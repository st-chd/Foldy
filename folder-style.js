export const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
export const BORDER_WIDTHS = ['0', '1', '2', '3', '4'];
export const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'];

export function folderStyleValues(values = {}) {
    return {
        color: values.color,
        borderColor: values.borderColor,
        nameColor: values.nameColor,
        borderWidth: values.borderWidth,
        borderStyle: values.borderStyle,
        borderSides: values.borderSides,
    };
}

// 빈 값은 기본 테두리(1px 실선, 네 방향)다. 방향을 모두 끄면 'none'으로 저장한다.
export function folderBorder(folder = {}) {
    const width = BORDER_WIDTHS.includes(folder.borderWidth) ? folder.borderWidth : '';
    const style = BORDER_STYLES.includes(folder.borderStyle) ? folder.borderStyle : '';
    if (folder.borderSides === 'none') return { width, style, sides: [] };
    const requested = String(folder.borderSides || '').split(',');
    const sides = BORDER_SIDES.filter(side => requested.includes(side));
    return { width, style, sides: sides.length ? sides : [...BORDER_SIDES] };
}

export function borderSidesValue(sides) {
    const selected = BORDER_SIDES.filter(side => sides.includes(side));
    if (selected.length === BORDER_SIDES.length) return '';
    return selected.length ? selected.join(',') : 'none';
}
