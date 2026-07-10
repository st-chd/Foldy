import { updateFolderCount } from './folder-ui.js';

export function destroyFolderSortables(list, nestedItemsSelector, { dataKey = null } = {}) {
    if (!list) return;
    const $list = $(list);
    const cleanupKey = dataKey ? `${dataKey}Cleanup` : 'foldySortableCleanup';
    const cleanup = $list.data(cleanupKey);
    if (typeof cleanup === 'function') cleanup();
    $list.removeData(cleanupKey);
    if ($list.sortable('instance')) $list.sortable('destroy');
    if (dataKey) $list.removeData(dataKey);
    list.querySelectorAll(nestedItemsSelector).forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });
}

export function setupFolderSortables({
    list,
    nestedItemsSelector,
    rootSortableItems,
    nestedSortableItems,
    connectWith,
    folderHitSelector,
    folderItemsSelector,
    isItemElement,
    itemIdFromElement,
    getSortableDelay,
    setSorting,
    rerender,
    saveFromDom,
    saveOptionsFromItem = null,
    moveItemToFolder = null,
    debugLog,
    domainLabel,
    appendPlaceholderToFolder = false,
    dataKey = null,
}) {
    if (!list) return;
    destroyFolderSortables(list, nestedItemsSelector, { dataKey });

    const $list = $(list);
    let lastPointer = null;
    let lastFolderElement = null;
    let draggingItemIntoFolder = false;
    let draggingFolderId = null;
    let pointerFrame = 0;
    let pointerUi = null;

    const clearDropState = () => {
        if (pointerFrame) cancelAnimationFrame(pointerFrame);
        pointerFrame = 0;
        pointerUi = null;
        lastPointer = null;
        lastFolderElement = null;
        draggingItemIntoFolder = false;
        draggingFolderId = null;
        list.classList.remove('foldy-dropping-into-folder');
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
    };

    const rememberPointer = (event, ui) => {
        if (!draggingItemIntoFolder) {
            lastFolderElement = null;
            list.classList.remove('foldy-dropping-into-folder');
            list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
            return;
        }
        lastPointer = { x: event.clientX, y: event.clientY };
        pointerUi = ui;
        if (pointerFrame) return;
        pointerFrame = requestAnimationFrame(() => {
            pointerFrame = 0;
            if (!draggingItemIntoFolder || !lastPointer) return;
            const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
                .map(element => element.closest?.(folderHitSelector))
                .find(Boolean);
            lastFolderElement = pointedFolder ?? null;
            list.classList.toggle('foldy-dropping-into-folder', Boolean(pointedFolder));
            list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
            pointedFolder?.classList.add('foldy-drop-target');
            const placeholder = pointerUi?.placeholder?.[0];
            const items = pointedFolder?.querySelector?.(folderItemsSelector);
            if (appendPlaceholderToFolder && placeholder && items && !items.contains(placeholder)) items.append(placeholder);
        });
    };

    const moveIntoPointedFolder = item => {
        if (!isItemElement(item) || !lastPointer) return null;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.(folderHitSelector))
            .find(Boolean);
        const items = folderElement?.querySelector?.(folderItemsSelector);
        if (!items || items.contains(item)) return null;
        items.append(item);
        updateFolderCount(folderElement);
        return folderElement.dataset.foldyId || null;
    };

    const afterSort = task => {
        setTimeout(() => {
            task().catch(error => {
                debugLog(`${domainLabel} 폴더 정렬 완료 처리 실패`, error);
                toastr.error(`${domainLabel} 폴더 순서를 저장하지 못했습니다.`);
                rerender();
            });
        }, 0);
    };

    const start = (_, ui) => {
        const item = ui.item?.[0];
        setSorting(true);
        draggingItemIntoFolder = isItemElement(item);
        draggingFolderId = item?.classList?.contains('foldy-folder') ? item.dataset.foldyId : null;
    };

    const finishSort = (ui, { nested = false } = {}) => afterSort(async () => {
        try {
            const item = ui.item?.[0];
            if (draggingFolderId && item?.parentElement !== list) {
                rerender();
                return;
            }
            if (nested && item?.classList?.contains('foldy-folder')) {
                rerender();
                return;
            }
            const folderId = moveIntoPointedFolder(item);
            if (folderId && moveItemToFolder) await moveItemToFolder(String(itemIdFromElement(item)), folderId);
            else await saveFromDom(saveOptionsFromItem?.(item, { nested }) || {});
        } finally {
            setSorting(false);
            clearDropState();
        }
    });

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: rootSortableItems,
        placeholder: 'foldy-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start,
        sort: rememberPointer,
        stop: (_, ui) => finishSort(ui),
    });
    const cleanupKey = dataKey ? `${dataKey}Cleanup` : 'foldySortableCleanup';
    $list.data(cleanupKey, clearDropState);
    if (dataKey) $list.data(dataKey, true);

    list.querySelectorAll(nestedItemsSelector).forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: nestedSortableItems,
            connectWith,
            placeholder: 'foldy-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start,
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('foldy-folder')) $(ui.sender).sortable('cancel');
            },
            stop: (_, ui) => finishSort(ui, { nested: true }),
        });
    });
}
