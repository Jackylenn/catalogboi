const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getUpcomingCosmetics, getItemDisplayName, removeUpcomingCosmetics, resetBaselines, clearUpcomingCosmetics, diffCosmeticsController, updateCosmeticsControllerBaseline, getCosmeticsControllerBaselineText, diffTitleData, parseTitleDataInput, getFormattedPrice, getPrice, getPriceString, getCurrencyName } = require('./tracker');
const { getItemCategory } = require('./categories');
const { getSavedProducts, getSavedCollections, checkShopify, fetchShopifyStoreData, STORE_DOMAIN } = require('./shopify');
const { purchaseItem } = require('./playfab');
const { diffCCU, getSavedCCU, fetchLiveCCU } = require('./ccu');

let client = null;
let catalogChannel = null;
let newItemsChannel = null;
let priceChangesChannel = null;
let titleDataChannel = null;
let listChannel = null;
let statusChannel = null;
let cosmeticsControllerChannel = null;
let shopifyChannel = null;
let ccuChannel = null;
let devCatalogChannel = null;
let startTime = Date.now();
let lastCheckTime = null;
let lastCheckItemCount = 0;

// Store the message IDs so we can edit them in-place
const LIST_MSG_PATH = path.join(__dirname, '..', 'data', 'list_message_id.txt');
const STATUS_MSG_PATH = path.join(__dirname, '..', 'data', 'status_message_id.txt');

// ─── Bot Setup ───────────────────────────────────────────────────


function formatUpcomingCosmeticLine(item) {
    const price = getPrice(item);
    const category = getItemCategory(item.ItemId, price);
    const priceStr = getFormattedPrice(item);
    const displayName = getItemDisplayName(item.ItemId, item.DisplayName);
    const nameSuffix = displayName ? ` (${displayName})` : '';
    return `${item.ItemId} - ${category} - ${priceStr}${nameSuffix}`;
}

async function initBot() {
    const clientOptions = {
        sweepers: {
            messages: { interval: 60, lifetime: 30 },
        },
    };

    try {
        client = new Client({
            ...clientOptions,
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });
        await client.login(config.discord.token);
    } catch (err) {
        if (err.message && err.message.includes('disallowed intents')) {
            console.warn('[Discord] Message Content Intent is not enabled in Discord Developer Portal.');
            console.warn('[Discord] Falling back to Slash Commands only (/upcoming, /clearlist, /status, /reset, /buy)...');
            client = new Client({
                ...clientOptions,
                intents: [
                    GatewayIntentBits.Guilds,
                ],
            });
            await client.login(config.discord.token);
        } else {
            throw err;
        }
    }

    await new Promise((resolve) => {
        client.once('ready', async () => {
            console.log(`[Discord] Bot ready as ${client.user.tag}`);

            // Fetch configured channels
            async function fetchChan(id, name) {
                if (!id) {
                    console.log(`[Discord] ${name} channel: (not set in .env)`);
                    return null;
                }
                try {
                    const ch = await client.channels.fetch(id);
                    console.log(`[Discord] ${name} channel: #${ch?.name || id}`);
                    return ch;
                } catch (e) {
                    console.error(`[Discord] Could not find ${name} channel (${id}): ${e.message}`);
                    return null;
                }
            }

            catalogChannel = await fetchChan(config.discord.catalogChannelId, 'Catalog');
            newItemsChannel = (await fetchChan(config.discord.newItemsChannelId, 'New Items')) || catalogChannel;
            priceChangesChannel = (await fetchChan(config.discord.priceChangesChannelId, 'Price Changes')) || catalogChannel;
            titleDataChannel = (await fetchChan(config.discord.titleDataChannelId, 'Title Data')) || catalogChannel;
            listChannel = await fetchChan(config.discord.listChannelId, 'List');
            statusChannel = await fetchChan(config.discord.statusChannelId, 'Status / Heartbeat');
            cosmeticsControllerChannel = (await fetchChan(config.discord.cosmeticsControllerChannelId, 'CosmeticsController')) || catalogChannel;
            shopifyChannel = (await fetchChan(config.discord.shopifyChannelId, 'Shopify Merch')) || newItemsChannel || catalogChannel;
            ccuChannel = (await fetchChan(config.discord.ccuChannelId, 'CCU Tracker')) || catalogChannel;
            devCatalogChannel = (await fetchChan(config.discord.devCatalogChannelId, 'Dev Catalog')) || catalogChannel;

            await registerCommands();
            resolve();
        });
    });

    client.on('interactionCreate', handleInteraction);
    client.on('messageCreate', handlePrefixCommand);
    return client;
}

// ─── Slash Commands ──────────────────────────────────────────────

async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('upcoming')
            .setDescription('Post the accumulated upcoming cosmetics summary'),
        new SlashCommandBuilder()
            .setName('reset')
            .setDescription('Clear all baseline files and re-scan on next poll'),
        new SlashCommandBuilder()
            .setName('status')
            .setDescription('Show bot uptime, last check time, and item counts'),
        new SlashCommandBuilder()
            .setName('clearlist')
            .setDescription('Clear the entire upcoming cosmetics list'),
        new SlashCommandBuilder()
            .setName('checkdev')
            .setDescription('Force an immediate scan of the Dev PlayFab catalog (195C0)'),
        new SlashCommandBuilder()
            .setName('checkdevcatalog')
            .setDescription('Force an immediate scan of the Dev PlayFab catalog (195C0)'),
        new SlashCommandBuilder()
            .setName('checkcatalog')
            .setDescription('Force an immediate scan of the PlayFab catalog for new items and price changes'),
        new SlashCommandBuilder()
            .setName('ccu')
            .setDescription('View current Gorilla Tag concurrent online players (CCU)'),
        new SlashCommandBuilder()
            .setName('checkccu')
            .setDescription('Force an immediate check of Gorilla Tag CCU'),
        new SlashCommandBuilder()
            .setName('shopify')
            .setDescription('View current Gorilla Tag merch store products & collections'),
        new SlashCommandBuilder()
            .setName('checkshopify')
            .setDescription('Force an immediate scan of the Shopify merch store for updates'),
        new SlashCommandBuilder()
            .setName('updatemothershiptoken')
            .setDescription('Update the Mothership Title Data access token')
            .addStringOption(opt =>
                opt.setName('token')
                    .setDescription('The new Mothership token (JWT)')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('checktitledata')
            .setDescription('Upload a TitleDataCache.json dump to compare and update Title Data baseline')
            .addAttachmentOption(opt =>
                opt.setName('file')
                    .setDescription('The TitleDataCache.json or TitleData .json file')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('checkcosmeticscontroller')
            .setDescription('Upload a new CosmeticsController dump to diff and update item names/prices')
            .addAttachmentOption(opt =>
                opt.setName('file')
                    .setDescription('The new CosmeticsController .txt file')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('remove')
            .setDescription('Remove specific item ID(s) from the upcoming cosmetics list')
            .addStringOption(opt =>
                opt.setName('itemids')
                    .setDescription('Item ID or comma/space-separated IDs to remove (e.g. LSAEE or LSAEE, LBAUX)')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('buy')
            .setDescription('Purchase an item in Gorilla Tag using a PlayFab session ticket')
            .addStringOption(opt =>
                opt.setName('sessionticket')
                    .setDescription('Your PlayFab session ticket')
                    .setRequired(true)
            )
            .addStringOption(opt =>
                opt.setName('itemid')
                    .setDescription('Item ID to purchase (e.g. LBATF.)')
                    .setRequired(true)
            )
            .addIntegerOption(opt =>
                opt.setName('price')
                    .setDescription('Price in Shiny Rocks (0 for free items)')
                    .setRequired(true)
            )
            .addStringOption(opt =>
                opt.setName('currency')
                    .setDescription('Virtual Currency code (default: SR)')
                    .setRequired(false)
            ),
    ];

    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    const commandPayload = commands.map(c => c.toJSON());

    // 1. Wipe global commands so they don't duplicate
    try {
        await rest.put(Routes.applicationCommands(client.user.id), {
            body: [],
        });
    } catch { }

    // 2. Register per-guild for instant update
    try {
        const guilds = client.guilds.cache;
        for (const [guildId, guild] of guilds) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
                body: commandPayload,
            });
            console.log(`[Discord] Slash commands registered cleanly for guild: ${guild.name}`);
        }
    } catch (e) {
        console.warn('[Discord] Guild command registration:', e.message);
    }
}

