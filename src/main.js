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
    proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
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

// Inject session cookies
await context.addCookies([
    { name: 'sessionid', value: sessionId,  domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ...(csrfToken
        ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }]
        : []),
]);

// igPage is used only for Strategy 2 (page-based fallback)
const igPage = await context.newPage();

// ─── Strategy 1: Playwright APIRequestContext ─────────────────────────────────
// Uses context.request.get() — reads cookies from the browser context directly,
// independent of what page is currently loaded. No origin/CORS issues, no warmup
// navigation needed. This replaces the old page.evaluate(fetch(...)) approach
// which broke whenever the warmup navigation timed out.

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
            headers: {
                ...IG_HEADERS,
                'Referer': `https://www.instagram.com/${username}/`,
            },
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
    } catch (e) {
        return { found: null, followers: null, source: 'api_exception', status: 0 };
    }
}

// ─── Strategy 2: page navigation + response interception ─────────────────────
// Only triggered for hard auth errors (401/403) — not for 429 rate limits,
// since a rate-limited IP will also fail page loads.

async function fetchViaPageIntercept(username) {
    let followers  = null;
    let userExists = true;

    const handleResponse = async (response) => {
        try {
            if (response.url().includes('web_profile_info')) {
                const body = await response.json().catch(() => null);
                const user = body?.data?.user ?? body?.user;
                if (user) {
                    followers = user.edge_followed_by?.count ?? user.follower_count ?? null;
                }
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

        // Wait briefly for XHR responses after DOM load
        await new Promise(r => setTimeout(r, 2_000));

        // Last resort: scrape from inline page scripts
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

    if (!userExists)        return { found: false, followers: null,  source: 'page_404' };
    if (followers !== null) return { found: true,  followers,        source: 'page_intercept' };
    return                         { found: null,  followers: null,  source: 'page_no_data' };
}

// ─── Fetch orchestrator ───────────────────────────────────────────────────────
//
//   Strategy 1 (fast API via context.request)
//     ├─ success  → done
//     ├─ 404      → user not found
//     ├─ 429      → wait & retry Strategy 1 (up to 3×, escalating backoff)
//     │              page intercept NOT used — rate-limited IP fails page loads too
//     └─ 401/403  → try Strategy 2 (page navigation)
//
//   Strategy 2 (page navigation + interception)
//     ├─ success  → done
//     └─ failed   → record as failed

const RATE_LIMIT_BACKOFF = [30_000, 60_000, 90_000];

async function fetchFollowers(username) {
    let lastStatus = 0;

    for (let attempt = 0; attempt < RATE_LIMIT_BACKOFF.length; attempt++) {
        const result = await fetchViaApi(username);

        if (result.found === true)  return result;
        if (result.found === false) return result;

        lastStatus = result.status;

        if (lastStatus === 429) {
            const wait = RATE_LIMIT_BACKOFF[attempt];
            console.log(`  [${username}] 429 rate limited (attempt ${attempt + 1}/${RATE_LIMIT_BACKOFF.length}) — waiting ${wait / 1000}s`);
            await new Promise(r => setTimeout(r, wait));
            continue;
        }

        // Non-429 error → try page intercept
        console.log(`  [${username}] API HTTP ${lastStatus} → trying page intercept`);
        break;
    }

    if (lastStatus === 429) {
        console.log(`  [${username}] Rate limited after all retries — skipping`);
        return { found: false, followers: null, source: '429_exhausted' };
    }

    const pageResult = await fetchViaPageIntercept(username);
    if (pageResult.found === true || pageResult.found === false) return pageResult;

    return { found: false, followers: null, source: 'all_failed' };
}

// ─── Smoke test ───────────────────────────────────────────────────────────────

console.log('\nTesting API...');
const testResult = await fetchViaApi('instagram');
if (testResult.found === true) {
    console.log(`API OK — @instagram has ${testResult.followers?.toLocaleString()} followers`);
} else {
    console.log(`API returned HTTP ${testResult.status} [${testResult.source}]`);
    if (testResult.status === 401 || testResult.status === 403) {
        console.log('TIP: Refresh sessionId and csrfToken from Chrome DevTools.');
    }
    // Do not exit — page intercept fallback may still work
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

    await Dataset.pushData({
        username,
        followers: followers ?? null,
        scrapedAt: new Date().toISOString(),
    });
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
