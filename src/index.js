const config = require('./config');
const steam = require('./steam');
const playfab = require('./playfab');
const { diffCatalog, diffTitleData, syncUpcomingNamesFromMapping } = require('./tracker');
const { initBot, sendChanges, updateCheckStats, updateListMessage, updateStatusMessage, sleep, getClient } = require('./discord');
const { checkHierarchyDumpsOnStartup } = require('./hierarchy');
const { checkShopify } = require('./shopify');

let pollInterval = null;
let statusInterval = null;
let isChecking = false;

async function main() {
    console.log('=== Gorilla Tag Catalog Tracker Bot ===');
    console.log(`Poll interval: ${config.pollIntervalSeconds}s (${(config.pollIntervalSeconds / 60).toFixed(1)} min)`);

    // 1. Log into Steam
    console.log('\n[1/3] Logging into Steam...');
    try {
        await steam.login();
    } catch (e) {
        console.error('Failed to log into Steam:', e.message);
        process.exit(1);
    }

    // 2. Get Steam auth ticket and log into PlayFab (with retry)
    console.log('\n[2/3] Authenticating with PlayFab...');
    let playfabSuccess = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const ticket = await steam.getAuthTicket();
            console.log(`[Steam] Got auth ticket (${ticket.length} chars)`);
            await playfab.loginWithSteam(ticket);
            playfabSuccess = true;
            break;
        } catch (e) {
            console.warn(`[PlayFab] Attempt ${attempt}/5 failed: ${e.message}`);
            if (attempt < 5) await sleep(2500);
        }
    }

    if (!playfabSuccess) {
        console.error('Failed to authenticate with PlayFab after multiple attempts.');
        process.exit(1);
    }

    // 3. Start Discord bot
    console.log('\n[3/3] Starting Discord bot...');
    try {
        await initBot();
    } catch (e) {
        console.error('Failed to start Discord bot:', e.message);
        process.exit(1);
    }

    // Startup Only: Sync item display names from reference mapping
    if (typeof syncUpcomingNamesFromMapping === 'function') {
        try {
            syncUpcomingNamesFromMapping();
            await updateListMessage();
        } catch (e) {
            console.warn('[Tracker] Names sync note:', e.message);
        }
    }

    // Startup Only: Check & diff hierarchy dump files once
    try {
        await checkHierarchyDumpsOnStartup(getClient());
    } catch (e) {
        console.warn('[Hierarchy] Check error:', e.message);
    }

    // Startup: Check & post initial Dev/Beta CCU status embed
    try {
        const { diffCCU } = require('./ccu');
        const { sendCCUChange } = require('./discord');
        const startupCCU = await diffCCU(true);
        if (startupCCU) {
            await sendCCUChange(startupCCU);
        }
    } catch (e) {
        console.warn('[CCU] Startup check note:', e.message);
    }

    console.log('\n=== Bot is running! ===');
    console.log('Running initial check...\n');

    // Run first check immediately (Catalog, Title Data, Shopify)
    await runCheck();

    // Ensure list & status channel messages are initialized
    await updateListMessage();
    await updateStatusMessage();

    // Schedule recurring checks for everything (Catalog, Title Data, Shopify)
    pollInterval = setInterval(async () => {
        await runCheck();
    }, config.pollIntervalMs);

    // Schedule recurring 60s heartbeat / status message updates
    statusInterval = setInterval(async () => {
        await updateStatusMessage();
    }, 60 * 1000);
}

