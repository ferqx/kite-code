import { platform, release, type } from "node:os";
import type { ThreadMode } from "./graph";

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
  checkpointPath?: string;
  memoryPath?: string;
  modelName?: string;
  threadMode: ThreadMode;
  memories: string;
  verification: string;
  now?: Date;
  timezone?: string;
}

export function getRuntimeSystemInfo(input: {
  workspace: string;
  checkpointPath?: string;
  memoryPath?: string;
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
    `Thread mode: ${input.threadMode}`,
    `Tool policy: ${toolPolicy(input.threadMode)}`,
  ];

  if (input.verification) {
    lines.push(`Verification: ${input.verification}`);
  }
  if (input.memories) {
    lines.push(`Memory: ${input.memories}`);
  }

  return lines.join("\n");
}

function toolPolicy(mode: ThreadMode): string {
  if (mode === "plan") {
    return "read-only planning; do not edit, delete, execute tests, or mutate workspace";
  }
  return "execute mode; write/delete/execute tools require approval before running";
}
