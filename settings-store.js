import { decodeStore, encodeStore, isStoredStore } from './storage-format.js';

function defaultCloneValue(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // structuredClone이 복사할 수 없는 호스트 객체는 아래 JSON 방식으로 대체한다.
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

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 레이아웃과 접힘 상태 중 하나라도 남아 있으면 백업 대상이다.
function hasLegacyContent(value) {
    const { layouts, collapsed } = value;
    if ((layouts !== undefined && !isRecord(layouts)) || (collapsed !== undefined && !isRecord(collapsed))) return true;
    const regex = layouts?.regex;
    const buckets = [
        layouts?.prompts,
        layouts?.lorebooks,
        ...(isRecord(regex) ? Object.values(regex) : [regex]),
        ...Object.values(collapsed ?? {}),
    ];
    return buckets.some(bucket => bucket !== undefined && (!isRecord(bucket) || Object.keys(bucket).length > 0));
}

function defineHidden(target, key, value) {
    Object.defineProperty(target, key, { value, enumerable: false, configurable: true, writable: true });
}

export const POSITION_FILTER_KINDS = ['prompts', 'lorebooks', 'regex'];
export const POSITION_FILTER_VALUES = ['folders', 'items', 'all'];
const DEFAULT_POSITION_FILTER = 'folders';
export const LEGACY_BACKUP_FILE = 'foldy-v1-backup.json';
export const LEGACY_BACKUP_TTL = 3 * 24 * 60 * 60 * 1000;

export function createFoldySettingsStore({
    extensionSettings,
    settingsKey = 'foldy',
    corruptedLimit = 12,
    extensionName = 'Foldy',
    cloneValue = defaultCloneValue,
    logger = console,
} = {}) {
    let cachedSettings = null;
    const hydrated = new WeakSet();
    // 아직 파일로 옮기지 못한 v1 원본이다.
    const legacySnapshots = new WeakMap();

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

    // layouts/collapsed는 메모리에만 두고, settings.json에는 store getter가 압축본을 쓴다.
    const hydrate = value => {
        const storeDescriptor = Object.getOwnPropertyDescriptor(value, 'store');
        const storedValue = storeDescriptor && 'value' in storeDescriptor ? storeDescriptor.value : undefined;
        let decoded = null;
        if (isStoredStore(storedValue)) {
            try {
                decoded = decodeStore(storedValue);
            } catch (error) {
                logger.error?.(`[${extensionName}] 저장된 폴더 구조를 읽지 못했습니다.`, error);
            }
        }
        if (storedValue !== undefined && !decoded) preserveCorrupted(value, 'store', storedValue);

        const hasLegacy = Object.hasOwn(value, 'layouts') || Object.hasOwn(value, 'collapsed');
        const legacyPending = hasLegacy && hasLegacyContent(value);
        if (legacyPending) {
            legacySnapshots.set(value, cloneSafely({ layouts: value.layouts, collapsed: value.collapsed }, cloneValue));
        }

        const layouts = decoded ? decoded.layouts : value.layouts;
        const collapsed = decoded ? decoded.collapsed : value.collapsed;
        if (legacyPending) {
            // 파일 백업 전까지는 v1도 settings.json에 최신 상태로 함께 남긴다.
            value.layouts = layouts;
            value.collapsed = collapsed;
        } else {
            delete value.layouts;
            delete value.collapsed;
            defineHidden(value, 'layouts', layouts);
            defineHidden(value, 'collapsed', collapsed);
        }

        let lastEncoded = decoded ? storedValue : null;
        Object.defineProperty(value, 'store', {
            enumerable: true,
            configurable: true,
            get() {
                try {
                    lastEncoded = encodeStore(value.layouts, value.collapsed);
                } catch (error) {
                    logger.error?.(`[${extensionName}] 폴더 구조 저장 형식 변환 실패`, error);
                }
                return lastEncoded;
            },
            set(next) {
                if (!isStoredStore(next)) return;
                const replaced = decodeStore(next);
                value.layouts = replaced.layouts;
                value.collapsed = replaced.collapsed;
            },
        });
        hydrated.add(value);
    };

    const repairSettings = () => {
        if (!extensionSettings[settingsKey] || typeof extensionSettings[settingsKey] !== 'object' || Array.isArray(extensionSettings[settingsKey])) {
            extensionSettings[settingsKey] = {};
        }
        const value = extensionSettings[settingsKey];
        if (!hydrated.has(value)) hydrate(value);
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
        const ui = ensureObject('ui');
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
        features.lorebookHome ??= false;
        const positionFilter = ensureChildObject(ui, 'positionFilter', 'ui.positionFilter');
        for (const kind of POSITION_FILTER_KINDS) {
            if (!POSITION_FILTER_VALUES.includes(positionFilter[kind])) positionFilter[kind] = DEFAULT_POSITION_FILTER;
        }
        ensureChildObject(layouts, 'prompts', 'layouts.prompts');
        ensureChildObject(layouts, 'lorebooks', 'layouts.lorebooks');
        ensureChildObject(layouts, 'books', 'layouts.books');
        const regexLayouts = ensureChildObject(layouts, 'regex', 'layouts.regex');
        ensureChildObject(regexLayouts, 'global', 'layouts.regex.global');
        ensureChildObject(regexLayouts, 'scoped', 'layouts.regex.scoped');
        ensureChildObject(regexLayouts, 'preset', 'layouts.regex.preset');
        ensureChildObject(collapsed, 'prompt', 'collapsed.prompt');
        ensureChildObject(collapsed, 'lore', 'collapsed.lore');
        ensureChildObject(collapsed, 'book', 'collapsed.book');
        ensureChildObject(collapsed, 'regex', 'collapsed.regex');
        cachedSettings = value;
        return cachedSettings;
    };

    const settings = () => {
        if (cachedSettings && extensionSettings[settingsKey] === cachedSettings) return cachedSettings;
        return repairSettings();
    };

    const revalidateSettings = () => repairSettings();

    // v1 원본을 파일로 옮긴 뒤 settings.json에서 빼고, 기한이 지난 백업 파일은 지운다.
    // 설정을 바꿨으면 true를 반환한다.
    const maintainLegacyBackup = async ({ upload, remove, now = Date.now }) => {
        const value = settings();
        let changed = false;
        const snapshot = legacySnapshots.get(value);
        if (snapshot) {
            const savedAt = now();
            const path = await upload(LEGACY_BACKUP_FILE, JSON.stringify({ savedAt, ...snapshot }));
            if (extensionSettings[settingsKey] !== value) return false;
            for (const key of ['layouts', 'collapsed']) {
                const current = value[key];
                delete value[key];
                defineHidden(value, key, current);
            }
            value.legacyBackup = { path, savedAt };
            legacySnapshots.delete(value);
            return true;
        }

        const record = value.legacyBackup;
        if (record === undefined) return false;
        const savedAt = Number(record?.savedAt);
        if (isRecord(record) && typeof record.path === 'string' && Number.isFinite(savedAt) && now() - savedAt < LEGACY_BACKUP_TTL) {
            return false;
        }
        if (isRecord(record) && typeof record.path === 'string' && record.path) {
            if (!await remove(record.path)) return false;
        }
        if (extensionSettings[settingsKey] === value && value.legacyBackup === record) {
            delete value.legacyBackup;
            changed = true;
        }
        return changed;
    };

    return { repairSettings, revalidateSettings, settings, maintainLegacyBackup };
}
