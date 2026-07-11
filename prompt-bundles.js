import {
    backupFilename,
    bundleEnvelope,
    bundleFilename,
    cloneJson,
    createFolderRenameTracker,
    importedLayoutSummary,
    nameKey,
    uniqueNameMap,
    uniqueNameIndex,
} from './bundle-utils.js';
import {
    flattenLayout,
    generateUUID,
    layoutFromTree,
    mergeImportedLayout,
    normalizeLayout,
    remapImportedLayout,
} from './model.js';
import { setupFolderSortables } from './folder-sortables.js';

export function promptBundlePresetName(bundle) {
    if (bundle?.presetName) return String(bundle.presetName);
    const owner = String(bundle?.owner || '');
    const index = owner.indexOf(':');
    return index >= 0 ? owner.slice(index + 1) : owner;
}

export function promptPresetSettingsWithManagerState(baseSettings, manager) {
    return {
        ...cloneJson(baseSettings || {}),
        prompts: cloneJson(manager.serviceSettings.prompts || []),
        prompt_order: cloneJson(manager.serviceSettings.prompt_order || []),
    };
}

export function promptOrderIds(manager) {
    return manager.getPromptOrderForCharacter(manager.activeCharacter).map(entry => String(entry.identifier));
}

export function ensurePromptOrder(manager) {
    if (!manager.activeCharacter) return [];
    manager.serviceSettings.prompt_order ??= [];
    const list = manager.serviceSettings.prompt_order.find(value => String(value.character_id) === String(manager.activeCharacter.id));
    if (list) return list.order;
    let order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    if (!order.length) {
        manager.addPromptOrderForCharacter(manager.activeCharacter, []);
        order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    }
    return order;
}

export function promptLayoutRefs(manager, ids) {
    const promptById = new Map((manager.serviceSettings.prompts || [])
        .filter(prompt => prompt?.identifier)
        .map(prompt => [String(prompt.identifier), prompt]));
    return ids.map(id => ({
        id,
        name: promptById.get(id)?.name || '',
    }));
}

export function promptLayoutOnlyBundle(bundle) {
    return bundle?.contents === 'layout'
        || (Array.isArray(bundle?.promptRefs) && !Array.isArray(bundle?.prompts) && !Array.isArray(bundle?.promptOrder));
}

export function importedPromptOrderIds(bundle, idMap) {
    const orderedSourceIds = Array.isArray(bundle?.promptOrder) && bundle.promptOrder.length
        ? bundle.promptOrder.map(entry => entry?.identifier)
        : flattenLayout(bundle?.layout || { root: [], folders: [] });
    return [...new Set(orderedSourceIds
        .map(id => idMap.get(String(id)))
        .filter(Boolean))];
}

export function promptDomNodesFromList(list, { preserveFolderIds = new Set() } = {}) {
    const nodes = [];
    for (const element of list.children) {
        if (element.classList.contains('foldy-folder')) {
            const id = element.dataset.foldyId;
            const itemIds = preserveFolderIds.has(id)
                ? []
                : [...(element.querySelector('.foldy-folder-items')?.children || [])]
                    .map(item => item.dataset.pmIdentifier)
                    .filter(Boolean);
            nodes.push({ type: 'folder', id, itemIds });
        } else if (element.dataset.pmIdentifier) {
            nodes.push({ type: 'item', id: element.dataset.pmIdentifier });
        }
    }
    return nodes;
}

