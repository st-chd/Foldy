import { bindAction, createIconButton } from './folder-ui.js';

export const BUNDLE_KIND = 'foldy-bundle';
export const BUNDLE_VERSION = 1;
export const SUPPORTED_BUNDLE_VERSIONS = new Set([1]);
export const DEFAULT_MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

export function cloneJson(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Keep the old JSON clone behavior for non-cloneable host objects.
        }
    }
    return JSON.parse(JSON.stringify(value));
}

export function safeFilePart(value) {
    const part = String(value || 'current')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F\x7F]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'current';
    // Windows reserves these names even when an extension is appended.
    // Prefixing keeps the user-provided name recognizable while making it safe.
    return /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)
        ? `_${part}`
        : part;
}

export function bundleFilename(name) {
    return `${safeFilePart(name)}.json`;
}

export function backupFilename(name, now = new Date()) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    return bundleFilename(`${name}-backup-${stamp}`);
}

export function createFolderRenameTracker({ toaster = globalThis.toastr } = {}) {
    const renamed = [];
    return {
        options: { onFolderRenamed: value => renamed.push(value) },
        renamed,
        notify() {
            if (renamed.length) {
                toaster?.info?.(`\uC911\uBCF5\uB41C \uD3F4\uB354 \uC774\uB984 ${renamed.length}\uAC1C\uB97C \uC790\uB3D9\uC73C\uB85C \uBCC0\uACBD\uD588\uC2B5\uB2C8\uB2E4.`);
            }
        },
    };
}
export function isObjectRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function hasValue(value) {
    // Falsy values like 0 and false can be valid imported identifiers.
    return value !== undefined && value !== null && String(value) !== '';
}

export function validateBundleEnvelope(
    bundle,
    scope,
    {
        kind = BUNDLE_KIND,
        currentVersion = BUNDLE_VERSION,
        supportedVersions = SUPPORTED_BUNDLE_VERSIONS,
    } = {},
) {
    if (bundle?.kind !== kind || bundle?.scope !== scope) {
        return { ok: false, reason: 'scope' };
    }
    const version = Number(bundle.version ?? 1);
    if (!Number.isFinite(version)) {
        return { ok: false, reason: 'invalid-version' };
    }
    if (version > currentVersion) {
        return { ok: false, reason: 'future-version', version };
    }
    if (!supportedVersions.has(version)) {
        return { ok: false, reason: 'unsupported-version', version };
    }
    return { ok: true, version };
}

export function migrateBundle(bundle, { currentVersion = BUNDLE_VERSION } = {}) {
    const migrated = cloneJson(bundle);
    const version = Number(migrated.version ?? 1);
    if (version === currentVersion) {
        migrated.version = currentVersion;
        return migrated;
    }
    // No historical migrations are needed yet. Keep this explicit path so the
    // first bundle-version bump has a real function to extend and test.
    migrated.version = currentVersion;
    return migrated;
}

export function bundleEnvelope(scope) {
    return {
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        scope,
    };
}

export function importedLayoutSummary({
    currentLabel,
    sourceLabel = '\uBD88\uB7EC\uC628 \uD3F4\uB354\uC758 \uD56D\uBAA9',
    matchedLabel = '\uB9E4\uCE6D\uB41C \uD56D\uBAA9',
    failedLabel = '\uB9E4\uCE6D \uC2E4\uD328',
    ambiguousLabel = '\uC774\uB984 \uC911\uBCF5\uC73C\uB85C \uAC74\uB108\uB700',
    currentOnlyLabel,
    unplacedLabel = '\uD3F4\uB354\uC5D0 \uBC30\uCE58\uB418\uC9C0 \uC54A\uC744 \uD56D\uBAA9',
    currentCount,
    sourceCount,
    matchedSourceCount,
    matchedTargetCount,
    ambiguousCount = 0,
}) {
    const failedCount = Math.max(0, sourceCount - matchedSourceCount);
    const currentOnlyCount = Math.max(0, currentCount - sourceCount);
    const unplacedCount = Math.max(0, currentCount - matchedTargetCount);
    const rows = [
        `${currentLabel}: ${currentCount}\uAC1C`,
        `${sourceLabel}: ${sourceCount}\uAC1C`,
        `${matchedLabel}: ${matchedSourceCount}\uAC1C`,
    ];
    if (failedCount > 0) rows.push(`${failedLabel}: ${failedCount}\uAC1C`);
    if (ambiguousCount > 0) rows.push(`${ambiguousLabel}: ${ambiguousCount}\uAC1C`);
    if (currentOnlyCount > 0) rows.push(`${currentOnlyLabel}: ${currentOnlyCount}\uAC1C`);
    if (unplacedCount > 0) rows.push(`${unplacedLabel}: ${unplacedCount}\uAC1C`);
    return rows.join('\n');
}

