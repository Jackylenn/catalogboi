const https = require('https');
const config = require('./config');
const steam = require('./steam');

const DEV_TITLE_ID = config.playfab.devTitleId || '195C0';
const BASE_URL = `https://${DEV_TITLE_ID}.playfabapi.com`;
let devSessionTicket = null;

/**
 * Make HTTPS request to Dev PlayFab.
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
            res.on('data', chunk => chunks.push(chunk));
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
            req.destroy(new Error('Dev PlayFab request timed out (15s)'));
        });

        req.on('error', err => reject(err));

        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

async function requestWithRetry(url, options = {}, body = null, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await makeHttpsRequest(url, options, body);
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                console.warn(`[Dev PlayFab] Connection attempt ${attempt}/${maxRetries} failed (${err.message}). Retrying in 2s...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
    throw lastError;
}

/**
 * Authenticate with Dev PlayFab (195C0) using Steam auth ticket.
 */
async function loginWithSteam(steamTicketHex) {
    const data = await requestWithRetry(`${BASE_URL}/Client/LoginWithSteam`, {
        method: 'POST',
    }, {
        TitleId: DEV_TITLE_ID,
        SteamTicket: steamTicketHex,
        CreateAccount: true,
    });

    if (data.code !== 200) {
        throw new Error(`Dev PlayFab login failed (${data.code}): ${data.errorMessage || JSON.stringify(data)}`);
    }

    devSessionTicket = data.data.SessionTicket;
    console.log('[Dev PlayFab] Authenticated successfully with Dev PlayFab (195C0).');
    return devSessionTicket;
}

async function ensureAuthenticated(force = false) {
    if (!devSessionTicket || force) {
        console.log('[Dev PlayFab] Renewing Dev PlayFab session...');
        const ticketHex = await steam.getAuthTicket();
        await loginWithSteam(ticketHex);
    }
    return devSessionTicket;
}

async function devPlayfabRequest(endpoint, body) {
    await ensureAuthenticated();

    let data = await requestWithRetry(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'X-Authorization': devSessionTicket,
        },
    }, body || {});

    const isAuthError = data.code === 401
        || (data.errorMessage && (
            data.errorMessage.toLowerCase().includes('ticket') ||
            data.errorMessage.toLowerCase().includes('notauthenticated') ||
            data.errorMessage.toLowerCase().includes('expired') ||
            data.errorMessage.toLowerCase().includes('invalid session')
        ));

    if (isAuthError) {
        console.warn(`[Dev PlayFab] Session expired (${data.errorMessage || data.code}). Renewing...`);
        await ensureAuthenticated(true);
        data = await requestWithRetry(`${BASE_URL}${endpoint}`, {
            method: 'POST',
            headers: {
                'X-Authorization': devSessionTicket,
            },
        }, body || {});
    }

    if (data.code !== 200) {
        throw new Error(`Dev PlayFab ${endpoint} failed (${data.code}): ${data.errorMessage || JSON.stringify(data)}`);
    }

    return data.data;
}

async function getDevCatalogItems() {
    const data = await devPlayfabRequest('/Client/GetCatalogItems', { CatalogVersion: null });
    return data.Catalog || [];
}

function getDevSessionTicket() { return devSessionTicket; }
function clearDevSession() { devSessionTicket = null; }

module.exports = {
    loginWithSteam,
    ensureAuthenticated,
    getDevCatalogItems,
    getDevSessionTicket,
    clearDevSession,
    DEV_TITLE_ID,
};

