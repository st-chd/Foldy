import { bindAction, createColorSetting, createIconButton, createSelectionToolbar, appendSelectionRow, themeColorHex } from './folder-ui.js';
import {
    hasDuplicateFolderName,
    layoutWithItemMovedToFolder,
    rootItemIds,
    rootNodeKey,
} from './model.js';

// 네이티브 select 펼침 목록의 너비는 CSS로 제어 불가하고 가장 긴 옵션을 따라가므로,
// 표시용 글자 수를 잘라서 너비를 잡는다.
const POSITION_OPTION_MAX_LENGTH = 30;

function truncateOptionLabel(value) {
    const text = String(value ?? '');
    return text.length > POSITION_OPTION_MAX_LENGTH
        ? `${text.slice(0, POSITION_OPTION_MAX_LENGTH - 1)}…`
        : text;
}

// 새/기존 폴더를 어느 위치에 둘지 고르는 필드. 폴더와 루트 낱개 항목 모두 기준으로
// 삼을 수 있다. excludeKey는 자기 자신을, selectedKey는 현재 위치를 미리 선택한다.
// 기준 노드가 없으면 null을 돌려주고 호출부는 필드를 그리지 않는다.
function createFolderPositionField(layout, labelById = new Map(), {
    excludeKey = '',
    hintText = '(선택한 폴더·항목 바로 아래에 새 폴더가 생성됩니다)',
    selectedKey = '',
} = {}) {
    const anchors = [];
    for (const node of layout.root) {
        const key = rootNodeKey(node);
        if (key === excludeKey) continue;
        if (node.type === 'folder') {
            const folder = layout.folders.find(value => value.id === node.id);
            if (folder) anchors.push({ key, text: `${folder.name} 폴더` });
            continue;
        }
        // 라벨이 없는 항목은 화면에 보이지 않는 항목이므로 기준으로 제시하지 않는다.
        const label = labelById.get(String(node.id));
        if (label) anchors.push({ key, text: label });
    }
    if (!anchors.length) return null;

    const field = document.createElement('label');
    field.className = 'foldy-text-field foldy-position-field';
    const text = document.createElement('span');
    text.textContent = '위치';
    const select = document.createElement('select');
    select.className = 'text_pole';
    const hint = document.createElement('small');
    hint.className = 'foldy-field-hint';
    hint.textContent = hintText;

    const topOption = document.createElement('option');
    topOption.value = '';
    topOption.textContent = '맨 위';
    select.append(topOption);

    for (const anchor of anchors) {
        const option = document.createElement('option');
        option.value = anchor.key;
        option.textContent = truncateOptionLabel(anchor.text);
        option.title = anchor.text;
        select.append(option);
    }

    if (selectedKey && anchors.some(anchor => anchor.key === selectedKey)) {
        select.value = selectedKey;
    }

    field.append(text, select, hint);
    return { field, select };
}

// folder(root 안의 폴더 노드) 바로 앞에 있는 root 노드의 key. 그게 이 폴더의
// "현재 위치"에 해당하는 위치 select 값이다(맨 앞이면 빈 문자열 = 맨 위).
function currentAnchorKeyForFolder(layout, folderId) {
    const index = layout.root.findIndex(node => node.type === 'folder' && node.id === folderId);
    if (index <= 0) return '';
    return rootNodeKey(layout.root[index - 1]);
}

function labelMapFromCandidates(candidates) {
    return new Map((candidates || [])
        .filter(candidate => candidate?.id && candidate?.label)
        .map(candidate => [String(candidate.id), candidate.label]));
}

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
        const position = createFolderPositionField(layout, labelMapFromCandidates(selectable));
        if (position) form.append(position.field);

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
        return { name: nameInput.value.trim(), itemIds, afterKey: position?.select.value || '' };
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

        const positionContainer = document.createElement('div');

        const group = document.createElement('div');
        group.className = 'foldy-create-items';
        const list = document.createElement('div');
        list.className = 'foldy-create-items-list';
        const selection = createSelectionToolbar(list, '\uD3F4\uB354\uC5D0 \uB123\uC744 \uD56D\uBAA9');
        group.append(selection.toolbar, list);

        let positionSelect = null;
        const selectedTypeKey = () => form.querySelector('input[name="foldy_regex_folder_target"]:checked')?.value || 'global';
        const renderCandidates = () => {
            const { layout, candidates } = regexFolderCreateContext(selectedTypeKey());

            positionContainer.innerHTML = '';
            const position = createFolderPositionField(layout, labelMapFromCandidates(candidates));
            positionSelect = position?.select ?? null;
            if (position) positionContainer.append(position.field);

            list.innerHTML = '';
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
        form.append(title, targetField, nameField, positionContainer, group);
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
        return { typeKey, name: nameInput.value.trim(), itemIds, afterKey: positionSelect?.value || '' };
    }

    async function requestFolderSettings(layout, folder, candidates = []) {
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

        const position = createFolderPositionField(layout, labelMapFromCandidates(candidates), {
            excludeKey: `folder:${folder.id}`,
            hintText: '(\uC120\uD0DD\uD55C \uD3F4\uB354\u00B7\uD56D\uBAA9 \uBC14\uB85C \uC544\uB798\uB85C \uC62E\uACA8\uC9D1\uB2C8\uB2E4)',
            selectedKey: currentAnchorKeyForFolder(layout, folder.id),
        });

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

        form.append(title, nameField);
        if (position) form.append(position.field);
        form.append(backgroundColor.field, borderColor.field, nameColor.field, applyAllField);

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
            afterKey: position?.select.value || '',
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
            option.textContent = truncateOptionLabel(folder.name);
            option.title = folder.name;
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
            option.textContent = `${truncateOptionLabel(source.name)} (${source.items.length})`;
            option.title = source.name;
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
                option.textContent = truncateOptionLabel(target.name);
                option.title = target.name;
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
            // 모바일 grid 레이아웃에서 셀 미지정 버튼이 좁은 컬럼에 몰리지 않도록
            // 기본 버튼들을 항상 이 래퍼로 묶는다(폴더가 없어도).
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
