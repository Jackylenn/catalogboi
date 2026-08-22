const config = require('./config');
const steam = require('./steam');

const BASE_URL = `https://${config.playfab.titleId}.playfabapi.com`;
let sessionTicket = null;

/**
 * Robust fetch wrapper with automatic retries for transient socket/terminated errors.
 */
async function fetchWithRetry(url, options, maxRetries = 5, delayMs = 1500) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fetch(url, options);
            return resp;
        } catch (err) {
            lastError = err;
            const errMsg = (err.cause?.message || err.message || '').toLowerCase();
            const isTransient = errMsg.includes('terminated') || errMsg.includes('econnreset') || errMsg.includes('socket') || errMsg.includes('etimedout') || errMsg.includes('fetch failed');
            if (isTransient && attempt < maxRetries) {
                console.warn(`[PlayFab] Network glitch (${errMsg}), retrying attempt ${attempt}/${maxRetries} in ${delayMs}ms...`);
                await new Promise(r => setTimeout(r, delayMs));
                delayMs *= 1.5;
            } else {
                throw err;
            }
        }
    }
    throw lastError;
}

/**
 * Login to PlayFab using a Steam auth ticket.
 */
async function loginWithSteam(steamTicketHex) {
    const resp = await fetchWithRetry(`${BASE_URL}/Client/LoginWithSteam`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'GorillaTag/PlayFabClient',
        },
        body: JSON.stringify({
            TitleId: config.playfab.titleId,
            SteamTicket: steamTicketHex,
            CreateAccount: false,
        }),
    });

    const data = await resp.json();
    if (data.code !== 200) {
        throw new Error(`PlayFab login failed (${data.code}): ${data.errorMessage || JSON.stringify(data)}`);
    }

    sessionTicket = data.data.SessionTicket;
    console.log('[PlayFab] Authenticated successfully with PlayFab.');
    return sessionTicket;
}

/**
 * Ensure we have a valid PlayFab session ticket. If force is true, generates a new one.
 */
async function ensureAuthenticated(force = false) {
    if (!sessionTicket || force) {
        console.log('[PlayFab] Requesting fresh Steam auth ticket and renewing PlayFab session...');
        const ticketHex = await steam.getAuthTicket();
        await loginWithSteam(ticketHex);
    }
    return sessionTicket;
}

/**
 * Generic PlayFab request wrapper with automatic session expiration recovery.
 */
async function playfabRequest(endpoint, body) {
    await ensureAuthenticated();

    let resp = await fetchWithRetry(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Authorization': sessionTicket,
            'User-Agent': 'GorillaTag/PlayFabClient',
        },
        body: JSON.stringify(body || {}),
    });

    let data = await resp.json();

    // If session expired or unauthorized, automatically renew ticket and retry once
    const isAuthError = data.code === 401
        || (data.errorMessage && (
            data.errorMessage.toLowerCase().includes('ticket') ||
            data.errorMessage.toLowerCase().includes('notauthenticated') ||
            data.errorMessage.toLowerCase().includes('expired') ||
            data.errorMessage.toLowerCase().includes('invalid session')
        ));

    if (isAuthError) {
        console.warn(`[PlayFab] Session ticket expired or invalid (${data.errorMessage || data.code}). Renewing...`);
        await ensureAuthenticated(true);

        resp = await fetchWithRetry(`${BASE_URL}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Authorization': sessionTicket,
                'User-Agent': 'GorillaTag/PlayFabClient',
            },
            body: JSON.stringify(body || {}),
        });
        data = await resp.json();
    }

    if (data.code !== 200) {
        throw new Error(`PlayFab ${endpoint} failed (${data.code}): ${data.errorMessage || JSON.stringify(data)}`);
    }

    return data.data;
}

/**
 * Fetch the full catalog from PlayFab.
 */
async function getCatalogItems() {
    const data = await playfabRequest('/Client/GetCatalogItems', { CatalogVersion: null });
    return data.Catalog || [];
}

/**
 * Fetch title data from PlayFab.
 */
async function getTitleData() {
    const data = await playfabRequest('/Client/GetTitleData', {});
    return data.Data || {};
}

/**
 * Purchase an item in Gorilla Tag using exact Unity client payload and headers.
 */
async function purchaseItem(userSessionTicket, itemId, price, currency = 'SR') {
    if (!userSessionTicket) throw new Error('Session ticket is required');
    if (!itemId) throw new Error('ItemId is required');

    const url = `${BASE_URL}/Client/PurchaseItem?sdk=UnitySDK-2.87.200602`;
    const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
            'accept': '*/*',
            'content-type': 'application/json',
            'user-agent': 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
            'x-authorization': userSessionTicket.trim(),
            'x-playfabsdk': 'UnitySDK-2.87.200602',
            'x-reporterrorassuccess': 'true',
            'x-unity-version': '6000.2.9f1',
        },
        body: JSON.stringify({
            CatalogVersion: 'DLC',
            CharacterId: null,
            ItemId: itemId.trim(),
            Price: parseInt(price) || 0,
            StoreId: null,
            VirtualCurrency: (currency || 'SR').trim(),
            AuthenticationContext: null,
        }),
    });

    const data = await resp.json();
    return data;
}

function getSessionTicket() { return sessionTicket; }
function clearSession() { sessionTicket = null; }

module.exports = {
    loginWithSteam,
    ensureAuthenticated,
    getCatalogItems,
    getTitleData,
    purchaseItem,
    getSessionTicket,
    clearSession,
};