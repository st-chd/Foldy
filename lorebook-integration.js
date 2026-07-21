import {
    closeOpenFolderMenus,
    enabledItemCount,
    enabledState,
    folderCountText,
    setStateButtonIcon,
    updateFolderCount,
} from './folder-ui.js';
import {
    destroyFolderSortables,
    setupFolderSortables,
} from './folder-sortables.js';
import {
    bundleImportSummary,
    bundleEnvelope,
    bundleFilename,
    cloneJson,
    createFolderRenameTracker,
    hasValue,
    importedLayoutSummary,
    isObjectRecord,
    nameKey,
    uniqueNameIndex,
} from './bundle-utils.js';
import {
    createRenderGate,
    flattenLayout,
    rootNodeKey,
    layoutWithItemMovedToFolder,
    layoutWithItemsMovedToFolder,
    layoutWithUpdatedFolder,
    mergeImportedLayout,
    normalizeLayout,
    removeFolder,
    remapImportedLayout,
} from './model.js';

const LORE_PER_PAGE_KEY = 'Foldy_LorePerPage';
const LORE_PER_PAGE_DEFAULT = 25;
// A folder counts as one entry here, so smaller pages are more useful than in
// SillyTavern's flat list. 5 is Foldy-only; ST's own list keeps its defaults.
const LORE_PER_PAGE_OPTIONS = [5, 10, 25, 50, 100, 500, 1000];
const LORE_PAGINATION_TEMPLATE = '<%= rangeStart %>-<%= rangeEnd %> .. <%= totalNumber %>';

