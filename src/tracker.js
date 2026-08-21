const fs = require('fs');
const path = require('path');
const { getItemCategory } = require('./categories');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG_BASELINE = path.join(DATA_DIR, 'catalog_baseline.json');
const TITLE_DATA_BASELINE = path.join(DATA_DIR, 'title_data_baseline.json');
const UPCOMING_COSMETICS = path.join(DATA_DIR, 'upcoming_cosmetics.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Helpers ─────────────────────────────────────────────────────

function getPrice(item) {
    if (item.VirtualCurrencyPrices) {
        const keys = Object.keys(item.VirtualCurrencyPrices);
        if (keys.length > 0) {
            const price = item.VirtualCurrencyPrices[keys[0]];
            return price;
        }
    }
    if (item.RealCurrencyPrices) {
        const keys = Object.keys(item.RealCurrencyPrices);
        if (keys.length > 0) return item.RealCurrencyPrices[keys[0]];
    }
    return null;
}

function getFormattedPrice(item) {
    const price = getPrice(item);
    if (price === null || price === undefined) return 'No Price';
    if (price === 0) return 'Free';
    return price.toString();
}

function getCurrencyName(key) {
    if (key === 'SR') return 'Shiny Rocks';
    if (key === 'RM') return 'Real Money';
    return key;
}

function getPriceString(item) {
    const parts = [];
    if (item.VirtualCurrencyPrices) {
        for (const [k, v] of Object.entries(item.VirtualCurrencyPrices)) {
            parts.push(`${getCurrencyName(k)}: ${v}`);
        }
    }
    if (item.RealCurrencyPrices) {
        for (const [k, v] of Object.entries(item.RealCurrencyPrices)) {
            parts.push(`${getCurrencyName(k)}: ${v}`);
        }
    }
    return parts.length > 0 ? parts.join(' | ') : 'None';
}

function pricesEqual(a, b) {
    const aV = a.VirtualCurrencyPrices || {};
    const bV = b.VirtualCurrencyPrices || {};
    const aR = a.RealCurrencyPrices || {};
    const bR = b.RealCurrencyPrices || {};
    return JSON.stringify(sortObj(aV)) === JSON.stringify(sortObj(bV))
        && JSON.stringify(sortObj(aR)) === JSON.stringify(sortObj(bR));
}

function sortObj(obj) {
    return Object.keys(obj).sort().reduce((r, k) => { r[k] = obj[k]; return r; }, {});
}

function bundlesEqual(a, b) {
    const aBundle = a.Bundle || null;
    const bBundle = b.Bundle || null;
    if (!aBundle && !bBundle) return true;
    if (!aBundle || !bBundle) return false;
    const aItems = [...(aBundle.BundledItems || [])].sort();
    const bItems = [...(bBundle.BundledItems || [])].sort();
    if (JSON.stringify(aItems) !== JSON.stringify(bItems)) return false;
    const aCur = sortObj(aBundle.BundledVirtualCurrencies || {});
    const bCur = sortObj(bBundle.BundledVirtualCurrencies || {});
    return JSON.stringify(aCur) === JSON.stringify(bCur);
}

// ─── Catalog Diff ────────────────────────────────────────────────

function diffCatalog(newCatalog) {
    const changes = [];
    let isFirstRun = false;

    let oldCatalog = null;
    if (fs.existsSync(CATALOG_BASELINE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(CATALOG_BASELINE, 'utf8'));
            oldCatalog = raw.Items || raw;
        } catch (e) {
            console.error('[Tracker] Failed to parse catalog baseline:', e.message);
            isFirstRun = true;
        }
    } else {
        isFirstRun = true;
    }

    if (oldCatalog && !isFirstRun) {
        const oldDict = {};
        for (const item of oldCatalog) oldDict[item.ItemId] = item;
        const newDict = {};
        for (const item of newCatalog) newDict[item.ItemId] = item;

        // New items
        const newItems = newCatalog.filter(i => !oldDict[i.ItemId]);
        for (const item of newItems) {
            changes.push({
                type: 'new_item',
                item,
                displayName: item.DisplayName || item.ItemId,
            });
        }

        // Append new items to upcoming cosmetics
        if (newItems.length > 0) {
            appendToUpcomingCosmetics(newItems);
        }

        // Sync upcoming cosmetics with latest prices/names
        syncUpcomingCosmetics(newCatalog);

        // Removed items
        for (const item of oldCatalog.filter(i => !newDict[i.ItemId])) {
            changes.push({
                type: 'removed_item',
                item,
                displayName: item.DisplayName || item.ItemId,
            });
        }

        // Changed items
        for (const oldItem of oldCatalog.filter(i => newDict[i.ItemId])) {
            const newItem = newDict[oldItem.ItemId];

            // Name change
            const oldName = oldItem.DisplayName || '';
            const newName = newItem.DisplayName || '';
            if (oldName !== newName) {
                changes.push({
                    type: 'name_change',
                    item: newItem,
                    oldName,
                    newName,
                });
            }

            // Price change
            if (!pricesEqual(oldItem, newItem)) {
                changes.push({
                    type: 'price_change',
                    item: newItem,
                    oldItem,
                });
            }

            // Bundle change
            if (!bundlesEqual(oldItem, newItem)) {
                changes.push({
                    type: 'bundle_change',
                    item: newItem,
                    oldItem,
                });
            }
        }
    } else if (isFirstRun) {
        console.log('[Tracker] First run - saving catalog baseline.');
    }

    // Save new baseline
    try {
        fs.writeFileSync(CATALOG_BASELINE, JSON.stringify({ Items: newCatalog }, null, 2));
        console.log(`[Tracker] Catalog baseline saved (${newCatalog.length} items).`);
    } catch (e) {
        console.error('[Tracker] Failed to save catalog baseline:', e.message);
    }

    return changes;
}

