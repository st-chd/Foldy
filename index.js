import { characters, eventSource, event_types, getCurrentChatId, reloadCurrentChat, saveSettingsDebounced, this_chid } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getChatCompletionPreset, oai_settings, promptManager } from '../../../openai.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { getPresetManager } from '../../../preset-manager.js';
import { renderTemplateAsync } from '../../../templates.js';
import { getSortableDelay, waitUntilCondition } from '../../../utils.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { cloneJson, createBundleActions } from './bundle-utils.js';
import {
    bindAction,
    createLabeledIconButton,
    createIconButton,
    folderStyleValues,
    createFolderElement as createFolderElementBase,
} from './folder-ui.js';
import {
    createConfirmDialogs,
    createFolderDialogs,
} from './folder-dialogs.js';
import { createClearDataDialog, createFoldyDataCleanup } from './clear-data-dialog.js';
import { createPromptIntegration } from './prompt-integration.js';
import {
    createLorebookBundleActions,
    createLorebookIntegration,
    isLoreOriginalDataCompatible as isLoreOriginalDataCompatibleBase,
    loreEntryLabel,
    setLoreEntryPosition,
    setLoreEntryStrategy,
    setLoreFolderEntriesEnabled,
    syncLoreOriginalEntry,
} from './lorebook-integration.js';
import {
    createRegexBundleActions,
    createRegexIntegration,
    saveRegexScriptsWithLatest,
} from './regex-integration.js';
import {
    createWorldInfoEntry,
    deleteWIOriginalDataValue,
    deleteWorldInfoEntry,
    getWorldEntry,
    loadWorldInfo,
    reloadEditor,
    saveWorldInfo,
    setWIOriginalDataValue,
    SORT_ORDER_KEY,
    updateWorldInfoList,
    world_names,
} from '../../../world-info.js';
import {
    allowPresetScripts,
    allowScopedScripts,
    getCurrentPresetAPI,
    getCurrentPresetName,
    getScriptsByType,
    saveScriptsByType,
    SCRIPT_TYPES,
} from '../../regex/engine.js';
import {
    FOLDY_VERSION,
    flattenLayout,
    layoutWithAddedFolder,
    layoutWithItemsMovedToFolder,
    layoutIntegrityDiff,
    layoutFromTree,
    mergePagedRootNodes,
    normalizeLayout,
    orderItemsByLayout,
    rootItemIds,
} from './model.js';
import { createFoldySettingsStore } from './settings-store.js';

const EXTENSION_NAME = 'Foldy';
const LEGACY_LORE_SORT_VALUE = 'foldy';
const LORE_SORT_VALUE = 'foldy-order';
const SETTINGS_KEY = 'foldy';
const CORRUPTED_SETTINGS_LIMIT = 12;

const REGEX_TYPES = {
    global: {
        scriptType: SCRIPT_TYPES.GLOBAL,
        selector: '#saved_regex_scripts',
        label: 'Global',
    },
    scoped: {
        scriptType: SCRIPT_TYPES.SCOPED,
        selector: '#saved_scoped_scripts',
        label: 'Scoped',
    },
    preset: {
        scriptType: SCRIPT_TYPES.PRESET,
        selector: '#saved_preset_scripts',
        label: 'Preset',
    },
};
const REGEX_FOLDER_TARGETS = [
    { key: 'global', label: '전역' },
    { key: 'preset', label: '프리셋' },
    { key: 'scoped', label: '범위 지정' },
];

let applyLorebookFeatureState = () => {};
let queueLoreRender = () => {};
let resetLorePage = () => {};
let installLorebookIntegration = async () => {};
let enhanceRegexLists = () => {};
let installRegexIntegration = async () => {};
let runtimeEventsRegistered = false;
const loreWriteQueues = new Map();
const sessionDisabledFeatures = new Set();
const foldySettingsStore = createFoldySettingsStore({
    extensionSettings: extension_settings,
    settingsKey: SETTINGS_KEY,
    corruptedLimit: CORRUPTED_SETTINGS_LIMIT,
    extensionName: EXTENSION_NAME,
});

function settings() {
    return foldySettingsStore.settings();
}

function revalidateSettings() {
    return foldySettingsStore.revalidateSettings();
}

function debugLog(message, detail = null, level = 'error') {
    const logger = level === 'warn' ? console.warn : console.error;
    logger?.(`[${EXTENSION_NAME}] ${message}`, detail ?? '');
}

async function withErrorToast(label, fn) {
    try {
        return await fn();
    } catch (error) {
        debugLog(label, error);
        toastr.error(`${label} 작업에 실패했습니다.`);
        return undefined;
    }
}
async function installOptionalIntegration({ label, action, debugLog }) {
    try {
        await action();
    } catch (error) {
        debugLog(`${label} 폴더 초기화 실패`, error);
    }
}

