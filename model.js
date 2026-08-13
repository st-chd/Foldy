import { folderStyleValues } from './folder-style.js';

export const FOLDY_VERSION = 1;

export function generateUUID() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }

    // crypto.randomUUID가 없는 구형 환경용 대체 구현. 암호학적으로 안전하지 않음.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, value => {
        const random = Math.floor(Math.random() * 16);
        return (value === 'x' ? random : (random & 0x3) | 0x8).toString(16);
    });
}

export function createEmptyLayout(itemIds = []) {
    return {
        version: FOLDY_VERSION,
        root: itemIds.map(id => ({ type: 'item', id: String(id) })),
        folders: [],
    };
}

export function flattenLayout(layout) {
    const folders = new Map(layout.folders.map(folder => [folder.id, folder]));
    return layout.root.flatMap(node => {
        if (node.type === 'item') return [node.id];
        return folders.get(node.id)?.items ?? [];
    });
}

export function orderItemsByLayout(layout, items, getId = item => item?.id) {
    const byId = new Map();
    items.forEach((item, index) => {
        const id = String(getId(item) ?? '');
        if (!id) return;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push({ item, index });
    });
    const usedIndices = new Set();
    const ordered = [];

    for (const id of flattenLayout(layout)) {
        const entry = byId.get(String(id))?.find(value => !usedIndices.has(value.index));
        if (!entry) continue;
        ordered.push(entry.item);
        usedIndices.add(entry.index);
    }

    items.forEach((item, index) => {
        if (usedIndices.has(index)) return;
        ordered.push(item);
    });

    return ordered;
}

function uniqueFolderName(name, usedNames) {
    const base = String(name || '새 폴더').trim() || '새 폴더';
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate.toLocaleLowerCase())) {
        candidate = `${base} (${suffix++})`;
    }
    usedNames.add(candidate.toLocaleLowerCase());
    return candidate;
}

