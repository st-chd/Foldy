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
    createLabeledIconButton,
    createIconButton,
    closeOpenFolderMenus,
    updateFolderCount,
    applyFolderStyleToAll,
    folderStyleValues,
    createFolderElement as createFolderElementBase,
} from './folder-ui.js';
import {
    createConfirmDialogs,
    createFolderDialogs,
} from './folder-dialogs.js';
import { createClearDataDialog, createFoldyDataCleanup } from './clear-data-dialog.js';
import { createPromptBundleActions, createPromptSortables, promptOrderIds } from './prompt-bundles.js';
import {
    createLorebookBundleActions,
    createLorebookIntegration,
    isLoreOriginalDataCompatible as isLoreOriginalDataCompatibleBase,
    detectLorebookRename,
    loreEntryLabel,
    setLoreEntryPosition,
    setLoreEntryStrategy,
    setLoreFolderEntriesEnabled,
    syncLoreOriginalEntry,
} from './lorebook-integration.js';
import { createRegexBundleActions, createRegexIntegration } from './regex-integration.js';
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
    addFolderWithItems,
    flattenLayout,
    layoutIntegrityDiff,
    layoutFromTree,
    moveItemsToFolder,
    normalizeLayout,
    orderItemsByLayout,
    removeFolder,
    rootItemIds,
} from './model.js';
import { createFoldySettingsStore } from './settings-store.js';

const EXTENSION_NAME = 'Foldy';
const LORE_SORT_VALUE = 'foldy';
const SETTINGS_KEY = 'foldy';
const CORRUPTED_SETTINGS_LIMIT = 12;

const REGEX_TYPES = {
    global: {
        scriptType: SCRIPT_TYPES.GLOBAL,
        selector: '#saved_regex_scripts',
        label: '글로벌',
    },
    scoped: {
        scriptType: SCRIPT_TYPES.SCOPED,
        selector: '#saved_scoped_scripts',
        label: '스코프',
    },
    preset: {
        scriptType: SCRIPT_TYPES.PRESET,
        selector: '#saved_preset_scripts',
        label: '프리셋',
    },
};
const REGEX_FOLDER_TARGETS = [
    { key: 'global', label: '글로벌' },
    { key: 'preset', label: '프리셋' },
    { key: 'scoped', label: '스코프' },
];

let currentPromptLayout = null;
let handlingLoreAction = false;
let lorebookNamesSnapshot = null;
let applyLorebookFeatureState = () => {};
let queueLoreRender = () => {};
let installLorebookIntegration = async () => {};
let enhanceRegexLists = () => {};
let installRegexIntegration = async () => {};
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

function debugLog(message, detail = null) {
    console.error?.(`[${EXTENSION_NAME}] ${message}`, detail ?? '');
}

