import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { applyLayoutImport, createLayoutBackup, createLayoutBackupActions, planLayoutImport } from '../layout-backup.js';
import { normalizeLayout, orderItemsByLayout } from '../model.js';
import { saveRegexScriptsWithLatest } from '../regex-integration.js';

const layout = () => ({ ...normalizeLayout({
    root: [{ type: 'folder', id: 'f' }, { type: 'item', id: '2' }],
    folders: [{ id: 'f', name: '폴더', items: ['1'], color: '#112233' }],
}, ['1', '2']), content: '본문은 백업하면 안 됨' });
const live = () => ({
    prompts: new Set(['A', 'B']), lorebooks: new Set(['book']),
    regexLayouts: { global: new Set(['global']), preset: new Set(['preset:A']), scoped: new Set(['character']) },
});
const layouts = () => ({
    prompts: { A: layout(), B: layout(), deleted: layout() }, lorebooks: { book: layout(), deleted: layout() },
    regex: { global: { global: layout() }, preset: { 'preset:A': layout() }, scoped: { character: layout(), deleted: layout() } },
});

test('현재 존재하는 모든 대상만 백업하며 본문과 UI 상태는 포함하지 않는다', () => {
    const source = layouts();
    const before = structuredClone(source);
    const bundle = createLayoutBackup(source, live());
    assert.deepEqual(Object.keys(bundle.layouts.prompts), ['A', 'B']);
    assert.deepEqual(Object.keys(bundle.layouts.lorebooks), ['book']);
    assert.deepEqual(Object.keys(bundle.layouts.regex.scoped), ['character']);
    assert.ok(!JSON.stringify(bundle).includes('본문'));
    assert.deepEqual(source, before);
});

test('꺼진 기능의 폴더 구조를 내보내지 않는다', () => {
    const bundle = createLayoutBackup(layouts(), live(), kind => kind !== 'regex');
    assert.deepEqual(bundle.layouts.regex, { global: {}, preset: {}, scoped: {} });
    assert.equal(planLayoutImport(bundle, live()).entries.length, 3);
});

test('일괄 복원은 존재하는 대상만 갱신하며 나머지 구조는 보존한다', () => {
    const bundle = createLayoutBackup(layouts(), live());
    const targets = layouts();
    targets.prompts.A.folders[0].name = '변경된 폴더';
    const untouched = structuredClone(targets.prompts.deleted);
    const owners = live();
    owners.prompts.delete('B');
    const plan = planLayoutImport(bundle, owners);
    assert.equal(plan.skipped, 1);
    applyLayoutImport(targets, plan);
    assert.equal(targets.prompts.A.folders[0].name, '폴더');
    assert.equal(targets.prompts.A.folders[0].color, '#112233');
    assert.deepEqual(targets.prompts.deleted, untouched);
});

test('구형 로어북 키의 백업은 현재 키로 복원하고 중복 키를 지운다', async () => {
    const source = layouts();
    source.lorebooks = { Book: layout() };
    source.lorebooks.Book.folders[0].name = '백업 폴더';
    const owners = live();
    owners.lorebooks = new Set(['["name","Book"]', 'Book', 'name:Book', 'index:0']);
    let state = { layouts: source };
    let saved;
    globalThis.toastr = { success() {}, info() {} };
    const actions = createLayoutBackupActions({
        settings: () => state, liveOwners: () => owners, featureEnabled: () => true, syncOwners() {},
        downloadJson: async bundle => { saved = bundle; return true; },
        readJsonFile: async () => saved, confirmText: async () => true,
        saveSettingsDebounced() {}, refreshLayouts: async () => {},
    });
    await actions.exportLayouts();
    state = { layouts: layouts() };
    state.layouts.lorebooks = { '["name","Book"]': layout(), Book: layout(), 'name:Book': layout() };
    state.layouts.lorebooks['["name","Book"]'].folders[0].name = '현재 폴더';
    await actions.importLayouts();
    assert.equal(state.layouts.lorebooks['["name","Book"]'].folders[0].name, '백업 폴더');
    assert.deepEqual(Object.keys(state.layouts.lorebooks), ['["name","Book"]']);
});

test('한 대상의 현재 키와 구형 키가 백업에 함께 있으면 현재 키를 우선한다', () => {
    const owners = live();
    owners.lorebooks = new Set(['["name","Book"]', 'Book', 'name:Book']);
    const source = layouts();
    source.lorebooks = { '["name","Book"]': layout(), Book: layout() };
    source.lorebooks.Book.folders[0].name = '구형';
    source.lorebooks['["name","Book"]'].folders[0].name = '현재';
    const plan = planLayoutImport(createLayoutBackup(source, owners), owners);
    const loreEntries = plan.entries.filter(entry => entry.key === 'lorebooks');
    assert.equal(loreEntries.length, 1);
    assert.equal(loreEntries[0].layout.folders[0].name, '현재');
});

