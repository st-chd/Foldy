import { characters, eventSource, event_types, getCurrentChatId, reloadCurrentChat, saveSettingsDebounced, this_chid } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { getPresetManager } from '../../../preset-manager.js';
import { renderTemplateAsync } from '../../../templates.js';
import { getSortableDelay, initScrollHeight, waitUntilCondition } from '../../../utils.js';
import { accountStorage } from '../../../util/AccountStorage.js';
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
    getScriptsByType,
    saveScriptsByType,
    SCRIPT_TYPES,
} from '../../regex/engine.js';
import {
    FOLDERIZER_VERSION,
    flattenLayout,
    generateUUID,
    hasDuplicateFolderName,
    normalizeLayout,
    removeFolder,
} from './model.js';

const EXTENSION_NAME = 'Folderizer';
const LORE_SORT_VALUE = 'folderizer';
const DEFAULT_PICKER_COLOR = '#7c6ee6';
const BUNDLE_KIND = 'folderizer-bundle';
const BUNDLE_VERSION = 1;
const DEBUG_LOG_LIMIT = 200;

const REGEX_TYPES = {
    global: {
        scriptType: SCRIPT_TYPES.GLOBAL,
        selector: '#saved_regex_scripts',
        label: '글로벌',
    },
    scoped: {
        scriptType: SCRIPT_TYPES.SCOPED,
        selector: '#saved_scoped_scripts',
        label: '범위',
    },
    preset: {
        scriptType: SCRIPT_TYPES.PRESET,
        selector: '#saved_preset_scripts',
        label: '프리셋',
    },
};

let currentPromptLayout = null;
let renderingLorebook = false;
let loreRenderQueued = false;
let loreRenderRequestedAfterRender = false;
let loreObserver = null;
let handlingLoreAction = false;
let regexObserver = null;
let enhancingRegex = false;
let sortingPrompt = false;
let sortingLore = false;
let sortingRegex = false;
let originalPromptRenderItems = null;
let originalPromptMakeDraggable = null;
let debugListenersInstalled = false;
const debugLogEntries = [];

function settings() {
    extension_settings.folderizer ??= {};
    const value = extension_settings.folderizer;
    value.features ??= { prompts: true, lorebooks: true, regex: true };
    value.features.prompts ??= true;
    value.features.lorebooks ??= true;
    value.features.regex ??= true;
    value.layouts ??= {};
    value.layouts.prompts ??= {};
    value.layouts.lorebooks ??= {};
    value.layouts.regex ??= {};
    value.layouts.regex.global ??= {};
    value.layouts.regex.scoped ??= {};
    value.layouts.regex.preset ??= {};
    value.collapsed ??= {};
    value.collapsed.prompt ??= {};
    value.collapsed.lore ??= {};
    value.collapsed.regex ??= {};
    value.debug ??= false;
    return value;
}

function debugEnabled() {
    return settings().debug === true;
}

function formatDebugDetail(detail) {
    if (detail instanceof Error) return `${detail.name}: ${detail.message}\n${detail.stack || ''}`.trim();
    if (typeof detail === 'string') return detail;
    try {
        return JSON.stringify(detail, null, 2);
    } catch {
        return String(detail);
    }
}

function debugLog(level, message, detail = null) {
    if (!debugEnabled() && level !== 'error') return;
    debugLogEntries.push({
        time: new Date().toLocaleString(),
        level,
        message,
        detail: detail == null ? '' : formatDebugDetail(detail),
    });
    if (debugLogEntries.length > DEBUG_LOG_LIMIT) debugLogEntries.splice(0, debugLogEntries.length - DEBUG_LOG_LIMIT);
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'debug';
    console[method]?.(`[${EXTENSION_NAME}] ${message}`, detail ?? '');
}

function debugText() {
    const state = settings();
    const header = [
        `Folderizer ${state.debug ? 'debug on' : 'debug off'}`,
        `time: ${new Date().toLocaleString()}`,
        `features: prompts=${featureEnabled('prompts')}, lorebooks=${featureEnabled('lorebooks')}, regex=${featureEnabled('regex')}`,
        'userAgent:',
        navigator.userAgent,
    ].join('\n');
    if (!debugLogEntries.length) return `${header}\n\n아직 기록된 Folderizer 디버그 로그가 없습니다.`;
    const body = debugLogEntries.map(entry => {
        const detail = entry.detail ? `\n${entry.detail}` : '';
        return `[${entry.time}] [${entry.level.toUpperCase()}] ${entry.message}${detail}`;
    }).join('\n\n');
    return `${header}\n\n${body}`;
}

async function copyDebugLog() {
    const text = debugText();
    try {
        await navigator.clipboard.writeText(text);
        toastr.success('Folderizer 디버그 로그를 복사했습니다.');
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to copy debug log`, error);
        const area = document.createElement('textarea');
        area.className = 'folderizer-debug-copy';
        area.value = text;
        await new Popup(area, POPUP_TYPE.TEXT, 'Folderizer 디버그 로그').show();
    }
}

async function showDebugLog() {
    const wrap = document.createElement('div');
    wrap.className = 'folderizer-debug-view';
    const pre = document.createElement('pre');
    pre.textContent = debugText();
    wrap.append(pre);
    await new Popup(wrap, POPUP_TYPE.TEXT, 'Folderizer 디버그 로그', {
        wide: true,
        large: true,
    }).show();
}

function installDebugListeners() {
    if (debugListenersInstalled) return;
    debugListenersInstalled = true;
    window.addEventListener('error', event => {
        if (!debugEnabled()) return;
        debugLog('error', '브라우저 오류', {
            message: event.message,
            source: event.filename,
            line: event.lineno,
            column: event.colno,
            error: event.error?.stack || event.error?.message || '',
        });
    });
    window.addEventListener('unhandledrejection', event => {
        if (!debugEnabled()) return;
        debugLog('error', '처리되지 않은 Promise 오류', event.reason);
    });
}

function featureEnabled(name) {
    return settings().features[name] !== false;
}

function ownerCollapsed(kind, owner) {
    const bucket = settings().collapsed[kind];
    bucket[owner] ??= [];
    return new Set(bucket[owner]);
}

function saveCollapsed(kind, owner, values) {
    settings().collapsed[kind][owner] = [...values];
    saveSettingsDebounced();
}

function promptPresetManager() {
    return getPresetManager('openai');
}

function promptOwnerKey() {
    const manager = promptPresetManager();
    return `${manager?.apiId || 'openai'}:${manager?.getSelectedPresetName() || ''}`;
}

function promptOwnerKeyForName(name) {
    const manager = promptPresetManager();
    return `${manager?.apiId || 'openai'}:${name || ''}`;
}

function promptExportName() {
    return promptPresetManager()?.getSelectedPresetName?.() || 'prompts';
}

function promptBundlePresetName(bundle) {
    if (bundle?.presetName) return String(bundle.presetName);
    const owner = String(bundle?.owner || '');
    const index = owner.indexOf(':');
    return index >= 0 ? owner.slice(index + 1) : owner;
}

function selectedLorebookName() {
    const value = String($('#world_editor_select').find(':selected').val() ?? '');
    return world_names?.[value] || String($('#world_editor_select').find(':selected').text() ?? '').trim();
}

function regexOwnerKey(typeKey) {
    if (typeKey === 'global') return 'global';
    if (typeKey === 'scoped') {
        const avatar = characters?.[this_chid]?.avatar;
        return avatar ? `scoped:${avatar}` : 'scoped:none';
    }
    const manager = getPresetManager();
    return `preset:${manager?.apiId || 'unknown'}:${manager?.getSelectedPresetName() || ''}`;
}

function regexExportName(typeKey) {
    if (typeKey === 'global') return 'global';
    if (typeKey === 'scoped') return characters?.[this_chid]?.name || characters?.[this_chid]?.avatar || 'scoped';
    return getPresetManager()?.getSelectedPresetName?.() || 'preset';
}

function createIconButton(icon, title, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button fa-solid ${icon} ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
}

function createIconCodeButton(code, title, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button fa-solid folderizer-code-icon ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = String.fromCodePoint(parseInt(code, 16));
    return button;
}

function createLabeledIconButton(icon, title, label, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button folderizer-labeled-button ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    const iconElement = document.createElement('span');
    iconElement.className = `fa-solid ${icon}`;
    const labelElement = document.createElement('span');
    labelElement.textContent = label;
    button.append(iconElement, labelElement);
    return button;
}

function isHexColor(value) {
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value ?? '').trim());
}

function isColorValue(value) {
    const color = String(value ?? '').trim();
    return color.toLowerCase() === 'transparent'
        || isHexColor(color)
        || globalThis.CSS?.supports?.('color', color)
        || false;
}

function normalizeColor(value, fallback = '') {
    const color = String(value ?? '').trim();
    if (!color) return fallback;
    if (color.toLowerCase() === 'transparent') return 'transparent';
    if (isHexColor(color) && (color.length === 4 || color.length === 5)) {
        return `#${[...color.slice(1)].map(part => `${part}${part}`).join('')}`.toLowerCase();
    }
    if (isHexColor(color)) return color.toLowerCase();
    return globalThis.CSS?.supports?.('color', color) ? color : fallback;
}

function pickerColor(value, fallback = DEFAULT_PICKER_COLOR) {
    const color = normalizeColor(value, fallback);
    return color === 'transparent' ? 'rgba(0, 0, 0, 0)' : color;
}

function cssColorToHex(value, fallback = DEFAULT_PICKER_COLOR) {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    try {
        const color = getComputedStyle(probe).color;
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!match) return fallback;
        return `#${[match[1], match[2], match[3]].map(part => Number(part).toString(16).padStart(2, '0')).join('')}`;
    } finally {
        probe.remove();
    }
}

function themeColorHex(variableName, fallback = DEFAULT_PICKER_COLOR) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
    return cssColorToHex(value || fallback, fallback);
}

function createColorSetting(labelText, initialValue, pickerFallback = DEFAULT_PICKER_COLOR) {
    const field = document.createElement('label');
    field.className = 'folderizer-color-field';

    const label = document.createElement('span');
    label.textContent = labelText;

    const controls = document.createElement('span');
    controls.className = 'folderizer-color-controls';

    const picker = document.createElement('toolcool-color-picker');
    picker.setAttribute('color', pickerColor(initialValue, pickerFallback));

    const hex = document.createElement('input');
    hex.type = 'text';
    hex.value = normalizeColor(initialValue);
    hex.placeholder = 'default, transparent, rgba(...)';
    hex.spellcheck = false;

    picker.addEventListener('change', event => {
        hex.value = event.detail?.rgba || picker.getAttribute('color') || '';
    });
    hex.addEventListener('input', () => {
        const value = normalizeColor(hex.value);
        if (!value) return;
        const next = pickerColor(value, pickerFallback);
        picker.setAttribute('color', next);
        picker.color = next;
    });

    controls.append(picker, hex);
    field.append(label, controls);

    return {
        field,
        value: () => normalizeColor(hex.value),
        isValid: () => !hex.value.trim() || isColorValue(hex.value),
    };
}

