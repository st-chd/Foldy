import assert from 'node:assert/strict';
import test from 'node:test';
import { createLorebookIntegration } from '../lorebook-integration.js';

function fixture() {
    const element = () => ({
        innerHTML: '', value: '', style: { removeProperty() {} },
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector: () => ({}), querySelectorAll: () => [], addEventListener() {}, remove() {},
    });
    const sort = element();
    sort.value = 'foldy-order';
    const list = element();
    list.innerHTML = '현재 로어북 폴더';
    const elements = new Map([
        ['world_info_sort_order', sort], ['world_popup_entries_list', list], ['world_popup_new', element()],
        ...['create', 'export', 'import', 'collapse_all', 'expand_all', 'root_bulk_move'].map(name => [`foldy_lore_${name}`, element()]),
    ]);
    globalThis.document = { getElementById: id => elements.get(id), querySelector: () => null };
    const data = new WeakMap();
    globalThis.$ = target => ({
        length: 0,
        val: () => target === '#world_info_sort_order' ? sort.value : '',
        off() { return this; }, on() { return this; },
        data(key, value) {
            const store = data.get(target) || {};
            if (value !== undefined) { store[key] = value; data.set(target, store); }
            return store[key];
        },
        removeData() {}, sortable: () => null,
    });
    let observer;
    globalThis.MutationObserver = class {
        constructor(callback) { this.callback = callback; observer = this; }
        observe() { this.connected = true; }
        disconnect() { this.connected = false; }
    };
    globalThis.toastr = { error() {} };
    let owner = 'A';
    let releaseLoad;
    let loadStarted;
    const loading = new Promise(resolve => { loadStarted = resolve; });
    let releaseHeader;
    let headerStarted;
    const header = new Promise(resolve => { headerStarted = resolve; });
    const state = { layouts: { lorebooks: { A: { version: 1, root: [], folders: [] } } } };
    let persisted = 0;
    const integration = createLorebookIntegration({
        loreSortValue: 'foldy-order', featureEnabled: () => true, settings: () => state,
        currentLorebookOwner: () => ({ name: owner, owner }), selectedLorebookName: () => owner,
        waitUntilCondition: async () => {}, storedLoreSortValue: () => '0', debugLog() {},
        ownerCollapsed: () => new Set(), accountStorage: { getItem: () => null },
        persistLoreLayout: async () => { persisted++; },
        loadWorldInfo: async () => { loadStarted(); return new Promise(resolve => { releaseLoad = resolve; }); },
        renderTemplateAsync: async () => { headerStarted(); return new Promise(resolve => { releaseHeader = resolve; }); },
    });
    return { integration, list, loading, header, observer: () => observer, persisted: () => persisted,
        switchOwner: () => { owner = 'B'; }, finishLoad: () => releaseLoad({ entries: {} }), finishHeader: () => releaseHeader('headers') };
}

test('A 로어북 읽기를 기다리는 동안 B를 선택하면 A 폴더를 저장하거나 화면에 덮어쓰지 않는다', async () => {
    const f = fixture();
    await f.integration.installLorebookIntegration();
    const pending = f.integration.renderLorebookFolders();
    await f.loading;
    f.switchOwner();
    f.finishLoad();
    void f.header.then(() => f.finishHeader());
    await pending;
    assert.equal(f.persisted(), 0);
    assert.equal(f.list.innerHTML, '현재 로어북 폴더');
});

test('폴더 템플릿 대기 중 기본 편집기의 갱신을 계속 감지하고 기존 화면을 보존한다', async () => {
    const f = fixture();
    await f.integration.installLorebookIntegration();
    const pending = f.integration.renderLorebookFolders();
    await f.loading;
    f.finishLoad();
    await f.header;
    const connected = f.observer().connected;
    const previousHtml = f.list.innerHTML;
    f.switchOwner();
    f.finishHeader();
    await pending;
    assert.equal(connected, true);
    assert.equal(previousHtml, '현재 로어북 폴더');
    assert.equal(f.list.innerHTML, '현재 로어북 폴더');
});