export function createPromptSortables({
    getSortableDelay,
    promptOwnerKey,
    getCurrentPromptLayout,
    setCurrentPromptLayout,
    persistPromptLayout,
    shouldRejectDomLayout,
    debugLog,
}) {
    function promptLayoutFromDom(manager, list, sourceLayout, { preserveFolderIds = new Set(), normalizeOptions = {} } = {}) {
        const nodes = promptDomNodesFromList(list, { preserveFolderIds });
        return layoutFromTree(nodes, sourceLayout, promptOrderIds(manager), {
            preserveFolderIds,
            normalizeOptions,
            onMissingSourceFolders: ids => debugLog('프롬프트 DOM에 저장된 폴더가 없습니다.', ids, 'warn'),
        });
    }

    function setupPromptSortables(manager) {
        const list = manager.listElement;
        if (!list?.classList.contains('foldy-prompt-root')) return;
        const owner = promptOwnerKey();
        let sourceLayout = getCurrentPromptLayout();

        let saving = false;
        const saveFromDom = async ({ preserveFolderIds = new Set() } = {}) => {
            if (saving) return;
            saving = true;
            try {
                if (promptOwnerKey() !== owner || getCurrentPromptLayout() !== sourceLayout) {
                    manager.render(false);
                    return;
                }
                const next = promptLayoutFromDom(manager, list, sourceLayout, { preserveFolderIds });
                if (shouldRejectDomLayout(sourceLayout, next, '프롬프트')) {
                    manager.render(false);
                    return;
                }
                await persistPromptLayout(owner, next, manager);
                setCurrentPromptLayout(next);
                sourceLayout = next;
            } catch (error) {
                debugLog('프롬프트 폴더 순서 저장 실패', error);
                toastr.error('프롬프트 폴더 순서를 저장하지 못했습니다.');
                manager.render(false);
            } finally {
                saving = false;
            }
        };

        setupFolderSortables({
            list,
            nestedItemsSelector: '.foldy-prompt-items',
            rootSortableItems: '> .completion_prompt_manager_prompt_draggable, > .foldy-folder',
            nestedSortableItems: '> .completion_prompt_manager_prompt_draggable',
            connectWith: '#completion_prompt_manager_list, .foldy-prompt-items',
            folderHitSelector: '.foldy-prompt-folder',
            folderItemsSelector: '.foldy-prompt-items',
            isItemElement: item => item?.classList?.contains('completion_prompt_manager_prompt_draggable') ?? false,
            itemIdFromElement: item => item?.dataset?.pmIdentifier,
            getSortableDelay,
            setSorting: () => {},
            rerender: () => manager.render(false),
            saveFromDom,
            saveOptionsFromItem: item => ({
                preserveFolderIds: item?.classList?.contains('foldy-folder')
                    ? new Set([item.dataset.foldyId].filter(Boolean))
                    : new Set(),
            }),
            debugLog,
            domainLabel: '프롬프트',
            appendPlaceholderToFolder: true,
            positionPlaceholderInFolder: true,
        });
    }

    return {
        setupPromptSortables,
        promptLayoutFromDom,
    };
}

