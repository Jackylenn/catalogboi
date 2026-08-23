const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOT_DIR = path.join(__dirname, '..');

/**
 * Filter out combined mesh noise, baked occlusion chunks, and dumper temp objects.
 */
function isTrashOrCombinedMesh(line) {
    if (!line) return true;
    const l = line.toLowerCase().trim();
    if (!l || l.startsWith('//') || l.startsWith('#')) return true;

    // Combined meshes & baked static chunks
    if (l.includes('combined mesh') || l.includes('combinedmesh') || l.includes('combined_mesh')) return true;
    if (l.includes('scenemesh_') || l.includes('scenemesh-') || l.includes('bakedmesh') || l.includes('mergedmesh') || l.includes('staticmesh')) return true;
    if (l.includes('__hierarchydumper') || l.includes('ddol_probe')) return true;
    if (l.includes('reflection probe') || l.includes('occlusion') || l.includes('navmesh')) return true;

    return false;
}

/**
 * Locate old and new hierarchy dump files in data/ or root.
 */
function findDumpFiles() {
    const oldCandidates = [
        path.join(DATA_DIR, 'hiarchydumpold.txt'),
        path.join(DATA_DIR, 'hierarchydumpold.txt'),
        path.join(ROOT_DIR, 'hiarchydumpold.txt'),
        path.join(ROOT_DIR, 'hierarchydumpold.txt'),
    ];
    const newCandidates = [
        path.join(DATA_DIR, 'hiarchydumpnew.txt'),
        path.join(DATA_DIR, 'hierarchydumpnew.txt'),
        path.join(ROOT_DIR, 'hiarchydumpnew.txt'),
        path.join(ROOT_DIR, 'hierarchydumpnew.txt'),
    ];

    const oldPath = oldCandidates.find(p => fs.existsSync(p));
    const newPath = newCandidates.find(p => fs.existsSync(p));

    return { oldPath, newPath };
}

/**
 * Parse a hierarchy dump file into a Map of { path -> { raw, name, components, active } }.
 */
function parseHierarchyDump(filePath) {
    const map = new Map();
    if (!filePath || !fs.existsSync(filePath)) return map;

    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const lines = text.split(/\r?\n/);

        const pathStack = []; // stores [depth] = name

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
            if (!rawLine || isTrashOrCombinedMesh(rawLine)) continue;

            // Calculate depth (indent = 2 spaces per level)
            const match = rawLine.match(/^(\s*)/);
            const spaces = match ? match[1].length : 0;
            const depth = Math.floor(spaces / 2);

            const trimmed = rawLine.trim();
            if (!trimmed) continue;

            // Extract gameobject name (before [OFF] or [ComponentList])
            let goName = trimmed;
            const bracketIdx = goName.indexOf('[');
            if (bracketIdx !== -1) {
                goName = goName.substring(0, bracketIdx).trim();
            }

            pathStack[depth] = goName;
            pathStack.length = depth + 1; // truncate deeper levels

            const fullPath = pathStack.join(' / ');
            map.set(fullPath, {
                raw: trimmed,
                name: goName,
                path: fullPath,
                depth,
            });
        }
    } catch (e) {
        console.error('[Hierarchy] Failed to parse dump file:', filePath, e.message);
    }

    return map;
}

/**
 * Diff old vs new hierarchy dumps and return added, removed, and modified items.
 */
function diffHierarchyDumps(oldPath, newPath) {
    console.log(`[Hierarchy] Diffing dumps: Old (${path.basename(oldPath)}) vs New (${path.basename(newPath)})...`);

    const oldMap = parseHierarchyDump(oldPath);
    const newMap = parseHierarchyDump(newPath);

    const added = [];
    const removed = [];
    const modified = [];

    // Find added & modified
    for (const [fullPath, info] of newMap.entries()) {
        if (!oldMap.has(fullPath)) {
            added.push(info);
        } else {
            const oldInfo = oldMap.get(fullPath);
            if (oldInfo.raw !== info.raw) {
                modified.push({ fullPath, oldRaw: oldInfo.raw, newRaw: info.raw });
            }
        }
    }

    // Find removed
    for (const [fullPath, info] of oldMap.entries()) {
        if (!newMap.has(fullPath)) {
            removed.push(info);
        }
    }

    return { added, removed, modified, totalOld: oldMap.size, totalNew: newMap.size };
}

