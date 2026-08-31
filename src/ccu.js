const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CCU_BASELINE_PATH = path.join(DATA_DIR, 'ccu_baseline.json');

const CCU_ENDPOINT = 'https://moderationfunctions-dev.azurewebsites.net/api/CCU';

/**
 * Fetch live CCU from Gorilla Tag Moderation Functions API.
 */
function fetchLiveCCU() {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(CCU_ENDPOINT);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'accept': '*/*',
                'content-type': 'application/x-www-form-urlencoded',
                'user-agent': 'UnityPlayer/6000.2.9f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
                'x-unity-version': '6000.2.9f1',
                'Content-Length': 0,
            },
            timeout: 10000,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Failed to parse CCU response: ${data.substring(0, 100)}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('CCU API request timed out (10s)'));
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.end();
    });
}

/**
 * Read the saved baseline CCU data.
 */
function getSavedCCU() {
    if (fs.existsSync(CCU_BASELINE_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(CCU_BASELINE_PATH, 'utf8'));
        } catch { }
    }
    return null;
}

/**
 * Save baseline CCU data.
 */
function saveCCUBaseline(data) {
    try {
        fs.writeFileSync(CCU_BASELINE_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[CCU] Failed to save baseline:', e.message);
    }
}

/**
 * Compare live CCU against saved baseline.
 * Returns null if no change (or baseline initialized), or change object { oldCCU, newCCU, diff, diffStr, pctChange, timestamp }
 */
async function diffCCU() {
    const live = await fetchLiveCCU();
    if (live.ccuTotal === undefined || live.ccuTotal === null) {
        console.warn(`[CCU] Service temporarily unavailable: ${live.errorMessage || 'No CCU count returned'}`);
        return null;
    }

    const newCCU = parseInt(live.ccuTotal, 10);
    const saved = getSavedCCU();

    if (!saved || saved.ccuTotal === undefined) {
        console.log(`[CCU] First run - initialized baseline with ${newCCU} player(s).`);
        saveCCUBaseline({ ccuTotal: newCCU, lastUpdated: new Date().toISOString() });
        return null;
    }

    const oldCCU = parseInt(saved.ccuTotal, 10);

    if (newCCU !== oldCCU) {
        const diff = newCCU - oldCCU;
        const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
        let pctChange = 0;
        if (oldCCU > 0) {
            pctChange = ((diff / oldCCU) * 100).toFixed(1);
        }

        const change = {
            oldCCU,
            newCCU,
            diff,
            diffStr,
            pctChange,
            timestamp: new Date(),
        };

        saveCCUBaseline({ ccuTotal: newCCU, lastUpdated: new Date().toISOString() });
        return change;
    }

    return null;
}

module.exports = {
    fetchLiveCCU,
    getSavedCCU,
    diffCCU,
    CCU_ENDPOINT,
};
