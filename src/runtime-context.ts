import { platform, release, type } from "node:os";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentEvidence, AgentMode, AgentPlan, AgentProgressLedger } from "./types";

/** 运行时系统信息 / Runtime system information */
export interface RuntimeSystemInfo {
  /** 当前时间 ISO 格式 / Current time in ISO format */
  currentTimeIso: string;
  /** 时区 / Timezone */
  timezone: string;
  /** 操作系统类型 / OS type */
  os: string;
  /** 平台 / Platform */
  platform: string;
  /** 系统版本 / OS release version */
  release: string;
  /** 当前 Shell / Current shell */
  shell: string;
  /** 当前工作目录 / Current working directory */
  cwd: string;
  /** 工作区路径 / Workspace path */
  workspace: string;
}

/** 运行时上下文输入参数 / Runtime context input parameters */
export interface RuntimeContextInput {
  /** 用户 ID / User ID */
  userId: string;
  /** 工作目录 / Workspace path */
  workspace: string;
  /** 模型名称 / Model name */
  modelName?: string;
  /** 对话消息 / Conversation messages */
  messages: BaseMessage[];
  /** 运行模式 / Run mode */
  mode?: AgentMode;
  /** 执行计划 / Execution plan */
  plan?: AgentPlan | null;
  /** 上下文摘要 / Context summary */
  contextSummary?: string;
  /** 执行证据 / Execution evidence */
  evidence?: AgentEvidence;
  /** 进度跟踪 / Progress tracking */
  progress?: AgentProgressLedger;
  /** 可注入的当前时间 / Injectable current time */
  now?: Date;
  /** 可注入的时区 / Injectable timezone */
  timezone?: string;
}

/** 收集运行时系统信息 / Collect runtime system information */
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

/** 构建动态运行时上下文（含时间戳，不适合缓存）/ Build dynamic runtime context (includes timestamps, not cacheable) */
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
    // 将计划的每个步骤以 "状态:步骤描述" 格式列出 / List each plan step as "status:description"
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

  // 输出执行证据（命令、文件、验证记录）/ Output execution evidence (commands, files, verification)
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

/** 构建可缓存的运行时上下文（不含时间戳，适合 DeepSeek 前缀缓存）/ Build cacheable runtime context (no timestamps, cache-stable for DeepSeek prefix cache) */
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

/** 将进度心跳信息附加到上下文行列表 / Append progress heartbeat to context lines */
function appendProgressHeartbeat(lines: string[], progress?: AgentProgressLedger): void {
  // 仅当 progress 中有 heartbeat 时才输出 / Only output when progress has a heartbeat
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

/** 根据模式返回工具策略描述 / Return tool policy description based on mode */
function toolPolicy(mode: AgentMode): string {
  if (mode === "plan") {
    return "read-only planning; may read files/search/list/git inspect through shell_read and update_plan; must not write, delete, run tests, install dependencies, execute project code, or mutate workspace";
  }
  // builder 模式：写/删/执行工具需要审批 / builder mode: write/delete/execute tools require approval
  return "execute mode; write/delete/execute tools require approval before running";
}