// 저장된 레이아웃을 현재 항목 순서에 맞춰 조정한다. 빠진 항목은 가장 가까운 이웃 옆에 끼워 넣는다.
export function normalizeLayout(rawLayout, itemIds = [], { preserveUnrootedFolders = true, onFolderRenamed = null } = {}) {
    const validIds = itemIds.map(String);
    const validSet = new Set(validIds);
    const source = rawLayout && typeof rawLayout === 'object' ? rawLayout : {};
    const sourceFolders = Array.isArray(source.folders) ? source.folders : [];
    const usedFolderIds = new Set();
    const usedFolderNames = new Set();
    const placedItems = new Set();
    let folders = [];

    for (const candidate of sourceFolders) {
        if (!candidate || typeof candidate !== 'object') continue;
        let id = String(candidate.id || generateUUID());
        while (usedFolderIds.has(id)) id = generateUUID();
        usedFolderIds.add(id);

        const items = [];
        for (const value of Array.isArray(candidate.items) ? candidate.items : []) {
            const itemId = String(value);
            if (!validSet.has(itemId) || placedItems.has(itemId)) continue;
            placedItems.add(itemId);
            items.push(itemId);
        }

        const requestedName = String(candidate.name || '새 폴더').trim() || '새 폴더';
        const name = uniqueFolderName(candidate.name, usedFolderNames);
        if (name !== requestedName) onFolderRenamed?.({ from: requestedName, to: name, id });

        folders.push({
            id,
            name,
            color: typeof candidate.color === 'string' ? candidate.color : '',
            borderColor: typeof candidate.borderColor === 'string' ? candidate.borderColor : '',
            nameColor: typeof candidate.nameColor === 'string' ? candidate.nameColor : '',
            items,
        });
    }

    const folderMap = new Map(folders.map(folder => [folder.id, folder]));
    const root = [];
    const placedFolders = new Set();
    for (const candidate of Array.isArray(source.root) ? source.root : []) {
        if (!candidate || typeof candidate !== 'object') continue;
        const id = String(candidate.id ?? '');
        if (candidate.type === 'folder' && folderMap.has(id) && !placedFolders.has(id)) {
            root.push({ type: 'folder', id });
            placedFolders.add(id);
        } else if (candidate.type === 'item' && validSet.has(id) && !placedItems.has(id)) {
            root.push({ type: 'item', id });
            placedItems.add(id);
        }
    }

    if (preserveUnrootedFolders) {
        for (const folder of folders) {
            if (!placedFolders.has(folder.id)) root.push({ type: 'folder', id: folder.id });
        }
    } else {
        folders = folders.filter(folder => placedFolders.has(folder.id));
    }

    // 실제 남은 항목만 배치됨으로 표시(주인 없는 폴더를 버릴 때 내부 항목을 루트로 풀어주기 위함).
    placedItems.clear();
    for (const folder of folders) {
        for (const itemId of folder.items) placedItems.add(itemId);
    }
    for (const node of root) {
        if (node.type === 'item') placedItems.add(node.id);
    }

    const ownerIndices = new Map();
    const folderByItemId = new Map();
    root.forEach((node, rootIndex) => {
        if (node.type === 'item') {
            ownerIndices.set(node.id, rootIndex);
            return;
        }
        for (const itemId of folderMap.get(node.id)?.items ?? []) {
            ownerIndices.set(itemId, rootIndex);
            folderByItemId.set(itemId, node.id);
        }
    });

    // 새 항목은 현재 순서상 가장 가까운 이웃 옆에 붙여 폴더 묶음이 흐트러지지 않게 한다.
    const previousOwners = [];
    const previousKnownIds = [];
    let previousOwner = -1;
    let previousKnownId = '';
    for (let index = 0; index < validIds.length; index++) {
        previousOwners[index] = previousOwner;
        previousKnownIds[index] = previousKnownId;
        const ownerIndex = ownerIndices.get(validIds[index]);
        if (ownerIndex !== undefined) {
            previousOwner = ownerIndex;
            previousKnownId = validIds[index];
        }
    }

    const nextOwners = [];
    const nextKnownIds = [];
    let nextOwner = -1;
    let nextKnownId = '';
    for (let index = validIds.length - 1; index >= 0; index--) {
        nextOwners[index] = nextOwner;
        nextKnownIds[index] = nextKnownId;
        const ownerIndex = ownerIndices.get(validIds[index]);
        if (ownerIndex !== undefined) {
            nextOwner = ownerIndex;
            nextKnownId = validIds[index];
        }
    }

    const insertions = new Map();
    const folderInsertions = new Map();
    for (let index = 0; index < validIds.length; index++) {
        const itemId = validIds[index];
        if (placedItems.has(itemId)) continue;

        // 앞뒤 이웃이 같은 폴더면 그 안에, 아니면 루트에 둔다(마지막 폴더로 빨려 들어가는 것 방지).
        const absorbingFolderId = absorbingFolder(previousKnownIds[index], nextKnownIds[index], folderByItemId);
        if (absorbingFolderId) {
            const folder = folderMap.get(absorbingFolderId);
            const at = folder.items.indexOf(previousKnownIds[index]) + 1;
            if (!folderInsertions.has(absorbingFolderId)) folderInsertions.set(absorbingFolderId, new Map());
            const byIndex = folderInsertions.get(absorbingFolderId);
            if (!byIndex.has(at)) byIndex.set(at, []);
            byIndex.get(at).push(itemId);
            placedItems.add(itemId);
            continue;
        }

        const insertionIndex = previousOwners[index] !== -1
            ? previousOwners[index] + 1
            : nextOwners[index] !== -1
                ? nextOwners[index]
                : root.length;
        if (!insertions.has(insertionIndex)) insertions.set(insertionIndex, []);
        insertions.get(insertionIndex).push({ type: 'item', id: itemId });
        placedItems.add(itemId);
    }

    [...insertions.entries()]
        .sort(([left], [right]) => right - left)
        .forEach(([index, nodes]) => root.splice(index, 0, ...nodes));

    for (const [folderId, byIndex] of folderInsertions) {
        const folder = folderMap.get(folderId);
        [...byIndex.entries()]
            .sort(([left], [right]) => right - left)
            .forEach(([at, ids]) => folder.items.splice(at, 0, ...ids));
    }

    return { version: FOLDY_VERSION, root, folders };
}

