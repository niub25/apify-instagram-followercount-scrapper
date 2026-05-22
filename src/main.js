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
    console.log('ERROR: sessionId is required.');
    await Actor.exit();
}
if (!inputUsernames || inputUsernames.length === 0) {
    console.log('ERROR: usernames array is empty.');
    await Actor.exit();
}

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? {
        useApifyProxy:      true,
        apifyProxyGroups:   ['RESIDENTIAL'],
        apifyProxyCountry:  'US',
    }
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

// ─── Browser ──────────────────────────────────────────────────────────────────

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
    // Block images/fonts/media — we only need HTML + XHR, no need to download assets
    // This speeds up page loads significantly
});

await context.addCookies([
    { name: 'sessionid', value: sessionId,  domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ...(csrfToken
        ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }]
        : []),
]);

// Block images, fonts, and media to make page loads 3-4× faster
await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        route.abort();
    } else {
        route.continue();
    }
});

const igPage = await context.newPage();

// ─── Warmup: establish a real browsing session ────────────────────────────────

console.log('Warming up session...');
try {
    await igPage.goto('https://www.instagram.com/', {
        waitUntil: 'domcontentloaded',
        timeout:   25_000,
    });
    await new Promise(r => setTimeout(r, 2_000));
    console.log('Warmup done');
} catch (e) {
    console.log(`Warmup warning (non-fatal): ${e.message.split('\n')[0]}`);
    await new Promise(r => setTimeout(r, 1_000));
}

// ─── Strategy 1 (PRIMARY): page navigation + response interception ────────────
//
// Navigate to the profile page. Instagram's own JS will call web_profile_info —
// we intercept that XHR response. This is treated as legitimate browser traffic,
// not a direct API scrape, and is far less likely to be rate-limited.
//
// Fallback within this strategy: if the XHR isn't intercepted in time,
// scrape the follower count from embedded JSON in the page's <script> tags.

async function fetchViaPage(username) {
    let followers  = null;
    let userExists = true;
    let hitRateLimit = false;

    const handleResponse = async (response) => {
        try {
            const url = response.url();
            // Intercept Instagram's own profile info XHR
            if (url.includes('web_profile_info') || url.includes('/api/v1/users/') && url.includes('/info/')) {
                const status = response.status();
                if (status === 429) { hitRateLimit = true; return; }
                if (!response.ok())  return;
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
            timeout:   20_000,
        });

        const pageStatus = navResponse?.status();
        if (pageStatus === 404) { userExists = false; }
        else if (pageStatus === 429) { hitRateLimit = true; }

        // Wait for XHRs to complete after DOM load
        await new Promise(r => setTimeout(r, 2_500));

        // Fallback: scrape follower count from inline page scripts
        if (followers === null && userExists && !hitRateLimit) {
            followers = await igPage.evaluate(() => {
                for (const s of document.querySelectorAll('script')) {
                    const t = s.textContent || '';
                    const m1 = t.match(/"edge_followed_by":\{"count":(\d+)\}/);
                    if (m1) return parseInt(m1[1], 10);
                    const m2 = t.match(/"follower_count":(\d+)/);
                    if (m2) return parseInt(m2[1], 10);
                }
                return null;
            }).catch(() => null);
        }
    } catch (e) {
        const msg = e.message.split('\n')[0];
        if (msg.includes('429') || msg.includes('ERR_TOO_MANY')) hitRateLimit = true;
        else console.log(`  [page] nav error: ${msg}`);
    } finally {
        igPage.off('response', handleResponse);
    }

    if (hitRateLimit)       return { found: null,  followers: null, source: 'page_429',     rateLimit: true };
    if (!userExists)        return { found: false, followers: null, source: 'page_404' };
    if (followers !== null) return { found: true,  followers,       source: 'page_intercept' };
    return                         { found: null,  followers: null, source: 'page_no_data' };
}