function registerFoldyRuntimeEvents({
    eventSource,
    eventTypes,
    settings,
    revalidateSettings,
    saveSettingsDebounced,
    renderPrompts,
    renderRegex,
    syncLorebookRenameMigration,
}) {
    if (runtimeEventsRegistered) return;
    runtimeEventsRegistered = true;

    eventSource.on(eventTypes.PRESET_RENAMED_BEFORE, ({ apiId, oldName, newName }) => {
        revalidateSettings();
        const oldPromptKey = `${apiId}:${oldName}`;
        const newPromptKey = `${apiId}:${newName}`;
        if (settings().layouts.prompts[oldPromptKey] && !settings().layouts.prompts[newPromptKey]) {
            settings().layouts.prompts[newPromptKey] = settings().layouts.prompts[oldPromptKey];
            delete settings().layouts.prompts[oldPromptKey];
            saveSettingsDebounced();
        }
    });
    eventSource.on(eventTypes.PRESET_CHANGED, () => {
        revalidateSettings();
        renderPrompts();
        renderRegex();
    });
    eventSource.on(eventTypes.WORLDINFO_SETTINGS_UPDATED, (...args) => {
        revalidateSettings();
        syncLorebookRenameMigration(...args);
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        revalidateSettings();
        renderRegex();
    });
}

function createToolbarFactory({ withErrorToast }) {
    return function ensureToolbar(parent, key, onCreate, extra = []) {
        if (!parent) return null;
        parent.querySelector(`.foldy-toolbar[data-foldy-toolbar="${key}"]`)?.remove();
        const toolbar = document.createElement('div');
        toolbar.className = 'foldy-toolbar';
        toolbar.dataset.foldyToolbar = key;
        if (onCreate) {
            const create = createLabeledIconButton('fa-folder-plus', '새 폴더', '새 폴더', 'foldy-create-folder');
            bindAction(create, '새 폴더', onCreate, { withErrorToast });
            toolbar.append(create);
        }
        toolbar.append(...extra);
        parent.prepend(toolbar);
        return toolbar;
    };
}

function createSettingsRenderer({
    renderExtensionTemplateAsync,
    settings,
    featureEnabled,
    sessionDisabledFeatures,
    saveSettingsDebounced,
    debugLog,
    withErrorToast,
    requestClearFoldyData,
    renderPrompts,
    renderLore,
    renderRegex,
    applyLorebookFeatureState,
}) {
    return async function renderSettings() {
        if (document.getElementById('foldy_settings')) return;
        const html = await renderExtensionTemplateAsync('third-party/Foldy', 'settings');
        $('#extensions_settings2').append(html);

        const sync = () => {
            $('#foldy_enable_prompts').prop('checked', featureEnabled('prompts'));
            $('#foldy_enable_lorebooks').prop('checked', featureEnabled('lorebooks'));
            $('#foldy_enable_regex').prop('checked', featureEnabled('regex'));
        };
        const rerender = () => {
            renderPrompts();
            renderLore();
            renderRegex();
        };
        $('#foldy_enable_prompts').on('input', function () {
            sessionDisabledFeatures.delete('prompts');
            settings().features.prompts = !!this.checked;
            saveSettingsDebounced();
            rerender();
        });
        $('#foldy_enable_lorebooks').on('input', function () {
            sessionDisabledFeatures.delete('lorebooks');
            settings().features.lorebooks = !!this.checked;
            saveSettingsDebounced();
            applyLorebookFeatureState();
            rerender();
        });
        $('#foldy_enable_regex').on('input', function () {
            sessionDisabledFeatures.delete('regex');
            settings().features.regex = !!this.checked;
            saveSettingsDebounced();
            rerender();
        });
        $('#foldy_clear_prompts').on('click', () => withErrorToast('Clear prompt folder data', async () => {
            await requestClearFoldyData('prompts', '프롬프트');
            rerender();
        }));
        $('#foldy_clear_lorebooks').on('click', () => withErrorToast('Clear lorebook folder data', async () => {
            await requestClearFoldyData('lorebooks', '로어북');
            rerender();
        }));
        $('#foldy_clear_regex').on('click', () => withErrorToast('Clear regex folder data', async () => {
            await requestClearFoldyData('regex', 'Regex');
            rerender();
        }));
        $('#foldy_clear_all').on('click', () => withErrorToast('Clear all folder data', async () => {
            await requestClearFoldyData('all', 'All');
            rerender();
        }));
        sync();
    };
}

function featureEnabled(name) {
    return !sessionDisabledFeatures.has(name) && settings().features[name] !== false;
}

