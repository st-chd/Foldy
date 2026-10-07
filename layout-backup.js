import { bundleEnvelope, bundleFilename, isObjectRecord, validateBundleEnvelope } from './bundle-utils.js';
import { flattenLayout, normalizeLayout } from './model.js';

const TYPES = ['global', 'scoped', 'preset'];

function layoutBuckets(layouts, live, enabled) {
    return [
        ['prompts', layouts.prompts, live.prompts, enabled('prompts')],
        ['lorebooks', layouts.lorebooks, live.lorebooks, enabled('lorebooks')],
        ...TYPES.map(type => [`regex.${type}`, layouts.regex?.[type], live.regexLayouts[type], enabled('regex')]),
    ];
}

function emptyLayouts() {
    return { prompts: {}, lorebooks: {}, regex: { global: {}, scoped: {}, preset: {} } };
}

function bucketFor(layouts, key) {
    return key.startsWith('regex.') ? layouts.regex[key.slice(6)] : layouts[key];
}

function structureOnly(layout) {
    return normalizeLayout(layout, flattenLayout(layout));
}

function ownerAliases(key, owners) {
    const aliases = new Map();
    let loreIndex = 0;
    for (const canonical of owners) {
        let parts;
        try { parts = JSON.parse(canonical); } catch { continue; }
        if (!Array.isArray(parts) || !parts.every(part => typeof part === 'string')) continue;
        const names = [canonical, parts.join(':')];
        if (key === 'lorebooks' && parts[0] === 'name' && parts.length === 2) {
            names.push(parts[1], `index:${loreIndex++}`);
        }
        for (const name of names) {
            if (aliases.has(name) && aliases.get(name) !== canonical) aliases.set(name, null);
            else if (!aliases.has(name)) aliases.set(name, canonical);
        }
    }
    return aliases;
}

export function createLayoutBackup(layouts, live, enabled = () => true) {
    const result = emptyLayouts();
    for (const [key, bucket, owners, active] of layoutBuckets(layouts, live, enabled)) {
        if (!active) continue;
        for (const [owner, layout] of Object.entries(bucket || {})) {
            if (!owners.has(owner) || !layout?.folders?.length) continue;
            Object.defineProperty(bucketFor(result, key), owner, {
                value: structureOnly(layout), enumerable: true, configurable: true, writable: true,
            });
        }
    }
    return { ...bundleEnvelope('layouts'), contents: 'layout', layouts: result };
}

function validateLayout(layout) {
    const string = value => typeof value === 'string';
    return isObjectRecord(layout) && layout.version === 1
        && Array.isArray(layout.root) && Array.isArray(layout.folders)
        && layout.root.every(node => isObjectRecord(node) && ['item', 'folder'].includes(node.type) && string(node.id))
        && layout.folders.every(folder => isObjectRecord(folder) && string(folder.id) && string(folder.name)
            && Array.isArray(folder.items) && folder.items.every(string)
            && ['color', 'borderColor', 'nameColor'].every(key => folder[key] === undefined || string(folder[key])));
}

export function planLayoutImport(bundle, live, enabled = () => true) {
    if (!validateBundleEnvelope(bundle, 'layouts').ok || bundle.contents !== 'layout'
        || !isObjectRecord(bundle.layouts) || !isObjectRecord(bundle.layouts.regex)) {
        throw new Error('올바른 Foldy 일괄 폴더 구조 파일이 아닙니다.');
    }
    const entries = new Map();
    let skipped = 0;
    for (const [key, bucket, owners, active] of layoutBuckets(bundle.layouts, live, enabled)) {
        if (!isObjectRecord(bucket)) throw new Error('일괄 폴더 구조의 목록 형식이 올바르지 않습니다.');
        const aliases = ownerAliases(key, owners);
        for (const [owner, layout] of Object.entries(bucket)) {
            if (!validateLayout(layout)) throw new Error('일괄 폴더 구조에 올바르지 않은 폴더가 있습니다.');
            if (!active || !owners.has(owner)) { skipped++; continue; }
            if (aliases.has(owner) && aliases.get(owner) === null) { skipped++; continue; }
            const canonical = aliases.get(owner) ?? owner;
            const id = `${key}\0${canonical}`;
            const previous = entries.get(id);
            if (previous && owner !== canonical) continue;
            entries.set(id, { key, owner: canonical, layout: structureOnly(layout),
                obsoleteOwners: [...aliases].filter(([alias, target]) => target === canonical && alias !== canonical)
                    .map(([alias]) => alias) });
        }
    }
    const planned = [...entries.values()];
    return { entries: planned, skipped, folders: planned.reduce((count, entry) => count + entry.layout.folders.length, 0) };
}

export function applyLayoutImport(layouts, plan) {
    for (const { key, owner, layout, obsoleteOwners = [] } of plan.entries) {
        const bucket = bucketFor(layouts, key);
        for (const alias of obsoleteOwners) delete bucket[alias];
        Object.defineProperty(bucket, owner, {
            value: layout, enumerable: true, configurable: true, writable: true,
        });
    }
}

export function createLayoutBackupActions({
    settings, liveOwners, featureEnabled, syncOwners, downloadJson, readJsonFile,
    confirmText, saveSettingsDebounced, refreshLayouts,
}) {
    return {
        async exportLayouts() {
            syncOwners();
            const live = liveOwners();
            const bundle = createLayoutBackup(settings().layouts, live, featureEnabled);
            const plan = planLayoutImport(bundle, live, featureEnabled);
            if (!plan.entries.length) { toastr.info('내보낼 활성 폴더 구조가 없습니다.'); return; }
            if (await downloadJson(bundle, bundleFilename('Foldy-folders'))) {
                toastr.success(`${plan.entries.length}개 대상의 폴더 ${plan.folders}개를 내보냈습니다.`);
            }
        },
        async importLayouts() {
            const bundle = await readJsonFile();
            if (!bundle) return;
            syncOwners();
            const preview = planLayoutImport(bundle, liveOwners(), featureEnabled);
            if (!preview.entries.length) { toastr.info('현재 존재하는 대상에 적용할 폴더 구조가 없습니다.'); return; }
            if (!await confirmText('일괄 폴더 구조 불러오기',
                `${preview.entries.length}개 대상의 폴더 구조(폴더 ${preview.folders}개)를 복원할까요?\n`
                + '파일에 포함된 대상의 폴더 배치를 바꿉니다. 본문 내용과 활성화 상태는 유지됩니다.\n'
                + `존재하지 않거나 기능이 꺼진 대상 ${preview.skipped}개는 건너뜁니다.`)) return;
            syncOwners();
            const plan = planLayoutImport(bundle, liveOwners(), featureEnabled);
            applyLayoutImport(settings().layouts, plan);
            saveSettingsDebounced();
            await refreshLayouts(plan);
            toastr.success(`${plan.entries.length}개 대상의 폴더 구조를 불러왔습니다.`);
        },
    };
}
