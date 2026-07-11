import { appendSelectionRow, createSelectionToolbar } from './folder-ui.js';

import { removeFolder } from './model.js';

function createUnusedDataPreview(items) {
    const preview = document.createElement('div');
    preview.className = 'foldy-clear-unused-preview';
    const title = document.createElement('div');
    title.className = 'foldy-clear-unused-title';
    title.textContent = `미사용 폴더 데이터: ${items.length}개`;
    preview.append(title);

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'foldy-empty-hint';
        empty.textContent = '삭제할 미사용 폴더 데이터가 없습니다.';
        preview.append(empty);
        return preview;
    }

    const list = document.createElement('ul');
    items.slice(0, 30).forEach(item => {
        const row = document.createElement('li');
        row.textContent = `${item.title}: ${item.value}`;
        list.append(row);
    });
    if (items.length > 30) {
        const more = document.createElement('li');
        more.textContent = `외 ${items.length - 30}개`;
        list.append(more);
    }
    preview.append(list);
    return preview;
}

function createActiveFolderSelection(items, { showCategoryPrefix = false } = {}) {
    const group = document.createElement('div');
    group.className = 'foldy-clear-active foldy-create-items';
    const list = document.createElement('div');
    list.className = 'foldy-create-items-list';
    const selection = createSelectionToolbar(list, `활성 폴더: ${items.length}개`);

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'foldy-empty-hint';
        empty.textContent = '삭제할 활성 폴더가 없습니다.';
        list.append(empty);
    } else {
        items.forEach((item, index) => {
            const label = document.createElement('label');
            label.className = 'checkbox flex-container';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = String(index);
            const text = document.createElement('span');
            text.textContent = showCategoryPrefix ? `${item.title}: ${item.label}` : item.label;
            text.title = text.textContent;
            appendSelectionRow(label, checkbox, text);
            list.append(label);
        });
    }

    selection.sync();
    group.append(selection.toolbar, list);
    return group;
}