function disableFeatureForCompatibility(name, label, detail) {
    sessionDisabledFeatures.add(name);
    const checkboxIds = {
        prompts: '#foldy_enable_prompts',
        lorebooks: '#foldy_enable_lorebooks',
        regex: '#foldy_enable_regex',
    };
    $(checkboxIds[name] || []).prop('checked', false);
    debugLog(`${label} 호환성 확인 실패`, detail);
    toastr.error(`현재 SillyTavern UI와 호환되지 않아 Foldy가 ${label} 폴더를 비활성화했습니다.`);
}

function ownerCollapsed(kind, owner) {
    const bucket = settings().collapsed[kind];
    return new Set(bucket[owner]);
}

function saveCollapsed(kind, owner, values) {
    const collapsed = [...values];
    if (collapsed.length) {
        settings().collapsed[kind][owner] = collapsed;
    } else {
        delete settings().collapsed[kind][owner];
    }
    saveSettingsDebounced();
}

function promptPresetManager() {
    // Prompt folders track SillyTavern's OpenAI prompt preset manager; regex
    // preset folders use the currently active regex preset API instead.
    return getPresetManager('openai');
}

function foldyOwnerKey(prefix, ...segments) {
    return JSON.stringify([prefix, ...segments].map(value => String(value ?? '')));
}

function legacyFoldyOwnerKey(prefix, ...segments) {
    return [prefix, ...segments].map(value => String(value ?? '')).join(':');
}

function migrateFoldyOwnerKey(layouts, collapsed, prefix, ...segments) {
    const owner = foldyOwnerKey(prefix, ...segments);
    const legacyOwner = legacyFoldyOwnerKey(prefix, ...segments);
    if (owner === legacyOwner) return owner;

    let changed = false;
    if (Object.hasOwn(layouts, legacyOwner) && !Object.hasOwn(layouts, owner)) {
        layouts[owner] = layouts[legacyOwner];
        delete layouts[legacyOwner];
        changed = true;
    }
    if (Object.hasOwn(collapsed, legacyOwner) && !Object.hasOwn(collapsed, owner)) {
        collapsed[owner] = collapsed[legacyOwner];
        delete collapsed[legacyOwner];
        changed = true;
    }
    if (changed) saveSettingsDebounced();
    return owner;
}

function promptOwnerKey() {
    const manager = promptPresetManager();
    const state = settings();
    return migrateFoldyOwnerKey(state.layouts.prompts, state.collapsed.prompt, manager?.apiId || 'openai', manager?.getSelectedPresetName() || '');
}

function promptOwnerKeyForName(name) {
    const manager = promptPresetManager();
    const state = settings();
    return migrateFoldyOwnerKey(state.layouts.prompts, state.collapsed.prompt, manager?.apiId || 'openai', name || '');
}

function promptExportName() {
    return promptPresetManager()?.getSelectedPresetName?.() || 'prompts';
}

function currentPromptPresetSettings(presetName = promptExportName()) {
    const presetManager = promptPresetManager();
    const selectedName = presetManager?.getSelectedPresetName?.();
    if (!presetName || selectedName === presetName) {
        return getChatCompletionPreset(oai_settings);
    }
    return cloneJson(presetManager?.getCompletionPresetByName?.(presetName) || presetManager?.getPresetSettings?.(presetName) || {});
}

function selectedLorebookName() {
    const value = String($('#world_editor_select').find(':selected').val() ?? '');
    if (!/^\d+$/.test(value)) return '';
    return world_names?.[Number(value)] || '';
}

function selectedLorebookOwner() {
    const selected = $('#world_editor_select').find(':selected');
    const value = String(selected.val() ?? '');
    const name = /^\d+$/.test(value) ? world_names?.[Number(value)] || '' : '';
    const owner = lorebookOwnerForName(name);
    return { name, owner };
}

function lorebookOwnerForName(name) {
    const state = settings();
    return migrateFoldyOwnerKey(state.layouts.lorebooks, state.collapsed.lore, 'name', name);
}

function currentLorebookNames() {
    return [...new Set((world_names || []).map(name => String(name || '')).filter(Boolean))];
}

function migrateLorebookOwnerKey(oldOwner, newOwner, { overwrite = false } = {}) {
    if (!oldOwner || !newOwner || oldOwner === newOwner) return false;
    const state = settings();
    let changed = false;

    if (state.layouts.lorebooks[oldOwner] && (!state.layouts.lorebooks[newOwner] || overwrite)) {
        state.layouts.lorebooks[newOwner] = state.layouts.lorebooks[oldOwner];
        delete state.layouts.lorebooks[oldOwner];
        changed = true;
    }
    if (state.collapsed.lore[oldOwner] && (!state.collapsed.lore[newOwner] || overwrite)) {
        state.collapsed.lore[newOwner] = state.collapsed.lore[oldOwner];
        delete state.collapsed.lore[oldOwner];
        changed = true;
    }

    return changed;
}

function migrateLorebookOwner(name, owner) {
    if (!name || !owner || name === owner) return;
    if (migrateLorebookOwnerKey(name, owner)) {
        saveSettingsDebounced();
    }
}

