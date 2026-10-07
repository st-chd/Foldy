import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptIntegration } from '../prompt-integration.js';
import { normalizeLayout } from '../model.js';

function fixture(options = {}) {
    const ids = Array.from({ length: 12 }, (_, i) => `default-${i}`);
    const order = ids.map(identifier => ({ identifier, enabled: true }));
    const state = { layouts: { prompts: {} }, features: { prompts: true } };
    const manager = {
        activeCharacter: { id: 100000 },
        serviceSettings: { prompts: [], prompt_order: [{ character_id: 100000, order }] },
        getPromptOrderForCharacter: () => order,
        saveServiceSettings: async () => { manager.saves++; },
        saves: 0,
        render: () => {},
        makeDraggable: () => {},
        renderPromptManagerListItems: async () => {},
    };
    let owner = 'openai:A';
    const integration = createPromptIntegration({
        settings: () => state,
        saveSettingsDebounced: () => {},
        waitUntilCondition: async () => {},
        promptManager: manager,
        promptPresetManager: () => ({}),
        promptOwnerKey: () => owner,
        featureEnabled: () => false,
        debugLog: () => {},
        ...options,
    });
    return { ids, order, state, manager, integration, select: value => { owner = value; } };
}

test('A의 지연된 저장은 B의 기본 프롬프트 12개 순서와 A 폴더를 바꾸지 않는다', async () => {
    const f = fixture();
    const layout = normalizeLayout({
        root: [{ type: 'folder', id: 'a-folder' }],
        folders: [{ id: 'a-folder', name: 'A 폴더', items: [...f.ids].reverse() }],
    }, f.ids);
    f.state.layouts.prompts['openai:A'] = structuredClone(layout);
    f.select('openai:B');
    const before = structuredClone(f.state);
    await assert.rejects(f.integration.persistPromptLayout('openai:A', layout), /프리셋/);
    assert.deepEqual(f.order.map(x => x.identifier), f.ids);
    assert.deepEqual(f.state, before);
    assert.equal(f.manager.saves, 0);
});

test('프리셋 전환 중에는 폴더 배치 저장과 기본 목록 렌더를 실행하지 않는다', async () => {
    const f = fixture({ promptContextReady: () => false });
    let rendered = 0;
    f.manager.renderPromptManagerListItems = async () => { rendered++; };
    await f.integration.installPromptIntegration();
    await f.manager.renderPromptManagerListItems();
    await assert.rejects(f.integration.persistPromptLayout('openai:A', normalizeLayout(null, f.ids)), /프리셋/);
    assert.equal(rendered, 0);
    assert.equal(f.manager.saves, 0);
});

test('템플릿 대기 중 바뀐 프리셋은 새 소유자의 폴더 저장값을 덮어쓰지 않는다', async () => {
    const f = fixture({ featureEnabled: () => true });
    globalThis.toastr = { error() {} };
    f.manager.listElement = { classList: { add() { throw new Error('DOM 구성 시작'); } } };
    const storedIds = [f.ids[1], f.ids[0], 'b-only', ...f.ids.slice(2)];
    const before = normalizeLayout({ root: [{ type: 'folder', id: 'b' }], folders: [{ id: 'b', name: 'B', items: storedIds }] }, storedIds);
    f.state.layouts.prompts['openai:B'] = structuredClone(before);
    let finish;
    let started;
    let calls = 0;
    const ready = new Promise(resolve => { started = resolve; });
    f.manager.renderPromptManagerListItems = async () => {
        if (++calls !== 1) return;
        started();
        await new Promise(resolve => { finish = resolve; });
    };
    await f.integration.installPromptIntegration();
    const pending = f.manager.renderPromptManagerListItems();
    await ready;
    f.select('openai:B');
    finish();
    await pending;
    assert.deepEqual(f.state.layouts.prompts['openai:B'], before);
});

test('프리셋 활성화는 평면 목록에 맞춰 폴더를 바꾸지 않고 저장된 기본 프롬프트 순서를 복원한다', async () => {
    const f = fixture({ featureEnabled: () => true });
    globalThis.toastr = { error() {} };
    f.manager.listElement = { classList: { add() { throw new Error('DOM 구성 시작'); } } };
    const expected = [f.ids[1], f.ids[0], ...f.ids.slice(2)];
    const before = normalizeLayout({ root: [{ type: 'folder', id: 'a' }], folders: [{ id: 'a', name: 'A', items: expected }] }, expected);
    f.state.layouts.prompts['openai:A'] = structuredClone(before);
    await f.integration.installPromptIntegration();
    await f.manager.renderPromptManagerListItems();
    assert.deepEqual(f.order.map(x => x.identifier), expected);
    assert.deepEqual(f.state.layouts.prompts['openai:A'], before);
});

test('프리셋 전환으로 겹친 목록 렌더는 순차 실행된다', async () => {
    const f = fixture();
    let active = 0;
    let maximum = 0;
    f.manager.renderPromptManagerListItems = async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
    };
    await f.integration.installPromptIntegration();
    await Promise.all([f.manager.renderPromptManagerListItems(), f.manager.renderPromptManagerListItems()]);
    assert.equal(maximum, 1);
});

test('같은 프리셋을 다시 적용해도 저장된 폴더 순서를 복원한다', async () => {
    const f = fixture({ featureEnabled: () => true });
    globalThis.toastr = { error() {} };
    f.manager.listElement = { classList: { add() { throw new Error('DOM 구성 시작'); } } };
    const expected = [...f.ids].reverse();
    f.state.layouts.prompts['openai:A'] = normalizeLayout({ root: [{ type: 'folder', id: 'a' }],
        folders: [{ id: 'a', name: 'A', items: expected }] }, expected);
    await f.integration.installPromptIntegration();
    await f.manager.renderPromptManagerListItems();
    f.order.splice(0, f.order.length, ...f.ids.map(identifier => ({ identifier, enabled: true })));
    f.integration.invalidatePromptLayout();
    await f.manager.renderPromptManagerListItems();
    assert.deepEqual(f.order.map(x => x.identifier), expected);
});
