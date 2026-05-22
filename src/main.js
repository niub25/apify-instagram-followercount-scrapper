import { Actor } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'playwright';

await Actor.init();

// ─── Input ────────────────────────────────────────────────────────────────────

const input = await Actor.getInput();
const {
    usernames: inputUsernames = [],
    sessionId,
    csrfToken,
    proxyConfiguration,
} = input;

if (!sessionId) {
    console.log('ERROR: sessionId is required. See INPUT_SCHEMA for how to get it.');
    await Actor.exit();
}
if (!inputUsernames || inputUsernames.length === 0) {
    console.log('ERROR: usernames array is empty. Provide at least one username.');
    await Actor.exit();
}

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'US' }
);

// ─── Restore state ────────────────────────────────────────────────────────────

const savedState    = await Actor.getValue('STATE') ?? {};
const doneUsernames = new Set(savedState.doneUsernames ?? []);

const seen = new Set();
const pendingQueue = inputUsernames
    .map(u => u.trim().replace(/^@/, '').toLowerCase())
    .filter(u => {
        if (!u || doneUsernames.has(u) || seen.has(u)) return false;
        seen.add(u);
        return true;
    });

console.log([
    `Restored state : ${doneUsernames.size} already done`,
    `Pending        : ${pendingQueue.length} usernames to process`,
    `Total input    : ${inputUsernames.length}`,
].join('\n'));

Actor.on('migrating', async () => {
    await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
    console.log(`[MIGRATION] State saved — ${doneUsernames.size} done`);
});

// ─── Browser + context ────────────────────────────────────────────────────────

console.log('\nLaunching browser...');
const proxyUrl  = await proxyConfig.newUrl('ig_browser');
const proxyHost = proxyUrl ? new URL(proxyUrl) : null;

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: proxyHost
        ? {
              server:   `${proxyHost.protocol}//${proxyHost.host}`,
              username: proxyHost.username ? decodeURIComponent(proxyHost.username) : undefined,
              password: proxyHost.password ? decodeURIComponent(proxyHost.password) : undefined,
          }
        : undefined,
});

const IG_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const context = await browser.newContext({
    userAgent: IG_UA,
    viewport:  { width: 390, height: 844 },
});

await context.addCookies([
    { name: 'sessionid', value: sessionId,  domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ...(csrfToken
        ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }]
        : []),
]);

const igPage = await context.newPage();

// ─── Warmup navigation ────────────────────────────────────────────────────────
// Visit Instagram homepage before any API calls. Cold API requests (no prior
// page visit) trigger bot detection immediately. A real page load first
// establishes the full cookie/header context Instagram expects, and makes
// subsequent API calls look like natural in-page XHRs.
console.log('Warming up session...');
try {
    await igPage.goto('https://www.instagram.com/', {
        waitUntil: 'domcontentloaded',
        timeout:   25_000,
    });
    await new Promise(r => setTimeout(r, 3_000)); // human-like pause
    console.log('Warmup done');
} catch (e) {
    // Non-fatal — context.request works even if page nav fails
    console.log(`Warmup warning (non-fatal): ${e.message.split('\n')[0]}`);
    await new Promise(r => setTimeout(r, 2_000));
}

// ─── Rate limit state ─────────────────────────────────────────────────────────
// Tracks consecutive 429s across all requests.
// On each 429: one global pause, then single retry.
// If MAX_CONSECUTIVE_429 is hit: abort — session is fully blocked.

const GLOBAL_RL_PAUSE      = 90_000;   // 90s cool-down on any 429
const MAX_CONSECUTIVE_429  = 10;       // abort after this many in a row
let   consecutive429s      = 0;

async function onRateLimit(username) {
    consecutive429s++;
    console.log(
        `  [${username}] 429 rate limited` +
        ` (${consecutive429s} consecutive) — global pause ${GLOBAL_RL_PAUSE / 1000}s`
    );

    if (consecutive429s >= MAX_CONSECUTIVE_429) {
        console.log([
            ``,
            `ABORT: ${MAX_CONSECUTIVE_429} consecutive 429s.`,
            `The session or proxy IP appears fully blocked by Instagram.`,
            `Wait ~10–15 minutes, then either:`,
            `  1. Re-run — state is saved, it will resume where it left off`,
            `  2. Refresh sessionId + csrfToken from Chrome DevTools`,
        ].join('\n'));
        await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
        await browser.close();
        await Actor.exit();
    }

    await new Promise(r => setTimeout(r, GLOBAL_RL_PAUSE));
}

