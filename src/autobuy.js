const fs = require('fs');
const path = require('path');
const playfab = require('./playfab');
const { getItemDisplayName } = require('./tracker');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTOBOUGHT_FILE = path.join(DATA_DIR, 'autobought_items.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

/**
 * Load set of item IDs that have already been bought or confirmed owned.
 */
function loadKnownOwnedItems() {
    if (fs.existsSync(AUTOBOUGHT_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(AUTOBOUGHT_FILE, 'utf8'));
            if (Array.isArray(raw)) {
                return new Set(raw);
            }
        } catch (e) {
            console.error('[AutoBuy] Error reading autobought_items.json:', e.message);
        }
    }
    return new Set();
}

/**
 * Save set of item IDs to disk.
 */
function saveKnownOwnedItems(itemSet) {
    try {
        fs.writeFileSync(AUTOBOUGHT_FILE, JSON.stringify(Array.from(itemSet), null, 2), 'utf8');
    } catch (e) {
        console.error('[AutoBuy] Error saving autobought_items.json:', e.message);
    }
}

/**
 * Check if a catalog item is free (price = 0).
 * An item is free if it has VirtualCurrencyPrices with price 0 (e.g. SR: 0).
 */
function isFreeItem(item) {
    if (!item || !item.ItemId) return false;

    // Check virtual currency prices
    if (item.VirtualCurrencyPrices && typeof item.VirtualCurrencyPrices === 'object') {
        const entries = Object.entries(item.VirtualCurrencyPrices);
        if (entries.length > 0) {
            return entries.some(([, price]) => price === 0);
        }
    }

    // Check real currency prices (rare/fallback)
    if (item.RealCurrencyPrices && typeof item.RealCurrencyPrices === 'object') {
        const entries = Object.entries(item.RealCurrencyPrices);
        if (entries.length > 0) {
            return entries.some(([, price]) => price === 0);
        }
    }

    return false;
}

/**
 * Determine the currency code to use for purchasing a free item.
 */
function getFreeCurrencyCode(item) {
    if (item.VirtualCurrencyPrices && typeof item.VirtualCurrencyPrices === 'object') {
        const freeVc = Object.keys(item.VirtualCurrencyPrices).find(c => item.VirtualCurrencyPrices[c] === 0);
        if (freeVc) return freeVc;
    }
    return 'SR';
}

let isInventorySeeded = false;

/**
 * Query user inventory from PlayFab to seed known owned items.
 */
async function syncInventory() {
    if (isInventorySeeded) return;
    try {
        const invRes = await playfab.getUserInventory();
        if (invRes && invRes.code === 200 && invRes.data?.Inventory) {
            const known = loadKnownOwnedItems();
            let addedCount = 0;
            for (const item of invRes.data.Inventory) {
                if (item && item.ItemId && !known.has(item.ItemId)) {
                    known.add(item.ItemId);
                    addedCount++;
                }
            }
            if (addedCount > 0) {
                saveKnownOwnedItems(known);
                console.log(`[AutoBuy] Synced inventory: added ${addedCount} owned items to baseline.`);
            }
            isInventorySeeded = true;
        }
    } catch (e) {
        console.warn('[AutoBuy] Could not sync user inventory:', e.message);
    }
}

/**
 * Scan catalog for free items (price = 0) and buy them immediately with the bot's session ticket.
 * Scans ALL items in the entire catalog (data/catalog_baseline.json and any live catalog passed in).
 */