/**
 * Check on startup once, diff, send to Discord, and archive new -> old.
 */
async function checkHierarchyDumpsOnStartup(client) {
    const { oldPath, newPath } = findDumpFiles();

    if (!oldPath || !newPath) {
        if (newPath && !oldPath) {
            console.log('[Hierarchy] Found initial hierarchy dump (new). Renaming to old baseline.');
            const targetOld = path.join(DATA_DIR, 'hiarchydumpold.txt');
            try {
                fs.copyFileSync(newPath, targetOld);
                fs.unlinkSync(newPath);
            } catch { }
        }
        return;
    }

    try {
        const diff = diffHierarchyDumps(oldPath, newPath);
        const { added, removed, modified } = diff;

        console.log(`[Hierarchy] Diff results: +${added.length} added, -${removed.length} removed, ~${modified.length} modified.`);

        if (added.length === 0 && removed.length === 0 && modified.length === 0) {
            console.log('[Hierarchy] No hierarchy differences detected.');
            try {
                fs.copyFileSync(newPath, oldPath);
                fs.unlinkSync(newPath);
            } catch { }
            return;
        }

        // Determine destination Discord channel
        const targetChanId = config.discord.hierarchyChannelId || config.discord.titleDataChannelId || config.discord.catalogChannelId;
        if (!targetChanId) {
            console.warn('[Hierarchy] No channel ID available to send hierarchy diffs.');
            return;
        }

        let targetChan = null;
        try {
            targetChan = await client.channels.fetch(targetChanId);
        } catch (e) {
            console.error('[Hierarchy] Failed to fetch channel:', e.message);
            return;
        }

        if (!targetChan) return;

        // 1. Post Header Embed
        const headerEmbed = new EmbedBuilder()
            .setTitle('🗺️ Gorilla Tag Hierarchy Update Detected!')
            .setColor(0x3498DB)
            .setDescription(`Detected map & scene hierarchy changes between updates.\n**Additions:** \`+${added.length}\` | **Removals:** \`-${removed.length}\` | **Modified:** \`~${modified.length}\``)
            .setTimestamp();
        await targetChan.send({ embeds: [headerEmbed] });

        // 2. Post Additions in Batches
        if (added.length > 0) {
            const addedLines = added.map(a => `➕ \`${a.path}\` ${a.raw.includes('[') ? a.raw.substring(a.raw.indexOf('[')) : ''}`);
            await sendBatchedEmbeds(targetChan, '🆕 New GameObjects Added', addedLines, 0x2ECC71);
        }

        // 3. Post Removals in Batches
        if (removed.length > 0) {
            const removedLines = removed.map(r => `➖ \`${r.path}\``);
            await sendBatchedEmbeds(targetChan, '🗑️ GameObjects Removed', removedLines, 0xE74C3C);
        }

        // 4. Post Modified in Batches
        if (modified.length > 0) {
            const modLines = modified.map(m => `🔄 \`${m.fullPath}\`\n  Old: \`${m.oldRaw}\`\n  New: \`${m.newRaw}\``);
            await sendBatchedEmbeds(targetChan, '✏️ GameObjects Modified', modLines, 0xF1C40F);
        }

        // Archive new -> old so it is not re-posted on next restart
        try {
            fs.copyFileSync(newPath, oldPath);
            fs.unlinkSync(newPath);
            console.log('[Hierarchy] Successfully archived hiarchydumpnew.txt -> hiarchydumpold.txt');
        } catch (e) {
            console.error('[Hierarchy] Failed to archive dump files:', e.message);
        }

    } catch (err) {
        console.error('[Hierarchy] Error during startup hierarchy check:', err.message);
    }
}

async function sendBatchedEmbeds(channel, title, lines, color, batchSize = 15) {
    for (let i = 0; i < lines.length; i += batchSize) {
        const batch = lines.slice(i, i + batchSize);
        let desc = batch.join('\n\n');
        if (desc.length > 4000) {
            desc = desc.substring(0, 3950) + '\n... (truncated)';
        }

        const embed = new EmbedBuilder()
            .setTitle(i === 0 ? title : `${title} (cont.)`)
            .setDescription(desc)
            .setColor(color);

        await channel.send({ embeds: [embed] });
        await new Promise(r => setTimeout(r, 1200));
    }
}

module.exports = {
    checkHierarchyDumpsOnStartup,
    diffHierarchyDumps,
    parseHierarchyDump,
};