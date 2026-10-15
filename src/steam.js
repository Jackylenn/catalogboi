const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REFRESH_TOKEN_PATH = path.join(DATA_DIR, 'steam_refresh_token.txt');

let client = null;
let isLoggedIn = false;
let isLoggingIn = false;
let loginPromise = null;
let reconnectTimer = null;

/**
 * Initialize the SteamUser client singleton with core event listeners.
 */
function initClient() {
    if (client) return client;

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { }
    }

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
            console.log(`[Steam] Saved refresh token to ${REFRESH_TOKEN_PATH}`);
        } catch (e) {
            console.error('[Steam] Failed to save refresh token:', e.message);
        }
    });

    client.on('loggedOn', () => {
        console.log('[Steam] Logged in successfully as', client.steamID.getSteamID64());
        isLoggedIn = true;
        isLoggingIn = false;
        loginPromise = null;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // Register game session so Steam knows the client is running Gorilla Tag (1533390)
        try {
            client.gamesPlayed([Number(config.steam.appId) || 1533390]);
        } catch { }
    });

    client.on('steamGuard', (domain, callback) => {
        const isEmail = Boolean(domain);
        const promptType = isEmail
            ? `Email code sent to (${domain})`
            : 'Steam Mobile Authenticator app 2FA code';

        console.log('\n' + '='.repeat(60));
        console.log('[Steam Guard] ACTION REQUIRED');
        console.log(`Account "${config.steam.username}" requires Steam Guard verification.`);
        console.log(`Please enter the ${promptType} below and press Enter:`);
        console.log('='.repeat(60) + '\n');

        const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });

        const timer = setTimeout(() => {
            rl.close();
            console.error('\n[Steam Guard] Verification timed out after 120 seconds.');
            if (client) {
                try { client.logOff(); } catch { }
            }
        }, 120000);

        rl.question('> ', (code) => {
            clearTimeout(timer);
            rl.close();
            const trimmed = code.trim();
            if (!trimmed) {
                console.warn('[Steam Guard] No code entered, sending empty string to Steam.');
            }
            callback(trimmed);
        });
    });

    client.on('error', (err) => {
        console.error('[Steam] Login error:', err.message);
        isLoggedIn = false;
        isLoggingIn = false;
        loginPromise = null;

        if (fs.existsSync(REFRESH_TOKEN_PATH) && (err.eresult === SteamUser.EResult.InvalidPassword || err.eresult === SteamUser.EResult.AccessDenied)) {
            console.warn('[Steam] Saved refresh token is expired or revoked by Steam. Removing token file.');
            try { fs.unlinkSync(REFRESH_TOKEN_PATH); } catch { }
        }

        scheduleReconnect();
    });

    client.on('disconnected', (eresult, msg) => {
        console.warn(`[Steam] Disconnected: ${msg} (eresult ${eresult}). Scheduling auto-reconnect...`);
        isLoggedIn = false;
        isLoggingIn = false;
        loginPromise = null;
        scheduleReconnect();
    });

    return client;
}

/**
 * Log into Steam headlessly with minimal RAM footprint and automatic reconnect.
 */
function login() {
    if (isLoggedIn && client) return Promise.resolve(client);
    if (isLoggingIn && loginPromise) return loginPromise;

    isLoggingIn = true;
    const cl = initClient();

    loginPromise = new Promise((resolve, reject) => {
        const onLoggedOn = () => {
            cleanup();
            resolve(cl);
        };

        const onError = (err) => {
            cleanup();
            reject(err);
        };

        function cleanup() {
            cl.removeListener('loggedOn', onLoggedOn);
            cl.removeListener('error', onError);
            isLoggingIn = false;
            loginPromise = null;
        }

        cl.once('loggedOn', onLoggedOn);
        cl.once('error', onError);

        let logOnOptions = {};

        // Priority 1: STEAM_REFRESH_TOKEN from environment variables
        const envToken = (config.steam?.refreshToken || process.env.STEAM_REFRESH_TOKEN || '').trim();
        if (envToken) {
            console.log('[Steam] Logging in using STEAM_REFRESH_TOKEN from environment...');
            logOnOptions = { refreshToken: envToken };
        }

        // Priority 2: saved refresh token file
        if (!logOnOptions.refreshToken && fs.existsSync(REFRESH_TOKEN_PATH)) {
            try {
                const savedToken = fs.readFileSync(REFRESH_TOKEN_PATH, 'utf8').trim();
                if (savedToken) {
                    console.log('[Steam] Logging in using saved refresh token file...');
                    logOnOptions = { refreshToken: savedToken };
                }
            } catch (e) {
                console.warn('[Steam] Could not read saved refresh token:', e.message);
            }
        }

        // Priority 3: username & password
        if (!logOnOptions.refreshToken) {
            console.log(`[Steam] Logging in as ${config.steam.username}...`);
            logOnOptions = {
                accountName: config.steam.username,
                password: config.steam.password,
            };
        }

        try {
            cl.logOn(logOnOptions);
        } catch (err) {
            cleanup();
            reject(err);
        }
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

