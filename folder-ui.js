import { folderStyleValues } from './folder-style.js';

export { folderStyleValues } from './folder-style.js';

export function createIconButton(icon, title, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button fa-solid ${icon} ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
}

export function createLabeledIconButton(icon, title, label, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button foldy-labeled-button ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    const iconElement = document.createElement('span');
    iconElement.className = `fa-solid ${icon}`;
    const labelElement = document.createElement('span');
    labelElement.textContent = label;
    button.append(iconElement, labelElement);
    return button;
}

export function bindAction(button, label, handler, {
    withErrorToast,
    preventDefault = true,
    stopPropagation = true,
} = {}) {
    button.addEventListener('click', async event => {
        if (preventDefault) event.preventDefault();
        if (stopPropagation) event.stopPropagation();
        const action = () => handler(event);
        if (typeof withErrorToast === 'function') {
            await withErrorToast(label, action);
            return;
        }
        await action();
    });
    return button;
}

export function updateFolderCount(folderElement, { itemIdFromElement = null, isItemEnabled = null } = {}) {
    const children = [...(folderElement.querySelector('.foldy-folder-items')?.children || [])];
    const count = children.length;
    const countElement = folderElement.querySelector('.foldy-folder-count');
    if (!countElement) return;
    if (typeof isItemEnabled !== 'function') {
        countElement.textContent = folderCountText({ total: count });
        return;
    }
    const enabled = children.filter(child => isItemEnabled(
        typeof itemIdFromElement === 'function'
            ? itemIdFromElement(child)
            : child.dataset?.pmIdentifier ?? child.id,
    )).length;
    countElement.textContent = folderCountText({ enabled, total: count });
}

export function folderCountText({ enabled = null, total = 0 } = {}) {
    if (Number.isFinite(enabled)) return `${enabled}/${total}`;
    return String(total);
}

export function enabledItemCount(itemIds = [], isItemEnabled = null) {
    if (typeof isItemEnabled !== 'function') return null;
    return itemIds.filter(id => isItemEnabled(id)).length;
}

export function closeOpenFolderMenus(root = document) {
    if (!root) return;
    root.querySelectorAll?.('.foldy-folder.is-actions-open').forEach(element => {
        if (typeof element.__foldyCloseActions === 'function') {
            element.__foldyCloseActions();
            return;
        }
        element.classList.remove('is-actions-open');
        element.querySelector('.foldy-folder-more')?.setAttribute('aria-expanded', 'false');
    });
}

export function applyFolderStyleToAll(layout, sourceFolderId, style) {
    for (const folder of layout.folders) {
        if (folder.id === sourceFolderId) continue;
        Object.assign(folder, folderStyleValues(style));
    }
}

export function enabledState(values) {
    if (!values.length) return 'off';
    const enabledCount = values.filter(Boolean).length;
    if (enabledCount === 0) return 'off';
    if (enabledCount === values.length) return 'on';
    return 'mixed';
}

export function shouldShowMixedStateBadge(kind, state) {
    return kind === 'regex' && state === 'mixed';
}

export function createSelectionToolbar(list, titleText = '제목') {
    const toolbar = document.createElement('label');
    toolbar.className = 'foldy-selection-toolbar';
    const master = document.createElement('input');
    master.type = 'checkbox';
    const title = document.createElement('span');
    title.className = 'foldy-selection-title';
    title.textContent = titleText;
    const syncHeader = () => {
        const boxes = [...list.querySelectorAll('input[type="checkbox"]')];
        const checked = boxes.filter(input => input.checked).length;
        master.disabled = !boxes.length;
        master.checked = boxes.length > 0 && checked === boxes.length;
        master.indeterminate = checked > 0 && checked < boxes.length;
    };
    master.addEventListener('input', () => {
        list.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = master.checked; });
        syncHeader();
    });
    list.addEventListener('input', syncHeader);
    toolbar.append(master, title);
    queueMicrotask(syncHeader);
    return {
        toolbar,
        sync: syncHeader,
        setTitle: value => { title.textContent = value; },
    };
}

export function appendSelectionRow(label, checkbox, text) {
    label.append(checkbox, text);
}

export const DEFAULT_PICKER_COLOR = '#7c6ee6';

export function isHexColor(value) {
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value ?? '').trim());
}

export function isColorValue(value) {
    const color = String(value ?? '').trim();
    if (color.startsWith('#')) return isHexColor(color);
    return color.toLowerCase() === 'transparent'
        || isHexColor(color)
        || globalThis.CSS?.supports?.('color', color)
        || false;
}

export function normalizeColor(value, fallback = '') {
    const color = String(value ?? '').trim();
    if (!color) return fallback;
    if (color.toLowerCase() === 'transparent') return 'transparent';
    if (color.startsWith('#') && !isHexColor(color)) return fallback;
    if (isHexColor(color) && (color.length === 4 || color.length === 5)) {
        return `#${[...color.slice(1)].map(part => `${part}${part}`).join('')}`.toLowerCase();
    }
    if (isHexColor(color)) return color.toLowerCase();
    return globalThis.CSS?.supports?.('color', color) ? color : fallback;
}

