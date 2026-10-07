import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createPromptIntegration } from '../prompt-integration.js';
import { normalizeLayout } from '../model.js';

function runtimeFixture() {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
    const listeners = new Map();
    const eventTypes = Object.fromEntries(['OAI_PRESET_CHANGED_BEFORE', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED',
        'PRESET_RENAMED', 'WORLDINFO_SETTINGS_UPDATED', 'CHAT_CHANGED'].map(value => [value, value]));
    const events = {
        on(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); },
        makeFirst(event, fn) { listeners.set(event, [fn, ...(listeners.get(event) || []).filter(value => value !== fn)]); },
        removeListener(event, fn) { listeners.set(event, (listeners.get(event) || []).filter(value => value !== fn)); },
        async emit(event, data) { for (const listener of [...(listeners.get(event) || [])]) await listener(data); },
    };
    const settings = { preset_settings_openai: 'initial', prompts: [], prompt_order: [] };
    let selected = 'initial';
    let invalidations = 0;
    let reapplications = 0;
    let recovery;
    const presets = new Map();
    const manager = {
        getSelectedPreset: () => selected,
        selectPreset: name => {
            reapplications++;
            recovery = (async () => {
                const request = structuredClone(presets.get(name));
                await events.emit(eventTypes.OAI_PRESET_CHANGED_BEFORE, { preset: request, presetName: name });
                Object.assign(settings, request);
                await events.emit(eventTypes.OAI_PRESET_CHANGED_AFTER);
                await events.emit(eventTypes.PRESET_CHANGED, { apiId: 'openai', name });
            })();
            return recovery;
        },
    };
    const runtime = runInNewContext(`
        let extensionRemoving = false;
        let runtimeEventsRegistered = false;
        ${section('let promptPresetChanges =', 'const loreWriteQueues =')}
        appliedPromptPresetName = 'initial';
        ${section('function registerFoldyRuntimeEvents(', 'function createToolbarFactory(')}
        ${section('function promptContextReady()', 'function currentPromptPresetSettings(')}
        ({ register: registerFoldyRuntimeEvents, ready: promptContextReady, unregister: unregisterFoldyRuntimeEvents });
    `, {
        oai_settings: settings, settingsToUpdate: { temperature: ['', 'temp_openai', false, false] },
        promptExportName: () => selected, promptPresetManager: () => manager,
        invalidatePromptLayout: () => { invalidations++; }, debugLog() {},
        migratePresetRenameSettings: () => false, foldyOwnerKey() {}, legacyFoldyOwnerKey() {},
    });
    const register = () => runtime.register({
        eventSource: events, eventTypes, settings: () => ({}), revalidateSettings() {}, saveSettingsDebounced() {},
        renderPrompts() {}, renderRegex() {}, syncLorebookRenameMigration() {},
    });
    const begin = async (name, id, suppliedPreset) => {
        selected = name;
        settings.preset_settings_openai = name;
        const preset = suppliedPreset ?? { prompts: [{ identifier: id }],
            prompt_order: [{ character_id: 100000, order: [{ identifier: id, enabled: true }] }] };
        presets.set(name, structuredClone(preset));
        await events.emit(eventTypes.OAI_PRESET_CHANGED_BEFORE, { preset, presetName: name });
        return preset;
    };
    const complete = async preset => {
        for (const key of ['prompts', 'prompt_order', 'temp_openai']) {
            const sourceKey = key === 'temp_openai' ? 'temperature' : key;
            if (preset[sourceKey] !== undefined) settings[key] = preset[sourceKey];
        }
        await events.emit(eventTypes.OAI_PRESET_CHANGED_AFTER);
    };
    return { register, begin, complete, ready: runtime.ready, events, eventTypes, settings,
        recover: async () => { await events.emit(eventTypes.PRESET_CHANGED); await recovery; },
        unregister: runtime.unregister, select: name => { selected = name; },
        reapplications: () => reapplications, invalidations: () => invalidations };
}

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

test('프리셋 전환 중에는 폴더 배치 저장과 폴더 목록 렌더를 실행하지 않는다', async () => {
    const f = fixture({ promptContextReady: () => false, featureEnabled: () => true });
    let rendered = 0;
    f.manager.renderPromptManagerListItems = async () => { rendered++; };
    await f.integration.installPromptIntegration();
    await f.manager.renderPromptManagerListItems();
    await assert.rejects(f.integration.persistPromptLayout('openai:A', normalizeLayout(null, f.ids)), /프리셋/);
    assert.equal(rendered, 0);
    assert.equal(f.manager.saves, 0);
});

