import { updateFolderCount } from './folder-ui.js';

export function copyFormControlState(source, clone) {
    const sourceControls = [...(source?.querySelectorAll?.('input, select, textarea') || [])];
    const cloneControls = [...(clone?.querySelectorAll?.('input, select, textarea') || [])];
    sourceControls.forEach((control, index) => {
        const copy = cloneControls[index];
        if (!copy) return;
        if (String(control.tagName).toUpperCase() === 'SELECT') {
            [...(control.options || [])].forEach((option, optionIndex) => {
                if (copy.options?.[optionIndex]) copy.options[optionIndex].selected = option.selected;
            });
            copy.selectedIndex = control.selectedIndex;
        } else {
            copy.value = control.value;
            if ('checked' in control) copy.checked = control.checked;
        }
    });
    return clone;
}

export function cloneSortableHelper(_event, item) {
    const clone = item.clone();
    copyFormControlState(item[0], clone[0]);
    return clone;
}

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
    positionPlaceholderInFolder = false,
    dataKey = null,
}) {
    if (!list) return;
    destroyFolderSortables(list, nestedItemsSelector, { dataKey });

    const $list = $(list);
    let lastPointer = null;
    let lastFolderElement = null;
    let lastFolderInsertBefore = null;
    let draggingItemIntoFolder = false;
    let draggingFolderId = null;
    let activePlaceholder = null;
    // 저장을 기다리는 동안 다음 드래그가 시작될 수 있어 드래그마다 번호를 매기고 마무리를 차례로 처리한다.
    let dragToken = 0;
    let finishing = Promise.resolve();

    const clearDropState = () => {
        lastPointer = null;
        lastFolderElement = null;
        lastFolderInsertBefore = null;
        draggingItemIntoFolder = false;
        draggingFolderId = null;
        list.classList.remove('foldy-dropping-into-folder');
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
        // 진행 중인 드래그의 placeholder를 지우면 jQuery UI가 드롭을 마무리하지 못한다.
        list.querySelectorAll('.foldy-drop-placeholder').forEach(element => {
            if (element !== activePlaceholder) element.remove();
        });
    };

    // jQuery UI의 placeholder 재배치보다 늦지 않게 동기적으로 판정한다.
    const rememberPointer = (event, ui) => {
        if (!draggingItemIntoFolder) {
            lastFolderElement = null;
            lastFolderInsertBefore = null;
            list.classList.remove('foldy-dropping-into-folder');
            list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
            return;
        }
        lastPointer = { x: event.clientX, y: event.clientY };

        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.(folderHitSelector))
            .find(folder => folder && list.contains(folder));
        lastFolderElement = pointedFolder ?? null;
        list.classList.toggle('foldy-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
        pointedFolder?.classList.add('foldy-drop-target');
        const placeholder = ui?.placeholder?.[0];
        const items = pointedFolder?.querySelector?.(folderItemsSelector);
        if (positionPlaceholderInFolder && items) {
            const draggedItem = ui?.item?.[0];
            lastFolderInsertBefore = [...items.children]
                .filter(element => element !== placeholder && element !== draggedItem)
                .find(element => {
                    const rect = element.getBoundingClientRect?.();
                    return rect?.height > 0 && lastPointer.y < rect.top + rect.height / 2;
                }) ?? null;
            if (placeholder) {
                if (lastFolderInsertBefore) items.insertBefore(placeholder, lastFolderInsertBefore);
                else items.append(placeholder);
            }
        } else {
            lastFolderInsertBefore = null;
            if (appendPlaceholderToFolder && placeholder && items && !items.contains(placeholder)) items.append(placeholder);
        }
    };

    const moveIntoPointedFolder = (item, drop) => {
        if (!isItemElement(item) || !drop.pointer) return null;
        const folderElement = (drop.folderElement && list.contains(drop.folderElement) ? drop.folderElement : null)
            || document.elementsFromPoint(drop.pointer.x, drop.pointer.y)
            .map(element => element.closest?.(folderHitSelector))
            .find(folder => folder && list.contains(folder));
        const items = folderElement?.querySelector?.(folderItemsSelector);
        if (!items || items.contains(item)) return null;
        const insertBefore = positionPlaceholderInFolder
            && drop.insertBefore
            && items.contains(drop.insertBefore)
            ? drop.insertBefore
            : null;
        if (insertBefore) items.insertBefore(item, insertBefore);
        else items.append(item);
        updateFolderCount(folderElement);
        return {
            folderId: folderElement.dataset.foldyId || null,
            preserveDomPosition: Boolean(insertBefore),
        };
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
        dragToken++;
        activePlaceholder = ui.placeholder?.[0] ?? null;
        clearDropState();
        const item = ui.item?.[0];
        setSorting(true);
        draggingItemIntoFolder = isItemElement(item);
        draggingFolderId = item?.classList?.contains('foldy-folder') ? item.dataset.foldyId : null;
    };

    const finishDrop = async (ui, drop, nested, token) => {
        try {
            const item = ui.item?.[0];
            if (drop.draggingFolderId && item?.parentElement !== list) {
                rerender();
                return;
            }
            if (nested && item?.classList?.contains('foldy-folder')) {
                rerender();
                return;
            }
            // 구분선은 폴더 안에서만 옮길 수 있다.
            if (item?.classList?.contains('foldy-divider') && !item.parentElement?.matches?.(folderItemsSelector)) {
                rerender();
                return;
            }
            const move = moveIntoPointedFolder(item, drop);
            if (move?.folderId && moveItemToFolder && !move.preserveDomPosition) {
                await moveItemToFolder(String(itemIdFromElement(item)), move.folderId);
            }
            else await saveFromDom(saveOptionsFromItem?.(item, { nested }) || {});
        } finally {
            // 다음 드래그가 이미 시작됐으면 그 드래그의 placeholder와 상태를 건드리지 않는다.
            if (token === dragToken) {
                activePlaceholder = null;
                setSorting(false);
                clearDropState();
            }
        }
    };

    const finishSort = (ui, { nested = false } = {}) => {
        // 드롭 판정 값은 다음 드래그가 덮어쓰기 전에 지금 고정한다.
        const token = dragToken;
        const drop = {
            pointer: lastPointer,
            folderElement: lastFolderElement,
            insertBefore: lastFolderInsertBefore,
            draggingFolderId,
        };
        afterSort(() => {
            finishing = finishing.catch(() => {}).then(() => finishDrop(ui, drop, nested, token));
            return finishing;
        });
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: rootSortableItems,
        placeholder: 'foldy-drop-placeholder',
        helper: cloneSortableHelper,
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
            helper: cloneSortableHelper,
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start,
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('foldy-folder')) {
                    $(ui.sender).sortable('cancel');
                    // 취소된 sender는 항상 stop 이벤트를 발생시키지 않는다.
                    activePlaceholder = null;
                    setSorting(false);
                    clearDropState();
                }
            },
            stop: (_, ui) => finishSort(ui, { nested: true }),
        });
    });
}