function currentLorebookOwner() {
    const value = selectedLorebookOwner();
    migrateLorebookOwner(value.name, value.owner);
    return value;
}

function syncLorebookRenameMigration() {
    // WORLDINFO_SETTINGS_UPDATED provides names only. A one-name removal and
    // addition is indistinguishable from deleting one lorebook and creating
    // another, so never transfer persisted layout data on that heuristic.
}

const foldyDataCleanup = createFoldyDataCleanup({
    settings,
    getPresetManager,
    currentLorebookNames,
    lorebookOwnerForName,
    promptOwnerKeyForName,
    regexOwnerKey,
    regexOwnerKeyForScopedAvatar: avatar => {
        const state = settings();
        return migrateFoldyOwnerKey(state.layouts.regex.scoped, state.collapsed.regex, 'scoped', avatar || 'none');
    },
    regexOwnerKeyForPresetName: (apiId, name) => {
        const state = settings();
        return migrateFoldyOwnerKey(state.layouts.regex.preset, state.collapsed.regex, 'preset', apiId, name);
    },
    regexTypes: REGEX_TYPES,
    getCharacters: () => characters,
    getWorldNames: () => world_names,
});

const requestClearFoldyData = createClearDataDialog({
    Popup,
    POPUP_RESULT,
    POPUP_TYPE,
    syncLorebookRenameMigration,
    ...foldyDataCleanup,
    saveSettingsDebounced,
});

const {
    downloadJson,
    readJsonFile,
    assertBundle,
    assertPromptBundleShape,
    assertLorebookBundleShape,
    assertRegexBundleShape,
    createBundleButtons,
    createCollapseButtons,
    requestBundleExportMode,
} = createBundleActions({
    Popup,
    POPUP_RESULT,
    POPUP_TYPE,
    debugLog,
    withErrorToast,
    ownerCollapsed,
    saveCollapsed,
    isLoreOriginalDataCompatible,
});

function storedLoreSortValue() {
    const value = accountStorage.getItem(SORT_ORDER_KEY);
    if (value === LEGACY_LORE_SORT_VALUE) {
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
        return LORE_SORT_VALUE;
    }
    return value;
}

function regexOwnerKey(typeKey) {
    if (typeKey === 'global') return 'global';
    if (typeKey === 'scoped') {
        const avatar = characters?.[this_chid]?.avatar;
        const state = settings();
        return migrateFoldyOwnerKey(state.layouts.regex.scoped, state.collapsed.regex, 'scoped', avatar || 'none');
    }
    const apiId = getCurrentPresetAPI?.() || 'openai';
    const manager = getPresetManager(apiId);
    const state = settings();
    return migrateFoldyOwnerKey(state.layouts.regex.preset, state.collapsed.regex, 'preset', manager?.apiId || apiId, manager?.getSelectedPresetName() || getCurrentPresetName?.() || '');
}

function regexExportName(typeKey) {
    if (typeKey === 'global') return 'global';
    if (typeKey === 'scoped') return characters?.[this_chid]?.name || characters?.[this_chid]?.avatar || 'scoped';
    const apiId = getCurrentPresetAPI?.() || 'openai';
    return getPresetManager(apiId)?.getSelectedPresetName?.() || getCurrentPresetName?.() || 'preset';
}

const {
    requestNewFolder,
    requestNewRegexFolder,
    requestFolderSettings,
    requestFlexibleBulkMove,
    createRootBulkMoveButton,
    attachMoveToFolderButton,
} = createFolderDialogs({
    Popup,
    POPUP_RESULT,
    POPUP_TYPE,
    withErrorToast,
    regexFolderTargets: REGEX_FOLDER_TARGETS,
    regexFolderCreateContext,
});

const {
    confirmText,
    confirmFolderDelete,
} = createConfirmDialogs({
    Popup,
    POPUP_RESULT,
    POPUP_TYPE,
});

const ensureToolbar = createToolbarFactory({ withErrorToast });

const renderSettings = createSettingsRenderer({
    renderExtensionTemplateAsync,
    settings,
    featureEnabled,
    sessionDisabledFeatures,
    saveSettingsDebounced,
    debugLog,
    withErrorToast,
    requestClearFoldyData,
    renderPrompts: () => promptManager?.render?.(false),
    renderLore: () => queueLoreRender(),
    renderRegex: () => enhanceRegexLists(),
    applyLorebookFeatureState: () => applyLorebookFeatureState(),
});

function createFolderElement(folder, { kind, owner, collapsed, onEdit, onDelete, onStateToggle, state = null, onBulkMove = null, onCollapseChange = null, extraButtons = [] }) {
    return createFolderElementBase(folder, {
        kind,
        owner,
        collapsed,
        onEdit,
        onDelete,
        onStateToggle,
        state,
        onBulkMove,
        onCollapseChange,
        extraButtons,
        ownerCollapsed,
        saveCollapsed,
        withErrorToast,
    });
}