async function autoBuyFreeItems(catalog = null, notifyFn = null) {
    const ticket = playfab.getSessionTicket();
    if (!ticket) {
        console.warn('[AutoBuy] No active bot session ticket. Skipping autobuy check.');
        return [];
    }

    // 1. Gather all items from data/catalog_baseline.json
    const itemMap = new Map();
    const baselinePath = path.join(DATA_DIR, 'catalog_baseline.json');
    if (fs.existsSync(baselinePath)) {
        try {
            const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
            if (Array.isArray(baseline)) {
                for (const item of baseline) {
                    if (item && item.ItemId) {
                        itemMap.set(item.ItemId, item);
                    }
                }
            }
        } catch (e) {
            console.error('[AutoBuy] Error reading catalog_baseline.json:', e.message);
        }
    }

    // 2. Also merge with any live catalog items passed in
    if (Array.isArray(catalog) && catalog.length > 0) {
        for (const item of catalog) {
            if (item && item.ItemId) {
                itemMap.set(item.ItemId, item);
            }
        }
    }

    const allItems = Array.from(itemMap.values());
    if (allItems.length === 0) {
        console.warn('[AutoBuy] No items found in catalog baseline or live catalog.');
        return [];
    }

    // Sync inventory once on startup/first run
    await syncInventory();

    const knownItems = loadKnownOwnedItems();
    const freeItems = allItems.filter(isFreeItem);
    const boughtResults = [];

    console.log(`[AutoBuy] Full catalog scan: checking all ${allItems.length} items (${freeItems.length} free items with price 0 detected).`);

    for (const item of freeItems) {
        if (knownItems.has(item.ItemId)) {
            continue; // Already bought or owned
        }

        const currency = getFreeCurrencyCode(item);
        const displayName = getItemDisplayName(item.ItemId, item.DisplayName) || item.ItemId;
        console.log(`[AutoBuy] 🆓 Free item detected: ${item.ItemId} ("${displayName}")! Price: 0 ${currency}`);
        console.log(`[AutoBuy] Running buy cmd with bot session ticket...`);

        try {
            const result = await playfab.purchaseItem(ticket, item.ItemId, 0, currency);

            if (result && result.code === 200) {
                console.log(`[AutoBuy] 🎉 Successfully purchased free item: ${item.ItemId} ("${displayName}")!`);
                knownItems.add(item.ItemId);
                saveKnownOwnedItems(knownItems);

                boughtResults.push({ item, result, success: true });

                if (typeof notifyFn === 'function') {
                    try {
                        await notifyFn(item, result);
                    } catch (nErr) {
                        console.error('[AutoBuy] Error sending Discord notification:', nErr.message);
                    }
                }
            } else {
                const errMsg = result?.errorMessage || result?.status || 'Unknown error';
                console.warn(`[AutoBuy] Purchase response for ${item.ItemId}: (${result?.code}) ${errMsg}`);

                // Check if user already owns the item
                const isAlreadyOwned = errMsg.toLowerCase().includes('already owns') ||
                    errMsg.toLowerCase().includes('not stackable') ||
                    errMsg.toLowerCase().includes('already owned') ||
                    result?.errorCode === 1058;

                if (isAlreadyOwned) {
                    console.log(`[AutoBuy] Item ${item.ItemId} is already owned by the account. Marking as owned.`);
                    knownItems.add(item.ItemId);
                    saveKnownOwnedItems(knownItems);
                }
            }
        } catch (err) {
            console.error(`[AutoBuy] Failed to buy ${item.ItemId}:`, err.message);
            if (err.message.toLowerCase().includes('already owns') || err.message.toLowerCase().includes('not stackable')) {
                knownItems.add(item.ItemId);
                saveKnownOwnedItems(knownItems);
            }
        }
    }

    return boughtResults;
}

/**
 * Check if the bot account currently owns a given item ID.
 */
async function checkIfItemOwned(itemId) {
    if (!itemId) return { owned: false, reason: 'No item ID specified' };

    const normalized = itemId.trim().toUpperCase();
    const withDot = normalized.endsWith('.') ? normalized : normalized + '.';
    const withoutDot = normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;

    try {
        const invRes = await playfab.getUserInventory();
        if (invRes && invRes.code === 200 && invRes.data?.Inventory) {
            const match = invRes.data.Inventory.find(inv => 
                inv && (inv.ItemId === normalized || inv.ItemId === withDot || inv.ItemId === withoutDot)
            );
            if (match) {
                const known = loadKnownOwnedItems();
                known.add(match.ItemId);
                saveKnownOwnedItems(known);
                return { owned: true, item: match, live: true };
            }
            return { owned: false, live: true };
        }
    } catch (e) {
        console.warn('[AutoBuy] Could not query live inventory for check:', e.message);
    }

    const known = loadKnownOwnedItems();
    if (known.has(normalized) || known.has(withDot) || known.has(withoutDot)) {
        return { owned: true, live: false, cached: true };
    }

    return { owned: false, live: false };
}

module.exports = {
    isFreeItem,
    autoBuyFreeItems,
    loadKnownOwnedItems,
    saveKnownOwnedItems,
    checkIfItemOwned,
};
