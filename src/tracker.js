const fs = require('fs');
const path = require('path');
const { getItemCategory } = require('./categories');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG_BASELINE = path.join(DATA_DIR, 'catalog_baseline.json');
const TITLE_DATA_BASELINE = path.join(DATA_DIR, 'title_data_baseline.json');
const UPCOMING_COSMETICS = path.join(DATA_DIR, 'upcoming_cosmetics.json');
const DEV_CATALOG_BASELINE = path.join(DATA_DIR, 'dev_catalog_baseline.json');
const DEV_TITLE_DATA_BASELINE = path.join(DATA_DIR, 'dev_title_data_baseline.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Price & Currency Helpers ────────────────────────────────────

function getPrice(item) {
    if (item.VirtualCurrencyPrices && Object.keys(item.VirtualCurrencyPrices).length > 0) {
        return Object.values(item.VirtualCurrencyPrices)[0];
    }
    if (item.RealCurrencyPrices && Object.keys(item.RealCurrencyPrices).length > 0) {
        return Object.values(item.RealCurrencyPrices)[0];
    }
    return 0;
}

function getPriceString(item) {
    const parts = [];
    if (item.VirtualCurrencyPrices && Object.keys(item.VirtualCurrencyPrices).length > 0) {
        for (const [code, val] of Object.entries(item.VirtualCurrencyPrices)) {
            parts.push(`${val} ${getCurrencyName(code)}`);
        }
    }
    if (item.RealCurrencyPrices && Object.keys(item.RealCurrencyPrices).length > 0) {
        for (const [code, val] of Object.entries(item.RealCurrencyPrices)) {
            const formatted = (val / 100).toFixed(2);
            parts.push(`${formatted} ${code}`);
        }
    }
    return parts.length > 0 ? parts.join(', ') : 'No Price';
}

function getFormattedPrice(item) {
    if (item.VirtualCurrencyPrices && Object.keys(item.VirtualCurrencyPrices).length > 0) {
        const val = Object.values(item.VirtualCurrencyPrices)[0];
        if (val === 0) return 'Free';
        return `${val} Shiny Rocks`;
    }
    if (item.RealCurrencyPrices && Object.keys(item.RealCurrencyPrices).length > 0) {
        const val = Object.values(item.RealCurrencyPrices)[0];
        if (val === 0) return 'Free';
        return `${(val / 100).toFixed(2)}`;
    }
    return 'No Price';
}

function getCurrencyName(code) {
    switch (code.toUpperCase()) {
        case 'SR': return 'Shiny Rocks';
        case 'RM': return 'Real Money';
        default: return code;
    }
}

function pricesEqual(a, b) {
    const aV = a.VirtualCurrencyPrices || {};
    const bV = b.VirtualCurrencyPrices || {};
    const aR = a.RealCurrencyPrices || {};
    const bR = b.RealCurrencyPrices || {};
    return JSON.stringify(aV) === JSON.stringify(bV) && JSON.stringify(aR) === JSON.stringify(bR);
}

function bundlesEqual(a, b) {
    const aBundle = a.Bundle || {};
    const bBundle = b.Bundle || {};
    const aItems = (aBundle.BundledItems || []).slice().sort();
    const bItems = (bBundle.BundledItems || []).slice().sort();
    if (JSON.stringify(aItems) !== JSON.stringify(bItems)) return false;

    function sortObj(o) {
        return Object.keys(o).sort().reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});
    }
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
            if ((oldItem.DisplayName || '') !== (newItem.DisplayName || '')) {
                changes.push({
                    type: 'name_change',
                    item: newItem,
                    oldName: oldItem.DisplayName,
                    newName: newItem.DisplayName,
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

            // Bundle content change
            if (oldItem.Bundle || newItem.Bundle) {
                if (!bundlesEqual(oldItem, newItem)) {
                    changes.push({
                        type: 'bundle_change',
                        item: newItem,
                        oldItem,
                    });
                }
            }
        }
    } else if (isFirstRun) {
        console.log('[Tracker] First run - saving initial catalog baseline.');
    }

    // Save new baseline
    try {
        fs.writeFileSync(CATALOG_BASELINE, JSON.stringify(newCatalog, null, 2));
        console.log(`[Tracker] Catalog baseline saved (${newCatalog.length} items).`);
    } catch (e) {
        console.error('[Tracker] Failed to save catalog baseline:', e.message);
    }

    return changes;
}

