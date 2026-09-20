export function moveStoredOwner(bucket, oldKeys, newKey) {
    if (!bucket || !newKey) return false;
    for (const oldKey of oldKeys) {
        if (!oldKey || oldKey === newKey || !Object.hasOwn(bucket, oldKey) || Object.hasOwn(bucket, newKey)) continue;
        bucket[newKey] = bucket[oldKey];
        delete bucket[oldKey];
        return true;
    }
    return false;
}

export function migratePresetRenameSettings(state, {
    apiId,
    oldName,
    newName,
    ownerKey,
    legacyOwnerKey,
}) {
    if (!state || !apiId || !oldName || !newName || oldName === newName) return false;

    const oldPromptOwner = ownerKey(apiId, oldName);
    const newPromptOwner = ownerKey(apiId, newName);
    const oldRegexOwner = ownerKey('preset', apiId, oldName);
    const newRegexOwner = ownerKey('preset', apiId, newName);
    const oldRegexLegacyOwner = legacyOwnerKey('preset', apiId, oldName);

    return [
        moveStoredOwner(state.layouts?.prompts, [oldPromptOwner, legacyOwnerKey(apiId, oldName)], newPromptOwner),
        moveStoredOwner(state.collapsed?.prompt, [oldPromptOwner, legacyOwnerKey(apiId, oldName)], newPromptOwner),
        moveStoredOwner(state.layouts?.regex?.preset, [oldRegexOwner, oldRegexLegacyOwner], newRegexOwner),
        moveStoredOwner(state.collapsed?.regex, [
            `preset:${oldRegexOwner}`,
            oldRegexOwner,
            `preset:${oldRegexLegacyOwner}`,
            oldRegexLegacyOwner,
        ], `preset:${newRegexOwner}`),
    ].some(Boolean);
}

export function removeFoldyPersistentData({
    extensionSettings,
    settingsKey,
    accountStorage,
    lorePerPageKey,
    sortOrderKey,
    loreSortValues = [],
}) {
    const hasAccountStorage = accountStorage && typeof accountStorage.getItem === 'function';
    const removed = {
        settings: Object.hasOwn(extensionSettings, settingsKey),
        lorePage: hasAccountStorage && accountStorage.getItem(lorePerPageKey) !== null,
        loreSort: hasAccountStorage && loreSortValues.includes(accountStorage.getItem(sortOrderKey)),
    };

    delete extensionSettings[settingsKey];
    if (removed.lorePage) accountStorage.removeItem(lorePerPageKey);
    if (removed.loreSort) accountStorage.removeItem(sortOrderKey);
    return removed;
}