function updateFolderCount(folderElement) {
    const count = folderElement.querySelector('.folderizer-folder-items')?.children.length ?? 0;
    const countElement = folderElement.querySelector('.folderizer-folder-count');
    if (countElement) countElement.textContent = String(count);
}

function enabledState(values) {
    if (!values.length) return 'off';
    const enabledCount = values.filter(Boolean).length;
    if (enabledCount === 0) return 'off';
    if (enabledCount === values.length) return 'on';
    return 'mixed';
}

function setStateButtonIcon(button, state) {
    button.classList.toggle('fa-toggle-on', state === 'on');
    button.classList.toggle('fa-toggle-off', state === 'off');
    button.classList.toggle('fa-circle-half-stroke', state === 'mixed');
    button.dataset.state = state;
    button.title = state === 'on' ? '이 폴더의 모든 항목 비활성화' : '이 폴더의 모든 항목 활성화';
}

function createFolderElement(folder, { kind, owner, collapsed, onEdit, onDelete, onStateToggle, state = null }) {
    const element = document.createElement(kind === 'regex' ? 'div' : 'li');
    element.className = `folderizer-folder folderizer-${kind}-folder`;
    element.dataset.folderizerId = folder.id;
    const backgroundColor = normalizeColor(folder.color);
    const borderColor = normalizeColor(folder.borderColor);
    if (backgroundColor) element.style.setProperty('--folderizer-background-color', backgroundColor);
    if (borderColor) element.style.setProperty('--folderizer-border-color', borderColor);
    element.style.setProperty('--folderizer-name-color', normalizeColor(folder.nameColor, 'inherit'));

    const header = document.createElement('div');
    header.className = 'folderizer-folder-header';

    const drag = document.createElement('span');
    drag.className = 'folderizer-drag drag-handle fa-solid fa-bars';
    drag.title = '폴더 이동';

    const name = document.createElement('span');
    name.className = 'folderizer-folder-name';
    name.textContent = folder.name;
    name.title = folder.name;

    const count = document.createElement('span');
    count.className = 'folderizer-folder-count';
    count.textContent = String(folder.items.length);

    const edit = createIconButton('fa-pencil', '폴더 편집');
    edit.addEventListener('click', () => onEdit(folder.id));

    const remove = createIconButton('fa-trash', '폴더 삭제', 'caution');
    remove.addEventListener('click', () => onDelete(folder.id));

    const collapse = createIconButton('fa-chevron-down', '폴더 접기');
    collapse.classList.add('folderizer-collapse-toggle');
    const items = document.createElement(kind === 'regex' ? 'div' : 'ul');
    items.className = `folderizer-folder-items folderizer-${kind}-items`;

    if (collapsed.has(folder.id)) {
        element.classList.add('is-collapsed');
        collapse.classList.replace('fa-chevron-down', 'fa-chevron-right');
    }

    collapse.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const isCollapsed = element.classList.toggle('is-collapsed');
        collapse.classList.toggle('fa-chevron-down', !isCollapsed);
        collapse.classList.toggle('fa-chevron-right', isCollapsed);
        const values = ownerCollapsed(kind, owner);
        isCollapsed ? values.add(folder.id) : values.delete(folder.id);
        saveCollapsed(kind, owner, values);
    });

    header.append(drag, collapse);
    if (onStateToggle) {
        header.classList.add('has-state-toggle');
        const stateButton = createIconButton('fa-toggle-off', '폴더 항목 켜기/끄기', 'folderizer-state-toggle');
        setStateButtonIcon(stateButton, state);
        stateButton.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            stateButton.disabled = true;
            try {
                await onStateToggle(folder.id, stateButton.dataset.state);
            } finally {
                stateButton.disabled = false;
            }
        });
        header.append(stateButton);
    }
    header.append(name, count, edit, remove);
    element.append(header, items);
    return element;
}

async function requestFolderName(layout, currentName = '', currentId = null) {
    const value = await Popup.show.input(currentId ? '폴더 이름 변경' : '새 폴더', '폴더 이름', currentName);
    const name = String(value ?? '').trim();
    if (!name) return null;
    if (hasDuplicateFolderName(layout, name, currentId)) {
        toastr.warning('같은 이름의 폴더가 이미 있습니다.');
        return null;
    }
    return name;
}

async function requestNewFolder(layout, candidates = []) {
    const form = document.createElement('div');
    form.className = 'folderizer-edit-form folderizer-create-form';

    const title = document.createElement('div');
    title.className = 'folderizer-edit-title';
    title.textContent = '새 폴더';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '폴더 이름';
    nameInput.autofocus = true;

    const nameField = document.createElement('label');
    nameField.className = 'folderizer-text-field';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '이름';
    nameField.append(nameLabel, nameInput);

    form.append(title, nameField);

    const selectable = candidates.filter(candidate => candidate?.id && candidate?.label);
    if (selectable.length) {
        const group = document.createElement('div');
        group.className = 'folderizer-create-items';
        const groupTitle = document.createElement('div');
        groupTitle.className = 'folderizer-create-items-title';
        groupTitle.textContent = '폴더에 넣을 항목';
        const list = document.createElement('div');
        list.className = 'folderizer-create-items-list';
        selectable.forEach(candidate => {
            const label = document.createElement('label');
            label.className = 'checkbox flex-container';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = String(candidate.id);
            const text = document.createElement('span');
            text.textContent = candidate.label;
            text.title = candidate.label;
            label.append(checkbox, text);
            list.append(label);
        });
        group.append(groupTitle, list);
        form.append(group);
    }

    const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '만들기',
        cancelButton: '취소',
        wide: true,
        onClosing: value => {
            if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const name = nameInput.value.trim();
            if (!name) {
                toastr.warning('폴더 이름은 비워둘 수 없습니다.');
                return false;
            }
            if (hasDuplicateFolderName(layout, name)) {
                toastr.warning('같은 이름의 폴더가 이미 있습니다.');
                return false;
            }
            return true;
        },
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    const itemIds = [...form.querySelectorAll('.folderizer-create-items input[type="checkbox"]:checked')]
        .map(input => String(input.value));
    return { name: nameInput.value.trim(), itemIds };
}

async function requestFolderSettings(layout, folder) {
    const form = document.createElement('div');
    form.className = 'folderizer-edit-form';

    const title = document.createElement('div');
    title.className = 'folderizer-edit-title';
    title.textContent = '폴더 설정';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = folder.name;
    nameInput.placeholder = '폴더 이름';
    nameInput.autofocus = true;

    const nameField = document.createElement('label');
    nameField.className = 'folderizer-text-field';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '이름';
    nameField.append(nameLabel, nameInput);

    const backgroundColor = createColorSetting('배경색', folder.color, themeColorHex('--SmartThemeBlurTintColor'));
    const borderColor = createColorSetting('테두리색', folder.borderColor, themeColorHex('--SmartThemeBorderColor'));
    const nameColor = createColorSetting('이름 색상', folder.nameColor, themeColorHex('--SmartThemeBodyColor', '#ffffff'));

    form.append(title, nameField, backgroundColor.field, borderColor.field, nameColor.field);

    const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '저장',
        cancelButton: '취소',
        wide: true,
        onClosing: value => {
            if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const name = nameInput.value.trim();
            if (!name) {
                toastr.warning('폴더 이름은 비워둘 수 없습니다.');
                return false;
            }
            if (hasDuplicateFolderName(layout, name, folder.id)) {
                toastr.warning('같은 이름의 폴더가 이미 있습니다.');
                return false;
            }
            if (![backgroundColor, borderColor, nameColor].every(setting => setting.isValid())) {
                toastr.warning('transparent, #fff, #ffff, #ffffff, #ffffffff 형식으로 입력하거나 기본값을 쓰려면 비워두세요.');
                return false;
            }
            return true;
        },
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    const name = nameInput.value.trim();
    return {
        name,
        color: backgroundColor.value(),
        borderColor: borderColor.value(),
        nameColor: nameColor.value(),
    };
}

async function requestMoveTarget(layout, itemId) {
    if (!layout.folders.length) {
        toastr.info('먼저 폴더를 만들어 주세요.');
        return null;
    }

    const currentFolder = layout.folders.find(folder => folder.items.includes(String(itemId)));
    const currentValue = currentFolder?.id ?? '';
    const form = document.createElement('div');
    form.className = 'folderizer-move-form';

    const title = document.createElement('div');
    title.className = 'folderizer-edit-title';
    title.textContent = '폴더로 이동';

    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = '대상';
    const select = document.createElement('select');
    select.className = 'text_pole';

    const rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.textContent = '최상위 (폴더 없음)';
    select.append(rootOption);
    for (const folder of layout.folders) {
        const option = document.createElement('option');
        option.value = folder.id;
        option.textContent = folder.name;
        select.append(option);
    }
    select.value = currentValue;
    label.append(text, select);
    form.append(title, label);

    const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '이동',
        cancelButton: '취소',
    }).show();

    return result === POPUP_RESULT.AFFIRMATIVE ? select.value : null;
}

function moveItemToFolder(layout, itemId, folderId) {
    const id = String(itemId);
    const currentRootIndex = layout.root.findIndex(node => node.type === 'item' && node.id === id);
    const currentFolder = layout.folders.find(folder => folder.items.includes(id));
    const currentFolderId = currentFolder?.id ?? '';
    const targetFolderId = String(folderId ?? '');
    if (currentRootIndex !== -1 && !targetFolderId) return false;
    if (currentFolderId === targetFolderId) return false;

    layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === id));
    for (const folder of layout.folders) {
        folder.items = folder.items.filter(value => value !== id);
    }

    if (!targetFolderId) {
        layout.root.unshift({ type: 'item', id });
        return true;
    }

    const folder = layout.folders.find(value => value.id === targetFolderId);
    if (!folder) return false;
    folder.items.push(id);
    return true;
}

function rootItemIds(layout) {
    return layout.root
        .filter(node => node?.type === 'item' && node.id)
        .map(node => String(node.id));
}

function addFolderWithItems(layout, folderName, itemIds = []) {
    const selected = new Set(itemIds.map(String));
    const folder = { id: generateUUID(), name: folderName, color: '', items: [...selected] };
    layout.folders.push(folder);
    layout.root = [
        { type: 'folder', id: folder.id },
        ...layout.root.filter(node => node?.type !== 'item' || !selected.has(String(node.id))),
    ];
    return folder;
}