// ─── Title Data Diff ─────────────────────────────────────────────


function parseTitleDataInput(inputJson) {
    if (!inputJson) return {};
    let parsed = inputJson;
    if (typeof inputJson === 'string') {
        try {
            parsed = JSON.parse(inputJson);
        } catch {
            return {};
        }
    }

    // 1. Mothership / Game Cache format: { Results: [ { key: "...", data: "..." } ] }
    if (parsed.Results && Array.isArray(parsed.Results)) {
        const dict = {};
        for (const item of parsed.Results) {
            if (item && item.key) {
                dict[item.key] = item.data;
            }
        }
        return dict;
    }

    // 2. PlayFab CacheImport format: { TitleData: { en: { ... } } }
    if (parsed.TitleData && typeof parsed.TitleData === 'object') {
        const langKey = parsed.TitleData.en ? 'en' : Object.keys(parsed.TitleData)[0];
        if (langKey && parsed.TitleData[langKey]) {
            return parsed.TitleData[langKey];
        }
    }

    // 3. Direct Key-Value Dictionary format: { "key": "value" }
    return parsed;
}



function diffTitleData(rawTitleData, isFallback = false) {
    const newTitleData = parseTitleDataInput(rawTitleData);
    const changes = [];

    let oldTitleData = null;
    if (fs.existsSync(TITLE_DATA_BASELINE)) {
        try {
            oldTitleData = parseTitleDataInput(fs.readFileSync(TITLE_DATA_BASELINE, 'utf8'));
        } catch (e) {
            console.error('[Tracker] Failed to read title data baseline:', e.message);
        }
    }

    if (oldTitleData && Object.keys(oldTitleData).length > 0) {
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

        // Removed keys (only if not in fallback mode)
        if (!isFallback) {
            for (const key of oldKeys) {
                if (!newKeys.has(key)) {
                    changes.push({
                        type: 'title_data_removed',
                        key,
                        oldValue: oldTitleData[key],
                    });
                }
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
    } else {
        console.log(`[Tracker] Initial run - saving initial title data baseline (${Object.keys(newTitleData).length} keys).`);
    }

    // Auto-update baseline (merge in fallback mode to preserve Mothership keys)
    try {
        const toSave = isFallback && oldTitleData ? Object.assign({}, oldTitleData, newTitleData) : newTitleData;
        fs.writeFileSync(TITLE_DATA_BASELINE, JSON.stringify(toSave, null, 2));
        console.log(`[Tracker] Title data baseline saved (${Object.keys(toSave).length} keys).`);
    } catch (e) {
        console.error('[Tracker] Failed to save title data baseline:', e.message);
    }

    return changes;
}




// ─── Upcoming Cosmetics ─────────────────────────────────────────


const ITEM_NAMES_FILE = path.join(DATA_DIR, 'item_names.txt');

let cachedNameMap = null;

/**
 * Load item name mapping from file (supports item_names.txt or new.txt).
 */
function loadItemNamesMap(forceReload = false) {
    if (cachedNameMap && !forceReload) return cachedNameMap;
    const map = {};
    const possiblePaths = [
        path.join(DATA_DIR, 'item_names.txt'),
        path.join(__dirname, '..', 'item_names.txt'),
        path.join(DATA_DIR, 'new.txt'),
        path.join(__dirname, '..', 'new.txt'),
        'C:\\Users\\gebruiker\\Downloads\\new.txt',
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            try {
                const content = fs.readFileSync(p, 'utf8');
                const lines = content.split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
                    if (trimmed.includes('//')) {
                        const parts = trimmed.split('//').map(s => s.trim());
                        if (parts.length >= 2 && parts[0] && parts[1]) {
                            const id = parts[0];
                            const name = parts[1];
                            map[id.toUpperCase()] = name;
                            if (id.endsWith('.')) {
                                map[id.slice(0, -1).toUpperCase()] = name;
                            } else {
                                map[(id + '.').toUpperCase()] = name;
                            }
                        }
                    }
                }
                console.log(`[Tracker] Loaded ${Object.keys(map).length / 2} item name mappings from ${path.basename(p)}.`);
                break;
            } catch (e) {
                console.error('[Tracker] Error loading item names from:', p, e.message);
            }
        }
    }
    cachedNameMap = map;
    return map;
}

