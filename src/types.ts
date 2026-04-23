export interface ApplyPatchInput {
  workspace: string;
  path: string;
  content: string;
  shellExecutor?: (input: ShellInput) => Promise<ShellResult>;
}

export interface ApplyPatchResult {
  ok: boolean;
  path: string;
  message: string;
}

export interface ShellInput {
  workspace: string;
  command: string;
}

export interface ShellResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ToolRequest =
  | {
      type: "mode_change";
      targetMode: "plan" | "builder";
      reason: string;
    }
  | {
      type: "tool_call";
      id?: string;
      name: "apply_patch";
      args: {
        path: string;
        content: string;
      };
      reason: string;
      protectedCommand: string;
    }
  | {
      type: "tool_call";
      id?: string;
      name: "shell_execute";
      args: {
        command: string;
      };
      reason: string;
      protectedCommand: string;
    };

export interface AgentEvent {
  type: string;
  data: unknown;
}
