const fs = require('fs');
const path = require('path');
const https = require('https');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_BASELINE = path.join(DATA_DIR, 'shopify_products_baseline.json');
const COLLECTIONS_BASELINE = path.join(DATA_DIR, 'shopify_collections_baseline.json');

const STORE_DOMAIN = config.shopify?.domain || 'another-axiom-x-juniper.myshopify.com';
const STOREFRONT_TOKEN = config.shopify?.storefrontToken || '5db8864a0aebe3ff62a60db93e8491e1';

/**
 * Perform HTTPS GET returning parsed JSON
 */
function fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const options = {
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                ...headers,
            }
        };

        https.get(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve({ status: res.statusCode, data: JSON.parse(data) });
                    } catch (e) {
                        resolve({ status: res.statusCode, raw: data });
                    }
                } else {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        }).on('error', reject);
    });
}

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*[\/]?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function formatPriceRange(variants) {
    if (!variants || variants.length === 0) return 'No Price';
    const prices = variants.map(v => parseFloat(v.price)).filter(p => !isNaN(p));
    if (prices.length === 0) return 'No Price';
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min === max) return `$${min.toFixed(2)} USD`;
    return `$${min.toFixed(2)} - $${max.toFixed(2)} USD`;
}

function areVariantsAvailable(variants) {
    if (!variants || variants.length === 0) return false;
    return variants.some(v => v.available === true);
}

/**
 * Fetch all products and collections from Shopify
 */