test('프롬프트 폴더를 끄면 전환 준비 상태와 무관하게 기본 목록을 렌더한다', async () => {
    const f = fixture({ promptContextReady: () => false });
    let rendered = 0;
    f.manager.renderPromptManagerListItems = async () => { rendered++; };
    await f.integration.installPromptIntegration();
    await f.manager.renderPromptManagerListItems();
    assert.equal(rendered, 1);
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

test('B가 먼저 적용되고 A가 나중에 완료되면 B 폴더 읽기와 저장을 차단하고 B를 재적용한다', async () => {
    const runtime = runtimeFixture();
    runtime.register();
    const a = await runtime.begin('A', 'a-only');
    const b = await runtime.begin('B', 'b-only');
    await runtime.complete(b);
    assert.equal(runtime.ready(), false);
    await runtime.complete(a);
    assert.equal(runtime.ready(), false);
    const f = fixture({ promptContextReady: runtime.ready });
    f.select('openai:B');
    const layout = normalizeLayout({ root: [{ type: 'folder', id: 'b' }],
        folders: [{ id: 'b', name: 'B', items: ['b-only', ...f.ids] }] }, ['b-only', ...f.ids]);
    f.state.layouts.prompts['openai:B'] = structuredClone(layout);
    assert.throws(() => f.integration.readPromptLayout(), /프리셋/);
    await assert.rejects(f.integration.persistPromptLayout('openai:B', layout), /프리셋/);
    assert.deepEqual(f.state.layouts.prompts['openai:B'], layout);
    assert.equal(f.manager.saves, 0);
    await runtime.recover();
    assert.equal(runtime.reapplications(), 1);
    assert.equal(runtime.ready(), true);
    assert.equal(runtime.settings.prompts[0].identifier, 'b-only');
});

test('같은 이름의 이전 요청도 최신 요청의 세대와 다르면 다시 적용한다', async () => {
    const runtime = runtimeFixture();
    runtime.register();
    const first = await runtime.begin('A', 'first');
    const latest = await runtime.begin('A', 'latest');
    await runtime.complete(latest);
    await runtime.complete(first);
    assert.equal(runtime.ready(), false);
    await runtime.recover();
    assert.equal(runtime.ready(), true);
    assert.equal(runtime.settings.prompts[0].identifier, 'latest');
});

test('기존 비동기 BEFORE 핸들러가 지연되어도 요청 순서와 전환 중 상태를 추적한다', async () => {
    const runtime = runtimeFixture();
    let release;
    let entered;
    const blocked = new Promise(resolve => { entered = resolve; });
    runtime.events.on(runtime.eventTypes.OAI_PRESET_CHANGED_BEFORE, async ({ presetName }) => {
        if (presetName !== 'A') return;
        entered();
        await new Promise(resolve => { release = resolve; });
    });
    runtime.register();
    const pendingA = runtime.begin('A', 'a-only');
    await blocked;
    const b = await runtime.begin('B', 'b-only');
    await runtime.complete(b);
    assert.equal(runtime.ready(), false);
    release();
    const a = await pendingA;
    await runtime.complete(a);
    assert.equal(runtime.ready(), false);
    await runtime.recover();
    assert.equal(runtime.ready(), true);
});

test('정상 전환은 재적용하지 않고 리스너를 중복 등록하지 않으며 이름 변경도 유지한다', async () => {
    const runtime = runtimeFixture();
    runtime.register();
    runtime.register();
    await runtime.complete(await runtime.begin('A', 'a-only'));
    assert.equal(runtime.ready(), true);
    assert.equal(runtime.invalidations(), 1);
    await runtime.recover();
    assert.equal(runtime.reapplications(), 0);
    runtime.select('renamed');
    await runtime.events.emit(runtime.eventTypes.PRESET_RENAMED, { apiId: 'openai', oldName: 'A', newName: 'renamed' });
    assert.equal(runtime.ready(), true);
    runtime.unregister();
    await runtime.begin('B', 'b-only');
    assert.equal(runtime.invalidations(), 1);
});

test('요청과 연결되지 않은 적용 데이터는 완료 횟수가 0이어도 정상으로 판정하지 않는다', async () => {
    const runtime = runtimeFixture();
    runtime.register();
    const a = await runtime.begin('A', 'a-only');
    await runtime.complete(structuredClone(a));
    assert.equal(runtime.ready(), false);
});

test('프롬프트 배열을 하나 또는 모두 생략한 프리셋도 적용된 요청으로 판정한다', async () => {
    const runtime = runtimeFixture();
    runtime.register();
    await runtime.complete(await runtime.begin('A', 'unused', { prompts: [{ identifier: 'a' }] }));
    assert.equal(runtime.ready(), true);
    await runtime.complete(await runtime.begin('B', 'unused', { prompt_order: [{ character_id: 100000, order: [] }] }));
    assert.equal(runtime.ready(), true);
    await runtime.complete(await runtime.begin('C', 'unused', { temperature: 0.7 }));
    assert.equal(runtime.ready(), true);
    await runtime.recover();
    assert.equal(runtime.reapplications(), 0);
});

test('배열이 없는 요청 둘이 겹치면 소유자를 추측하지 않고 최신 프리셋을 재적용한다', async () => {
    const runtime = runtimeFixture();
    runtime.register();
    const a = await runtime.begin('A', 'unused', { temperature: 0.7 });
    const b = await runtime.begin('B', 'unused', { temperature: 0.7 });
    await runtime.complete(b);
    assert.equal(runtime.ready(), false);
    await runtime.complete(a);
    assert.equal(runtime.ready(), false);
    await runtime.recover();
    assert.equal(runtime.ready(), true);
    assert.equal(runtime.reapplications(), 1);
});
