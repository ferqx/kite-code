import { platform, release, type } from "node:os";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentEvidence, AgentMode, AgentPlan, AgentProgressLedger } from "./types";

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
  mode?: AgentMode;
  plan?: AgentPlan | null;
  contextSummary?: string;
  evidence?: AgentEvidence;
  progress?: AgentProgressLedger;
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
  const plan = input.plan ?? null;
  const mode = input.mode ?? "builder";
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

  if (plan) {
    lines.push(`Plan name: ${plan.name}`);
    lines.push(`Plan description: ${plan.description}`);
    lines.push(`Plan status: ${plan.status}`);
    lines.push(
      `Plan steps: ${plan.steps.map((step) => `${step.status}:${step.step}`).join(" | ")}`,
    );
  }

  if (input.contextSummary?.trim()) {
    lines.push("Context summary:");
    lines.push(input.contextSummary.trim());
  }

  if (input.evidence) {
    if (input.evidence.commands.length) {
      lines.push(`Evidence commands: ${input.evidence.commands.join(" | ")}`);
    }
    if (input.evidence.files.length) {
      lines.push(`Evidence files: ${input.evidence.files.join(" | ")}`);
    }
    if (input.evidence.verification.length) {
      lines.push(`Evidence verification: ${input.evidence.verification.join(" | ")}`);
    }
  }

  appendProgressHeartbeat(lines, input.progress);

  return lines.join("\n");
}

export function buildCacheableRuntimeContext(input: RuntimeContextInput): string {
  const mode = input.mode ?? "builder";
  const lines = [
    "Cacheable runtime context:",
    `Workspace: ${input.workspace}`,
    `User ID: ${input.userId}`,
    ...(input.modelName ? [`Configured model: ${input.modelName}`] : []),
    `Thread mode: ${mode}`,
    `Plan state: ${input.plan ? "active" : "inactive"}`,
    `Tool policy: ${toolPolicy(mode)}`,
  ];

  if (input.plan) {
    lines.push(`Plan name: ${input.plan.name}`);
    lines.push(`Plan description: ${input.plan.description}`);
    lines.push(`Plan status: ${input.plan.status}`);
    lines.push(
      `Plan steps: ${input.plan.steps.map((step) => `${step.status}:${step.step}`).join(" | ")}`,
    );
  }

  if (input.contextSummary?.trim()) {
    lines.push("Context summary:");
    lines.push(input.contextSummary.trim());
  }

  appendProgressHeartbeat(lines, input.progress);

  return lines.join("\n");
}

function appendProgressHeartbeat(lines: string[], progress?: AgentProgressLedger): void {
  const heartbeat = progress?.heartbeat;
  if (!heartbeat) {
    return;
  }

  lines.push("Progress heartbeat:");
  if (heartbeat.goal) {
    lines.push(`Goal: ${heartbeat.goal}`);
  }
  if (heartbeat.findings.length) {
    lines.push(`Findings: ${heartbeat.findings.join(" | ")}`);
  }
  if (heartbeat.nextAction) {
    lines.push(`Next action: ${heartbeat.nextAction}`);
  }
  if (heartbeat.blockers.length) {
    lines.push(`Blockers: ${heartbeat.blockers.join(" | ")}`);
  }
  if (heartbeat.verification.length) {
    lines.push(`Verification: ${heartbeat.verification.join(" | ")}`);
  }
}

function toolPolicy(mode: AgentMode): string {
  if (mode === "plan") {
    return "read-only planning; may read files/search/list/git inspect through shell_read and update_plan; must not write, delete, run tests, install dependencies, execute project code, or mutate workspace";
  }
  return "execute mode; write/delete/execute tools require approval before running";
}