// ─── Strategy 1: Playwright APIRequestContext ─────────────────────────────────

const IG_HEADERS = {
    'X-IG-App-ID':      '936619743392459',
    'X-ASBD-ID':        '129477',
    'X-IG-WWW-Claim':   '0',
    'Accept':           '*/*',
    'Accept-Language':  'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent':       IG_UA,
};

async function fetchViaApi(username) {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    try {
        const response = await context.request.get(url, {
            headers: { ...IG_HEADERS, 'Referer': `https://www.instagram.com/${username}/` },
            timeout: 15_000,
        });

        const status = response.status();
        if (status === 404) return { found: false, followers: null, source: 'api_404',    status };
        if (!response.ok()) return { found: null,  followers: null, source: 'api_error',  status };

        const body = await response.json();
        const user = body?.data?.user;
        if (!user)          return { found: false, followers: null, source: 'api_no_user', status };

        return {
            found:     true,
            followers: user.edge_followed_by?.count ?? user.follower_count ?? null,
            source:    'web_profile_info',
            status:    200,
        };
    } catch {
        return { found: null, followers: null, source: 'api_exception', status: 0 };
    }
}

// ─── Strategy 2: page navigation + response interception ─────────────────────
// Only used for hard auth errors (401/403), not for 429.

async function fetchViaPageIntercept(username) {
    let followers  = null;
    let userExists = true;

    const handleResponse = async (response) => {
        try {
            if (response.url().includes('web_profile_info')) {
                const body = await response.json().catch(() => null);
                const user = body?.data?.user ?? body?.user;
                if (user) followers = user.edge_followed_by?.count ?? user.follower_count ?? null;
            }
        } catch { /* ignore */ }
    };

    igPage.on('response', handleResponse);
    try {
        const navResponse = await igPage.goto(`https://www.instagram.com/${username}/`, {
            waitUntil: 'domcontentloaded',
            timeout:   15_000,
        });
        if (navResponse?.status() === 404) userExists = false;

        await new Promise(r => setTimeout(r, 2_000));

        if (followers === null && userExists) {
            followers = await igPage.evaluate(() => {
                for (const s of document.querySelectorAll('script')) {
                    const t = s.textContent || '';
                    const m1 = t.match(/"edge_followed_by":\{"count":(\d+)\}/);
                    if (m1) return parseInt(m1[1], 10);
                    const m2 = t.match(/"follower_count":(\d+)/);
                    if (m2) return parseInt(m2[1], 10);
                }
                return null;
            });
        }
    } catch (e) {
        console.log(`  [page_intercept] ${e.message.split('\n')[0]}`);
    } finally {
        igPage.off('response', handleResponse);
    }

    if (!userExists)        return { found: false, followers: null, source: 'page_404' };
    if (followers !== null) return { found: true,  followers,       source: 'page_intercept' };
    return                         { found: null,  followers: null, source: 'page_no_data' };
}

// ─── Fetch orchestrator ───────────────────────────────────────────────────────
//
//   Strategy 1 (API)
//     ├─ success        → done, reset consecutive429 counter
//     ├─ 404            → user not found
//     ├─ 429            → global 90s pause → single retry
//     │                    still 429 → skip (don't retry forever)
//     │                    10 consecutive 429s → abort actor
//     └─ 401/403/other  → Strategy 2 (page intercept)