// ─── Title Data Diff ─────────────────────────────────────────────

function diffTitleData(newTitleData) {
    const changes = [];
    let isFirstRun = false;

    let oldTitleData = null;
    if (fs.existsSync(TITLE_DATA_BASELINE)) {
        try {
            oldTitleData = JSON.parse(fs.readFileSync(TITLE_DATA_BASELINE, 'utf8'));
        } catch (e) {
            console.error('[Tracker] Failed to parse title data baseline:', e.message);
            isFirstRun = true;
        }
    } else {
        isFirstRun = true;
    }

    if (oldTitleData && !isFirstRun) {
        const oldKeys = new Set(Object.keys(oldTitleData));
        const newKeys = new Set(Object.keys(newTitleData));

        // New keys
        for (const key of newKeys) {
            if (!oldKeys.has(key)) {
                changes.push({
                    type: 'title_data_new',
                    key,
                    newValue: newTitleData[key],
                });
            }
        }

        // Removed keys
        for (const key of oldKeys) {
            if (!newKeys.has(key)) {
                changes.push({
                    type: 'title_data_removed',
                    key,
                    oldValue: oldTitleData[key],
                });
            }
        }

        // Changed values
        for (const key of oldKeys) {
            if (newKeys.has(key) && oldTitleData[key] !== newTitleData[key]) {
                changes.push({
                    type: 'title_data_changed',
                    key,
                    oldValue: oldTitleData[key],
                    newValue: newTitleData[key],
                });
            }
        }
    } else if (isFirstRun) {
        console.log('[Tracker] First run - saving title data baseline.');
    }

    // Save new baseline
    try {
        fs.writeFileSync(TITLE_DATA_BASELINE, JSON.stringify(newTitleData, null, 2));
        console.log(`[Tracker] Title data baseline saved (${Object.keys(newTitleData).length} keys).`);
    } catch (e) {
        console.error('[Tracker] Failed to save title data baseline:', e.message);
    }

    return changes;
}

// ─── Upcoming Cosmetics ─────────────────────────────────────────

function appendToUpcomingCosmetics(newItems) {
    if (!newItems || newItems.length === 0) return;

    try {
        let existing = [];
        if (fs.existsSync(UPCOMING_COSMETICS)) {
            existing = JSON.parse(fs.readFileSync(UPCOMING_COSMETICS, 'utf8')) || [];
        }

        const existingIds = new Set(existing.map(i => i.ItemId));
        let added = 0;
        for (const item of newItems) {
            if (!existingIds.has(item.ItemId)) {
                existing.push(item);
                added++;
            }
        }

        if (added > 0) {
            fs.writeFileSync(UPCOMING_COSMETICS, JSON.stringify(existing, null, 2));
            console.log(`[Tracker] Added ${added} items to upcoming_cosmetics.json (Total: ${existing.length}).`);
        }
    } catch (e) {
        console.error('[Tracker] Failed to save upcoming cosmetics:', e.message);
    }
}

function syncUpcomingCosmetics(newCatalog) {
    if (!fs.existsSync(UPCOMING_COSMETICS) || !newCatalog) return;

    try {
        let existing = JSON.parse(fs.readFileSync(UPCOMING_COSMETICS, 'utf8'));
        if (!existing || existing.length === 0) return;

        const catalogDict = {};
        for (const item of newCatalog) catalogDict[item.ItemId] = item;

        let updatedAny = false;
        for (let i = 0; i < existing.length; i++) {
            const fresh = catalogDict[existing[i].ItemId];
            if (fresh) {
                if (!pricesEqual(existing[i], fresh) || (existing[i].DisplayName || '') !== (fresh.DisplayName || '')) {
                    existing[i] = fresh;
                    updatedAny = true;
                }
            }
        }

        if (updatedAny) {
            fs.writeFileSync(UPCOMING_COSMETICS, JSON.stringify(existing, null, 2));
            console.log('[Tracker] Synced updated prices/names to upcoming_cosmetics.json.');
        }
    } catch (e) {
        console.error('[Tracker] Failed to sync upcoming cosmetics:', e.message);
    }
}

function getUpcomingCosmetics() {
    if (!fs.existsSync(UPCOMING_COSMETICS)) return [];
    try {
        return JSON.parse(fs.readFileSync(UPCOMING_COSMETICS, 'utf8')) || [];
    } catch {
        return [];
    }
}

function clearUpcomingCosmetics() {
    try {
        if (fs.existsSync(UPCOMING_COSMETICS)) {
            fs.writeFileSync(UPCOMING_COSMETICS, JSON.stringify([], null, 2));
            console.log('[Tracker] Cleared upcoming_cosmetics.json');
        }
    } catch (e) {
        console.error('[Tracker] Failed to clear upcoming cosmetics:', e.message);
    }
}

function resetBaselines() {
    for (const f of [CATALOG_BASELINE, TITLE_DATA_BASELINE, UPCOMING_COSMETICS]) {
        if (fs.existsSync(f)) {
            fs.unlinkSync(f);
            console.log(`[Tracker] Deleted ${path.basename(f)}`);
        }
    }
}

module.exports = {
    diffCatalog,
    diffTitleData,
    getUpcomingCosmetics,
    clearUpcomingCosmetics,
    resetBaselines,
    getFormattedPrice,
    getPrice,
    getPriceString,
    getCurrencyName,
};