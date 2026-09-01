const https = require('https');
const crypto = require('crypto');
const config = require('./config');

const MOTHERSHIP_TITLE_ID = process.env.MOTHERSHIP_TITLE_ID || 'f3e9fb19';
const MOTHERSHIP_DEPLOYMENT_ID = process.env.MOTHERSHIP_DEPLOYMENT_ID || 'a25d8da6-0390-42a9-a07c-a910662d6806';
const MOTHERSHIP_ENV_ID = process.env.MOTHERSHIP_ENV_ID || 'fdc86860-8d61-4136-9631-7dab23d2e08e';
const MOTHERSHIP_TOKEN = process.env.MOTHERSHIP_TOKEN || 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiI1MDIxM2Q3OC0xYjhmLTQ2NmMtYmFlMS1kNTI4NDMwZDEwMmMiLCJkaWQiOiJhMjVkOGRhNi0wMzkwLTQyYTktYTA3Yy1hOTEwNjYyZDY4MDYiLCJlbnYiOiJmZGM4Njg2MC04ZDYxLTQxMzYtOTYzMS03ZGFiMjNkMmUwOGUiLCJleHRlcm5hbFNlcnZpY2UiOiJSSUZUIiwiZXh0ZXJuYWxTZXJ2aWNlSWQiOiI1NjY2ODI5ODAzMzYwMDM5IiwidGlkIjoiZjNlOWZiMTkiLCJ0YWdzIjpudWxsLCJvcmdTY29wZWRFeHRlcm5hbFNlcnZpY2VJZCI6IjU3MTYxOTE2NjE3OTU0ODEiLCJuYmYiOjE3ODgyNzE0MDcsImV4cCI6MTc4ODI3NTAwNywiaWF0IjoxNzg4MjcxNDA3fQ.Ni1plLRKU8Nuf3DEpGHgyj3bx9DbgokX53MH5KDZwwIEoNuvYaESAgnBt2DOoBuwEtTfCI9E1nnH_ias8LdNCg';

/**
 * Fetch Title Data from Mothership API Gateway.
 */
function fetchMothershipTitleData() {
    return new Promise((resolve, reject) => {
        const sessionId = crypto.randomUUID();
        const headers = {
            'accept': '*/*',
            'content-type': 'application/octet-stream',
            'user-agent': 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
            'x-mothership-accept-language': 'en',
            'x-mothership-deployment-id': MOTHERSHIP_DEPLOYMENT_ID,
            'x-mothership-env-id': MOTHERSHIP_ENV_ID,
            'x-mothership-sdk-version': 'v2026.5.18-1',
            'x-mothership-session-id': sessionId,
            'x-mothership-title-id': MOTHERSHIP_TITLE_ID,
            'x-mothership-token': MOTHERSHIP_TOKEN,
            'x-unity-version': '6000.2.9f1',
        };

        const options = {
            hostname: `${MOTHERSHIP_TITLE_ID}.prod.aa-mothership.com`,
            path: '/v1/title-data/client',
            method: 'GET',
            headers: headers,
            timeout: 10000,
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    const parsed = JSON.parse(text);
                    const dict = {};
                    if (parsed.Results && Array.isArray(parsed.Results)) {
                        for (const item of parsed.Results) {
                            if (item.key) dict[item.key] = item.data;
                        }
                    }
                    resolve(dict);
                } catch (e) {
                    reject(new Error(`Failed to parse Mothership response (Status ${res.statusCode}): ${e.message}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('Mothership Title Data request timed out (10s)'));
        });

        req.on('error', reject);
        req.end();
    });
}

module.exports = {
    fetchMothershipTitleData,
};