async function fetchShopifyStoreData() {
    const headers = {
        'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    };

    const [prodRes, colRes] = await Promise.all([
        fetchJson(`https://${STORE_DOMAIN}/products.json?limit=250`, headers),
        fetchJson(`https://${STORE_DOMAIN}/collections.json?limit=250`, headers),
    ]);

    const products = prodRes.data?.products || [];
    const collections = colRes.data?.collections || [];

    return { products, collections };
}

/**
 * Diff current products and collections against saved baselines
 */
function diffShopify(newProducts, newCollections) {
    const changes = [];

    // 1. Diff Products
    let oldProducts = null;
    if (fs.existsSync(PRODUCTS_BASELINE)) {
        try {
            oldProducts = JSON.parse(fs.readFileSync(PRODUCTS_BASELINE, 'utf8'));
        } catch { }
    }

    if (oldProducts && Array.isArray(oldProducts)) {
        const oldMap = new Map(oldProducts.map(p => [p.id, p]));
        const newMap = new Map(newProducts.map(p => [p.id, p]));

        // New products
        for (const [id, prod] of newMap.entries()) {
            if (!oldMap.has(id)) {
                changes.push({
                    type: 'shopify_product_new',
                    product: prod,
                });
            } else {
                const oldProd = oldMap.get(id);
                const oldPrice = formatPriceRange(oldProd.variants);
                const newPrice = formatPriceRange(prod.variants);
                const oldAvail = areVariantsAvailable(oldProd.variants);
                const newAvail = areVariantsAvailable(prod.variants);
                const titleChanged = oldProd.title !== prod.title;

                if (oldPrice !== newPrice || oldAvail !== newAvail || titleChanged) {
                    changes.push({
                        type: 'shopify_product_updated',
                        product: prod,
                        oldProduct: oldProd,
                    });
                }
            }
        }

        // Removed products
        for (const [id, oldProd] of oldMap.entries()) {
            if (!newMap.has(id)) {
                changes.push({
                    type: 'shopify_product_removed',
                    product: oldProd,
                });
            }
        }
    } else {
        console.log(`[Shopify] Saving initial products baseline (${newProducts.length} items).`);
    }

    // 2. Diff Collections
    let oldCollections = null;
    if (fs.existsSync(COLLECTIONS_BASELINE)) {
        try {
            oldCollections = JSON.parse(fs.readFileSync(COLLECTIONS_BASELINE, 'utf8'));
        } catch { }
    }

    if (oldCollections && Array.isArray(oldCollections)) {
        const oldColMap = new Map(oldCollections.map(c => [c.id, c]));
        const newColMap = new Map(newCollections.map(c => [c.id, c]));

        // New collections
        for (const [id, col] of newColMap.entries()) {
            if (!oldColMap.has(id)) {
                changes.push({
                    type: 'shopify_collection_new',
                    collection: col,
                });
            } else {
                const oldCol = oldColMap.get(id);
                if (oldCol.title !== col.title || (oldCol.products_count !== col.products_count && col.products_count !== undefined)) {
                    changes.push({
                        type: 'shopify_collection_updated',
                        collection: col,
                        oldCollection: oldCol,
                    });
                }
            }
        }

        // Removed collections
        for (const [id, oldCol] of oldColMap.entries()) {
            if (!newColMap.has(id)) {
                changes.push({
                    type: 'shopify_collection_removed',
                    collection: oldCol,
                });
            }
        }
    } else {
        console.log(`[Shopify] Saving initial collections baseline (${newCollections.length} collections).`);
    }

    // Save updated baselines immediately
    try {
        fs.writeFileSync(PRODUCTS_BASELINE, JSON.stringify(newProducts, null, 2));
        fs.writeFileSync(COLLECTIONS_BASELINE, JSON.stringify(newCollections, null, 2));
    } catch (e) {
        console.error('[Shopify] Failed to save baselines:', e.message);
    }

    return changes;
}

/**
 * Build Discord Embed for Product changes
 */
function buildProductEmbed(change) {
    const { type, product, oldProduct } = change;
    let title = 'Merch product updated';
    let color = 0xF1C40F; // Yellow

    if (type === 'shopify_product_new') {
        title = 'New merch product added';
        color = 0x2ECC71; // Green
    } else if (type === 'shopify_product_removed') {
        title = 'Merch product removed';
        color = 0xE74C3C; // Red
    }

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`**${product.title}**\n[View on Store](https://${STORE_DOMAIN}/products/${product.handle})`)
        .setColor(color);

    const priceStr = formatPriceRange(product.variants);
    const inStock = areVariantsAvailable(product.variants);

    embed.addFields(
        { name: 'Price', value: priceStr, inline: true },
        { name: 'Availability', value: inStock ? 'In Stock' : 'Sold Out', inline: true },
    );

    if (product.product_type) {
        embed.addFields({ name: 'Type', value: product.product_type, inline: true });
    }

    const desc = stripHtml(product.body_html);
    if (desc) {
        const truncatedDesc = desc.length > 350 ? desc.substring(0, 340) + '...' : desc;
        embed.addFields({ name: 'Description', value: truncatedDesc, inline: false });
    }

    if (product.variants && product.variants.length > 1) {
        const variantNames = product.variants.map(v => `${v.title} (${v.available ? `$${v.price}` : 'Sold Out'})`).join(', ');
        const truncVariants = variantNames.length > 300 ? variantNames.substring(0, 290) + '...' : variantNames;
        embed.addFields({ name: `Variants (${product.variants.length})`, value: truncVariants, inline: false });
    }

    if (product.images && product.images.length > 0 && product.images[0].src) {
        embed.setThumbnail(product.images[0].src);
    }

    if (oldProduct && type === 'shopify_product_updated') {
        const oldPrice = formatPriceRange(oldProduct.variants);
        const oldStock = areVariantsAvailable(oldProduct.variants);
        const changesList = [];
        if (oldPrice !== priceStr) changesList.push(`Price: ${oldPrice} -> ${priceStr}`);
        if (oldStock !== inStock) changesList.push(`Stock: ${oldStock ? 'In Stock' : 'Sold Out'} -> ${inStock ? 'In Stock' : 'Sold Out'}`);
        if (oldProduct.title !== product.title) changesList.push(`Title: "${oldProduct.title}" -> "${product.title}"`);
        if (changesList.length > 0) {
            embed.addFields({ name: 'Changes Detected', value: changesList.join('\n'), inline: false });
        }
    }

    return embed;
}

