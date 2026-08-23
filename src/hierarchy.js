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
 * Parse a hierarchy dump file into a Map of { fullPath -> { scene, relativePath, raw, depth } }.
 */
function parseHierarchyDump(filePath) {
    const map = new Map();
    if (!filePath || !fs.existsSync(filePath)) return map;

    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const lines = text.split(/\r?\n/);

        let currentScene = 'General';
        const pathStack = [];

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
            if (!rawLine || isTrashOrCombinedMesh(rawLine)) continue;

            const match = rawLine.match(/^(\s*)/);
            const spaces = match ? match[1].length : 0;
            const depth = Math.floor(spaces / 2);

            const trimmed = rawLine.trim();
            if (!trimmed) continue;

            if (depth === 0) {
                // Root scene header (e.g. Forest, Cave, DontDestroyOnLoad)
                currentScene = trimmed;
                pathStack.length = 0;
                pathStack[0] = currentScene;
                continue;
            }

            let goName = trimmed;
            const bracketIdx = goName.indexOf('[');
            if (bracketIdx !== -1) {
                goName = goName.substring(0, bracketIdx).trim();
            }

            pathStack[depth] = goName;
            pathStack.length = depth + 1;

            const fullPath = pathStack.join(' / ');
            const relativePath = pathStack.slice(1).join(' / ');

            map.set(fullPath, {
                scene: currentScene,
                relativePath,
                fullPath,
                raw: trimmed,
                depth,
            });
        }
    } catch (e) {
        console.error('[Hierarchy] Failed to parse dump file:', filePath, e.message);
    }

    return map;
}

/**
 * Diff old vs new hierarchy dumps and group changes per scene.
 */
function diffHierarchyDumps(oldPath, newPath) {
    console.log(`[Hierarchy] Diffing dumps: Old (${path.basename(oldPath)}) vs New (${path.basename(newPath)})...`);

    const oldMap = parseHierarchyDump(oldPath);
    const newMap = parseHierarchyDump(newPath);

    // sceneName -> { added: [], removed: [] }
    const sceneMap = new Map();

    let totalAdded = 0;
    let totalRemoved = 0;

    // Find added
    for (const [fullPath, info] of newMap.entries()) {
        if (!oldMap.has(fullPath)) {
            if (!sceneMap.has(info.scene)) sceneMap.set(info.scene, { added: [], removed: [] });
            sceneMap.get(info.scene).added.push(info);
            totalAdded++;
        }
    }

    // Find removed
    for (const [fullPath, info] of oldMap.entries()) {
        if (!newMap.has(fullPath)) {
            if (!sceneMap.has(info.scene)) sceneMap.set(info.scene, { added: [], removed: [] });
            sceneMap.get(info.scene).removed.push(info);
            totalRemoved++;
        }
    }

    return {
        scenes: sceneMap,
        totalAdded,
        totalRemoved,
        totalOld: oldMap.size,
        totalNew: newMap.size,
    };
}

/**
 * Check on startup once, diff, send 1 embed per scene, and archive new -> old.
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
        const { scenes, totalAdded, totalRemoved } = diffHierarchyDumps(oldPath, newPath);

        console.log(`[Hierarchy] Diff results: +${totalAdded} added, -${totalRemoved} removed across ${scenes.size} scene(s).`);

        if (totalAdded === 0 && totalRemoved === 0) {
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

        // 1. Post Main Summary Header Embed
        const headerEmbed = new EmbedBuilder()
            .setTitle('🗺️ Gorilla Tag Hierarchy Changes')
            .setColor(0x3498DB)
            .setDescription(`Detected map & scene hierarchy changes between updates.\n\n**Total Changes:** \`+${totalAdded} added\` | \`-${totalRemoved} removed\` across **${scenes.size}** scene(s).`)
            .setTimestamp();
        await targetChan.send({ embeds: [headerEmbed] });

        // 2. Post 1 Embed per Scene
        for (const [sceneName, changes] of scenes.entries()) {
            const lines = [];

            for (const a of changes.added) {
                const comp = a.raw.includes('[') ? ' ' + a.raw.substring(a.raw.indexOf('[')) : '';
                lines.push(`+ ${a.relativePath}${comp}`);
            }

            for (const r of changes.removed) {
                const comp = r.raw.includes('[') ? ' ' + r.raw.substring(r.raw.indexOf('[')) : '';
                lines.push(`- ${r.relativePath}${comp}`);
            }

            const title = `📍 Scene: ${sceneName} (+${changes.added.length}, -${changes.removed.length})`;
            const color = changes.added.length > 0 && changes.removed.length === 0 ? 0x2ECC71
                        : changes.removed.length > 0 && changes.added.length === 0 ? 0xE74C3C
                        : 0xF1C40F; // mixed

            await sendSceneEmbeds(targetChan, title, lines, color);
            await new Promise(r => setTimeout(r, 1200));
        }

        // Archive new -> old so it won't repeat on future restarts
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

/**
 * Format scene diff lines into 1 embed if it fits, or chunk if too big.
 */
async function sendSceneEmbeds(channel, title, lines, color) {
    const maxCharsPerBlock = 3800;
    const blocks = [];
    let currentBlock = [];
    let currentLen = 0;

    for (const line of lines) {
        if (currentLen + line.length + 1 > maxCharsPerBlock && currentBlock.length > 0) {
            blocks.push(currentBlock);
            currentBlock = [];
            currentLen = 0;
        }
        currentBlock.push(line);
        currentLen += line.length + 1;
    }
    if (currentBlock.length > 0) blocks.push(currentBlock);

    for (let i = 0; i < blocks.length; i++) {
        const blockTitle = blocks.length === 1 ? title : `${title} (${i + 1}/${blocks.length})`;
        const diffBody = '```diff\n' + blocks[i].join('\n') + '\n```';

        const embed = new EmbedBuilder()
            .setTitle(blockTitle)
            .setDescription(diffBody)
            .setColor(color);

        await channel.send({ embeds: [embed] });
        if (i + 1 < blocks.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

module.exports = {
    checkHierarchyDumpsOnStartup,
    diffHierarchyDumps,
    parseHierarchyDump,
};