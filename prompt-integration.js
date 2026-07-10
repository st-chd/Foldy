import {
    closeOpenFolderMenus,
    updateFolderCount,
} from './folder-ui.js';
import { createPromptBundleActions, createPromptSortables, promptOrderIds } from './prompt-bundles.js';
import {
    flattenLayout,
    layoutWithAddedFolder,
    layoutWithItemsMovedToFolder,
    layoutWithUpdatedFolder,
    normalizeLayout,
    removeFolder,
    rootItemIds,
} from './model.js';

function setPromptToolbarSummary(toolbar, layout, visibleItemIds = null) {
    if (!toolbar || !layout) return;
    const summary = document.createElement('span');
    summary.className = 'foldy-toolbar-summary';
    const folderCount = layout.folders?.length || 0;
    const unfiledCount = rootItemIds(layout).filter(id => !visibleItemIds || visibleItemIds.has(String(id))).length;
    summary.textContent = '폴더 ' + folderCount + ' / 미분류 ' + unfiledCount;
    summary.title = '폴더: ' + folderCount + ', 미분류 항목: ' + unfiledCount;
    toolbar.prepend(summary);
}

function placePromptToolbar(toolbar, rangeBlock) {
    if (!toolbar || !rangeBlock) return;
    const list = rangeBlock.querySelector('#completion_prompt_manager_list');
    if (list) rangeBlock.insertBefore(toolbar, list);
}

function createPromptInstaller({
    waitUntilCondition,
    promptManager,
    promptPresetManager,
    settings,
    featureEnabled,
    saveSettingsDebounced,
    debugLog,
    enhancePromptList,
    setupPromptSortables,
}) {
    let originalRenderItems = null;
    let originalMakeDraggable = null;

    return async function installPromptIntegration() {
        await waitUntilCondition(() => promptManager && promptPresetManager(), 30000, 100);
        const manager = promptManager;
        if (typeof manager.renderPromptManagerListItems !== 'function' || typeof manager.makeDraggable !== 'function') {
            settings().features.prompts = false;
            saveSettingsDebounced();
            debugLog('Prompt folder initialization API is missing', {
                renderPromptManagerListItems: typeof manager.renderPromptManagerListItems,
                makeDraggable: typeof manager.makeDraggable,
            });
            toastr.error('현재 SillyTavern 버전과 호환되지 않아 프롬프트 폴더를 비활성화했습니다.');
            return;
        }
        if (!originalRenderItems) originalRenderItems = manager.renderPromptManagerListItems.bind(manager);
        if (!originalMakeDraggable) originalMakeDraggable = manager.makeDraggable.bind(manager);
        if (manager.__foldyInstalled) return;
        manager.__foldyInstalled = true;

        manager.renderPromptManagerListItems = async function (...args) {
            await originalRenderItems.apply(this, args);
            if (!featureEnabled('prompts')) return;
            try {
                await enhancePromptList(manager);
            } catch (error) {
                debugLog('Prompt folder rendering failed', error);
                toastr.error('프롬프트 폴더를 표시하지 못해 원래 프롬프트 목록으로 되돌렸습니다.');
                await originalRenderItems.apply(this, args);
            }
        };
        manager.makeDraggable = function (...args) {
            const result = originalMakeDraggable.apply(this, args);
            if (featureEnabled('prompts')) {
                try {
                    setupPromptSortables(manager);
                } catch (error) {
                    debugLog('Prompt folder sorting initialization failed', error);
                }
            }
            return result;
        };
        manager.render(false);
    };
}