// 앞 이웃과 뒤 이웃이 같은 폴더에 있을 때만 그 폴더 id를 돌려준다.
function absorbingFolder(previousId, nextId, folderByItemId) {
    if (!previousId || !nextId) return '';
    const folderId = folderByItemId.get(previousId);
    if (!folderId || folderByItemId.get(nextId) !== folderId) return '';
    return folderId;
}

// 값이 커지는 가장 긴 부분 수열의 인덱스 목록. 순서가 바뀐 항목을 최소로 골라내는 데 쓴다.
function longestIncreasingSubsequenceIndices(values) {
    const tails = [];
    const parents = new Array(values.length).fill(-1);
    for (let index = 0; index < values.length; index++) {
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (values[tails[middle]] < values[index]) low = middle + 1;
            else high = middle;
        }
        if (low > 0) parents[index] = tails[low - 1];
        if (low === tails.length) tails.push(index);
        else tails[low] = index;
    }

    const result = [];
    let cursor = tails.length ? tails[tails.length - 1] : -1;
    while (cursor !== -1) {
        result.push(cursor);
        cursor = parents[cursor];
    }
    return result.reverse();
}

function rootNodeIdentity(node) {
    return `${node.type}␟${node.id}`;
}

// 외부(다른 확장/ST)가 바꾼 항목 순서를 레이아웃에 반영한다. 폴더 소속은 유지한 채 움직인
// 항목만 옮기며, 이동 개수가 maxMoves를 넘으면(프리셋 교체 등) 따라가지 않는다.
export function layoutFollowingExternalOrder(layout, externalIds, { maxMoves = 3, onSkip = null } = {}) {
    const current = flattenLayout(layout);
    const external = [];
    const externalSet = new Set();
    for (const value of Array.isArray(externalIds) ? externalIds : []) {
        const id = String(value);
        if (!id || externalSet.has(id)) continue;
        externalSet.add(id);
        external.push(id);
    }

    // 항목 구성 자체가 다르면 normalizeLayout이 처리할 일이므로 손대지 않는다.
    if (current.length !== external.length || !current.every(id => externalSet.has(id))) return layout;
    if (current.every((id, index) => id === external[index])) return layout;

    const folderMap = new Map((layout.folders || []).map(folder => [String(folder.id), folder]));
    const ownerByItemId = new Map();
    for (const node of layout.root || []) {
        if (node.type === 'item') {
            ownerByItemId.set(String(node.id), '');
            continue;
        }
        for (const itemId of folderMap.get(String(node.id))?.items ?? []) {
            ownerByItemId.set(String(itemId), String(node.id));
        }
    }

    const positionInCurrent = new Map(current.map((id, index) => [id, index]));
    const keptIndices = new Set(longestIncreasingSubsequenceIndices(external.map(id => positionInCurrent.get(id))));
    const movedIds = new Set(external.filter((_, index) => !keptIndices.has(index)));
    if (movedIds.size > maxMoves) {
        onSkip?.({ reason: 'too-many-moves', movedCount: movedIds.size, movedIds: [...movedIds] });
        return layout;
    }

    // 움직인 항목의 새 소속은 제자리에 남은 이웃을 기준으로 정한다.
    const ownerForMoved = new Map();
    for (let index = 0; index < external.length; index++) {
        const id = external[index];
        if (!movedIds.has(id)) continue;
        let previousId = '';
        for (let cursor = index - 1; cursor >= 0; cursor--) {
            if (movedIds.has(external[cursor])) continue;
            previousId = external[cursor];
            break;
        }
        let nextId = '';
        for (let cursor = index + 1; cursor < external.length; cursor++) {
            if (movedIds.has(external[cursor])) continue;
            nextId = external[cursor];
            break;
        }
        ownerForMoved.set(id, absorbingFolder(previousId, nextId, ownerByItemId));
    }

    const folders = (layout.folders || []).map(folder => ({ ...folder, items: [] }));
    const nextFolderMap = new Map(folders.map(folder => [String(folder.id), folder]));
    const root = [];
    const emittedFolders = new Set();
    for (const id of external) {
        const owner = movedIds.has(id) ? ownerForMoved.get(id) : (ownerByItemId.get(id) ?? '');
        const folder = owner ? nextFolderMap.get(owner) : null;
        if (!folder) {
            root.push({ type: 'item', id });
            continue;
        }
        if (!emittedFolders.has(owner)) {
            emittedFolders.add(owner);
            root.push({ type: 'folder', id: owner });
        }
        folder.items.push(id);
    }

    // 빈 폴더는 외부 순서에 나타나지 않으므로, 원래 루트에서의 앞 이웃 뒤에 되돌려 놓는다.
    let anchor = '';
    for (const node of layout.root || []) {
        const id = String(node.id);
        if (node.type === 'folder' && !emittedFolders.has(id)) {
            const at = anchor ? root.findIndex(value => rootNodeIdentity(value) === anchor) + 1 : 0;
            root.splice(at, 0, { type: 'folder', id });
            anchor = rootNodeIdentity({ type: 'folder', id });
            continue;
        }
        const identity = rootNodeIdentity({ type: node.type, id });
        if (root.some(value => rootNodeIdentity(value) === identity)) anchor = identity;
    }

    const next = { version: FOLDY_VERSION, root, folders };
    // 폴더가 쪼개지는 등 외부 순서를 그대로 재현하지 못했다면 건드리지 않는다.
    const flattened = flattenLayout(next);
    if (flattened.length !== external.length || !flattened.every((id, index) => id === external[index])) {
        onSkip?.({ reason: 'order-mismatch', movedIds: [...movedIds] });
        return layout;
    }
    return next;
}

