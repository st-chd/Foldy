import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegexBundleActions } from '../regex-integration.js';
import { normalizeLayout } from '../model.js';

async function exported(selection) {
    const layout = normalizeLayout({
        root: [{ type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }],
        folders: [{ id: 'f1', name: '대사', items: ['r1'] }, { id: 'f2', name: '보조/표시', items: ['r2'] }],
    }, ['r1', 'r2']);
    let result;
    globalThis.toastr = { success() {} };
    const actions = createRegexBundleActions({
        readRegexLayout: () => ({ owner: 'global', layout }), regexTypes: { global: { label: '글로벌', scriptType: 1 } },
        getScriptsByType: () => [{ id: 'r1', scriptName: '첫 항목', script: '내용' }, { id: 'r2', scriptName: '둘째 항목' }],
        requestBundleExportMode: async () => selection, regexExportName: () => 'global',
        downloadJson: async (bundle, filename) => { result = { bundle, filename }; return true; },
    });
    await actions.exportRegexBundle('global');
    return result;
}

test('폴더별 정규식 번들 파일명에 위치와 폴더명을 넣고 선택된 내용만 담는다', async () => {
    const { filename, bundle } = await exported({ mode: 'full', folderIds: ['f1'] });
    assert.equal(filename, 'global.대사.json');
    assert.deepEqual(bundle.scripts.map(x => x.id), ['r1']);
});

test('여러 폴더 구조의 파일명은 모든 폴더명을 포함하고 파일명 금지 문자를 정리한다', async () => {
    const { filename, bundle } = await exported({ mode: 'layout', folderIds: ['f1', 'f2'] });
    assert.equal(filename, 'global.대사+보조_표시-folders.json');
    assert.equal(bundle.scripts, undefined);
    assert.equal(bundle.layout.folders.length, 2);
});

test('전체 정규식 내보내기의 기존 파일명은 유지한다', async () => {
    assert.equal((await exported({ mode: 'full' })).filename, 'global.json');
});
