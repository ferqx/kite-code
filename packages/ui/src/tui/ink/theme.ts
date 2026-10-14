export interface Theme {
  primary: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  muted: string;
  dim: string;
  bg: string;
  userMsgBg: string;
  risk: Record<string, string>;
  /** diff 新增行背景色 / diff addition background */
  diffAddedBg: string;
  /** diff 新增行文字色 / diff addition foreground */
  diffAddedFg: string;
  /** diff 删除行背景色 / diff removal background */
  diffRemovedBg: string;
  /** diff 删除行文字色 / diff removal foreground */
  diffRemovedFg: string;
}

export type ThemePreset = 'teal' | 'blue' | 'purple' | 'cyan' | 'mono';

export const THEME_PRESET_NAMES: ThemePreset[] = ['teal', 'blue', 'purple', 'cyan', 'mono'];

const presetRGB: Record<ThemePreset, Record<string, string>> = {
  teal: {
    primary: '#4EC9B0', // VS Code type teal
    accent: '#C586C0', // secondary categorical accent
    success: '#6A9955', // comment green
    error: '#E03A3A',
    warning: '#CCA700',
    muted: '#D4D4D4', // VS Code foreground
    dim: '#6A6A6A',
    userMsgBg: '#252526', // VS Code sidebar bg
    diffAddedBg: '#062E12',
    diffAddedFg: '#86EFAC',
    diffRemovedBg: '#3E0A10',
    diffRemovedFg: '#FCA5A5',
  },
  blue: {
    primary: '#569CD6', // VS Code keyword blue
    accent: '#C586C0',
    success: '#6A9955',
    error: '#E03A3A',
    warning: '#CCA700',
    muted: '#D4D4D4',
    dim: '#6A6A6A',
    userMsgBg: '#252526',
    diffAddedBg: '#062E12',
    diffAddedFg: '#86EFAC',
    diffRemovedBg: '#3E0A10',
    diffRemovedFg: '#FCA5A5',
  },
  purple: {
    primary: '#C586C0', // VS Code-ish purple
    accent: '#4EC9B0',
    success: '#6A9955',
    error: '#E03A3A',
    warning: '#CCA700',
    muted: '#D4D4D4',
    dim: '#6A6A6A',
    userMsgBg: '#252526',
    diffAddedBg: '#062E12',
    diffAddedFg: '#86EFAC',
    diffRemovedBg: '#3E0A10',
    diffRemovedFg: '#FCA5A5',
  },
  cyan: {
    primary: '#11A8CD', // VS Code terminal cyan
    accent: '#D16D9E',
    success: '#6A9955',
    error: '#E03A3A',
    warning: '#CCA700',
    muted: '#D4D4D4',
    dim: '#6A6A6A',
    userMsgBg: '#252526',
    diffAddedBg: '#062E12',
    diffAddedFg: '#86EFAC',
    diffRemovedBg: '#3E0A10',
    diffRemovedFg: '#FCA5A5',
  },
  mono: {
    primary: '#E0E0E0',
    accent: '#C0C0C0',
    success: '#A0A0A0',
    error: '#D01C1C',
    warning: '#CCA700',
    muted: '#A0A0A0',
    dim: '#6B6B6B',
    userMsgBg: '#2A2A2A',
    diffAddedBg: '#062A10',
    diffAddedFg: '#A0A0A0',
    diffRemovedBg: '#38090D',
    diffRemovedFg: '#CCCCCC',
  },
};

export const lightTheme: Theme = {
  primary: '#007ACC', // VS Code blue
  accent: '#A315E0',
  success: '#388A34',
  error: '#D01C1C',
  warning: '#AD8A00',
  muted: '#6B6B6B',
  dim: '#A0A0A0',
  bg: '#FFFFFF',
  userMsgBg: '#F3F3F3',
  risk: {
    read: '#007ACC',
    plan: '#A315E0',
    write_file: '#AD8A00',
    execute_code: '#A31515',
    destructive: '#D01C1C',
    network: '#E87D00',
    vcs_mutation: '#A315E0',
    unknown: '#A0A0A0',
  },
  diffAddedBg: '#DDF4E1',
  diffAddedFg: '#1A5C2A',
  diffRemovedBg: '#FDE8E8',
  diffRemovedFg: '#8B1A1A',
};

export type InkTheme = Theme;

// Use the original RGB roles directly: Ink owns the rendered cells, without
// changing the terminal's shared ANSI palette for other applications.
const darkThemes = Object.fromEntries(
  THEME_PRESET_NAMES.map((preset) => {
    const colors = presetRGB[preset];
    const theme: Theme = {
      primary: colors.primary!,
      accent: colors.accent!,
      success: colors.success!,
      error: colors.error!,
      warning: colors.warning!,
      muted: colors.muted!,
      dim: colors.dim!,
      bg: '#000000',
      userMsgBg: colors.userMsgBg!,
      risk: {
        read: colors.primary!,
        plan: colors.muted!,
        write_file: colors.warning!,
        execute_code: colors.error!,
        destructive: colors.error!,
        network: colors.error!,
        vcs_mutation: colors.muted!,
        unknown: colors.muted!,
      },
      diffAddedBg: colors.diffAddedBg!,
      diffAddedFg: colors.diffAddedFg!,
      diffRemovedBg: colors.diffRemovedBg!,
      diffRemovedFg: colors.diffRemovedFg!,
    };
    return [preset, theme];
  }),
) as Record<ThemePreset, Theme>;

export function getInkTheme(base: 'dark' | 'light', preset: ThemePreset): Theme {
  return base === 'light' ? lightTheme : darkThemes[preset];
}
