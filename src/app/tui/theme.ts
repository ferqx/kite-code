import { createContext, useContext } from "react";

export interface Theme {
  primary: string;
  success: string;
  error: string;
  warning: string;
  muted: string;
  dim: string;
  bg: string;
  risk: Record<string, string>;
}

export const darkTheme: Theme = {
  primary: "#569CD6",
  success: "#4ADE80",
  error: "#F87171",
  warning: "#FBBF24",
  muted: "#9CA3AF",
  dim: "#6B7280",
  bg: "#1A1A2E",
  risk: {
    read: "#60A5FA",
    plan: "#818CF8",
    write_file: "#FBBF24",
    execute_code: "#F59E0B",
    destructive: "#EF4444",
    network: "#F97316",
    vcs_mutation: "#EC4899",
    unknown: "#9CA3AF",
  },
};

export const lightTheme: Theme = {
  primary: "#0451A5",
  success: "#16A34A",
  error: "#DC2626",
  warning: "#CA8A04",
  muted: "#6B7280",
  dim: "#9CA3AF",
  bg: "#FFFFFF",
  risk: {
    read: "#3B82F6",
    plan: "#6366F1",
    write_file: "#CA8A04",
    execute_code: "#D97706",
    destructive: "#DC2626",
    network: "#EA580C",
    vcs_mutation: "#DB2777",
    unknown: "#9CA3AF",
  },
};

export const ThemeContext = createContext<Theme>(darkTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
