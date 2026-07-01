import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createEmptyLayout,
    flattenLayout,
    normalizeLayout,
    orderItemsByLayout,
} from './model.js';

test('createEmptyLayout creates root items in source order', () => {
    assert.deepEqual(createEmptyLayout(['a', 2]).root, [
        { type: 'item', id: 'a' },
        { type: 'item', id: '2' },
    ]);
});

test('normalizeLayout removes invalid and duplicate items while preserving folder styling', () => {
    const layout = normalizeLayout({
        root: [
            { type: 'folder', id: 'folder-a' },
            { type: 'item', id: 'b' },
            { type: 'item', id: 'b' },
            { type: 'item', id: 'missing' },
        ],
        folders: [{
            id: 'folder-a',
            name: 'Design',
            color: '#111111',
            borderColor: '#222222',
            nameColor: '#333333',
            items: ['a', 'missing', 'a'],
        }],
    }, ['a', 'b']);

    assert.deepEqual(layout.root, [
        { type: 'folder', id: 'folder-a' },
        { type: 'item', id: 'b' },
    ]);
    assert.deepEqual(layout.folders[0], {
        id: 'folder-a',
        name: 'Design',
        color: '#111111',
        borderColor: '#222222',
        nameColor: '#333333',
        items: ['a'],
    });
    assert.deepEqual(flattenLayout(layout), ['a', 'b']);
});

test('normalizeLayout inserts consecutive missing items after the nearest previous owner', () => {
    const layout = normalizeLayout({
        root: [{ type: 'folder', id: 'folder-a' }],
        folders: [{
            id: 'folder-a',
            name: 'Folder',
            items: ['a', 'd'],
        }],
    }, ['a', 'b', 'c', 'd']);

    assert.deepEqual(layout.root, [
        { type: 'folder', id: 'folder-a' },
        { type: 'item', id: 'b' },
        { type: 'item', id: 'c' },
    ]);
    assert.deepEqual(flattenLayout(layout), ['a', 'd', 'b', 'c']);
});

test('normalizeLayout inserts missing items before the nearest next owner when no previous owner exists', () => {
    const layout = normalizeLayout({
        root: [{ type: 'item', id: 'c' }],
        folders: [],
    }, ['a', 'b', 'c']);

    assert.deepEqual(layout.root, [
        { type: 'item', id: 'a' },
        { type: 'item', id: 'b' },
        { type: 'item', id: 'c' },
    ]);
});

test('normalizeLayout keeps empty folders and can drop unrooted folders', () => {
    const preserved = normalizeLayout({
        root: [],
        folders: [{ id: 'empty', name: 'Empty', items: [] }],
    }, ['a']);

    assert.deepEqual(preserved.root, [
        { type: 'folder', id: 'empty' },
        { type: 'item', id: 'a' },
    ]);
    assert.equal(preserved.folders.length, 1);

    const dropped = normalizeLayout({
        root: [],
        folders: [{ id: 'empty', name: 'Empty', items: [] }],
    }, ['a'], { preserveUnrootedFolders: false });

    assert.deepEqual(dropped.root, [{ type: 'item', id: 'a' }]);
    assert.deepEqual(dropped.folders, []);
});

test('normalizeLayout keeps duplicate folder names unique', () => {
    const layout = normalizeLayout({
        root: [
            { type: 'folder', id: 'first' },
            { type: 'folder', id: 'second' },
        ],
        folders: [
            { id: 'first', name: 'Same', items: [] },
            { id: 'second', name: 'same', items: [] },
        ],
    }, []);

    assert.deepEqual(layout.folders.map(folder => folder.name), ['Same', 'same (2)']);
});

test('orderItemsByLayout appends items missing from layout instead of dropping them', () => {
    const items = [
        { id: 'a', disabled: true },
        { id: 'b', disabled: false },
        { id: 'c', disabled: false },
    ];
    const layout = normalizeLayout({
        root: [{ type: 'folder', id: 'folder-a' }],
        folders: [{ id: 'folder-a', name: 'Folder', items: ['b'] }],
    }, ['b']);

    assert.deepEqual(orderItemsByLayout(layout, items).map(item => item.id), ['b', 'a', 'c']);
});