export function layoutFromTree(nodes, sourceLayout, itemIds = [], {
    preserveFolderIds = new Set(),
    normalizeOptions = {},
    onMissingPreservedFolders = null,
    onMissingSourceFolders = null,
} = {}) {
    const folderSource = new Map((sourceLayout?.folders || []).map(folder => [String(folder.id), folder]));
    const preserved = new Set([...preserveFolderIds].map(String));
    const seenPreservedFolders = new Set();
    const root = [];
    const folders = [];
    const missingSourceFolders = [];

    for (const node of Array.isArray(nodes) ? nodes : []) {
        const id = String(node?.id ?? '');
        if (!id) continue;

        if (node.type === 'folder') {
            const source = folderSource.get(id);
            if (!source) {
                missingSourceFolders.push(id);
                continue;
            }
            const items = preserved.has(id) || node.preserveItems
                ? [...source.items]
                : (Array.isArray(node.itemIds) ? node.itemIds : []).map(String).filter(Boolean);
            folders.push({ ...source, items });
            root.push({ type: 'folder', id });
            if (preserved.has(id)) seenPreservedFolders.add(id);
            continue;
        }

        if (node.type === 'item') {
            root.push({ type: 'item', id });
        }
    }

    if (missingSourceFolders.length) onMissingSourceFolders?.(missingSourceFolders);

    const missingPreservedFolders = [...preserved].filter(id => !seenPreservedFolders.has(id));
    if (missingPreservedFolders.length) {
        onMissingPreservedFolders?.(missingPreservedFolders);
        return normalizeLayout(sourceLayout, itemIds, normalizeOptions);
    }

    return normalizeLayout({ version: FOLDY_VERSION, root, folders }, itemIds, normalizeOptions);
}