export function createClearDataDialog({
    Popup,
    POPUP_RESULT,
    POPUP_TYPE,
    syncLorebookRenameMigration,
    findUnusedFoldyData,
    unusedFoldyDataItems,
    activeFoldyFolderItems,
    deleteActiveFoldyFolders,
    deleteUnusedFoldyData,
    clearAllFoldyData,
    saveSettingsDebounced,
}) {
    return async function requestClearFoldyData(scope, label) {
        syncLorebookRenameMigration({ rerender: false });
        const report = findUnusedFoldyData();
        const unusedItems = unusedFoldyDataItems(report, scope);
        const unusedCount = unusedItems.length;
        const activeItems = activeFoldyFolderItems(scope);

        const form = document.createElement('div');
        form.className = 'foldy-clear-form';
        const hint = document.createElement('div');
        hint.className = 'foldy-export-hint';
        hint.textContent = `${label} 폴더 데이터만 삭제합니다. 원본 프롬프트, 로어북, 정규식 내용은 유지됩니다.`;

        const options = document.createElement('div');
        options.className = 'foldy-clear-options';
        const activeOption = document.createElement('label');
        activeOption.className = 'checkbox flex-container';
        const activeRadio = document.createElement('input');
        activeRadio.type = 'radio';
        activeRadio.name = 'foldy-clear-mode';
        activeRadio.value = 'active';
        activeRadio.checked = activeItems.length > 0;
        activeRadio.disabled = activeItems.length === 0;
        const activeText = document.createElement('span');
        activeText.textContent = `활성 폴더 삭제 (${activeItems.length}개)`;
        activeOption.append(activeRadio, activeText);

        const unusedOption = document.createElement('label');
        unusedOption.className = 'checkbox flex-container';
        const unusedRadio = document.createElement('input');
        unusedRadio.type = 'radio';
        unusedRadio.name = 'foldy-clear-mode';
        unusedRadio.value = 'unused';
        unusedRadio.checked = activeItems.length === 0 && unusedCount > 0;
        unusedRadio.disabled = unusedCount === 0;
        const unusedText = document.createElement('span');
        unusedText.textContent = `미사용 폴더 데이터 삭제 (${unusedCount}개)`;
        unusedOption.append(unusedRadio, unusedText);

        const allOption = document.createElement('label');
        allOption.className = 'checkbox flex-container';
        const allRadio = document.createElement('input');
        allRadio.type = 'radio';
        allRadio.name = 'foldy-clear-mode';
        allRadio.value = 'all';
        const allText = document.createElement('span');
        allText.textContent = '모든 폴더 데이터 삭제';
        allOption.append(allRadio, allText);
        options.append(activeOption, unusedOption, allOption);

        const details = document.createElement('div');
        details.className = 'foldy-clear-details';
        const renderDetails = () => {
            details.innerHTML = '';
            if (activeRadio.checked) {
                details.append(createActiveFolderSelection(activeItems, { showCategoryPrefix: scope === 'all' }));
            } else if (unusedRadio.checked) {
                details.append(createUnusedDataPreview(unusedItems));
            } else if (allRadio.checked) {
                const message = document.createElement('div');
                message.className = 'foldy-clear-unused-preview';
                const title = document.createElement('div');
                title.className = 'foldy-clear-unused-title';
                title.textContent = '모든 폴더 데이터 삭제';
                const text = document.createElement('div');
                text.textContent = `저장된 ${label} 폴더 구조와 접힘 상태가 모두 삭제됩니다.`;
                message.append(title, text);
                details.append(message);
            }
        };
        options.addEventListener('input', renderDetails);
        renderDetails();

        form.append(hint, options, details);
        const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
            okButton: '삭제',
            cancelButton: '취소',
            onClosing: value => {
                if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                if (!activeRadio.checked && !unusedRadio.checked && !allRadio.checked) {
                    toastr.warning('삭제할 항목을 선택해 주세요.');
                    return false;
                }
                if (activeRadio.checked && !details.querySelector('input[type="checkbox"]:checked')) {
                    toastr.warning('삭제할 폴더를 선택해 주세요.');
                    return false;
                }
                return true;
            },
        }).show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;

        if (activeRadio.checked) {
            const selected = [...details.querySelectorAll('input[type="checkbox"]:checked')]
                .map(input => activeItems[Number(input.value)])
                .filter(Boolean);
            deleteActiveFoldyFolders(selected);
            toastr.success(`활성 폴더 ${selected.length}개를 삭제했습니다.`);
        } else if (unusedRadio.checked) {
            deleteUnusedFoldyData(report, scope);
            toastr.success(`미사용 폴더 데이터 ${unusedCount}개를 삭제했습니다.`);
        } else {
            clearAllFoldyData(scope);
            toastr.success(`${label} 폴더 데이터를 삭제했습니다.`);
        }
        saveSettingsDebounced();
    };
}
export function createFoldyDataCleanup({
    settings,
    getPresetManager,
    currentLorebookNames,
    lorebookOwnerForName,
    promptOwnerKeyForName,
    regexOwnerKey,
    regexOwnerKeyForScopedAvatar,
    regexOwnerKeyForPresetName,
    regexTypes,
    getCharacters,
    getWorldNames,
    queryPresetManagerSelects = () => globalThis.document?.querySelectorAll?.('select[data-preset-manager-for]') || [],
}) {
    function presetOwnersForApi(apiId) {
        const manager = getPresetManager(apiId);
        return (manager?.getAllPresets?.() || []).map(name => `${apiId}:${name}`);
    }

    function promptOwnersForApi(apiId) {
        return presetOwnersForApi(apiId).flatMap(owner => {
            const name = owner.slice(`${apiId}:`.length);
            return [owner, promptOwnerKeyForName(name)];
        });
    }

    function liveFoldyOwners() {
        const state = settings();
        const promptOwners = new Set(promptOwnersForApi('openai'));
        const loreOwners = new Set(currentLorebookNames().flatMap((name, index) => [lorebookOwnerForName(name), name, `index:${index}`]));
        const regexLayoutOwners = {
            global: new Set(['global']),
            scoped: new Set([
                'scoped:none',
                regexOwnerKeyForScopedAvatar('none'),
                ...(getCharacters() || [])
                    .map(character => character?.avatar)
                    .filter(Boolean)
                    .flatMap(avatar => [`scoped:${avatar}`, regexOwnerKeyForScopedAvatar(avatar)]),
            ]),
            preset: new Set(),
        };
        const unknownRegexOwners = new Set();

        const presetManagerSelects = queryPresetManagerSelects();
        if (!presetManagerSelects.length) {
            unknownRegexOwners.add('preset');
            Object.keys(state.layouts.regex?.preset || {}).forEach(owner => regexLayoutOwners.preset.add(owner));
        }
        presetManagerSelects.forEach(select => {
            const apiIds = String(select.dataset.presetManagerFor || '').split(',').map(value => value.trim()).filter(Boolean);
            for (const apiId of apiIds) {
                for (const owner of presetOwnersForApi(apiId)) {
                    regexLayoutOwners.preset.add(`preset:${owner}`);
                    const name = owner.slice(`${apiId}:`.length);
                    regexLayoutOwners.preset.add(regexOwnerKeyForPresetName(apiId, name));
                }
            }
        });
        regexLayoutOwners.preset.add(regexOwnerKey('preset'));

        const regexCollapsedOwners = new Set();
        for (const owners of Object.values(regexLayoutOwners)) {
            for (const owner of owners) regexCollapsedOwners.add(owner);
        }

        return {
            prompts: promptOwners,
            lorebooks: loreOwners,
            regexLayouts: regexLayoutOwners,
            unknownRegexOwners,
            collapsed: {
                prompt: promptOwners,
                lore: loreOwners,
                regex: regexCollapsedOwners,
            },
        };
    }

    function isPlaceholderLoreOwner(owner) {
        const value = String(owner || '').trim();
        // Fragile ST coupling: this matches the visible World Info placeholder
        // label. If ST changes its i18n text, cleanup may report that
        // placeholder as unused data instead of crashing.
        return /^name:\s*-+\s*.*\uC120\uD0DD.*-+\s*$/.test(value)
            || /^name:\s*-+\s*.*select.*-+\s*$/i.test(value);
    }

    function findUnusedFoldyData() {
        const state = settings();
        const live = liveFoldyOwners();
        return {
            layouts: {
                prompts: Object.keys(state.layouts.prompts || {}).filter(owner => hasStoredFolders(state.layouts.prompts[owner]) && !live.prompts.has(owner)),
                lorebooks: Object.keys(state.layouts.lorebooks || {}).filter(owner => hasStoredFolders(state.layouts.lorebooks[owner]) && !live.lorebooks.has(owner) && !isPlaceholderLoreOwner(owner)),
                regex: Object.fromEntries(Object.keys(regexTypes).map(typeKey => [
                    typeKey,
                    live.unknownRegexOwners.has(typeKey)
                        ? []
                        : Object.keys(state.layouts.regex?.[typeKey] || {}).filter(owner => hasStoredFolders(state.layouts.regex?.[typeKey]?.[owner]) && !live.regexLayouts[typeKey].has(owner)),
                ])),
            },
            collapsed: {
                prompt: Object.keys(state.collapsed.prompt || {}).filter(owner => hasCollapsedFolders(state.collapsed.prompt[owner]) && !live.collapsed.prompt.has(owner)),
                lore: Object.keys(state.collapsed.lore || {}).filter(owner => hasCollapsedFolders(state.collapsed.lore[owner]) && !live.collapsed.lore.has(owner) && !isPlaceholderLoreOwner(owner)),
                regex: Object.keys(state.collapsed.regex || {}).filter(owner => hasCollapsedFolders(state.collapsed.regex[owner]) && !live.collapsed.regex.has(owner)),
            },
        };
    }

    function deleteUnusedFoldyData(report, scope = 'all') {
        const state = settings();
        if (scope === 'all' || scope === 'prompts') {
            report.layouts.prompts.forEach(owner => delete state.layouts.prompts[owner]);
            report.collapsed.prompt.forEach(owner => delete state.collapsed.prompt[owner]);
        }
        if (scope === 'all' || scope === 'lorebooks') {
            report.layouts.lorebooks.forEach(owner => delete state.layouts.lorebooks[owner]);
            report.collapsed.lore.forEach(owner => delete state.collapsed.lore[owner]);
        }
        if (scope === 'all' || scope === 'regex') {
            for (const typeKey of Object.keys(regexTypes)) {
                report.layouts.regex[typeKey].forEach(owner => delete state.layouts.regex?.[typeKey]?.[owner]);
            }
            report.collapsed.regex.forEach(owner => delete state.collapsed.regex[owner]);
        }
    }

    function ownerDisplayName(owner) {
        const value = String(owner || '');
        try {
            const parts = JSON.parse(value);
            if (Array.isArray(parts)) {
                if (parts[0] === 'name') return parts[1] || value;
                if (parts[0] === 'scoped') return parts[1] || 'None selected';
                if (parts[0] === 'preset') return parts[2] || parts[1] || value;
                return parts.at(-1) || value;
            }
        } catch {
            // Older saved owners use colon-separated keys below.
        }
        if (value.startsWith('name:')) return value.slice(5);
        if (/^index:\d+$/.test(value)) return getWorldNames()?.[Number(value.slice(6))] || value;
        if (value.startsWith('scoped:')) return value.slice(7) || 'None selected';
        if (value.startsWith('preset:')) {
            const parts = value.split(':');
            return parts.slice(2).join(':') || value;
        }
        if (value.startsWith('openai:')) return value.slice(7);
        return value;
    }

    function isRegexOwnerForType(typeKey, owner) {
        const value = String(owner || '');
        try {
            const parts = JSON.parse(value);
            if (Array.isArray(parts)) return parts[0] === typeKey;
        } catch {
            // Older saved owners use colon-separated keys below.
        }
        if (typeKey === 'global') return value === 'global';
        if (typeKey === 'scoped') return value.startsWith('scoped:');
        if (typeKey === 'preset') return value.startsWith('preset:');
        return false;
    }

    function hasStoredFolders(layout) {
        return Array.isArray(layout?.folders) && layout.folders.length > 0;
    }

    function hasCollapsedFolders(value) {
        return Array.isArray(value) && value.length > 0;
    }

    function activeFoldyFolderItems(scope = 'all') {
        const state = settings();
        const live = liveFoldyOwners();
        const items = [];
        const addItem = item => {
            if (!items.some(value => value.kind === item.kind && value.owner === item.owner && value.typeKey === item.typeKey && value.folderId === item.folderId)) {
                items.push(item);
            }
        };

        if (scope === 'all' || scope === 'prompts') {
            for (const owner of Object.keys(state.layouts.prompts || {})) {
                if (!live.prompts.has(owner) || !hasStoredFolders(state.layouts.prompts[owner])) continue;
                addItem({ kind: 'prompts', title: '프롬프트', owner, label: ownerDisplayName(owner) });
            }
        }

        if (scope === 'all' || scope === 'lorebooks') {
            const lorebookGroups = new Map();
            for (const owner of Object.keys(state.layouts.lorebooks || {})) {
                if (!live.lorebooks.has(owner) || !hasStoredFolders(state.layouts.lorebooks[owner])) continue;
                const label = ownerDisplayName(owner);
                if (!lorebookGroups.has(label)) lorebookGroups.set(label, []);
                lorebookGroups.get(label).push(owner);
            }
            lorebookGroups.forEach((owners, label) => {
                addItem({ kind: 'lorebooks', title: '로어북', owner: owners.join('\n'), owners, label });
            });
        }

        if (scope === 'all' || scope === 'regex') {
            for (const typeKey of Object.keys(regexTypes)) {
                for (const owner of Object.keys(state.layouts.regex?.[typeKey] || {})) {
                    const layout = state.layouts.regex[typeKey][owner];
                    if (!live.regexLayouts[typeKey].has(owner) || !hasStoredFolders(layout)) continue;
                    for (const folder of layout.folders) {
                        addItem({
                            kind: 'regex',
                            typeKey,
                            owner,
                            folderId: folder.id,
                            title: '정규식',
                            label: `${regexTypes[typeKey].label}: ${folder.name}`,
                        });
                    }
                }
            }
        }

        return items;
    }

    function deleteActiveFoldyFolders(items) {
        const state = settings();
        for (const item of items) {
            if (item.kind === 'prompts') {
                delete state.layouts.prompts[item.owner];
                delete state.collapsed.prompt[item.owner];
            } else if (item.kind === 'lorebooks') {
                for (const owner of item.owners || [item.owner]) {
                    delete state.layouts.lorebooks[owner];
                    delete state.collapsed.lore[owner];
                }
            } else if (item.kind === 'regex') {
                const layout = state.layouts.regex?.[item.typeKey]?.[item.owner];
                if (!layout || !item.folderId) continue;
                const nextLayout = removeFolder(layout, item.folderId);
                const layoutWithoutFolder = nextLayout === layout
                    ? { ...layout, folders: layout.folders.filter(folder => folder.id !== item.folderId) }
                    : nextLayout;
                if (layoutWithoutFolder.folders.length) {
                    state.layouts.regex[item.typeKey][item.owner] = layoutWithoutFolder;
                    const collapsed = (state.collapsed.regex[item.owner] || []).filter(id => id !== item.folderId);
                    if (collapsed.length) state.collapsed.regex[item.owner] = collapsed;
                    else delete state.collapsed.regex[item.owner];
                } else {
                    delete state.layouts.regex[item.typeKey][item.owner];
                    delete state.collapsed.regex[item.owner];
                }
            }
        }
    }

    function unusedFoldyDataItems(report, scope = 'all') {
        const items = [];
        const addOwners = (title, values) => values.forEach(value => items.push({ title, value }));
        const mergeOwners = (title, ...groups) => {
            const owners = [...new Set(groups.flat().map(value => String(value)).filter(Boolean))];
            owners.forEach(value => items.push({ title, value }));
        };
        if (scope === 'all' || scope === 'prompts') {
            mergeOwners('프롬프트', report.layouts.prompts, report.collapsed.prompt);
        }
        if (scope === 'all' || scope === 'lorebooks') {
            mergeOwners('로어북', report.layouts.lorebooks, report.collapsed.lore);
        }
        if (scope === 'all' || scope === 'regex') {
            for (const typeKey of Object.keys(regexTypes)) {
                const collapsedOwners = report.collapsed.regex
                    .filter(owner => isRegexOwnerForType(typeKey, owner));
                mergeOwners(
                    `정규식 ${regexTypes[typeKey].label}`,
                    report.layouts.regex[typeKey].filter(owner => isRegexOwnerForType(typeKey, owner)),
                    collapsedOwners,
                );
            }
            addOwners('정규식 접힘 상태', report.collapsed.regex.filter(owner => !Object.keys(regexTypes).some(typeKey => isRegexOwnerForType(typeKey, owner))));
        }
        return items;
    }

    function clearAllFoldyData(scope = 'all') {
        const state = settings();
        if (scope === 'all' || scope === 'prompts') {
            state.layouts.prompts = {};
            state.collapsed.prompt = {};
        }
        if (scope === 'all' || scope === 'lorebooks') {
            state.layouts.lorebooks = {};
            state.collapsed.lore = {};
        }
        if (scope === 'all' || scope === 'regex') {
            state.layouts.regex = { global: {}, scoped: {}, preset: {} };
            state.collapsed.regex = {};
        }
    }

    return {
        findUnusedFoldyData,
        unusedFoldyDataItems,
        activeFoldyFolderItems,
        deleteActiveFoldyFolders,
        deleteUnusedFoldyData,
        clearAllFoldyData,
    };
}
