import { setLoreEntryPosition, setLoreEntryStrategy } from './lorebook-integration.js';

const booleanOptions = [['true', '사용'], ['false', '사용 안 함']];
const defaultOption = ['null', '기본 설정 사용'];
const fields = [
    { key: 'strategy', label: '전략', options: [['normal', '키워드 활성화'], ['constant', '상시 활성화'], ['vectorized', '벡터화됨']] },
    { key: 'position', label: '위치', options: [
        ['0:', '캐릭터 정의 전'], ['1:', '캐릭터 정의 후'], ['5:', '↑ EM'], ['6:', '↓ EM'],
        ['2:', '작가 노트 전'], ['3:', '작가 노트 후'], ['4:0', '@D ⚙️'], ['4:1', '@D 👤'],
        ['4:2', '@D 🤖'], ['7:', '➡️ outlet'],
    ] },
    { key: 'scanDepth', label: '스캔 깊이', path: 'scan_depth', options: [defaultOption, ['number', '직접 입력']], min: 0 },
    { key: 'caseSensitive', label: '대소문자 구분', path: 'case_sensitive', options: [defaultOption, ...booleanOptions] },
    { key: 'matchWholeWords', label: '단어 전체 일치 (Whole Words)', path: 'match_whole_words', options: [defaultOption, ...booleanOptions] },
    { key: 'excludeRecursion', label: '재귀 검색 제외 (Non-recursable)', path: 'exclude_recursion', options: booleanOptions },
    { key: 'preventRecursion', label: '추가 재귀 방지', path: 'prevent_recursion', options: booleanOptions },
    { key: 'delayUntilRecursion', label: '재귀까지 지연', path: 'delay_until_recursion', options: [...booleanOptions, ['number', '지연 단계 지정']], min: 1 },
    { key: 'ignoreBudget', label: '예산 무시 (Ignore budget)', path: 'ignore_budget', options: booleanOptions },
];

export async function requestLoreFolderSettings(folder, { Popup, POPUP_TYPE, POPUP_RESULT, maxScanDepth }) {
    const form = document.createElement('div');
    form.className = 'foldy-move-form foldy-lore-bulk-setting-form';
    const title = document.createElement('div');
    title.className = 'foldy-edit-title';
    title.textContent = `[${folder.name}] 항목 설정 일괄 변경`;
    const hint = document.createElement('p');
    hint.textContent = '선택한 설정만 폴더 내 모든 항목에 적용합니다. ‘변경하지 않음’은 각 항목의 기존 값을 유지합니다.';
    form.append(title, hint);
    const fieldsContainer = document.createElement('div');
    fieldsContainer.className = 'foldy-lore-bulk-fields';
    form.append(fieldsContainer);
    const controls = fields.map(field => {
        const label = document.createElement('label');
        const text = document.createElement('span');
        text.textContent = field.label;
        const group = document.createElement('span');
        group.className = 'foldy-lore-bulk-controls';
        const select = document.createElement('select');
        select.className = 'text_pole';
        select.name = field.key;
        for (const [value, caption] of [['', '변경하지 않음'], ...field.options]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = caption;
            select.append(option);
        }
        select.value = '';
        group.append(select);
        let input;
        let positionInputs;
        if (field.key === 'position') {
            const depth = document.createElement('input');
            depth.className = 'text_pole';
            depth.type = 'number';
            depth.min = '0';
            depth.max = String(maxScanDepth);
            depth.step = '1';
            depth.placeholder = '깊이 (비워두면 기존 값 유지)';
            depth.setAttribute('aria-label', '삽입 깊이');
            const outlet = document.createElement('input');
            outlet.className = 'text_pole';
            outlet.type = 'text';
            outlet.placeholder = 'outlet 이름 (비워두면 기존 값 유지)';
            outlet.setAttribute('aria-label', 'outlet 이름');
            const updatePositionInputs = () => {
                depth.hidden = depth.disabled = !select.value.startsWith('4:');
                outlet.hidden = outlet.disabled = select.value !== '7:';
            };
            select.addEventListener('change', updatePositionInputs);
            updatePositionInputs();
            group.append(depth, outlet);
            positionInputs = { depth, outlet };
        }
        if (field.min !== undefined) {
            input = document.createElement('input');
            input.className = 'text_pole';
            input.type = 'number';
            input.min = String(field.min);
            input.max = String(field.key === 'scanDepth' ? maxScanDepth : Number.MAX_SAFE_INTEGER);
            input.step = '1';
            input.value = String(field.min);
            input.setAttribute('aria-label', `${field.label} 값`);
            input.hidden = input.disabled = true;
            select.addEventListener('change', () => {
                input.hidden = input.disabled = select.value !== 'number';
            });
            group.append(input);
        }
        label.append(text, group);
        fieldsContainer.append(label);
        return { field, select, input, positionInputs };
    });
    const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '적용',
        cancelButton: '취소',
        onClosing: popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            for (const { select, input, positionInputs } of controls) {
                if (positionInputs && !positionInputs.depth.disabled && !positionInputs.depth.reportValidity()) return false;
                if (select.value !== 'number') continue;
                input.required = true;
                if (!input.reportValidity()) return false;
            }
            return true;
        },
    }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    const changes = {};
    for (const { field, select, input, positionInputs } of controls) {
        if (select.value === '') continue;
        changes[field.key] = select.value === 'number' ? Number(input.value)
            : ['strategy', 'position'].includes(field.key) ? select.value : JSON.parse(select.value);
        if (positionInputs) {
            const { depth, outlet } = positionInputs;
            if (!depth.disabled && depth.value !== '') changes.depth = Number(depth.value);
            if (!outlet.disabled && outlet.value.trim() !== '') changes.outletName = outlet.value.trim();
        }
    }
    return changes;
}

export function applyLoreEntrySettings(data, entry, changes, setOriginalDataValue) {
    if (!entry) return;
    if (Object.hasOwn(changes, 'strategy')) setLoreEntryStrategy(data, entry, changes.strategy, setOriginalDataValue);
    if (Object.hasOwn(changes, 'position')) {
        const [position, role] = changes.position.split(':');
        setLoreEntryPosition(data, entry, Number(position), role === '' ? null : Number(role), setOriginalDataValue);
        if (Number(position) === 4 && Object.hasOwn(changes, 'depth')) {
            entry.depth = changes.depth;
            setOriginalDataValue(data, entry.uid, 'extensions.depth', entry.depth);
        }
        if (Number(position) === 7 && Object.hasOwn(changes, 'outletName')) {
            entry.outletName = changes.outletName;
            setOriginalDataValue(data, entry.uid, 'extensions.outlet_name', entry.outletName);
        }
    }
    for (const { key, path } of fields) {
        if (!path || !Object.hasOwn(changes, key)) continue;
        entry[key] = changes[key];
        setOriginalDataValue(data, entry.uid, `extensions.${path}`, entry[key]);
    }
}
