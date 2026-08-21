/**
 * Resolve item category from ItemId prefix.
 * Same logic as the BepInEx mod's GetItemCategoryString.
 */
function getItemCategory(itemId, price) {
    if (!itemId) return 'Cosmetic';

    const id = itemId.toUpperCase();
    const isFreeOrNoPrice = price === 0 || price === null || price === undefined;

    if (id.startsWith('LH')) return 'Hat';
    if (id.startsWith('LF')) return 'Face';
    if (id.startsWith('LB')) return isFreeOrNoPrice ? 'Badge' : 'Shirt';
    if (id.startsWith('LS')) return 'Bundle';
    if (id.startsWith('LM')) return 'Holdable';
    if (id.startsWith('LP')) return 'Collectible';
    if (id.startsWith('LC')) return 'Shirt';
    if (id.startsWith('LA')) return 'Arms';
    if (id.startsWith('LE')) return 'TagEffect';

    return 'Cosmetic';
}

module.exports = { getItemCategory };