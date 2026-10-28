import { BORDER_SIDES, borderSidesValue, folderBorder, folderStyleValues } from './folder-style.js';

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

export function setCollapseButtonState(button, isCollapsed) {
    button.classList.toggle('fa-chevron-down', !isCollapsed);
    button.classList.toggle('fa-chevron-right', isCollapsed);
    const title = isCollapsed ? '폴더 펼치기' : '폴더 접기';
    button.title = title;
    button.setAttribute('aria-label', title);
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
    const children = [...(folderElement.querySelector('.foldy-folder-items')?.children || [])]
        .filter(child => !child.classList?.contains('foldy-divider'));
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

const FOLDY_MOBILE_MENU_QUERY = '(max-width: 700px)';

function isFoldyMobileMenuActive() {
    return typeof window.matchMedia === 'function' && window.matchMedia(FOLDY_MOBILE_MENU_QUERY).matches;
}

function stopPortaledMenuPointerPropagation(event) {
    if (event.currentTarget.classList.contains('foldy-folder-actions-portal')) {
        event.stopPropagation();
    }
}

// 모바일 드로어의 backdrop-filter가 fixed 메뉴를 가리지 않도록 body로 옮긴다.
function openFoldyFolderMenu(anchor, actions) {
    if (!isFoldyMobileMenuActive()) return;
    const header = actions.parentElement;
    actions.__foldyHomeParent = header;
    actions.__foldyHomeNext = actions.nextSibling;
    document.body.appendChild(actions);
    actions.classList.add('foldy-folder-actions-portal');
    positionFoldyFolderMenu(anchor, actions);
}

function positionFoldyFolderMenu(anchor, actions) {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    actions.style.top = '0px';
    actions.style.left = '0px';
    actions.style.maxWidth = `${window.innerWidth - margin * 2}px`;
    const actionsRect = actions.getBoundingClientRect();
    const maxLeft = window.innerWidth - actionsRect.width - margin;
    const left = Math.max(margin, Math.min(rect.right - actionsRect.width, maxLeft));
    const maxTop = window.innerHeight - actionsRect.height - margin;
    const top = Math.max(margin, Math.min(rect.bottom + 4, maxTop));
    actions.style.left = `${left}px`;
    actions.style.top = `${top}px`;
}

function closeFoldyFolderMenu(actions) {
    if (!actions.classList.contains('foldy-folder-actions-portal')) return;
    actions.classList.remove('foldy-folder-actions-portal');
    actions.style.removeProperty('top');
    actions.style.removeProperty('left');
    actions.style.removeProperty('max-width');
    const home = actions.__foldyHomeParent;
    if (home) home.insertBefore(actions, actions.__foldyHomeNext || null);
    actions.__foldyHomeParent = null;
    actions.__foldyHomeNext = null;
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

    const reset = createIconButton('fa-rotate-left', '기본값', 'foldy-color-reset');

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
    // 선택기는 색을 바꾸는 즉시 change를 보내 입력칸을 다시 채우므로, 입력칸은 마지막에 비운다.
    const clear = () => {
        syncPicker('');
        hex.value = '';
    };
    reset.addEventListener('click', clear);

    controls.append(picker, hex, reset);
    field.append(label, controls);
    picker.setAttribute('button-padding', '0');

    return {
        field,
        value: () => normalizeColor(hex.value),
        isValid: () => !hex.value.trim() || isColorValue(hex.value),
        // 선택기 버튼은 기본 3rem×1.5rem이라, 화면에 그려진 뒤 입력칸 높이의 정사각형으로 맞춘다.
        fitSwatch: () => {
            if (!hex.offsetHeight) return;
            const size = `${hex.offsetHeight}px`;
            picker.setAttribute('button-width', size);
            picker.setAttribute('button-height', size);
        },
        reset: clear,
    };
}

// label로 감싸면 라벨 클릭이 첫 컨트롤을 누르므로, 컨트롤이 여럿인 줄은 div로 만든다.
export function createSettingRow(labelText, ...controls) {
    const field = document.createElement('div');
    field.className = 'foldy-setting-row';
    const label = document.createElement('span');
    label.textContent = labelText;
    const group = document.createElement('span');
    group.className = 'foldy-setting-controls';
    group.append(...controls);
    field.append(label, group);
    return field;
}

export function createSelectSetting(options, initialValue = '') {
    const select = document.createElement('select');
    select.className = 'text_pole';
    options.forEach(([value, text]) => select.append(new Option(text, value)));
    select.value = initialValue;
    return {
        select,
        value: () => select.value,
        reset: () => {
            select.value = '';
        },
    };
}

export function createBorderSidesSetting(labelText, initialSides) {
    const buttons = document.createElement('span');
    buttons.className = 'foldy-border-sides';
    const names = { top: '위', bottom: '아래', left: '왼쪽', right: '오른쪽' };
    const setOn = (button, on) => {
        // toggleEnabled는 실리태번과 테마가 켜진 버튼에 쓰는 표시다.
        button.classList.toggle('is-on', on);
        button.classList.toggle('toggleEnabled', on);
        button.setAttribute('aria-pressed', String(on));
    };
    const toggles = ['top', 'bottom', 'left', 'right'].map(side => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button foldy-border-side';
        button.dataset.side = side;
        button.textContent = names[side];
        setOn(button, initialSides.includes(side));
        button.addEventListener('click', () => setOn(button, !button.classList.contains('is-on')));
        return button;
    });
    buttons.append(...toggles);
    return {
        field: createSettingRow(labelText, buttons),
        value: () => borderSidesValue(toggles.filter(button => button.classList.contains('is-on')).map(button => button.dataset.side)),
        reset: () => toggles.forEach(button => setOn(button, true)),
    };
}