function attachMoveToFolderButton(element, { kind, layout, itemId, onMove }) {
    if (!element || element.querySelector(':scope .folderizer-move-to-folder') || !layout.folders.length) return;
    const title = '폴더로 이동';
    const button = kind === 'prompt' ? document.createElement('span') : createIconButton('fa-folder-open', title, 'folderizer-move-to-folder');
    if (kind === 'prompt') {
        button.className = 'fa-solid fa-folder-open folderizer-move-to-folder';
        button.title = title;
        button.setAttribute('aria-label', title);
    }
    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const target = await requestMoveTarget(layout, itemId);
        if (target === null) return;
        if (!moveItemToFolder(layout, itemId, target)) return;
        await onMove();
    });

    if (kind === 'prompt') {
        element.querySelector('.prompt_manager_prompt_controls')?.prepend(button);
        return;
    }

    if (kind === 'lore') {
        const host = element.querySelector('.world_entry_thin_controls');
        const before = host?.querySelector('.flex-container.alignitemscenter.wide100p');
        if (host) {
            before ? host.insertBefore(button, before) : host.append(button);
        }
        return;
    }

    if (kind === 'regex') {
        element.querySelector('.regex_script_buttons')?.prepend(button);
    }
}

function ensureToolbar(parent, key, onCreate, extra = []) {
    if (!parent) return;
    parent.querySelector(`.folderizer-toolbar[data-folderizer-toolbar="${key}"]`)?.remove();
    const toolbar = document.createElement('div');
    toolbar.className = 'folderizer-toolbar';
    toolbar.dataset.folderizerToolbar = key;
    const create = createLabeledIconButton('fa-folder-plus', '새 폴더', '새 폴더', 'folderizer-create-folder');
    create.addEventListener('click', onCreate);
    toolbar.append(create, ...extra);
    parent.prepend(toolbar);
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function safeFilePart(value) {
    return String(value || 'current')
        .replace(/[<>:"/\\|?*\x00-\x1F\x7F]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'current';
}

function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

function bundleFilename(name) {
    return `${safeFilePart(name)}.json`;
}

async function readJsonFile() {
    return await new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        let settled = false;
        const settle = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        input.addEventListener('cancel', () => settle(null), { once: true });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) {
                settle(null);
                return;
            }
            try {
                settle(JSON.parse(await file.text()));
            } catch (error) {
                console.error(`[${EXTENSION_NAME}] Failed to read bundle`, error);
                debugLog('error', '번들 파일 읽기 실패', error);
                toastr.error('Folderizer 번들을 읽을 수 없습니다.');
                settle(null);
            }
        }, { once: true });
        input.click();
    });
}

function assertBundle(bundle, scope) {
    if (bundle?.kind !== BUNDLE_KIND || bundle?.scope !== scope) {
        toastr.error('현재 항목에 맞는 Folderizer 번들이 아닙니다.');
        return false;
    }
    if (bundle.version > BUNDLE_VERSION) {
        toastr.error('이 Folderizer 번들은 더 새로운 버전에서 만들어졌습니다.');
        return false;
    }
    if (bundle.version !== BUNDLE_VERSION) {
        toastr.error('지원하지 않는 Folderizer 번들 버전입니다.');
        return false;
    }
    return true;
}

function nameKey(value) {
    return String(value || '').trim().toLocaleLowerCase();
}

function remapImportedLayout(layout, itemIdMap) {
    const rootedFolderIds = new Set((layout?.root || [])
        .filter(node => node?.type === 'folder')
        .map(node => node.id));
    const sourceFolders = (layout?.folders || []).filter(folder => rootedFolderIds.has(folder.id));
    const folderIdMap = new Map(sourceFolders.map(folder => [folder.id, generateUUID()]));
    return {
        version: FOLDERIZER_VERSION,
        root: (layout?.root || []).map(node => {
            if (node.type === 'folder') return { type: 'folder', id: folderIdMap.get(node.id) };
            return { type: 'item', id: itemIdMap.get(String(node.id)) };
        }).filter(node => node.id),
        folders: sourceFolders.map(folder => ({
            ...folder,
            id: folderIdMap.get(folder.id),
            items: (folder.items || []).map(id => itemIdMap.get(String(id))).filter(Boolean),
        })).filter(folder => folder.id),
    };
}

function removeItemsFromLayout(layout, itemIds) {
    const ids = new Set(itemIds);
    return {
        version: FOLDERIZER_VERSION,
        root: (layout.root || []).filter(node => node.type !== 'item' || !ids.has(String(node.id))),
        folders: (layout.folders || []).map(folder => ({
            ...folder,
            items: (folder.items || []).filter(id => !ids.has(String(id))),
        })),
    };
}

function mergeImportedLayout(currentLayout, importedLayout, allIds) {
    const importedIds = flattenLayout(importedLayout);
    const baseLayout = removeItemsFromLayout(currentLayout, importedIds);
    return normalizeLayout({
        version: FOLDERIZER_VERSION,
        root: [...importedLayout.root, ...baseLayout.root],
        folders: [...importedLayout.folders, ...baseLayout.folders],
    }, allIds);
}

function createBundleButtons(onExport, onImport) {
    const exportButton = createIconCodeButton('f0ee', 'Folderizer 번들 내보내기', 'folderizer-bundle-button');
    const importButton = createIconCodeButton('f0ed', 'Folderizer 번들 불러오기', 'folderizer-bundle-button');
    exportButton.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await onExport();
    });
    importButton.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await onImport();
    });
    return [exportButton, importButton];
}

function promptOrderIds(manager = promptManager) {
    return manager.getPromptOrderForCharacter(manager.activeCharacter).map(entry => String(entry.identifier));
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

function ensurePromptOrder(manager = promptManager) {
    if (!manager.activeCharacter) return [];
    manager.serviceSettings.prompt_order ??= [];
    const list = manager.serviceSettings.prompt_order.find(value => String(value.character_id) === String(manager.activeCharacter.id));
    if (list) return list.order;
    let order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    if (!order.length) {
        manager.addPromptOrderForCharacter(manager.activeCharacter, []);
        order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    }
    return order;
}

async function exportPromptBundle(manager = promptManager) {
    const owner = promptOwnerKey();
    const layout = currentPromptLayout
        ? normalizeLayout(currentPromptLayout, promptOrderIds(manager), { preserveUnrootedFolders: false })
        : readPromptLayout(manager, { preserveUnrootedFolders: false }).layout;
    settings().layouts.prompts[owner] = layout;
    currentPromptLayout = layout;
    saveSettingsDebounced();
    const presetManager = promptPresetManager();
    const presetName = promptExportName();
    const ids = new Set(flattenLayout(layout));
    const prompts = (manager.serviceSettings.prompts || [])
        .filter(prompt => prompt?.identifier && ids.has(String(prompt.identifier)))
        .map(cloneJson);
    const promptOrder = manager.getPromptOrderForCharacter(manager.activeCharacter)
        .filter(entry => ids.has(String(entry.identifier)))
        .map(cloneJson);

    downloadJson({
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        scope: 'prompts',
        owner,
        presetName,
        presetSettings: cloneJson(presetManager?.getPresetSettings?.(presetName) || {}),
        layout: cloneJson(layout),
        prompts,
        promptOrder,
    }, bundleFilename(presetName));
    toastr.success('Folderizer 프롬프트 번들을 내보냈습니다.');
}

async function importPromptBundle(manager = promptManager) {
    const bundle = await readJsonFile();
    if (!bundle || !assertBundle(bundle, 'prompts')) return;
    if (!Array.isArray(bundle.prompts) || !Array.isArray(bundle.promptOrder)) {
        toastr.error('Folderizer 프롬프트 번들에 프롬프트 데이터가 없습니다.');
        return;
    }
    const presetManager = promptPresetManager();
    const presetName = promptBundlePresetName(bundle);
    if (!presetName) {
        toastr.error('Folderizer 프롬프트 번들에 프리셋 이름이 없습니다.');
        return;
    }
    const exists = presetManager?.getAllPresets?.().includes(presetName);
    const confirmed = await Popup.show.confirm('프롬프트 번들 불러오기', exists
        ? `기존 프롬프트 프리셋 "${presetName}"을 이 Folderizer 번들로 덮어쓸까요?`
        : `이 Folderizer 번들로 새 프롬프트 프리셋 "${presetName}"을 만들까요?`);
    if (!confirmed) return;

    const presetSettings = cloneJson(bundle.presetSettings || presetManager?.getPresetSettings?.(presetName) || {});
    await presetManager.savePreset(presetName, presetSettings);
    const presetValue = presetManager.findPreset(presetName);
    if (presetValue !== undefined) presetManager.selectPreset(presetValue);
    await waitUntilCondition(() => presetManager.getSelectedPresetName() === presetName, 5000, 100);

    const importedPrompts = bundle.prompts.filter(prompt => prompt?.identifier);
    const currentPrompts = exists ? (manager.serviceSettings.prompts || []) : [];
    const promptsById = new Map(currentPrompts
        .filter(prompt => prompt?.identifier)
        .map(prompt => [String(prompt.identifier), prompt]));
    const promptsByName = new Map(currentPrompts
        .filter(prompt => prompt?.name)
        .map(prompt => [nameKey(prompt.name), prompt]));
    const usedIds = new Set(promptsById.keys());
    const idMap = new Map();
    importedPrompts.forEach(prompt => {
        const imported = cloneJson(prompt);
        const existing = promptsByName.get(nameKey(imported.name));
        const sourceId = String(imported.identifier);
        if (existing) {
            imported.identifier = existing.identifier;
        } else if (!imported.identifier || usedIds.has(String(imported.identifier))) {
            imported.identifier = generateUUID();
        }
        const targetId = String(imported.identifier);
        idMap.set(sourceId, targetId);
        usedIds.add(targetId);
        promptsById.set(targetId, imported);
    });
    manager.setPrompts([...promptsById.values()]);

    const owner = promptOwnerKeyForName(presetName);
    const currentIds = exists ? promptOrderIds(manager) : [];
    // Imports may reuse existing prompts, but the Folderizer layout itself comes from the bundle.
    const currentLayout = normalizeLayout(null, currentIds);
    const importedLayout = remapImportedLayout(bundle.layout, idMap);
    const allIds = [...new Set([...currentIds, ...idMap.values()])];
    const layout = mergeImportedLayout(currentLayout, importedLayout, allIds);
    const orderById = new Map(bundle.promptOrder.map(entry => {
        const targetId = idMap.get(String(entry.identifier));
        return targetId ? [targetId, { ...cloneJson(entry), identifier: targetId }] : null;
    }).filter(Boolean));
    const order = ensurePromptOrder(manager);
    const existingOrderById = new Map(exists ? order.map(entry => [String(entry.identifier), entry]) : []);
    order.splice(0, order.length, ...flattenLayout(layout).map(id => orderById.get(id) ?? existingOrderById.get(id) ?? { identifier: id, enabled: true }));

    settings().layouts.prompts[owner] = layout;
    currentPromptLayout = layout;
    saveSettingsDebounced();
    await manager.saveServiceSettings();
    manager.render(false);
    toastr.success('Folderizer 프롬프트 번들을 불러왔습니다.');
}

function promptLayoutFromDom(list, sourceLayout, { preserveFolderIds = new Set(), normalizeOptions = {} } = {}) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const root = [];
    const folders = [];
    const seenPreservedFolders = new Set();

    for (const element of list.children) {
        if (element.classList.contains('folderizer-folder')) {
            const id = element.dataset.folderizerId;
            const source = folderSource.get(id);
            if (!source) continue;
            const items = preserveFolderIds.has(id)
                ? [...source.items]
                : [...element.querySelector('.folderizer-folder-items').children]
                    .map(item => item.dataset.pmIdentifier)
                    .filter(Boolean);
            folders.push({ ...source, items });
            root.push({ type: 'folder', id });
            if (preserveFolderIds.has(id)) seenPreservedFolders.add(id);
        } else if (element.dataset.pmIdentifier) {
            root.push({ type: 'item', id: element.dataset.pmIdentifier });
        }
    }

    if ([...preserveFolderIds].some(id => !seenPreservedFolders.has(id))) {
        return normalizeLayout(sourceLayout, promptOrderIds(), normalizeOptions);
    }

    return normalizeLayout({ version: 1, root, folders }, promptOrderIds(), normalizeOptions);
}