export function rootNodeKey(node) {
    return `${node?.type}:${node?.id}`;
}

// 한 페이지만 DOM에 있을 때, 그 페이지 노드를 전체 루트 순서에 다시 끼워 넣는다.
// 페이지 밖 폴더는 "보존됨"으로 표시해 비었다고 오인하지 않게 한다.
export function mergePagedRootNodes(sourceLayout, domNodes, pageNodeKeys) {
    const pageKeys = new Set(pageNodeKeys || []);
    if (!pageKeys.size) return domNodes;
    const nodes = [];
    let inserted = false;
    for (const node of sourceLayout?.root || []) {
        if (pageKeys.has(rootNodeKey(node))) {
            if (!inserted) {
                nodes.push(...domNodes);
                inserted = true;
            }
            continue;
        }
        nodes.push(node.type === 'folder'
            ? { type: 'folder', id: String(node.id), preserveItems: true }
            : { type: 'item', id: String(node.id) });
    }
    if (!inserted) nodes.push(...domNodes);
    return nodes;
}

export function remapImportedLayout(layout, itemIdMap, createFolderId = generateUUID) {
    // 루트에서 연결된 폴더만 유지한다(고아 폴더는 버려짐).
    const rootedFolderIds = new Set((layout?.root || [])
        .filter(node => node?.type === 'folder')
        .map(node => String(node.id)));
    const sourceFolders = (layout?.folders || []).filter(folder => rootedFolderIds.has(String(folder.id)));
    const folderIdMap = new Map(sourceFolders.map(folder => [String(folder.id), createFolderId()]));
    return {
        version: FOLDY_VERSION,
        root: (layout?.root || []).map(node => {
            if (node.type === 'folder') return { type: 'folder', id: folderIdMap.get(String(node.id)) };
            return { type: 'item', id: itemIdMap.get(String(node.id)) };
        }).filter(node => node.id),
        folders: sourceFolders.map(folder => ({
            ...folder,
            id: folderIdMap.get(String(folder.id)),
            items: (folder.items || []).map(id => itemIdMap.get(String(id))).filter(Boolean),
        })).filter(folder => folder.id),
    };
}

function removeItemsFromLayout(layout, itemIds) {
    const ids = new Set(itemIds);
    return {
        version: FOLDY_VERSION,
        root: (layout.root || []).filter(node => node.type !== 'item' || !ids.has(String(node.id))),
        folders: (layout.folders || []).map(folder => ({
            ...folder,
            items: (folder.items || []).filter(id => !ids.has(String(id))),
        })),
    };
}

export function mergeImportedLayout(currentLayout, importedLayout, allIds, options = {}) {
    const importedIds = flattenLayout(importedLayout);
    const baseLayout = removeItemsFromLayout(currentLayout, importedIds);
    return normalizeLayout({
        version: FOLDY_VERSION,
        root: [...importedLayout.root, ...baseLayout.root],
        folders: [...importedLayout.folders, ...baseLayout.folders],
    }, allIds, options);
}

export function removeFolder(layout, folderId) {
    const root = [...(layout.root || [])];
    const folders = [...(layout.folders || [])];
    const folder = folders.find(value => value.id === folderId);
    const rootIndex = root.findIndex(node => node.type === 'folder' && node.id === folderId);
    if (!folder || rootIndex === -1) return layout;

    root.splice(rootIndex, 1, ...(folder.items || []).map(id => ({ type: 'item', id })));
    return {
        version: FOLDY_VERSION,
        root,
        folders: folders.filter(value => value.id !== folderId),
    };
}

export function hasDuplicateFolderName(layout, name, exceptId = null) {
    const normalized = String(name).trim().toLocaleLowerCase();
    return layout.folders.some(folder => folder.id !== exceptId && folder.name.trim().toLocaleLowerCase() === normalized);
}

export function rootItemIds(layout) {
    return (layout.root || [])
        .filter(node => node?.type === 'item' && node.id)
        .map(node => String(node.id));
}