async function withErrorToast(label, fn) {
    try {
        return await fn();
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] ${label}`, error);
        debugLog(label, error);
        toastr.error(`${label} 실패`);
        return undefined;
    }
}

async function installOptionalIntegration({ label, action, extensionName, debugLog }) {
    try {
        await action();
    } catch (error) {
        console.error(`[${extensionName}] Failed to initialize ${label} folders`, error);
        debugLog(`${label} folder initialization failed`, error);
    }
}

function registerFoldyRuntimeEvents({
    eventSource,
    eventTypes,
    settings,
    saveSettingsDebounced,
    renderPrompts,
    renderRegex,
    syncLorebookRenameMigration,
}) {
    eventSource.on(eventTypes.PRESET_RENAMED_BEFORE, ({ apiId, oldName, newName }) => {
        const oldPromptKey = `${apiId}:${oldName}`;
        const newPromptKey = `${apiId}:${newName}`;
        if (settings().layouts.prompts[oldPromptKey] && !settings().layouts.prompts[newPromptKey]) {
            settings().layouts.prompts[newPromptKey] = settings().layouts.prompts[oldPromptKey];
            delete settings().layouts.prompts[oldPromptKey];
            saveSettingsDebounced();
        }
    });
    eventSource.on(eventTypes.PRESET_CHANGED, () => {
        renderPrompts();
        renderRegex();
    });
    eventSource.on(eventTypes.WORLDINFO_SETTINGS_UPDATED, syncLorebookRenameMigration);
    eventSource.on(eventTypes.CHAT_CHANGED, renderRegex);
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
            create.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                withErrorToast('새 폴더', onCreate);
            });
            toolbar.append(create);
        }
        toolbar.append(...extra);
        parent.prepend(toolbar);
        return toolbar;
    };
}

function setPromptToolbarSummary(toolbar, layout, visibleItemIds = null) {
    if (!toolbar || !layout) return;
    const summary = document.createElement('span');
    summary.className = 'foldy-toolbar-summary';
    const folderCount = layout.folders?.length || 0;
    const unfiledCount = rootItemIds(layout).filter(id => !visibleItemIds || visibleItemIds.has(String(id))).length;
    summary.textContent = '폴더 ' + folderCount + ' / 미분류 ' + unfiledCount;
    summary.title = '폴더: ' + folderCount + ', 미분류 항목: ' + unfiledCount;
    toolbar.prepend(summary);
}

function placePromptToolbar(toolbar, rangeBlock) {
    if (!toolbar || !rangeBlock) return;
    const list = rangeBlock.querySelector('#completion_prompt_manager_list');
    if (list) rangeBlock.insertBefore(toolbar, list);
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
        $('#foldy_clear_prompts').on('click', () => withErrorToast('프롬프트 폴더 데이터 삭제', async () => {
            await requestClearFoldyData('prompts', '프롬프트');
            rerender();
        }));
        $('#foldy_clear_lorebooks').on('click', () => withErrorToast('로어북 폴더 데이터 삭제', async () => {
            await requestClearFoldyData('lorebooks', '로어북');
            rerender();
        }));
        $('#foldy_clear_regex').on('click', () => withErrorToast('정규식 폴더 데이터 삭제', async () => {
            await requestClearFoldyData('regex', '정규식');
            rerender();
        }));
        $('#foldy_clear_all').on('click', () => withErrorToast('전체 폴더 데이터 삭제', async () => {
            await requestClearFoldyData('all', '전체');
            rerender();
        }));
        sync();
    };
}

function createPromptInstaller({
    waitUntilCondition,
    promptManager,
    promptPresetManager,
    settings,
    featureEnabled,
    saveSettingsDebounced,
    debugLog,
    extensionName,
    enhancePromptList,
    setupPromptSortables,
}) {
    let originalRenderItems = null;
    let originalMakeDraggable = null;

    return async function installPromptIntegration() {
        await waitUntilCondition(() => promptManager && promptPresetManager(), 30000, 100);
        const manager = promptManager;
        if (typeof manager.renderPromptManagerListItems !== 'function' || typeof manager.makeDraggable !== 'function') {
            settings().features.prompts = false;
            saveSettingsDebounced();
            debugLog('Prompt folder initialization API is missing', {
                renderPromptManagerListItems: typeof manager.renderPromptManagerListItems,
                makeDraggable: typeof manager.makeDraggable,
            });
            toastr.error('현재 SillyTavern 버전과 호환되지 않아 프롬프트 폴더를 비활성화했습니다.');
            return;
        }
        if (!originalRenderItems) originalRenderItems = manager.renderPromptManagerListItems.bind(manager);
        if (!originalMakeDraggable) originalMakeDraggable = manager.makeDraggable.bind(manager);
        if (manager.__foldyInstalled) return;
        manager.__foldyInstalled = true;

        manager.renderPromptManagerListItems = async function (...args) {
            await originalRenderItems.apply(this, args);
            if (!featureEnabled('prompts')) return;
            try {
                await enhancePromptList(manager);
            } catch (error) {
                console.error(`[${extensionName}] Failed to enhance prompt folders`, error);
                debugLog('Prompt folder rendering failed', error);
                toastr.error('프롬프트 폴더를 표시하지 못해 원래 프롬프트 목록으로 되돌렸습니다.');
                await originalRenderItems.apply(this, args);
            }
        };
        manager.makeDraggable = function (...args) {
            const result = originalMakeDraggable.apply(this, args);
            if (featureEnabled('prompts')) {
                try {
                    setupPromptSortables(manager);
                } catch (error) {
                    console.error(`[${extensionName}] Failed to initialize prompt folder sorting`, error);
                    debugLog('Prompt folder sorting initialization failed', error);
                }
            }
            return result;
        };
        manager.render(false);
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
    debugLog(label + ' compatibility check failed', detail);
    toastr.error(`현재 SillyTavern UI와 호환되지 않아 ${label} 폴더를 비활성화했습니다.`);
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

function promptOwnerKey() {
    const manager = promptPresetManager();
    // Prefix is load-bearing: owner keys must not be raw user names, both to
    // avoid cross-domain collisions and prototype-shaped object keys.
    return `${manager?.apiId || 'openai'}:${manager?.getSelectedPresetName() || ''}`;
}

function promptOwnerKeyForName(name) {
    const manager = promptPresetManager();
    // Prefix is load-bearing: owner keys must not be raw user names, both to
    // avoid cross-domain collisions and prototype-shaped object keys.
    return `${manager?.apiId || 'openai'}:${name || ''}`;
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
    const owner = `name:${name}`;
    return { name, owner };
}

function lorebookOwnerForName(name) {
    // Prefix is load-bearing: owner keys must not be raw user names, both to
    // avoid cross-domain collisions and prototype-shaped object keys.
    return `name:${name}`;
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

function syncLorebookRenameMigration({ rerender = true } = {}) {
    const previous = lorebookNamesSnapshot;
    const next = currentLorebookNames();
    lorebookNamesSnapshot = next;

    const rename = detectLorebookRename(previous, next);
    if (!rename) return;

    const oldOwner = lorebookOwnerForName(rename.oldName);
    const newOwner = lorebookOwnerForName(rename.newName);
    if (migrateLorebookOwnerKey(oldOwner, newOwner, { overwrite: true })) {
        saveSettingsDebounced();
        if (rerender) queueLoreRender();
    }
}

const foldyDataCleanup = createFoldyDataCleanup({
    settings,
    getPresetManager,
    currentLorebookNames,
    lorebookOwnerForName,
    regexOwnerKey,
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
    extensionName: EXTENSION_NAME,
    debugLog,
    withErrorToast,
    ownerCollapsed,
    saveCollapsed,
    isLoreOriginalDataCompatible,
});

function storedLoreSortValue() {
    return accountStorage.getItem(SORT_ORDER_KEY);
}

function regexOwnerKey(typeKey) {
    if (typeKey === 'global') return 'global';
    if (typeKey === 'scoped') {
        const avatar = characters?.[this_chid]?.avatar;
        // Prefix is load-bearing: owner keys must not be raw user names, both to
        // avoid cross-domain collisions and prototype-shaped object keys.
        return avatar ? `scoped:${avatar}` : 'scoped:none';
    }
    const apiId = getCurrentPresetAPI?.() || 'openai';
    const manager = getPresetManager(apiId);
    // Prefix is load-bearing: owner keys must not be raw user names, both to
    // avoid cross-domain collisions and prototype-shaped object keys.
    return `preset:${manager?.apiId || apiId}:${manager?.getSelectedPresetName() || getCurrentPresetName?.() || ''}`;
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

function createFolderElement(folder, { kind, owner, collapsed, onEdit, onDelete, onStateToggle, state = null, onBulkMove = null, extraButtons = [] }) {
    return createFolderElementBase(folder, {
        kind,
        owner,
        collapsed,
        onEdit,
        onDelete,
        onStateToggle,
        state,
        onBulkMove,
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
        debugLog(label + ' DOM layout save was rejected', {
            reason: 'The layout read from the DOM lost existing folders or items.',
            ...diff,
        });
        toastr.warning('목록이 아직 갱신 중이라 폴더 순서 저장을 건너뛰었습니다. 잠시 후 다시 시도해 주세요.');
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
    const expandAll = createIconButton('fa-folder-open', '전체 펼치기', 'foldy-lore-expand-all');
    const collapseAll = createIconButton('fa-folder', '전체 접기', 'foldy-lore-collapse-all');
    collapseAll.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        withErrorToast('전체 접기', () => setAll(true));
    });
    expandAll.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        withErrorToast('전체 펼치기', () => setAll(false));
    });
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
        if (!moveItemsToFolder(layout, values.itemIds, values.targetFolderId)) return;
        await persistLoreLayout(owner, layout);
        queueLoreRender();
    });
    button.id = 'foldy_lore_root_bulk_move';
    return button;
}

function readPromptLayout(manager = promptManager, normalizeOptions = {}) {
    const owner = promptOwnerKey();
    const raw = settings().layouts.prompts[owner];
    return { owner, layout: normalizeLayout(raw, promptOrderIds(manager), normalizeOptions) };
}

async function persistPromptLayout(owner, layout, manager = promptManager) {
    const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    const byId = new Map(order.map(entry => [String(entry.identifier), entry]));
    const flattened = flattenLayout(layout);
    order.splice(0, order.length, ...flattened.map(identifier => byId.get(identifier)).filter(Boolean));
    settings().layouts.prompts[owner] = layout;
    currentPromptLayout = layout;
    saveSettingsDebounced();
    await manager.saveServiceSettings();
}

const {
    exportPromptBundle,
    importPromptBundle,
} = createPromptBundleActions({
    settings,
    saveSettingsDebounced,
    waitUntilCondition,
    promptOwnerKey,
    promptOwnerKeyForName,
    promptExportName,
    promptPresetManager,
    currentPromptPresetSettings,
    readPromptLayout,
    persistPromptLayout,
    getCurrentPromptLayout: () => currentPromptLayout,
    setCurrentPromptLayout: layout => { currentPromptLayout = layout; },
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertPromptBundleShape,
    confirmText,
});

const { setupPromptSortables } = createPromptSortables({
    getSortableDelay,
    promptOwnerKey,
    getCurrentPromptLayout: () => currentPromptLayout,
    setCurrentPromptLayout: layout => { currentPromptLayout = layout; },
    persistPromptLayout,
    shouldRejectDomLayout,
    debugLog,
    extensionName: EXTENSION_NAME,
});

async function enhancePromptList(manager) {
    const list = manager.listElement;
    if (!list || !featureEnabled('prompts')) return;
    const { owner, layout } = readPromptLayout(manager);
    currentPromptLayout = layout;
    list.classList.add('foldy-prompt-root');

    closeOpenFolderMenus(list);
    const itemMap = new Map([...list.querySelectorAll('[data-pm-identifier]')].map(element => [element.dataset.pmIdentifier, element]));
    const visiblePromptIds = new Set(itemMap.keys());
    itemMap.forEach(element => element.remove());
    const collapsed = ownerCollapsed('prompt', owner);
    const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));

    const rerender = () => manager.render(false);
    const promptContextChanged = activeLayout => activeLayout !== currentPromptLayout || promptOwnerKey() !== owner;
    const rerenderIfPromptContextChanged = activeLayout => {
        if (!promptContextChanged(activeLayout)) return false;
        rerender();
        return true;
    };
    const onEdit = async id => {
        const activeLayout = currentPromptLayout;
        const folder = activeLayout.folders.find(value => value.id === id);
        if (!folder) return;
        const values = await requestFolderSettings(activeLayout, folder);
        if (!values) return;
        if (rerenderIfPromptContextChanged(activeLayout)) return;
        if (values.applyStyleToAll) applyFolderStyleToAll(activeLayout, folder.id, values);
        delete values.applyStyleToAll;
        Object.assign(folder, values);
        await persistPromptLayout(owner, activeLayout, manager);
        rerender();
    };
    const onDelete = async id => {
        const activeLayout = currentPromptLayout;
        const folder = activeLayout.folders.find(value => value.id === id);
        if (!folder || !await confirmFolderDelete(folder.name, '프롬프트 항목은')) return;
        if (rerenderIfPromptContextChanged(activeLayout)) return;
        const removedLayout = removeFolder(activeLayout, id);
        const nextLayout = normalizeLayout(removedLayout, promptOrderIds(manager), { preserveUnrootedFolders: false });
        await persistPromptLayout(owner, nextLayout, manager);
        rerender();
    };

    for (const node of layout.root) {
        if (node.type === 'item') {
            const item = itemMap.get(node.id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'prompt',
                    layout: currentPromptLayout,
                    itemId: node.id,
                    onMove: async movedLayout => {
                        if (promptOwnerKey() !== owner) {
                            rerender();
                            return;
                        }
                        currentPromptLayout = movedLayout;
                        await persistPromptLayout(owner, movedLayout, manager);
                        rerender();
                    },
                });
                list.append(item);
            }
            continue;
        }
        const folder = folderMap.get(node.id);
        if (!folder) continue;
        const folderElement = createFolderElement(folder, {
            kind: 'prompt',
            owner,
            collapsed,
            onEdit,
            onDelete,
            onBulkMove: async id => {
                const activeLayout = currentPromptLayout;
                const labels = new Map([...itemMap.entries()].map(([itemId, element]) => [
                    String(itemId),
                    element.querySelector('.completion_prompt_manager_prompt_name')?.textContent?.trim() || String(itemId),
                ]));
                const values = await requestFlexibleBulkMove(activeLayout, id, labels);
                if (!values) return;
                if (rerenderIfPromptContextChanged(activeLayout)) return;
                if (!moveItemsToFolder(activeLayout, values.itemIds, values.targetFolderId)) return;
                await persistPromptLayout(owner, activeLayout, manager);
                rerender();
            },
        });
        const items = folderElement.querySelector('.foldy-folder-items');
        folder.items.forEach(id => {
            const item = itemMap.get(id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'prompt',
                    layout: currentPromptLayout,
                    itemId: id,
                    onMove: async movedLayout => {
                        if (promptOwnerKey() !== owner) {
                            rerender();
                            return;
                        }
                        currentPromptLayout = movedLayout;
                        await persistPromptLayout(owner, movedLayout, manager);
                        rerender();
                    },
                });
                items.append(item);
            }
        });
        updateFolderCount(folderElement);
        list.append(folderElement);
    }

    const rangeBlock = list.closest('.range-block');
    const toolbar = ensureToolbar(rangeBlock, 'prompt', async () => {
        const activeLayout = currentPromptLayout;
        const promptsById = new Map((manager.serviceSettings.prompts || [])
            .filter(prompt => prompt?.identifier)
            .map(prompt => [String(prompt.identifier), prompt]));
        const candidates = rootItemIds(activeLayout)
            .filter(id => visiblePromptIds.has(String(id)))
            .map(id => ({
                id,
                label: promptsById.get(id)?.name || id,
            }));
        const values = await requestNewFolder(activeLayout, candidates);
        if (!values) return;
        if (rerenderIfPromptContextChanged(activeLayout)) return;
        const folder = addFolderWithItems(activeLayout, values.name, values.itemIds);
        collapseNewFolder('prompt', owner, folder.id);
        await persistPromptLayout(owner, activeLayout, manager);
        rerender();
    }, [
        createRootBulkMoveButton(async () => {
            const activeLayout = currentPromptLayout;
            const labels = new Map([...itemMap.entries()].map(([itemId, element]) => [
                String(itemId),
                element.querySelector('.completion_prompt_manager_prompt_name')?.textContent?.trim() || String(itemId),
            ]));
            const values = await requestFlexibleBulkMove(activeLayout, null, labels);
            if (!values) return;
            if (rerenderIfPromptContextChanged(activeLayout)) return;
            if (!moveItemsToFolder(activeLayout, values.itemIds, values.targetFolderId)) return;
            await persistPromptLayout(owner, activeLayout, manager);
            rerender();
        }),
        ...createCollapseButtons('prompt', owner, () => currentPromptLayout, async () => rerender()),
        ...createBundleButtons(() => exportPromptBundle(manager), () => importPromptBundle(manager)),
    ]);
    setPromptToolbarSummary(toolbar, currentPromptLayout, visiblePromptIds);
    placePromptToolbar(toolbar, rangeBlock);
}

const installPromptIntegration = createPromptInstaller({
    waitUntilCondition,
    promptManager,
    promptPresetManager,
    settings,
    featureEnabled,
    saveSettingsDebounced,
    debugLog,
    extensionName: EXTENSION_NAME,
    enhancePromptList,
    setupPromptSortables,
});

function loreLayoutFromDom(list, sourceLayout, allIds) {
    const nodes = [];
    for (const element of list.children) {
        if (element.classList.contains('foldy-folder')) {
            const id = element.dataset.foldyId;
            const itemIds = [...(element.querySelector('.foldy-folder-items')?.children || [])]
                .map(item => item.getAttribute('uid'))
                .filter(Boolean);
            nodes.push({ type: 'folder', id, itemIds, preserveItems: element.classList.contains('is-collapsed') });
        } else if (element.hasAttribute('uid')) {
            nodes.push({ type: 'item', id: element.getAttribute('uid') });
        }
    }
    return layoutFromTree(nodes, sourceLayout, allIds);
}

async function persistLoreLayout(owner, layout) {
    settings().layouts.lorebooks[owner] = layout;
    saveSettingsDebounced();
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

    const folder = addFolderWithItems(layout, values.name, values.itemIds);
    collapseNewFolder('lore', owner, folder.id);
    await persistLoreLayout(owner, layout);

    const sort = document.getElementById('world_info_sort_order');
    if (sort && sort.value !== LORE_SORT_VALUE) {
        sort.value = LORE_SORT_VALUE;
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
    }
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
    if (handlingLoreAction) return;
    if (!featureEnabled('lorebooks')) return;
    handlingLoreAction = true;
    try {
        const { name, owner } = currentLorebookOwner();
        if (!name) return;
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
        queueLoreRender();
    } finally {
        handlingLoreAction = false;
    }
}

async function deleteLorebookEntryInFolderOrder(uid) {
    if (handlingLoreAction) return;
    if (!featureEnabled('lorebooks')) return;
    handlingLoreAction = true;
    try {
        const { name, owner } = currentLorebookOwner();
        if (!name) return;
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
    } finally {
        handlingLoreAction = false;
    }
}

async function setLoreFolderEnabled(name, data, layout, folderId, enabled) {
    if (!isLoreOriginalDataCompatible(data)) return;
    if (!setLoreFolderEntriesEnabled(data, layout, folderId, enabled, setWIOriginalDataValue)) return;
    await saveWorldInfo(name, data, true);
    queueLoreRender();
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
        ['normal', '🟢키워드 활성화'],
        ['constant', '🔵상시 활성화'],
        ['vectorized', '🔗벡터화'],
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
        ['7:', '➡️ Outlet'],
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
    const strategy = createIconButton('fa-layer-group', '폴더 항목 전략 일괄 설정', 'foldy-lore-bulk-setting');
    strategy.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await withErrorToast('폴더 항목 전략 일괄 설정', async () => {
            const value = await requestLoreFolderStrategy(folder);
            if (!value) return;
            if (shouldAbort()) return;
            if (!isLoreOriginalDataCompatible(data)) return;
            for (const id of folder.items) setLoreEntryStrategy(data, data.entries[id], value, setWIOriginalDataValue);
            await saveWorldInfo(name, data, true);
            queueLoreRender();
        });
    });

    const position = createIconButton('fa-location-dot', '폴더 항목 위치 일괄 설정', 'foldy-lore-bulk-setting');
    position.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await withErrorToast('폴더 항목 위치 일괄 설정', async () => {
            const value = await requestLoreFolderPosition(folder);
            if (!value) return;
            if (shouldAbort()) return;
            if (!isLoreOriginalDataCompatible(data)) return;
            for (const id of folder.items) setLoreEntryPosition(data, data.entries[id], value.position, value.role, setWIOriginalDataValue);
            await saveWorldInfo(name, data, true);
            queueLoreRender();
        });
    });
    return [strategy, position];
}

({ applyLorebookFeatureState, installLorebookIntegration, queueLoreRender } = createLorebookIntegration({
    extensionName: EXTENSION_NAME,
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

async function persistRegexLayout(typeKey, owner, layout, reorder = true) {
    settings().layouts.regex[typeKey][owner] = layout;
    saveSettingsDebounced();
    if (!reorder) return;
    const type = REGEX_TYPES[typeKey].scriptType;
    const scripts = getScriptsByType(type);
    const reordered = orderItemsByLayout(layout, scripts);
    await saveScriptsByType(reordered, type);
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
    saveScriptsByType,
    getCurrentChatId,
    reloadCurrentChat,
    enhanceRegexLists: () => enhanceRegexLists(),
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertRegexBundleShape,
    confirmText,
});

({ enhanceRegexLists, installRegexIntegration } = createRegexIntegration({
    extensionName: EXTENSION_NAME,
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
    saveScriptsByType,
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
    lorebookNamesSnapshot = currentLorebookNames();
    await renderSettings();
    await Promise.all([
        installOptionalIntegration({ label: 'lorebook', action: installLorebookIntegration, extensionName: EXTENSION_NAME, debugLog }),
        installOptionalIntegration({ label: 'regex', action: installRegexIntegration, extensionName: EXTENSION_NAME, debugLog }),
    ]);
    registerFoldyRuntimeEvents({
        eventSource,
        eventTypes: event_types,
        settings,
        saveSettingsDebounced,
        renderPrompts: () => promptManager?.render?.(false),
        renderRegex: () => enhanceRegexLists(),
        syncLorebookRenameMigration,
    });
    try {
        await installPromptIntegration();
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to initialize prompt folders`, error);
        debugLog('Prompt folder initialization failed', error);
    }
}
