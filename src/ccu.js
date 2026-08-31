const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CCU_BASELINE_PATH = path.join(DATA_DIR, 'ccu_baseline.json');

// Gorilla Tag Dev / Beta CCU Endpoint
const CCU_ENDPOINT = process.env.CCU_API_URL || 'https://moderationfunctions-dev.azurewebsites.net/api/CCU';

/**
 * Fetch live CCU from Gorilla Tag Moderation Functions API.
 */
function fetchLiveCCU() {
    return new Promise((resolve) => {
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
                    resolve({ ccuTotal: null, error: data });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('CCU API request timed out (10s)'));
        });

        req.on('error', (err) => {
            resolve({ ccuTotal: null, error: err.message });
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
 * If isStartup is true, sends an initial status embed on boot.
 */
async function diffCCU(isStartup = false) {
    const live = await fetchLiveCCU();

    // In dev/beta endpoint, null or error indicates 0 players currently online
    const newCCU = (live && live.ccuTotal !== null && live.ccuTotal !== undefined)
        ? parseInt(live.ccuTotal, 10)
        : 0;

    const saved = getSavedCCU();

    if (isStartup || !saved || saved.ccuTotal === undefined) {
        console.log(`[CCU] Startup check - ${newCCU} player(s) online.`);
        saveCCUBaseline({ ccuTotal: newCCU, lastUpdated: new Date().toISOString() });
        return {
            isStartup: true,
            newCCU,
            oldCCU: null,
            diff: 0,
            timestamp: new Date(),
        };
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
            isStartup: false,
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