/**
 * Build Discord Embed for Collection changes
 */
function buildCollectionEmbed(change) {
    const { type, collection, oldCollection } = change;
    let title = 'Merch collection updated';
    let color = 0xF1C40F; // Yellow

    if (type === 'shopify_collection_new') {
        title = 'New merch collection added';
        color = 0x2ECC71; // Green
    } else if (type === 'shopify_collection_removed') {
        title = 'Merch collection removed';
        color = 0xE74C3C; // Red
    }

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`**${collection.title}**\n[View Collection](https://${STORE_DOMAIN}/collections/${collection.handle})`)
        .setColor(color);

    if (collection.products_count !== undefined) {
        embed.addFields({ name: 'Products Count', value: `${collection.products_count}`, inline: true });
    }

    const desc = stripHtml(collection.description);
    if (desc) {
        const truncatedDesc = desc.length > 350 ? desc.substring(0, 340) + '...' : desc;
        embed.addFields({ name: 'Description', value: truncatedDesc, inline: false });
    }

    if (collection.image && collection.image.src) {
        embed.setThumbnail(collection.image.src);
    }

    if (oldCollection && type === 'shopify_collection_updated') {
        const changesList = [];
        if (oldCollection.title !== collection.title) changesList.push(`Title: "${oldCollection.title}" -> "${collection.title}"`);
        if (oldCollection.products_count !== collection.products_count) changesList.push(`Count: ${oldCollection.products_count} -> ${collection.products_count}`);
        if (changesList.length > 0) {
            embed.addFields({ name: 'Changes Detected', value: changesList.join('\n'), inline: false });
        }
    }

    return embed;
}

/**
 * Execute a check against Shopify and send any changes to Discord channel
 */
async function checkShopify(client) {
    if (!client) return [];

    try {
        const { products, collections } = await fetchShopifyStoreData();
        if (products.length === 0 && collections.length === 0) return [];

        const changes = diffShopify(products, collections);
        if (changes.length === 0) return [];

        console.log(`[Shopify] ${changes.length} change(s) detected on store!`);

        const chanId = config.discord.shopifyChannelId || config.discord.newItemsChannelId || config.discord.catalogChannelId;
        if (!chanId) {
            console.warn('[Shopify] No channel ID available to send store updates.');
            return changes;
        }

        let channel = null;
        try {
            channel = await client.channels.fetch(chanId);
        } catch (e) {
            console.error('[Shopify] Failed to fetch channel:', e.message);
            return changes;
        }

        if (!channel) return changes;

        for (const change of changes) {
            let embed = null;
            if (change.type.startsWith('shopify_product')) {
                embed = buildProductEmbed(change);
            } else if (change.type.startsWith('shopify_collection')) {
                embed = buildCollectionEmbed(change);
            }

            if (embed) {
                try {
                    await channel.send({ embeds: [embed] });
                    await new Promise(r => setTimeout(r, 1200));
                } catch (err) {
                    console.error('[Shopify] Error sending change embed:', err.message);
                }
            }
        }

        return changes;
    } catch (err) {
        console.error('[Shopify] Check error:', err.message);
        return [];
    }
}

function getSavedProducts() {
    if (fs.existsSync(PRODUCTS_BASELINE)) {
        try {
            return JSON.parse(fs.readFileSync(PRODUCTS_BASELINE, 'utf8')) || [];
        } catch { }
    }
    return [];
}

function getSavedCollections() {
    if (fs.existsSync(COLLECTIONS_BASELINE)) {
        try {
            return JSON.parse(fs.readFileSync(COLLECTIONS_BASELINE, 'utf8')) || [];
        } catch { }
    }
    return [];
}

module.exports = {
    fetchShopifyStoreData,
    diffShopify,
    checkShopify,
    buildProductEmbed,
    buildCollectionEmbed,
    getSavedProducts,
    getSavedCollections,
    STORE_DOMAIN,
};