function regexFolderCreateContext(typeKey) {
    const { owner, layout } = readRegexLayout(typeKey);
    const scriptsById = new Map(getScriptsByType(REGEX_TYPES[typeKey].scriptType)
        .filter(script => script?.id)
        .map(script => [String(script.id), script]));
    const candidates = rootItemIds(layout).map(id => ({
        id,
        label: scriptsById.get(id)?.scriptName || id,
    }));
    return { owner, layout, candidates };
}

function collapseNewFolder(kind, owner, folderId) {
    const collapsed = ownerCollapsed(kind, owner);
    collapsed.add(folderId);
    saveCollapsed(kind, owner, collapsed);
}

function shouldRejectDomLayout(previousLayout, nextLayout, label) {
    const diff = layoutIntegrityDiff(previousLayout, nextLayout);
    if (!diff.ok) {
        debugLog(`${label} DOM 폴더 순서 저장 거부`, {
            reason: 'DOM에서 읽은 폴더 구조에 기존 폴더나 항목이 빠져 있습니다.',
            ...diff,
        });
        toastr.warning('목록이 아직 갱신 중이라 Foldy가 폴더 순서 저장을 건너뛰었습니다. 잠시 후 다시 시도해 주세요.');
        return true;
    }
    return false;
}

function createLoreCollapseButtons() {
    const setAll = async collapsedValue => {
        const { name, owner } = currentLorebookOwner();
        if (!name) return;
        const data = await loadWorldInfo(name);
        const allIds = Object.values(data?.entries || {})
            .filter(value => value && typeof value === 'object')
            .map(value => String(value.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
        const collapsed = ownerCollapsed('lore', owner);
        collapsed.clear();
        if (collapsedValue) {
            for (const folder of layout.folders) collapsed.add(folder.id);
        }
        saveCollapsed('lore', owner, collapsed);
        queueLoreRender();
    };
    const expandAll = createIconButton('fa-folder-open', '모두 펼치기', 'foldy-lore-expand-all');
    const collapseAll = createIconButton('fa-folder', '모두 접기', 'foldy-lore-collapse-all');
    bindAction(collapseAll, '모두 접기', () => setAll(true), { withErrorToast });
    bindAction(expandAll, '모두 펼치기', () => setAll(false), { withErrorToast });
    return [expandAll, collapseAll];
}

function createLoreRootBulkMoveButton() {
    const button = createRootBulkMoveButton(async () => {
        const { name, owner } = currentLorebookOwner();
        if (!name) return;
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;
        const entries = Object.values(data.entries).filter(entry => entry && typeof entry === 'object');
        const allIds = entries.map(entry => String(entry.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
        const labels = new Map(entries.map(entry => [String(entry.uid), loreEntryLabel(entry)]));
        const values = await requestFlexibleBulkMove(layout, null, labels);
        if (!values) return;
        const result = layoutWithItemsMovedToFolder(layout, values.itemIds, values.targetFolderId);
        if (!result.changed) return;
        await persistLoreLayout(owner, result.layout);
        queueLoreRender();
    });
    button.id = 'foldy_lore_root_bulk_move';
    return button;
}

const {
    installPromptIntegration,
    renderPrompts,
} = createPromptIntegration({
    settings,
    saveSettingsDebounced,
    waitUntilCondition,
    getSortableDelay,
    promptManager,
    promptPresetManager,
    promptOwnerKey,
    promptOwnerKeyForName,
    promptExportName,
    currentPromptPresetSettings,
    featureEnabled,
    debugLog,
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertPromptBundleShape,
    confirmText,
    shouldRejectDomLayout,
    ownerCollapsed,
    collapseNewFolder,
    ensureToolbar,
    createRootBulkMoveButton,
    createCollapseButtons,
    createBundleButtons,
    requestFolderSettings,
    confirmFolderDelete,
    requestFlexibleBulkMove,
    requestNewFolder,
    attachMoveToFolderButton,
    createFolderElement,
});
function loreLayoutFromDom(list, sourceLayout, allIds, pageNodeKeys = null) {
    const domNodes = [];
    for (const element of list.children) {
        if (element.classList.contains('foldy-folder')) {
            const id = element.dataset.foldyId;
            const itemIds = [...(element.querySelector('.foldy-folder-items')?.children || [])]
                .map(item => item.getAttribute('uid'))
                .filter(Boolean);
            domNodes.push({ type: 'folder', id, itemIds, preserveItems: element.classList.contains('is-collapsed') });
        } else if (element.hasAttribute('uid')) {
            domNodes.push({ type: 'item', id: element.getAttribute('uid') });
        }
    }
    const nodes = pageNodeKeys ? mergePagedRootNodes(sourceLayout, domNodes, pageNodeKeys) : domNodes;
    return layoutFromTree(nodes, sourceLayout, allIds, {
        onMissingSourceFolders: ids => debugLog('로어북 DOM에 저장된 폴더가 없습니다.', ids, 'warn'),
    });
}

async function persistLoreLayout(owner, layout) {
    settings().layouts.lorebooks[owner] = layout;
    saveSettingsDebounced();
}

async function enqueueLorebookWrite(name, action) {
    const key = String(name || '');
    const previous = loreWriteQueues.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(action);
    loreWriteQueues.set(key, queued);
    queued.finally(() => {
        if (loreWriteQueues.get(key) === queued) loreWriteQueues.delete(key);
    }).catch(() => {});
    return queued;
}

async function createLorebookFolder() {
    if (!featureEnabled('lorebooks')) return;
    const { name, owner } = currentLorebookOwner();
    if (!name) {
        toastr.warning('먼저 로어북을 선택해 주세요.');
        return;
    }

    const data = await loadWorldInfo(name);
    if (!data?.entries) return;
    const allIds = Object.values(data.entries)
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => String(entry.uid));
    const layout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
    const entriesById = new Map(Object.values(data.entries)
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => [String(entry.uid), entry]));
    const candidates = rootItemIds(layout)
        .map(id => entriesById.get(id))
        .filter(Boolean)
        .map(entry => ({ id: String(entry.uid), label: loreEntryLabel(entry) }));
    const values = await requestNewFolder(layout, candidates);
    if (!values) return;

    const result = layoutWithAddedFolder(layout, values.name, values.itemIds);
    collapseNewFolder('lore', owner, result.folder.id);
    await persistLoreLayout(owner, result.layout);

    const sort = document.getElementById('world_info_sort_order');
    if (sort && sort.value !== LORE_SORT_VALUE) {
        sort.value = LORE_SORT_VALUE;
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
    }
    resetLorePage();
    queueLoreRender();
}

function isLoreOriginalDataCompatible(data) {
    return isLoreOriginalDataCompatibleBase(data, { debugLog });
}

const {
    exportLorebookBundle,
    importLorebookBundle,
} = createLorebookBundleActions({
    settings,
    saveSettingsDebounced,
    currentLorebookOwner,
    selectedLorebookName,
    lorebookOwnerForName,
    migrateLorebookOwner,
    persistLoreLayout,
    enqueueLorebookWrite,
    loadWorldInfo,
    saveWorldInfo,
    updateWorldInfoList,
    reloadEditor,
    getWorldNames: () => world_names,
    queueLoreRender: () => queueLoreRender(),
    isLoreFolderSortActive: () => document.getElementById('world_info_sort_order')?.value === LORE_SORT_VALUE,
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertLorebookBundleShape,
    confirmText,
});

async function createLorebookEntryInFolderOrder() {
    if (!featureEnabled('lorebooks')) return;
    const { name, owner } = currentLorebookOwner();
    if (!name) return;
    await enqueueLorebookWrite(name, async () => {
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;
        if (!isLoreOriginalDataCompatible(data)) return;

        const entry = createWorldInfoEntry(name, data);
        if (!entry) return;
        syncLoreOriginalEntry(data, entry);

        const allIds = Object.values(data.entries)
            .filter(value => value && typeof value === 'object')
            .map(value => String(value.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
        const entryId = String(entry.uid);
        layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === entryId));
        for (const folder of layout.folders) {
            folder.items = folder.items.filter(id => id !== entryId);
        }
        layout.root.unshift({ type: 'item', id: entryId });

        await persistLoreLayout(owner, layout);
        await saveWorldInfo(name, data, true);
        resetLorePage();
        queueLoreRender();
    });
}

async function deleteLorebookEntryInFolderOrder(uid) {
    if (!featureEnabled('lorebooks')) return;
    const { name, owner } = currentLorebookOwner();
    if (!name) return;
    await enqueueLorebookWrite(name, async () => {
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;
        if (!isLoreOriginalDataCompatible(data)) return;

        const entryId = String(uid);
        const deleted = await deleteWorldInfoEntry(data, entryId);
        if (!deleted) return;
        deleteWIOriginalDataValue(data, entryId);

        const allIds = Object.values(data.entries)
            .filter(value => value && typeof value === 'object')
            .map(value => String(value.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
        layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === entryId));
        for (const folder of layout.folders) {
            folder.items = folder.items.filter(id => id !== entryId);
        }

        await persistLoreLayout(owner, layout);
        await saveWorldInfo(name, data, true);
        queueLoreRender();
    });
}

async function setLoreFolderEnabled(name, data, layout, folderId, enabled) {
    await enqueueLorebookWrite(name, async () => {
        const freshData = await loadWorldInfo(name);
        if (!freshData?.entries) return;
        if (!isLoreOriginalDataCompatible(freshData)) return;
        const owner = lorebookOwnerForName(name);
        const allIds = Object.values(freshData.entries)
            .filter(entry => entry && typeof entry === 'object')
            .map(entry => String(entry.uid));
        const freshLayout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
        if (!setLoreFolderEntriesEnabled(freshData, freshLayout, folderId, enabled, setWIOriginalDataValue)) return;
        await saveWorldInfo(name, freshData, true);
        queueLoreRender();
    });
}

async function requestLoreFolderStrategy(folder) {
    const form = document.createElement('div');
    form.className = 'foldy-move-form foldy-lore-bulk-setting-form';
    const title = document.createElement('div');
    title.className = 'foldy-edit-title';
    title.textContent = `[${folder.name}] 전략`;
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = '전략';
    const select = document.createElement('select');
    select.className = 'text_pole';
    [
        ['normal', '키워드 활성화'],
        ['constant', '상시 활성화'],
        ['vectorized', '벡터화됨'],
    ].forEach(([value, labelText]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = labelText;
        select.append(option);
    });
    label.append(text, select);
    form.append(title, label);
    const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '적용',
        cancelButton: '취소',
    }).show();
    return result === POPUP_RESULT.AFFIRMATIVE ? select.value : null;
}

