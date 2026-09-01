const https = require('https');
const crypto = require('crypto');
const steam = require('./steam');

// Default Prod / Dev settings from Gorilla Tag
const TITLE_ID = process.env.MOTHERSHIP_TITLE_ID || 'f3e9fb19';

const PROD_CONFIG = {
    envId: process.env.MOTHERSHIP_ENV_ID || '7f3a99dd-5598-4725-98cf-6538d28feb9f',
    deploymentId: process.env.MOTHERSHIP_DEPLOYMENT_ID || 'abadf120-bb2f-48e2-b154-978c8fc1eac2',
};

const DEV_CONFIG = {
    envId: process.env.MOTHERSHIP_DEV_ENV_ID || 'fdc86860-8d61-4136-9631-7dab23d2e08e',
    deploymentId: process.env.MOTHERSHIP_DEV_DEPLOYMENT_ID || 'a25d8da6-0390-42a9-a07c-a910662d6806',
};

let cachedProdToken = null;
let cachedDevToken = null;

function httpsReq(options, payload) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch {
                    resolve({ status: res.statusCode, raw: body });
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error(`Request to ${options.hostname}${options.path} timed out`));
        });
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * Authenticate with Mothership using Steam ticket and Nonce (V2 Auth API).
 */
async function authenticateMothership(isDev = false) {
    const config = isDev ? DEV_CONFIG : PROD_CONFIG;
    const sessionId = crypto.randomUUID();

    const baseHeaders = {
        'accept': '*/*',
        'user-agent': 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
        'x-mothership-sdk-version': 'v2026.5.18-1',
        'x-mothership-title-id': TITLE_ID,
        'x-mothership-env-id': config.envId,
        'x-mothership-deployment-id': config.deploymentId,
        'x-mothership-session-id': sessionId,
        'x-mothership-accept-language': 'en',
        'x-unity-version': '6000.2.9f1',
    };

    // Step 1: Request Nonce
    const beginRes = await httpsReq({
        hostname: `${TITLE_ID}.prod.aa-mothership.com`,
        path: '/v2/player/client/auth/begin/STEAM',
        method: 'GET',
        headers: baseHeaders,
        timeout: 10000,
    });

    if (!beginRes.data || !beginRes.data.Nonce) {
        throw new Error(`Failed to obtain Mothership auth nonce: ${JSON.stringify(beginRes)}`);
    }

    const nonce = beginRes.data.Nonce;

    // Step 2: Get Steam auth ticket
    await steam.login();
    const steamTicketHex = await steam.getAuthTicket();

    // Step 3: Complete Steam auth
    const completePayload = JSON.stringify({
        Nonce: nonce,
        SteamTicket: steamTicketHex,
    });

    const completeHeaders = Object.assign({}, baseHeaders, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(completePayload),
    });

    const completeRes = await httpsReq({
        hostname: `${TITLE_ID}.prod.aa-mothership.com`,
        path: '/v2/player/client/auth/complete/STEAM',
        method: 'POST',
        headers: completeHeaders,
        timeout: 10000,
    }, completePayload);

    if (completeRes.data && completeRes.data.Token) {
        const token = completeRes.data.Token;
        if (isDev) {
            cachedDevToken = token;
        } else {
            cachedProdToken = token;
        }
        console.log(`[Mothership] Authenticated successfully with Mothership (${isDev ? 'DEV' : 'PROD'}). PlayerId: ${completeRes.data.PlayerId}`);
        return token;
    } else {
        throw new Error(`Mothership auth completion failed (${completeRes.status}): ${JSON.stringify(completeRes.data || completeRes.raw)}`);
    }
}

/**
 * Fetch live Title Data dictionary from Mothership. Automatically authenticates / refreshes token.
 */
async function fetchMothershipTitleData(isDev = false, retry = true) {
    let token = isDev ? (cachedDevToken || process.env.MOTHERSHIP_DEV_TOKEN) : (cachedProdToken || process.env.MOTHERSHIP_TOKEN);
    const config = isDev ? DEV_CONFIG : PROD_CONFIG;

    if (!token) {
        token = await authenticateMothership(isDev);
    }

    const sessionId = crypto.randomUUID();
    const headers = {
        'accept': '*/*',
        'content-type': 'application/octet-stream',
        'user-agent': 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
        'x-mothership-accept-language': 'en',
        'x-mothership-deployment-id': config.deploymentId,
        'x-mothership-env-id': config.envId,
        'x-mothership-sdk-version': 'v2026.5.18-1',
        'x-mothership-session-id': sessionId,
        'x-mothership-title-id': TITLE_ID,
        'x-mothership-token': token,
        'x-unity-version': '6000.2.9f1',
    };

    const res = await httpsReq({
        hostname: `${TITLE_ID}.prod.aa-mothership.com`,
        path: '/v1/title-data/client',
        method: 'GET',
        headers: headers,
        timeout: 10000,
    });

    if (res.status === 401 && retry) {
        console.warn(`[Mothership] Token expired for ${isDev ? 'DEV' : 'PROD'}, re-authenticating...`);
        token = await authenticateMothership(isDev);
        return fetchMothershipTitleData(isDev, false);
    }

    if (res.status !== 200) {
        throw new Error(`Mothership Title Data request failed with status ${res.status}: ${JSON.stringify(res.data || res.raw)}`);
    }

    const dict = {};
    if (res.data && res.data.Results && Array.isArray(res.data.Results)) {
        for (const item of res.data.Results) {
            if (item.key) dict[item.key] = item.data;
        }
    }

    return dict;
}

module.exports = {
    authenticateMothership,
    fetchMothershipTitleData,
};

