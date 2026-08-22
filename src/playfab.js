const https = require('https');
const config = require('./config');
const steam = require('./steam');

const BASE_URL = `https://${config.playfab.titleId}.playfabapi.com`;
let sessionTicket = null;

/**
 * Robust native HTTPS request function (immune to Node 18/19 undici fetch socket bugs in Docker).
 */
function makeHttpsRequest(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const headers = Object.assign({
            'User-Agent': 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
            'Content-Type': 'application/json',
            'Accept': '*/*',
        }, options.headers || {});

        const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        if (bodyStr) {
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'POST',
            headers: headers,
            timeout: 15000,
        };

        const req = https.request(reqOptions, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const responseText = Buffer.concat(chunks).toString('utf8');
                try {
                    const data = JSON.parse(responseText);
                    resolve(data);
                } catch {
                    resolve({ code: res.statusCode, raw: responseText });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('PlayFab request timed out (15s)'));
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (bodyStr) {
            req.write(bodyStr);
        }
        req.end();
    });
}

/**
 * Execute request with retry for network resilience.
 */
async function requestWithRetry(url, options = {}, body = null, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await makeHttpsRequest(url, options, body);
            return result;
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                console.warn(`[PlayFab] Connection attempt ${attempt}/${maxRetries} failed (${err.message}). Retrying in 2s...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
    throw lastError;
}

/**
 * Login to PlayFab using a Steam auth ticket.
 */
async function loginWithSteam(steamTicketHex) {
    const data = await requestWithRetry(`${BASE_URL}/Client/LoginWithSteam`, {
        method: 'POST',
    }, {
        TitleId: config.playfab.titleId,
        SteamTicket: steamTicketHex,
        CreateAccount: false,
    });

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

    let data = await requestWithRetry(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'X-Authorization': sessionTicket,
        },
    }, body || {});

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

        data = await requestWithRetry(`${BASE_URL}${endpoint}`, {
            method: 'POST',
            headers: {
                'X-Authorization': sessionTicket,
            },
        }, body || {});
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
    const data = await requestWithRetry(url, {
        method: 'POST',
        headers: {
            'x-authorization': userSessionTicket.trim(),
            'x-playfabsdk': 'UnitySDK-2.87.200602',
            'x-reporterrorassuccess': 'true',
            'x-unity-version': '6000.2.9f1',
        },
    }, {
        CatalogVersion: 'DLC',
        CharacterId: null,
        ItemId: itemId.trim(),
        Price: parseInt(price) || 0,
        StoreId: null,
        VirtualCurrency: (currency || 'SR').trim(),
        AuthenticationContext: null,
    });

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