async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'upcoming') {
        await handleUpcoming(interaction);
    } else if (interaction.commandName === 'reset') {
        await handleReset(interaction);
    } else if (interaction.commandName === 'status') {
        await handleStatus(interaction);
    } else if (interaction.commandName === 'clearlist') {
        await handleClearList(interaction);
    } else if (interaction.commandName === 'ccu') {
        await handleCCU(interaction);
    } else if (interaction.commandName === 'checkccu') {
        await handleCheckCCU(interaction);
    } else if (interaction.commandName === 'shopify') {
        await handleShopify(interaction);
    } else if (interaction.commandName === 'checkdev' || interaction.commandName === 'checkdevcatalog') {
        await handleCheckDevCatalog(interaction);
    } else if (interaction.commandName === 'checkcatalog') {
        await handleCheckCatalog(interaction);
    } else if (interaction.commandName === 'checkshopify') {
        await handleCheckShopify(interaction);
    } else if (interaction.commandName === 'updatemothershiptoken') {
        await handleUpdateMothershipToken(interaction);
    } else if (interaction.commandName === 'checktitledata') {
        await handleCheckTitleData(interaction);
    } else if (interaction.commandName === 'checkcosmeticscontroller') {
        await handleCheckCosmeticsController(interaction);
    } else if (interaction.commandName === 'remove') {
        await handleRemove(interaction);
    } else if (interaction.commandName === 'buy') {
        await handleBuy(interaction);
    }
}

// ─── Prefix Command (?clearlist, ?upcoming, ?status, ?reset, ?buy) 