async function fetchFollowers(username) {
    const first = await fetchViaApi(username);

    if (first.found === true)  { consecutive429s = 0; return first; }
    if (first.found === false) { consecutive429s = 0; return first; }

    if (first.status === 429) {
        await onRateLimit(username);

        // Single retry after the pause
        const retry = await fetchViaApi(username);
        if (retry.found === true)  { consecutive429s = 0; return retry; }
        if (retry.found === false) { consecutive429s = 0; return retry; }
        if (retry.status === 429) {
            // Still blocked — skip this username and keep going
            return { found: false, followers: null, source: '429_skipped' };
        }
        // Retry gave a non-429 error — fall through to page intercept
    }

    // Auth or other error → try page intercept
    console.log(`  [${username}] API HTTP ${first.status} → trying page intercept`);
    const page = await fetchViaPageIntercept(username);
    if (page.found === true || page.found === false) return page;

    return { found: false, followers: null, source: 'all_failed' };
}

// ─── Smoke test ───────────────────────────────────────────────────────────────
// Runs before processing any usernames.
// If rate limited (429): abort immediately — no point burning time on 4000+ usernames
//   when every request will fail. State is saved; re-run after refreshing the session.
// If auth error (401/403): abort with instructions to refresh cookies.
// If success: proceed normally.

console.log('\nTesting API...');
const smoke = await fetchViaApi('instagram');

if (smoke.found === true) {
    console.log(`API OK — @instagram has ${smoke.followers?.toLocaleString()} followers`);

} else if (smoke.status === 429) {
    console.log([
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `ABORT — Session is rate limited (HTTP 429)`,
        ``,
        `Your Instagram session or proxy IP is currently blocked.`,
        `There is no point starting — every username would fail.`,
        ``,
        `What to do:`,
        `  1. Wait 15–30 minutes for the rate limit to clear`,
        `  2. Get a fresh sessionId + csrfToken from Chrome:`,
        `       Open Instagram → DevTools → Application → Cookies`,
        `       Copy "sessionid" and "csrftoken" values`,
        `  3. Re-run — state is saved, it will resume from where it stopped`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n'));
    await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
    await browser.close();
    await Actor.exit();

} else if (smoke.status === 401 || smoke.status === 403) {
    console.log([
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `ABORT — Session invalid or expired (HTTP ${smoke.status})`,
        ``,
        `Your sessionId cookie is expired or incorrect.`,
        ``,
        `What to do:`,
        `  1. Log in to Instagram in Chrome`,
        `  2. Open DevTools → Application → Cookies → instagram.com`,
        `  3. Copy the fresh "sessionid" and "csrftoken" values`,
        `  4. Update the actor input and re-run`,
        `     (state is saved — it will resume where it stopped)`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n'));
    await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
    await browser.close();
    await Actor.exit();

} else {
    console.log(`API returned HTTP ${smoke.status} [${smoke.source}] — page intercept fallback will be used`);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

const total   = pendingQueue.length;
let succeeded = 0;
let failed    = 0;

console.log(`\n${'─'.repeat(55)}\nProcessing ${total} usernames\n${'─'.repeat(55)}`);

for (let i = 0; i < pendingQueue.length; i++) {
    const username = pendingQueue[i];
    const progress = `[${i + 1 + doneUsernames.size}/${total + doneUsernames.size}]`;

    const { found, followers, source } = await fetchFollowers(username);

    await Dataset.pushData({ username, followers: followers ?? null, scrapedAt: new Date().toISOString() });
    doneUsernames.add(username);

    if (found && followers !== null) {
        succeeded++;
        console.log(`${progress} @${username.padEnd(32)} → ${String(followers.toLocaleString()).padStart(10)} followers  [${source}]`);
    } else {
        failed++;
        console.log(`${progress} @${username.padEnd(32)} → not found / failed  [${source}]`);
    }

    if ((i + 1) % 50 === 0) {
        await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
        console.log(`  [checkpoint] ${i + 1} done, state saved`);
    }

    await new Promise(r => setTimeout(r, 600));
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

await browser.close();
await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });

console.log([
    `\n${'═'.repeat(55)}`,
    `DONE`,
    `  Total processed : ${doneUsernames.size}`,
    `  Succeeded        : ${succeeded}`,
    `  Not found/failed : ${failed}`,
    `${'═'.repeat(55)}`,
].join('\n'));

await Actor.exit();
