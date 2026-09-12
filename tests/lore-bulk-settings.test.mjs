import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLoreEntrySettings, requestLoreFolderSettings } from '../lore-bulk-settings.js';

test('bulk changes preserve unselected settings and synchronize original entry fields', () => {
    const entry = { uid: 1, content: 'keep', scanDepth: 5, constant: true, caseSensitive: true };
    const outside = { uid: 2, scanDepth: 7 };
    const data = { entries: { 1: entry, 2: outside } };
    const writes = [];
    const sync = (data, uid, path, value) => writes.push([uid, path, value]);
    applyLoreEntrySettings(data, entry, { scanDepth: null, caseSensitive: false, ignoreBudget: true }, sync);
    assert.deepEqual(entry, { uid: 1, content: 'keep', scanDepth: null, constant: true, caseSensitive: false, ignoreBudget: true });
    assert.deepEqual(outside, { uid: 2, scanDepth: 7 });
    assert.deepEqual(writes, [[1, 'extensions.scan_depth', null], [1, 'extensions.case_sensitive', false], [1, 'extensions.ignore_budget', true]]);
    applyLoreEntrySettings(data, undefined, { scanDepth: 0 }, sync);
});

test('strategy, position, recursion and nullable values can be applied together', () => {
    const entry = { uid: 3 };
    const writes = [];
    const sync = (data, uid, path, value) => writes.push([path, value]);
    applyLoreEntrySettings({}, entry, {
        strategy: 'vectorized', position: '4:2', scanDepth: 0, matchWholeWords: null,
        excludeRecursion: true, preventRecursion: false, delayUntilRecursion: 3,
    }, sync);
    assert.deepEqual(entry, { uid: 3, constant: false, vectorized: true, position: 4, role: 2,
        scanDepth: 0, matchWholeWords: null, excludeRecursion: true, preventRecursion: false, delayUntilRecursion: 3 });
    assert.ok(writes.some(([path, value]) => path === 'extensions.delay_until_recursion' && value === 3));
    applyLoreEntrySettings({}, entry, { position: '0:', delayUntilRecursion: false }, sync);
    assert.equal(entry.role, null);
    assert.equal(entry.delayUntilRecursion, false);
    assert.ok(writes.some(([path, value]) => path === 'position' && value === 'before_char'));
});

class Element {
    children = [];
    listeners = {};
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(name, fn) { this.listeners[name] = fn; }
    reportValidity() {
        return this.value !== '' && Number.isInteger(Number(this.value))
            && Number(this.value) >= Number(this.min) && Number(this.value) <= Number(this.max);
    }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
async function dialog(interact) {
    const original = globalThis.document;
    globalThis.document = { createElement: tag => Object.assign(new Element(), { tag }) };
    try {
        return await requestLoreFolderSettings({ name: '<folder>' }, {
            POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1 }, maxScanDepth: 1000,
            Popup: class {
                constructor(body, type, text, options) { Object.assign(this, { body, options }); }
                async show() { return interact(descendants(this.body), this.options); }
            },
        });
    } finally {
        globalThis.document = original;
    }
}

test('dialog defaults to no changes, cancellation discards selections', async () => {
    assert.deepEqual(await dialog(nodes => {
        assert.equal(nodes.filter(node => node.tag === 'select').length, 9);
        return 1;
    }), {});
    assert.equal(await dialog(nodes => {
        nodes.find(node => node.name === 'strategy').value = 'constant';
        return 0;
    }), null);
});

test('dialog validates numeric limits and distinguishes false, default and unchanged', async () => {
    const result = await dialog((nodes, options) => {
        const scan = nodes.find(node => node.name === 'scanDepth');
        const input = nodes.find(node => node.tag === 'input');
        scan.value = 'number';
        scan.listeners.change();
        assert.equal(input.disabled, false);
        for (const value of ['', '-1', '1.5', '1001']) {
            input.value = value;
            assert.equal(options.onClosing({ result: 1 }), false);
        }
        input.value = '1000';
        assert.equal(options.onClosing({ result: 1 }), true);
        nodes.find(node => node.name === 'caseSensitive').value = 'null';
        nodes.find(node => node.name === 'preventRecursion').value = 'false';
        return 1;
    });
    assert.deepEqual(result, { scanDepth: 1000, caseSensitive: null, preventRecursion: false });
});
