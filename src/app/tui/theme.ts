import { createContext, useContext } from 'react';

export interface Theme {
  primary: string;
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

/** ANSI palette index for each theme role — OSC 4 reprogrammable slots */
export const PALETTE_INDEX: Record<keyof Theme, number | undefined> = {
  primary: 6, // ANSI cyan
  success: 2, // ANSI green
  error: 1, // ANSI red
  warning: 3, // ANSI yellow
  muted: 7, // ANSI white
  dim: undefined, // hex direct — no ANSI slot needed (constant across dark presets)
  bg: 0, // untouched (terminal background)
  userMsgBg: 8, // ANSI bright black → dark gray
  risk: undefined,
  diffAddedBg: 4, // ANSI blue → dark green (#1B4A2B)
  diffAddedFg: undefined,
  diffRemovedBg: 5, // ANSI magenta → dark red (#3D2020)
  diffRemovedFg: undefined,
};

/** RGB values for each preset — used for OSC 4 palette reprogramming
 *  VS Code Dark+ inspired palette */
const presetRGB: Record<ThemePreset, Record<string, string>> = {
  teal: {
    primary: '#4EC9B0', // VS Code type teal
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

/** Build OSC 4 sequence: reprogram terminal palette slots to preset colors */
export function osc4Apply(preset: ThemePreset): string {
  const colors = presetRGB[preset];
  let seq = '';
  for (const [role, hex] of Object.entries(colors)) {
    const idx = PALETTE_INDEX[role as keyof Theme];
    if (idx != null && hex) {
      // rgb:RR/GG/BB format — most widely supported across terminals
      const rrggbb = hex.slice(1);
      const r = rrggbb.slice(0, 2);
      const g = rrggbb.slice(2, 4);
      const b = rrggbb.slice(4, 6);
      seq += `\u001B]4;${idx};rgb:${r}/${g}/${b}\u0007`;
    }
  }
  return seq;
}

/** Map ANSI index to Ink color name */
function ansiName(idx: number): string {
  switch (idx) {
    case 0:
      return 'black';
    case 1:
      return 'red';
    case 2:
      return 'green';
    case 3:
      return 'yellow';
    case 4:
      return 'blue';
    case 5:
      return 'magenta';
    case 6:
      return 'cyan';
    case 7:
      return 'white';
    case 8:
      return 'gray';
    default:
      return 'white';
  }
}

function buildTheme(_p: ThemePreset): Theme {
  const colors = presetRGB[_p];
  const fg = (role: keyof Theme) => {
    const idx = PALETTE_INDEX[role];
    return idx != null ? ansiName(idx) : 'white';
  };
  return {
    primary: fg('primary'),
    success: fg('success'),
    error: fg('error'),
    warning: fg('warning'),
    muted: fg('muted'),
    dim: colors.dim!,
    bg: 'black',
    userMsgBg: 'gray',
    risk: {
      read: fg('primary'),
      plan: fg('dim'),
      write_file: fg('warning'),
      execute_code: fg('error'),
      destructive: fg('error'),
      network: fg('error'),
      vcs_mutation: fg('dim'),
      unknown: fg('dim'),
    },
    diffAddedBg: fg('diffAddedBg'),
    diffAddedFg: colors.diffAddedFg!,
    diffRemovedBg: fg('diffRemovedBg'),
    diffRemovedFg: colors.diffRemovedFg!,
  };
}

const darkPresets: Record<ThemePreset, Theme> = {
  teal: buildTheme('teal'),
  blue: buildTheme('blue'),
  purple: buildTheme('purple'),
  cyan: buildTheme('cyan'),
  mono: buildTheme('mono'),
};

export function getDarkTheme(preset: ThemePreset): Theme {
  return darkPresets[preset];
}

export const darkTheme = darkPresets.blue;

export const lightTheme: Theme = {
  primary: '#007ACC', // VS Code blue
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

export const ThemeContext = createContext<Theme>(darkTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