function setupPromptSortables(manager) {
    const list = manager.listElement;
    if (!list?.classList.contains('folderizer-prompt-root')) return;
    const $list = $(list);
    if ($list.sortable('instance')) $list.sortable('destroy');
    list.querySelectorAll('.folderizer-prompt-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    let saving = false;
    const saveFromDom = async ({ preserveFolderIds = new Set() } = {}) => {
        if (saving) return;
        saving = true;
        try {
            const preservedFolders = new Map(currentPromptLayout.folders
                .filter(folder => preserveFolderIds.has(folder.id))
                .map(folder => [folder.id, folder]));
            list.querySelectorAll('.folderizer-folder').forEach(element => {
                const preserved = preservedFolders.get(element.dataset.folderizerId);
                if (!preserved) {
                    updateFolderCount(element);
                    return;
                }
                const countElement = element.querySelector('.folderizer-folder-count');
                if (countElement) countElement.textContent = String(preserved.items.length);
            });
            const next = promptLayoutFromDom(list, currentPromptLayout, { preserveFolderIds });
            await persistPromptLayout(promptOwnerKey(), next, manager);
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save prompt folder order`, error);
            debugLog('error', '프롬프트 폴더 순서 저장 실패', error);
            toastr.error('프롬프트 폴더 순서를 저장하지 못했습니다.');
            manager.render(false);
        } finally {
            saving = false;
        }
    };

    let lastPointer = null;
    let lastFolderElement = null;
    let draggingPromptIntoFolder = false;
    let draggingFolderId = null;
    const clearFolderDropState = () => {
        lastPointer = null;
        lastFolderElement = null;
        draggingPromptIntoFolder = false;
        draggingFolderId = null;
        list.classList.remove('folderizer-dropping-into-folder');
        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
    };
    const rememberPointer = (event, ui) => {
        if (!draggingPromptIntoFolder) {
            list.classList.remove('folderizer-dropping-into-folder');
            list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
            return;
        }
        lastPointer = { x: event.clientX, y: event.clientY };
        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-prompt-folder'))
            .find(Boolean);
        if (pointedFolder) lastFolderElement = pointedFolder;
        list.classList.toggle('folderizer-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
        pointedFolder?.classList.add('folderizer-drop-target');
        const placeholder = ui?.placeholder?.[0];
        const items = pointedFolder?.querySelector?.('.folderizer-prompt-items');
        if (placeholder && items && !items.contains(placeholder)) items.append(placeholder);
    };
    const movePromptIntoPointedFolder = item => {
        if (!item?.classList?.contains('completion_prompt_manager_prompt_draggable') || !lastPointer) return;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-prompt-folder'))
            .find(Boolean);
        const items = folderElement?.querySelector?.('.folderizer-prompt-items');
        if (!items || items.contains(item)) return;
        items.append(item);
        updateFolderCount(folderElement);
    };
    const afterPromptSort = task => {
        setTimeout(() => {
            task().catch(error => {
                console.error(`[${EXTENSION_NAME}] Failed to finish prompt folder sort`, error);
                debugLog('error', '프롬프트 폴더 정렬 완료 처리 실패', error);
                toastr.error('프롬프트 폴더 순서를 저장하지 못했습니다.');
                manager.render(false);
            });
        }, 0);
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> .completion_prompt_manager_prompt_draggable, > .folderizer-folder',
        placeholder: 'folderizer-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: (_, ui) => {
            const item = ui.item?.[0];
            sortingPrompt = true;
            draggingPromptIntoFolder = item?.classList?.contains('completion_prompt_manager_prompt_draggable') ?? false;
            draggingFolderId = item?.classList?.contains('folderizer-folder') ? item.dataset.folderizerId : null;
        },
        sort: rememberPointer,
        stop: (_, ui) => {
            afterPromptSort(async () => {
                try {
                    const item = ui.item?.[0];
                    if (draggingFolderId && item?.parentElement !== list) {
                        manager.render(false);
                        return;
                    }
                    const preserveFolderIds = item?.classList?.contains('folderizer-folder')
                        ? new Set([item.dataset.folderizerId].filter(Boolean))
                        : new Set();
                    movePromptIntoPointedFolder(item);
                    await saveFromDom({ preserveFolderIds });
                } finally {
                    sortingPrompt = false;
                    clearFolderDropState();
                }
            });
        },
    });
    list.querySelectorAll('.folderizer-prompt-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> .completion_prompt_manager_prompt_draggable',
            connectWith: '#completion_prompt_manager_list, .folderizer-prompt-items',
            placeholder: 'folderizer-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: (_, ui) => {
                const item = ui.item?.[0];
                sortingPrompt = true;
                draggingPromptIntoFolder = item?.classList?.contains('completion_prompt_manager_prompt_draggable') ?? false;
                draggingFolderId = item?.classList?.contains('folderizer-folder') ? item.dataset.folderizerId : null;
            },
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('folderizer-folder')) $(ui.sender).sortable('cancel');
            },
            stop: (_, ui) => {
                afterPromptSort(async () => {
                    try {
                        const item = ui.item?.[0];
                        if (item?.classList?.contains('folderizer-folder')) {
                            manager.render(false);
                            return;
                        }
                        const preserveFolderIds = item?.classList?.contains('folderizer-folder')
                            ? new Set([item.dataset.folderizerId].filter(Boolean))
                            : new Set();
                        movePromptIntoPointedFolder(item);
                        await saveFromDom({ preserveFolderIds });
                    } finally {
                        sortingPrompt = false;
                        clearFolderDropState();
                    }
                });
            },
        });
    });
}

async function enhancePromptList(manager) {
    const list = manager.listElement;
    if (!list || !featureEnabled('prompts')) return;
    const { owner, layout } = readPromptLayout(manager);
    currentPromptLayout = layout;
    list.classList.add('folderizer-prompt-root');

    const itemMap = new Map([...list.querySelectorAll('[data-pm-identifier]')].map(element => [element.dataset.pmIdentifier, element]));
    itemMap.forEach(element => element.remove());
    const collapsed = ownerCollapsed('prompt', owner);
    const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));

    const rerender = () => manager.render(false);
    const onEdit = async id => {
        const folder = currentPromptLayout.folders.find(value => value.id === id);
        if (!folder) return;
        const values = await requestFolderSettings(currentPromptLayout, folder);
        if (!values) return;
        Object.assign(folder, values);
        await persistPromptLayout(owner, currentPromptLayout, manager);
        rerender();
    };
    const onDelete = async id => {
        const folder = currentPromptLayout.folders.find(value => value.id === id);
        if (!folder || !await Popup.show.confirm('폴더 삭제', `"${folder.name}" 폴더를 삭제하고 안의 프롬프트는 최상위로 옮길까요?`)) return;
        removeFolder(currentPromptLayout, id);
        currentPromptLayout = normalizeLayout(currentPromptLayout, promptOrderIds(manager), { preserveUnrootedFolders: false });
        await persistPromptLayout(owner, currentPromptLayout, manager);
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
                    onMove: async () => {
                        await persistPromptLayout(owner, currentPromptLayout, manager);
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
            kind: 'prompt', owner, collapsed, onEdit, onDelete,
        });
        const items = folderElement.querySelector('.folderizer-folder-items');
        folder.items.forEach(id => {
            const item = itemMap.get(id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'prompt',
                    layout: currentPromptLayout,
                    itemId: id,
                    onMove: async () => {
                        await persistPromptLayout(owner, currentPromptLayout, manager);
                        rerender();
                    },
                });
                items.append(item);
            }
        });
        updateFolderCount(folderElement);
        list.append(folderElement);
    }

    ensureToolbar(list.closest('.range-block'), 'prompt', async () => {
        const promptsById = new Map((manager.serviceSettings.prompts || [])
            .filter(prompt => prompt?.identifier)
            .map(prompt => [String(prompt.identifier), prompt]));
        const candidates = rootItemIds(currentPromptLayout).map(id => ({
            id,
            label: promptsById.get(id)?.name || id,
        }));
        const values = await requestNewFolder(currentPromptLayout, candidates);
        if (!values) return;
        addFolderWithItems(currentPromptLayout, values.name, values.itemIds);
        await persistPromptLayout(owner, currentPromptLayout, manager);
        rerender();
    }, createBundleButtons(() => exportPromptBundle(manager), () => importPromptBundle(manager)));
}

async function installPromptIntegration() {
    await waitUntilCondition(() => promptManager && promptPresetManager(), 30000, 100);
    const manager = promptManager;
    if (!originalPromptRenderItems) originalPromptRenderItems = manager.renderPromptManagerListItems.bind(manager);
    if (!originalPromptMakeDraggable) originalPromptMakeDraggable = manager.makeDraggable.bind(manager);
    if (manager.__folderizerInstalled) return;
    manager.__folderizerInstalled = true;

    manager.renderPromptManagerListItems = async function (...args) {
        await originalPromptRenderItems.apply(this, args);
        if (featureEnabled('prompts')) await enhancePromptList(manager);
    };
    manager.makeDraggable = function (...args) {
        if (featureEnabled('prompts')) setupPromptSortables(manager);
        else originalPromptMakeDraggable.apply(this, args);
    };
    manager.render(false);
}

function loreLayoutFromDom(list, sourceLayout, allIds) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const root = [];
    const folders = [];
    for (const element of list.children) {
        if (element.classList.contains('folderizer-folder')) {
            const id = element.dataset.folderizerId;
            const source = folderSource.get(id);
            if (!source) continue;
            const renderedItems = [...element.querySelector('.folderizer-folder-items').children]
                .map(item => item.getAttribute('uid'))
                .filter(Boolean);
            const items = element.classList.contains('is-collapsed') ? [...source.items] : renderedItems;
            folders.push({ ...source, items });
            root.push({ type: 'folder', id });
        } else if (element.hasAttribute('uid')) {
            root.push({ type: 'item', id: element.getAttribute('uid') });
        }
    }
    return normalizeLayout({ version: 1, root, folders }, allIds);
}

function matchesLoreQuery(entry, query) {
    if (!query) return true;
    const haystack = [
        entry.comment,
        entry.content,
        ...(Array.isArray(entry.key) ? entry.key : []),
        ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
    ].filter(Boolean).join('\n').toLocaleLowerCase();
    return query.toLocaleLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

function loreEntryLabel(entry) {
    if (!entry) return '';
    const comment = String(entry.comment || '').trim();
    if (comment) return comment;
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean).join(', ') : '';
    if (keys) return keys;
    const content = String(entry.content || '').trim().replace(/\s+/g, ' ');
    if (content) return content.slice(0, 80);
    return `UID ${entry.uid}`;
}

async function persistLoreLayout(owner, layout) {
    settings().layouts.lorebooks[owner] = layout;
    saveSettingsDebounced();
}

async function createLorebookFolder() {
    if (!featureEnabled('lorebooks')) return;
    const name = selectedLorebookName();
    if (!name) {
        toastr.warning('먼저 로어북을 선택해 주세요.');
        return;
    }

    const data = await loadWorldInfo(name);
    if (!data?.entries) return;
    const allIds = Object.values(data.entries)
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => String(entry.uid));
    const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
    const entriesById = new Map(Object.values(data.entries)
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => [String(entry.uid), entry]));
    const candidates = rootItemIds(layout)
        .map(id => entriesById.get(id))
        .filter(Boolean)
        .map(entry => ({ id: String(entry.uid), label: loreEntryLabel(entry) }));
    const values = await requestNewFolder(layout, candidates);
    if (!values) return;

    addFolderWithItems(layout, values.name, values.itemIds);
    await persistLoreLayout(name, layout);

    const sort = document.getElementById('world_info_sort_order');
    if (sort && sort.value !== LORE_SORT_VALUE) {
        sort.value = LORE_SORT_VALUE;
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
    }
    queueLoreRender();
}

function loreEntryIds(data) {
    return Object.values(data?.entries || {})
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => String(entry.uid));
}

async function exportLorebookBundle() {
    const name = selectedLorebookName();
    if (!name) {
        toastr.warning('먼저 로어북을 선택해 주세요.');
        return;
    }
    const data = await loadWorldInfo(name);
    const layout = normalizeLayout(settings().layouts.lorebooks[name], loreEntryIds(data));
    settings().layouts.lorebooks[name] = layout;
    saveSettingsDebounced();

    downloadJson({
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        scope: 'lorebooks',
        owner: name,
        layout: cloneJson(layout),
        data: cloneJson(data),
    }, bundleFilename(name));
    toastr.success('Folderizer 로어북 번들을 내보냈습니다.');
}

async function importLorebookBundle() {
    const bundle = await readJsonFile();
    if (!bundle || !assertBundle(bundle, 'lorebooks')) return;
    if (!bundle.data?.entries) {
        toastr.error('Folderizer 로어북 번들에 로어북 데이터가 없습니다.');
        return;
    }
    const name = String(bundle.owner || bundle.data.name || selectedLorebookName() || '').trim();
    if (!name) {
        toastr.warning('Folderizer 로어북 번들에 로어북 이름이 없습니다.');
        return;
    }
    const exists = world_names.includes(name);
    const confirmed = await Popup.show.confirm('로어북 번들 불러오기', exists
        ? `기존 로어북 "${name}"을 이 Folderizer 번들로 덮어쓸까요?`
        : `이 Folderizer 번들로 새 로어북 "${name}"을 만들까요?`);
    if (!confirmed) return;

    const data = cloneJson(bundle.data);
    const layout = normalizeLayout(bundle.layout, loreEntryIds(data));
    await saveWorldInfo(name, data, true);
    settings().layouts.lorebooks[name] = layout;
    saveSettingsDebounced();
    await updateWorldInfoList();
    const index = world_names.indexOf(name);
    if (index >= 0) $('#world_editor_select').val(index).trigger('change');
    await reloadEditor(name, true);
    if (document.getElementById('world_info_sort_order')?.value === LORE_SORT_VALUE) queueLoreRender();
    toastr.success('Folderizer 로어북 번들을 불러왔습니다.');
}

async function createLorebookEntryInFolderOrder() {
    if (handlingLoreAction) return;
    if (!featureEnabled('lorebooks')) return;
    handlingLoreAction = true;
    try {
        const name = selectedLorebookName();
        if (!name) return;
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;

        const entry = createWorldInfoEntry(name, data);
        if (!entry) return;
        syncLoreOriginalEntry(data, entry);

        const allIds = Object.values(data.entries)
            .filter(value => value && typeof value === 'object')
            .map(value => String(value.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
        const entryId = String(entry.uid);
        layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === entryId));
        for (const folder of layout.folders) {
            folder.items = folder.items.filter(id => id !== entryId);
        }
        layout.root.unshift({ type: 'item', id: entryId });

        await persistLoreLayout(name, layout);
        await saveWorldInfo(name, data, true);
        queueLoreRender();
    } finally {
        handlingLoreAction = false;
    }
}

function syncLoreOriginalEntry(data, entry) {
    if (!data?.originalData || !Array.isArray(data.originalData.entries) || !entry) return;
    const uid = Number(entry.uid);
    const existing = data.originalData.entries.find(value => value.uid === uid || value.id === uid);
    const original = existing ?? { uid, id: uid };
    // FRAGILE: mirrors SillyTavern World Info originalData entry shape used by world-info.js.
    original.uid = uid;
    original.id = uid;
    original.keys = Array.isArray(entry.key) ? [...entry.key] : [];
    original.secondary_keys = Array.isArray(entry.keysecondary) ? [...entry.keysecondary] : [];
    original.comment = entry.comment ?? '';
    original.content = entry.content ?? '';
    original.constant = !!entry.constant;
    original.selective = !!entry.selective;
    original.selectiveLogic = entry.selectiveLogic;
    original.insertion_order = Number(entry.order) || 0;
    original.enabled = !entry.disable;
    original.position = entry.position === 0 ? 'before_char' : 'after_char';
    original.extensions ??= {};
    original.extensions.display_index = entry.displayIndex ?? entry.uid;
    original.extensions.position = entry.position;
    original.extensions.role = entry.role;
    original.extensions.depth = entry.depth;
    original.extensions.probability = entry.probability;
    original.extensions.useProbability = entry.useProbability;
    original.extensions.exclude_recursion = entry.excludeRecursion;
    original.extensions.prevent_recursion = entry.preventRecursion;
    original.extensions.delay_until_recursion = entry.delayUntilRecursion;
    original.extensions.match_whole_words = entry.matchWholeWords;
    original.extensions.use_group_scoring = entry.useGroupScoring;
    original.extensions.case_sensitive = entry.caseSensitive;
    original.extensions.scan_depth = entry.scanDepth;
    original.extensions.automation_id = entry.automationId;
    original.extensions.vectorized = entry.vectorized;
    original.extensions.outlet_name = entry.outletName;
    original.extensions.group = entry.group;
    original.extensions.group_override = entry.groupOverride;
    original.extensions.group_weight = entry.groupWeight;
    original.extensions.triggers = Array.isArray(entry.triggers) ? [...entry.triggers] : [];
    original.extensions.ignore_budget = entry.ignoreBudget;
    if (!existing) data.originalData.entries.push(original);
}

async function deleteLorebookEntryInFolderOrder(uid) {
    if (handlingLoreAction) return;
    if (!featureEnabled('lorebooks')) return;
    handlingLoreAction = true;
    try {
        const name = selectedLorebookName();
        if (!name) return;
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;

        const entryId = String(uid);
        const deleted = await deleteWorldInfoEntry(data, entryId);
        if (!deleted) return;
        deleteWIOriginalDataValue(data, entryId);

        const allIds = Object.values(data.entries)
            .filter(value => value && typeof value === 'object')
            .map(value => String(value.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
        layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === entryId));
        for (const folder of layout.folders) {
            folder.items = folder.items.filter(id => id !== entryId);
        }

        await persistLoreLayout(name, layout);
        await saveWorldInfo(name, data, true);
        queueLoreRender();
    } finally {
        handlingLoreAction = false;
    }
}

async function setLoreFolderEnabled(name, data, layout, folderId, enabled) {
    const folder = layout.folders.find(value => value.id === folderId);
    if (!folder) return;
    for (const id of folder.items) {
        const entry = data.entries[id];
        if (!entry) continue;
        entry.disable = !enabled;
        setWIOriginalDataValue(data, entry.uid, 'enabled', enabled);
    }
    await saveWorldInfo(name, data, true);
    queueLoreRender();
}

function setupLoreSortables(name, data, layout) {
    const list = document.getElementById('world_popup_entries_list');
    if (!list) return;
    const $list = $(list);
    if ($list.sortable('instance')) $list.sortable('destroy');
    list.querySelectorAll('.folderizer-lore-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    const allIds = Object.keys(data.entries);
    let saving = false;
    const saveFromDom = async () => {
        if (saving) return;
        if (renderingLorebook) {
            queueLoreRender();
            return;
        }
        saving = true;
        try {
            list.querySelectorAll('.folderizer-folder').forEach(updateFolderCount);
            const next = loreLayoutFromDom(list, layout, allIds);
            Object.assign(layout, next);
            await persistLoreLayout(name, layout);
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save lorebook folder order`, error);
            debugLog('error', '로어북 폴더 순서 저장 실패', error);
            toastr.error('로어북 폴더 순서를 저장하지 못했습니다.');
            queueLoreRender();
        } finally {
            saving = false;
        }
    };
    const moveItemInLayout = async (itemId, folderId) => {
        const folder = layout.folders.find(value => value.id === folderId);
        if (!folder) return;
        layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === itemId));
        for (const value of layout.folders) {
            value.items = value.items.filter(id => id !== itemId);
        }
        folder.items.push(itemId);
        await persistLoreLayout(name, layout);
    };

    let lastPointer = null;
    let lastFolderElement = null;
    let draggingLoreIntoFolder = false;
    let draggingLoreFolderId = null;
    const clearLoreDropState = () => {
        lastPointer = null;
        lastFolderElement = null;
        draggingLoreIntoFolder = false;
        draggingLoreFolderId = null;
        list.classList.remove('folderizer-dropping-into-folder');
        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
    };
    const rememberPointer = event => {
        if (!draggingLoreIntoFolder) {
            list.classList.remove('folderizer-dropping-into-folder');
            list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
            return;
        }
        lastPointer = { x: event.clientX, y: event.clientY };
        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-lore-folder'))
            .find(Boolean);
        if (pointedFolder) lastFolderElement = pointedFolder;
        list.classList.toggle('folderizer-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
        pointedFolder?.classList.add('folderizer-drop-target');
    };
    const moveLoreIntoPointedFolder = item => {
        if (!item?.hasAttribute?.('uid') || !lastPointer) return;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-lore-folder'))
            .find(Boolean);
        const items = folderElement?.querySelector?.('.folderizer-lore-items');
        if (!items || items.contains(item)) return;
        items.append(item);
        updateFolderCount(folderElement);
        return folderElement.dataset.folderizerId;
    };
    const afterLoreSort = task => {
        setTimeout(() => {
            task().catch(error => {
                console.error(`[${EXTENSION_NAME}] Failed to finish lorebook folder sort`, error);
                debugLog('error', '로어북 폴더 정렬 완료 처리 실패', error);
                toastr.error('로어북 폴더 순서를 저장하지 못했습니다.');
                queueLoreRender();
            });
        }, 0);
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> [uid], > .folderizer-folder',
        placeholder: 'folderizer-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: (_, ui) => {
            const item = ui.item?.[0];
            sortingLore = true;
            draggingLoreIntoFolder = item?.hasAttribute?.('uid') ?? false;
            draggingLoreFolderId = item?.classList?.contains('folderizer-folder') ? item.dataset.folderizerId : null;
        },
        sort: rememberPointer,
        stop: (_, ui) => {
            afterLoreSort(async () => {
                try {
                    const item = ui.item?.[0];
                    if (draggingLoreFolderId && item?.parentElement !== list) {
                        queueLoreRender();
                        return;
                    }
                    const folderId = moveLoreIntoPointedFolder(item);
                    if (folderId) await moveItemInLayout(String(item.getAttribute('uid')), folderId);
                    else await saveFromDom();
                } finally {
                    sortingLore = false;
                    clearLoreDropState();
                }
            });
        },
    });
    list.querySelectorAll('.folderizer-lore-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> [uid]',
            connectWith: '#world_popup_entries_list, .folderizer-lore-items',
            placeholder: 'folderizer-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: (_, ui) => {
                const item = ui.item?.[0];
                sortingLore = true;
                draggingLoreIntoFolder = item?.hasAttribute?.('uid') ?? false;
                draggingLoreFolderId = item?.classList?.contains('folderizer-folder') ? item.dataset.folderizerId : null;
            },
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('folderizer-folder')) $(ui.sender).sortable('cancel');
            },
            stop: (_, ui) => {
                afterLoreSort(async () => {
                    try {
                        const item = ui.item?.[0];
                        if (item?.classList?.contains('folderizer-folder')) {
                            queueLoreRender();
                            return;
                        }
                        const folderId = moveLoreIntoPointedFolder(item);
                        if (folderId) await moveItemInLayout(String(item.getAttribute('uid')), folderId);
                        else await saveFromDom();
                    } finally {
                        sortingLore = false;
                        clearLoreDropState();
                    }
                });
            },
        });
    });
}

