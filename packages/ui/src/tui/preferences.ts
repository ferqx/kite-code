export type TuiLanguage = 'system' | 'zh-CN' | 'en-US';
export type TuiColorPreset = 'teal' | 'blue' | 'purple' | 'cyan' | 'mono';
export interface TuiPreferences {
  readonly revision: string;
  readonly language: TuiLanguage;
  readonly resolvedLanguage: 'zh-CN' | 'en-US';
  readonly colorPreset: TuiColorPreset;
  readonly theme: 'dark' | 'light';
}
export type TuiPreferenceEdit = { expectedRevision: string } & (
  | { key: 'language'; value: TuiLanguage }
  | { key: 'colorPreset'; value: TuiColorPreset }
);
export interface TuiPreferencePort {
  read(): Promise<TuiPreferences>;
  save(edit: TuiPreferenceEdit): Promise<TuiPreferences>;
}
export const defaultTuiPreferences: TuiPreferences = Object.freeze({
  revision: '',
  language: 'system',
  resolvedLanguage: 'en-US',
  colorPreset: 'teal',
  theme: 'dark',
});
export function verifyTuiPreferences(value: TuiPreferences): TuiPreferences {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'colorPreset,language,resolvedLanguage,revision,theme' ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    !['system', 'zh-CN', 'en-US'].includes(value.language) ||
    !['zh-CN', 'en-US'].includes(value.resolvedLanguage) ||
    (value.language !== 'system' && value.resolvedLanguage !== value.language) ||
    !['teal', 'blue', 'purple', 'cyan', 'mono'].includes(value.colorPreset) ||
    !['dark', 'light'].includes(value.theme)
  )
    throw new Error('tui_preferences_invalid');
  return Object.freeze({ ...value });
}
