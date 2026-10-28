import { bindAction, closeOpenFolderMenus, createIconButton, updateFolderCount } from './folder-ui.js';
import { destroyFolderSortables, setupFolderSortables } from './folder-sortables.js';
import {
    flattenLayout,
    layoutFromTree,
    layoutWithAddedFolder,
    layoutWithItemMovedToFolder,
    layoutWithItemsMovedToFolder,
    layoutWithMovedFolder,
    layoutWithUpdatedFolder,
    normalizeLayout,
    removeFolder,
    rootItemIds,
} from './model.js';

export const BOOK_HOME_OWNER = 'home';

const HOME_TOOL_IDS = ['foldy_book_create', 'foldy_book_expand_all', 'foldy_book_collapse_all', 'foldy_book_root_bulk_move'];

// 저장된 배치에 없던 로어북은 이름순 이웃 근처가 아니라 맨 아래 폴더 밖에 붙인다.
export function normalizeBookLayout(rawLayout, names) {
    const known = new Set(rawLayout && typeof rawLayout === 'object' ? flattenLayout(rawLayout).map(String) : []);
    const layout = normalizeLayout(rawLayout, names.filter(name => known.has(name)));
    names.filter(name => !known.has(name)).forEach(name => layout.root.push({ type: 'item', id: name }));
    return layout;
}

export function renameBookInLayout(layout, oldName, newName) {
    if (!layout || !oldName || !newName || oldName === newName) return null;
    const ids = flattenLayout(layout).map(String);
    if (!ids.includes(oldName) || ids.includes(newName)) return null;
    const rename = id => (String(id) === oldName ? newName : id);
    return {
        ...layout,
        root: layout.root.map(node => (node.type === 'item' ? { ...node, id: rename(node.id) } : node)),
        folders: layout.folders.map(folder => ({ ...folder, items: folder.items.map(rename) })),
    };
}