export function createLorebookIntegration({
    loreSortValue,
    sortOrderKey,
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
}) {
    const loreRenderGate = createRenderGate();
    let loreObserver = null;
    let loreListenersAbort = null;
    let loreSearchRenderTimer = 0;
    let sortingLore = false;
    let currentLoreLayout = null;
    let lorePage = 1;
    let lorePageContext = null;

    function lorePageSize() {
        const stored = Number(accountStorage.getItem(LORE_PER_PAGE_KEY));
        return Number.isFinite(stored) && stored > 0 ? stored : LORE_PER_PAGE_DEFAULT;
    }

    function resetLorePage() {
        lorePage = 1;
    }

    // Foldy renders one page of root nodes at a time, so the pager is driven by
    // Foldy's own render pass: the widget only reports the requested page number
    // and the next render slices the layout accordingly.
    function renderLorePagination(totalNodes) {
        const container = $('#world_info_pagination');
        if (!container.length) return;
        container.pagination({
            dataSource: Array.from({ length: totalNodes }, (_, index) => index),
            pageSize: lorePageSize(),
            // pagination.js mutates this array when the stored size is not in
            // the list, so hand it a throwaway copy on every render.
            sizeChangerOptions: [...LORE_PER_PAGE_OPTIONS],
            showSizeChanger: true,
            pageRange: 1,
            pageNumber: lorePage,
            position: 'top',
            showPageNumbers: false,
            prevText: '<',
            nextText: '>',
            formatNavigator: LORE_PAGINATION_TEMPLATE,
            showNavigator: true,
            callback: (_page, model) => {
                if (model.pageNumber === lorePage) return;
                lorePage = model.pageNumber;
                queueLoreRender();
            },
            afterSizeSelectorChange: event => {
                accountStorage.setItem(LORE_PER_PAGE_KEY, event.target.value);
                lorePage = 1;
                queueLoreRender();
            },
        });
    }

    function destroyLoreSortables(list = document.getElementById('world_popup_entries_list')) {
        destroyFolderSortables(list, '.foldy-lore-items');
    }

    function setupLoreSortables(owner, data, layout, pageNodeKeys) {
        const list = document.getElementById('world_popup_entries_list');
        if (!list) return;

        const allIds = loreEntryIds(data);
        let saving = false;
        const saveFromDom = async () => {
            if (saving) return;
            if (loreRenderGate.isRunning()) {
                queueLoreRender();
                return;
            }
            saving = true;
            try {
                list.querySelectorAll('.foldy-folder').forEach(updateFolderCount);
                const next = loreLayoutFromDom(list, layout, allIds, pageNodeKeys);
                if (shouldRejectDomLayout(layout, next, '로어북')) {
                    queueLoreRender();
                    return;
                }
                Object.assign(layout, next);
                await persistLoreLayout(owner, layout);
            } catch (error) {
            debugLog('로어북 폴더 순서 저장 실패', error);
            toastr.error('로어북 폴더 순서를 저장하지 못했습니다.');
                queueLoreRender();
            } finally {
                saving = false;
            }
        };
        const moveItemInLayout = async (itemId, folderId) => {
            const result = layoutWithItemMovedToFolder(layout, itemId, folderId);
            if (!result.changed) return;
            Object.assign(layout, result.layout);
            await persistLoreLayout(owner, result.layout);
        };

        setupFolderSortables({
            list,
            nestedItemsSelector: '.foldy-lore-items',
            rootSortableItems: '> [uid], > .foldy-folder',
            nestedSortableItems: '> [uid]',
            connectWith: '#world_popup_entries_list, .foldy-lore-items',
            folderHitSelector: '.foldy-lore-folder',
            folderItemsSelector: '.foldy-lore-items',
            isItemElement: item => item?.hasAttribute?.('uid') ?? false,
            itemIdFromElement: item => item?.getAttribute?.('uid'),
            getSortableDelay,
            setSorting: value => { sortingLore = value; },
            rerender: () => queueLoreRender(),
            saveFromDom,
            moveItemToFolder: moveItemInLayout,
            debugLog,
            domainLabel: '로어북',
            positionPlaceholderInFolder: true,
        });
    }

    function queueLoreSearchRender() {
        if (loreSearchRenderTimer) clearTimeout(loreSearchRenderTimer);
        loreSearchRenderTimer = setTimeout(() => {
            loreSearchRenderTimer = 0;
            queueLoreRender();
        }, 150);
    }

    async function renderLorebookFolders() {
        if (loreRenderGate.isRunning()) {
            loreRenderGate.requestAfterRun();
            return;
        }
        if (!featureEnabled('lorebooks') || $('#world_info_sort_order').val() !== loreSortValue) {
            document.getElementById('world_popup_entries_list')?.classList.remove('foldy-lore-pending');
            return;
        }
        const { name, owner } = currentLorebookOwner();
        if (!name) return;
        await loreRenderGate.run(async () => {
            try {
            const data = await loadWorldInfo(name);
            if (!data?.entries) return;
            const list = document.getElementById('world_popup_entries_list');
            if (!list) return;
            const allEntries = Object.values(data.entries).filter(entry => entry && typeof entry === 'object');
            const allIds = allEntries.map(entry => String(entry.uid));
            const layout = normalizeLayout(settings().layouts.lorebooks[owner], allIds);
            currentLoreLayout = layout;
            await persistLoreLayout(owner, layout);
            const query = String($('#world_info_search').val() ?? '').trim();
            const visibleEntries = query ? allEntries.filter(entry => matchesLoreQuery(entry, query)) : allEntries;
            const visibleIds = new Set(visibleEntries.map(entry => String(entry.uid)));
            const entryMap = new Map(allEntries.map(entry => [String(entry.uid), entry]));
            const collapsed = ownerCollapsed('lore', owner);
            const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));

            // This observer watches a list Foldy rewrites. Disconnect it for
            // the entire render transaction; any DOM mutation added here must
            // remain inside this guarded block to avoid observer feedback.
            loreObserver?.disconnect();
            destroyLoreSortables(list);
            closeOpenFolderMenus(list);
            list.innerHTML = '';
            list.classList.add('foldy-lore-root');
            list.classList.toggle('foldy-searching', Boolean(query));
            const headers = await renderTemplateAsync('worldInfoKeywordHeaders');
            list.insertAdjacentHTML('beforeend', headers);

            const rerender = () => queueLoreRender();
            const loreContextChanged = () => currentLorebookOwner().owner !== owner || currentLoreLayout !== layout;
            const rerenderIfLoreContextChanged = () => {
                if (!loreContextChanged()) return false;
                rerender();
                return true;
            };
            const renderEntryBlock = async id => {
                const block = await getWorldEntry(name, data, entryMap.get(id));
                const element = block?.[0];
                if (!element) return null;
                attachMoveToFolderButton(element, {
                    kind: 'lore',
                    layout,
                    itemId: id,
                    onMove: async movedLayout => {
                        if (rerenderIfLoreContextChanged()) return;
                        await persistLoreLayout(owner, movedLayout);
                        rerender();
                    },
                });
                return element;
            };
            const onEdit = async id => {
                const folder = layout.folders.find(value => value.id === id);
                if (!folder) return;
                const values = await requestFolderSettings(layout, folder);
                if (!values) return;
                if (rerenderIfLoreContextChanged()) return;
                const { applyStyleToAll, ...folderValues } = values;
                const result = layoutWithUpdatedFolder(layout, folder.id, folderValues, { applyStyleToAll });
                currentLoreLayout = result.layout;
                await persistLoreLayout(owner, result.layout);
                rerender();
            };
            const onDelete = async id => {
                const folder = layout.folders.find(value => value.id === id);
                if (!folder || !await confirmFolderDelete(folder.name, '항목')) return;
                if (rerenderIfLoreContextChanged()) return;
                const nextLayout = removeFolder(layout, id);
                await persistLoreLayout(owner, nextLayout);
                rerender();
            };
            const refreshFolderState = (folderElement, folder) => {
                const state = enabledState(folder.items.map(id => !data.entries[id]?.disable));
                const countElement = folderElement.querySelector('.foldy-folder-count');
                if (countElement) {
                    countElement.textContent = folderCountText({
                        enabled: enabledItemCount(folder.items, id => !data.entries[id]?.disable),
                        total: folder.items.length,
                    });
                }
                const stateButton = folderElement.querySelector('.foldy-state-toggle');
                if (stateButton) setStateButtonIcon(stateButton, state);
            };

            const renderRootNode = async node => {
                if (node.type === 'item') {
                    if (!visibleIds.has(node.id)) return null;
                    return renderEntryBlock(node.id);
                }
                const folder = folderMap.get(node.id);
                if (!folder) return null;
                const shownItems = loreFolderVisibleItemIds(folder, visibleIds);
                if (query && !shownItems.length) return null;
                const deferCollapsedItems = !query && collapsed.has(folder.id);
                const state = enabledState(folder.items.map(id => !data.entries[id]?.disable));
                let folderElement;
                let items;
                let deferredItemsPending = false;
                let deferredItemsRendered = !deferCollapsedItems;
                const renderDeferredItems = async () => {
                    if (deferredItemsPending || deferredItemsRendered) return;
                    deferredItemsPending = true;
                    try {
                        if (rerenderIfLoreContextChanged()) return;
                        const blocks = await Promise.all(shownItems.map(id => renderEntryBlock(id)));
                        if (rerenderIfLoreContextChanged() || !folderElement.isConnected) return;
                        blocks.filter(Boolean).forEach(element => items.append(element));
                        deferredItemsRendered = true;
                    } finally {
                        deferredItemsPending = false;
                    }
                };
                folderElement = createFolderElement(folder, {
                    kind: 'lore',
                    owner,
                    collapsed,
                    onEdit,
                    onDelete,
                    state,
                    onStateToggle: async (id, currentState) => {
                        if (rerenderIfLoreContextChanged()) return;
                        await setLoreFolderEnabled(name, data, layout, id, currentState !== 'on');
                    },
                    extraButtons: createLoreBulkSettingButtons(name, data, layout, folder, rerenderIfLoreContextChanged),
                    onCollapseChange: (id, isCollapsed) => {
                        if (!isCollapsed && id === folder.id && deferCollapsedItems) {
                            void withErrorToast('로어북 폴더 펼치기', renderDeferredItems);
                        }
                    },
                    onBulkMove: async id => {
                        const labels = new Map(allEntries.map(entry => [String(entry.uid), loreEntryLabel(entry)]));
                        const values = await requestFlexibleBulkMove(layout, id, labels);
                        if (!values) return;
                        if (rerenderIfLoreContextChanged()) return;
                        const result = layoutWithItemsMovedToFolder(layout, values.itemIds, values.targetFolderId);
                        if (!result.changed) return;
                        await persistLoreLayout(owner, result.layout);
                        rerender();
                    },
                });
                if (query) folderElement.classList.remove('is-collapsed');
                items = folderElement.querySelector('.foldy-folder-items');
                const itemIdsToRender = loreFolderItemIdsToRender(folder, visibleIds, { query: Boolean(query), collapsed: collapsed.has(folder.id) });
                const blocks = await Promise.all(itemIdsToRender.map(id => renderEntryBlock(id)));
                blocks.filter(Boolean).forEach(element => items.append(element));
                items.addEventListener('click', event => {
                    if (!event.target.closest?.('[name="entryKillSwitch"]')) return;
                    refreshFolderState(folderElement, folder);
                });
                refreshFolderState(folderElement, folder);
                return folderElement;
            };

            // Mirrors the null cases in renderRootNode so the pager counts
            // exactly the root nodes that end up on screen.
            const isVisibleRootNode = node => {
                if (node.type === 'item') return visibleIds.has(String(node.id));
                const folder = folderMap.get(node.id);
                if (!folder) return false;
                return !query || loreFolderVisibleItemIds(folder, visibleIds).length > 0;
            };
            const visibleRootNodes = layout.root.filter(isVisibleRootNode);

            const pageContext = `${owner} ${query}`;
            if (lorePageContext !== pageContext) {
                lorePageContext = pageContext;
                lorePage = 1;
            }
            const pageSize = lorePageSize();
            const pageCount = Math.max(1, Math.ceil(visibleRootNodes.length / pageSize));
            lorePage = Math.min(Math.max(1, lorePage), pageCount);
            const pageNodes = visibleRootNodes.slice((lorePage - 1) * pageSize, lorePage * pageSize);
            const pageNodeKeys = pageNodes.map(rootNodeKey);

            const fragment = document.createDocumentFragment();
            const rootElements = await Promise.all(pageNodes.map(renderRootNode));
            rootElements.filter(Boolean).forEach(element => fragment.append(element));
            list.append(fragment);
            renderLorePagination(visibleRootNodes.length);

            document.querySelector('#WorldInfo .foldy-toolbar[data-foldy-toolbar="lore"]')?.remove();
            if (!query) setupLoreSortables(owner, data, layout, pageNodeKeys);
            else destroyLoreSortables(list);
        } catch (error) {
            debugLog('로어북 폴더 표시 실패', error);
            toastr.error('로어북 폴더를 표시하지 못했습니다.');
        } finally {
            const list = document.getElementById('world_popup_entries_list');
            list?.classList.remove('foldy-lore-pending');
            if (list && loreObserver) loreObserver.observe(list, { childList: true });
        }
        }, () => queueLoreRender());
    }

    function queueLoreRender() {
        if (!featureEnabled('lorebooks') || $('#world_info_sort_order').val() !== loreSortValue) return;
        loreRenderGate.queue(
            () => renderLorebookFolders(),
            () => {
                syncLorebookRenameMigration({ rerender: false });
                document.getElementById('world_popup_entries_list')?.classList.add('foldy-lore-pending');
            },
        );
    }

    function applyLorebookFeatureState() {
        const enabled = featureEnabled('lorebooks');
        const sort = document.getElementById('world_info_sort_order');
        const option = sort?.querySelector(`option[value="${loreSortValue}"]`);
        if (option) option.disabled = !enabled;
        [
            'foldy_lore_create',
            'foldy_lore_import',
            'foldy_lore_export',
            'foldy_lore_expand_all',
            'foldy_lore_collapse_all',
            'foldy_lore_root_bulk_move',
        ].forEach(id => {
            const element = document.getElementById(id);
            if (!element) return;
            element.hidden = !enabled;
            if (enabled) {
                element.style.removeProperty('display');
            } else {
                element.style.setProperty('display', 'none', 'important');
            }
        });
        if (enabled) return;

        document.querySelector('#WorldInfo .foldy-toolbar[data-foldy-toolbar="lore"]')?.remove();
        const list = document.getElementById('world_popup_entries_list');
        list?.classList.remove('foldy-lore-root', 'foldy-searching', 'foldy-lore-pending');
        list?.querySelectorAll('.foldy-folder').forEach(element => element.remove());
        loreObserver?.disconnect();
        if (sort?.value === loreSortValue) {
            sort.value = '0';
            accountStorage.setItem(sortOrderKey, '0');
        }
        const name = selectedLorebookName();
        if (name) setTimeout(() => reloadEditor(name, true), 0);
        if (list && loreObserver) {
            setTimeout(() => loreObserver?.observe(list, { childList: true }), 0);
        }
    }

    async function installLorebookIntegration() {
        await waitUntilCondition(() => document.getElementById('world_info_sort_order')
            && document.getElementById('world_popup_entries_list')
            && document.getElementById('world_popup_new'), 30000, 100, { rejectOnTimeout: false });
        const sort = document.getElementById('world_info_sort_order');
        const entriesList = document.getElementById('world_popup_entries_list');
        const newButton = document.getElementById('world_popup_new');
        if (!sort || !entriesList || !newButton) {
            if (featureEnabled('lorebooks')) {
                disableFeatureForCompatibility('lorebooks', '로어북', {
                    world_info_sort_order: !!sort,
                    world_popup_entries_list: !!entriesList,
                    world_popup_new: !!newButton,
                });
            }
            return;
        }
        if (!sort.querySelector(`option[value="${loreSortValue}"]`)) {
            const option = document.createElement('option');
            option.value = loreSortValue;
            option.textContent = '폴더 순서';
            option.dataset.rule = 'custom';
            option.dataset.field = 'displayIndex';
            option.dataset.order = 'asc';
            sort.append(option);
        }
        if (!document.getElementById('foldy_lore_create')) {
            const create = createIconButton('fa-folder-plus', '새 폴더', 'foldy-lore-create');
            create.id = 'foldy_lore_create';
            bindAction(create, '로어북 폴더 만들기', createLorebookFolder, { withErrorToast });
            newButton.after(create);
        }
        if (!document.getElementById('foldy_lore_export')) {
            const [importButton, exportButton] = createBundleButtons(exportLorebookBundle, importLorebookBundle);
            exportButton.id = 'foldy_lore_export';
            importButton.id = 'foldy_lore_import';
            exportButton.classList.add('foldy-lore-bundle');
            importButton.classList.add('foldy-lore-bundle');
            document.getElementById('foldy_lore_create')?.after(importButton, exportButton);
        }
        if (!document.getElementById('foldy_lore_collapse_all')) {
            const [expandAll, collapseAll] = createLoreCollapseButtons();
            collapseAll.id = 'foldy_lore_collapse_all';
            expandAll.id = 'foldy_lore_expand_all';
            document.getElementById('foldy_lore_export')?.after(expandAll, collapseAll);
        }
        if (!document.getElementById('foldy_lore_root_bulk_move')) {
            document.getElementById('foldy_lore_collapse_all')?.after(createLoreRootBulkMoveButton());
        }
        applyLorebookFeatureState();
        document.querySelector('#WorldInfo .foldy-toolbar[data-foldy-toolbar="lore"]')?.remove();
        loreListenersAbort?.abort();
        loreListenersAbort = new AbortController();
        const listenerOptions = { capture: true, signal: loreListenersAbort.signal };

        sort.addEventListener('change', event => {
            if (event.target.value !== loreSortValue) {
                const wasFolderOrder = storedLoreSortValue() === loreSortValue;
                document.querySelector('#WorldInfo .foldy-toolbar')?.remove();
                document.getElementById('world_popup_entries_list')?.classList.remove('foldy-lore-root', 'foldy-searching');
                if (wasFolderOrder && featureEnabled('lorebooks')) {
                    event.stopImmediatePropagation();
                    const value = String(event.target.value);
                    if (value !== 'search') accountStorage.setItem(sortOrderKey, value);
                    const name = selectedLorebookName();
                    if (name) reloadEditor(name, true);
                }
                return;
            }
            if (!featureEnabled('lorebooks')) return;
            event.stopImmediatePropagation();
            accountStorage.setItem(sortOrderKey, loreSortValue);
            queueLoreRender();
        }, listenerOptions);
        document.getElementById('world_info_search')?.addEventListener('input', event => {
            if (sort.value !== loreSortValue || !featureEnabled('lorebooks')) return;
            event.stopImmediatePropagation();
            queueLoreSearchRender();
        }, listenerOptions);
        document.getElementById('world_refresh')?.addEventListener('click', event => {
            if (sort.value !== loreSortValue || !featureEnabled('lorebooks')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            queueLoreRender();
        }, listenerOptions);
        document.getElementById('world_popup_new')?.addEventListener('click', event => {
            if (sort.value !== loreSortValue || !featureEnabled('lorebooks')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            createLorebookEntryInFolderOrder();
        }, listenerOptions);
        document.getElementById('world_popup_entries_list')?.addEventListener('click', event => {
            if (sort.value !== loreSortValue || !featureEnabled('lorebooks')) return;
            const button = event.target.closest?.('.delete_entry_button');
            if (!button) return;
            const entry = button.closest?.('.world_entry');
            const uid = entry?.getAttribute('uid');
            if (!uid) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            deleteLorebookEntryInFolderOrder(uid);
        }, listenerOptions);

        loreObserver = new MutationObserver(() => {
            if (sortingLore || sort.value !== loreSortValue || !featureEnabled('lorebooks')) return;
            if (loreRenderGate.isRunning()) {
                loreRenderGate.requestAfterRun();
                return;
            }
            queueLoreRender();
        });
        const list = document.getElementById('world_popup_entries_list');
        if (list) loreObserver.observe(list, { childList: true });
        $('#world_editor_select').off('change.foldy').on('change.foldy', () => {
            if (sort.value === loreSortValue) setTimeout(queueLoreRender, 0);
        });
        if (featureEnabled('lorebooks') && storedLoreSortValue() === loreSortValue) {
            sort.value = loreSortValue;
            queueLoreRender();
        }
    }

    return {
        applyLorebookFeatureState,
        installLorebookIntegration,
        queueLoreRender,
        renderLorebookFolders,
        resetLorePage,
    };
}


export function matchesLoreQuery(entry, query) {
    if (!query) return true;
    const haystack = [
        entry.comment,
        entry.content,
        ...(Array.isArray(entry.key) ? entry.key : []),
        ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
    ].filter(Boolean).join('\n').toLocaleLowerCase();
    return query.toLocaleLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

export function loreFolderVisibleItemIds(folder, visibleIds) {
    return (folder?.items || []).filter(id => visibleIds.has(String(id)));
}

export function loreFolderItemIdsToRender(folder, visibleIds, { query = false, collapsed = false } = {}) {
    if (!query && collapsed) return [];
    return loreFolderVisibleItemIds(folder, visibleIds);
}

export function loreEntryLabel(entry) {
    if (!entry) return '';
    const comment = String(entry.comment || '').trim();
    if (comment) return comment;
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean).join(', ') : '';
    if (keys) return keys;
    const content = String(entry.content || '').trim().replace(/\s+/g, ' ');
    if (content) return content.slice(0, 80);
    return `UID ${entry.uid}`;
}

export function loreEntryIds(data) {
    return Object.values(data?.entries || {})
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => String(entry.uid));
}

