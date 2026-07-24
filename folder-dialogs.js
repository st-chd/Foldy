import { bindAction, createColorSetting, createIconButton, createSelectionToolbar, appendSelectionRow, themeColorHex } from './folder-ui.js';
import {
    hasDuplicateFolderName,
    layoutWithItemMovedToFolder,
    rootItemIds,
} from './model.js';

export function createFolderDialogs({
    Popup,
    POPUP_RESULT,
    POPUP_TYPE,
    withErrorToast,
    regexFolderTargets = [],
    regexFolderCreateContext = null,
}) {
    async function requestNewFolder(layout, candidates = []) {
        const form = document.createElement('div');
        form.className = 'foldy-edit-form foldy-create-form';

        const title = document.createElement('div');
        title.className = 'foldy-edit-title';
        title.textContent = '\uC0C8 \uD3F4\uB354';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = '\uD3F4\uB354 \uC774\uB984';
        nameInput.autofocus = true;

        const nameField = document.createElement('label');
        nameField.className = 'foldy-text-field';
        const nameLabel = document.createElement('span');
        nameLabel.textContent = '\uC774\uB984';
        nameField.append(nameLabel, nameInput);

        form.append(title, nameField);

        const selectable = candidates.filter(candidate => candidate?.id && candidate?.label);
        if (selectable.length) {
            const group = document.createElement('div');
            group.className = 'foldy-create-items';
            const list = document.createElement('div');
            list.className = 'foldy-create-items-list';
            const selection = createSelectionToolbar(list, '\uD3F4\uB354\uC5D0 \uB123\uC744 \uD56D\uBAA9');
            selectable.forEach(candidate => {
                const label = document.createElement('label');
                label.className = 'checkbox flex-container';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = String(candidate.id);
                const text = document.createElement('span');
                text.textContent = candidate.label;
                text.title = candidate.label;
                appendSelectionRow(label, checkbox, text);
                list.append(label);
            });
            selection.sync();
            group.append(selection.toolbar, list);
            form.append(group);
        }

        const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
            okButton: '\uB9CC\uB4E4\uAE30',
            cancelButton: '\uCDE8\uC18C',
            onClosing: value => {
                if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                const name = nameInput.value.trim();
                if (!name) {
                    toastr.warning('\uD3F4\uB354 \uC774\uB984\uC740 \uBE44\uC6CC\uB458 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.');
                    return false;
                }
                if (hasDuplicateFolderName(layout, name)) {
                    toastr.warning('\uAC19\uC740 \uC774\uB984\uC758 \uD3F4\uB354\uAC00 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.');
                    return false;
                }
                return true;
            },
        });
        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
        const itemIds = [...form.querySelectorAll('.foldy-create-items input[type="checkbox"]:checked')]
            .map(input => String(input.value));
        return { name: nameInput.value.trim(), itemIds };
    }

    async function requestNewRegexFolder(defaultTypeKey = 'global') {
        if (typeof regexFolderCreateContext !== 'function') return null;

        const form = document.createElement('div');
        form.className = 'foldy-edit-form foldy-create-form';

        const title = document.createElement('div');
        title.className = 'foldy-edit-title';
        title.textContent = '\uC0C8 \uD3F4\uB354';

        const targetField = document.createElement('label');
        targetField.className = 'foldy-text-field foldy-target-field';
        const targetLabel = document.createElement('span');
        targetLabel.textContent = '\uB300\uC0C1';
        const targetControls = document.createElement('span');
        targetControls.className = 'foldy-target-options';
        regexFolderTargets.forEach(target => {
            const option = document.createElement('label');
            option.className = 'checkbox flex-container foldy-target-option';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'foldy_regex_folder_target';
            input.value = target.key;
            input.checked = target.key === defaultTypeKey;
            const text = document.createElement('span');
            text.textContent = target.label;
            option.append(input, text);
            targetControls.append(option);
        });
        targetField.append(targetLabel, targetControls);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = '\uD3F4\uB354 \uC774\uB984';
        nameInput.autofocus = true;

        const nameField = document.createElement('label');
        nameField.className = 'foldy-text-field';
        const nameLabel = document.createElement('span');
        nameLabel.textContent = '\uC774\uB984';
        nameField.append(nameLabel, nameInput);

        const group = document.createElement('div');
        group.className = 'foldy-create-items';
        const list = document.createElement('div');
        list.className = 'foldy-create-items-list';
        const selection = createSelectionToolbar(list, '\uD3F4\uB354\uC5D0 \uB123\uC744 \uD56D\uBAA9');
        group.append(selection.toolbar, list);

        const selectedTypeKey = () => form.querySelector('input[name="foldy_regex_folder_target"]:checked')?.value || 'global';
        const renderCandidates = () => {
            list.innerHTML = '';
            const { candidates } = regexFolderCreateContext(selectedTypeKey());
            if (!candidates.length) {
                const empty = document.createElement('div');
                empty.className = 'foldy-empty-hint';
                empty.textContent = '\uD3F4\uB354\uC5D0 \uB123\uC744 \uC218 \uC788\uB294 \uB8E8\uD2B8 \uD56D\uBAA9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.';
                list.append(empty);
                selection.sync();
                return;
            }
            candidates.forEach(candidate => {
                const label = document.createElement('label');
                label.className = 'checkbox flex-container';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = String(candidate.id);
                const text = document.createElement('span');
                text.textContent = candidate.label;
                text.title = candidate.label;
                appendSelectionRow(label, checkbox, text);
                list.append(label);
            });
            selection.sync();
        };

        targetControls.addEventListener('input', renderCandidates);
        form.append(title, targetField, nameField, group);
        renderCandidates();

        const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
            okButton: '\uB9CC\uB4E4\uAE30',
            cancelButton: '\uCDE8\uC18C',
            onClosing: value => {
                if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                const name = nameInput.value.trim();
                if (!name) {
                    toastr.warning('\uD3F4\uB354 \uC774\uB984\uC740 \uBE44\uC6CC\uB458 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.');
                    return false;
                }
                const { layout } = regexFolderCreateContext(selectedTypeKey());
                if (hasDuplicateFolderName(layout, name)) {
                    toastr.warning('\uAC19\uC740 \uC774\uB984\uC758 \uD3F4\uB354\uAC00 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.');
                    return false;
                }
                return true;
            },
        });
        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
        const typeKey = selectedTypeKey();
        const itemIds = [...form.querySelectorAll('.foldy-create-items input[type="checkbox"]:checked')]
            .map(input => String(input.value));
        return { typeKey, name: nameInput.value.trim(), itemIds };
    }

    async function requestFolderSettings(layout, folder) {
        const form = document.createElement('div');
        form.className = 'foldy-edit-form foldy-folder-settings-form';

        const title = document.createElement('div');
        title.className = 'foldy-edit-title';
        title.textContent = '\uD3F4\uB354 \uC124\uC815';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = folder.name;
        nameInput.placeholder = '\uD3F4\uB354 \uC774\uB984';
        nameInput.autofocus = true;

        const nameField = document.createElement('label');
        nameField.className = 'foldy-text-field';
        const nameLabel = document.createElement('span');
        nameLabel.textContent = '\uC774\uB984';
        nameField.append(nameLabel, nameInput);

        const backgroundColor = createColorSetting('\uBC30\uACBD\uC0C9', folder.color, themeColorHex('--SmartThemeBlurTintColor'));
        const borderColor = createColorSetting('\uD14C\uB450\uB9AC\uC0C9', folder.borderColor, themeColorHex('--SmartThemeBorderColor'));
        const nameColor = createColorSetting('\uC774\uB984 \uC0C9\uC0C1', folder.nameColor, themeColorHex('--SmartThemeBodyColor', '#ffffff'));

        const applyAllField = document.createElement('label');
        applyAllField.className = 'checkbox flex-container foldy-apply-style-all';
        const applyAllCheckbox = document.createElement('input');
        applyAllCheckbox.type = 'checkbox';
        const applyAllText = document.createElement('span');
        applyAllText.textContent = '\uB2E4\uB978 \uD3F4\uB354\uC5D0\uB3C4 \uC0C9\uC0C1 \uC801\uC6A9';
        applyAllField.append(applyAllCheckbox, applyAllText);

        form.append(title, nameField, backgroundColor.field, borderColor.field, nameColor.field, applyAllField);

        const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
            okButton: '\uC801\uC6A9',
            cancelButton: '\uCDE8\uC18C',
            customButtons: [{
                text: '\uAE30\uBCF8\uAC12',
                tooltip: '\uBAA8\uB4E0 \uC0C9\uC0C1\uC744 \uD14C\uB9C8 \uAE30\uBCF8\uAC12\uC73C\uB85C \uB418\uB3CC\uB9AC\uAE30',
                action: () => [backgroundColor, borderColor, nameColor].forEach(setting => setting.reset()),
            }],
            onClosing: value => {
                if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                const name = nameInput.value.trim();
                if (!name) {
                    toastr.warning('\uD3F4\uB354 \uC774\uB984\uC740 \uBE44\uC6CC\uB458 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.');
                    return false;
                }
                if (hasDuplicateFolderName(layout, name, folder.id)) {
                    toastr.warning('\uAC19\uC740 \uC774\uB984\uC758 \uD3F4\uB354\uAC00 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.');
                    return false;
                }
                if (![backgroundColor, borderColor, nameColor].every(setting => setting.isValid())) {
                    toastr.warning('transparent, #fff, #ffff, #ffffff, #ffffffff \uD615\uC2DD\uC73C\uB85C \uC785\uB825\uD558\uAC70\uB098 \uAE30\uBCF8\uAC12\uC744 \uC4F0\uB824\uBA74 \uBE44\uC6CC\uB450\uC138\uC694.');
                    return false;
                }
                return true;
            },
        });
        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

        return {
            name: nameInput.value.trim(),
            color: backgroundColor.value(),
            borderColor: borderColor.value(),
            nameColor: nameColor.value(),
            applyStyleToAll: applyAllCheckbox.checked,
        };
    }

    async function requestMoveTarget(layout, itemId) {
        if (!layout.folders.length) {
            toastr.info('\uBA3C\uC800 \uD3F4\uB354\uB97C \uB9CC\uB4E4\uC5B4 \uC8FC\uC138\uC694.');
            return null;
        }

        const currentFolder = layout.folders.find(folder => folder.items.includes(String(itemId)));
        const currentValue = currentFolder?.id ?? '';
        const form = document.createElement('div');
        form.className = 'foldy-move-form';

        const title = document.createElement('div');
        title.className = 'foldy-edit-title';
        title.textContent = '\uD3F4\uB354\uB85C \uC774\uB3D9';

        const label = document.createElement('label');
        const text = document.createElement('span');
        text.textContent = '\uB300\uC0C1';
        const select = document.createElement('select');
        select.className = 'text_pole';

        const rootOption = document.createElement('option');
        rootOption.value = '';
        rootOption.textContent = '\uCD5C\uC0C1\uC704 (\uD3F4\uB354 \uC5C6\uC74C)';
        select.append(rootOption);
        for (const folder of layout.folders) {
            const option = document.createElement('option');
            option.value = folder.id;
            option.textContent = folder.name;
            select.append(option);
        }
        select.value = currentValue;
        label.append(text, select);
        form.append(title, label);

        const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
            okButton: '\uC774\uB3D9',
            cancelButton: '\uCDE8\uC18C',
        }).show();

        return result === POPUP_RESULT.AFFIRMATIVE ? select.value : null;
    }

    async function requestFlexibleBulkMove(layout, sourceFolderId, labelById = new Map()) {
        const requestedSourceId = String(sourceFolderId ?? '');
        const rootSource = { id: '', name: '\uBBF8\uBD84\uB958', items: rootItemIds(layout) };
        const sources = [
            rootSource,
            ...layout.folders.map(folder => ({ id: String(folder.id), name: folder.name, items: folder.items || [] })),
        ];
        const requestedSource = sources.find(source => source.id === requestedSourceId);
        const firstFilledSource = sources.find(source => source.items.length && source.id !== requestedSourceId);
        const initialSourceId = requestedSource?.items?.length ? requestedSource.id : firstFilledSource?.id ?? requestedSource?.id ?? '';
        const initialTargetId = requestedSource && !requestedSource.items.length ? requestedSource.id : '';

        if (!sources.some(source => source.items.length)) {
            toastr.info('\uC774\uB3D9\uD560 \uD56D\uBAA9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.');
            return null;
        }

        const form = document.createElement('div');
        form.className = 'foldy-move-form foldy-bulk-move-form';

        const title = document.createElement('div');
        title.className = 'foldy-edit-title';

        const sourceLabel = document.createElement('label');
        const sourceText = document.createElement('span');
        sourceText.textContent = '\uAC00\uC838\uC62C \uACF3';
        const sourceSelect = document.createElement('select');
        sourceSelect.className = 'text_pole';
        for (const source of sources) {
            const option = document.createElement('option');
            option.value = source.id;
            option.textContent = `${source.name} (${source.items.length})`;
            option.disabled = !source.items.length;
            sourceSelect.append(option);
        }
        sourceSelect.value = initialSourceId;
        sourceLabel.append(sourceText, sourceSelect);

        const itemGroup = document.createElement('div');
        itemGroup.className = 'foldy-create-items';
        const list = document.createElement('div');
        list.className = 'foldy-create-items-list';
        const selection = createSelectionToolbar(list, '\uC120\uD0DD\uD560 \uD56D\uBAA9');
        itemGroup.append(selection.toolbar, list);

        const targetLabel = document.createElement('label');
        const targetText = document.createElement('span');
        targetText.textContent = '\uBCF4\uB0BC \uACF3';
        const targetSelect = document.createElement('select');
        targetSelect.className = 'text_pole';
        targetLabel.append(targetText, targetSelect);

        const sourceById = new Map(sources.map(source => [source.id, source]));
        const renderTargetOptions = () => {
            const previousValue = targetSelect.value;
            const currentSourceId = sourceSelect.value;
            targetSelect.innerHTML = '';
            const targetOptions = [
                { id: '', name: '\uBBF8\uBD84\uB958' },
                ...layout.folders.map(folder => ({ id: String(folder.id), name: folder.name })),
            ].filter(target => target.id !== currentSourceId);
            for (const target of targetOptions) {
                const option = document.createElement('option');
                option.value = target.id;
                option.textContent = target.name;
                targetSelect.append(option);
            }
            const preferred = initialTargetId && initialTargetId !== currentSourceId ? initialTargetId : previousValue;
            targetSelect.value = [...targetSelect.options].some(option => option.value === preferred) ? preferred : targetSelect.options[0]?.value ?? '';
        };
        const renderItems = () => {
            const source = sourceById.get(sourceSelect.value) || rootSource;
            title.textContent = '[\uC77C\uAD04 \uC774\uB3D9] ' + source.name;
            list.innerHTML = '';
            for (const id of source.items) {
                const label = document.createElement('label');
                label.className = 'checkbox flex-container';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = String(id);
                const text = document.createElement('span');
                text.textContent = labelById.get(String(id)) || String(id);
                text.title = text.textContent;
                appendSelectionRow(label, checkbox, text);
                list.append(label);
            }
            selection.sync();
            renderTargetOptions();
        };

        sourceSelect.addEventListener('input', renderItems);
        form.append(title, sourceLabel, itemGroup, targetLabel);
        renderItems();

        const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
            okButton: '\uC774\uB3D9',
            cancelButton: '\uCDE8\uC18C',
            onClosing: value => {
                if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                if (!form.querySelector('.foldy-create-items input[type="checkbox"]:checked')) {
                    toastr.warning('\uC774\uB3D9\uD560 \uD56D\uBAA9\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.');
                    return false;
                }
                return true;
            },
        }).show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
        return {
            itemIds: [...form.querySelectorAll('.foldy-create-items input[type="checkbox"]:checked')]
                .map(input => String(input.value)),
            targetFolderId: targetSelect.value,
        };
    }

    function createRootBulkMoveButton(onClick) {
        const button = createIconButton('fa-folder-tree', '\uBBF8\uBD84\uB958 \uC77C\uAD04 \uC774\uB3D9', 'foldy-root-bulk-move');
        bindAction(button, '\uBBF8\uBD84\uB958 \uC77C\uAD04 \uC774\uB3D9', onClick, { withErrorToast });
        return button;
    }

    function createMoveToFolderButton(kind, layout, itemId, onMove) {
        const title = '\uD3F4\uB354\uB85C \uC774\uB3D9';
        const button = kind === 'prompt' ? document.createElement('span') : createIconButton('fa-folder-open', title, 'foldy-move-to-folder');
        if (kind === 'prompt') {
            button.className = 'fa-solid fa-folder-open foldy-move-to-folder';
            button.title = title;
            button.setAttribute('aria-label', title);
        }
        bindAction(button, '\uD3F4\uB354 \uC774\uB3D9', async () => {
            const target = await requestMoveTarget(layout, itemId);
            if (target === null) return;
            const result = layoutWithItemMovedToFolder(layout, itemId, target);
            if (!result.changed) return;
            await onMove(result.layout);
        }, { withErrorToast });
        return button;
    }

    function attachMoveToFolderButton(element, { kind, layout, itemId, onMove }) {
        if (!element) return;
        element.querySelectorAll?.(':scope .foldy-move-to-folder').forEach(button => button.remove());

        if (kind === 'lore') {
            const host = element.querySelector('.inline-drawer-header');
            if (!host) return;
            // Always group the native move/duplicate/delete buttons into this
            // wrapper, even with zero folders: the mobile layout puts
            // .inline-drawer-header into a fixed-column CSS grid, and without
            // this wrapper those buttons have no assigned grid cell, so they
            // fall back to grid auto-placement and end up crammed into the
            // narrow left column across multiple rows instead of following
            // the entry's own controls.
            let actions = host.querySelector(':scope > .foldy-lore-entry-actions');
            if (!actions) {
                actions = document.createElement('div');
                actions.className = 'foldy-lore-entry-actions';
                const nativeButtons = [...host.querySelectorAll(':scope > .move_entry_button, :scope > .duplicate_entry_button, :scope > .delete_entry_button')];
                host.append(actions);
                nativeButtons.forEach(value => actions.append(value));
            }
            if (layout.folders.length) {
                actions.prepend(createMoveToFolderButton(kind, layout, itemId, onMove));
            }
            return;
        }

        if (!layout.folders.length) return;
        const button = createMoveToFolderButton(kind, layout, itemId, onMove);

        if (kind === 'prompt') {
            element.querySelector('.prompt_manager_prompt_controls')?.prepend(button);
            return;
        }

        if (kind === 'regex') {
            const host = element.querySelector('.regex_script_buttons')
                || element.querySelector('.regex_script_expand')?.parentElement
                || element;
            host.prepend(button);
        }
    }

    return {
        requestNewFolder,
        requestNewRegexFolder,
        requestFolderSettings,
        requestMoveTarget,
        requestFlexibleBulkMove,
        createRootBulkMoveButton,
        attachMoveToFolderButton,
    };
}

export function createConfirmDialogs({ Popup, POPUP_RESULT, POPUP_TYPE }) {
    async function confirmText(titleText, messageText, { okButton = '\uD655\uC778', cancelButton = '\uCDE8\uC18C' } = {}) {
        const body = document.createElement('div');
        body.className = 'foldy-confirm-body';
        const title = document.createElement('h3');
        title.textContent = titleText;
        const message = document.createElement('p');
        message.className = 'foldy-confirm-message';
        message.textContent = messageText;
        body.append(title, message);
        const result = await new Popup(body, POPUP_TYPE.CONFIRM, '', {
            okButton,
            cancelButton,
        }).show();
        return result === POPUP_RESULT.AFFIRMATIVE;
    }

    async function confirmFolderDelete(folderName, itemLabel) {
        return confirmText(
            '\uD3F4\uB354 \uC0AD\uC81C',
            `"${folderName}" \uD3F4\uB354\uB97C \uC0AD\uC81C\uD558\uACE0 \uC548\uC758 ${itemLabel} \uCD5C\uC0C1\uC704\uB85C \uC62E\uAE38\uAE4C\uC694?`,
            { okButton: '\uC0AD\uC81C' },
        );
    }

    return {
        confirmText,
        confirmFolderDelete,
    };
}