test('잘못된 구조와 미래 버전은 일부라도 복원하기 전에 거절한다', () => {
    const bundle = createLayoutBackup(layouts(), live());
    bundle.layouts.regex.scoped.character.folders[0].items = 'wrong';
    assert.throws(() => planLayoutImport(bundle, live()), /올바르지/);
    const future = createLayoutBackup(layouts(), live());
    future.version = 999;
    assert.throws(() => planLayoutImport(future, live()), /올바른/);
});

test('본문 데이터를 끼워 넣은 파일에서도 허용된 구조 필드만 복원한다', () => {
    const bundle = createLayoutBackup(layouts(), live());
    bundle.layouts.prompts.A.folders[0].content = 'malicious';
    bundle.layouts.prompts.A.prompts = [{ content: 'malicious' }];
    const plan = planLayoutImport(bundle, live());
    assert.ok(!JSON.stringify(plan).includes('malicious'));
});

test('확인 창을 열어 둔 사이 삭제된 대상은 복원하지 않는다', async () => {
    const state = { layouts: layouts() };
    const owners = live();
    const bundle = createLayoutBackup(state.layouts, owners);
    state.layouts.prompts.A.folders[0].name = '현재 폴더';
    const beforeB = structuredClone(state.layouts.prompts.B);
    let refreshed;
    globalThis.toastr = { success() {}, info() {} };
    const actions = createLayoutBackupActions({
        settings: () => state, liveOwners: () => owners, featureEnabled: () => true, syncOwners() {},
        readJsonFile: async () => bundle, saveSettingsDebounced() {},
        confirmText: async () => { owners.prompts.delete('B'); return true; },
        refreshLayouts: async plan => { refreshed = plan; },
    });
    await actions.importLayouts();
    assert.equal(state.layouts.prompts.A.folders[0].name, '폴더');
    assert.deepEqual(state.layouts.prompts.B, beforeB);
    assert.equal(refreshed.skipped, 1);
});

function regexRestoreFixture(legacy = false) {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
    const ownerKey = (prefix, ...parts) => legacy ? [prefix, ...parts].join(':') : JSON.stringify([prefix, ...parts]);
    const scripts = () => [{ id: '1', scriptName: '첫째', findRegex: 'a', replaceString: 'b', disabled: false },
        { id: '2', scriptName: '둘째', findRegex: 'b', replaceString: 'c', disabled: true },
        { id: 'new', scriptName: '추가됨', findRegex: 'c', replaceString: 'd', disabled: false }];
    const characters = ['A.png', 'B:character.png'].map(avatar => ({ avatar, data: { extensions: { regex_scripts: scripts() } } }));
    const presetData = { openai: { A: scripts(), 'B:preset': scripts() }, novel: { 'B:novel': scripts() } };
    const selectedNames = { openai: 'A', novel: 'B:novel' };
    let globalScripts = scripts();
    let activeCharacter = 0;
    const writes = [];
    let refreshes = 0;
    let chatReloads = 0;
    const managers = Object.fromEntries(Object.keys(presetData).map(api => [api, {
        getAllPresets: () => Object.keys(presetData[api]), getSelectedPresetName: () => selectedNames[api],
        readPresetExtensionField: ({ name }) => presetData[api][name],
        writePresetExtensionField: async ({ name, path, value }) => {
            assert.equal(path, 'regex_scripts');
            presetData[api][name] = value;
            writes.push(`${api}:${name}`);
        },
    }]));
    const live = { prompts: new Set(), lorebooks: new Set(), regexLayouts: {
        global: new Set(['global']), scoped: new Set(characters.map(character => ownerKey('scoped', character.avatar))),
        preset: new Set(Object.entries(presetData).flatMap(([api, data]) => Object.keys(data).map(name => ownerKey('preset', api, name)))),
    } };
    const state = { layouts: { prompts: {}, lorebooks: {}, regex: { global: {}, scoped: {}, preset: {} } } };
    const reversed = normalizeLayout({ root: [{ type: 'folder', id: 'f' }],
        folders: [{ id: 'f', name: '복원', items: ['2', '1', 'deleted'] }] }, ['1', '2', 'deleted']);
    const bundle = { ...createLayoutBackup(state.layouts, live), layouts: structuredClone(state.layouts) };
    bundle.layouts.regex.global.global = reversed;
    bundle.layouts.regex.scoped[ownerKey('scoped', characters[1].avatar)] = reversed;
    bundle.layouts.regex.preset[ownerKey('preset', 'openai', 'B:preset')] = reversed;
    bundle.layouts.regex.preset[ownerKey('preset', 'novel', 'B:novel')] = reversed;
    const context = {
        createLayoutBackupActions, settings: () => state, foldyDataCleanup: { liveFoldyOwners: () => live },
        featureEnabled: () => true, syncLorebookRenameMigration() {}, downloadJson() {},
        readJsonFile: async () => bundle, confirmText: async () => true, saveSettingsDebounced() {},
        invalidatePromptLayout() {}, renderPrompts() {}, queueLoreRender() {}, enhanceRegexLists: () => { refreshes++; },
        REGEX_TYPES: { global: { scriptType: 'global' }, scoped: { scriptType: 'scoped' }, preset: { scriptType: 'preset' } },
        regexOwnerKey: type => type === 'global' ? 'global' : type === 'scoped'
            ? ownerKey(type, characters[activeCharacter].avatar) : ownerKey(type, 'openai', selectedNames.openai),
        extensionRemoving: false, saveRegexScriptsWithLatest, normalizeLayout, orderItemsByLayout, characters,
        foldyOwnerKey: (prefix, ...parts) => JSON.stringify([prefix, ...parts]),
        legacyFoldyOwnerKey: (prefix, ...parts) => [prefix, ...parts].join(':'),
        getScriptsByType: type => type === 'global' ? globalScripts : type === 'scoped'
            ? characters[activeCharacter].data.extensions.regex_scripts : presetData.openai[selectedNames.openai],
        saveScriptsByType: async (value, type) => {
            if (type === 'global') { globalScripts = value; writes.push('global'); }
            else if (type === 'scoped') characters[activeCharacter].data.extensions.regex_scripts = value;
            else presetData.openai[selectedNames.openai] = value;
        },
        writeExtensionField: async (id, path, value) => {
            assert.equal(path, 'regex_scripts');
            characters[id].data.extensions.regex_scripts = value;
            writes.push(characters[id].avatar);
        },
        document: { querySelectorAll: () => [{ dataset: { presetManagerFor: 'openai,novel' } }] },
        getCurrentPresetAPI: () => 'openai', getPresetManager: api => managers[api],
        promptContextReady: () => true, waitUntilCondition: async condition => { assert.equal(condition(), true); },
        getCurrentChatId: () => 'chat', reloadCurrentChat: async () => { chatReloads++; },
    };
    const actions = runInNewContext(`
        ${section('function regexItemIds(', 'const {\n    exportRegexBundle,')}
        ${section('const layoutBackupActions =', 'function loreLayoutFromDom(')}
        layoutBackupActions;
    `, context);
    return { actions, bundle, characters, presetData, writes, global: () => globalScripts,
        refreshes: () => refreshes, chatReloads: () => chatReloads,
        activateB: () => { activeCharacter = 1; selectedNames.openai = 'B:preset'; }, context };
}

