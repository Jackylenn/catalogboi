const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const REFRESH_TOKEN_PATH = path.join(__dirname, '..', 'data', 'steam_refresh_token.txt');

let client = null;
let isLoggedIn = false;
let isLoggingIn = false;
let loginPromise = null;
let reconnectTimer = null;

/**
 * Log into Steam headlessly with minimal RAM footprint and automatic reconnect.
 */
function login() {
    if (isLoggedIn && client) return Promise.resolve(client);
    if (isLoggingIn && loginPromise) return loginPromise;

    isLoggingIn = true;
    loginPromise = new Promise((resolve, reject) => {
        if (!client) {
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
                isLoggingIn = false;
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }

                // Register game session so Steam knows the client is running Gorilla Tag (1533390)
                try {
                    client.gamesPlayed([Number(config.steam.appId) || 1533390]);
                } catch { }

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
                isLoggingIn = false;
                if (fs.existsSync(REFRESH_TOKEN_PATH) && (err.eresult === SteamUser.EResult.InvalidPassword || err.eresult === SteamUser.EResult.AccessDenied)) {
                    console.warn('[Steam] Saved refresh token is no longer valid. Removing it.');
                    try { fs.unlinkSync(REFRESH_TOKEN_PATH); } catch { }
                }
                scheduleReconnect();
                reject(err);
            });

            client.on('disconnected', (eresult, msg) => {
                console.warn(`[Steam] Disconnected: ${msg} (eresult ${eresult}). Scheduling auto-reconnect...`);
                isLoggedIn = false;
                isLoggingIn = false;
                scheduleReconnect();
            });
        }

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

    return loginPromise;
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!isLoggedIn) {
            console.log('[Steam] Attempting automatic reconnection...');
            login().catch(e => {
                console.warn('[Steam] Auto-reconnect attempt failed:', e.message);
            });
        }
    }, 10000);
}

/**
 * Get a fresh Steam auth session ticket for PlayFab authentication (with self-healing).
 */
async function getAuthTicket() {
    if (!client || !isLoggedIn) {
        console.log('[Steam] Session not active. Re-logging into Steam...');
        await login();
    }

    try {
        const result = await client.createAuthSessionTicket(config.steam.appId);
        return result.sessionTicket.toString('hex');
    } catch (e) {
        console.warn('[Steam] createAuthSessionTicket failed, retrying after re-login:', e.message);
        isLoggedIn = false;
        await login();
        const retryResult = await client.createAuthSessionTicket(config.steam.appId);
        return retryResult.sessionTicket.toString('hex');
    }
}

/**
 * Get an encrypted app ticket (optionally with nonce as userdata).
 */
async function getEncryptedAppTicket(nonce) {
    if (!client || !isLoggedIn) {
        await login();
    }
    const userData = nonce ? Buffer.from(nonce, 'utf8') : Buffer.alloc(0);
    const res = await client.createEncryptedAppTicket(config.steam.appId, userData);
    return res.encryptedAppTicket.toString('hex');
}

function getClient() { return client; }
function getIsLoggedIn() { return isLoggedIn; }

module.exports = { login, getAuthTicket, getEncryptedAppTicket, getClient, getIsLoggedIn };