export function bookMatchesQuery(name, query) {
    if (!query) return true;
    return String(name).toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

export function bookLayoutFromDom(list, sourceLayout, names) {
    const nodes = [];
    for (const element of list.children) {
        if (element.classList.contains('foldy-folder')) {
            const itemIds = [...(element.querySelector('.foldy-folder-items')?.children || [])]
                .map(item => item.dataset?.foldyBook)
                .filter(Boolean);
            nodes.push({ type: 'folder', id: element.dataset.foldyId, itemIds });
        } else if (element.dataset?.foldyBook) {
            nodes.push({ type: 'item', id: element.dataset.foldyBook });
        }
    }
    return layoutFromTree(nodes, sourceLayout, names);
}

export function createLorebookHome({
    featureEnabled,
    settings,
    saveSettingsDebounced,
    getWorldNames,
    syncOwners,
    updateWorldInfoList,
    createFolderElement,
    ownerCollapsed,
    saveCollapsed,
    requestNewFolder,
    requestFolderSettings,
    requestFlexibleBulkMove,
    createRootBulkMoveButton,
    confirmText,
    shouldRejectDomLayout,
    waitUntilCondition,
    getSortableDelay,
    withErrorToast,
    debugLog,
}) {
    let list = null;
    let homeButton = null;
    let optionsObserver = null;
    let listenersAbort = null;
    let searchTimer = 0;
    let sorting = false;
    let renderPending = false;
    let lastBook = '';
    let savedScroll = 0;

    const enabled = () => featureEnabled('lorebookHome');
    const scrollContainer = () => document.getElementById('WorldInfo');
    const selectedValue = () => String($('#world_editor_select').val() ?? '');
    const isHomeVisible = () => Boolean(list && !list.hidden);

    function bookNames() {
        return [...new Set((getWorldNames() || []).map(name => String(name || '')).filter(Boolean))];
    }

    function activeNames() {
        const names = getWorldNames() || [];
        return new Set([].concat($('#world_info').val() || []).map(index => names[Number(index)]).filter(Boolean));
    }

    function readLayout() {
        return normalizeBookLayout(settings().layouts.books[BOOK_HOME_OWNER], bookNames());
    }

    function persist(layout) {
        settings().layouts.books[BOOK_HOME_OWNER] = layout;
        saveSettingsDebounced();
    }

    function openBook(name) {
        const index = (getWorldNames() || []).indexOf(name);
        if (index === -1) return;
        lastBook = name;
        $('#world_editor_select').val(String(index)).trigger('change');
    }

    function goHome() {
        $('#world_editor_select').val('').trigger('change');
    }

    function createBookRow(name, active) {
        const row = document.createElement('li');
        row.className = 'foldy-book-row';
        row.dataset.foldyBook = name;
        row.classList.toggle('is-active', active.has(name));
        row.classList.toggle('is-last-opened', name === lastBook);
        const drag = document.createElement('span');
        drag.className = 'drag-handle fa-solid fa-bars';
        drag.title = '로어북 이동';
        const label = document.createElement('span');
        label.className = 'foldy-book-name';
        label.textContent = name;
        label.title = name;
        row.append(drag, label);
        return row;
    }

    function setupSortables(layout, names) {
        const saveFromDom = async () => {
            list.querySelectorAll('.foldy-folder').forEach(element => updateFolderCount(element));
            const next = bookLayoutFromDom(list, layout, names);
            if (shouldRejectDomLayout(layout, next, '로어북 홈')) {
                render();
                return;
            }
            Object.assign(layout, next);
            persist(layout);
        };
        setupFolderSortables({
            list,
            nestedItemsSelector: '.foldy-book-items',
            rootSortableItems: '> .foldy-book-row, > .foldy-folder',
            nestedSortableItems: '> .foldy-book-row',
            connectWith: '#foldy_book_home, .foldy-book-items',
            folderHitSelector: '.foldy-book-folder',
            folderItemsSelector: '.foldy-book-items',
            isItemElement: item => Boolean(item?.dataset?.foldyBook),
            itemIdFromElement: item => item?.dataset?.foldyBook,
            getSortableDelay,
            setSorting: value => {
                sorting = value;
                if (!value && renderPending) {
                    renderPending = false;
                    setTimeout(render, 0);
                }
            },
            rerender: () => render(),
            saveFromDom,
            moveItemToFolder: async (itemId, folderId) => {
                const result = layoutWithItemMovedToFolder(layout, itemId, folderId);
                if (!result.changed) return;
                Object.assign(layout, result.layout);
                persist(layout);
            },
            debugLog,
            domainLabel: '로어북 홈',
            positionPlaceholderInFolder: true,
            dataKey: 'foldyBookSortable',
        });
    }

    function destroySortables() {
        if (list) destroyFolderSortables(list, '.foldy-book-items', { dataKey: 'foldyBookSortable' });
    }

    function render() {
        if (!isHomeVisible()) return;
        if (sorting) {
            renderPending = true;
            return;
        }
        const container = scrollContainer();
        const scrollTop = container?.scrollTop ?? 0;
        const names = bookNames();
        const layout = readLayout();
        const query = String($('#world_info_search').val() ?? '').trim();
        const visible = new Set(names.filter(name => bookMatchesQuery(name, query)));
        const active = activeNames();
        const collapsed = ownerCollapsed('book', BOOK_HOME_OWNER);
        const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));
        const labels = new Map(names.map(name => [name, name]));

        const onEdit = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder) return;
            const values = await requestFolderSettings(layout, folder, names.map(name => ({ id: name, label: name })), { kind: 'lorebooks' });
            if (!values) return;
            const { applyStyleToAll, afterKey, ...folderValues } = values;
            const updated = layoutWithUpdatedFolder(layout, folder.id, folderValues, { applyStyleToAll });
            persist(layoutWithMovedFolder(updated.layout, folder.id, afterKey).layout);
            render();
        };
        const onDelete = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder) return;
            if (!await confirmText(`"${folder.name}" 폴더 삭제`, '안의 로어북은 폴더 밖으로 옮겨집니다.', { okButton: '삭제' })) return;
            const values = ownerCollapsed('book', BOOK_HOME_OWNER);
            values.delete(id);
            saveCollapsed('book', BOOK_HOME_OWNER, values);
            persist(removeFolder(layout, id));
            render();
        };
        const onBulkMove = async id => {
            const values = await requestFlexibleBulkMove(layout, id, labels);
            if (!values) return;
            const result = layoutWithItemsMovedToFolder(layout, values.itemIds, values.targetFolderId);
            if (!result.changed) return;
            persist(result.layout);
            render();
        };

        const elements = layout.root.map(node => {
            if (node.type === 'item') return visible.has(node.id) ? createBookRow(node.id, active) : null;
            const folder = folderMap.get(node.id);
            if (!folder) return null;
            const shown = folder.items.filter(name => visible.has(name));
            if (query && !shown.length) return null;
            const element = createFolderElement(folder, { kind: 'book', owner: BOOK_HOME_OWNER, collapsed, onEdit, onDelete, onBulkMove });
            if (query) element.classList.remove('is-collapsed');
            element.querySelector('.foldy-folder-items')?.append(...shown.map(name => createBookRow(name, active)));
            return element;
        }).filter(Boolean);

        destroySortables();
        closeOpenFolderMenus(list);
        list.replaceChildren(...elements);
        list.classList.toggle('foldy-searching', Boolean(query));
        if (!query) setupSortables(layout, names);
        if (container) container.scrollTop = scrollTop;
    }

    function refreshActive() {
        if (!isHomeVisible()) return;
        const active = activeNames();
        list.querySelectorAll('.foldy-book-row').forEach(row => row.classList.toggle('is-active', active.has(row.dataset.foldyBook)));
    }

    // 로어북 선택이 비면 홈 목록을, 로어북이 열리면 홈 버튼을 보여준다.
    function applyMode() {
        if (!list) return;
        const on = enabled();
        const home = on && !/^\d+$/.test(selectedValue());
        const wasHome = isHomeVisible();
        document.getElementById('world_popup')?.classList.toggle('foldy-book-home', home);
        list.hidden = !home;
        if (homeButton) homeButton.hidden = !on || home;
        HOME_TOOL_IDS.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.hidden = !home;
        });
        if (home) {
            render();
            if (!wasHome) {
                const container = scrollContainer();
                if (container) container.scrollTop = savedScroll;
            }
            return;
        }
        if (wasHome) {
            destroySortables();
            closeOpenFolderMenus(list);
            list.replaceChildren();
        }
    }

    function createHomeTools() {
        const create = createIconButton('fa-folder-plus', '새 폴더', 'foldy-book-tool');
        create.id = 'foldy_book_create';
        bindAction(create, '로어북 폴더 만들기', async () => {
            const layout = readLayout();
            const candidates = rootItemIds(layout).map(name => ({ id: name, label: name }));
            const values = await requestNewFolder(layout, candidates, { kind: 'lorebooks' });
            if (!values) return;
            const result = layoutWithAddedFolder(layout, values.name, values.itemIds, undefined, { afterKey: values.afterKey });
            persist(result.layout);
            render();
        }, { withErrorToast });

        const setAll = isCollapsed => {
            const collapsed = new Set(isCollapsed ? readLayout().folders.map(folder => folder.id) : []);
            saveCollapsed('book', BOOK_HOME_OWNER, collapsed);
            render();
        };
        const expandAll = createIconButton('fa-folder-open', '모두 펼치기', 'foldy-book-tool');
        expandAll.id = 'foldy_book_expand_all';
        bindAction(expandAll, '모두 펼치기', () => setAll(false), { withErrorToast });
        const collapseAll = createIconButton('fa-folder', '모두 접기', 'foldy-book-tool');
        collapseAll.id = 'foldy_book_collapse_all';
        bindAction(collapseAll, '모두 접기', () => setAll(true), { withErrorToast });

        const bulkMove = createRootBulkMoveButton(async () => {
            const layout = readLayout();
            const values = await requestFlexibleBulkMove(layout, null, new Map(bookNames().map(name => [name, name])));
            if (!values) return;
            const result = layoutWithItemsMovedToFolder(layout, values.itemIds, values.targetFolderId);
            if (!result.changed) return;
            persist(result.layout);
            render();
        });
        bulkMove.id = 'foldy_book_root_bulk_move';
        bulkMove.classList.add('foldy-book-tool');
        return [create, expandAll, collapseAll, bulkMove];
    }

    async function install() {
        await waitUntilCondition(() => document.getElementById('world_popup_entries_list')
            && document.getElementById('world_popup_new')
            && document.getElementById('world_editor_select'), 30000, 100, { rejectOnTimeout: false });
        const entries = document.getElementById('world_popup_entries_list');
        const newButton = document.getElementById('world_popup_new');
        const select = document.getElementById('world_editor_select');
        const popup = document.getElementById('world_popup');
        if (!entries || !newButton || !select || !popup) {
            debugLog('로어북 홈 화면을 붙일 위치를 찾지 못했습니다.', null, 'warn');
            return;
        }

        list = document.getElementById('foldy_book_home') || document.createElement('ul');
        list.id = 'foldy_book_home';
        list.hidden = true;
        entries.after(list);

        if (!document.getElementById('foldy_book_go_home')) {
            homeButton = createIconButton('fa-house', '로어북 목록', 'foldy-book-go-home');
            homeButton.id = 'foldy_book_go_home';
            homeButton.hidden = true;
            bindAction(homeButton, '로어북 목록', goHome, { withErrorToast });
            newButton.before(homeButton);
        }
        if (!document.getElementById(HOME_TOOL_IDS[0])) newButton.after(...createHomeTools());

        listenersAbort?.abort();
        listenersAbort = new AbortController();
        const { signal } = listenersAbort;

        list.addEventListener('click', event => {
            const row = event.target.closest?.('.foldy-book-row');
            if (!row || event.target.closest('.drag-handle')) return;
            openBook(row.dataset.foldyBook);
        }, { signal });
        scrollContainer()?.addEventListener('scroll', event => {
            if (isHomeVisible()) savedScroll = event.currentTarget.scrollTop;
        }, { signal, passive: true });
        // 대상 요소의 리스너보다 먼저 받아야 홈 화면의 새로고침을 가로챌 수 있다.
        popup.addEventListener('click', event => {
            if (!isHomeVisible() || !event.target.closest?.('#world_refresh')) return;
            event.preventDefault();
            event.stopPropagation();
            void withErrorToast('로어북 목록 새로고침', async () => {
                await updateWorldInfoList();
                render();
            });
        }, { signal, capture: true });
        popup.addEventListener('input', event => {
            if (!isHomeVisible() || event.target.id !== 'world_info_search') return;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(render, 150);
        }, { signal, capture: true });

        $('#world_editor_select').off('change.foldyBookHome').on('change.foldyBookHome', () => {
            const index = selectedValue();
            if (/^\d+$/.test(index)) lastBook = getWorldNames()?.[Number(index)] || lastBook;
            applyMode();
        });
        $('#world_info').off('change.foldyBookHome').on('change.foldyBookHome', refreshActive);
        optionsObserver?.disconnect();
        // 로어북 생성·삭제·이름 변경은 이벤트 없이 선택창 옵션만 다시 만든다.
        optionsObserver = new MutationObserver(() => {
            syncOwners();
            render();
        });
        optionsObserver.observe(select, { childList: true });
        applyMode();
    }

    function teardown() {
        listenersAbort?.abort();
        listenersAbort = null;
        optionsObserver?.disconnect();
        optionsObserver = null;
        clearTimeout(searchTimer);
        $('#world_editor_select').off('change.foldyBookHome');
        $('#world_info').off('change.foldyBookHome');
        destroySortables();
        document.getElementById('world_popup')?.classList.remove('foldy-book-home');
        list?.remove();
        list = null;
        homeButton?.remove();
        homeButton = null;
        HOME_TOOL_IDS.forEach(id => document.getElementById(id)?.remove());
        sorting = false;
        renderPending = false;
    }

    return { install, teardown, render, applyMode };
}
