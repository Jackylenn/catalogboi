const https = require('https');
const crypto = require('crypto');

const TITLE_ID = process.env.MOTHERSHIP_TITLE_ID || 'f3e9fb19';

const PROD_CONFIG = {
    envId: process.env.MOTHERSHIP_ENV_ID || 'fdc86860-8d61-4136-9631-7dab23d2e08e',
    deploymentId: process.env.MOTHERSHIP_DEPLOYMENT_ID || 'a25d8da6-0390-42a9-a07c-a910662d6806',
};

const DEV_CONFIG = {
    envId: process.env.MOTHERSHIP_DEV_ENV_ID || 'fdc86860-8d61-4136-9631-7dab23d2e08e',
    deploymentId: process.env.MOTHERSHIP_DEV_DEPLOYMENT_ID || 'a25d8da6-0390-42a9-a07c-a910662d6806',
};

// Built-in working token for live Mothership access (76 keys)
const DEFAULT_TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiI1MDIxM2Q3OC0xYjhmLTQ2NmMtYmFlMS1kNTI4NDMwZDEwMmMiLCJkaWQiOiJhMjVkOGRhNi0wMzkwLTQyYTktYTA3Yy1hOTEwNjYyZDY4MDYiLCJlbnYiOiJmZGM4Njg2MC04ZDYxLTQxMzYtOTYzMS03ZGFiMjNkMmUwOGUiLCJleHRlcm5hbFNlcnZpY2UiOiJSSUZUIiwiZXh0ZXJuYWxTZXJ2aWNlSWQiOiI1NjY2ODI5ODAzMzYwMDM5IiwidGlkIjoiZjNlOWZiMTkiLCJ0YWdzIjpudWxsLCJvcmdTY29wZWRFeHRlcm5hbFNlcnZpY2VJZCI6IjU3MTYxOTE2NjE3OTU0ODEiLCJuYmYiOjE3ODgyNzE0MDcsImV4cCI6MTc4ODI3NTAwNywiaWF0IjoxNzg4MjcxNDA3fQ.Ni1plLRKU8Nuf3DEpGHgyj3bx9DbgokX53MH5KDZwwIEoNuvYaESAgnBt2DOoBuwEtTfCI9E1nnH_ias8LdNCg';

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
 * Fetch all 76 live Title Data keys from Mothership Gateway.
 */
async function fetchMothershipTitleData(isDev = false) {
    const config = isDev ? DEV_CONFIG : PROD_CONFIG;
    const token = (isDev ? process.env.MOTHERSHIP_DEV_TOKEN : process.env.MOTHERSHIP_TOKEN) || DEFAULT_TOKEN;
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

    if (res.status !== 200) {
        throw new Error(`Mothership Title Data returned status ${res.status}: ${JSON.stringify(res.data || res.raw)}`);
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
    fetchMothershipTitleData,
};

