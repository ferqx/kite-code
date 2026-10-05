import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigurationError,
  type JsonObject,
  readConfigurationFile,
  updateConfigurationFile,
} from '@kite-ai/agent/config';
import { assertProfileAccess, type ProfileAccess } from '@kite-ai/agent/profile-access';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import type { TuiPreferenceEdit, TuiPreferences } from '@kite-ai/ui/tui';

export class TuiPreferenceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Explicit host locale discovery; importing this module never starts a process. */
export function detectTuiDeviceLocale(): string {
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
        maxBuffer: 8192,
      });
      const language = /"([^"\r\n]+)"/.exec(output)?.[1];
      if (language) return language;
    } catch {
      // A device without AppleLanguages still has an Intl locale.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().locale;
}
function locale(value: string): 'zh-CN' | 'en-US' {
  try {
    return new Intl.Locale(value).language === 'zh' ? 'zh-CN' : 'en-US';
  } catch {
    return 'en-US';
  }
}
function preferences(value: JsonObject, revision: string, device: string): TuiPreferences {
  const language = value.language === undefined ? 'system' : value.language,
    colorPreset = value.colorPreset === undefined ? 'teal' : value.colorPreset,
    theme = value.theme === undefined ? 'dark' : value.theme;
  if (
    !['system', 'zh-CN', 'en-US'].includes(String(language)) ||
    !['teal', 'blue', 'purple', 'cyan', 'mono'].includes(String(colorPreset)) ||
    !['dark', 'light'].includes(String(theme)) ||
    typeof language !== 'string' ||
    typeof colorPreset !== 'string' ||
    typeof theme !== 'string'
  )
    throw new TuiPreferenceError('tui_preferences_invalid');
  return Object.freeze({
    revision,
    language,
    colorPreset,
    theme,
    resolvedLanguage: language === 'system' ? locale(device) : language,
  }) as TuiPreferences;
}
function finite<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof TuiPreferenceError) throw error;
    const mapped: Record<string, string> = {
      configuration_conflict: 'tui_preferences_conflict',
      configuration_busy: 'tui_preferences_busy',
      configuration_publication_uncertain: 'tui_preferences_publication_uncertain',
      invalid_jsonc: 'tui_preferences_invalid',
    };
    throw new TuiPreferenceError(
      (error instanceof ConfigurationError && mapped[error.code]) || 'tui_preferences_unavailable',
    );
  }
}
function privatePath(path: string, directory: boolean, optional = false): boolean {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
      (process.getuid && stat.uid !== process.getuid()) ||
      realpathSync(path) !== path
    )
      throw new TuiPreferenceError('tui_preferences_unavailable');
    if (process.platform === 'win32') {
      const security = defaultWindowsPathSecurity()!;
      if (directory) security.verifyDirectory(path);
      else security.verifyFile(path);
    }
    return true;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The host holds profile access until close; UI receives neither paths nor arbitrary edits. */
export function openTuiPreferenceFile(input: { access: ProfileAccess; deviceLocale?: string }) {
  const access = input.access;
  const parent = join(access.profilePath, 'ui'),
    path = join(parent, 'preferences.jsonc'),
    device = input.deviceLocale ?? detectTuiDeviceLocale();
  let closed = false;
  const validate = () => {
    if (closed) throw new TuiPreferenceError('tui_preferences_unavailable');
    assertProfileAccess(access);
    privatePath(access.profilePath, true);
    privatePath(parent, true, true);
    privatePath(path, false, true);
  };
  const read = () => {
    validate();
    const document = readConfigurationFile({ path, windowsPathPolicy: 'private' });
    return preferences(document.value, document.etag, device);
  };
  return {
    read: () => finite(read),
    save: (edit: TuiPreferenceEdit) =>
      finite(() => {
        if (
          !edit ||
          Object.keys(edit).sort().join(',') !== 'expectedRevision,key,value' ||
          !/^[a-f0-9]{64}$/.test(edit.expectedRevision) ||
          !(
            (edit.key === 'language' && ['system', 'zh-CN', 'en-US'].includes(edit.value)) ||
            (edit.key === 'colorPreset' &&
              ['teal', 'blue', 'purple', 'cyan', 'mono'].includes(edit.value))
          )
        )
          throw new TuiPreferenceError('tui_preferences_invalid');
        read(); // Invalid existing preferences must never be silently repaired by a selection.
        privateDirectory(parent);
        validate();
        const document = updateConfigurationFile({
          path,
          windowsPathPolicy: 'private',
          ifMatch: edit.expectedRevision,
          operations: [{ kind: 'set', path: [edit.key], value: edit.value }],
          validateCandidate: (value) => {
            preferences(value, edit.expectedRevision, device);
          },
          validatePublication: validate,
        });
        return preferences(document.value, document.etag, device);
      }),
    close() {
      closed = true;
    },
  };
}