export function createPromptBundleActions({
    settings,
    saveSettingsDebounced,
    waitUntilCondition,
    promptOwnerKey,
    promptOwnerKeyForName,
    promptExportName,
    promptPresetManager,
    currentPromptPresetSettings,
    readPromptLayout,
    persistPromptLayout,
    getCurrentPromptLayout,
    setCurrentPromptLayout,
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertPromptBundleShape,
    confirmText,
}) {
    function backupExistingPromptPreset(presetName, manager) {
        const owner = promptOwnerKeyForName(presetName);
        const presetSettings = currentPromptPresetSettings(presetName);
        const prompts = Array.isArray(presetSettings?.prompts) ? presetSettings.prompts : [];
        const ids = prompts.map(prompt => String(prompt?.identifier || '')).filter(Boolean);
        const layout = normalizeLayout(settings().layouts.prompts[owner], ids, { preserveUnrootedFolders: false });
        downloadJson({
            ...bundleEnvelope('prompts'),
            owner: presetName,
            presetName,
            backup: true,
            createdAt: new Date().toISOString(),
            layout: cloneJson(layout),
            presetSettings: cloneJson(presetSettings),
            prompts: cloneJson(prompts),
            promptOrder: cloneJson(presetSettings?.prompt_order || []),
        }, backupFilename(`${presetName}-prompts`));
    }

    async function requestPromptExportMode() {
        return requestBundleExportMode(
            '프롬프트 번들 내보내기',
            '프롬프트 내용과 폴더 구조',
            '폴더 구조만',
            '폴더 구조만 내보내면 불러올 때 현재 프롬프트 내용은 유지하고 폴더 배치만 적용합니다.',
            'foldy_prompt_export_mode',
        );
    }

    async function importPromptLayoutBundle(bundle, manager) {
        if (!bundle?.layout) {
            toastr.error('프롬프트 구조 번들에 폴더 구조가 없습니다.');
            return;
        }
        const currentPreset = promptExportName();
        const sourcePreset = promptBundlePresetName(bundle) || 'unknown preset';
        const currentPrompts = manager.serviceSettings.prompts || [];
        const currentIds = promptOrderIds(manager);
        const currentById = new Map(currentPrompts
            .filter(prompt => prompt?.identifier)
            .map(prompt => [String(prompt.identifier), prompt]));
        const currentNameIndex = uniqueNameIndex(currentPrompts
            .filter(prompt => prompt?.identifier), prompt => prompt?.name);
        const currentByName = currentNameIndex.unique;
        const refsById = new Map((bundle.promptRefs || [])
            .filter(ref => ref?.id)
            .map(ref => [String(ref.id), ref]));
        const idMap = new Map();
        const usedTargetIds = new Set();
        let ambiguousNameCount = 0;
        for (const sourceId of flattenLayout(bundle.layout)) {
            const ref = refsById.get(String(sourceId));
            const direct = currentById.get(String(sourceId));
            const refNameKey = nameKey(ref?.name);
            if (!direct && refNameKey && currentNameIndex.ambiguous.has(refNameKey)) ambiguousNameCount++;
            const byName = refNameKey ? currentByName.get(refNameKey) : null;
            const target = direct || byName;
            const targetId = target?.identifier != null ? String(target.identifier) : '';
            if (targetId && !usedTargetIds.has(targetId)) {
                idMap.set(String(sourceId), targetId);
                usedTargetIds.add(targetId);
            }
        }
        const sourceItemCount = new Set(flattenLayout(bundle.layout)).size;
        const matchedTargetCount = new Set(idMap.values()).size;
        const confirmed = await confirmText(
            '프롬프트 폴더 구조 불러오기',
            `"${sourcePreset}"의 폴더 구조를 현재 프리셋 "${currentPreset}"에 적용할까요? 프롬프트 내용은 바뀌지 않습니다.\n\n${importedLayoutSummary({
                currentLabel: '현재 프롬프트',
                currentOnlyLabel: '현재 프리셋에만 있는 프롬프트',
                currentCount: currentIds.length,
                sourceCount: sourceItemCount,
                matchedSourceCount: idMap.size,
                matchedTargetCount,
                ambiguousCount: ambiguousNameCount,
            })}`,
        );
        if (!confirmed) return;

        const currentLayout = normalizeLayout(null, currentIds);
        const importedLayout = remapImportedLayout(bundle.layout, idMap);
        const renameTracker = createFolderRenameTracker();
        const layout = mergeImportedLayout(currentLayout, importedLayout, currentIds, renameTracker.options);
        const owner = promptOwnerKey();
        settings().layouts.prompts[owner] = layout;
        setCurrentPromptLayout(layout);
        saveSettingsDebounced();
        await persistPromptLayout(owner, layout, manager);
        manager.render(false);
        renameTracker.notify();
        toastr.success('프롬프트 폴더 구조를 불러왔습니다.');
    }

    async function exportPromptBundle(manager) {
        const owner = promptOwnerKey();
        const currentPromptLayout = getCurrentPromptLayout();
        const layout = currentPromptLayout
            ? normalizeLayout(currentPromptLayout, promptOrderIds(manager), { preserveUnrootedFolders: false })
            : readPromptLayout(manager, { preserveUnrootedFolders: false }).layout;
        settings().layouts.prompts[owner] = layout;
        setCurrentPromptLayout(layout);
        saveSettingsDebounced();
        const presetManager = promptPresetManager();
        const presetName = promptExportName();
        const ids = new Set(flattenLayout(layout));
        const mode = await requestPromptExportMode();
        if (!mode) return;

        if (mode === 'layout') {
            downloadJson({
                ...bundleEnvelope('prompts'),
                contents: 'layout',
                owner,
                presetName,
                layout: cloneJson(layout),
                promptRefs: promptLayoutRefs(manager, [...ids]),
            }, bundleFilename(`${presetName}-folders`));
            toastr.success('프롬프트 폴더 구조를 내보냈습니다.');
            return;
        }

        const prompts = (manager.serviceSettings.prompts || [])
            .filter(prompt => prompt?.identifier)
            .map(cloneJson);
        const promptOrder = manager.getPromptOrderForCharacter(manager.activeCharacter)
            .filter(entry => ids.has(String(entry.identifier)))
            .map(cloneJson);

        downloadJson({
            ...bundleEnvelope('prompts'),
            owner,
            presetName,
            presetSettings: promptPresetSettingsWithManagerState(currentPromptPresetSettings(presetName), manager),
            layout: cloneJson(layout),
            prompts,
            promptOrder,
        }, bundleFilename(presetName));
        toastr.success('프롬프트 번들을 내보냈습니다.');
    }

    async function importPromptBundle(manager) {
        const rawBundle = await readJsonFile();
        const bundle = rawBundle ? assertBundle(rawBundle, 'prompts') : null;
        if (!bundle) return;
        if (promptLayoutOnlyBundle(bundle)) {
            await importPromptLayoutBundle(bundle, manager);
            return;
        }
        if (!assertPromptBundleShape(bundle)) return;
        const presetManager = promptPresetManager();
        const presetName = promptBundlePresetName(bundle);
        if (!presetName) {
            toastr.error('프롬프트 번들에 프리셋 이름이 없습니다.');
            return;
        }
        const exists = presetManager?.getAllPresets?.().includes(presetName);
        const existingPromptCount = exists ? (currentPromptPresetSettings(presetName)?.prompts || []).length : 0;
        const importedPromptCount = bundle.prompts.filter(prompt => prompt?.identifier).length;
        const sourceLayoutIds = new Set(flattenLayout(bundle.layout));
        const importedPromptIds = new Set(bundle.prompts
            .filter(prompt => prompt?.identifier)
            .map(prompt => String(prompt.identifier)));
        const matchedLayoutCount = [...sourceLayoutIds].filter(id => importedPromptIds.has(String(id))).length;
        const layoutSummary = importedLayoutSummary({
            currentLabel: '가져올 프롬프트',
            currentOnlyLabel: '폴더 구조에 없는 가져올 프롬프트',
            currentCount: importedPromptCount,
            sourceCount: sourceLayoutIds.size,
            matchedSourceCount: matchedLayoutCount,
            matchedTargetCount: matchedLayoutCount,
        });
        const confirmed = await confirmText('프롬프트 번들 불러오기', exists
            ? `기존 프롬프트 프리셋 "${presetName}"을 이 번들로 바꿀까요?\n\n기존 프롬프트: ${existingPromptCount}개\n가져올 프롬프트: ${importedPromptCount}개\n\n덮어쓰기 전에 백업 파일을 내려받습니다.\n\n${layoutSummary}\n\n계속할까요?`
            : `이 번들로 새 프롬프트 프리셋 "${presetName}"을 만들까요?\n\n가져올 프롬프트: ${importedPromptCount}개\n\n${layoutSummary}`);
        if (!confirmed) return;
        if (exists) backupExistingPromptPreset(presetName, manager);

        const presetSettings = cloneJson(bundle.presetSettings || currentPromptPresetSettings(presetName));
        await presetManager.savePreset(presetName, presetSettings);
        const presetValue = presetManager.findPreset(presetName);
        if (presetValue !== undefined) presetManager.selectPreset(presetValue);
        await waitUntilCondition(() => presetManager.getSelectedPresetName() === presetName, 5000, 100);

        const importedPrompts = bundle.prompts.filter(prompt => prompt?.identifier);
        const currentPrompts = exists ? (manager.serviceSettings.prompts || []) : [];
        const promptsById = new Map(currentPrompts
            .filter(prompt => prompt?.identifier)
            .map(prompt => [String(prompt.identifier), prompt]));
        const promptsByName = uniqueNameMap(currentPrompts, prompt => prompt?.name);
        const usedIds = new Set(promptsById.keys());
        const idMap = new Map();
        importedPrompts.forEach(prompt => {
            const imported = cloneJson(prompt);
            const existing = promptsByName.get(nameKey(imported.name));
            const sourceId = String(imported.identifier);
            if (existing) {
                imported.identifier = existing.identifier;
            } else if (!imported.identifier || usedIds.has(String(imported.identifier))) {
                imported.identifier = generateUUID();
            }
            const targetId = String(imported.identifier);
            idMap.set(sourceId, targetId);
            usedIds.add(targetId);
            promptsById.set(targetId, imported);
        });
        manager.setPrompts([...promptsById.values()]);

        const owner = promptOwnerKeyForName(presetName);
        const currentIds = exists ? promptOrderIds(manager) : [];
        // Imports may reuse existing prompts, but the Foldy layout itself comes from the bundle.
        const currentLayout = normalizeLayout(null, currentIds);
        const importedLayout = remapImportedLayout(bundle.layout, idMap);
        const importedConnectedIds = importedPromptOrderIds(bundle, idMap);
        const allIds = [...new Set([...currentIds, ...importedConnectedIds])];
        const renameTracker = createFolderRenameTracker();
        const layout = mergeImportedLayout(currentLayout, importedLayout, allIds, renameTracker.options);
        const orderById = new Map(bundle.promptOrder.map(entry => {
            const targetId = idMap.get(String(entry.identifier));
            return targetId ? [targetId, { ...cloneJson(entry), identifier: targetId }] : null;
        }).filter(Boolean));
        const order = ensurePromptOrder(manager);
        const existingOrderById = new Map(exists ? order.map(entry => [String(entry.identifier), entry]) : []);
        order.splice(0, order.length, ...flattenLayout(layout).map(id => orderById.get(id) ?? existingOrderById.get(id) ?? { identifier: id, enabled: true }));

        settings().layouts.prompts[owner] = layout;
        setCurrentPromptLayout(layout);
        saveSettingsDebounced();
        await presetManager.savePreset(presetName, promptPresetSettingsWithManagerState(presetSettings, manager));
        manager.render(false);
        renameTracker.notify();
        toastr.success('프롬프트 번들을 불러왔습니다.');
    }

    return {
        exportPromptBundle,
        importPromptBundle,
    };
}
