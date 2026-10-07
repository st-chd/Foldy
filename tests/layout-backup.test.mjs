import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLayoutImport, createLayoutBackup, createLayoutBackupActions, planLayoutImport } from '../layout-backup.js';
import { normalizeLayout } from '../model.js';

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