/**
 * Get cosmetic DisplayName from mapping or fallback.
 */
function getItemDisplayName(itemId, fallbackDisplayName = null) {
    if (!itemId) return fallbackDisplayName || '';
    const map = loadItemNamesMap();
    const mapped = map[itemId.toUpperCase()];
    if (mapped && mapped !== itemId) return mapped;
    if (fallbackDisplayName && fallbackDisplayName !== itemId) return fallbackDisplayName;
    return '';
}

/**
 * Sync DisplayNames for all items in upcoming_cosmetics.json from the item names mapping.
 */

/**
 * Parse CosmeticsController text into a Map of { idUpper -> { id, name, price, raw } }
 */
function parseCosmeticsControllerText(text) {
    const map = new Map();
    if (!text) return map;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.includes('//')) {
            const parts = trimmed.split('//').map(s => s.trim());
            if (parts.length >= 2 && parts[0]) {
                const id = parts[0];
                if (id.toLowerCase() === 'null') continue;
                const name = parts[1] || '';
                const price = parts[2] || 'No Price';
                map.set(id.toUpperCase(), {
                    id,
                    name,
                    price,
                    raw: trimmed,
                });
            }
        }
    }
    return map;
}

/**
 * Diff two CosmeticsController text dumps.
 */
function diffCosmeticsController(oldText, newText) {
    const oldMap = parseCosmeticsControllerText(oldText);
    const newMap = parseCosmeticsControllerText(newText);

    const added = [];
    const modified = [];
    const removed = [];

    for (const [key, newItem] of newMap.entries()) {
        if (!oldMap.has(key)) {
            added.push(newItem);
        } else {
            const oldItem = oldMap.get(key);
            if (oldItem.name !== newItem.name || oldItem.price !== newItem.price) {
                modified.push({
                    id: newItem.id,
                    oldName: oldItem.name,
                    newName: newItem.name,
                    oldPrice: oldItem.price,
                    newPrice: newItem.price,
                });
            }
        }
    }

    for (const [key, oldItem] of oldMap.entries()) {
        if (!newMap.has(key)) {
            removed.push(oldItem);
        }
    }

    return { added, modified, removed, totalOld: oldMap.size, totalNew: newMap.size };
}

/**
 * Update the baseline item_names.txt reference and resync upcoming cosmetics.
 */
function updateCosmeticsControllerBaseline(newText) {
    const pathsToUpdate = [
        path.join(DATA_DIR, 'item_names.txt'),
        path.join(__dirname, '..', 'item_names.txt'),
        path.join(__dirname, '..', 'new.txt'),
    ];

    for (const p of pathsToUpdate) {
        try {
            fs.writeFileSync(p, newText, 'utf8');
        } catch (e) {
            console.error('[Tracker] Failed to write to', p, e.message);
        }
    }

    cachedNameMap = null;
    loadItemNamesMap(true);
    syncUpcomingNamesFromMapping();
}

function getCosmeticsControllerBaselineText() {
    const possiblePaths = [
        path.join(DATA_DIR, 'item_names.txt'),
        path.join(__dirname, '..', 'item_names.txt'),
        path.join(DATA_DIR, 'new.txt'),
        path.join(__dirname, '..', 'new.txt'),
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            try {
                return fs.readFileSync(p, 'utf8');
            } catch { }
        }
    }
    return '';
}

