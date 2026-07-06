function defaultCloneValue(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fall back to JSON below for host objects structuredClone cannot copy.
        }
    }
    return JSON.parse(JSON.stringify(value));
}

function cloneSafely(value, cloneValue) {
    try {
        return cloneValue(value);
    } catch {
        return String(value);
    }
}

function valueType(value) {
    return Array.isArray(value) ? 'array' : typeof value;
}

export function createFoldySettingsStore({
    extensionSettings,
    settingsKey = 'foldy',
    corruptedLimit = 12,
    extensionName = 'Foldy',
    cloneValue = defaultCloneValue,
    logger = console,
} = {}) {
    let repaired = false;

    const preserveCorrupted = (value, key, corruptedValue) => {
        if (!value._corrupted || typeof value._corrupted !== 'object' || Array.isArray(value._corrupted)) {
            value._corrupted = {};
        }
        value._corrupted[key] = cloneSafely(corruptedValue, cloneValue);
        const corruptedKeys = Object.keys(value._corrupted);
        while (corruptedKeys.length > corruptedLimit) {
            delete value._corrupted[corruptedKeys.shift()];
        }
        logger.warn?.(`[${extensionName}] 설정 구조 복구: ${key}`, {
            preservedAs: `_corrupted.${key}`,
            valueType: valueType(corruptedValue),
        });
    };

    const repairSettings = () => {
        if (!extensionSettings[settingsKey] || typeof extensionSettings[settingsKey] !== 'object' || Array.isArray(extensionSettings[settingsKey])) {
            extensionSettings[settingsKey] = {};
        }
        const value = extensionSettings[settingsKey];
        const ensureObject = key => {
            if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
                preserveCorrupted(value, key, value[key]);
                value[key] = {};
            }
            return value[key];
        };
        const features = ensureObject('features');
        const layouts = ensureObject('layouts');
        const collapsed = ensureObject('collapsed');
        const ensureChildObject = (parent, key, label) => {
            if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
                preserveCorrupted(value, label, parent[key]);
                parent[key] = {};
            }
            return parent[key];
        };

        features.prompts ??= true;
        features.lorebooks ??= true;
        features.regex ??= true;
        ensureChildObject(layouts, 'prompts', 'layouts.prompts');
        ensureChildObject(layouts, 'lorebooks', 'layouts.lorebooks');
        const regexLayouts = ensureChildObject(layouts, 'regex', 'layouts.regex');
        ensureChildObject(regexLayouts, 'global', 'layouts.regex.global');
        ensureChildObject(regexLayouts, 'scoped', 'layouts.regex.scoped');
        ensureChildObject(regexLayouts, 'preset', 'layouts.regex.preset');
        ensureChildObject(collapsed, 'prompt', 'collapsed.prompt');
        ensureChildObject(collapsed, 'lore', 'collapsed.lore');
        ensureChildObject(collapsed, 'regex', 'collapsed.regex');
        repaired = true;
        return value;
    };

    const settings = () => {
        const value = extensionSettings[settingsKey];
        if (!repaired || !value || typeof value !== 'object' || Array.isArray(value)) {
            return repairSettings();
        }
        return value;
    };

    return { repairSettings, settings };
}