async function renderLorebookFolders() {
    if (renderingLorebook) {
        loreRenderRequestedAfterRender = true;
        return;
    }
    if (!featureEnabled('lorebooks') || $('#world_info_sort_order').val() !== LORE_SORT_VALUE) return;
    const name = selectedLorebookName();
    if (!name) return;
    renderingLorebook = true;
    try {
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;
        const list = document.getElementById('world_popup_entries_list');
        if (!list) return;
        const allEntries = Object.values(data.entries).filter(entry => entry && typeof entry === 'object');
        const allIds = allEntries.map(entry => String(entry.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
        await persistLoreLayout(name, layout);
        const query = String($('#world_info_search').val() ?? '').trim();
        const visibleEntries = query ? allEntries.filter(entry => matchesLoreQuery(entry, query)) : allEntries;
        const visibleIds = new Set(visibleEntries.map(entry => String(entry.uid)));
        const entryMap = new Map(allEntries.map(entry => [String(entry.uid), entry]));
        const collapsed = ownerCollapsed('lore', name);
        const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));

        loreObserver?.disconnect();
        list.innerHTML = '';
        list.classList.add('folderizer-lore-root');
        list.classList.toggle('folderizer-searching', Boolean(query));
        $('#world_info_pagination').empty();
        const headers = await renderTemplateAsync('worldInfoKeywordHeaders');
        list.insertAdjacentHTML('beforeend', headers);

        const rerender = () => queueLoreRender();
        const onEdit = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder) return;
            const values = await requestFolderSettings(layout, folder);
            if (!values) return;
            Object.assign(folder, values);
            await persistLoreLayout(name, layout);
            rerender();
        };
        const onDelete = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder || !await Popup.show.confirm('폴더 삭제', `"${folder.name}" 폴더를 삭제하고 안의 항목은 최상위로 옮길까요?`)) return;
            removeFolder(layout, id);
            await persistLoreLayout(name, layout);
            rerender();
        };

        for (const node of layout.root) {
            if (node.type === 'item') {
                if (!visibleIds.has(node.id)) continue;
                const block = await getWorldEntry(name, data, entryMap.get(node.id));
                if (block?.[0]) {
                    attachMoveToFolderButton(block[0], {
                        kind: 'lore',
                        layout,
                        itemId: node.id,
                        onMove: async () => {
                            await persistLoreLayout(name, layout);
                            rerender();
                        },
                    });
                    list.append(block[0]);
                }
                continue;
            }
            const folder = folderMap.get(node.id);
            if (!folder) continue;
            const shownItems = folder.items.filter(id => visibleIds.has(id));
            if (query && !shownItems.length) continue;
            const state = enabledState(folder.items.map(id => !data.entries[id]?.disable));
            const folderElement = createFolderElement(folder, {
                kind: 'lore',
                owner: name,
                collapsed,
                onEdit,
                onDelete,
                state,
                onStateToggle: async (id, currentState) => setLoreFolderEnabled(name, data, layout, id, currentState !== 'on'),
            });
            if (query) folderElement.classList.remove('is-collapsed');
            const items = folderElement.querySelector('.folderizer-folder-items');
            for (const id of shownItems) {
                const block = await getWorldEntry(name, data, entryMap.get(id));
                if (block?.[0]) {
                    attachMoveToFolderButton(block[0], {
                        kind: 'lore',
                        layout,
                        itemId: id,
                        onMove: async () => {
                            await persistLoreLayout(name, layout);
                            rerender();
                        },
                    });
                    items.append(block[0]);
                }
            }
            folderElement.querySelector('.folderizer-folder-count').textContent = String(folder.items.length);
            list.append(folderElement);
        }

        document.querySelector('#WorldInfo .folderizer-toolbar[data-folderizer-toolbar="lore"]')?.remove();
        list.querySelectorAll('textarea[name="comment"]').forEach(element => initScrollHeight($(element)));
        if (!query) setupLoreSortables(name, data, layout);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to render lorebook folders`, error);
        debugLog('error', '로어북 폴더 표시 실패', error);
        toastr.error('로어북 폴더를 표시하지 못했습니다.');
    } finally {
        renderingLorebook = false;
        const list = document.getElementById('world_popup_entries_list');
        if (list && loreObserver) loreObserver.observe(list, { childList: true });
        if (loreRenderRequestedAfterRender) {
            loreRenderRequestedAfterRender = false;
            queueLoreRender();
        }
    }
}

function queueLoreRender() {
    if (loreRenderQueued) return;
    loreRenderQueued = true;
    setTimeout(async () => {
        loreRenderQueued = false;
        await renderLorebookFolders();
    }, 0);
}

function installLorebookIntegration() {
    const sort = document.getElementById('world_info_sort_order');
    if (!sort) return;
    if (!sort.querySelector(`option[value="${LORE_SORT_VALUE}"]`)) {
        const option = document.createElement('option');
        option.value = LORE_SORT_VALUE;
        option.textContent = '폴더 순서';
        option.dataset.rule = 'custom';
        option.dataset.field = 'displayIndex';
        option.dataset.order = 'asc';
        sort.append(option);
    }
    if (!document.getElementById('folderizer_lore_create')) {
        const create = createIconButton('fa-folder-plus', '새 폴더', 'folderizer-lore-create');
        create.id = 'folderizer_lore_create';
        create.addEventListener('click', createLorebookFolder);
        document.getElementById('world_popup_new')?.after(create);
    }
    if (!document.getElementById('folderizer_lore_export')) {
        const [exportButton, importButton] = createBundleButtons(exportLorebookBundle, importLorebookBundle);
        exportButton.id = 'folderizer_lore_export';
        importButton.id = 'folderizer_lore_import';
        exportButton.classList.add('folderizer-lore-bundle');
        importButton.classList.add('folderizer-lore-bundle');
        document.getElementById('folderizer_lore_create')?.after(exportButton, importButton);
    }
    document.querySelector('#WorldInfo .folderizer-toolbar[data-folderizer-toolbar="lore"]')?.remove();

    sort.addEventListener('change', event => {
        if (event.target.value !== LORE_SORT_VALUE) {
            const wasFolderOrder = accountStorage.getItem(SORT_ORDER_KEY) === LORE_SORT_VALUE;
            document.querySelector('#WorldInfo .folderizer-toolbar')?.remove();
            document.getElementById('world_popup_entries_list')?.classList.remove('folderizer-lore-root', 'folderizer-searching');
            if (wasFolderOrder && featureEnabled('lorebooks')) {
                event.stopImmediatePropagation();
                const value = String(event.target.value);
                if (value !== 'search') accountStorage.setItem(SORT_ORDER_KEY, value);
                const name = selectedLorebookName();
                if (name) reloadEditor(name, true);
            }
            return;
        }
        if (!featureEnabled('lorebooks')) return;
        event.stopImmediatePropagation();
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
        queueLoreRender();
    }, true);
    document.getElementById('world_info_search')?.addEventListener('input', event => {
        if (sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        event.stopImmediatePropagation();
        queueLoreRender();
    }, true);
    document.getElementById('world_refresh')?.addEventListener('click', event => {
        if (sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        queueLoreRender();
    }, true);
    document.getElementById('world_popup_new')?.addEventListener('click', event => {
        if (sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        createLorebookEntryInFolderOrder();
    }, true);
    document.getElementById('world_popup_entries_list')?.addEventListener('click', event => {
        if (sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        const button = event.target.closest?.('.delete_entry_button');
        if (!button) return;
        const entry = button.closest?.('.world_entry');
        const uid = entry?.getAttribute('uid');
        if (!uid) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        deleteLorebookEntryInFolderOrder(uid);
    }, true);

    loreObserver = new MutationObserver(() => {
        if (sortingLore || sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        if (renderingLorebook) {
            loreRenderRequestedAfterRender = true;
            return;
        }
        queueLoreRender();
    });
    const list = document.getElementById('world_popup_entries_list');
    if (list) loreObserver.observe(list, { childList: true });
    $('#world_editor_select').on('change.folderizer', () => {
        if (sort.value === LORE_SORT_VALUE) setTimeout(queueLoreRender, 0);
    });
    if (featureEnabled('lorebooks') && accountStorage.getItem(SORT_ORDER_KEY) === LORE_SORT_VALUE) {
        sort.value = LORE_SORT_VALUE;
        queueLoreRender();
    }
}

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
    const byId = new Map(scripts.map(script => [String(script.id), script]));
    const reordered = flattenLayout(layout).map(id => byId.get(id)).filter(Boolean);
    await saveScriptsByType(reordered, type);
}

async function exportRegexBundle(typeKey) {
    const { owner, layout } = readRegexLayout(typeKey);
    const type = REGEX_TYPES[typeKey].scriptType;
    const scripts = getScriptsByType(type).map(cloneJson);
    downloadJson({
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        scope: 'regex',
        typeKey,
        owner,
        layout: cloneJson(layout),
        scripts,
    }, bundleFilename(regexExportName(typeKey)));
    toastr.success('Folderizer 정규식 번들을 내보냈습니다.');
}

async function importRegexBundle(typeKey) {
    const bundle = await readJsonFile();
    if (!bundle || !assertBundle(bundle, 'regex')) return;
    if (!Array.isArray(bundle.scripts)) {
        toastr.error('Folderizer 정규식 번들에 정규식 데이터가 없습니다.');
        return;
    }
    if (bundle.typeKey && bundle.typeKey !== typeKey) {
        toastr.error(`이 번들은 ${REGEX_TYPES[bundle.typeKey]?.label || bundle.typeKey} 정규식 목록용입니다.`);
        return;
    }
    const label = REGEX_TYPES[typeKey].label;
    const confirmed = await Popup.show.confirm('정규식 번들 불러오기', `이 Folderizer 번들을 현재 ${label} 정규식 목록으로 불러올까요? 같은 이름의 정규식 스크립트는 대체되고, 나머지는 추가됩니다.`);
    if (!confirmed) return;

    const type = REGEX_TYPES[typeKey].scriptType;
    const owner = regexOwnerKey(typeKey);
    const currentScripts = getScriptsByType(type);
    const scriptsById = new Map(currentScripts
        .filter(script => script?.id)
        .map(script => [String(script.id), script]));
    const scriptsByName = new Map(currentScripts
        .filter(script => script?.scriptName)
        .map(script => [nameKey(script.scriptName), script]));
    const usedIds = new Set(scriptsById.keys());
    const idMap = new Map();
    bundle.scripts.filter(script => script).forEach(script => {
        const imported = cloneJson(script);
        const existing = scriptsByName.get(nameKey(imported.scriptName));
        const sourceId = String(imported.id || generateUUID());
        if (existing) {
            imported.id = existing.id;
        } else if (!imported.id || usedIds.has(String(imported.id))) {
            imported.id = generateUUID();
        }
        const targetId = String(imported.id);
        idMap.set(sourceId, targetId);
        usedIds.add(targetId);
        scriptsById.set(targetId, imported);
    });

    const currentLayout = normalizeLayout(null, currentScripts.map(script => String(script.id)).filter(Boolean));
    const importedLayout = remapImportedLayout(bundle.layout, idMap);
    const allIds = [...new Set([...currentScripts.map(script => String(script.id)).filter(Boolean), ...idMap.values()])];
    const layout = mergeImportedLayout(currentLayout, importedLayout, allIds);
    settings().layouts.regex[typeKey][owner] = layout;
    saveSettingsDebounced();
    const orderedScripts = flattenLayout(layout).map(id => scriptsById.get(id)).filter(Boolean);
    await saveScriptsByType(orderedScripts, type);
    if (getCurrentChatId()) await reloadCurrentChat();
    enhanceRegexLists();
    toastr.success('Folderizer 정규식 번들을 불러왔습니다.');
}

function regexLayoutFromDom(list, sourceLayout, typeKey) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const root = [];
    const folders = [];
    for (const element of list.children) {
        if (element.classList.contains('folderizer-folder')) {
            const id = element.dataset.folderizerId;
            const source = folderSource.get(id);
            if (!source) continue;
            const items = [...element.querySelector('.folderizer-folder-items').children]
                .map(item => item.id)
                .filter(Boolean);
            folders.push({ ...source, items });
            root.push({ type: 'folder', id });
        } else if (element.classList.contains('regex-script-label') && element.id) {
            root.push({ type: 'item', id: element.id });
        }
    }
    return normalizeLayout({ version: 1, root, folders }, regexItemIds(typeKey));
}

async function setRegexFolderEnabled(typeKey, layout, folderId, enabled) {
    const folder = layout.folders.find(value => value.id === folderId);
    if (!folder) return;
    const type = REGEX_TYPES[typeKey].scriptType;
    const scripts = getScriptsByType(type);
    const ids = new Set(folder.items);
    scripts.forEach(script => {
        if (ids.has(String(script.id))) script.disabled = !enabled;
    });
    await saveScriptsByType(scripts, type);
    saveSettingsDebounced();
    if (getCurrentChatId()) await reloadCurrentChat();
    enhanceRegexLists();
}

function unwrapRegexFolders(list) {
    const items = [...list.querySelectorAll('.regex-script-label')];
    list.innerHTML = '';
    items.forEach(item => list.append(item));
    list.closest('.inline-drawer-content, .regex_settings, #regex_container')?.querySelector('.folderizer-toolbar')?.remove();
}

function setupRegexSortable(typeKey, owner, layout) {
    const list = document.querySelector(REGEX_TYPES[typeKey].selector);
    if (!list) return;
    const folderItemsSelector = `.folderizer-regex-items[data-folderizer-regex-type="${typeKey}"]`;
    const $list = $(list);
    if ($list.sortable('instance')) $list.sortable('destroy');
    list.querySelectorAll('.folderizer-regex-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    let saving = false;
    const saveFromDom = async () => {
        if (saving) return;
        saving = true;
        try {
            list.querySelectorAll('.folderizer-folder').forEach(updateFolderCount);
            const next = regexLayoutFromDom(list, layout, typeKey);
            Object.assign(layout, next);
            await persistRegexLayout(typeKey, owner, layout);
            if (getCurrentChatId()) await reloadCurrentChat();
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save regex folder order`, error);
            debugLog('error', '정규식 폴더 순서 저장 실패', error);
            toastr.error('정규식 폴더 순서를 저장하지 못했습니다.');
        } finally {
            saving = false;
        }
    };

    let lastPointer = null;
    let lastFolderElement = null;
    let draggingRegexIntoFolder = false;
    let draggingRegexFolderId = null;
    const clearRegexDropState = () => {
        lastPointer = null;
        lastFolderElement = null;
        draggingRegexIntoFolder = false;
        draggingRegexFolderId = null;
        list.classList.remove('folderizer-dropping-into-folder');
        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
    };
    const rememberPointer = (event, ui) => {
        if (!draggingRegexIntoFolder) {
            list.classList.remove('folderizer-dropping-into-folder');
            list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
            return;
        }
        lastPointer = { x: event.clientX, y: event.clientY };
        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-regex-folder'))
            .find(Boolean);
        if (pointedFolder) lastFolderElement = pointedFolder;
        list.classList.toggle('folderizer-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
        pointedFolder?.classList.add('folderizer-drop-target');
        const placeholder = ui?.placeholder?.[0];
        const items = pointedFolder?.querySelector?.('.folderizer-regex-items');
        if (placeholder && items && !items.contains(placeholder)) items.append(placeholder);
    };
    const moveRegexIntoPointedFolder = item => {
        if (!item?.classList?.contains('regex-script-label') || !lastPointer) return;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-regex-folder'))
            .find(Boolean);
        const items = folderElement?.querySelector?.('.folderizer-regex-items');
        if (!items || items.contains(item)) return;
        items.append(item);
        updateFolderCount(folderElement);
    };
    const afterRegexSort = task => {
        setTimeout(() => {
            task().catch(error => {
                console.error(`[${EXTENSION_NAME}] Failed to finish regex folder sort`, error);
                debugLog('error', '정규식 폴더 정렬 완료 처리 실패', error);
                toastr.error('정규식 폴더 순서를 저장하지 못했습니다.');
                enhanceRegexLists();
            });
        }, 0);
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> .regex-script-label, > .folderizer-folder',
        placeholder: 'folderizer-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: (_, ui) => {
            const item = ui.item?.[0];
            sortingRegex = true;
            draggingRegexIntoFolder = item?.classList?.contains('regex-script-label') ?? false;
            draggingRegexFolderId = item?.classList?.contains('folderizer-folder') ? item.dataset.folderizerId : null;
        },
        sort: rememberPointer,
        stop: async (_, ui) => {
            afterRegexSort(async () => {
                try {
                    const item = ui.item?.[0];
                    if (draggingRegexFolderId && item?.parentElement !== list) {
                        enhanceRegexLists();
                        return;
                    }
                    moveRegexIntoPointedFolder(item);
                    await saveFromDom();
                } finally {
                    sortingRegex = false;
                    clearRegexDropState();
                }
            });
        },
    });
    list.querySelectorAll('.folderizer-regex-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> .regex-script-label',
            connectWith: `${REGEX_TYPES[typeKey].selector}, ${folderItemsSelector}`,
            placeholder: 'folderizer-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: (_, ui) => {
                const item = ui.item?.[0];
                sortingRegex = true;
                draggingRegexIntoFolder = item?.classList?.contains('regex-script-label') ?? false;
                draggingRegexFolderId = item?.classList?.contains('folderizer-folder') ? item.dataset.folderizerId : null;
            },
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('folderizer-folder')) $(ui.sender).sortable('cancel');
            },
            stop: async (_, ui) => {
                afterRegexSort(async () => {
                    try {
                        const item = ui.item?.[0];
                        if (item?.classList?.contains('folderizer-folder')) {
                            enhanceRegexLists();
                            return;
                        }
                        moveRegexIntoPointedFolder(item);
                        await saveFromDom();
                    } finally {
                        sortingRegex = false;
                        clearRegexDropState();
                    }
                });
            },
        });
    });
}

