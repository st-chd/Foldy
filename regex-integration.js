import {
    closeOpenFolderMenus,
    enabledState,
    updateFolderCount,
} from './folder-ui.js';
import { setupFolderSortables } from './folder-sortables.js';
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
    createRenderGate,
    flattenLayout,
    generateUUID,
    layoutWithAddedFolder,
    layoutWithItemsMovedToFolder,
    layoutWithUpdatedFolder,
    layoutFromTree,
    mergeImportedLayout,
    normalizeLayout,
    orderItemsByLayout,
    removeFolder,
    remapImportedLayout,
} from './model.js';
export function regexLayoutFromDom(list, sourceLayout, allIds, options = {}) {
    const visibleIds = new Set([...list.querySelectorAll('.regex-script-label')]
        .map(element => element.id)
        .filter(Boolean));
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const nodes = [];
    for (const element of list.children) {
        if (element.classList.contains('foldy-folder')) {
            const id = element.dataset.foldyId;
            const source = folderSource.get(id);
            if (!source) continue;
            const visibleItems = [...(element.querySelector('.foldy-folder-items')?.children || [])]
                .map(item => item.id)
                .filter(Boolean);
            const hiddenItems = source.items.filter(itemId => !visibleIds.has(itemId));
            nodes.push({ type: 'folder', id, itemIds: [...hiddenItems, ...visibleItems] });
        } else if (element.classList.contains('regex-script-label') && element.id) {
            nodes.push({ type: 'item', id: element.id });
        }
    }
    return layoutFromTree(nodes, sourceLayout, allIds, options);
}