function syncUpcomingNamesFromMapping() {
    if (!fs.existsSync(UPCOMING_COSMETICS)) return;
    const nameMap = loadItemNamesMap(true);
    if (Object.keys(nameMap).length === 0) return;

    try {
        let items = JSON.parse(fs.readFileSync(UPCOMING_COSMETICS, 'utf8'));
        let updatedCount = 0;

        for (const item of items) {
            const mappedName = nameMap[(item.ItemId || '').toUpperCase()];
            if (mappedName && (!item.DisplayName || item.DisplayName === item.ItemId || item.DisplayName.trim() === '')) {
                item.DisplayName = mappedName;
                updatedCount++;
            }
        }

        if (updatedCount > 0) {
            fs.writeFileSync(UPCOMING_COSMETICS, JSON.stringify(items, null, 2));
            console.log(`[Tracker] Updated DisplayNames for ${updatedCount} upcoming cosmetic(s) from item names reference.`);
        }
    } catch (e) {
        console.error('[Tracker] Failed to sync names to upcoming_cosmetics.json:', e.message);
    }
}

function appendToUpcomingCosmetics(newItems) {
    if (!newItems || newItems.length === 0) return;

    try {
        let existing = [];
        if (fs.existsSync(UPCOMING_COSMETICS)) {
            existing = JSON.parse(fs.readFileSync(UPCOMING_COSMETICS, 'utf8'));
        }

        const existingIds = new Set(existing.map(i => i.ItemId));
        let addedCount = 0;

        const nameMap = loadItemNamesMap();
        for (const item of newItems) {
            if (!existingIds.has(item.ItemId)) {
                if ((!item.DisplayName || item.DisplayName === item.ItemId) && nameMap[item.ItemId.toUpperCase()]) {
                    item.DisplayName = nameMap[item.ItemId.toUpperCase()];
                }
                existing.push(item);
                existingIds.add(item.ItemId);
                addedCount++;
            }
        }

        if (addedCount > 0) {
            fs.writeFileSync(UPCOMING_COSMETICS, JSON.stringify(existing, null, 2));
            console.log(`[Tracker] Added ${addedCount} item(s) to upcoming_cosmetics.json (total: ${existing.length})`);
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

function removeUpcomingCosmetics(itemIds) {
    const list = getUpcomingCosmetics();
    const rawIds = (Array.isArray(itemIds) ? itemIds : [itemIds]);
    
    // Normalize IDs (support with or without trailing dot, case-insensitive)
    const normalizedTargets = new Set();
    for (const raw of rawIds) {
        const id = raw.trim().toUpperCase();
        if (!id) continue;
        normalizedTargets.add(id);
        if (id.endsWith('.')) {
            normalizedTargets.add(id.slice(0, -1));
        } else {
            normalizedTargets.add(id + '.');
        }
    }

    const removed = [];
    const remaining = list.filter(item => {
        const idUpper = (item.ItemId || '').toUpperCase();
        if (normalizedTargets.has(idUpper)) {
            removed.push(item);
            return false;
        }
        return true;
    });

    try {
        fs.writeFileSync(UPCOMING_COSMETICS, JSON.stringify(remaining, null, 2));
        console.log(`[Tracker] Removed ${removed.length} item(s) from upcoming cosmetics. ${remaining.length} remaining.`);
    } catch (e) {
        console.error('[Tracker] Failed to save upcoming cosmetics:', e.message);
    }

    return { removed, remainingCount: remaining.length };
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
    for (const f of [CATALOG_BASELINE, TITLE_DATA_BASELINE, UPCOMING_COSMETICS, DEV_CATALOG_BASELINE]) {
        if (fs.existsSync(f)) {
            fs.unlinkSync(f);
            console.log(`[Tracker] Deleted ${path.basename(f)}`);
        }
    }
}

module.exports = {
    diffCatalog,
    diffTitleData,
    diffDevCatalog,
    diffDevTitleData,
    getUpcomingCosmetics,
    loadItemNamesMap,
    getItemDisplayName,
    syncUpcomingNamesFromMapping,
    removeUpcomingCosmetics,
    clearUpcomingCosmetics,
    resetBaselines,
    diffCosmeticsController,
    updateCosmeticsControllerBaseline,
    getCosmeticsControllerBaselineText,
    parseTitleDataInput,
    getFormattedPrice,
    getPrice,
    getPriceString,
    getCurrencyName,
};

// ─── Dev Catalog Diff (TitleId: 195C0) ───────────────────────────

function diffDevCatalog(newCatalog) {
    const changes = [];
    let isFirstRun = false;

    let oldCatalog = null;
    if (fs.existsSync(DEV_CATALOG_BASELINE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(DEV_CATALOG_BASELINE, 'utf8'));
            oldCatalog = raw.Items || raw;
        } catch (e) {
            console.error('[Tracker] Failed to parse dev catalog baseline:', e.message);
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
                type: 'dev_new_item',
                item,
                displayName: item.DisplayName || item.ItemId,
            });
        }

        // Removed items
        for (const item of oldCatalog.filter(i => !newDict[i.ItemId])) {
            changes.push({
                type: 'dev_removed_item',
                item,
                displayName: item.DisplayName || item.ItemId,
            });
        }

        // Changed items
        for (const oldItem of oldCatalog.filter(i => newDict[i.ItemId])) {
            const newItem = newDict[oldItem.ItemId];

            // Name change
            if ((oldItem.DisplayName || '') !== (newItem.DisplayName || '')) {
                changes.push({
                    type: 'dev_name_change',
                    item: newItem,
                    oldName: oldItem.DisplayName,
                    newName: newItem.DisplayName,
                });
            }

            // Price change
            if (!pricesEqual(oldItem, newItem)) {
                changes.push({
                    type: 'dev_price_change',
                    item: newItem,
                    oldItem,
                });
            }

            // Bundle change
            if (oldItem.Bundle || newItem.Bundle) {
                if (!bundlesEqual(oldItem, newItem)) {
                    changes.push({
                        type: 'dev_bundle_change',
                        item: newItem,
                        oldItem,
                    });
                }
            }
        }
    } else if (isFirstRun) {
        console.log(`[Tracker] First run - saving initial dev catalog baseline (${newCatalog.length} items).`);
    }

    // Save new dev baseline
    try {
        fs.writeFileSync(DEV_CATALOG_BASELINE, JSON.stringify(newCatalog, null, 2));
    } catch (e) {
        console.error('[Tracker] Failed to save dev catalog baseline:', e.message);
    }

    return changes;
}

