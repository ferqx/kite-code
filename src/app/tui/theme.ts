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
  primary: "#6C8AFF",
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
