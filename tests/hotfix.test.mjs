import test from 'node:test';
import assert from 'node:assert/strict';
import { createFoldyDataCleanup } from '../clear-data-dialog.js';
import { removeFolder, flattenLayout } from '../model.js';
import { createBundleActions } from '../bundle-utils.js';
import { createConfirmDialogs } from '../folder-dialogs.js';
import { createRegexBundleActions } from '../regex-integration.js';

const layout = {
    version: 1,
    root: [{ type: 'folder', id: 'a' }, { type: 'item', id: 'outside' }, { type: 'folder', id: 'b' }],
    folders: [{ id: 'a', name: 'A', items: ['one'] }, { id: 'b', name: 'B', items: ['two'] }],
};

test('unused owners display names while keeping their original storage keys', () => {
    const owners = ['["openai","My preset"]', 'openai:Legacy', '["openai","이름:기호"]'];
    const report = { layouts: { prompts: owners }, collapsed: { prompt: owners } };
    const items = createFoldyDataCleanup({}).unusedFoldyDataItems(report, 'prompts');
    assert.deepEqual(items.map(item => item.label), ['My preset', 'Legacy', '이름:기호']);
    assert.deepEqual(items.map(item => item.value), owners);
});

test('folder-only deletion preserves items, content deletion removes only its items', () => {
    assert.deepEqual(flattenLayout(removeFolder(layout, 'a')), ['one', 'outside', 'two']);
    assert.deepEqual(flattenLayout(removeFolder(layout, 'a', { deleteContents: true })), ['outside', 'two']);
    assert.deepEqual(flattenLayout(layout), ['one', 'outside', 'two']);
});

