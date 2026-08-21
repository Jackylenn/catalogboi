const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const REFRESH_TOKEN_PATH = path.join(__dirname, '..', 'data', 'steam_refresh_token.txt');

let client = null;
let isLoggedIn = false;

/**
 * Log into Steam headlessly with minimal RAM footprint.
 */
function login() {
    return new Promise((resolve, reject) => {
        // Disable PICS cache and unneeded data caches to stay well below 40MB RAM
        client = new SteamUser({
            renewRefreshTokens: true,
            enablePicsCache: false,
            dataDirectory: null,
        });

        // Save refresh token when received
        client.on('refreshToken', (token) => {
            console.log('[Steam] Received new refresh token. Saving for automated logins...');
            try {
                fs.writeFileSync(REFRESH_TOKEN_PATH, token, 'utf8');
            } catch (e) {
                console.error('[Steam] Failed to save refresh token:', e.message);
            }
        });

        client.on('loggedOn', () => {
            console.log('[Steam] Logged in successfully as', client.steamID.getSteamID64());
            isLoggedIn = true;
            resolve(client);
        });

        client.on('steamGuard', (domain, callback) => {
            const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
            const prompt = domain
                ? `[Steam Guard] Enter code sent to your email (${domain}): `
                : '[Steam Guard] Enter code from your Steam Mobile Authenticator app: ';
            rl.question(prompt, (code) => {
                rl.close();
                callback(code.trim());
            });
        });

        client.on('error', (err) => {
            console.error('[Steam] Login error:', err.message);
            isLoggedIn = false;
            if (fs.existsSync(REFRESH_TOKEN_PATH) && (err.eresult === SteamUser.EResult.InvalidPassword || err.eresult === SteamUser.EResult.AccessDenied)) {
                console.warn('[Steam] Saved refresh token is no longer valid. Removing it.');
                try { fs.unlinkSync(REFRESH_TOKEN_PATH); } catch { }
            }
            reject(err);
        });

        client.on('disconnected', (eresult, msg) => {
            console.warn('[Steam] Disconnected:', msg);
            isLoggedIn = false;
        });

        let logOnOptions = {};
        if (fs.existsSync(REFRESH_TOKEN_PATH)) {
            try {
                const savedToken = fs.readFileSync(REFRESH_TOKEN_PATH, 'utf8').trim();
                if (savedToken) {
                    console.log('[Steam] Logging in using saved refresh token...');
                    logOnOptions = { refreshToken: savedToken };
                }
            } catch (e) {
                console.warn('[Steam] Could not read saved refresh token:', e.message);
            }
        }

        if (!logOnOptions.refreshToken) {
            console.log(`[Steam] Logging in as ${config.steam.username}...`);
            logOnOptions = {
                accountName: config.steam.username,
                password: config.steam.password,
            };
        }

        client.logOn(logOnOptions);
    });
}

/**
 * Get a fresh Steam auth session ticket for PlayFab authentication.
 */
async function getAuthTicket() {
    if (!client || !isLoggedIn) {
        let waited = 0;
        while ((!client || !isLoggedIn) && waited < 10) {
            await new Promise(r => setTimeout(r, 1000));
            waited++;
        }
        if (!client || !isLoggedIn) {
            throw new Error('Not logged into Steam. Please ensure Steam connection is active.');
        }
    }

    const result = await client.createAuthSessionTicket(config.steam.appId);
    return result.sessionTicket.toString('hex');
}

function getClient() { return client; }
function getIsLoggedIn() { return isLoggedIn; }

module.exports = { login, getAuthTicket, getClient, getIsLoggedIn };