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

// Build queue from input, skip already-processed ones
const usernameQueue = inputUsernames
    .map(u => u.trim().replace(/^@/, '').toLowerCase())
    .filter(u => u && !doneUsernames.has(u));

// De-duplicate
const seen = new Set();
const pendingQueue = usernameQueue.filter(u => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
});

console.log([
    `Restored state: ${doneUsernames.size} already done`,
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

// ─── Core fetch helper (runs inside browser — uses session cookies) ───────────

async function igFetch(url) {
    try {
        const result = await igPage.evaluate(async (u) => {
            try {
                const r = await fetch(u, {
                    headers: {
                        'X-IG-App-ID':      '936619743392459',
                        'X-ASBD-ID':        '129477',
                        'Accept':           '*/*',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    credentials: 'include',
                });
                if (!r.ok) return { error: r.status };
                return { data: await r.json() };
            } catch (e) {
                return { error: e.message };
            }
        }, url);
        return result?.data ?? null;
    } catch {
        return null;
    }
}

// ─── Fetch follower count for one username ────────────────────────────────────

const RETRY_DELAYS = [2_000, 5_000, 10_000]; // ms between retries on failure

async function fetchFollowers(username) {
    // Primary endpoint — web profile info
    const primaryUrl =
        `https://www.instagram.com/api/v1/users/web_profile_info/` +
        `?username=${encodeURIComponent(username)}`;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        const data = await igFetch(primaryUrl);

        if (data) {
            const user = data?.data?.user;
            if (user) {
                return {
                    found: true,
                    followers: user.edge_followed_by?.count ?? user.follower_count ?? null,
                    source: 'web_profile_info',
                };
            }
        }

        // Detect hard 404 / user not found (no point retrying)
        if (data === null && attempt === 0) {
            // Try fallback endpoint before giving up
            const fallbackUrl =
                `https://i.instagram.com/api/v1/users/lookup/` +
                `?username=${encodeURIComponent(username)}`;
            const fallback = await igFetch(fallbackUrl);
            const fbUser = fallback?.user ?? fallback?.users?.[0];
            if (fbUser) {
                return {
                    found: true,
                    followers: fbUser.follower_count ?? null,
                    source: 'users_lookup',
                };
            }
        }

        if (attempt < RETRY_DELAYS.length) {
            console.log(`  [${username}] attempt ${attempt + 1} failed — retrying in ${RETRY_DELAYS[attempt] / 1000}s`);
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        }
    }

    return { found: false, followers: null, source: null };
}

// ─── API smoke test ───────────────────────────────────────────────────────────

console.log('\nTesting API...');
const testData = await igFetch(
    'https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram'
);
if (!testData?.data?.user) {
    console.log(
        'ERROR: API test failed.\n' +
        'ACTION: Refresh sessionId and csrfToken from Chrome DevTools and retry.'
    );
    await browser.close();
    await Actor.exit();
}
const testFollowers = testData.data.user.edge_followed_by?.count;
console.log(`API OK — @instagram has ${testFollowers?.toLocaleString()} followers`);

// ─── Main loop ────────────────────────────────────────────────────────────────

const total   = pendingQueue.length;
let succeeded = 0;
let failed    = 0;
let skipped   = 0;

console.log([
    `\n${'─'.repeat(50)}`,
    `Processing ${total} usernames`,
    `${'─'.repeat(50)}`,
].join('\n'));

for (let i = 0; i < pendingQueue.length; i++) {
    const username = pendingQueue[i];
    const progress = `[${i + 1 + doneUsernames.size}/${total + doneUsernames.size}]`;

    const { found, followers, source } = await fetchFollowers(username);

    if (found && followers !== null) {
        await Dataset.pushData({
            username,
            followers,
            scrapedAt: new Date().toISOString(),
        });
        doneUsernames.add(username);
        succeeded++;
        console.log(`${progress} @${username.padEnd(30)} → ${followers.toLocaleString()} followers  [${source}]`);
    } else if (found && followers === null) {
        // Profile exists but follower count wasn't in response
        await Dataset.pushData({
            username,
            followers: null,
            scrapedAt: new Date().toISOString(),
        });
        doneUsernames.add(username);
        skipped++;
        console.log(`${progress} @${username.padEnd(30)} → followers unavailable`);
    } else {
        // Profile not found or all retries exhausted
        await Dataset.pushData({
            username,
            followers: null,
            scrapedAt: new Date().toISOString(),
        });
        doneUsernames.add(username);
        failed++;
        console.log(`${progress} @${username.padEnd(30)} → not found / failed`);
    }

    // Checkpoint every 50 profiles
    if ((i + 1) % 50 === 0) {
        await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });
        console.log(`  [checkpoint] ${i + 1} done, state saved`);
    }

    // Small delay between requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

await browser.close();

await Actor.setValue('STATE', { doneUsernames: [...doneUsernames] });

console.log([
    `\n${'═'.repeat(50)}`,
    `DONE`,
    `  Total processed : ${doneUsernames.size}`,
    `  Succeeded        : ${succeeded}`,
    `  Not found/failed : ${failed}`,
    `  No count data    : ${skipped}`,
    `${'═'.repeat(50)}`,
].join('\n'));

await Actor.exit();
