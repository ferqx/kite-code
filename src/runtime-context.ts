import { platform, release, type } from "node:os";
import type { BaseMessage } from "@langchain/core/messages";
import { deriveModeFromMessages, derivePlanFromMessages } from "./plan-state";

export interface RuntimeSystemInfo {
  currentTimeIso: string;
  timezone: string;
  os: string;
  platform: string;
  release: string;
  shell: string;
  cwd: string;
  workspace: string;
}

export interface RuntimeContextInput {
  userId: string;
  workspace: string;
  modelName?: string;
  messages: BaseMessage[];
  now?: Date;
  timezone?: string;
}

export function getRuntimeSystemInfo(input: {
  workspace: string;
  now?: Date;
  timezone?: string;
}): RuntimeSystemInfo {
  const now = input.now ?? new Date();
  return {
    currentTimeIso: now.toISOString(),
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    os: type(),
    platform: platform(),
    release: release(),
    shell: process.env.SHELL || process.env.ComSpec || "powershell",
    cwd: process.cwd(),
    workspace: input.workspace,
  };
}

export function buildRuntimeContext(input: RuntimeContextInput): string {
  const info = getRuntimeSystemInfo(input);
  const mode = deriveModeFromMessages(input.messages);
  const plan = derivePlanFromMessages(input.messages);
  const lines = [
    "Dynamic runtime context:",
    `Time: ${info.currentTimeIso}`,
    `Timezone: ${info.timezone}`,
    `OS: ${info.os} ${info.release} (${info.platform})`,
    `Shell: ${info.shell}`,
    `CWD: ${info.cwd}`,
    `Workspace: ${info.workspace}`,
    `User ID: ${input.userId}`,
    ...(input.modelName ? [`Configured model: ${input.modelName}`] : []),
    `Thread mode: ${mode}`,
    `Plan state: ${plan ? "active" : "inactive"}`,
    `Tool policy: ${toolPolicy(mode)}`,
  ];

  if (plan?.items.length) {
    lines.push(
      `Plan items: ${plan.items
        .map((item) => `${item.status}:${item.step}`)
        .join(" | ")}`,
    );
  }

  return lines.join("\n");
}

function toolPolicy(mode: "plan" | "builder"): string {
  if (mode === "plan") {
    return "read-only planning; may read files/search/list/git inspect through shell_read and update_plan; must not write, delete, run tests, install dependencies, execute project code, or mutate workspace";
  }
  return "execute mode; write/delete/execute tools require approval before running";
}