async function handlePrefixCommand(message) {
    if (message.author.bot) return;
    if (!message.content.startsWith('?')) return;

    const fullContent = message.content.slice(1).trim();
    const parts = fullContent.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'updatemothershiptoken') {
        const token = parts.slice(1).join(' ').trim();
        if (!token) {
            return message.reply('❌ Please provide the new Mothership token:\n`?updatemothershiptoken <token>`');
        }
        const replyMsg = await message.reply('🔄 Validating Mothership token with Gateway...');
        try {
            const { validateMothershipToken, setMothershipToken, fetchMothershipTitleData } = require('./mothership');
            const { diffTitleData } = require('./tracker');

            const val = await validateMothershipToken(token);
            if (!val.success) {
                return replyMsg.edit({
                    content: '',
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('❌ Mothership Token Invalid')
                            .setDescription(`The token was rejected by Mothership:
\`\`\`${val.error}\`\`\``)
                            .setColor(0xE74C3C)
                    ]
                });
            }

            setMothershipToken(token);
            const titleData = await fetchMothershipTitleData();
            const changes = diffTitleData(titleData);
            if (changes.length > 0) {
                await sendChanges(changes);
            }

            return replyMsg.edit({
                content: '',
                embeds: [
                    new EmbedBuilder()
                        .setTitle('✅ Mothership Token Updated!')
                        .setDescription(`Successfully authenticated with Mothership!

• **Keys Loaded**: ${val.count} keys
• **Changes Detected**: ${changes.length}
• **Status**: Active & saved to storage`)
                        .setColor(0x2ECC71)
                ]
            });
        } catch (e) {
            return replyMsg.edit(`❌ Error updating token: ${e.message}`);
        }
    } else if (cmd === 'clearlist') {
        clearUpcomingCosmetics();
        await message.reply('Upcoming cosmetics list cleared!');
        await updateListMessage();
        await updateStatusMessage();
        console.log('[Discord] ?clearlist executed by', message.author.tag);
    } else if (cmd === 'ccu') {
        try {
            const data = await fetchLiveCCU();
            const currentCCU = (data && data.ccuTotal !== null && data.ccuTotal !== undefined) ? parseInt(data.ccuTotal, 10) : 0;
            const color = currentCCU > 0 ? 0x2ECC71 : 0xE74C3C;
            const embed = new EmbedBuilder()
                .setTitle('Players online: ' + currentCCU)
                .setColor(color);
            await message.reply({ embeds: [embed] });
        } catch (e) {
            await message.reply('❌ Error fetching CCU: ' + e.message);
        }
    } else if (cmd === 'checkccu') {
        const replyMsg = await message.reply('🔄 Checking Gorilla Tag CCU...');
        try {
            const change = await diffCCU();
            if (change) {
                await sendCCUChange(change);
                await replyMsg.edit(`✅ CCU Changed! **${change.oldCCU}** → **${change.newCCU}** (${change.diffStr})`);
            } else {
                const saved = getSavedCCU();
                const count = saved?.ccuTotal !== undefined ? saved.ccuTotal : 'Unknown';
                await replyMsg.edit(`✅ CCU checked: **${count}** player(s) online. No change detected.`);
            }
        } catch (e) {
            await replyMsg.edit(`❌ Error checking CCU: ${e.message}`);
        }
    } else if (cmd === 'shopify') {
        const products = getSavedProducts();
        const collections = getSavedCollections();

        const embed = new EmbedBuilder()
            .setTitle('Gorilla Tag Merch Store')
            .setURL(`https://${STORE_DOMAIN}`)
            .setColor(0x2ECC71)
            .setDescription(`Tracking **${products.length}** products across **${collections.length}** collections on \`${STORE_DOMAIN}\`.`)
            .addFields(
                { name: 'Store Link', value: `[Visit Store](https://${STORE_DOMAIN})`, inline: true },
                { name: 'Products Tracked', value: `${products.length}`, inline: true },
                { name: 'Collections Tracked', value: `${collections.length}`, inline: true },
            );

        if (products.length > 0) {
            const sample = products.slice(0, 5).map(p => `• **[${p.title}](https://${STORE_DOMAIN}/products/${p.handle})**`).join('\n');
            embed.addFields({ name: 'Recent Products', value: sample, inline: false });
        }

        await message.reply({ embeds: [embed] });
    } else if (cmd === 'checkdev' || cmd === 'checkdevcatalog') {
        const replyMsg = await message.reply('🔄 Scanning Dev PlayFab catalog & title data (195C0)...');
        try {
            const { getDevCatalogItems, getDevTitleData } = require('./dev_playfab');
            const { diffDevCatalog, diffDevTitleData } = require('./tracker');
            const catalog = await getDevCatalogItems();
            const changes = diffDevCatalog(catalog);

            let titleChanges = [];
            try {
                const td = await getDevTitleData();
                titleChanges = diffDevTitleData(td);
            } catch { }

            const totalChanges = [...changes, ...titleChanges];
            if (totalChanges.length > 0) {
                await sendDevChanges(totalChanges);
            }
            await replyMsg.edit(`✅ Scanned Dev catalog (**${catalog.length}** items). Found **${totalChanges.length}** change(s).`);
        } catch (e) {
            await replyMsg.edit(`❌ Error checking Dev catalog: ${e.message}`);
        }
    } else if (cmd === 'checkcatalog') {
        const replyMsg = await message.reply('🔄 Scanning PlayFab catalog for new items...');
        try {
            const { getCatalogItems } = require('./playfab');
            const { diffCatalog } = require('./tracker');
            const catalog = await getCatalogItems();
            const changes = diffCatalog(catalog);
            if (changes.length > 0) {
                await sendChanges(changes);
            }
            await replyMsg.edit(`✅ Scanned PlayFab catalog (**${catalog.length}** items). Found **${changes.length}** change(s).`);
        } catch (e) {
            await replyMsg.edit(`❌ Error checking catalog: ${e.message}`);
        }
    } else if (cmd === 'checkshopify') {
        const replyMsg = await message.reply('Scanning Shopify merch store for updates...');
        try {
            const changes = await checkShopify(client);
            const targetChan = shopifyChannel || newItemsChannel || catalogChannel || message.channel;

            const embed = new EmbedBuilder()
                .setTitle('Shopify Check Complete')
                .setColor(0x2B2D31)
                .setDescription(`Scan complete. Found **${changes.length}** change(s).\nDestination: <#${targetChan.id}>`);

            await replyMsg.edit({ content: '', embeds: [embed] });
        } catch (e) {
            await replyMsg.edit(`❌ Error checking Shopify: ${e.message}`);
        }
    } else if (cmd === 'checktitledata') {
        const attachment = message.attachments.first();
        if (!attachment) {
            await message.reply('⚠️ Please attach a `TitleDataCache.json` or `.json` file with `?checktitledata`.');
            return;
        }

        try {
            const resp = await fetch(attachment.url);
            const text = await resp.text();
            const parsed = JSON.parse(text);

            const changes = diffTitleData(parsed);
            const targetChan = titleDataChannel || catalogChannel || message.channel;

            if (changes.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle('Title Data: No Changes Detected')
                    .setColor(0x2B2D31)
                    .setDescription('*The uploaded Title Data is identical to the current baseline.*');
                await message.reply({ embeds: [embed] });
                return;
            }

            await sendChanges(changes);

            const replyEmbed = new EmbedBuilder()
                .setTitle('Title Data Check Complete')
                .setColor(0x2B2D31)
                .setDescription(`Detected and sent **${changes.length}** title data change(s) to <#${targetChan.id}>.\nBaseline saved.`);

            await message.reply({ embeds: [replyEmbed] });
        } catch (err) {
            await message.reply(`❌ Error checking Title Data: ${err.message}`);
        }
    } else if (cmd === 'checkcosmeticscontroller') {
        const attachment = message.attachments.first();
        if (!attachment) {
            await message.reply('⚠️ Please attach a CosmeticsController `.txt` file with `?checkcosmeticscontroller`.');
            return;
        }

        try {
            const resp = await fetch(attachment.url);
            const newText = await resp.text();
            const oldText = getCosmeticsControllerBaselineText();

            const diff = diffCosmeticsController(oldText, newText);
            const targetChan = cosmeticsControllerChannel || message.channel;

            await sendCosmeticsControllerDiffEmbeds(targetChan, diff);
            updateCosmeticsControllerBaseline(newText);
            await updateListMessage();
            await updateStatusMessage();

            const replyEmbed = new EmbedBuilder()
                .setTitle('CosmeticsController Check Complete')
                .setColor(0x2B2D31)
                .setDescription(`Processed **+${diff.added.length}** added, **~${diff.modified.length}** modified, **-${diff.removed.length}** removed.\nBaseline saved & upcoming cosmetics list updated.`);

            await message.reply({ embeds: [replyEmbed] });
        } catch (err) {
            await message.reply(`❌ Error checking CosmeticsController: ${err.message}`);
        }
    } else if (cmd === 'remove') {
        const targetIds = parts.slice(1);
        if (targetIds.length === 0) {
            await message.reply('⚠️ Usage: `?remove <itemid> [itemid2 ...]` (e.g. `?remove LSAEE`)');
            return;
        }

        const { removed, remainingCount } = removeUpcomingCosmetics(targetIds);
        if (removed.length === 0) {
            await message.reply(`⚠️ No matching items found in the upcoming list for: \`${targetIds.join(', ')}\``);
            return;
        }

        const removedList = removed.map(i => `\`${i.ItemId}\` (${i.DisplayName || 'No Name'})`).join('\n');
        const embed = new EmbedBuilder()
            .setTitle('Removed from Upcoming List 🗑️')
            .setColor(0xE67E22)
            .addFields(
                { name: 'Removed Items', value: removedList, inline: false },
                { name: 'Upcoming Items Remaining', value: `${remainingCount}`, inline: true },
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
        await updateListMessage();
        await updateStatusMessage();
    } else if (cmd === 'upcoming') {
        const items = getUpcomingCosmetics();
        if (items.length === 0) {
            await message.reply('No upcoming cosmetics tracked yet.');
            return;
        }

        const lines = items.map(formatUpcomingCosmeticLine);

        const batchSize = 20;
        for (let i = 0; i < lines.length; i += batchSize) {
            const batch = lines.slice(i, i + batchSize);
            const embed = new EmbedBuilder()
                .setDescription(batch.join('\n'))
                .setColor(0x2ECC71);

            await message.channel.send({ embeds: [embed] });
            if (i + batchSize < lines.length) await sleep(1200);
        }
    } else if (cmd === 'reset') {
        resetBaselines();
        await message.reply('All baselines and upcoming cosmetics cleared. Baseline will re-scan on next poll.');
        await updateListMessage();
        await updateStatusMessage();
    } else if (cmd === 'status') {
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;
        const upcoming = getUpcomingCosmetics();

        const embed = new EmbedBuilder()
            .setTitle('Catalog Tracker Status')
            .setColor(0x3498DB)
            .addFields(
                { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
                { name: 'Poll interval', value: `${config.pollIntervalSeconds}s`, inline: true },
                { name: 'Last check', value: lastCheckTime ? `<t:${Math.floor(lastCheckTime / 1000)}:R>` : 'Never', inline: true },
                { name: 'Catalog items (last)', value: `${lastCheckItemCount}`, inline: true },
                { name: 'Upcoming cosmetics', value: `${upcoming.length}`, inline: true },
            );

        await message.channel.send({ embeds: [embed] });
    } else if (cmd === 'buy') {
        try { await message.delete(); } catch {}

        if (parts.length < 4) {
            await message.channel.send('⚠️ Usage: `?buy <sessionticket> <itemid> <price> [currency]`\n*Tip: Use `/buy` slash command for private ephemeral responses.*');
            return;
        }

        const ticket = parts[1];
        const itemId = parts[2];
        const price = parseInt(parts[3]) || 0;
        const currency = parts[4] || 'SR';

        const replyMsg = await message.channel.send(`Processing purchase for item \`${itemId}\`...`);
        try {
            const result = await purchaseItem(ticket, itemId, price, currency);
            if (result.code === 200) {
                const embed = new EmbedBuilder()
                    .setTitle('Item Purchased Successfully! 🎉')
                    .setColor(0x2ECC71)
                    .addFields(
                        { name: 'Item ID', value: `\`${itemId}\``, inline: true },
                        { name: 'Price Paid', value: `${price} ${getCurrencyName(currency)}`, inline: true },
                    )
                    .setTimestamp();
                await replyMsg.edit({ content: '', embeds: [embed] });
            } else {
                const embed = new EmbedBuilder()
                    .setTitle('Purchase Failed ❌')
                    .setColor(0xE74C3C)
                    .setDescription(`**Error (${result.code || 'Unknown'}):** ${result.errorMessage || result.status || 'Failed to purchase item.'}`)
                    .setTimestamp();
                await replyMsg.edit({ content: '', embeds: [embed] });
            }
        } catch (e) {
            await replyMsg.edit(`❌ Error during purchase: ${e.message}`);
        }
    }
}

// ─── Slash Command Handlers ──────────────────────────────────────




async function handleCCU(interaction) {
    await interaction.deferReply();
    try {
        const data = await fetchLiveCCU();
        const currentCCU = (data && data.ccuTotal !== null && data.ccuTotal !== undefined) ? parseInt(data.ccuTotal, 10) : 0;
        const color = currentCCU > 0 ? 0x2ECC71 : 0xE74C3C;
        const embed = new EmbedBuilder()
            .setTitle('Players online: ' + currentCCU)
            .setColor(color);
        await interaction.editReply({ embeds: [embed] });
    } catch (e) {
        await interaction.editReply('❌ Error fetching CCU: ' + e.message);
    }
}

async function handleCheckCCU(interaction) {
    await interaction.deferReply();
    try {
        const change = await diffCCU();
        if (change) {
            await sendCCUChange(change);
            await interaction.editReply(`✅ CCU Changed! **${change.oldCCU}** → **${change.newCCU}** (${change.diffStr})`);
        } else {
            const saved = getSavedCCU();
            const count = saved?.ccuTotal !== undefined ? saved.ccuTotal : 'Unknown';
            await interaction.editReply(`✅ CCU checked: **${count}** player(s) online. No change detected.`);
        }
    } catch (e) {
        await interaction.editReply(`❌ Error checking CCU: ${e.message}`);
    }
}

async function handleShopify(interaction) {
    const products = getSavedProducts();
    const collections = getSavedCollections();

    const embed = new EmbedBuilder()
        .setTitle('Gorilla Tag Merch Store')
        .setURL(`https://${STORE_DOMAIN}`)
        .setColor(0x2ECC71)
        .setDescription(`Tracking **${products.length}** products across **${collections.length}** collections on \`${STORE_DOMAIN}\`.`)
        .addFields(
            { name: 'Store Link', value: `[Visit Store](https://${STORE_DOMAIN})`, inline: true },
            { name: 'Products Tracked', value: `${products.length}`, inline: true },
            { name: 'Collections Tracked', value: `${collections.length}`, inline: true },
        );

    if (products.length > 0) {
        const sample = products.slice(0, 5).map(p => `• **[${p.title}](https://${STORE_DOMAIN}/products/${p.handle})**`).join('\n');
        embed.addFields({ name: 'Recent Products', value: sample, inline: false });
    }

    await interaction.reply({ embeds: [embed] });
}

async function handleCheckDevCatalog(interaction) {
    await interaction.deferReply();
    try {
        const { getDevCatalogItems, getDevTitleData } = require('./dev_playfab');
        const { diffDevCatalog, diffDevTitleData } = require('./tracker');
        const catalog = await getDevCatalogItems();
        const changes = diffDevCatalog(catalog);

        let titleChanges = [];
        try {
            const td = await getDevTitleData();
            titleChanges = diffDevTitleData(td);
        } catch { }

        const totalChanges = [...changes, ...titleChanges];
        if (totalChanges.length > 0) {
            await sendDevChanges(totalChanges);
        }
        await interaction.editReply(`✅ Scanned Dev catalog (**${catalog.length}** items). Found **${totalChanges.length}** change(s).`);
    } catch (e) {
        await interaction.editReply(`❌ Error checking Dev catalog: ${e.message}`);
    }
}

async function sendDevChanges(changes) {
    if (!changes || changes.length === 0) return;
    const targetChannel = devCatalogChannel || catalogChannel;

    for (const change of changes) {
        let embed;
        let files = [];

        switch (change.type) {
            case 'dev_new_item': {
                const item = change.item;
                embed = new EmbedBuilder()
                    .setTitle('New item added to dev catalog')
                    .setDescription(`**${item.DisplayName || item.ItemId}**\nID: \`${item.ItemId}\``)
                    .setColor(0x2ECC71);
                if (item.Description) embed.addFields({ name: 'Description', value: item.Description, inline: false });
                embed.addFields({ name: 'Price', value: getPriceString(item), inline: false });
                break;
            }
            case 'dev_removed_item':
                embed = new EmbedBuilder()
                    .setTitle('Item removed from dev catalog')
                    .setDescription(`**${change.displayName}**\nID: \`${change.item.ItemId}\``)
                    .setColor(0xE74C3C);
                break;
            case 'dev_name_change':
                embed = new EmbedBuilder()
                    .setTitle('Dev display name changed')
                    .setDescription(`ID: \`${change.item.ItemId}\``)
                    .setColor(0xF1C40F)
                    .addFields(
                        { name: 'Old name', value: change.oldName || 'None', inline: true },
                        { name: 'New name', value: change.newName || 'None', inline: true },
                    );
                break;
            case 'dev_price_change': {
                embed = buildPriceChangeEmbed(change);
                embed.setTitle('Dev price changed');
                break;
            }
            case 'dev_bundle_change': {
                embed = buildBundleChangeEmbed(change);
                embed.setTitle('Dev bundle changed');
                break;
            }
            case 'dev_title_data_new': {
                const res = buildTitleDataEmbed('New dev title data key', change.key, null, change.newValue);
                embed = res.embed;
                files = res.files;
                break;
            }
            case 'dev_title_data_removed': {
                const res = buildTitleDataEmbed('Dev title data key removed', change.key, change.oldValue, null);
                embed = res.embed;
                files = res.files;
                break;
            }
            case 'dev_title_data_changed': {
                const res = buildTitleDataEmbed('Dev title data value changed', change.key, change.oldValue, change.newValue);
                embed = res.embed;
                files = res.files;
                break;
            }
            default:
                continue;
        }

        if (embed) {
            await sendToSpecificChannel(targetChannel, embed, files);
            await sleep(1200);
        }
    }
}

async function handleCheckCatalog(interaction) {
    await interaction.deferReply();
    try {
        const { getCatalogItems } = require('./playfab');
        const { diffCatalog } = require('./tracker');
        const catalog = await getCatalogItems();
        const changes = diffCatalog(catalog);
        if (changes.length > 0) {
            await sendChanges(changes);
        }
        await interaction.editReply(`✅ Scanned PlayFab catalog (**${catalog.length}** items). Found **${changes.length}** change(s).`);
    } catch (e) {
        await interaction.editReply(`❌ Error checking catalog: ${e.message}`);
    }
}

async function handleCheckShopify(interaction) {
    await interaction.deferReply();
    try {
        const changes = await checkShopify(client);
        const targetChan = shopifyChannel || newItemsChannel || catalogChannel || interaction.channel;

        const embed = new EmbedBuilder()
            .setTitle('Shopify Check Complete')
            .setColor(0x2B2D31)
            .setDescription(`Scan complete. Found **${changes.length}** change(s).\nDestination: <#${targetChan.id}>`);

        await interaction.editReply({ embeds: [embed] });
    } catch (e) {
        await interaction.editReply({ content: `❌ Error checking Shopify store: ${e.message}` });
    }
}

async function handleCheckTitleData(interaction) {
    const attachment = interaction.options.getAttachment('file');
    if (!attachment) {
        await interaction.reply({ content: '⚠️ Please attach a valid JSON file.', ephemeral: true });
        return;
    }

    await interaction.deferReply();

    try {
        const resp = await fetch(attachment.url);
        const text = await resp.text();
        const parsed = JSON.parse(text);

        const changes = diffTitleData(parsed);
        const targetChan = titleDataChannel || catalogChannel || interaction.channel;

        if (changes.length === 0) {
            const embed = new EmbedBuilder()
                .setTitle('Title Data: No Changes Detected')
                .setColor(0x2B2D31)
                .setDescription('*The uploaded Title Data is identical to the current baseline.*');
            await interaction.editReply({ embeds: [embed] });
            return;
        }

        await sendChanges(changes);

        const replyEmbed = new EmbedBuilder()
            .setTitle('Title Data Check Complete')
            .setColor(0x2B2D31)
            .setDescription(`Detected and sent **${changes.length}** title data change(s) to <#${targetChan.id}>.\n\nBaseline saved.`);

        await interaction.editReply({ embeds: [replyEmbed] });
    } catch (err) {
        await interaction.editReply({ content: `❌ Error processing Title Data file: ${err.message}` });
    }
}

async function handleCheckCosmeticsController(interaction) {
    const attachment = interaction.options.getAttachment('file');
    if (!attachment) {
        await interaction.reply({ content: '⚠️ Please attach a valid file.', ephemeral: true });
        return;
    }

    await interaction.deferReply();

    try {
        const resp = await fetch(attachment.url);
        const newText = await resp.text();
        const oldText = getCosmeticsControllerBaselineText();

        const diff = diffCosmeticsController(oldText, newText);
        const targetChan = cosmeticsControllerChannel || interaction.channel;

        await sendCosmeticsControllerDiffEmbeds(targetChan, diff);
        updateCosmeticsControllerBaseline(newText);
        await updateListMessage();
        await updateStatusMessage();

        const replyEmbed = new EmbedBuilder()
            .setTitle('CosmeticsController Check Complete')
            .setColor(0x2B2D31)
            .setDescription(`Processed **+${diff.added.length}** added, **~${diff.modified.length}** modified, **-${diff.removed.length}** removed.\n\nBaseline saved to data/item_names.txt & upcoming cosmetics list updated.`);

        await interaction.editReply({ embeds: [replyEmbed] });
    } catch (err) {
        await interaction.editReply({ content: `❌ Error processing CosmeticsController file: ${err.message}` });
    }
}

async function sendCosmeticsControllerDiffEmbeds(channel, diff) {
    const { added, modified, removed } = diff;

    if (added.length === 0 && modified.length === 0 && removed.length === 0) {
        const embed = new EmbedBuilder()
            .setTitle('CosmeticsController: No Changes Detected')
            .setColor(0x2B2D31)
            .setDescription('*The uploaded file is identical to the current baseline.*');
        await channel.send({ embeds: [embed] });
        return;
    }

    const lines = [];
    for (const a of added) {
        lines.push(`+ ${a.id} // ${a.name} // ${a.price}`);
    }
    for (const m of modified) {
        const nameChange = m.oldName !== m.newName ? ` (Name: "${m.oldName}" -> "${m.newName}")` : '';
        const priceChange = m.oldPrice !== m.newPrice ? ` (Price: "${m.oldPrice}" -> "${m.newPrice}")` : '';
        lines.push(`~ ${m.id} // ${m.newName} // ${m.newPrice}${nameChange}${priceChange}`);
    }
    for (const r of removed) {
        lines.push(`- ${r.id} // ${r.name} // ${r.price}`);
    }

    const maxChars = 3800;
    const blocks = [];
    let cur = [];
    let curLen = 0;

    for (const line of lines) {
        if (curLen + line.length + 1 > maxChars && cur.length > 0) {
            blocks.push(cur);
            cur = [];
            curLen = 0;
        }
        cur.push(line);
        curLen += line.length + 1;
    }
    if (cur.length > 0) blocks.push(cur);

    for (let i = 0; i < blocks.length; i++) {
        const title = blocks.length === 1
            ? `CosmeticsController Changes (+${added.length}, ~${modified.length}, -${removed.length})`
            : `CosmeticsController Changes (${i + 1}/${blocks.length})`;

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(0x2B2D31)
            .setDescription('\`\`\`diff\n' + blocks[i].join('\n') + '\n\`\`\`');

        await channel.send({ embeds: [embed] });
        if (i + 1 < blocks.length) await sleep(1000);
    }
}

async function handleRemove(interaction) {
    const rawInput = interaction.options.getString('itemids');
    const targetIds = rawInput.split(/[\s,]+/).filter(Boolean);

    if (targetIds.length === 0) {
        await interaction.reply({ content: '⚠️ Please specify at least one Item ID to remove.', ephemeral: true });
        return;
    }

    const { removed, remainingCount } = removeUpcomingCosmetics(targetIds);

    if (removed.length === 0) {
        await interaction.reply({
            content: `⚠️ No matching items found in the upcoming list for: \`${targetIds.join(', ')}\``,
            ephemeral: true,
        });
        return;
    }

    const removedList = removed.map(i => `\`${i.ItemId}\` (${i.DisplayName || 'No Name'})`).join('\n');
    const embed = new EmbedBuilder()
        .setTitle('Removed from Upcoming List 🗑️')
        .setColor(0xE67E22)
        .addFields(
            { name: 'Removed Items', value: removedList, inline: false },
            { name: 'Upcoming Items Remaining', value: `${remainingCount}`, inline: true },
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    await updateListMessage();
    await updateStatusMessage();
}

async function handleCheckDevCatalog(interaction) {
    await interaction.deferReply();
    try {
        const { getDevCatalogItems, getDevTitleData } = require('./dev_playfab');
        const { diffDevCatalog, diffDevTitleData } = require('./tracker');
        const catalog = await getDevCatalogItems();
        const changes = diffDevCatalog(catalog);

        let titleChanges = [];
        try {
            const { fetchMothershipTitleData } = require('./mothership');
            let td = null;
            try {
                td = await fetchMothershipTitleData(true);
            } catch {
                td = await getDevTitleData();
            }
            if (td) titleChanges = diffDevTitleData(td);
        } catch { }

        const totalChanges = [...changes, ...titleChanges];
        if (totalChanges.length > 0) {
            await sendDevChanges(totalChanges);
        }
        await interaction.editReply(`✅ Scanned Dev catalog (**${catalog.length}** items). Found **${totalChanges.length}** change(s).`);
    } catch (e) {
        await interaction.editReply(`❌ Error checking Dev catalog: ${e.message}`);
    }
}

async function handleCheckCatalog(interaction) {
    await interaction.deferReply();
    try {
        const { getCatalogItems } = require('./playfab');
        const { diffCatalog } = require('./tracker');
        const catalog = await getCatalogItems();
        const changes = diffCatalog(catalog);
        if (changes.length > 0) {
            await sendChanges(changes);
        }
        await interaction.editReply(`✅ Scanned Production catalog (**${catalog.length}** items). Found **${changes.length}** change(s).`);
    } catch (e) {
        await interaction.editReply(`❌ Error checking Production catalog: ${e.message}`);
    }
}

async function handleCheckShopify(interaction) {
    await interaction.deferReply();
    try {
        const { checkShopify } = require('./shopify');
        const changes = await checkShopify(client);
        await interaction.editReply(`✅ Scanned Shopify store. Found **${changes ? changes.length : 0}** change(s).`);
    } catch (e) {
        await interaction.editReply(`❌ Error checking Shopify: ${e.message}`);
    }
}

async function handleBuy(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const ticket = interaction.options.getString('sessionticket');
    const itemId = interaction.options.getString('itemid');
    const price = interaction.options.getInteger('price');
    const currency = interaction.options.getString('currency') || 'SR';

    try {
        const result = await purchaseItem(ticket, itemId, price, currency);

        if (result.code === 200) {
            const purchasedItems = result.data?.Items || [];
            const itemNames = purchasedItems.map(i => `\`${i.ItemId}\` (Instance: \`${i.ItemInstanceId || 'N/A'}\`)`).join('\n') || `\`${itemId}\``;

            const embed = new EmbedBuilder()
                .setTitle('Item Purchased Successfully! 🎉')
                .setColor(0x2ECC71)
                .addFields(
                    { name: 'Item ID', value: `\`${itemId}\``, inline: true },
                    { name: 'Price Paid', value: `${price} ${getCurrencyName(currency)}`, inline: true },
                    { name: 'Purchased Items', value: itemNames, inline: false },
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } else {
            const embed = new EmbedBuilder()
                .setTitle('Purchase Failed ❌')
                .setColor(0xE74C3C)
                .setDescription(`**Error (${result.code || 'Unknown'}):** ${result.errorMessage || result.status || 'Failed to purchase item.'}`)
                .addFields(
                    { name: 'Item ID', value: `\`${itemId}\``, inline: true },
                    { name: 'Attempted Price', value: `${price} ${currency}`, inline: true },
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
    } catch (err) {
        await interaction.editReply({
            content: `❌ Error during purchase: ${err.message}`,
        });
    }
}

async function handleUpcoming(interaction) {
    const items = getUpcomingCosmetics();
    if (items.length === 0) {
        await interaction.reply({ content: 'No upcoming cosmetics tracked yet.', ephemeral: true });
        return;
    }

    await interaction.deferReply();

    const lines = items.map(formatUpcomingCosmeticLine);

    const batchSize = 20;
    for (let i = 0; i < lines.length; i += batchSize) {
        const batch = lines.slice(i, i + batchSize);
        const embed = new EmbedBuilder()
            .setDescription(batch.join('\n'))
            .setColor(0x2ECC71);

        if (i === 0) {
            await interaction.editReply({ embeds: [embed] });
        } else {
            await sendToSpecificChannel(interaction.channel, embed);
        }
        if (i + batchSize < lines.length) {
            await sleep(1200);
        }
    }
}

async function handleReset(interaction) {
    resetBaselines();
    await interaction.reply({ content: 'All baselines and upcoming cosmetics cleared. Changes will be detected on next poll.', ephemeral: true });
    await updateListMessage();
    await updateStatusMessage();
}

async function handleClearList(interaction) {
    clearUpcomingCosmetics();
    await interaction.reply({ content: 'Upcoming cosmetics list cleared!', ephemeral: true });
    await updateListMessage();
    await updateStatusMessage();
    console.log('[Discord] /clearlist executed by', interaction.user.tag);
}

async function handleStatus(interaction) {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const upcoming = getUpcomingCosmetics();

    const embed = new EmbedBuilder()
        .setTitle('Catalog Tracker Status')
        .setColor(0x3498DB)
        .addFields(
            { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
            { name: 'Poll interval', value: `${config.pollIntervalSeconds}s`, inline: true },
            { name: 'Last check', value: lastCheckTime ? `<t:${Math.floor(lastCheckTime / 1000)}:R>` : 'Never', inline: true },
            { name: 'Catalog items (last)', value: `${lastCheckItemCount}`, inline: true },
            { name: 'Upcoming cosmetics', value: `${upcoming.length}`, inline: true },
        );

    await interaction.reply({ embeds: [embed] });
}

// ─── Auto-Updating Simple 1-Line "Last seen" Message ─────────────

async function updateStatusMessage() {
    if (!statusChannel) return;

    const now = Math.floor(Date.now() / 1000);
    const text = `Last seen <t:${now}:R>`;

    // 1. Try saved ID from disk
    const savedId = loadStatusMessageId();
    if (savedId) {
        try {
            const msg = await statusChannel.messages.fetch(savedId);
            if (msg) {
                await msg.edit({ content: text, embeds: [] });
                return;
            }
        } catch { }
    }

    // 2. Scan channel for existing bot messages to avoid duplicate creation on restarts
    try {
        const fetched = await statusChannel.messages.fetch({ limit: 10 });
        const botMessages = fetched.filter(m => m.author.id === client.user.id);
        
        if (botMessages.size > 0) {
            const firstMsg = botMessages.first();
            await firstMsg.edit({ content: text, embeds: [] });
            saveStatusMessageId(firstMsg.id);

            // Delete any extra duplicate bot messages in status channel
            const extraMessages = botMessages.filter(m => m.id !== firstMsg.id);
            for (const [, extra] of extraMessages) {
                try { await extra.delete(); } catch { }
            }
            return;
        }
    } catch { }

    // 3. If none found, create a new one
    try {
        const msg = await statusChannel.send({ content: text });
        saveStatusMessageId(msg.id);
        console.log('[Discord] Simple Last seen message created.');
    } catch (e) {
        console.error('[Discord] Failed to send status message:', e.message);
    }
}

function loadStatusMessageId() {
    try {
        if (fs.existsSync(STATUS_MSG_PATH)) {
            return fs.readFileSync(STATUS_MSG_PATH, 'utf8').trim();
        }
    } catch { }
    return null;
}

function saveStatusMessageId(id) {
    try {
        fs.writeFileSync(STATUS_MSG_PATH, id);
    } catch (e) {
        console.error('[Discord] Failed to save status message ID:', e.message);
    }
}

// ─── Auto-Updating List Message ──────────────────────────────────

async function updateListMessage() {
    if (!listChannel) {
        return;
    }

    const items = getUpcomingCosmetics();

    let description;
    if (items.length === 0) {
        description = '*No upcoming cosmetics tracked yet.*';
    } else {
        const lines = items.map(formatUpcomingCosmeticLine);
        description = lines.join('\n');
    }

    const embeds = [];
    if (description.length <= 4000) {
        embeds.push(new EmbedBuilder()
            .setTitle(`Upcoming Cosmetics (${items.length})`)
            .setDescription(description)
            .setColor(0x9B59B6)
            .setTimestamp());
    } else {
        const lines = description.split('\n');
        let currentBatch = [];
        let currentLen = 0;
        let batchNum = 0;

        for (const line of lines) {
            if (currentLen + line.length + 1 > 3900 && currentBatch.length > 0) {
                batchNum++;
                embeds.push(new EmbedBuilder()
                    .setTitle(batchNum === 1 ? `Upcoming Cosmetics (${items.length})` : `Upcoming Cosmetics (cont.)`)
                    .setDescription(currentBatch.join('\n'))
                    .setColor(0x9B59B6));
                currentBatch = [];
                currentLen = 0;
            }
            currentBatch.push(line);
            currentLen += line.length + 1;
        }
        if (currentBatch.length > 0) {
            batchNum++;
            embeds.push(new EmbedBuilder()
                .setTitle(batchNum === 1 ? `Upcoming Cosmetics (${items.length})` : `Upcoming Cosmetics (cont.)`)
                .setDescription(currentBatch.join('\n'))
                .setColor(0x9B59B6)
                .setTimestamp());
        }
    }

    const savedMsgId = loadListMessageId();
    if (savedMsgId) {
        try {
            const existingMsg = await listChannel.messages.fetch(savedMsgId);
            if (embeds.length <= 10) {
                await existingMsg.edit({ embeds });
                return;
            } else {
                await existingMsg.delete();
            }
        } catch { }
    }

    // Check for existing bot list message in channel to avoid duplicates on container restart
    try {
        const fetched = await listChannel.messages.fetch({ limit: 10 });
        const botListMsg = fetched.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title?.includes('Upcoming Cosmetics'));
        if (botListMsg) {
            await botListMsg.edit({ embeds });
            saveListMessageId(botListMsg.id);
            return;
        }
    } catch { }

    try {
        const msg = await listChannel.send({ embeds: embeds.slice(0, 10) });
        saveListMessageId(msg.id);
        console.log('[Discord] List message sent.');

        for (let i = 10; i < embeds.length; i += 10) {
            await sleep(1200);
            await listChannel.send({ embeds: embeds.slice(i, i + 10) });
        }
    } catch (e) {
        console.error('[Discord] Failed to send list message:', e.message);
    }
}

function loadListMessageId() {
    try {
        if (fs.existsSync(LIST_MSG_PATH)) {
            return fs.readFileSync(LIST_MSG_PATH, 'utf8').trim();
        }
    } catch { }
    return null;
}

function saveListMessageId(id) {
    try {
        fs.writeFileSync(LIST_MSG_PATH, id);
    } catch (e) {
        console.error('[Discord] Failed to save list message ID:', e.message);
    }
}

// ─── Send Embeds with Rate Limit Handling ────────────────────────

async function sendToSpecificChannel(targetChannel, embed, files = []) {
    if (!targetChannel) {
        return;
    }

    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
        try {
            const payload = { embeds: [embed] };
            if (files && files.length > 0) payload.files = files;
            await targetChannel.send(payload);
            return;
        } catch (err) {
            if (err.status === 429) {
                const retryAfter = (err.retryAfter || 1.5) + 0.3;
                retries++;
                console.warn(`[Discord] Rate limited (429). Waiting ${retryAfter.toFixed(2)}s (${retries}/${maxRetries})...`);
                await sleep(retryAfter * 1000);
            } else {
                console.error('[Discord] Send error:', err.message);
                return;
            }
        }
    }
    console.error('[Discord] Max retries hit for rate limiting.');
}

// ─── Route Changes to Correct Channels ───────────────────────────

async function sendChanges(changes) {
    if (changes.length === 0) return;

    let hadCatalogChanges = false;

    for (const change of changes) {
        let embed;
        let targetChannel;

        switch (change.type) {
            case 'new_item':
                embed = buildNewItemEmbed(change);
                targetChannel = newItemsChannel || catalogChannel;
                hadCatalogChanges = true;
                break;
            case 'removed_item':
                embed = buildRemovedItemEmbed(change);
                targetChannel = catalogChannel;
                hadCatalogChanges = true;
                break;
            case 'name_change':
                embed = buildNameChangeEmbed(change);
                targetChannel = priceChangesChannel || catalogChannel;
                hadCatalogChanges = true;
                break;
            case 'price_change':
                embed = buildPriceChangeEmbed(change);
                targetChannel = priceChangesChannel || catalogChannel;
                hadCatalogChanges = true;
                break;
            case 'bundle_change':
                embed = buildBundleChangeEmbed(change);
                targetChannel = priceChangesChannel || catalogChannel;
                hadCatalogChanges = true;
                break;
            case 'title_data_new': {
                const { embed: tdEmbed, files: tdFiles } = buildTitleDataEmbed('New title data key', change.key, null, change.newValue);
                targetChannel = titleDataChannel || catalogChannel;
                await sendToSpecificChannel(targetChannel, tdEmbed, tdFiles);
                await sleep(1200);
                continue;
            }
            case 'title_data_removed': {
                const { embed: tdEmbed, files: tdFiles } = buildTitleDataEmbed('Title data key removed', change.key, change.oldValue, null);
                targetChannel = titleDataChannel || catalogChannel;
                await sendToSpecificChannel(targetChannel, tdEmbed, tdFiles);
                await sleep(1200);
                continue;
            }
            case 'title_data_changed': {
                const { embed: tdEmbed, files: tdFiles } = buildTitleDataEmbed('Title data value changed', change.key, change.oldValue, change.newValue);
                targetChannel = titleDataChannel || catalogChannel;
                await sendToSpecificChannel(targetChannel, tdEmbed, tdFiles);
                await sleep(1200);
                continue;
            }
            default:
                continue;
        }

        await sendToSpecificChannel(targetChannel, embed);
        await sleep(1200);
    }

    if (hadCatalogChanges) {
        await updateListMessage();
    }
}

// ─── Embed Builders ──────────────────────────────────────────────

function buildCCUEmbed(change) {
    const color = change.newCCU > 0 ? 0x2ECC71 : 0xE74C3C;
    return new EmbedBuilder()
        .setTitle('Players online: ' + change.newCCU)
        .setColor(color);
}

async function sendCCUChange(change) {
    if (!change) return;
    const embed = buildCCUEmbed(change);
    const targetChan = ccuChannel || catalogChannel;
    await sendToSpecificChannel(targetChan, embed);
}

function buildNewItemEmbed(change) {
    const item = change.item;
    const embed = new EmbedBuilder()
        .setTitle('New item added to catalog')
        .setDescription(`**${item.DisplayName || item.ItemId}**\nID: \`${item.ItemId}\``)
        .setColor(0x2ECC71);

    if (item.Description) {
        embed.addFields({ name: 'Description', value: item.Description, inline: false });
    }

    if (item.Bundle) {
        embed.addFields({ name: 'Type', value: 'Bundle', inline: true });
        if (item.Bundle.BundledItems && item.Bundle.BundledItems.length > 0) {
            embed.addFields({ name: 'Includes items', value: item.Bundle.BundledItems.join(', '), inline: false });
        }
        if (item.Bundle.BundledVirtualCurrencies) {
            const currencies = Object.entries(item.Bundle.BundledVirtualCurrencies)
                .map(([k, v]) => `${getCurrencyName(k)}: ${v}`).join(', ');
            if (currencies) embed.addFields({ name: 'Includes currency', value: currencies, inline: false });
        }
    }

    embed.addFields({ name: 'Price', value: getPriceString(item), inline: false });
    return embed;
}

function buildRemovedItemEmbed(change) {
    return new EmbedBuilder()
        .setTitle('Item removed from catalog')
        .setDescription(`**${change.displayName}**\nID: \`${change.item.ItemId}\``)
        .setColor(0xE74C3C);
}

function buildNameChangeEmbed(change) {
    return new EmbedBuilder()
        .setTitle('Display name changed')
        .setDescription(`ID: \`${change.item.ItemId}\``)
        .setColor(0xF1C40F)
        .addFields(
            { name: 'Old name', value: change.oldName || 'None', inline: true },
            { name: 'New name', value: change.newName || 'None', inline: true },
        );
}

function buildPriceChangeEmbed(change) {
    const embed = new EmbedBuilder()
        .setTitle('Price changed')
        .setDescription(`**${change.item.DisplayName || change.item.ItemId}**\nID: \`${change.item.ItemId}\``)
        .setColor(0xF1C40F);

    const oldV = change.oldItem.VirtualCurrencyPrices || {};
    const newV = change.item.VirtualCurrencyPrices || {};
    const allVKeys = [...new Set([...Object.keys(oldV), ...Object.keys(newV)])];
    for (const key of allVKeys) {
        const oldVal = key in oldV ? oldV[key].toString() : '\u2013';
        const newVal = key in newV ? newV[key].toString() : '\u2013';
        if (oldVal !== newVal) {
            embed.addFields({ name: getCurrencyName(key), value: `${oldVal} \u2192 ${newVal}`, inline: true });
        }
    }

    const oldR = change.oldItem.RealCurrencyPrices || {};
    const newR = change.item.RealCurrencyPrices || {};
    const allRKeys = [...new Set([...Object.keys(oldR), ...Object.keys(newR)])];
    for (const key of allRKeys) {
        const oldVal = key in oldR ? oldR[key].toString() : '\u2013';
        const newVal = key in newR ? newR[key].toString() : '\u2013';
        if (oldVal !== newVal) {
            embed.addFields({ name: getCurrencyName(key), value: `${oldVal} \u2192 ${newVal}`, inline: true });
        }
    }

    return embed;
}

function buildBundleChangeEmbed(change) {
    const embed = new EmbedBuilder()
        .setTitle('Bundle content changed')
        .setDescription(`**${change.item.DisplayName || change.item.ItemId}**\nID: \`${change.item.ItemId}\``)
        .setColor(0xF1C40F);

    const oldItems = (change.oldItem.Bundle?.BundledItems || []).sort();
    const newItems = (change.item.Bundle?.BundledItems || []).sort();
    if (JSON.stringify(oldItems) !== JSON.stringify(newItems)) {
        embed.addFields({
            name: 'Bundled items changed',
            value: `Old: ${oldItems.join(', ') || 'None'}\nNew: ${newItems.join(', ') || 'None'}`,
            inline: false,
        });
    }

    const oldCur = change.oldItem.Bundle?.BundledVirtualCurrencies || {};
    const newCur = change.item.Bundle?.BundledVirtualCurrencies || {};
    if (JSON.stringify(oldCur) !== JSON.stringify(newCur)) {
        const oldStr = Object.entries(oldCur).map(([k, v]) => `${getCurrencyName(k)}: ${v}`).join(', ') || 'None';
        const newStr = Object.entries(newCur).map(([k, v]) => `${getCurrencyName(k)}: ${v}`).join(', ') || 'None';
        embed.addFields({ name: 'Bundled currency changed', value: `Old: ${oldStr}\nNew: ${newStr}`, inline: false });
    }

    return embed;
}

function buildTitleDataEmbed(title, key, oldValue, newValue) {
    let color = 0xF1C40F;
    if (oldValue === null || oldValue === undefined) color = 0x2ECC71;
    if (newValue === null || newValue === undefined) color = 0xE74C3C;

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`Key: \`${key}\``)
        .setColor(color);

    const files = [];

    // If either value is large (> 950 chars), attach full file
    if ((oldValue && oldValue.length > 950) || (newValue && newValue.length > 950)) {
        let fileContent = `=== TITLE DATA CHANGE ===\nKey: ${key}\nType: ${title}\n\n`;
        if (oldValue) fileContent += `=== OLD VALUE ===\n${oldValue}\n\n`;
        if (newValue) fileContent += `=== NEW VALUE ===\n${newValue}\n\n`;

        files.push({
            attachment: Buffer.from(fileContent, 'utf8'),
            name: `${key}_change.txt`,
        });
    }

    if (oldValue !== null && oldValue !== undefined && newValue !== null && newValue !== undefined) {
        embed.addFields(
            { name: 'Old value', value: prettyFormat(oldValue), inline: false },
            { name: 'New value', value: prettyFormat(newValue), inline: false },
        );
    } else if (newValue !== null && newValue !== undefined) {
        embed.addFields({ name: 'New value', value: prettyFormat(newValue), inline: false });
    } else if (oldValue !== null && oldValue !== undefined) {
        embed.addFields({ name: 'Old value', value: prettyFormat(oldValue), inline: false });
    }

    if (files.length > 0) {
        embed.setFooter({ text: 'Full content attached as a file due to length.' });
    }

    return { embed, files };
}

function prettyFormat(input) {
    if (!input) return '*(empty)*';

    let cleaned = input.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').trim();

    if ((cleaned.startsWith('{') && cleaned.endsWith('}')) || (cleaned.startsWith('[') && cleaned.endsWith(']'))) {
        try {
            const parsed = JSON.parse(cleaned);
            const formatted = JSON.stringify(parsed, null, 2);
            return wrapCodeBlock(formatted, 'json');
        } catch { }
    }

    return wrapCodeBlock(cleaned, 'txt');
}

function wrapCodeBlock(text, lang) {
    const maxLen = 950;
    if (text.length > maxLen) {
        text = text.substring(0, maxLen) + '\n... (truncated)';
    }
    return '```' + lang + '\n' + text + '\n```';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function updateCheckStats(itemCount) {
    lastCheckTime = Date.now();
    lastCheckItemCount = itemCount;
}

function getClient() { return client; }
module.exports = { initBot, sendChanges, sendDevChanges, sendCCUChange, updateCheckStats, updateListMessage, updateStatusMessage, sleep, getClient };
async function handleUpdateMothershipToken(interaction) {
    await interaction.deferReply();
    const token = interaction.options.getString('token');
    try {
        const { validateMothershipToken, setMothershipToken, fetchMothershipTitleData } = require('./mothership');
        const { diffTitleData } = require('./tracker');

        const val = await validateMothershipToken(token);
        if (!val.success) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('❌ Mothership Token Invalid')
                        .setDescription(`The token was rejected by Mothership:
\`\`\`${val.error}\`\`\``)
                        .setColor(0xE74C3C)
                ]
            });
        }

        setMothershipToken(token);
        const titleData = await fetchMothershipTitleData();
        const changes = diffTitleData(titleData);
        if (changes.length > 0) {
            await sendChanges(changes);
        }

        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('✅ Mothership Token Updated!')
                    .setDescription(`Successfully authenticated with Mothership!

• **Keys Loaded**: ${val.count} keys
• **Changes Detected**: ${changes.length}
• **Status**: Active & saved to storage`)
                    .setColor(0x2ECC71)
            ]
        });
    } catch (e) {
        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('❌ Error Updating Token')
                    .setDescription(`\`\`\`${e.message}\`\`\``)
                    .setColor(0xE74C3C)
            ]
        });
    }
}
