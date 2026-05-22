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

if (!sessionId) { console.log('ERROR: sessionId is required.'); await Actor.exit(); }
if (!inputUsernames?.length) { console.log('ERROR: usernames array is empty.'); await Actor.exit(); }

const proxyConfig = await Actor.createProxyConfiguration(
    proxyConfiguration ?? {
        useApifyProxy:     true,
        apifyProxyGroups:  ['RESIDENTIAL'],
        apifyProxyCountry: 'US',
    }
);

// ─── Restore state ────────────────────────────────────────────────────────────

const savedState    = await Actor.getValue('STATE') ?? {};
const doneUsernames = new Set(savedState.doneUsernames ?? []);

const seen = new Set();
const pendingQueue = inputUsernames
    .map(u => u.trim().replace(/^@/, '').toLowerCase())
    .filter(u => { if (!u || doneUsernames.has(u) || seen.has(u)) return false; seen.add(u); return true; });

console.log(`Restored: ${doneUsernames.size} done | Pending: ${pendingQueue.length} | Total: ${inputUsernames.length}`);

Actor.on('migrating', async () => {
    await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
    console.log(`[MIGRATION] Saved — ${doneUsernames.size} done`);
});

// ─── Browser ──────────────────────────────────────────────────────────────────

console.log('\nLaunching browser...');
const proxyUrl  = await proxyConfig.newUrl('ig_browser');
const proxyHost = proxyUrl ? new URL(proxyUrl) : null;

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: proxyHost ? {
        server:   `${proxyHost.protocol}//${proxyHost.host}`,
        username: proxyHost.username ? decodeURIComponent(proxyHost.username) : undefined,
        password: proxyHost.password ? decodeURIComponent(proxyHost.password) : undefined,
    } : undefined,
});

const IG_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const context = await browser.newContext({ userAgent: IG_UA, viewport: { width: 390, height: 844 } });

await context.addCookies([
    { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ...(csrfToken ? [{ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true }] : []),
]);

// ─── Warmup: navigate to Instagram to establish session context ───────────────

const igPage = await context.newPage();
console.log('Warming up session...');
try {
    await igPage.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await new Promise(r => setTimeout(r, 2_000));
    console.log('Warmup done');
} catch (e) {
    console.log(`Warmup warning (non-fatal): ${e.message.split('\n')[0]}`);
}

// ─── API fetch via context.request ───────────────────────────────────────────
// Uses Playwright's native HTTP client — reads cookies from browser context,
// no origin/CORS issues, no dependency on page navigation state.
// This is the approach that successfully returned 500+ followers in earlier runs.

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
        const res    = await context.request.get(url, {
            headers: { ...IG_HEADERS, 'Referer': `https://www.instagram.com/${username}/` },
            timeout: 15_000,
        });
        const status = res.status();
        if (status === 404) return { found: false, followers: null, source: 'not_found', status };
        if (status === 429) return { found: null,  followers: null, source: 'rate_limit', status };
        if (!res.ok())      return { found: null,  followers: null, source: 'api_error',  status };
        const body = await res.json();
        const user = body?.data?.user;
        if (!user)          return { found: false, followers: null, source: 'no_user',    status };
        return { found: true, followers: user.edge_followed_by?.count ?? user.follower_count ?? null, source: 'api', status };
    } catch {
        return { found: null, followers: null, source: 'exception', status: 0 };
    }
}

// ─── Rate limit handling ──────────────────────────────────────────────────────
//
// Strategy: when rate limited, pause and retry.
// The base delay between requests also increases after each 429 event,
// so the run automatically slows down to avoid continued blocking.
// After MAX_RL_EVENTS consecutive 429s, abort and save state.

let   requestDelay    = 800;    // ms between requests — increases on 429 events
let   rl429Events     = 0;      // consecutive 429 events (resets on success)
const MAX_RL_EVENTS   = 5;      // abort after this many consecutive 429 events
const RL_PAUSE_MS     = 3 * 60_000;  // 3-minute pause on each 429 event