export function createRegexIntegration({
    regexTypes,
    scriptTypes,
    featureEnabled,
    disableFeatureForCompatibility,
    ownerCollapsed,
    collapseNewFolder,
    readRegexLayout,
    persistRegexLayout,
    regexOwnerKey,
    regexItemIds,
    getScriptsByType,
    saveScriptsByType,
    getCurrentChatId,
    reloadCurrentChat,
    saveSettingsDebounced,
    createFolderElement,
    requestFolderSettings,
    confirmFolderDelete,
    requestNewRegexFolder,
    requestFlexibleBulkMove,
    attachMoveToFolderButton,
    createRootBulkMoveButton,
    createCollapseButtons,
    createBundleButtons,
    exportRegexBundle,
    importRegexBundle,
    ensureToolbar,
    shouldRejectDomLayout,
    getSortableDelay,
    setupFolderSortablesImpl = setupFolderSortables,
    regexLayoutFromDomImpl = regexLayoutFromDom,
    allowScopedScripts,
    allowPresetScripts,
    getScopedCharacter,
    getCurrentPresetAPI,
    getCurrentPresetName,
    debugLog,
    waitUntilCondition,
}) {
    let regexObserver = null;
    const regexRenderGate = createRenderGate();
    let sortingRegex = false;
    const currentRegexLayouts = { global: null, scoped: null, preset: null };

    async function setRegexFolderEnabled(typeKey, layout, folderId, enabled) {
        const folder = layout.folders.find(value => value.id === folderId);
        if (!folder) return;
        const type = regexTypes[typeKey].scriptType;
        const scripts = getScriptsByType(type);
        const ids = new Set(folder.items);
        scripts.forEach(script => {
            if (ids.has(String(script.id))) script.disabled = !enabled;
        });
        await saveScriptsByType(scripts, type);
        saveSettingsDebounced();
        if (getCurrentChatId()) await reloadCurrentChat();
        enhanceRegexLists();
    }

    function restoreRegexToggleHandlers(item) {
        const typeKey = Object.keys(regexTypes).find(key => document.querySelector(regexTypes[key].selector) === item.closest(regexTypes[key].selector));
        const scriptId = item.id;
        if (!typeKey || !scriptId) return;
        const type = regexTypes[typeKey].scriptType;
        const checkbox = item.querySelector('.disable_regex');
        const toggleOn = item.querySelector('.regex-toggle-on');
        const toggleOff = item.querySelector('.regex-toggle-off');
        if (!checkbox || !toggleOn || !toggleOff) return;

        $(checkbox).off('input.foldyRestore').on('input.foldyRestore', async function () {
            const scripts = getScriptsByType(type);
            const script = scripts.find(value => String(value.id) === scriptId);
            if (!script) return;
            script.disabled = !!this.checked;
            await saveScriptsByType(scripts, type);
            if (type === scriptTypes.SCOPED) allowScopedScripts(getScopedCharacter());
            if (type === scriptTypes.PRESET) allowPresetScripts(getCurrentPresetAPI(), getCurrentPresetName());
            saveSettingsDebounced();
            if (getCurrentChatId()) await reloadCurrentChat();
            enhanceRegexLists();
        });
        $(toggleOn).off('click.foldyRestore').on('click.foldyRestore', () => {
            checkbox.checked = false;
            $(checkbox).trigger('input');
        });
        $(toggleOff).off('click.foldyRestore').on('click.foldyRestore', () => {
            checkbox.checked = true;
            $(checkbox).trigger('input');
        });
    }

    function unwrapRegexFolders(list) {
        const $list = $(list);
        if ($list.data('foldySortable') && $list.sortable('instance')) $list.sortable('destroy');
        $list.removeData('foldySortable');
        closeOpenFolderMenus(list);
        list.querySelectorAll('.foldy-regex-items').forEach(element => {
            const $element = $(element);
            if ($element.sortable('instance')) $element.sortable('destroy');
        });
        const seen = new Set();
        const items = [];
        list.querySelectorAll('.regex-script-label').forEach(item => {
            const id = item.id || '';
            if (id && seen.has(id)) return;
            if (id) seen.add(id);
            item.querySelectorAll('.foldy-move-to-folder').forEach(button => button.remove());
            restoreRegexToggleHandlers(item);
            items.push(item);
        });
        list.replaceChildren(...items);
        list.classList.remove('foldy-regex-root', 'foldy-dropping-into-folder');
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
        list.closest('.inline-drawer-content, .regex_settings, #regex_container')?.querySelector('.foldy-toolbar')?.remove();
    }

    function setupRegexSortable(typeKey, owner, layout) {
        const list = document.querySelector(regexTypes[typeKey].selector);
        if (!list) return;
        const folderItemsSelector = `.foldy-regex-items[data-foldy-regex-type="${typeKey}"]`;

        let saving = false;
        const saveFromDom = async () => {
            if (saving) return;
            saving = true;
            try {
                list.querySelectorAll('.foldy-folder').forEach(updateFolderCount);
                const next = regexLayoutFromDomImpl(list, layout, regexItemIds(typeKey), {
                    onMissingSourceFolders: ids => debugLog('정규식 DOM에 저장된 폴더가 없습니다.', ids),
                });
                if (shouldRejectDomLayout(layout, next, 'Regex')) {
                    enhanceRegexLists();
                    return;
                }
                Object.assign(layout, next);
                await persistRegexLayout(typeKey, owner, layout);
                if (getCurrentChatId()) await reloadCurrentChat();
                enhanceRegexLists();
            } catch (error) {
                debugLog('정규식 폴더 표시 실패', error);
                toastr.error('정규식 폴더를 표시하지 못했습니다.');
            } finally {
                saving = false;
            }
        };

        setupFolderSortablesImpl({
            list,
            nestedItemsSelector: '.foldy-regex-items',
            rootSortableItems: '> .regex-script-label, > .foldy-folder',
            nestedSortableItems: '> .regex-script-label',
            connectWith: `${regexTypes[typeKey].selector}, ${folderItemsSelector}`,
            folderHitSelector: '.foldy-regex-folder',
            folderItemsSelector: '.foldy-regex-items',
            isItemElement: item => item?.classList?.contains('regex-script-label') ?? false,
            itemIdFromElement: item => item?.id,
            getSortableDelay,
            setSorting: value => { sortingRegex = value; },
            rerender: () => enhanceRegexLists(),
            saveFromDom,
            debugLog,
            domainLabel: '정규식',
            appendPlaceholderToFolder: true,
            dataKey: 'foldySortable',
        });
    }

    function enhanceRegexList(typeKey) {
        const list = document.querySelector(regexTypes[typeKey].selector);
        if (!list) return;
        if (!featureEnabled('regex')) {
            unwrapRegexFolders(list);
            return;
        }
        const $list = $(list);
        if ($list.sortable('instance')) $list.sortable('destroy');
        list.querySelectorAll('.foldy-regex-items').forEach(element => {
            const $element = $(element);
            if ($element.sortable('instance')) $element.sortable('destroy');
        });
        closeOpenFolderMenus(list);
        const { owner, layout } = readRegexLayout(typeKey);
        currentRegexLayouts[typeKey] = layout;
        const itemMap = new Map([...list.querySelectorAll('.regex-script-label')].map(element => [element.id, element]));
        itemMap.forEach(element => element.remove());
        const scriptsById = new Map(getScriptsByType(regexTypes[typeKey].scriptType).map(script => [String(script.id), script]));
        itemMap.forEach((element, id) => {
            const script = scriptsById.get(id);
            const toggle = element.querySelector('.disable_regex');
            if (script && toggle) toggle.checked = !!script.disabled;
        });
        const collapsed = ownerCollapsed('regex', `${typeKey}:${owner}`);
        const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));
        list.classList.add('foldy-regex-root');

        const rerender = () => enhanceRegexLists();
        const regexContextChanged = () => regexOwnerKey(typeKey) !== owner || currentRegexLayouts[typeKey] !== layout;
        const rerenderIfRegexContextChanged = () => {
            if (!regexContextChanged()) return false;
            rerender();
            return true;
        };
        const onEdit = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder) return;
            const values = await requestFolderSettings(layout, folder);
            if (!values) return;
            if (rerenderIfRegexContextChanged()) return;
            const { applyStyleToAll, ...folderValues } = values;
            const result = layoutWithUpdatedFolder(layout, folder.id, folderValues, { applyStyleToAll });
            currentRegexLayouts[typeKey] = result.layout;
            await persistRegexLayout(typeKey, owner, result.layout, false);
            rerender();
        };
        const onDelete = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder || !await confirmFolderDelete(folder.name, '정규식 스크립트')) return;
            if (rerenderIfRegexContextChanged()) return;
            const nextLayout = removeFolder(layout, id);
            await persistRegexLayout(typeKey, owner, nextLayout);
            rerender();
        };

        list.innerHTML = '';
        for (const node of layout.root) {
            if (node.type === 'item') {
                const item = itemMap.get(node.id);
                if (item) {
                    attachMoveToFolderButton(item, {
                        kind: 'regex',
                        layout,
                        itemId: node.id,
                        onMove: async movedLayout => {
                            if (rerenderIfRegexContextChanged()) return;
                            await persistRegexLayout(typeKey, owner, movedLayout);
                            rerender();
                        },
                    });
                    list.append(item);
                }
                continue;
            }
            const folder = folderMap.get(node.id);
            if (!folder) continue;
            const state = enabledState(folder.items.map(id => !scriptsById.get(id)?.disabled));
            const folderElement = createFolderElement(folder, {
                kind: 'regex',
                owner: `${typeKey}:${owner}`,
                collapsed,
                onEdit,
                onDelete,
                state,
                onStateToggle: async (id, currentState) => {
                    if (rerenderIfRegexContextChanged()) return;
                    await setRegexFolderEnabled(typeKey, layout, id, currentState !== 'on');
                },
                onBulkMove: async id => {
                    const labels = new Map([...scriptsById.entries()].map(([scriptId, script]) => [
                        String(scriptId),
                        script?.scriptName || String(scriptId),
                    ]));
                    const values = await requestFlexibleBulkMove(layout, id, labels);
                    if (!values) return;
                    if (rerenderIfRegexContextChanged()) return;
                    const result = layoutWithItemsMovedToFolder(layout, values.itemIds, values.targetFolderId);
                    if (!result.changed) return;
                    await persistRegexLayout(typeKey, owner, result.layout);
                    if (getCurrentChatId()) await reloadCurrentChat();
                    rerender();
                },
            });
            const items = folderElement.querySelector('.foldy-folder-items');
            items.dataset.foldyRegexType = typeKey;
            folder.items.forEach(id => {
                const item = itemMap.get(id);
                if (item) {
                    attachMoveToFolderButton(item, {
                        kind: 'regex',
                        layout,
                        itemId: id,
                        onMove: async movedLayout => {
                            if (rerenderIfRegexContextChanged()) return;
                            await persistRegexLayout(typeKey, owner, movedLayout);
                            rerender();
                        },
                    });
                    items.append(item);
                }
            });
            updateFolderCount(folderElement, {
                itemIdFromElement: item => item.id,
                isItemEnabled: id => !scriptsById.get(String(id))?.disabled,
            });
            list.append(folderElement);
        }

        const onCreate = async () => {
            const values = await requestNewRegexFolder(typeKey);
            if (!values) return;
            const { owner: targetOwner, layout: targetLayout } = readRegexLayout(values.typeKey);
            const result = layoutWithAddedFolder(targetLayout, values.name, values.itemIds);
            collapseNewFolder('regex', `${values.typeKey}:${targetOwner}`, result.folder.id);
            await persistRegexLayout(values.typeKey, targetOwner, result.layout, false);
            rerender();
        };
        const createHostTypeKey = Object.keys(regexTypes).find(key => document.querySelector(regexTypes[key].selector));
        ensureToolbar(list.parentElement, `regex-${typeKey}`, typeKey === createHostTypeKey ? onCreate : null, [
            createRootBulkMoveButton(async () => {
                const labels = new Map([...scriptsById.entries()].map(([scriptId, script]) => [
                    String(scriptId),
                    script?.scriptName || String(scriptId),
                ]));
                const values = await requestFlexibleBulkMove(layout, null, labels);
                if (!values) return;
                const result = layoutWithItemsMovedToFolder(layout, values.itemIds, values.targetFolderId);
                if (!result.changed) return;
                await persistRegexLayout(typeKey, owner, result.layout);
                if (getCurrentChatId()) await reloadCurrentChat();
                rerender();
            }),
            ...createCollapseButtons('regex', `${typeKey}:${owner}`, () => layout, async () => rerender()),
            ...createBundleButtons(() => exportRegexBundle(typeKey), () => importRegexBundle(typeKey)),
        ]);
        setupRegexSortable(typeKey, owner, layout);
    }

    function enhanceRegexLists() {
        if (regexRenderGate.isRunning()) return;
        const root = document.getElementById('regex_container');
        regexRenderGate.run(async () => {
            try {
                regexObserver?.disconnect();
                Object.keys(regexTypes).forEach(enhanceRegexList);
                regexObserver?.takeRecords();
            } catch (error) {
                debugLog('정규식 폴더 표시 실패', error);
                toastr.error('정규식 폴더를 표시하지 못했습니다.');
            } finally {
                if (root && regexObserver) {
                    regexObserver.observe(root, { childList: true, subtree: true });
                }
            }
        });
    }

    async function installRegexIntegration() {
        await waitUntilCondition(() => document.getElementById('regex_container')
            && Object.values(regexTypes).some(value => document.querySelector(value.selector)), 30000, 100, { rejectOnTimeout: false });
        const root = document.getElementById('regex_container');
        const presentLists = Object.fromEntries(Object.entries(regexTypes)
            .map(([key, value]) => [key, !!document.querySelector(value.selector)]));
        if (!root || !Object.values(presentLists).some(Boolean)) {
            if (featureEnabled('regex')) {
                disableFeatureForCompatibility('regex', 'regex', {
                    regex_container: !!root,
                    lists: presentLists,
                });
            }
            return;
        }
        regexObserver = new MutationObserver(() => {
            if (regexRenderGate.isRunning() || sortingRegex || regexRenderGate.isQueued()) return;
            regexRenderGate.queue(() => {
                if (sortingRegex) return;
                enhanceRegexLists();
            });
        });
        regexObserver.observe(root, { childList: true, subtree: true });
        enhanceRegexLists();
    }

    return {
        enhanceRegexLists,
        installRegexIntegration,
    };
}