function layoutItemIdSet(layout) {
    const ids = new Set(rootItemIds(layout));
    for (const folder of layout?.folders || []) {
        for (const id of folder.items || []) ids.add(String(id));
    }
    return ids;
}

export function layoutIntegrityDiff(previousLayout, nextLayout) {
    const previousFolderIds = new Set((previousLayout?.folders || []).map(folder => String(folder.id)));
    const nextFolderIds = new Set((nextLayout?.folders || []).map(folder => String(folder.id)));
    const previousItemIds = layoutItemIdSet(previousLayout);
    const nextItemIds = layoutItemIdSet(nextLayout);
    const missingFolderIds = [...previousFolderIds].filter(id => !nextFolderIds.has(id));
    const addedFolderIds = [...nextFolderIds].filter(id => !previousFolderIds.has(id));
    const missingItemIds = [...previousItemIds].filter(id => !nextItemIds.has(id));
    const addedItemIds = [...nextItemIds].filter(id => !previousItemIds.has(id));
    return {
        ok: !missingFolderIds.length && !addedFolderIds.length && !missingItemIds.length && !addedItemIds.length,
        previousFolderCount: previousFolderIds.size,
        nextFolderCount: nextFolderIds.size,
        previousItemCount: previousItemIds.size,
        nextItemCount: nextItemIds.size,
        missingFolderIds,
        addedFolderIds,
        missingItemIds,
        addedItemIds,
    };
}

export function createRenderGate() {
    let running = false;
    let queued = false;
    let requestedAfterRun = false;
    return {
        isRunning: () => running,
        isQueued: () => queued,
        requestAfterRun() {
            requestedAfterRun = true;
        },
        async run(action, afterRequested = null) {
            if (running) {
                requestedAfterRun = true;
                return false;
            }
            running = true;
            try {
                await action();
                return true;
            } finally {
                running = false;
                if (requestedAfterRun) {
                    requestedAfterRun = false;
                    afterRequested?.();
                }
            }
        },
        queue(action, beforeQueue = null) {
            if (queued) return false;
            beforeQueue?.();
            queued = true;
            setTimeout(async () => {
                queued = false;
                await action();
            }, 0);
            return true;
        },
    };
}

// 항상 새 레이아웃 객체를 반환한다. 호출부는 이 identity를 값싼 낡음(staleness) 검사로 쓴다.
export function layoutWithItemMovedToFolder(layout, itemId, folderId) {
    const id = String(itemId);
    const currentRootIndex = layout.root.findIndex(node => node.type === 'item' && node.id === id);
    const currentFolder = layout.folders.find(folder => folder.items.includes(id));
    const currentFolderId = currentFolder?.id ?? '';
    const targetFolderId = String(folderId ?? '');
    if (currentRootIndex !== -1 && !targetFolderId) return { changed: false, layout };
    if (currentFolderId === targetFolderId) return { changed: false, layout };
    if (targetFolderId && !layout.folders.some(value => value.id === targetFolderId)) return { changed: false, layout };

    const root = layout.root.filter(node => !(node.type === 'item' && node.id === id));
    const folders = layout.folders.map(folder => ({
        ...folder,
        items: folder.items.filter(value => value !== id),
    }));

    if (!targetFolderId) {
        return {
            changed: true,
            layout: { ...layout, root: [{ type: 'item', id }, ...root], folders },
        };
    }

    return {
        changed: true,
        layout: {
            ...layout,
            root,
            folders: folders.map(folder => folder.id === targetFolderId
                ? { ...folder, items: [...folder.items, id] }
                : folder),
        },
    };
}

