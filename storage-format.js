import { FOLDY_VERSION } from './model.js';

export const STORE_VERSION = 2;
export const REGEX_LAYOUT_TYPES = ['global', 'scoped', 'preset'];

const STYLE_KEYS = [['color', 'c'], ['borderColor', 'b'], ['nameColor', 't']];

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 쉼표가 들어간 ID가 하나라도 있으면 배열로 남긴다.
function joinIds(ids) {
    return ids.some(id => id.includes(',')) ? [...ids] : ids.join(',');
}

function splitIds(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value !== 'string' || !value) return [];
    return value.split(',');
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

// 저장 형식과 무관한 차이(폴더 ID, 빈 스타일, version)를 지운 비교용 문자열이다.
function canonicalLayout(layout, collapsedIds) {
    if (!isRecord(layout)) return stableStringify({ invalid: layout ?? null });
    const folders = Array.isArray(layout.folders) ? layout.folders : [];
    const positions = new Map(folders.map((folder, index) => [String(folder?.id), index]));
    const collapsed = new Set([...collapsedIds].map(String));
    const { version: _version, root, folders: _folders, ...extra } = layout;
    return stableStringify({
        extra,
        root: Array.isArray(root)
            ? root.map(node => (node?.type === 'folder' && Object.keys(node).length === 2
                ? { folderAt: positions.has(String(node.id)) ? positions.get(String(node.id)) : `missing:${node.id}` }
                : node))
            : root ?? null,
        folders: Array.isArray(layout.folders)
            ? folders.map(folder => {
                if (!isRecord(folder)) return { invalid: folder ?? null };
                const { id: _id, ...rest } = folder;
                for (const [key] of STYLE_KEYS) if (rest[key] === '' || rest[key] === undefined) delete rest[key];
                return { ...rest, collapsed: collapsed.has(String(folder.id)) };
            })
            : layout.folders ?? null,
    });
}

function encodeLayoutUnchecked(layout, collapsedIds) {
    const collapsed = new Set([...collapsedIds].map(String));
    const positions = new Map(layout.folders.map((folder, index) => [String(folder.id), index]));
    const root = layout.root.map(node => (node.type === 'folder'
        ? `f${positions.get(String(node.id))}`
        : `i${node.id}`));
    return {
        r: joinIds(root),
        f: layout.folders.map(folder => {
            const encoded = { n: folder.name, i: joinIds(folder.items.map(String)) };
            for (const [key, short] of STYLE_KEYS) if (folder[key]) encoded[short] = folder[key];
            if (collapsed.has(String(folder.id))) encoded.x = 1;
            return encoded;
        }),
    };
}

export function decodeLayout(encoded) {
    if (isRecord(encoded) && Object.hasOwn(encoded, 'v1')) {
        return { layout: encoded.v1, collapsedIds: Array.isArray(encoded.v1c) ? encoded.v1c : [] };
    }
    const source = isRecord(encoded) ? encoded : {};
    const folders = (Array.isArray(source.f) ? source.f : []).map((value, index) => {
        const folder = isRecord(value) ? value : {};
        return {
            id: String(index + 1),
            name: String(folder.n ?? ''),
            color: typeof folder.c === 'string' ? folder.c : '',
            borderColor: typeof folder.b === 'string' ? folder.b : '',
            nameColor: typeof folder.t === 'string' ? folder.t : '',
            items: splitIds(folder.i),
        };
    });
    const root = splitIds(source.r).flatMap(entry => {
        if (entry.startsWith('f')) {
            const index = Number(entry.slice(1));
            return Number.isInteger(index) && folders[index] ? [{ type: 'folder', id: folders[index].id }] : [];
        }
        return entry.startsWith('i') && entry.length > 1 ? [{ type: 'item', id: entry.slice(1) }] : [];
    });
    const collapsedIds = (Array.isArray(source.f) ? source.f : [])
        .map((value, index) => (isRecord(value) && value.x ? folders[index].id : null))
        .filter(Boolean);
    return { layout: { version: FOLDY_VERSION, root, folders }, collapsedIds };
}

// 다시 풀었을 때 원본과 같을 때만 압축하고, 아니면 원본을 그대로 담는다.
export function encodeLayout(layout, collapsedIds = []) {
    const collapsed = Array.isArray(collapsedIds) ? collapsedIds : [];
    try {
        if (isRecord(layout) && Array.isArray(layout.root) && Array.isArray(layout.folders)) {
            const encoded = encodeLayoutUnchecked(layout, collapsed);
            const decoded = decodeLayout(encoded);
            if (canonicalLayout(decoded.layout, decoded.collapsedIds) === canonicalLayout(layout, collapsed)) return encoded;
        }
    } catch {
        // 압축할 수 없는 구조는 아래에서 원본으로 보존한다.
    }
    const fallback = { v1: JSON.parse(JSON.stringify(layout ?? null)) };
    if (collapsed.length) fallback.v1c = collapsed.map(String);
    return fallback;
}

function regexCollapsedKey(typeKey, owner) {
    return `${typeKey}:${owner}`;
}

function encodeBucket(layouts, collapsed, collapsedKey) {
    return Object.fromEntries(Object.entries(isRecord(layouts) ? layouts : {})
        .map(([owner, layout]) => [owner, encodeLayout(layout, collapsed?.[collapsedKey(owner)])]));
}

function decodeBucket(encodedBucket, collapsedBucket, collapsedKey) {
    return Object.fromEntries(Object.entries(isRecord(encodedBucket) ? encodedBucket : {}).map(([owner, encoded]) => {
        const { layout, collapsedIds } = decodeLayout(encoded);
        if (collapsedIds.length) {
            Object.defineProperty(collapsedBucket, collapsedKey(owner), {
                value: collapsedIds.map(String), enumerable: true, configurable: true, writable: true,
            });
        }
        return [owner, layout];
    }));
}

export function encodeStore(layouts = {}, collapsed = {}) {
    const source = isRecord(layouts) ? layouts : {};
    const states = isRecord(collapsed) ? collapsed : {};
    return {
        v: STORE_VERSION,
        prompts: encodeBucket(source.prompts, states.prompt, owner => owner),
        lorebooks: encodeBucket(source.lorebooks, states.lore, owner => owner),
        regex: Object.fromEntries(REGEX_LAYOUT_TYPES.map(typeKey => [
            typeKey,
            encodeBucket(source.regex?.[typeKey], states.regex, owner => regexCollapsedKey(typeKey, owner)),
        ])),
    };
}

export function decodeStore(store) {
    const source = isRecord(store) ? store : {};
    const collapsed = { prompt: {}, lore: {}, regex: {} };
    const layouts = {
        prompts: decodeBucket(source.prompts, collapsed.prompt, owner => owner),
        lorebooks: decodeBucket(source.lorebooks, collapsed.lore, owner => owner),
        regex: Object.fromEntries(REGEX_LAYOUT_TYPES.map(typeKey => [
            typeKey,
            decodeBucket(source.regex?.[typeKey], collapsed.regex, owner => regexCollapsedKey(typeKey, owner)),
        ])),
    };
    return { layouts, collapsed };
}

export function isStoredStore(value) {
    return isRecord(value) && value.v === STORE_VERSION;
}
