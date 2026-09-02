import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireConfigFileMutationLock,
  replaceConfigFileAtomically,
} from '@kite-ai/kite-local-runtime/config';
import { applyEdits, modify, parse } from 'jsonc-parser';

/**
 * Preferences owned by the terminal client.  These values are deliberately
 * independent from the Service's provider/configuration authority: a TUI can
 * change its language, theme, colour preset, and interaction-mode preference
 * without opening the Runtime Store or creating a second Host.
 */
export type LanguagePreference = 'system' | 'zh-CN' | 'en-US';
export type InteractionModePreference = 'accept_edits' | 'auto' | 'full';
export type ThemeName = 'dark' | 'light';

interface ClientPreferences {
  readonly language?: LanguagePreference;
  readonly interactionMode?: InteractionModePreference;
  readonly theme?: ThemeName;
  readonly colorPreset?: string;
}

function clientConfigPath(): string {
  // When supplied by the release/test composition KITE_CODE_HOME is the exact
  // Kite code root. The fallback remains an OS-home presentation preference;
  // neither path is a Service identity input in this CLI-only module.
  const root = process.env.KITE_CODE_HOME ?? join(homedir(), '.kite-code');
  return join(root, 'kite-code.jsonc');
}

function readPreferences(path = clientConfigPath()): ClientPreferences | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value: unknown = parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return {
      ...(record.language === 'system' || record.language === 'zh-CN' || record.language === 'en-US'
        ? { language: record.language }
        : {}),
      ...(record.interactionMode === 'accept_edits' ||
      record.interactionMode === 'auto' ||
      record.interactionMode === 'full'
        ? { interactionMode: record.interactionMode }
        : {}),
      ...(record.theme === 'dark' || record.theme === 'light' ? { theme: record.theme } : {}),
      ...(typeof record.colorPreset === 'string' && record.colorPreset.length <= 64
        ? { colorPreset: record.colorPreset }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function writePreference(key: keyof ClientPreferences, value: string): boolean {
  let lock: ReturnType<typeof acquireConfigFileMutationLock> | undefined;
  try {
    const path = clientConfigPath();
    lock = acquireConfigFileMutationLock(path);
    const source = existsSync(path) ? readFileSync(path, 'utf8') : '{}';
    const formattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' as const };
    const next = applyEdits(source, modify(source, [key], value, { formattingOptions }));
    replaceConfigFileAtomically(path, next, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    lock?.release();
  }
}

export function loadUserLanguage(): LanguagePreference {
  return readPreferences()?.language ?? 'system';
}

export function saveUserLanguage(language: LanguagePreference): boolean {
  return writePreference('language', language);
}

export function loadUserInteractionMode(): InteractionModePreference {
  return readPreferences()?.interactionMode ?? 'auto';
}

export function saveInteractionMode(mode: InteractionModePreference): boolean {
  return writePreference('interactionMode', mode);
}

export function loadTheme(workspace?: string): ThemeName {
  void workspace;
  return readPreferences()?.theme ?? 'dark';
}

export function loadColorPreset(workspace?: string): string {
  void workspace;
  return readPreferences()?.colorPreset ?? 'blue';
}

export function saveColorPreset(preset: string): boolean {
  return writePreference('colorPreset', preset);
}

export function sessionExportPath(timestamp: string): string {
  return join(dirname(clientConfigPath()), `session-${timestamp}.md`);
}

/** Stable presentation-only default used by CLI code when no service config is available. */
export function defaultClientCheckpointPath(): string {
  return join(dirname(clientConfigPath()), 'checkpoints.sqlite');
}