export function detectLorebookRename(previousNames, nextNames) {
    if (!Array.isArray(previousNames) || !Array.isArray(nextNames)) return null;
    if (previousNames.length !== nextNames.length) return null;
    const previousSet = new Set(previousNames);
    const nextSet = new Set(nextNames);
    const removed = previousNames.filter(name => !nextSet.has(name));
    const added = nextNames.filter(name => !previousSet.has(name));
    if (removed.length !== 1 || added.length !== 1) return null;
    return { oldName: removed[0], newName: added[0] };
}

export function isLoreOriginalDataCompatible(data, { debugLog = null, toaster = globalThis.toastr } = {}) {
    if (!data?.originalData) return true;
    const entries = data.originalData.entries;
    const compatible = Array.isArray(entries)
        && entries.every(entry => isObjectRecord(entry) && (hasValue(entry.uid) || hasValue(entry.id)));
    if (!compatible) {
        debugLog?.('error', '로어북 원본 데이터 구조가 예상과 달라 저장을 중단했습니다.', {
            hasOriginalData: !!data?.originalData,
            entriesType: Array.isArray(entries) ? 'array' : typeof entries,
        });
        toaster?.error?.('로어북 원본 데이터 구조가 예상과 달라 저장을 중단했습니다.');
    }
    return compatible;
}