// ─── Strategy 2 (FALLBACK): direct API call ───────────────────────────────────
// Used when page nav fails for non-rate-limit reasons (network error, etc.)

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
        if (status === 404) return { found: false, followers: null, source: 'api_404',   status };
        if (!response.ok()) return { found: null,  followers: null, source: 'api_error', status };
        const body = await response.json();
        const user = body?.data?.user;
        if (!user)          return { found: false, followers: null, source: 'api_no_user' };
        return {
            found:     true,
            followers: user.edge_followed_by?.count ?? user.follower_count ?? null,
            source:    'web_profile_info',
        };
    } catch {
        return { found: null, followers: null, source: 'api_exception', status: 0 };
    }
}

// ─── Rate limit state ─────────────────────────────────────────────────────────

const GLOBAL_RL_PAUSE     = 90_000;
const MAX_CONSECUTIVE_429 = 8;
let   consecutive429s     = 0;

async function onRateLimit(username) {
    consecutive429s++;
    console.log(`  [${username}] 429 rate limit (${consecutive429s} consecutive) — pausing ${GLOBAL_RL_PAUSE / 1000}s`);

    if (consecutive429s >= MAX_CONSECUTIVE_429) {
        console.log([
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `ABORT — Proxy IP fully blocked (${MAX_CONSECUTIVE_429} consecutive 429s)`,
            ``,
            `What to do:`,
            `  1. Wait 30–60 minutes`,
            `  2. Get fresh sessionId + csrfToken from Chrome DevTools`,
            `  3. Re-run — state is saved, resumes from where it stopped`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ].join('\n'));
        await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
        await browser.close();
        await Actor.exit();
    }

    await new Promise(r => setTimeout(r, GLOBAL_RL_PAUSE));
}

// ─── Fetch orchestrator ───────────────────────────────────────────────────────
//
//   1. Page navigation (PRIMARY — looks like real browsing, low rate-limit risk)
//        ├─ XHR intercepted or scraped from page → return followers
//        ├─ 404 → user not found
//        ├─ 429 → global pause → retry page nav once → skip if still blocked
//        └─ no data → try API fallback
//   2. Direct API call (FALLBACK — only when page nav fails non-rate-limit)

async function fetchFollowers(username) {
    // ── Primary: page navigation ──────────────────────────────────────────────
    const pageResult = await fetchViaPage(username);

    if (pageResult.found === true)  { consecutive429s = 0; return pageResult; }
    if (pageResult.found === false) { consecutive429s = 0; return pageResult; }

    if (pageResult.rateLimit) {
        await onRateLimit(username);
        // Single retry after pause
        const retry = await fetchViaPage(username);
        if (retry.found === true)  { consecutive429s = 0; return retry; }
        if (retry.found === false) { consecutive429s = 0; return retry; }
        if (retry.rateLimit) return { found: false, followers: null, source: '429_skipped' };
    }

    // ── Fallback: direct API ──────────────────────────────────────────────────
    const apiResult = await fetchViaApi(username);
    if (apiResult.found === true || apiResult.found === false) {
        consecutive429s = 0;
        return apiResult;
    }

    return { found: false, followers: null, source: 'all_failed' };
}

// ─── Smoke test: verify session works via page load ───────────────────────────
// Tests by navigating to a real profile. This is the same mechanism used
// for every username — if it works here, it will work for the full run.

console.log('\nTesting session via page load...');
const smokeResult = await fetchViaPage('instagram');

if (smokeResult.found === true) {
    console.log(`Session OK — @instagram has ${smokeResult.followers?.toLocaleString()} followers`);
} else if (smokeResult.rateLimit) {
    console.log([
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `ABORT — Proxy IP is rate limited (HTTP 429)`,
        ``,
        `Even page loads are being blocked. The proxy IP needs time to recover.`,
        ``,
        `What to do:`,
        `  1. Wait 30–60 minutes before re-running`,
        `  2. Get fresh sessionId + csrfToken from Chrome DevTools`,
        `  3. Re-run — state is saved, resumes from where it stopped`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n'));
    await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
    await browser.close();
    await Actor.exit();
} else {
    // Page loaded but couldn't extract followers — session likely works, proceed anyway
    console.log(`Session appears active (page loaded but follower count not extracted — proceeding)`);
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

    // 1.5s between requests — page loads need more breathing room than API calls
    await new Promise(r => setTimeout(r, 1_500));
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