function enhanceRegexList(typeKey) {
    const list = document.querySelector(REGEX_TYPES[typeKey].selector);
    if (!list) return;
    if (!featureEnabled('regex')) {
        if (list.querySelector('.folderizer-folder')) unwrapRegexFolders(list);
        return;
    }
    const { owner, layout } = readRegexLayout(typeKey);
    const itemMap = new Map([...list.querySelectorAll('.regex-script-label')].map(element => [element.id, element]));
    if (!itemMap.size) return;
    itemMap.forEach(element => element.remove());
    const scriptsById = new Map(getScriptsByType(REGEX_TYPES[typeKey].scriptType).map(script => [String(script.id), script]));
    itemMap.forEach((element, id) => {
        const script = scriptsById.get(id);
        const toggle = element.querySelector('.disable_regex');
        if (script && toggle) toggle.checked = !!script.disabled;
    });
    const collapsed = ownerCollapsed('regex', `${typeKey}:${owner}`);
    const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));
    list.classList.add('folderizer-regex-root');

    const rerender = () => enhanceRegexLists();
    const onEdit = async id => {
        const folder = layout.folders.find(value => value.id === id);
        if (!folder) return;
        const values = await requestFolderSettings(layout, folder);
        if (!values) return;
        Object.assign(folder, values);
        await persistRegexLayout(typeKey, owner, layout, false);
        rerender();
    };
    const onDelete = async id => {
        const folder = layout.folders.find(value => value.id === id);
        if (!folder || !await Popup.show.confirm('폴더 삭제', `"${folder.name}" 폴더를 삭제하고 안의 정규식 스크립트는 최상위로 옮길까요?`)) return;
        removeFolder(layout, id);
        await persistRegexLayout(typeKey, owner, layout);
        rerender();
    };

    list.innerHTML = '';
    for (const node of layout.root) {
        if (node.type === 'item') {
            const item = itemMap.get(node.id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'regex',
                    layout,
                    itemId: node.id,
                    onMove: async () => {
                        await persistRegexLayout(typeKey, owner, layout);
                        rerender();
                    },
                });
                list.append(item);
            }
            continue;
        }
        const folder = folderMap.get(node.id);
        if (!folder) continue;
        const state = enabledState(folder.items.map(id => !scriptsById.get(id)?.disabled));
        const folderElement = createFolderElement(folder, {
            kind: 'regex',
            owner: `${typeKey}:${owner}`,
            collapsed,
            onEdit,
            onDelete,
            state,
            onStateToggle: async (id, currentState) => setRegexFolderEnabled(typeKey, layout, id, currentState !== 'on'),
        });
        const items = folderElement.querySelector('.folderizer-folder-items');
        items.dataset.folderizerRegexType = typeKey;
        folder.items.forEach(id => {
            const item = itemMap.get(id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'regex',
                    layout,
                    itemId: id,
                    onMove: async () => {
                        await persistRegexLayout(typeKey, owner, layout);
                        rerender();
                    },
                });
                items.append(item);
            }
        });
        updateFolderCount(folderElement);
        list.append(folderElement);
    }

    ensureToolbar(list.parentElement, `regex-${typeKey}`, async () => {
        const scriptsById = new Map(getScriptsByType(REGEX_TYPES[typeKey].scriptType)
            .filter(script => script?.id)
            .map(script => [String(script.id), script]));
        const candidates = rootItemIds(layout).map(id => ({
            id,
            label: scriptsById.get(id)?.scriptName || id,
        }));
        const values = await requestNewFolder(layout, candidates);
        if (!values) return;
        addFolderWithItems(layout, values.name, values.itemIds);
        await persistRegexLayout(typeKey, owner, layout, false);
        rerender();
    }, createBundleButtons(() => exportRegexBundle(typeKey), () => importRegexBundle(typeKey)));
    setupRegexSortable(typeKey, owner, layout);
}

