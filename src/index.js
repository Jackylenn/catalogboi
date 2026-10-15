const config = require('./config');
const steam = require('./steam');
const playfab = require('./playfab');
const { diffCatalog, syncUpcomingNamesFromMapping } = require('./tracker');
const { autoBuyFreeItems } = require('./autobuy');
const { initBot, sendChanges, sendAutoBuyNotification, updateCheckStats, updateListMessage, updateStatusMessage, sleep, getClient } = require('./discord');

let pollTimeout = null;
let statusTimeout = null;
let isShuttingDown = false;
let isChecking = false;

function scheduleNextCheck(delayMs) {
    if (isShuttingDown) return;
    if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
    }
    const safeDelay = Math.max(5000, Number(delayMs !== undefined ? delayMs : config.pollIntervalMs) || 60000);
    pollTimeout = setTimeout(async () => {
        try {
            await runCheck();
        } catch (e) {
            console.error('[Check] Unexpected error during check loop:', e.message);
        } finally {
            scheduleNextCheck();
        }
    }, safeDelay);
}

function scheduleNextStatus(delayMs) {
    if (isShuttingDown) return;
    if (statusTimeout) {
        clearTimeout(statusTimeout);
        statusTimeout = null;
    }
    const safeDelay = Math.max(5000, Number(delayMs !== undefined ? delayMs : 60000) || 60000);
    statusTimeout = setTimeout(async () => {
        try {
            await updateStatusMessage();
        } catch (e) {
            console.error('[Discord] Unexpected error updating status message:', e.message);
        } finally {
            scheduleNextStatus();
        }
    }, safeDelay);
}

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

    // Run first check immediately (Catalog, Auto-Buy, Dev CCU)
    await runCheck();

    // Ensure list & status channel messages are initialized
    await updateListMessage();
    await updateStatusMessage();

    // Schedule recurring checks and status updates
    scheduleNextCheck();
    scheduleNextStatus();
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

        // 2. Auto-buy any free item immediately (price = 0)
        try {
            const bought = await autoBuyFreeItems(catalog, sendAutoBuyNotification);
            if (bought.length > 0) {
                console.log(`[AutoBuy] Auto-bought ${bought.length} free item(s)!`);
            }
        } catch (abErr) {
            console.error('[AutoBuy] Check error:', abErr.message);
        }

        // 3. Fetch & diff Dev CCU Tracker
        console.log('[Check] Checking Dev CCU...');
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

        if (catalog && typeof catalog.length === 'number') {
            updateCheckStats(catalog.length);
        }
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
function shutdown() {
    console.log('\nShutting down...');
    isShuttingDown = true;
    if (pollTimeout) clearTimeout(pollTimeout);
    if (statusTimeout) clearTimeout(statusTimeout);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});