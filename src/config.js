require('dotenv').config();

// Determine poll interval in milliseconds (supports POLL_INTERVAL_SECONDS or POLL_INTERVAL_MINUTES)
let intervalSeconds = 60; // default 60s
if (process.env.POLL_INTERVAL_SECONDS) {
    const parsed = parseFloat(process.env.POLL_INTERVAL_SECONDS);
    if (!isNaN(parsed) && Number.isFinite(parsed) && parsed > 0) {
        intervalSeconds = Math.max(5, parsed);
    }
} else if (process.env.POLL_INTERVAL_MINUTES) {
    const parsed = parseFloat(process.env.POLL_INTERVAL_MINUTES);
    if (!isNaN(parsed) && Number.isFinite(parsed) && parsed > 0) {
        intervalSeconds = Math.max(0.1, parsed) * 60;
    }
}
if (isNaN(intervalSeconds) || !Number.isFinite(intervalSeconds) || intervalSeconds < 5) {
    intervalSeconds = 60;
}

module.exports = {
    discord: {
        token: process.env.DISCORD_TOKEN,
        catalogChannelId: process.env.CATALOG_CHANNEL_ID,
        newItemsChannelId: process.env.NEW_ITEMS_CHANNEL_ID,
        priceChangesChannelId: process.env.PRICE_CHANGES_CHANNEL_ID,
        titleDataChannelId: process.env.TITLE_DATA_CHANNEL_ID,
        listChannelId: process.env.LIST_CHANNEL_ID,
        statusChannelId: process.env.STATUS_CHANNEL_ID,
        hierarchyChannelId: process.env.HIERARCHY_CHANNEL_ID || process.env.HIARCHY_CHANNEL_ID,
        cosmeticsControllerChannelId: process.env.COSMETICS_CONTROLLER_CHANNEL_ID || process.env.COSMETIC_CONTROLLER_CHANNEL_ID,
        shopifyChannelId: process.env.SHOPIFY_CHANNEL_ID || process.env.STORE_CHANNEL_ID || process.env.MERCH_CHANNEL_ID,
        ccuChannelId: process.env.CCU_CHANNEL_ID,
        devCatalogChannelId: process.env.DEV_CATALOG_CHANNEL_ID || process.env.DEV_CHANNEL_ID,
    },
    steam: {
        username: process.env.STEAM_USERNAME,
        password: process.env.STEAM_PASSWORD,
        refreshToken: process.env.STEAM_REFRESH_TOKEN,
        appId: parseInt(process.env.STEAM_APPID || '1533390', 10),
    },
    playfab: {
        titleId: process.env.PLAYFAB_TITLE_ID || '63FDD',
        devTitleId: process.env.DEV_PLAYFAB_TITLE_ID || '195C0',
    },
    shopify: {
        domain: process.env.SHOPIFY_DOMAIN || 'another-axiom-x-juniper.myshopify.com',
        storefrontToken: process.env.SHOPIFY_STOREFRONT_TOKEN || '5db8864a0aebe3ff62a60db93e8491e1',
        pollIntervalSeconds: parseInt(process.env.SHOPIFY_POLL_INTERVAL_SECONDS || '60', 10),
    },
    pollIntervalSeconds: intervalSeconds,
    pollIntervalMs: Math.round(intervalSeconds * 1000),
};