async function requestLoreFolderPosition(folder) {
    const form = document.createElement('div');
    form.className = 'foldy-move-form foldy-lore-bulk-setting-form';
    const title = document.createElement('div');
    title.className = 'foldy-edit-title';
    title.textContent = `[${folder.name}] 위치`;
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = '위치';
    const select = document.createElement('select');
    select.className = 'text_pole';
    [
        ['0:', '캐릭터 정의 전'],
        ['1:', '캐릭터 정의 후'],
        ['5:', '↑ EM'],
        ['6:', '↓ EM'],
        ['2:', '작가 노트 전'],
        ['3:', '작가 노트 후'],
        ['4:0', '@D ⚙️'],
        ['4:1', '@D 👤'],
        ['4:2', '@D 🤖'],
        ['7:', '➡️ outlet'],
    ].forEach(([value, labelText]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = labelText;
        select.append(option);
    });
    label.append(text, select);
    form.append(title, label);
    const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '적용',
        cancelButton: '취소',
    }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    const [position, role] = select.value.split(':');
    return {
        position: Number(position),
        role: role === '' ? null : Number(role),
    };
}

function createLoreBulkSettingButtons(name, data, layout, folder, shouldAbort = () => false) {
    const strategy = createIconButton('fa-layer-group', 'Set folder item strategy', 'foldy-lore-bulk-setting');
    bindAction(strategy, 'Set folder item strategy', async () => {
        const value = await requestLoreFolderStrategy(folder);
        if (!value) return;
        if (shouldAbort()) return;
        await enqueueLorebookWrite(name, async () => {
            const freshData = await loadWorldInfo(name);
            if (!freshData?.entries) return;
            if (!isLoreOriginalDataCompatible(freshData)) return;
            const owner = lorebookOwnerForName(name);
            const allIds = Object.values(freshData.entries)
                .filter(entry => entry && typeof entry === 'object')
                .map(entry => String(entry.uid));
            const freshLayout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
            const freshFolder = freshLayout.folders.find(value => value.id === folder.id);
            if (!freshFolder) return;
            for (const id of freshFolder.items) setLoreEntryStrategy(freshData, freshData.entries[id], value, setWIOriginalDataValue);
            await saveWorldInfo(name, freshData, true);
            queueLoreRender();
        });
    }, { withErrorToast });

    const position = createIconButton('fa-location-dot', 'Set folder item position', 'foldy-lore-bulk-setting');
    bindAction(position, 'Set folder item position', async () => {
        const value = await requestLoreFolderPosition(folder);
        if (!value) return;
        if (shouldAbort()) return;
        await enqueueLorebookWrite(name, async () => {
            const freshData = await loadWorldInfo(name);
            if (!freshData?.entries) return;
            if (!isLoreOriginalDataCompatible(freshData)) return;
            const owner = lorebookOwnerForName(name);
            const allIds = Object.values(freshData.entries)
                .filter(entry => entry && typeof entry === 'object')
                .map(entry => String(entry.uid));
            const freshLayout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
            const freshFolder = freshLayout.folders.find(value => value.id === folder.id);
            if (!freshFolder) return;
            for (const id of freshFolder.items) setLoreEntryPosition(freshData, freshData.entries[id], value.position, value.role, setWIOriginalDataValue);
            await saveWorldInfo(name, freshData, true);
            queueLoreRender();
        });
    }, { withErrorToast });
    return [strategy, position];
}

