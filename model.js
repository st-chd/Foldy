import { folderStyleValues } from './folder-style.js';

export const FOLDY_VERSION = 1;

export function generateUUID() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }

    // Fallback is only for older WebViews without crypto.randomUUID; collisions
    // are extremely unlikely for local folder IDs, but this is not crypto-safe.
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
    const byId = new Map(items
        .map(item => [String(getId(item) ?? ''), item])
        .filter(([id]) => id));
    const used = new Set();
    const ordered = [];

    for (const id of flattenLayout(layout)) {
        const item = byId.get(String(id));
        if (!item || used.has(String(id))) continue;
        ordered.push(item);
        used.add(String(id));
    }

    for (const item of items) {
        const id = String(getId(item) ?? '');
        if (!id || used.has(id)) continue;
        ordered.push(item);
        used.add(id);
    }

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

// Reconciles a saved folder layout with SillyTavern's current item order. Items
// already owned by a root node establish owner positions; missing items are then
// inserted after the nearest previous owner, or before the nearest next owner.
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

    const ownerIndices = new Map();
    root.forEach((node, rootIndex) => {
        if (node.type === 'item') {
            ownerIndices.set(node.id, rootIndex);
            return;
        }
        for (const itemId of folderMap.get(node.id)?.items ?? []) {
            ownerIndices.set(itemId, rootIndex);
        }
    });

    // Newly discovered items stay near the closest known neighbor from the
    // current ST order, preserving folder groups when SillyTavern adds items.
    const previousOwners = [];
    let previousOwner = -1;
    for (let index = 0; index < validIds.length; index++) {
        previousOwners[index] = previousOwner;
        const ownerIndex = ownerIndices.get(validIds[index]);
        if (ownerIndex !== undefined) previousOwner = ownerIndex;
    }

    const nextOwners = [];
    let nextOwner = -1;
    for (let index = validIds.length - 1; index >= 0; index--) {
        nextOwners[index] = nextOwner;
        const ownerIndex = ownerIndices.get(validIds[index]);
        if (ownerIndex !== undefined) nextOwner = ownerIndex;
    }

    const insertions = new Map();
    for (let index = 0; index < validIds.length; index++) {
        const itemId = validIds[index];
        if (placedItems.has(itemId)) continue;

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

    return { version: FOLDY_VERSION, root, folders };
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

export function remapImportedLayout(layout, itemIdMap, createFolderId = generateUUID) {
    // Only folders reachable from root are meaningful; dangling folder objects
    // are dropped during import remapping just like layoutFromTree normalization.
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

// Layout transformation helpers return fresh layout objects. Callers rely on
// layout identity as a cheap staleness check while dialogs and renders await.
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

export function layoutWithAddedFolder(layout, folderName, itemIds = [], createFolderId = generateUUID) {
    const selected = new Set(itemIds.map(String));
    const folder = { id: createFolderId(), name: folderName, color: '', items: [...selected] };
    return {
        changed: true,
        folder,
        layout: {
            ...layout,
            folders: [...layout.folders, folder],
            root: [
                { type: 'folder', id: folder.id },
                ...layout.root.filter(node => node?.type !== 'item' || !selected.has(String(node.id))),
            ],
        },
    };
}

// Folder edits must replace the layout object so an open dialog can detect
// that another operation has changed its source layout while it was awaiting.
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