function createDividerElement(kind, onRemove, withErrorToast) {
    const element = document.createElement(kind === 'regex' ? 'div' : 'li');
    element.className = 'foldy-divider';
    const line = document.createElement('span');
    line.className = 'foldy-divider-line drag-handle';
    line.title = '구분선 이동';
    const remove = createIconButton('fa-xmark', '구분선 삭제', 'foldy-divider-remove');
    remove.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        withErrorToast('구분선 삭제', () => onRemove(element));
    });
    element.append(line, remove);
    return element;
}

// 폴더 항목이 전부 그려졌을 때만 구분선을 넣고, 저장할 때 화면 위치를 다시 읽는다.
export function renderFolderDividers(folderElement, folder) {
    const options = folderElement?.__foldyDividerOptions;
    const items = folderElement?.querySelector('.foldy-folder-items');
    if (!options || !items) return;
    items.querySelectorAll(':scope > .foldy-divider').forEach(element => element.remove());
    delete items.dataset.foldyDividers;
    const rendered = new Map();
    for (const child of items.children) {
        const id = options.itemIdFromElement(child);
        if (id) rendered.set(String(id), child);
    }
    const folderItems = folder.items.map(String);
    if (rendered.size !== folderItems.length || !folderItems.every(id => rendered.has(id))) return;
    const onRemove = element => {
        element.remove();
        return options.onDividersChange(folder.id, dividersFromFolderElement(folderElement) ?? []);
    };
    for (const anchor of folder.dividers || []) {
        const divider = createDividerElement(options.kind, onRemove, options.withErrorToast);
        if (!anchor) items.prepend(divider);
        else rendered.get(anchor)?.after(divider);
    }
    items.dataset.foldyDividers = 'true';
}

export function dividersFromFolderElement(folderElement) {
    const options = folderElement?.__foldyDividerOptions;
    const items = folderElement?.querySelector('.foldy-folder-items');
    if (!options || items?.dataset.foldyDividers !== 'true') return undefined;
    let previous = '';
    const dividers = [];
    for (const child of items.children) {
        if (child.classList.contains('foldy-divider')) {
            dividers.push(previous);
            continue;
        }
        const id = options.itemIdFromElement(child);
        if (id) previous = String(id);
    }
    return dividers;
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
    itemIdFromElement = null,
    onDividersChange = null,
    onEditDividers = null,
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
    const border = folderBorder(folder);
    if (border.style) element.style.setProperty('--foldy-border-style', border.style);
    if (border.width || border.sides.length < BORDER_SIDES.length) {
        const width = `${border.width || 1}px`;
        BORDER_SIDES.forEach(side => element.style.setProperty(`--foldy-border-${side}`, border.sides.includes(side) ? width : '0px'));
    }
    // 한쪽만 그린 테두리는 둥근 모서리에서 선 끝이 휘어 보인다.
    element.classList.toggle('foldy-partial-border', border.sides.length < BORDER_SIDES.length);

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

    const addDivider = createIconButton('fa-grip-lines', '구분선', 'foldy-add-divider');
    addDivider.addEventListener('click', () => withErrorToast('구분선 편집', () => onEditDividers(folder.id)));

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
    actions.addEventListener('touchstart', stopPortaledMenuPointerPropagation, { passive: true });
    actions.addEventListener('mousedown', stopPortaledMenuPointerPropagation);
    let outsideClickAbort = null;
    const closeActions = () => {
        element.classList.remove('is-actions-open');
        more.setAttribute('aria-expanded', 'false');
        outsideClickAbort?.abort();
        outsideClickAbort = null;
        closeFoldyFolderMenu(actions);
    };
    element.__foldyCloseActions = closeActions;
    const watchOutsideClick = () => {
        outsideClickAbort?.abort();
        outsideClickAbort = new AbortController();
        const { signal } = outsideClickAbort;
        document.addEventListener('click', event => {
            if (!element.contains(event.target) && !actions.contains(event.target)) closeActions();
        }, { signal });
        // fixed 메뉴가 스크롤로 앵커와 어긋나면 닫는다.
        document.addEventListener('scroll', closeActions, { signal, capture: true, passive: true });
        window.addEventListener('resize', closeActions, { signal });
    };
    const items = document.createElement(kind === 'regex' ? 'div' : 'ul');
    items.className = `foldy-folder-items foldy-${kind}-items`;

    if (collapsed.has(folder.id)) {
        element.classList.add('is-collapsed');
        setCollapseButtonState(collapse, true);
    }

    const toggleCollapsed = () => {
        const isCollapsed = element.classList.toggle('is-collapsed');
        setCollapseButtonState(collapse, isCollapsed);
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
        if (shouldOpen) {
            openFoldyFolderMenu(more, actions);
            watchOutsideClick();
        } else {
            closeActions();
        }
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
    if (onDividersChange && itemIdFromElement) {
        element.__foldyDividerOptions = { kind, itemIdFromElement, onDividersChange, withErrorToast };
        if (onEditDividers) actions.append(addDivider);
    }
    actions.append(edit, remove);
    header.append(more, actions);
    element.append(header, items);
    return element;
}
