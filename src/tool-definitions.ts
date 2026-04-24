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

  return [shellExecute, applyPatch, createUpdatePlanTool()];
}

export function createPlanAgentTools(input: CreateCodeAgentToolsInput) {
  const shellRead = tool(
    async ({ command }) => {
      if (!isPlanReadOnlyShellCommand(command)) {
        return JSON.stringify({
          ok: false,
          command,
          exitCode: -1,
          stdout: "",
          stderr: "Rejected: plan mode allows read-only shell commands only.",
        });
      }

      return JSON.stringify(
        await (input.shellExecutor ?? shellTool)({
          workspace: input.workspace,
          command,
        }),
      );
    },
    {
      name: "shell_read",
      description:
        "Read-only shell command for plan mode. Use it only to inspect files, list directories, search text, and read git status/diff/log/show. It must not write, delete, run tests, install dependencies, or execute project code.",
      schema: z.object({
        command: z.string().describe("Read-only shell command to execute in the workspace"),
      }),
    },
  );

  return [shellRead, createUpdatePlanTool()];
}

function createUpdatePlanTool() {
  return tool(
    async ({ name, description, status, steps }) =>
      JSON.stringify({
        ok: true,
        plan: {
          name,
          description,
          status,
          steps,
        },
      }),
    {
      name: "update_plan",
      description:
        "Update the current plan state. In plan mode use it to create or revise a concise implementation plan; it must not edit files, run commands, install dependencies, or mutate the workspace.",
      schema: z.object({
        name: z.string().describe("Short plan name"),
        description: z.string().describe("Short plan description"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .describe("Current status for the plan"),
        steps: z
          .array(
            z.object({
              step: z.string().describe("Plan step"),
              status: z
                .enum(["pending", "in_progress", "completed"])
                .describe("Current status for this step"),
            }),
          )
          .describe("Ordered plan steps"),
      }),
    },
  );
}

const PLAN_READ_ONLY_COMMANDS = new Set([
  "awk",
  "cat",
  "du",
  "file",
  "find",
  "gc",
  "gci",
  "get-childitem",
  "get-content",
  "get-location",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "rg",
  "select-object",
  "select-string",
  "sed",
  "sls",
  "stat",
  "tail",
  "test",
  "type",
  "wc",
]);

const PLAN_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "show",
  "status",
]);

export function isPlanReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /(^|[^>])>{1,2}($|[^>])/.test(trimmed)) {
    return false;
  }

  return splitShellSegments(trimmed).every(isPlanReadOnlySegment);
}

function splitShellSegments(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|[|;])\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isPlanReadOnlySegment(segment: string): boolean {
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const command = stripQuotes(tokens[0] ?? "").toLowerCase();
  if (!command) {
    return false;
  }

  if (command === "git") {
    return PLAN_READ_ONLY_GIT_SUBCOMMANDS.has(stripQuotes(tokens[1] ?? "").toLowerCase());
  }

  if (command === "sed") {
    return (
      PLAN_READ_ONLY_COMMANDS.has(command) &&
      !tokens.some((token) => /^-.*i/.test(stripQuotes(token)))
    );
  }

  if (command === "find") {
    return (
      PLAN_READ_ONLY_COMMANDS.has(command) &&
      !tokens.some((token) => ["-exec", "-execdir", "-delete"].includes(stripQuotes(token)))
    );
  }

  if (command === "awk") {
    return PLAN_READ_ONLY_COMMANDS.has(command) && !/\bsystem\s*\(/.test(segment);
  }

  return PLAN_READ_ONLY_COMMANDS.has(command);
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