export function pickerColor(value, fallback = DEFAULT_PICKER_COLOR) {
    const color = normalizeColor(value, fallback);
    return color === 'transparent' ? 'rgba(0, 0, 0, 0)' : color;
}

let colorProbe = null;

export function cssColorToHex(value, fallback = DEFAULT_PICKER_COLOR) {
    colorProbe ??= document.createElement('span');
    colorProbe.style.display = 'none';
    colorProbe.style.color = value;
    colorProbe.dataset.foldyColorProbe = 'true';
    const owner = document.getElementById('foldy_settings') || document.body;
    if (!colorProbe.isConnected || colorProbe.parentElement !== owner) owner.append(colorProbe);
    try {
        const color = getComputedStyle(colorProbe).color;
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?/i);
        if (!match) return fallback;
        const hex = [match[1], match[2], match[3]].map(part => Number(part).toString(16).padStart(2, '0')).join('');
        const alpha = match[4] == null ? 1 : Number(match[4]);
        if (!Number.isFinite(alpha) || alpha >= 1) return `#${hex}`;
        return `#${hex}${Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0')}`;
    } catch {
        return fallback;
    }
}

export function themeColorHex(variableName, fallback = DEFAULT_PICKER_COLOR) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
    return cssColorToHex(value || fallback, fallback);
}

export function createColorSetting(labelText, initialValue, pickerFallback = DEFAULT_PICKER_COLOR) {
    const field = document.createElement('label');
    field.className = 'foldy-color-field';

    const label = document.createElement('span');
    label.textContent = labelText;

    const controls = document.createElement('span');
    controls.className = 'foldy-color-controls';

    const picker = document.createElement('toolcool-color-picker');
    picker.setAttribute('color', pickerColor(initialValue, pickerFallback));

    const hex = document.createElement('input');
    hex.type = 'text';
    hex.value = normalizeColor(initialValue);
    hex.placeholder = '#fff, #ffffff, transparent, rgba(...)';
    hex.spellcheck = false;

    const reset = document.createElement('button');
    reset.className = 'menu_button foldy-color-reset';
    reset.type = 'button';
    reset.textContent = '기본값';
    reset.title = '테마 기본값으로 되돌리기';
    reset.setAttribute('aria-label', '테마 기본값으로 되돌리기');

    const syncPicker = value => {
        const next = pickerColor(value, pickerFallback);
        picker.setAttribute('color', next);
        picker.color = next;
    };

    picker.addEventListener('change', event => {
        if (document.activeElement === hex) return;
        hex.value = event.detail?.rgba || picker.getAttribute('color') || '';
    });
    hex.addEventListener('input', () => {
        const value = normalizeColor(hex.value);
        if (!value) return;
        syncPicker(value);
    });
    reset.addEventListener('click', () => {
        hex.value = '';
        syncPicker('');
    });

    controls.append(picker, hex, reset);
    field.append(label, controls);

    return {
        field,
        value: () => normalizeColor(hex.value),
        isValid: () => !hex.value.trim() || isColorValue(hex.value),
        reset: () => {
            hex.value = '';
            syncPicker('');
        },
    };
}

export function setStateButtonIcon(button, state) {
    button.classList.toggle('fa-toggle-on', state === 'on' || state === 'mixed');
    button.classList.toggle('fa-toggle-off', state === 'off');
    button.classList.remove('fa-circle-half-stroke');
    button.dataset.state = state;
    button.title = state === 'on' ? '이 폴더의 모든 항목 비활성화' : '이 폴더의 모든 항목 활성화';
}