async function fetchWithRateLimitHandling(username) {
    for (let attempt = 0; attempt <= 2; attempt++) {
        const result = await fetchViaApi(username);

        if (result.source === 'rate_limit') {
            rl429Events++;

            if (rl429Events >= MAX_RL_EVENTS) {
                console.log([
                    ``,
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                    `ABORT — ${MAX_RL_EVENTS} consecutive rate limit events`,
                    ``,
                    `The session or proxy IP is fully blocked.`,
                    `  1. Wait 30–60 minutes`,
                    `  2. Get fresh sessionId + csrfToken from Chrome`,
                    `  3. Re-run — state is saved, resumes where it stopped`,
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                ].join('\n'));
                await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
                await browser.close();
                await Actor.exit();
            }

            // Increase base delay — slow down to reduce future 429s
            requestDelay = Math.min(requestDelay + 500, 3_000);
            console.log(
                `  [${username}] 429 (event ${rl429Events}/${MAX_RL_EVENTS})` +
                ` — pausing ${RL_PAUSE_MS / 60_000} min, new delay: ${requestDelay}ms`
            );
            await new Promise(r => setTimeout(r, RL_PAUSE_MS));
            continue; // retry same username after pause
        }

        // Success or definitive failure — reset 429 counter
        rl429Events = 0;
        return result;
    }

    // All 3 attempts were rate-limited
    return { found: false, followers: null, source: '429_skipped' };
}

// ─── Smoke test ───────────────────────────────────────────────────────────────

console.log('\nTesting API...');
const smoke = await fetchViaApi('instagram');

if (smoke.source === 'api') {
    console.log(`API OK — @instagram has ${smoke.followers?.toLocaleString()} followers`);
} else if (smoke.source === 'rate_limit') {
    console.log([
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `ABORT — Session/proxy is rate limited before even starting`,
        ``,
        `  1. Wait 30–60 minutes for the block to clear`,
        `  2. Get fresh sessionId + csrfToken from Chrome:`,
        `       DevTools → Application → Cookies → instagram.com`,
        `  3. Re-run — state is saved, will resume where it stopped`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n'));
    await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
    await browser.close();
    await Actor.exit();
} else if (smoke.status === 401 || smoke.status === 403) {
    console.log([
        `ABORT — Session is invalid (HTTP ${smoke.status})`,
        `Get fresh sessionId + csrfToken from Chrome and re-run.`,
    ].join('\n'));
    await browser.close();
    await Actor.exit();
} else {
    console.log(`API returned ${smoke.status} [${smoke.source}] — proceeding cautiously`);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

const total   = pendingQueue.length;
let succeeded = 0;
let failed    = 0;

console.log(`\n${'─'.repeat(55)}\nProcessing ${total} usernames\n${'─'.repeat(55)}`);

for (let i = 0; i < pendingQueue.length; i++) {
    const username = pendingQueue[i];
    const progress = `[${i + 1 + doneUsernames.size}/${total + doneUsernames.size}]`;

    const { found, followers, source } = await fetchWithRateLimitHandling(username);

    await Dataset.pushData({ username, followers: followers ?? null, scrapedAt: new Date().toISOString() });
    doneUsernames.add(username);

    if (found && followers !== null) {
        succeeded++;
        console.log(`${progress} @${username.padEnd(32)} → ${String(followers.toLocaleString()).padStart(10)} followers  [${source}]`);
    } else {
        failed++;
        console.log(`${progress} @${username.padEnd(32)} → failed  [${source}]`);
    }

    if ((i + 1) % 50 === 0) {
        await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
        console.log(`  [checkpoint] ${i + 1} done, state saved`);
    }

    await new Promise(r => setTimeout(r, requestDelay));
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

await browser.close();
await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
console.log(`\nDONE — processed: ${doneUsernames.size} | succeeded: ${succeeded} | failed: ${failed}`);
await Actor.exit();
