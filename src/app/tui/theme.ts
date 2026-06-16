import { createContext, useContext } from "react";

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
}

export type ThemePreset = "teal" | "blue" | "purple" | "cyan" | "mono";

export const THEME_PRESET_NAMES: ThemePreset[] = ["teal", "blue", "purple", "cyan", "mono"];

const darkPresets: Record<ThemePreset, Theme> = {
  teal: {
    primary: "#4EC9B0",
    success: "#6A9955",
    error: "#F44747",
    warning: "#CCA700",
    muted: "#CCCCCC",
    dim: "#808080",
    bg: "#1E1E1E",
    userMsgBg: "#333333",
    risk: {
      read: "#4EC9B0",
      plan: "#C586C0",
      write_file: "#CCA700",
      execute_code: "#CE9178",
      destructive: "#F44747",
      network: "#CE9178",
      vcs_mutation: "#C586C0",
      unknown: "#808080",
    },
  },
  blue: {
    primary: "#4FC1FF",
    success: "#6A9955",
    error: "#F44747",
    warning: "#CCA700",
    muted: "#CCCCCC",
    dim: "#808080",
    bg: "#1E1E1E",
    userMsgBg: "#333333",
    risk: {
      read: "#4FC1FF",
      plan: "#C586C0",
      write_file: "#CCA700",
      execute_code: "#CE9178",
      destructive: "#F44747",
      network: "#CE9178",
      vcs_mutation: "#C586C0",
      unknown: "#808080",
    },
  },
  purple: {
    primary: "#B392F0",
    success: "#6A9955",
    error: "#F44747",
    warning: "#CCA700",
    muted: "#CCCCCC",
    dim: "#808080",
    bg: "#1E1E1E",
    userMsgBg: "#333333",
    risk: {
      read: "#B392F0",
      plan: "#C586C0",
      write_file: "#CCA700",
      execute_code: "#CE9178",
      destructive: "#F44747",
      network: "#CE9178",
      vcs_mutation: "#C586C0",
      unknown: "#808080",
    },
  },
  cyan: {
    primary: "#00BCD4",
    success: "#6A9955",
    error: "#F44747",
    warning: "#CCA700",
    muted: "#CCCCCC",
    dim: "#808080",
    bg: "#1E1E1E",
    userMsgBg: "#333333",
    risk: {
      read: "#00BCD4",
      plan: "#C586C0",
      write_file: "#CCA700",
      execute_code: "#CE9178",
      destructive: "#F44747",
      network: "#CE9178",
      vcs_mutation: "#C586C0",
      unknown: "#808080",
    },
  },
  mono: {
    primary: "#E0E0E0",
    success: "#A0A0A0",
    error: "#F44747",
    warning: "#CCA700",
    muted: "#A0A0A0",
    dim: "#6B6B6B",
    bg: "#1E1E1E",
    userMsgBg: "#2A2A2A",
    risk: {
      read: "#E0E0E0",
      plan: "#CCCCCC",
      write_file: "#A0A0A0",
      execute_code: "#808080",
      destructive: "#F44747",
      network: "#808080",
      vcs_mutation: "#CCCCCC",
      unknown: "#6B6B6B",
    },
  },
};

export function getDarkTheme(preset: ThemePreset): Theme {
  return darkPresets[preset];
}

export const darkTheme = darkPresets.blue;

export const lightTheme: Theme = {
  primary: "#007ACC",
  success: "#388A34",
  error: "#D01C1C",
  warning: "#AD8A00",
  muted: "#6B6B6B",
  dim: "#A0A0A0",
  bg: "#FFFFFF",
  userMsgBg: "#F3F3F3",
  risk: {
    read: "#007ACC",
    plan: "#A315E0",
    write_file: "#AD8A00",
    execute_code: "#A31515",
    destructive: "#D01C1C",
    network: "#E87D00",
    vcs_mutation: "#A315E0",
    unknown: "#A0A0A0",
  },
};

export const ThemeContext = createContext<Theme>(darkTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