({ applyLorebookFeatureState, installLorebookIntegration, queueLoreRender, resetLorePage } = createLorebookIntegration({
    loreSortValue: LORE_SORT_VALUE,
    sortOrderKey: SORT_ORDER_KEY,
    featureEnabled,
    disableFeatureForCompatibility,
    settings,
    syncLorebookRenameMigration,
    currentLorebookOwner,
    selectedLorebookName,
    ownerCollapsed,
    saveSettingsDebounced,
    persistLoreLayout,
    loadWorldInfo,
    getWorldEntry,
    reloadEditor,
    accountStorage,
    renderTemplateAsync,
    waitUntilCondition,
    bindAction,
    createIconButton,
    createFolderElement,
    createBundleButtons,
    createLoreCollapseButtons,
    createLoreRootBulkMoveButton,
    createLorebookFolder,
    createLorebookEntryInFolderOrder,
    deleteLorebookEntryInFolderOrder,
    setLoreFolderEnabled,
    createLoreBulkSettingButtons,
    requestFolderSettings,
    confirmFolderDelete,
    requestFlexibleBulkMove,
    attachMoveToFolderButton,
    loreLayoutFromDom,
    shouldRejectDomLayout,
    exportLorebookBundle,
    importLorebookBundle,
    storedLoreSortValue,
    withErrorToast,
    getSortableDelay,
    debugLog,
}));

