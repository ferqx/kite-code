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

  const remember = tool(
    async ({ namespace, key, value }) =>
      JSON.stringify({
        ok: true,
        namespace,
        key,
        value,
      }),
    {
      name: "remember",
      description:
        "Store a long-term memory when the user explicitly asks you to remember something for future conversations.",
      schema: z.object({
        namespace: z.string().default("task").describe("Memory namespace."),
        key: z.string().describe("Short stable key for the memory."),
        value: z.string().describe("Memory value to store."),
      }),
    },
  );

  return [shellExecute, applyPatch, remember];
}
