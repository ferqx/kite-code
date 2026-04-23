import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { applyPatchTool, shellTool, type ShellExecutor } from "./tools";

export interface CreateCodeAgentToolsInput {
  workspace: string;
  shellExecutor?: ShellExecutor;
}

export function createCodeAgentTools(input: CreateCodeAgentToolsInput) {
  const shellExecute = tool(
    async ({ command }) =>
      JSON.stringify(
        await shellTool({
          workspace: input.workspace,
          command,
        }),
      ),
    {
      name: "shell_execute",
      description:
        "Execute a platform shell command in the local workspace. Use this for reading, deleting, listing, testing, and running local commands. Commands are reviewed before execution.",
      schema: z.object({
        command: z.string().describe("Shell command to execute in the workspace"),
      }),
    },
  );

  const applyPatch = tool(
    async ({ path, content }) =>
      JSON.stringify(
        await applyPatchTool({
          workspace: input.workspace,
          path,
          content,
          shellExecutor: input.shellExecutor,
        }),
      ),
    {
      name: "apply_patch",
      description:
        "Write complete UTF-8 file content to a path inside the workspace. This is implemented on top of shell_execute and is reviewed before execution.",
      schema: z.object({
        path: z.string().describe("Workspace-relative file path to write"),
        content: z.string().describe("Complete file content to write"),
      }),
    },
  );

  return [shellExecute, applyPatch];
}