export function createFolderElement(folder, {
    kind,
    owner,
    collapsed,
    onEdit,
    onDelete,
    onStateToggle,
    state = null,
    onBulkMove = null,
    onCollapseChange = null,
    extraButtons = [],
    ownerCollapsed,
    saveCollapsed,
    withErrorToast,
}) {
    const element = document.createElement(kind === 'regex' ? 'div' : 'li');
    element.className = `foldy-folder foldy-${kind}-folder`;
    element.dataset.foldyId = folder.id;
    const backgroundColor = normalizeColor(folder.color);
    const borderColor = normalizeColor(folder.borderColor);
    if (backgroundColor) element.style.setProperty('--foldy-background-color', backgroundColor);
    if (borderColor) element.style.setProperty('--foldy-border-color', borderColor);
    element.style.setProperty('--foldy-name-color', normalizeColor(folder.nameColor) || 'var(--SmartThemeBodyColor)');

    const header = document.createElement('div');
    header.className = 'foldy-folder-header';

    const drag = document.createElement('span');
    drag.className = 'foldy-drag drag-handle fa-solid fa-bars';
    drag.title = '폴더 이동';

    const name = document.createElement('span');
    name.className = 'foldy-folder-name';
    name.textContent = folder.name;
    name.title = folder.name;

    const count = document.createElement('span');
    count.className = 'foldy-folder-count';
    count.textContent = String(folder.items.length);

    const mixedBadge = document.createElement('span');
    mixedBadge.className = 'foldy-state-badge';
    mixedBadge.textContent = '!';
    mixedBadge.title = '활성/비활성 항목이 섞여 있습니다';
    mixedBadge.setAttribute('aria-label', '활성/비활성 항목이 섞여 있습니다');

    const edit = createIconButton('fa-pencil', '폴더 편집');
    edit.addEventListener('click', () => withErrorToast('폴더 편집', () => onEdit(folder.id)));

    const bulkMove = createIconButton('fa-folder-tree', '일괄 이동', 'foldy-bulk-move');
    bulkMove.addEventListener('click', () => withErrorToast('일괄 이동', () => onBulkMove?.(folder.id)));

    const remove = createIconButton('fa-trash', '폴더 삭제', 'caution');
    remove.addEventListener('click', () => withErrorToast('폴더 삭제', () => onDelete(folder.id)));

    const collapse = createIconButton('fa-chevron-down', '폴더 접기');
    collapse.classList.add('foldy-collapse-toggle');
    const more = createIconButton('fa-ellipsis-vertical', '폴더 메뉴', 'foldy-folder-more');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    const actions = document.createElement('div');
    actions.className = 'foldy-folder-actions';
    actions.setAttribute('role', 'menu');
    let outsideClickAbort = null;
    const closeActions = () => {
        element.classList.remove('is-actions-open');
        more.setAttribute('aria-expanded', 'false');
        outsideClickAbort?.abort();
        outsideClickAbort = null;
    };
    element.__foldyCloseActions = closeActions;
    const watchOutsideClick = () => {
        outsideClickAbort?.abort();
        outsideClickAbort = new AbortController();
        document.addEventListener('click', event => {
            if (!element.contains(event.target)) closeActions();
        }, { signal: outsideClickAbort.signal });
    };
    const items = document.createElement(kind === 'regex' ? 'div' : 'ul');
    items.className = `foldy-folder-items foldy-${kind}-items`;

    if (collapsed.has(folder.id)) {
        element.classList.add('is-collapsed');
        collapse.classList.replace('fa-chevron-down', 'fa-chevron-right');
    }

    const toggleCollapsed = () => {
        const isCollapsed = element.classList.toggle('is-collapsed');
        collapse.classList.toggle('fa-chevron-down', !isCollapsed);
        collapse.classList.toggle('fa-chevron-right', isCollapsed);
        const values = ownerCollapsed(kind, owner);
        isCollapsed ? values.add(folder.id) : values.delete(folder.id);
        saveCollapsed(kind, owner, values);
        onCollapseChange?.(folder.id, isCollapsed);
    };

    collapse.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggleCollapsed();
    });
    more.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = !element.classList.contains('is-actions-open');
        closeOpenFolderMenus(element.closest('.foldy-folder-items, #completion_prompt_manager_list, #world_popup_entries_list, #regex_container'));
        element.classList.toggle('is-actions-open', shouldOpen);
        more.setAttribute('aria-expanded', String(shouldOpen));
        if (shouldOpen) watchOutsideClick();
        else closeActions();
    });
    actions.addEventListener('click', event => {
        if (event.target.closest?.('button')) closeActions();
    });

    header.addEventListener('click', event => {
        const interactive = event.target.closest?.('button, input, select, textarea, a, .foldy-drag, .drag-handle, .foldy-folder-actions');
        if (interactive) return;
        event.preventDefault();
        closeActions();
        toggleCollapsed();
    });

    header.append(drag, collapse);
    if (onStateToggle) {
        header.classList.add('has-state-toggle');
        if (shouldShowMixedStateBadge(kind, state)) header.classList.add('has-mixed-state');
        const stateButton = createIconButton('fa-toggle-off', '폴더 항목 켜기/끄기', 'foldy-state-toggle');
        setStateButtonIcon(stateButton, state);
        stateButton.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            stateButton.disabled = true;
            try {
                await withErrorToast('폴더 상태 변경', () => onStateToggle(folder.id, stateButton.dataset.state));
            } finally {
                stateButton.disabled = false;
            }
        });
        actions.append(stateButton);
    }
    if (shouldShowMixedStateBadge(kind, state)) {
        header.append(name, count, mixedBadge);
    } else {
        header.append(name, count);
    }
    if (extraButtons.length) actions.append(...extraButtons);
    if (onBulkMove) {
        header.classList.add('has-bulk-move');
        actions.append(bulkMove);
    }
    actions.append(edit, remove);
    header.append(more, actions);
    element.append(header, items);
    return element;
}