export function createPromptIntegration({
    settings,
    saveSettingsDebounced,
    waitUntilCondition,
    getSortableDelay,
    promptManager,
    promptPresetManager,
    promptOwnerKey,
    promptOwnerKeyForName,
    promptExportName,
    currentPromptPresetSettings,
    featureEnabled,
    debugLog,
    requestBundleExportMode,
    downloadJson,
    readJsonFile,
    assertBundle,
    assertPromptBundleShape,
    confirmText,
    shouldRejectDomLayout,
    ownerCollapsed,
    collapseNewFolder,
    ensureToolbar,
    createRootBulkMoveButton,
    createCollapseButtons,
    createBundleButtons,
    requestFolderSettings,
    confirmFolderDelete,
    requestFlexibleBulkMove,
    requestNewFolder,
    attachMoveToFolderButton,
    createFolderElement,
}) {
    let currentPromptLayout = null;

    function readPromptLayout(manager = promptManager, normalizeOptions = {}) {
        const owner = promptOwnerKey();
        const raw = settings().layouts.prompts[owner];
        return { owner, layout: normalizeLayout(raw, promptOrderIds(manager), normalizeOptions) };
    }

    async function persistPromptLayout(owner, layout, manager = promptManager) {
        const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
        const byId = new Map(order.map(entry => [String(entry.identifier), entry]));
        const flattened = flattenLayout(layout);
        order.splice(0, order.length, ...flattened.map(identifier => byId.get(identifier)).filter(Boolean));
        settings().layouts.prompts[owner] = layout;
        currentPromptLayout = layout;
        saveSettingsDebounced();
        await manager.saveServiceSettings();
    }

    const {
        exportPromptBundle,
        importPromptBundle,
    } = createPromptBundleActions({
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
        getCurrentPromptLayout: () => currentPromptLayout,
        setCurrentPromptLayout: layout => { currentPromptLayout = layout; },
        requestBundleExportMode,
        downloadJson,
        readJsonFile,
        assertBundle,
        assertPromptBundleShape,
        confirmText,
    });

    const { setupPromptSortables } = createPromptSortables({
        getSortableDelay,
        promptOwnerKey,
        getCurrentPromptLayout: () => currentPromptLayout,
        setCurrentPromptLayout: layout => { currentPromptLayout = layout; },
        persistPromptLayout,
        shouldRejectDomLayout,
        debugLog,
    });

    async function enhancePromptList(manager) {
        const list = manager.listElement;
        if (!list || !featureEnabled('prompts')) return;
        const { owner, layout } = readPromptLayout(manager);
        currentPromptLayout = layout;
        list.classList.add('foldy-prompt-root');

        closeOpenFolderMenus(list);
        const promptEnabledById = new Map(manager.getPromptOrderForCharacter(manager.activeCharacter)
            .map(entry => [String(entry.identifier), entry.enabled === true]));
        const itemMap = new Map([...list.querySelectorAll('[data-pm-identifier]')].map(element => [element.dataset.pmIdentifier, element]));
        const visiblePromptIds = new Set(itemMap.keys());
        itemMap.forEach(element => element.remove());
        const collapsed = ownerCollapsed('prompt', owner);
        const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));

        const rerender = () => manager.render(false);
        const promptContextChanged = activeLayout => activeLayout !== currentPromptLayout || promptOwnerKey() !== owner;
        const rerenderIfPromptContextChanged = activeLayout => {
            if (!promptContextChanged(activeLayout)) return false;
            rerender();
            return true;
        };
        const onEdit = async id => {
            const activeLayout = currentPromptLayout;
            const folder = activeLayout.folders.find(value => value.id === id);
            if (!folder) return;
            const values = await requestFolderSettings(activeLayout, folder);
            if (!values) return;
            if (rerenderIfPromptContextChanged(activeLayout)) return;
            const { applyStyleToAll, ...folderValues } = values;
            const result = layoutWithUpdatedFolder(activeLayout, folder.id, folderValues, { applyStyleToAll });
            await persistPromptLayout(owner, result.layout, manager);
            rerender();
        };
        const onDelete = async id => {
            const activeLayout = currentPromptLayout;
            const folder = activeLayout.folders.find(value => value.id === id);
            if (!folder || !await confirmFolderDelete(folder.name, '프롬프트 항목을')) return;
            if (rerenderIfPromptContextChanged(activeLayout)) return;
            const removedLayout = removeFolder(activeLayout, id);
            const nextLayout = normalizeLayout(removedLayout, promptOrderIds(manager), { preserveUnrootedFolders: false });
            await persistPromptLayout(owner, nextLayout, manager);
            rerender();
        };

        for (const node of layout.root) {
            if (node.type === 'item') {
                const item = itemMap.get(node.id);
                if (item) {
                    attachMoveToFolderButton(item, {
                        kind: 'prompt',
                        layout: currentPromptLayout,
                        itemId: node.id,
                        onMove: async movedLayout => {
                            if (promptOwnerKey() !== owner) {
                                rerender();
                                return;
                            }
                            currentPromptLayout = movedLayout;
                            await persistPromptLayout(owner, movedLayout, manager);
                            rerender();
                        },
                    });
                    list.append(item);
                }
                continue;
            }
            const folder = folderMap.get(node.id);
            if (!folder) continue;
            const folderElement = createFolderElement(folder, {
                kind: 'prompt',
                owner,
                collapsed,
                onEdit,
                onDelete,
                onBulkMove: async id => {
                    const activeLayout = currentPromptLayout;
                    const labels = new Map([...itemMap.entries()].map(([itemId, element]) => [
                        String(itemId),
                        element.querySelector('.completion_prompt_manager_prompt_name')?.textContent?.trim() || String(itemId),
                    ]));
                    const values = await requestFlexibleBulkMove(activeLayout, id, labels);
                    if (!values) return;
                    if (rerenderIfPromptContextChanged(activeLayout)) return;
                    const result = layoutWithItemsMovedToFolder(activeLayout, values.itemIds, values.targetFolderId);
                    if (!result.changed) return;
                    await persistPromptLayout(owner, result.layout, manager);
                    rerender();
                },
            });
            const items = folderElement.querySelector('.foldy-folder-items');
            folder.items.forEach(id => {
                const item = itemMap.get(id);
                if (item) {
                    attachMoveToFolderButton(item, {
                        kind: 'prompt',
                        layout: currentPromptLayout,
                        itemId: id,
                        onMove: async movedLayout => {
                            if (promptOwnerKey() !== owner) {
                                rerender();
                                return;
                            }
                            currentPromptLayout = movedLayout;
                            await persistPromptLayout(owner, movedLayout, manager);
                            rerender();
                        },
                    });
                    items.append(item);
                }
            });
            updateFolderCount(folderElement, {
                itemIdFromElement: item => item.dataset.pmIdentifier,
                isItemEnabled: id => promptEnabledById.get(String(id)) === true,
            });
            list.append(folderElement);
        }

        const rangeBlock = list.closest('.range-block');
        const toolbar = ensureToolbar(rangeBlock, 'prompt', async () => {
            const activeLayout = currentPromptLayout;
            const promptsById = new Map((manager.serviceSettings.prompts || [])
                .filter(prompt => prompt?.identifier)
                .map(prompt => [String(prompt.identifier), prompt]));
            const candidates = rootItemIds(activeLayout)
                .filter(id => visiblePromptIds.has(String(id)))
                .map(id => ({
                    id,
                    label: promptsById.get(id)?.name || id,
                }));
            const values = await requestNewFolder(activeLayout, candidates);
            if (!values) return;
            if (rerenderIfPromptContextChanged(activeLayout)) return;
            const result = layoutWithAddedFolder(activeLayout, values.name, values.itemIds);
            collapseNewFolder('prompt', owner, result.folder.id);
            await persistPromptLayout(owner, result.layout, manager);
            rerender();
        }, [
            createRootBulkMoveButton(async () => {
                const activeLayout = currentPromptLayout;
                const labels = new Map([...itemMap.entries()].map(([itemId, element]) => [
                    String(itemId),
                    element.querySelector('.completion_prompt_manager_prompt_name')?.textContent?.trim() || String(itemId),
                ]));
                const values = await requestFlexibleBulkMove(activeLayout, null, labels);
                if (!values) return;
                if (rerenderIfPromptContextChanged(activeLayout)) return;
                const result = layoutWithItemsMovedToFolder(activeLayout, values.itemIds, values.targetFolderId);
                if (!result.changed) return;
                await persistPromptLayout(owner, result.layout, manager);
                rerender();
            }),
            ...createCollapseButtons('prompt', owner, () => currentPromptLayout, async () => rerender()),
            ...createBundleButtons(() => exportPromptBundle(manager), () => importPromptBundle(manager)),
        ]);
        setPromptToolbarSummary(toolbar, currentPromptLayout, visiblePromptIds);
        placePromptToolbar(toolbar, rangeBlock);
    }

    const installPromptIntegration = createPromptInstaller({
        waitUntilCondition,
        promptManager,
        promptPresetManager,
        settings,
        featureEnabled,
        saveSettingsDebounced,
        debugLog,
        enhancePromptList,
        setupPromptSortables,
    });

    return {
        installPromptIntegration,
        renderPrompts: () => promptManager?.render?.(false),
        readPromptLayout,
        persistPromptLayout,
    };
}
