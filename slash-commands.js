import { folderStyleValues, isColorValue, normalizeColor } from './folder-ui.js';

const TARGETS = ['prompts', 'lorebooks', 'regex-global', 'regex-preset', 'regex-scoped'];
const COLOR_ARGUMENTS = { background: 'color', border: 'borderColor', text: 'nameColor' };

function booleanArgument(value, name) {
    const text = String(value ?? 'false').trim().toLowerCase();
    if (['true', 'on', '1'].includes(text)) return true;
    if (['false', 'off', '0'].includes(text)) return false;
    throw new Error(`${name}에는 true 또는 false를 입력해 주세요.`);
}

// Validate the complete request before changing any stored folder.
export function layoutWithCommandColors(layout, args) {
    const all = booleanArgument(args.all, 'all');
    const reset = booleanArgument(args.reset, 'reset');
    const selector = String(args.folder ?? '').trim();
    const folders = layout?.folders || [];
    let source;
    if (selector) {
        source = folders.find(folder => folder.id === selector);
        if (!source) {
            const matches = folders.filter(folder => folder.name === selector);
            if (matches.length > 1) throw new Error('같은 이름의 폴더가 여러 개입니다. 폴더 ID를 사용해 주세요.');
            source = matches[0];
        }
        if (!source) throw new Error(`폴더를 찾을 수 없습니다: ${selector}`);
    } else if (!all) {
        throw new Error('folder에 폴더 이름이나 ID를 입력하거나 all=true를 지정해 주세요.');
    }

    const colors = {};
    for (const [argument, property] of Object.entries(COLOR_ARGUMENTS)) {
        if (args[argument] === undefined) continue;
        const value = String(args[argument]).trim();
        if (value && value.toLowerCase() !== 'default' && !isColorValue(value)) {
            throw new Error(`${argument}: 올바른 색상 또는 default를 입력해 주세요.`);
        }
        colors[property] = value.toLowerCase() === 'default' ? '' : normalizeColor(value);
    }
    if (reset && Object.keys(colors).length) {
        throw new Error('reset=true와 개별 색상은 함께 지정할 수 없습니다.');
    }
    if (!reset && !Object.keys(colors).length && !(all && source)) {
        throw new Error('색상, reset=true 또는 복사할 folder와 all=true를 지정해 주세요.');
    }
    if (!folders.length) throw new Error('선택한 목록에 폴더가 없습니다.');

    const style = reset ? { color: '', borderColor: '', nameColor: '' }
        : { ...(source ? folderStyleValues(source) : {}), ...colors };
    return {
        layout: {
            ...layout,
            folders: folders.map(folder => all || folder === source ? { ...folder, ...style } : folder),
        },
        count: all ? folders.length : 1,
    };
}

export function registerFoldySlashCommands({
    SlashCommandParser, SlashCommand, SlashCommandNamedArgument, ARGUMENT_TYPE,
    getContext, saveSettingsDebounced,
}) {
    const named = (name, description, options = {}) => SlashCommandNamedArgument.fromProps({
        name, description, typeList: [ARGUMENT_TYPE.STRING], ...options,
    });
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'foldy-color',
        callback: async args => {
            if (!TARGETS.includes(args.target)) throw new Error(`target은 ${TARGETS.join(', ')} 중 하나여야 합니다.`);
            const context = getContext(args.target);
            const result = layoutWithCommandColors(context.layout, args);
            context.save(result.layout);
            saveSettingsDebounced();
            await context.render();
            return String(result.count);
        },
        returns: '색상을 적용한 폴더 수',
        namedArgumentList: [
            named('target', '현재 선택된 프리셋·로어북·정규식 목록', { isRequired: true, enumList: TARGETS, forceEnum: true }),
            named('folder', '대상 폴더 이름 또는 ID. all=true일 때 색상을 복사할 기준 폴더'),
            named('background', '배경색: #hex, transparent, CSS 색상 또는 default'),
            named('border', '테두리색: #hex, transparent, CSS 색상 또는 default'),
            named('text', '이름 색상: #hex, transparent, CSS 색상 또는 default'),
            named('reset', '세 가지 색상을 모두 테마 기본값으로 복원', { typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),
            named('all', '현재 목록의 모든 폴더에 적용', { typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),
        ],
        helpString: `<div>Foldy 폴더 색상을 변경합니다. 일괄 적용은 현재 선택된 목록 안에서만 수행합니다.</div>
            <pre><code>/foldy-color target=prompts folder="내 폴더" reset=true</code></pre>
            <pre><code>/foldy-color target=prompts folder="내 폴더" all=true</code></pre>
            <pre><code>/foldy-color target=lorebooks all=true reset=true</code></pre>
            <pre><code>/foldy-color target=regex-global all=true background=#202020 border=default text=#ffffff</code></pre>
            <div>folder와 all=true를 함께 쓰면 기준 폴더의 세 가지 색상을 모두 복사합니다.
            folder 없이 all=true와 색상을 지정하면 지정한 색상만 변경합니다.
            reset=true와 개별 색상은 함께 사용할 수 없습니다. 결과는 적용한 폴더 수입니다.</div>`,
    }));
}