function enhanceRegexLists() {
    if (enhancingRegex) return;
    const root = document.getElementById('regex_container');
    enhancingRegex = true;
    try {
        regexObserver?.disconnect();
        Object.keys(REGEX_TYPES).forEach(enhanceRegexList);
        regexObserver?.takeRecords();
    } finally {
        enhancingRegex = false;
        if (root && regexObserver) {
            regexObserver.observe(root, { childList: true, subtree: true });
        }
    }
}

function installRegexIntegration() {
    const root = document.getElementById('regex_container');
    if (!root) return;
    let regexRenderQueued = false;
    regexObserver = new MutationObserver(() => {
        if (enhancingRegex || sortingRegex || regexRenderQueued) return;
        regexRenderQueued = true;
        setTimeout(() => {
            regexRenderQueued = false;
            if (sortingRegex) return;
            enhanceRegexLists();
        }, 0);
    });
    regexObserver.observe(root, { childList: true, subtree: true });
    enhanceRegexLists();
}

function renderSettings() {
    if (document.getElementById('folderizer_settings')) return;
    const html = `
        <div id="folderizer_settings" class="folderizer-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Folderizer</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox flex-container">
                        <input id="folderizer_enable_prompts" type="checkbox">
                        <span>프롬프트 폴더</span>
                    </label>
                    <label class="checkbox flex-container">
                        <input id="folderizer_enable_lorebooks" type="checkbox">
                        <span>로어북 폴더</span>
                    </label>
                    <label class="checkbox flex-container">
                        <input id="folderizer_enable_regex" type="checkbox">
                        <span>정규식 폴더</span>
                    </label>
                    <details class="folderizer-settings-debug">
                        <summary>진단 도구</summary>
                        <div class="folderizer-settings-debug-content">
                            <label class="checkbox flex-container">
                                <input id="folderizer_debug_mode" type="checkbox">
                                <span>디버그 모드</span>
                            </label>
                            <div class="folderizer-settings-actions">
                                <button id="folderizer_debug_view" class="menu_button" type="button">로그 보기</button>
                                <button id="folderizer_debug_copy" class="menu_button" type="button">복사</button>
                                <button id="folderizer_debug_clear" class="menu_button" type="button">비우기</button>
                            </div>
                        </div>
                    </details>
                    <div class="folderizer-settings-clear">
                        <div class="folderizer-settings-subtitle">초기화</div>
                        <div class="folderizer-settings-actions">
                            <button id="folderizer_clear_prompts" class="menu_button" type="button">프롬프트</button>
                            <button id="folderizer_clear_lorebooks" class="menu_button" type="button">로어북</button>
                            <button id="folderizer_clear_regex" class="menu_button" type="button">정규식</button>
                            <button id="folderizer_clear_all" class="menu_button caution" type="button">전체</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    $('#extensions_settings2').append(html);

    const sync = () => {
        $('#folderizer_enable_prompts').prop('checked', featureEnabled('prompts'));
        $('#folderizer_enable_lorebooks').prop('checked', featureEnabled('lorebooks'));
        $('#folderizer_enable_regex').prop('checked', featureEnabled('regex'));
        $('#folderizer_debug_mode').prop('checked', debugEnabled());
    };
    const rerender = () => {
        promptManager?.render?.(false);
        queueLoreRender();
        enhanceRegexLists();
    };
    $('#folderizer_enable_prompts').on('input', function () {
        settings().features.prompts = !!this.checked;
        saveSettingsDebounced();
        debugLog('info', `프롬프트 폴더 ${this.checked ? '활성화' : '비활성화'}`);
        rerender();
    });
    $('#folderizer_enable_lorebooks').on('input', function () {
        settings().features.lorebooks = !!this.checked;
        saveSettingsDebounced();
        debugLog('info', `로어북 폴더 ${this.checked ? '활성화' : '비활성화'}`);
        if (!this.checked && $('#world_info_sort_order').val() === LORE_SORT_VALUE) {
            $('#world_info_sort_order').val('0').trigger('change');
        }
        rerender();
    });
    $('#folderizer_enable_regex').on('input', function () {
        settings().features.regex = !!this.checked;
        saveSettingsDebounced();
        debugLog('info', `정규식 폴더 ${this.checked ? '활성화' : '비활성화'}`);
        rerender();
    });
    $('#folderizer_debug_mode').on('input', function () {
        settings().debug = !!this.checked;
        saveSettingsDebounced();
        installDebugListeners();
        debugLog('info', `디버그 모드 ${this.checked ? '활성화' : '비활성화'}`);
    });
    $('#folderizer_debug_view').on('click', showDebugLog);
    $('#folderizer_debug_copy').on('click', copyDebugLog);
    $('#folderizer_debug_clear').on('click', () => {
        debugLogEntries.splice(0, debugLogEntries.length);
        toastr.success('Folderizer 디버그 로그를 비웠습니다.');
    });
    $('#folderizer_clear_prompts').on('click', async () => {
        if (!await Popup.show.confirm('프롬프트 폴더 데이터 초기화', '프롬프트 순서는 유지하고 Folderizer 프롬프트 배치만 삭제합니다.')) return;
        settings().layouts.prompts = {};
        settings().collapsed.prompt = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#folderizer_clear_lorebooks').on('click', async () => {
        if (!await Popup.show.confirm('로어북 폴더 데이터 초기화', '로어북 항목은 유지하고 Folderizer 로어북 배치만 삭제합니다.')) return;
        settings().layouts.lorebooks = {};
        settings().collapsed.lore = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#folderizer_clear_regex').on('click', async () => {
        if (!await Popup.show.confirm('정규식 폴더 데이터 초기화', '정규식 스크립트는 유지하고 Folderizer 정규식 배치만 삭제합니다.')) return;
        settings().layouts.regex = { global: {}, scoped: {}, preset: {} };
        settings().collapsed.regex = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#folderizer_clear_all').on('click', async () => {
        if (!await Popup.show.confirm('모든 Folderizer 데이터 초기화', '원본 항목은 유지하고 Folderizer 배치와 접힘 상태만 삭제합니다.')) return;
        settings().layouts = { prompts: {}, lorebooks: {}, regex: { global: {}, scoped: {}, preset: {} } };
        settings().collapsed = { prompt: {}, lore: {}, regex: {} };
        saveSettingsDebounced();
        rerender();
    });
    sync();
}

export async function init() {
    settings();
    installDebugListeners();
    debugLog('info', 'Folderizer 초기화 시작');
    renderSettings();
    installLorebookIntegration();
    installRegexIntegration();
    eventSource.on(event_types.PRESET_RENAMED_BEFORE, ({ apiId, oldName, newName }) => {
        const oldPromptKey = `${apiId}:${oldName}`;
        const newPromptKey = `${apiId}:${newName}`;
        if (settings().layouts.prompts[oldPromptKey] && !settings().layouts.prompts[newPromptKey]) {
            settings().layouts.prompts[newPromptKey] = settings().layouts.prompts[oldPromptKey];
            delete settings().layouts.prompts[oldPromptKey];
            saveSettingsDebounced();
        }
    });
    eventSource.on(event_types.PRESET_CHANGED, () => {
        promptManager?.render?.(false);
        enhanceRegexLists();
    });
    eventSource.on(event_types.CHAT_CHANGED, enhanceRegexLists);
    try {
        await installPromptIntegration();
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to initialize prompt folders`, error);
        debugLog('error', '프롬프트 폴더 초기화 실패', error);
    }
}