export function regexLayoutRefs(scripts, ids) {
    const scriptsById = new Map(scripts
        .filter(script => script?.id)
        .map(script => [String(script.id), script]));
    return ids.map(id => {
        const script = scriptsById.get(String(id));
        return {
            id: String(id),
            scriptName: String(script?.scriptName || ''),
        };
    });
}

export function regexLayoutOnlyBundle(bundle) {
    return bundle?.contents === 'layout'
        || (Array.isArray(bundle?.scriptRefs) && !Array.isArray(bundle?.scripts));
}

export function createRegexBundleActions({
    settings,
    saveSettingsDebounced,
    regexTypes,
    regexOwnerKey,
    regexExportName,
    regexItemIds,
    readRegexLayout,
    persistRegexLayout,
    getScriptsByType,
    saveScriptsByType,
    getCurrentChatId,
    reloadCurrentChat,
    enhanceRegexLists,
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertRegexBundleShape,
    confirmText,
}) {
    function backupExistingRegex(typeKey) {
        const type = regexTypes[typeKey].scriptType;
        const owner = regexOwnerKey(typeKey);
        const scripts = getScriptsByType(type);
        const layout = normalizeLayout(settings().layouts.regex[typeKey][owner], regexItemIds(typeKey), { preserveUnrootedFolders: false });
        downloadJson({
            ...bundleEnvelope('regex'),
            owner,
            typeKey,
            backup: true,
            createdAt: new Date().toISOString(),
            layout: cloneJson(layout),
            scripts: cloneJson(scripts),
        }, backupFilename(`${regexExportName(typeKey)}-regex`));
    }

    async function requestRegexExportMode(typeKey) {
        const label = regexTypes[typeKey]?.label || typeKey;
        return requestBundleExportMode(
            `${label} 정규식 내보내기`,
            '정규식 스크립트와 폴더 구조',
            '폴더 구조만',
            '폴더 구조만 내보내면 불러올 때 현재 정규식 스크립트는 유지하고 폴더 배치만 적용합니다.',
            `foldy_regex_${typeKey}_export_mode`,
        );
    }

    async function importRegexLayoutBundle(bundle, typeKey) {
        if (!bundle?.layout) {
            toastr.error('정규식 구조 번들에 폴더 구조가 없습니다.');
            return;
        }
        if (bundle.typeKey && bundle.typeKey !== typeKey) {
            toastr.error(`이 번들은 ${regexTypes[bundle.typeKey]?.label || bundle.typeKey} 정규식 목록용입니다.`);
            return;
        }
        const label = regexTypes[typeKey].label;
        const type = regexTypes[typeKey].scriptType;
        const owner = regexOwnerKey(typeKey);
        const scripts = getScriptsByType(type);
        const currentIds = scripts.map(script => String(script.id)).filter(Boolean);
        const scriptsById = new Map(scripts
            .filter(script => script?.id)
            .map(script => [String(script.id), script]));
        const scriptNameIndex = uniqueNameIndex(scripts, script => script?.scriptName);
        const refsById = new Map((bundle.scriptRefs || [])
            .filter(ref => ref?.id != null)
            .map(ref => [String(ref.id), ref]));
        const idMap = new Map();
        let ambiguousNameCount = 0;
        for (const sourceId of flattenLayout(bundle.layout)) {
            const ref = refsById.get(String(sourceId));
            const direct = scriptsById.get(String(sourceId));
            const refNameKey = nameKey(ref?.scriptName);
            if (!direct && refNameKey && scriptNameIndex.ambiguous.has(refNameKey)) ambiguousNameCount++;
            const byName = refNameKey ? scriptNameIndex.unique.get(refNameKey) : null;
            const target = direct || byName;
            if (target?.id != null) idMap.set(String(sourceId), String(target.id));
        }
        const sourceItemCount = new Set(flattenLayout(bundle.layout)).size;
        const matchedTargetCount = new Set(idMap.values()).size;
        const confirmed = await confirmText(
            '정규식 폴더 구조 불러오기',
            `이 폴더 구조를 현재 ${label} 정규식 목록에 적용할까요? 정규식 내용은 바뀌지 않습니다.\n\n${importedLayoutSummary({
                currentLabel: '현재 스크립트',
                currentOnlyLabel: `현재 ${label} 정규식 목록에만 있는 스크립트`,
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
        await persistRegexLayout(typeKey, owner, layout);
        if (getCurrentChatId()) await reloadCurrentChat();
        enhanceRegexLists();
        renameTracker.notify();
        toastr.success('정규식 폴더 구조를 불러왔습니다.');
    }

    async function exportRegexBundle(typeKey) {
        const { owner, layout } = readRegexLayout(typeKey);
        const type = regexTypes[typeKey].scriptType;
        const scripts = getScriptsByType(type).map(cloneJson);
        const ids = new Set(flattenLayout(layout));
        const mode = await requestRegexExportMode(typeKey);
        if (!mode) return;

        if (mode === 'layout') {
            downloadJson({
                ...bundleEnvelope('regex'),
                contents: 'layout',
                typeKey,
                owner,
                layout: cloneJson(layout),
                scriptRefs: regexLayoutRefs(scripts, [...ids]),
            }, bundleFilename(`${regexExportName(typeKey)}-folders`));
            toastr.success('정규식 폴더 구조를 내보냈습니다.');
            return;
        }

        downloadJson({
            ...bundleEnvelope('regex'),
            typeKey,
            owner,
            layout: cloneJson(layout),
            scripts,
        }, bundleFilename(regexExportName(typeKey)));
        toastr.success('정규식 번들을 내보냈습니다.');
    }

    async function importRegexBundle(typeKey) {
        const rawBundle = await readJsonFile();
        const bundle = rawBundle ? assertBundle(rawBundle, 'regex') : null;
        if (!bundle) return;
        if (regexLayoutOnlyBundle(bundle)) {
            await importRegexLayoutBundle(bundle, typeKey);
            return;
        }
        if (!assertRegexBundleShape(bundle)) return;
        if (bundle.typeKey && bundle.typeKey !== typeKey) {
            toastr.error(`이 번들은 ${regexTypes[bundle.typeKey]?.label || bundle.typeKey} 정규식 목록용입니다.`);
            return;
        }
        const label = regexTypes[typeKey].label;
        const currentScriptsForConfirm = getScriptsByType(regexTypes[typeKey].scriptType);
        const scriptsByUniqueName = uniqueNameMap(currentScriptsForConfirm, script => script?.scriptName);
        const replacedCount = bundle.scripts.filter(script => scriptsByUniqueName.has(nameKey(script?.scriptName))).length;
        const importedScriptCount = bundle.scripts.filter(Boolean).length;
        const sourceLayoutIds = new Set(flattenLayout(bundle.layout));
        const importedScriptIds = new Set(bundle.scripts
            .filter(script => script?.id)
            .map(script => String(script.id)));
        const matchedLayoutCount = [...sourceLayoutIds].filter(id => importedScriptIds.has(String(id))).length;
        const layoutSummary = importedLayoutSummary({
            currentLabel: '가져올 스크립트',
            currentOnlyLabel: '폴더 구조에 없는 가져올 스크립트',
            currentCount: importedScriptCount,
            sourceCount: sourceLayoutIds.size,
            matchedSourceCount: matchedLayoutCount,
            matchedTargetCount: matchedLayoutCount,
        });
        const confirmed = await confirmText('정규식 번들 불러오기', replacedCount
            ? `이름이 같은 기존 ${label} 정규식 스크립트 ${replacedCount}개를 바꾸고 나머지를 추가할까요?\n\n현재 스크립트: ${currentScriptsForConfirm.length}개\n가져올 스크립트: ${importedScriptCount}개\n교체될 스크립트: ${replacedCount}개\n\n덮어쓰기 전에 백업 파일을 내려받습니다.\n\n${layoutSummary}\n\n계속할까요?`
            : `이 번들을 현재 ${label} 정규식 목록에 추가하고 폴더 구조를 적용할까요?\n\n현재 스크립트: ${currentScriptsForConfirm.length}개\n가져올 스크립트: ${importedScriptCount}개\n\n${layoutSummary}`);
        if (!confirmed) return;
        if (replacedCount) backupExistingRegex(typeKey);

        const type = regexTypes[typeKey].scriptType;
        const owner = regexOwnerKey(typeKey);
        const currentScripts = getScriptsByType(type);
        const scriptsById = new Map(currentScripts
            .filter(script => script?.id)
            .map(script => [String(script.id), script]));
        const scriptsByName = uniqueNameMap(currentScripts, script => script?.scriptName);
        const usedIds = new Set(scriptsById.keys());
        const idMap = new Map();
        bundle.scripts.filter(script => script).forEach(script => {
            const imported = cloneJson(script);
            const existing = scriptsByName.get(nameKey(imported.scriptName));
            const sourceId = String(imported.id || generateUUID());
            if (existing) {
                imported.id = existing.id;
            } else if (!imported.id || usedIds.has(String(imported.id))) {
                imported.id = generateUUID();
            }
            const targetId = String(imported.id);
            idMap.set(sourceId, targetId);
            usedIds.add(targetId);
            scriptsById.set(targetId, imported);
        });

        const currentIds = currentScripts.map(script => String(script.id)).filter(Boolean);
        const currentLayout = normalizeLayout(null, currentIds);
        const importedLayout = remapImportedLayout(bundle.layout, idMap);
        const allIds = [...new Set([...currentIds, ...idMap.values()])];
        const renameTracker = createFolderRenameTracker();
        const layout = mergeImportedLayout(currentLayout, importedLayout, allIds, renameTracker.options);
        settings().layouts.regex[typeKey][owner] = layout;
        saveSettingsDebounced();
        const orderedScripts = orderItemsByLayout(layout, [...scriptsById.values()]);
        await saveScriptsByType(orderedScripts, type);
        if (getCurrentChatId()) await reloadCurrentChat();
        // SillyTavern keeps its list renderer private. The imported scripts
        // are saved immediately; Foldy re-renders its existing rows without
        // requiring a non-public host export or a host-file modification.
        enhanceRegexLists();
        renameTracker.notify();
        toastr.success('정규식 번들을 불러왔습니다.');
    }

    return {
        exportRegexBundle,
        importRegexBundle,
    };
}