function diffDevTitleData(newTitleData) {
    const changes = [];
    let oldTitleData = null;
    let isFirstRun = false;

    if (fs.existsSync(DEV_TITLE_DATA_BASELINE)) {
        try {
            oldTitleData = JSON.parse(fs.readFileSync(DEV_TITLE_DATA_BASELINE, 'utf8'));
        } catch (e) {
            console.error('[Tracker] Failed to read dev title data baseline:', e.message);
            isFirstRun = true;
        }
    } else {
        isFirstRun = true;
    }

    if (oldTitleData && Object.keys(oldTitleData).length > 0 && !isFirstRun) {
        const oldKeys = new Set(Object.keys(oldTitleData));
        const newKeys = new Set(Object.keys(newTitleData));

        for (const key of newKeys) {
            if (!oldKeys.has(key)) {
                changes.push({
                    type: 'dev_title_data_new',
                    key,
                    newValue: newTitleData[key],
                });
            }
        }

        for (const key of oldKeys) {
            if (!newKeys.has(key)) {
                changes.push({
                    type: 'dev_title_data_removed',
                    key,
                    oldValue: oldTitleData[key],
                });
            }
        }

        for (const key of oldKeys) {
            if (newKeys.has(key) && oldTitleData[key] !== newTitleData[key]) {
                changes.push({
                    type: 'dev_title_data_changed',
                    key,
                    oldValue: oldTitleData[key],
                    newValue: newTitleData[key],
                });
            }
        }
    } else if (isFirstRun) {
        console.log(`[Tracker] Initial run - saving initial dev title data baseline (${Object.keys(newTitleData).length} keys).`);
    }

    try {
        fs.writeFileSync(DEV_TITLE_DATA_BASELINE, JSON.stringify(newTitleData, null, 2));
    } catch (e) {
        console.error('[Tracker] Failed to save dev title data baseline:', e.message);
    }

    return changes;
}
