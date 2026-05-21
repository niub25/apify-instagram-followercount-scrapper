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

// Build queue from input — strip @, lowercase, dedupe, skip already done
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
// Returns { data, status } — data is null on failure, status is the HTTP code.
// Exposing status lets callers detect 401 vs 404 vs 429 and act accordingly.

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

        return {
            data:   result?.data   ?? null,
            status: result?.status ?? 0,
        };
    } catch (e) {
        return { data: null, status: 0 };
    }
}

// ─── Strategy 1: web_profile_info API ────────────────────────────────────────

async function fetchViaApi(username) {
    const url      = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const referer  = `https://www.instagram.com/${username}/`;
    const { data, status } = await igFetch(url, referer);

    if (status === 404) return { found: false, followers: null, source: 'api_404' };
    if (!data)         return { found: null,  followers: null, status };   // null = "unknown, try fallback"

    const user = data?.data?.user;
    if (!user)         return { found: false, followers: null, source: 'api_no_user' };

    return {
        found:     true,
        followers: user.edge_followed_by?.count ?? user.follower_count ?? null,
        source:    'web_profile_info',
    };
}

// ─── Strategy 2: page navigation with response interception ──────────────────
// Navigate to the actual profile page. Instagram loads web_profile_info itself —
// we intercept that response instead of calling the API directly.
// This bypasses header/auth issues because the browser makes the request in full
// page context (with all cookies, headers, and proper referrer chain).

async function fetchViaPageIntercept(username) {
    let followers  = null;
    let userExists = true;

    const profileUrl = `https://www.instagram.com/${username}/`;

    // Listen for the API response Instagram makes when loading a profile
    const handleResponse = async (response) => {
        try {
            if (
                response.url().includes('web_profile_info') ||
                response.url().includes(`/api/v1/users/`) && response.url().includes('/info/')
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
        const response = await igPage.goto(profileUrl, {
            waitUntil: 'networkidle',
            timeout:   20_000,
        });

        // Check HTTP status of the page itself
        if (response?.status() === 404) {
            userExists = false;
        }

        // Give intercepted XHRs a moment to resolve
        await new Promise(r => setTimeout(r, 1_000));

        // Last-resort: scrape follower count from page JSON data
        if (followers === null && userExists) {
            followers = await igPage.evaluate(() => {
                // Instagram embeds user data in <script> tags
                const scripts = [...document.querySelectorAll('script[type="application/json"]')];
                for (const s of scripts) {
                    try {
                        const obj = JSON.parse(s.textContent);
                        const str = JSON.stringify(obj);
                        const m   = str.match(/"edge_followed_by":\{"count":(\d+)\}/);
                        if (m) return parseInt(m[1], 10);
                    } catch { /* skip */ }
                }
                // Also check inline scripts
                const allScripts = [...document.querySelectorAll('script:not([src])')];
                for (const s of allScripts) {
                    const m = s.textContent?.match(/"edge_followed_by":\{"count":(\d+)\}/);
                    if (m) return parseInt(m[1], 10);
                    const m2 = s.textContent?.match(/"follower_count":(\d+)/);
                    if (m2) return parseInt(m2[1], 10);
                }
                return null;
            });
        }

    } catch (e) {
        console.log(`  [page_intercept] navigation error: ${e.message}`);
    } finally {
        igPage.off('response', handleResponse);
    }

    if (!userExists)      return { found: false, followers: null,     source: 'page_404' };
    if (followers !== null) return { found: true,  followers,           source: 'page_intercept' };
    return                        { found: null,   followers: null,     source: 'page_no_data' };
}

// ─── Main fetch orchestrator ──────────────────────────────────────────────────
// Strategy 1 (fast API) → Strategy 2 (page navigation) → give up
// Rate limit (429) triggers a longer pause before continuing.

async function fetchFollowers(username) {
    // ── Strategy 1: direct API call ───────────────────────────────────────────
    const apiResult = await fetchViaApi(username);

    if (apiResult.found === true)  return apiResult;   // success
    if (apiResult.found === false) return apiResult;   // definitive 404

    // found === null means the API gave a non-404 error — log the status
    const { status } = apiResult;
    console.log(`  [${username}] API error HTTP ${status} → trying page intercept`);

    // 429 rate limit — back off before the next strategy
    if (status === 429) {
        console.log(`  [${username}] Rate limited — waiting 15s`);
        await new Promise(r => setTimeout(r, 15_000));
    }

    // ── Strategy 2: full page navigation + interception ───────────────────────
    const pageResult = await fetchViaPageIntercept(username);

    if (pageResult.found === true)  return pageResult;
    if (pageResult.found === false) return pageResult;

    // Both strategies failed
    console.log(`  [${username}] Both strategies failed`);
    return { found: false, followers: null, source: 'all_failed' };
}

// ─── API smoke test ───────────────────────────────────────────────────────────

console.log('\nTesting API...');
const { data: testData, status: testStatus } = await igFetch(
    'https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram',
    'https://www.instagram.com/instagram/'
);

if (testData?.data?.user) {
    const testFollowers = testData.data.user.edge_followed_by?.count;
    console.log(`Strategy 1 (API) OK — @instagram has ${testFollowers?.toLocaleString()} followers`);
} else {
    console.log(`Strategy 1 (API) returned HTTP ${testStatus} — will rely on page intercept fallback`);
    if (testStatus === 401 || testStatus === 403) {
        console.log('TIP: Try refreshing your sessionId and csrfToken from Chrome DevTools.');
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
        console.log(`${progress} @${username.padEnd(32)} → ${String(followers.toLocaleString()).padStart(10)} followers  [${source}]`);
    } else {
        failed++;
        console.log(`${progress} @${username.padEnd(32)} → not found / failed  [${source}]`);
    }

    // Checkpoint every 50 profiles
    if ((i + 1) % 50 === 0) {
        await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
        console.log(`  [checkpoint] ${i + 1} done, state saved`);
    }

    await new Promise(r => setTimeout(r, 300));
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