// Minimal DOM for popup controls; exercise the production popup factories.
class Element {
    children = [];
    style = {};
    listeners = {};
    checked = false;
    append(...children) { this.children.push(...children); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
function popupDeps(interact) {
    globalThis.document = { createElement: () => new Element() };
    globalThis.toastr = { warning() {}, success() {} };
    return {
        POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1 },
        Popup: class {
            constructor(body, type, text, options) { Object.assign(this, { body, options }); }
            async show() { return interact(this.body, this.options); }
        },
    };
}

test('delete dialog defaults to folder-only, supports contents, and preserves cancellation', async () => {
    for (const requested of ['folder', 'contents', null]) {
        const api = createConfirmDialogs(popupDeps(body => {
            const radios = descendants(body).filter(node => node.type === 'radio');
            assert.equal(radios[0].checked, true);
            if (requested === 'contents') radios.forEach(node => { node.checked = node.value === requested; });
            return requested ? 1 : 0;
        }));
        assert.equal(await api.confirmFolderDelete('A', '항목'), requested);
    }
});

test('regex folder selection is hidden by default, toggles, and requires a selection', async () => {
    const api = createBundleActions(popupDeps((body, options) => {
        const list = descendants(body).find(node => node.className === 'foldy-selection-list');
        const checkboxes = descendants(body).filter(node => node.type === 'checkbox');
        assert.equal(list.hidden, true);
        checkboxes[0].checked = true;
        checkboxes[0].listeners.change();
        assert.equal(list.hidden, false);
        assert.equal(options.onClosing({ result: 1 }), false);
        checkboxes[1].checked = true;
        assert.equal(options.onClosing({ result: 1 }), true);
        checkboxes[0].checked = false;
        checkboxes[0].listeners.change();
        assert.equal(list.hidden, true);
        checkboxes[0].checked = true;
        checkboxes[0].listeners.change();
        return 1;
    }));
    assert.deepEqual(await api.requestBundleExportMode('Export', 'Full', 'Layout', '', 'test', layout.folders), {
        mode: 'full', folderIds: ['a'],
    });
});

test('non-regex export retains the existing mode result and has no folder controls', async () => {
    const api = createBundleActions(popupDeps(body => {
        assert.equal(descendants(body).some(node => node.type === 'checkbox'), false);
        return 1;
    }));
    assert.equal(await api.requestBundleExportMode('Export', 'Full', 'Layout', ''), 'full');
});

for (const mode of ['full', 'layout']) {
    for (const folderIds of [null, ['a'], ['a', 'b']]) {
        test(`regex ${mode} export selection ${JSON.stringify(folderIds)}`, async () => {
            let result;
            const api = createRegexBundleActions({
                regexTypes: { global: { label: 'Global', scriptType: 0 } },
                regexExportName: () => 'Global',
                readRegexLayout: () => ({ owner: 'global', layout }),
                getScriptsByType: () => ['one', 'outside', 'two'].map(id => ({ id, scriptName: id })),
                requestBundleExportMode: async () => ({ mode, folderIds }),
                downloadJson: async value => { result = value; return true; },
            });
            await api.exportRegexBundle('global');
            const expected = folderIds === null ? ['one', 'outside', 'two'] : folderIds.length === 1 ? ['one'] : ['one', 'two'];
            assert.deepEqual(flattenLayout(result.layout), expected);
            assert.deepEqual((mode === 'full' ? result.scripts : result.scriptRefs).map(item => item.id), expected);
            assert.equal(result.contents, mode === 'layout' ? 'layout' : undefined);
        });
    }
}

// Execute the actual deletion callbacks with storage and UI boundaries stubbed.
// This keeps destructive-path checks independent of a running user account.
import { readFile } from 'node:fs/promises';
import { normalizeLayout } from '../model.js';
async function deletionCallback(file, bindings) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const start = source.indexOf('const onDelete = async id => {') + 'const onDelete = '.length;
    const end = source.indexOf('\n        };', start) + '\n        }'.length;
    return new Function(...Object.keys(bindings), `return (${source.slice(start, end)});`)(...Object.values(bindings));
}
for (const mode of [null, 'folder', 'contents']) {
    test(`regex deletion persists correct scripts and layout: ${mode}`, async () => {
        let scripts = ['one', 'outside', 'two'].map(id => ({ id }));
        let savedLayout;
        const remove = await deletionCallback('regex-integration.js', {
            layout: structuredClone(layout), typeKey: 'global', owner: 'global',
            confirmFolderDelete: async () => mode, rerenderIfRegexContextChanged: () => false,
            regexTypes: { global: { scriptType: 0 } }, getScriptsByType: () => scripts,
            saveScriptsByType: async value => { scripts = value; },
            saveSettingsDebounced() {}, removeFolder,
            persistRegexLayout: async (type, owner, value) => { savedLayout = value; },
            getCurrentChatId: () => null, rerender() {},
        });
        await remove('a');
        assert.deepEqual(scripts.map(item => item.id), mode === 'contents' ? ['outside', 'two'] : ['one', 'outside', 'two']);
        if (mode) assert.deepEqual(flattenLayout(savedLayout), mode === 'contents' ? ['outside', 'two'] : ['one', 'outside', 'two']);
        else assert.equal(savedLayout, undefined);
    });
    test(`prompt deletion preserves protected prompts and unrelated items: ${mode}`, async () => {
        const currentPromptLayout = structuredClone(layout);
        currentPromptLayout.folders[0].items.push('system');
        const prompts = ['one', 'outside', 'two', 'system'].map(identifier => ({ identifier, system_prompt: identifier === 'system' }));
        const manager = {
            serviceSettings: { prompts, prompt_order: [{ order: prompts.map(prompt => ({ identifier: prompt.identifier })) }] },
            getPromptById: id => prompts.find(prompt => prompt.identifier === id),
            isPromptDeletionAllowed: prompt => !prompt.system_prompt,
        };
        let savedLayout;
        const remove = await deletionCallback('prompt-integration.js', {
            currentPromptLayout, manager, owner: 'preset',
            confirmFolderDelete: async (name, label, options) => { assert.equal(options.protectedCount, 1); return mode; },
            rerenderIfPromptContextChanged: () => false,
            removeFolder, normalizeLayout,
            promptOrderIds: () => manager.serviceSettings.prompt_order[0].order.map(item => item.identifier),
            persistPromptLayout: async (owner, value) => { savedLayout = value; }, rerender() {},
        });
        await remove('a');
        assert.deepEqual(manager.serviceSettings.prompts.map(item => item.identifier), mode === 'contents' ? ['outside', 'two', 'system'] : ['one', 'outside', 'two', 'system']);
        if (mode) assert.ok(flattenLayout(savedLayout).includes('system'));
        else assert.equal(savedLayout, undefined);
    });
}

test('lorebook content deletion removes original entries and preserves other folders', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function deleteLorebookFolderContents(');
    const end = source.indexOf('\nasync function deleteLorebookEntryInFolderOrder', start);
    const data = { entries: Object.fromEntries(['one', 'outside', 'two'].map(uid => [uid, { uid }])) };
    let savedLayout;
    const originalDeleted = [];
    const bindings = {
        currentLorebookOwner: () => ({ name: 'Book', owner: 'book' }),
        enqueueLorebookWrite: async (name, fn) => fn(), loadWorldInfo: async () => data,
        isLoreOriginalDataCompatible: () => true,
        settings: () => ({ layouts: { lorebooks: { book: structuredClone(layout) } } }),
        deleteWorldInfoEntry: async (value, uid, options) => { assert.equal(options.silent, true); delete value.entries[uid]; return true; },
        deleteWIOriginalDataValue: (value, uid) => originalDeleted.push(uid),
        saveWorldInfo: async () => {}, normalizeLayout,
        persistLoreLayout: async (owner, value) => { savedLayout = value; }, queueLoreRender() {},
    };
    const remove = new Function(...Object.keys(bindings), `return (${source.slice(start, end)});`)(...Object.values(bindings));
    await remove('book', 'a');
    assert.deepEqual(Object.keys(data.entries), ['outside', 'two']);
    assert.deepEqual(originalDeleted, ['one']);
    assert.deepEqual(flattenLayout(savedLayout), ['outside', 'two']);
});