async function runCheck() {
    if (isChecking) {
        console.log('[Check] Already running, skipping...');
        return;
    }

    isChecking = true;
    const timestamp = new Date().toISOString();
    console.log(`\n[Check] Starting check at ${timestamp}`);

    try {
        // Re-auth with PlayFab if session expired
        if (!playfab.getSessionTicket()) {
            console.log('[Check] Re-authenticating with PlayFab...');
            const ticket = await steam.getAuthTicket();
            await playfab.loginWithSteam(ticket);
        }

        // 1. Fetch & diff PlayFab Catalog
        console.log('[Check] Fetching catalog...');
        let catalog;
        try {
            catalog = await playfab.getCatalogItems();
            console.log(`[Check] Catalog: ${catalog.length} items`);
        } catch (e) {
            // If auth expired, try re-auth once
            if (e.message.includes('NotAuthenticated') || e.message.includes('401')) {
                console.log('[Check] Session expired, re-authenticating...');
                playfab.clearSession();
                const ticket = await steam.getAuthTicket();
                await playfab.loginWithSteam(ticket);
                catalog = await playfab.getCatalogItems();
                console.log(`[Check] Catalog: ${catalog.length} items (after re-auth)`);
            } else {
                throw e;
            }
        }

        // Diff catalog
        const catalogChanges = diffCatalog(catalog);
        if (catalogChanges.length > 0) {
            console.log(`[Check] ${catalogChanges.length} catalog change(s) detected!`);
            await sendChanges(catalogChanges);
        } else {
            console.log('[Check] No catalog changes.');
        }

        // 2. Fetch & diff PlayFab Title Data
        console.log('[Check] Fetching title data...');
        let titleData;
        try {
            titleData = await playfab.getTitleData();
            console.log(`[Check] Title data: ${Object.keys(titleData).length} keys`);
        } catch (e) {
            console.error('[Check] Failed to fetch title data:', e.message);
            titleData = null;
        }

        // Diff title data
        if (titleData) {
            const titleChanges = diffTitleData(titleData);
            if (titleChanges.length > 0) {
                console.log(`[Check] ${titleChanges.length} title data change(s) detected!`);
                await sendChanges(titleChanges);
            } else {
                console.log('[Check] No title data changes.');
            }
        }

        // 3. Fetch & diff Shopify Merch Store
        console.log('[Check] Checking Shopify merch store...');
        try {
            const shopifyChanges = await checkShopify(getClient());
            if (shopifyChanges && shopifyChanges.length > 0) {
                console.log(`[Check] ${shopifyChanges.length} Shopify change(s) detected!`);
            } else {
                console.log('[Check] No Shopify store changes.');
            }
        } catch (e) {
            console.error('[Check] Shopify check error:', e.message);
        }

        // 4. Fetch & diff CCU Tracker
        console.log('[Check] Checking CCU...');
        try {
            const { diffCCU } = require('./ccu');
            const { sendCCUChange } = require('./discord');
            const ccuChange = await diffCCU();
            if (ccuChange) {
                console.log(`[Check] CCU changed: ${ccuChange.oldCCU} -> ${ccuChange.newCCU} (${ccuChange.diffStr})`);
                await sendCCUChange(ccuChange);
            } else {
                console.log('[Check] No CCU changes.');
            }
        } catch (e) {
            console.error('[Check] CCU check error:', e.message);
        }

        // 5. Fetch & diff Dev PlayFab Catalog (TitleId: 195C0)
        console.log('[Check] Checking Dev PlayFab catalog (195C0)...');
        try {
            const devPlayfab = require('./dev_playfab');
            const { diffDevCatalog } = require('./tracker');
            const { sendDevChanges } = require('./discord');

            const devCatalog = await devPlayfab.getDevCatalogItems();
            const devCatalogChanges = diffDevCatalog(devCatalog);

            if (devCatalogChanges.length > 0) {
                console.log(`[Check] ${devCatalogChanges.length} Dev catalog change(s) detected!`);
                await sendDevChanges(devCatalogChanges);
            } else {
                console.log('[Check] No Dev catalog changes.');
            }
        } catch (e) {
            console.error('[Check] Dev PlayFab check error:', e.message);
        }

        updateCheckStats(catalog.length);
        await updateStatusMessage();
        console.log(`[Check] Done. Next check in ${config.pollIntervalSeconds}s.`);

    } catch (e) {
        console.error('[Check] Error during check:', e.message);
        playfab.clearSession();
    } finally {
        isChecking = false;
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (pollInterval) clearInterval(pollInterval);
    if (statusInterval) clearInterval(statusInterval);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    if (pollInterval) clearInterval(pollInterval);
    if (statusInterval) clearInterval(statusInterval);
    process.exit(0);
});

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});