export function nameKey(value) {
    return String(value || '').trim().toLocaleLowerCase();
}

export function uniqueNameMap(values, getName) {
    return uniqueNameIndex(values, getName).unique;
}

export function uniqueNameIndex(values, getName) {
    const buckets = new Map();
    values.forEach(value => {
        const key = nameKey(getName(value));
        if (!key) return;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(value);
    });
    return {
        unique: new Map([...buckets.entries()]
            .filter(([, matches]) => matches.length === 1)
            .map(([key, matches]) => [key, matches[0]])),
        ambiguous: new Set([...buckets.entries()]
            .filter(([, matches]) => matches.length > 1)
            .map(([key]) => key)),
    };
}

export function createBundleActions({
    Popup,
    POPUP_RESULT,
    POPUP_TYPE,
    debugLog,
    withErrorToast,
    ownerCollapsed,
    saveCollapsed,
    isLoreOriginalDataCompatible,
    maxBundleBytes = DEFAULT_MAX_BUNDLE_BYTES,
}) {
    async function downloadJson(value, filename) {
        const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });

        if (typeof globalThis.showSaveFilePicker === 'function') {
            try {
                const handle = await globalThis.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'JSON file',
                        accept: { 'application/json': ['.json'] },
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return true;
            } catch (error) {
                if (error?.name === 'AbortError') return false;
                debugLog('번들 파일 저장 실패', error);
                toastr.error('번들 파일을 저장하지 못했습니다. 원본 데이터는 변경하지 않았습니다.');
                return false;
            }
        }

        const url = URL.createObjectURL(blob);
        try {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
        } finally {
            setTimeout(() => URL.revokeObjectURL(url), 0);
        }

        return true;
    }

    async function readJsonFile() {
        return await new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            let settled = false;
            const settle = value => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            input.addEventListener('cancel', () => settle(null), { once: true });
            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                if (!file) {
                    settle(null);
                    return;
                }
                try {
                    if (Number.isFinite(maxBundleBytes) && file.size > maxBundleBytes) {
                        toastr.error(`번들 파일이 너무 큽니다. ${Math.ceil(maxBundleBytes / 1024 / 1024)}MB 이하의 JSON 파일을 선택해 주세요.`);
                        settle(null);
                        return;
                    }
                    settle(JSON.parse(await file.text()));
                } catch (error) {
                    debugLog('번들 파일 읽기 실패', error);
                    toastr.error('번들을 읽지 못했습니다.');
                    settle(null);
                }
            }, { once: true });
            input.click();
        });
    }

    function assertBundle(bundle, scope) {
        const result = validateBundleEnvelope(bundle, scope);
        if (result.ok) {
            return migrateBundle(bundle);
        }
        if (result.reason === 'scope') {
            toastr.error('이 번들은 현재 항목 유형과 맞지 않습니다.');
            return false;
        }
        if (result.reason === 'future-version') {
            toastr.error('이 번들은 더 최신 Foldy 버전에서 만들어졌습니다.');
            return false;
        }
        toastr.error('지원하지 않는 번들 버전입니다.');
        return null;
    }

    function assertLayoutBundleShape(bundle, label) {
        if (!isObjectRecord(bundle.layout)) {
            toastr.error(`${label} 번들에 폴더 구조가 없습니다.`);
            return false;
        }
        return true;
    }

    function optionalString(value) {
        return value === undefined || value === null || typeof value === 'string';
    }

    function optionalStringArray(value) {
        return value === undefined || value === null || (Array.isArray(value) && value.every(entry => typeof entry === 'string'));
    }

    function isPromptRecord(prompt) {
        return isObjectRecord(prompt)
            && hasValue(prompt.identifier)
            && optionalString(prompt.name)
            && optionalString(prompt.content);
    }

    function isLoreEntryRecord(entry) {
        return isObjectRecord(entry)
            && hasValue(entry.uid)
            && optionalStringArray(entry.key)
            && optionalStringArray(entry.keysecondary)
            && optionalString(entry.comment)
            && optionalString(entry.content);
    }

    function isRegexScriptRecord(script) {
        return isObjectRecord(script)
            && hasValue(script.id)
            && optionalString(script.scriptName)
            && optionalString(script.script);
    }

    function assertPromptBundleShape(bundle) {
            if (!assertLayoutBundleShape(bundle, '프롬프트')) return false;
        if (!Array.isArray(bundle.prompts) || !bundle.prompts.every(isPromptRecord)) {
            toastr.error('프롬프트 번들에 올바르지 않은 프롬프트 데이터가 있습니다.');
            return false;
        }
        if (!Array.isArray(bundle.promptOrder) || !bundle.promptOrder.every(entry => isObjectRecord(entry) && hasValue(entry.identifier))) {
            toastr.error('프롬프트 번들에 올바르지 않은 프롬프트 순서 데이터가 있습니다.');
            return false;
        }
        return true;
    }

    function assertLorebookBundleShape(bundle) {
        if (!assertLayoutBundleShape(bundle, '로어북')) return false;
        if (!isObjectRecord(bundle.data) || !isObjectRecord(bundle.data.entries)) {
            toastr.error('로어북 번들에 로어북 데이터가 없습니다.');
            return false;
        }
        if (!Object.values(bundle.data.entries).every(isLoreEntryRecord)) {
            toastr.error('로어북 번들에 올바르지 않은 항목 데이터가 있습니다.');
            return false;
        }
        if (!isLoreOriginalDataCompatible(bundle.data)) return false;
        return true;
    }

    function assertRegexBundleShape(bundle) {
        if (!assertLayoutBundleShape(bundle, '정규식')) return false;
        if (!Array.isArray(bundle.scripts) || !bundle.scripts.every(isRegexScriptRecord)) {
            toastr.error('정규식 번들에 올바르지 않은 스크립트 데이터가 있습니다.');
            return false;
        }
        return true;
    }

    function createBundleButtons(onExport, onImport) {
        const importButton = createIconButton('fa-file-import', '번들 불러오기', 'bundle-button');
        const exportButton = createIconButton('fa-file-export', '번들 내보내기', 'bundle-button');
        bindAction(exportButton, '번들 내보내기', onExport, { withErrorToast });
        bindAction(importButton, '번들 불러오기', onImport, { withErrorToast });
        return [importButton, exportButton];
    }

    function createCollapseButtons(kind, owner, getLayout, onChange) {
        const expandAll = createIconButton('fa-folder-open', '모두 펼치기', 'expand-all');
        const collapseAll = createIconButton('fa-folder', '모두 접기', 'collapse-all');
        bindAction(collapseAll, '모두 접기', async () => {
            const layout = getLayout();
            const collapsed = ownerCollapsed(kind, owner);
            for (const folder of layout.folders) collapsed.add(folder.id);
            saveCollapsed(kind, owner, collapsed);
            await onChange();
        }, { withErrorToast });
        bindAction(expandAll, '모두 펼치기', async () => {
            const collapsed = ownerCollapsed(kind, owner);
            collapsed.clear();
            saveCollapsed(kind, owner, collapsed);
            await onChange();
        }, { withErrorToast });
        return [expandAll, collapseAll];
    }
    async function requestBundleExportMode(titleText, fullLabel, layoutLabel, hintText, inputName = 'foldy_export_mode') {
        const form = document.createElement('div');
        form.className = 'foldy-export-form';

        const title = document.createElement('div');
        title.className = 'foldy-edit-title';
        title.textContent = titleText;

        const full = document.createElement('label');
        full.className = 'checkbox flex-container';
        const fullInput = document.createElement('input');
        fullInput.type = 'radio';
        fullInput.name = inputName;
        fullInput.value = 'full';
        fullInput.checked = true;
        const fullText = document.createElement('span');
        fullText.textContent = fullLabel;
        full.append(fullInput, fullText);

        const layoutOnly = document.createElement('label');
        layoutOnly.className = 'checkbox flex-container';
        const layoutInput = document.createElement('input');
        layoutInput.type = 'radio';
        layoutInput.name = inputName;
        layoutInput.value = 'layout';
        const layoutText = document.createElement('span');
        layoutText.textContent = layoutLabel;
        layoutOnly.append(layoutInput, layoutText);

        const hint = document.createElement('div');
        hint.className = 'foldy-export-hint';
        hint.textContent = hintText;

        form.append(title, full, layoutOnly, hint);
        const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
            okButton: '내보내기',
            cancelButton: '취소',
        }).show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
        return form.querySelector(`input[name="${inputName}"]:checked`)?.value || 'full';
    }

    return {
        downloadJson,
        readJsonFile,
        assertBundle,
        assertPromptBundleShape,
        assertLorebookBundleShape,
        assertRegexBundleShape,
        createBundleButtons,
        createCollapseButtons,
        requestBundleExportMode,
    };
}