test('현재 채팅의 정규식 순서가 그대로면 일괄 복원에서 채팅을 다시 렌더링하지 않는다', async () => {
    globalThis.toastr = { success() {}, info() {} };
    const f = regexRestoreFixture();
    delete f.bundle.layouts.regex.global.global;
    await f.actions.importLayouts();
    assert.equal(f.chatReloads(), 0);
});

test('현재 캐릭터와 프리셋의 정규식 순서가 바뀌면 채팅을 한 번만 갱신한다', async () => {
    globalThis.toastr = { success() {}, info() {} };
    const f = regexRestoreFixture();
    delete f.bundle.layouts.regex.global.global;
    f.activateB();
    await f.actions.importLayouts();
    assert.equal(f.chatReloads(), 1);
});

for (const legacy of [false, true]) {
    test(`일괄 복원은 비활성 캐릭터와 다른 API 프리셋의 실행 순서도 복원한다 (${legacy ? '기존 키' : '현재 키'})`, async () => {
        globalThis.toastr = { success() {}, info() {} };
        const f = regexRestoreFixture(legacy);
        const untouchedCharacter = structuredClone(f.characters[0]);
        const untouchedPreset = structuredClone(f.presetData.openai.A);
        const beforeCharacter = [...f.characters[1].data.extensions.regex_scripts];
        const beforePreset = [...f.presetData.openai['B:preset']];
        await f.actions.importLayouts();
        for (const scripts of [f.global(), f.characters[1].data.extensions.regex_scripts,
            f.presetData.openai['B:preset'], f.presetData.novel['B:novel']]) {
            assert.deepEqual(Array.from(scripts, script => script.id), ['2', '1', 'new']);
        }
        assert.deepEqual(f.characters[0], untouchedCharacter);
        assert.deepEqual(f.presetData.openai.A, untouchedPreset);
        assert.equal(f.characters[1].data.extensions.regex_scripts[0], beforeCharacter[1]);
        assert.equal(f.presetData.openai['B:preset'][0], beforePreset[1]);
        assert.equal(f.presetData.openai['B:preset'][0].disabled, true);
        assert.equal(f.presetData.openai['B:preset'][0].replaceString, 'c');
        assert.deepEqual(f.writes, ['global', 'B:character.png', 'openai:B:preset', 'novel:B:novel']);
        f.activateB();
        assert.deepEqual(Array.from(f.context.getScriptsByType('scoped'), script => script.id), ['2', '1', 'new']);
        assert.deepEqual(Array.from(f.context.getScriptsByType('preset'), script => script.id), ['2', '1', 'new']);
        assert.equal(f.refreshes(), 1);
        assert.equal(f.chatReloads(), 1);
    });
}
