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

// ─── Restore state after server migration ─────────────────────────────────────

const savedState = await Actor.getValue('STATE') ?? {};
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

// ─── Persist state on actor migration ────────────────────────────────────────

Actor.on('migrating', async () => {
    await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
    console.log(`[MIGRATION] State saved — ${doneUsernames.size} done`);
});

// ─── Launch browser ───────────────────────────────────────────────────────────

console.log('\nLaunching browser...');
const proxyUrl  = await proxyConfig.newUrl('ig_browser');
const proxyHost = proxyUrl ? new URL(proxyUrl) : null;

const browser = await chromium.launch({
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
    ],
    proxy: proxyHost
        ? {
              server:   `${proxyHost.protocol}//${proxyHost.host}`,
              username: proxyHost.username ? decodeURIComponent(proxyHost.username) : undefined,
              password: proxyHost.password ? decodeURIComponent(proxyHost.password) : undefined,
          }
        : undefined,
});

const context = await browser.newContext({
    userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
});

await context.addCookies([
    {
        name: 'sessionid', value: sessionId,
        domain: '.instagram.com', path: '/', httpOnly: true, secure: true,
    },
    ...(csrfToken
        ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }]
        : []),
]);

const igPage = await context.newPage();

console.log('Warming up session...');
await igPage.goto('https://www.instagram.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
}).catch(e => console.log(`Nav warning: ${e.message}`));

// ─── Core fetch helper ────────────────────────────────────────────────────────
// Always returns { data, status } so callers can branch on the HTTP status code.

async function igFetch(url, referer = 'https://www.instagram.com/') {
    try {
        const result = await igPage.evaluate(async ({ u, ref }) => {
            try {
                const r = await fetch(u, {
                    headers: {
                        'X-IG-App-ID':      '936619743392459',
                        'X-ASBD-ID':        '129477',
                        'X-IG-WWW-Claim':   '0',
                        'Accept':           '*/*',
                        'Accept-Language':  'en-US,en;q=0.9',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer':          ref,
                    },
                    credentials: 'include',
                });
                if (!r.ok) return { data: null, status: r.status };
                const data = await r.json();
                return { data, status: 200 };
            } catch (e) {
                return { data: null, status: 0, error: e.message };
            }
        }, { u: url, ref: referer });

        return { data: result?.data ?? null, status: result?.status ?? 0 };
    } catch {
        return { data: null, status: 0 };
    }
}

// ─── Strategy 1: direct API call ─────────────────────────────────────────────

async function fetchViaApi(username) {
    const url     = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const referer = `https://www.instagram.com/${username}/`;
    const { data, status } = await igFetch(url, referer);

    if (status === 404) return { found: false, followers: null, source: 'api_404',    status };
    if (!data)          return { found: null,  followers: null, source: 'api_error',  status };

    const user = data?.data?.user;
    if (!user)          return { found: false, followers: null, source: 'api_no_user', status };

    return {
        found:     true,
        followers: user.edge_followed_by?.count ?? user.follower_count ?? null,
        source:    'web_profile_info',
        status:    200,
    };
}

// ─── Strategy 2: page navigation + response interception ─────────────────────
// Used ONLY when Strategy 1 returns a hard auth error (401/403).
// Not used for rate limits (429) — if IP is rate limited, page loads are
// also throttled and will time out, wasting time.