export function layoutWithItemsMovedToFolder(layout, itemIds, folderId) {
    const ids = itemIds.map(String);
    if (!ids.length) return { changed: false, layout };
    const idSet = new Set(ids);
    const targetFolderId = String(folderId ?? '');
    if (targetFolderId && !layout.folders.some(value => value.id === targetFolderId)) return { changed: false, layout };

    const root = layout.root.filter(node => !(node.type === 'item' && idSet.has(String(node.id))));
    const folders = layout.folders.map(folder => ({
        ...folder,
        items: folder.items.filter(value => !idSet.has(String(value))),
    }));

    if (!targetFolderId) {
        return {
            changed: true,
            layout: { ...layout, root: [...ids.map(id => ({ type: 'item', id })), ...root], folders },
        };
    }

    return {
        changed: true,
        layout: {
            ...layout,
            root,
            folders: folders.map(folder => folder.id === targetFolderId
                ? { ...folder, items: [...folder.items, ...ids] }
                : folder),
        },
    };
}

// afterKey 노드가 remainingRoot에서 이미 빠졌다면(옮겨진 항목이거나 자기 자신) 원래 그
// 앞에 남아있던 가장 가까운 노드 뒤에 대신 꽂는다. 못 찾으면 맨 위(0).
function insertionIndexAfter(originalRoot, remainingRoot, afterKey) {
    if (!afterKey) return 0;
    const originalIndex = originalRoot.findIndex(node => rootNodeKey(node) === afterKey);
    if (originalIndex === -1) return 0;

    let insertAt = 0;
    for (let index = 0; index <= originalIndex; index++) {
        const key = rootNodeKey(originalRoot[index]);
        const remainingIndex = remainingRoot.findIndex(node => rootNodeKey(node) === key);
        if (remainingIndex !== -1) insertAt = remainingIndex + 1;
    }
    return insertAt;
}

export function layoutWithAddedFolder(layout, folderName, itemIds = [], createFolderId = generateUUID, { afterKey = '' } = {}) {
    const selected = new Set(itemIds.map(String));
    const folder = { id: createFolderId(), name: folderName, color: '', items: [...selected] };
    const remainingRoot = layout.root.filter(node => node?.type !== 'item' || !selected.has(String(node.id)));
    const insertAt = insertionIndexAfter(layout.root, remainingRoot, afterKey);

    const root = [...remainingRoot];
    root.splice(insertAt, 0, { type: 'folder', id: folder.id });
    return {
        changed: true,
        folder,
        layout: { ...layout, folders: [...layout.folders, folder], root },
    };
}

// 폴더를 root 안 다른 위치로 옮긴다. 내용물은 그대로 두고 노드 하나만 옮기므로
// layoutWithAddedFolder보다 단순하다.
export function layoutWithMovedFolder(layout, folderId, afterKey = '') {
    const id = String(folderId ?? '');
    const folderKey = `folder:${id}`;
    if (!layout.folders.some(folder => folder.id === id)) return { changed: false, layout };
    if (afterKey === folderKey) return { changed: false, layout };

    const remainingRoot = layout.root.filter(node => rootNodeKey(node) !== folderKey);
    const insertAt = insertionIndexAfter(layout.root, remainingRoot, afterKey);

    const root = [...remainingRoot];
    root.splice(insertAt, 0, { type: 'folder', id });
    if (root.length === layout.root.length && root.every((node, index) => rootNodeKey(node) === rootNodeKey(layout.root[index]))) {
        return { changed: false, layout };
    }
    return { changed: true, layout: { ...layout, root } };
}

// 항상 새 레이아웃 객체를 반환해, 대기 중인 다이얼로그가 낡음을 감지할 수 있게 한다.
export function layoutWithUpdatedFolder(layout, folderId, values = {}, { applyStyleToAll = false } = {}) {
    const id = String(folderId ?? '');
    const source = layout.folders.find(folder => folder.id === id);
    if (!source) return { changed: false, layout };

    const style = folderStyleValues(values);
    const folders = layout.folders.map(folder => {
        if (folder.id === id) return { ...folder, ...values };
        return applyStyleToAll ? { ...folder, ...style } : folder;
    });
    return { changed: true, layout: { ...layout, folders } };
}