export function syncLoreOriginalEntry(data, entry) {
    if (!data?.originalData || !Array.isArray(data.originalData.entries) || !entry) return;
    const uid = Number(entry.uid);
    const existing = data.originalData.entries.find(value => value.uid === uid || value.id === uid);
    const original = existing ?? { uid, id: uid };
    // FRAGILE ST coupling: mirrors SillyTavern World Info originalData entry
    // shape used by world-info.js. If ST adds/renames fields while keeping an
    // array of uid/id records, this may silently degrade rather than crash.
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

export function setLoreFolderEntriesEnabled(data, layout, folderId, enabled, setOriginalDataValue) {
    const folder = layout?.folders?.find(value => value.id === folderId);
    if (!folder) return false;
    for (const id of folder.items) {
        const entry = data?.entries?.[id];
        if (!entry) continue;
        entry.disable = !enabled;
        setOriginalDataValue?.(data, entry.uid, 'enabled', enabled);
    }
    return true;
}

export function setLoreEntryStrategy(data, entry, strategy, setOriginalDataValue) {
    if (!entry) return false;
    if (strategy === 'constant') {
        entry.constant = true;
        entry.vectorized = false;
    } else if (strategy === 'vectorized') {
        entry.constant = false;
        entry.vectorized = true;
    } else {
        entry.constant = false;
        entry.vectorized = false;
    }
    setOriginalDataValue?.(data, entry.uid, 'constant', entry.constant);
    setOriginalDataValue?.(data, entry.uid, 'extensions.vectorized', entry.vectorized);
    return true;
}

export function setLoreEntryPosition(data, entry, position, role, setOriginalDataValue) {
    if (!entry) return false;
    entry.position = position;
    entry.role = position === 4 ? role : null;
    setOriginalDataValue?.(data, entry.uid, 'position', entry.position === 0 ? 'before_char' : 'after_char');
    setOriginalDataValue?.(data, entry.uid, 'extensions.position', entry.position);
    setOriginalDataValue?.(data, entry.uid, 'extensions.role', entry.role);
    return true;
}


export function createLorebookBundleActions({
    settings,
    saveSettingsDebounced,
    currentLorebookOwner,
    selectedLorebookName,
    lorebookOwnerForName,
    migrateLorebookOwner,
    persistLoreLayout,
    enqueueLorebookWrite = async (_name, action) => action(),
    loadWorldInfo,
    saveWorldInfo,
    updateWorldInfoList,
    reloadEditor,
    getWorldNames,
    queueLoreRender,
    isLoreFolderSortActive,
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertLorebookBundleShape,
    confirmText,
}) {
    async function requestLorebookExportMode() {
        return requestBundleExportMode(
            '로어북 내보내기',
            '로어북 내용과 폴더 구조',
            '폴더 구조만',
            '구조만 내보내면 불러올 때 현재 로어북의 내용은 그대로 두고 폴더 배치만 적용합니다.',
            'foldy_lore_export_mode',
        );
    }

    function loreLayoutRefs(data, ids) {
        const entriesById = new Map(Object.values(data?.entries || {})
            .filter(entry => entry && typeof entry === 'object')
            .map(entry => [String(entry.uid), entry]));
        return ids.map(id => {
            const entry = entriesById.get(String(id));
            return {
                uid: String(id),
                comment: String(entry?.comment || ''),
            };
        });
    }

    function loreLayoutOnlyBundle(bundle) {
        return bundle?.contents === 'layout'
            || (Array.isArray(bundle?.entryRefs) && !bundle?.data?.entries);
    }

    async function importLorebookLayoutBundle(bundle) {
        if (!bundle?.layout) {
            toastr.error('로어북 구조 번들에 폴더 구조가 없습니다.');
            return;
        }
        const { name, owner } = currentLorebookOwner();
        if (!name) {
            toastr.warning('먼저 로어북을 선택해 주세요.');
            return;
        }
        const sourceName = String(bundle.owner || '알 수 없는 로어북');
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;
        const currentIds = loreEntryIds(data);
        const entries = Object.values(data.entries).filter(entry => entry && typeof entry === 'object');
        const currentById = new Map(entries.map(entry => [String(entry.uid), entry]));
        const commentIndex = uniqueNameIndex(entries, entry => entry.comment);
        const refsById = new Map((bundle.entryRefs || [])
            .filter(ref => ref?.uid != null)
            .map(ref => [String(ref.uid), ref]));
        const idMap = new Map();
        let ambiguousNameCount = 0;
        for (const sourceId of flattenLayout(bundle.layout)) {
            const ref = refsById.get(String(sourceId));
            const direct = currentById.get(String(sourceId));
            const refNameKey = nameKey(ref?.comment);
            if (!direct && refNameKey && commentIndex.ambiguous.has(refNameKey)) ambiguousNameCount++;
            const byComment = refNameKey ? commentIndex.unique.get(refNameKey) : null;
            const target = direct || byComment;
            if (target?.uid != null) idMap.set(String(sourceId), String(target.uid));
        }
        const sourceItemCount = new Set(flattenLayout(bundle.layout)).size;
        const matchedTargetCount = new Set(idMap.values()).size;
        const confirmed = await confirmText(
            '로어북 폴더 구조 불러오기',
            `"${sourceName}"의 폴더 구조를 현재 로어북 "${name}"에 적용할까요? 로어북 내용은 바뀌지 않습니다.\n\n${importedLayoutSummary({
                currentLabel: '현재 항목',
                currentOnlyLabel: '현재 로어북에만 있는 항목',
                currentCount: currentIds.length,
                sourceCount: sourceItemCount,
                matchedSourceCount: idMap.size,
                matchedTargetCount,
                ambiguousCount: ambiguousNameCount,
            })}`,
        );
        if (!confirmed) return;

        const currentLayout = normalizeLayout(null, currentIds);
        const importedLayout = remapImportedLayout(bundle.layout, idMap);
        const renameTracker = createFolderRenameTracker();
        const layout = mergeImportedLayout(currentLayout, importedLayout, currentIds, renameTracker.options);
        await persistLoreLayout(owner, layout);
        queueLoreRender();
        renameTracker.notify();
        toastr.success('로어북 폴더 구조를 불러왔습니다.');
    }

    async function exportLorebookBundle() {
        const { name, owner } = currentLorebookOwner();
        if (!name) {
            toastr.warning('먼저 로어북을 선택해 주세요.');
            return;
        }
        const data = await loadWorldInfo(name);
        const layout = normalizeLayout(settings().layouts.lorebooks[owner], loreEntryIds(data));
        settings().layouts.lorebooks[owner] = layout;
        saveSettingsDebounced();
        const ids = new Set(flattenLayout(layout));
        const mode = await requestLorebookExportMode();
        if (!mode) return;

        if (mode === 'layout') {
            if (!await downloadJson({
                ...bundleEnvelope('lorebooks'),
                contents: 'layout',
                owner: name,
                layout: cloneJson(layout),
                entryRefs: loreLayoutRefs(data, [...ids]),
            }, bundleFilename(`${name}-folders`))) return;
            toastr.success('로어북 폴더 구조를 내보냈습니다.');
            return;
        }

        if (!await downloadJson({
            ...bundleEnvelope('lorebooks'),
            owner: name,
            layout: cloneJson(layout),
            data: cloneJson(data),
        }, bundleFilename(name))) return;
        toastr.success('로어북 번들을 내보냈습니다.');
    }

    async function importLorebookBundle() {
        const rawBundle = await readJsonFile();
        const bundle = rawBundle ? assertBundle(rawBundle, 'lorebooks') : null;
        if (!bundle) return;
        if (loreLayoutOnlyBundle(bundle)) {
            await importLorebookLayoutBundle(bundle);
            return;
        }
        if (!assertLorebookBundleShape(bundle)) return;
        const name = String(bundle.owner || bundle.data.name || selectedLorebookName() || '').trim();
        if (!name) {
            toastr.warning('로어북 번들에 로어북 이름이 없습니다.');
            return;
        }
        const worldNames = getWorldNames();
        const exists = worldNames.includes(name);
        const currentData = exists ? await loadWorldInfo(name) : null;
        const existingEntryCount = currentData?.entries ? loreEntryIds(currentData).length : 0;
        const importedEntryCount = loreEntryIds(bundle.data).length;
        const sourceLayoutIds = new Set(flattenLayout(bundle.layout));
        const importedEntryIds = new Set(loreEntryIds(bundle.data).map(String));
        const matchedLayoutCount = [...sourceLayoutIds].filter(id => importedEntryIds.has(String(id))).length;
        const layoutSummary = bundleImportSummary({
            existingCount: existingEntryCount,
            folderCount: Array.isArray(bundle.layout?.folders) ? bundle.layout.folders.length : 0,
            importedCount: importedEntryCount,
            matchedCount: matchedLayoutCount,
        });
        const confirmed = await confirmText('로어북 번들 불러오기', exists
            ? `기존 로어북 "${name}"을 이 번들로 바꿀까요?\n\n${layoutSummary}\n\n계속할까요?`
            : `이 번들로 새 로어북 "${name}"을 만들까요?\n\n${layoutSummary}\n\n계속할까요?`);
        if (!confirmed) return;
        await enqueueLorebookWrite(name, async () => {
            const data = cloneJson(bundle.data);
            const layout = normalizeLayout(bundle.layout, loreEntryIds(data));
            await saveWorldInfo(name, data, true);
            await updateWorldInfoList();
            const index = getWorldNames().indexOf(name);
            const owner = lorebookOwnerForName(name);
            migrateLorebookOwner(name, owner);
            await persistLoreLayout(owner, layout);
            if (index >= 0) $('#world_editor_select').val(index).trigger('change');
            await reloadEditor(name, true);
            if (isLoreFolderSortActive()) queueLoreRender();
        });
        toastr.success('로어북 번들을 불러왔습니다.');
    }

    return {
        exportLorebookBundle,
        importLorebookBundle,
    };
}