async function fetchViaPageIntercept(username) {
    let followers  = null;
    let userExists = true;

    const handleResponse = async (response) => {
        try {
            if (
                response.url().includes('web_profile_info') ||
                (response.url().includes('/api/v1/users/') && response.url().includes('/info/'))
            ) {
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
        // Use domcontentloaded (not networkidle) — faster and sufficient
        // since we intercept XHRs via the response listener anyway
        const navResponse = await igPage.goto(`https://www.instagram.com/${username}/`, {
            waitUntil: 'domcontentloaded',
            timeout:   15_000,
        });

        if (navResponse?.status() === 404) {
            userExists = false;
        }

        // Brief wait for XHR responses to fire after DOM load
        await new Promise(r => setTimeout(r, 2_000));

        // Last resort: scrape follower count directly from page scripts
        if (followers === null && userExists) {
            followers = await igPage.evaluate(() => {
                const allScripts = [...document.querySelectorAll('script')];
                for (const s of allScripts) {
                    const text = s.textContent || '';
                    const m1 = text.match(/"edge_followed_by":\{"count":(\d+)\}/);
                    if (m1) return parseInt(m1[1], 10);
                    const m2 = text.match(/"follower_count":(\d+)/);
                    if (m2) return parseInt(m2[1], 10);
                }
                return null;
            });
        }
    } catch (e) {
        console.log(`  [page_intercept] error: ${e.message.split('\n')[0]}`);
    } finally {
        igPage.off('response', handleResponse);
    }

    if (!userExists)         return { found: false, followers: null,  source: 'page_404' };
    if (followers !== null)  return { found: true,  followers,        source: 'page_intercept' };
    return                          { found: null,  followers: null,  source: 'page_no_data' };
}

// ─── Fetch orchestrator ───────────────────────────────────────────────────────
//
// Decision tree:
//
//   Strategy 1 (API)
//     ├─ success              → return result
//     ├─ 404                  → user not found, return
//     ├─ 429 (rate limit)     → wait & retry Strategy 1 (up to 3×)
//     │                          page intercept NOT used — IP is throttled,
//     │                          page loads will also fail/timeout
//     └─ 401 / 403 / other   → try Strategy 2 (page intercept)
//
//   Strategy 2 (page intercept)
//     ├─ success              → return result
//     ├─ 404                  → user not found, return
//     └─ failed               → give up, record as failed

const MAX_429_RETRIES = 3;
const RATE_LIMIT_BACKOFF = [30_000, 60_000, 90_000]; // escalating waits

async function fetchFollowers(username) {
    let lastStatus = 0;

    // ── Strategy 1 with 429 retry loop ───────────────────────────────────────
    for (let attempt = 0; attempt < MAX_429_RETRIES; attempt++) {
        const result = await fetchViaApi(username);

        if (result.found === true)  return result;   // success
        if (result.found === false) return result;   // definitive 404

        lastStatus = result.status;

        if (lastStatus === 429) {
            const wait = RATE_LIMIT_BACKOFF[attempt] ?? 90_000;
            console.log(
                `  [${username}] 429 rate limited (attempt ${attempt + 1}/${MAX_429_RETRIES})` +
                ` — waiting ${wait / 1000}s then retrying API`
            );
            await new Promise(r => setTimeout(r, wait));
            // Loop back → retry Strategy 1 (same fast API, not page navigation)
            continue;
        }

        // Any other error (401, 403, network error) → break out and try page intercept
        console.log(`  [${username}] API error HTTP ${lastStatus} → trying page intercept`);
        break;
    }

    // If we exhausted 429 retries, log it
    if (lastStatus === 429) {
        console.log(`  [${username}] Still rate limited after ${MAX_429_RETRIES} retries — skipping`);
        return { found: false, followers: null, source: '429_exhausted' };
    }

    // ── Strategy 2: page intercept (auth failures only) ──────────────────────
    const pageResult = await fetchViaPageIntercept(username);
    if (pageResult.found === true || pageResult.found === false) return pageResult;

    return { found: false, followers: null, source: 'all_failed' };
}

// ─── API smoke test ───────────────────────────────────────────────────────────

console.log('\nTesting API...');
const { data: testData, status: testStatus } = await igFetch(
    'https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram',
    'https://www.instagram.com/instagram/'
);
if (testData?.data?.user) {
    const c = testData.data.user.edge_followed_by?.count;
    console.log(`Strategy 1 OK — @instagram has ${c?.toLocaleString()} followers`);
} else {
    console.log(`Strategy 1 returned HTTP ${testStatus} — will rely on page intercept fallback`);
    if (testStatus === 401 || testStatus === 403) {
        console.log('TIP: Refresh sessionId and csrfToken from Chrome DevTools.');
    }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

const total   = pendingQueue.length;
let succeeded = 0;
let failed    = 0;

console.log([
    `\n${'─'.repeat(55)}`,
    `Processing ${total} usernames`,
    `${'─'.repeat(55)}`,
].join('\n'));

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
        console.log(
            `${progress} @${username.padEnd(32)} → ` +
            `${String(followers.toLocaleString()).padStart(10)} followers  [${source}]`
        );
    } else {
        failed++;
        console.log(`${progress} @${username.padEnd(32)} → not found / failed  [${source}]`);
    }

    // Checkpoint every 50 profiles
    if ((i + 1) % 50 === 0) {
        await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
        console.log(`  [checkpoint] ${i + 1} done, state saved`);
    }

    // Base delay between requests — 600ms reduces 429 frequency vs 300ms
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