function regexItemIds(typeKey) {
    return getScriptsByType(REGEX_TYPES[typeKey].scriptType).map(script => String(script.id)).filter(Boolean);
}

function readRegexLayout(typeKey) {
    const owner = regexOwnerKey(typeKey);
    const raw = settings().layouts.regex[typeKey][owner];
    return { owner, layout: normalizeLayout(raw, regexItemIds(typeKey)) };
}

async function saveRegexScriptsSafely(scripts, type) {
    await saveRegexScriptsWithLatest(scripts, type, {
        getScriptsByType,
        saveScriptsByType,
    });
}

async function persistRegexLayout(typeKey, owner, layout, reorder = true) {
    settings().layouts.regex[typeKey][owner] = layout;
    saveSettingsDebounced();
    if (!reorder) return;
    const type = REGEX_TYPES[typeKey].scriptType;
    const scripts = getScriptsByType(type);
    const reordered = orderItemsByLayout(layout, scripts);
    await saveRegexScriptsSafely(reordered, type);
}

const {
    exportRegexBundle,
    importRegexBundle,
} = createRegexBundleActions({
    settings,
    saveSettingsDebounced,
    regexTypes: REGEX_TYPES,
    regexOwnerKey,
    regexExportName,
    regexItemIds,
    readRegexLayout,
    persistRegexLayout,
    getScriptsByType,
    saveScriptsByType: saveRegexScriptsSafely,
    getCurrentChatId,
    reloadCurrentChat,
    refreshRegexScripts: () => eventSource.emit(event_types.CHAT_CHANGED),
    enhanceRegexLists: () => enhanceRegexLists(),
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertRegexBundleShape,
    confirmText,
});

({ enhanceRegexLists, installRegexIntegration } = createRegexIntegration({
    regexTypes: REGEX_TYPES,
    scriptTypes: SCRIPT_TYPES,
    featureEnabled,
    disableFeatureForCompatibility,
    ownerCollapsed,
    collapseNewFolder,
    readRegexLayout,
    persistRegexLayout,
    regexOwnerKey,
    regexItemIds,
    getScriptsByType,
    saveScriptsByType: saveRegexScriptsSafely,
    getCurrentChatId,
    reloadCurrentChat,
    saveSettingsDebounced,
    createFolderElement,
    requestFolderSettings,
    confirmFolderDelete,
    requestNewRegexFolder,
    requestFlexibleBulkMove,
    attachMoveToFolderButton,
    createRootBulkMoveButton,
    createCollapseButtons,
    createBundleButtons,
    exportRegexBundle,
    importRegexBundle,
    ensureToolbar,
    shouldRejectDomLayout,
    getSortableDelay,
    allowScopedScripts,
    allowPresetScripts,
    getScopedCharacter: () => characters?.[this_chid],
    getCurrentPresetAPI,
    getCurrentPresetName,
    debugLog,
    waitUntilCondition,
}));

export async function init() {
    settings();
    await renderSettings();
    await Promise.all([
        installOptionalIntegration({ label: 'lorebook', action: installLorebookIntegration, debugLog }),
        installOptionalIntegration({ label: 'regex', action: installRegexIntegration, debugLog }),
    ]);
    registerFoldyRuntimeEvents({
        eventSource,
        eventTypes: event_types,
        settings,
        revalidateSettings,
        saveSettingsDebounced,
        renderPrompts: () => promptManager?.render?.(false),
        renderRegex: () => enhanceRegexLists(),
        syncLorebookRenameMigration,
    });
    try {
        await installPromptIntegration();
    } catch (error) {
        debugLog('프롬프트 폴더 초기화 실패', error);
    }
}
