import { platform as osPlatformFn, type as osTypeFn, release } from 'node:os';
import type { BaseMessage } from '@/core/messages';
import type { SandboxBackend } from '@/core/sandbox/platform';
import type {
  AgentPhase,
  AuthorizationMode,
  InteractionMode,
  PlanningState,
} from '@/protocol/events';

/** 将 Windows 路径转为 MSYS2/POSIX 格式（D:\app → /d/app），避免反斜杠在 bash 中被当作转义符吃掉 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

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

/** 运行时上下文输入参数（内部，轻量使用）/ Runtime context input parameters (internal, lightweight usage) */
export interface RuntimeContextInput {
  workspace: string;
  messages: BaseMessage[];
  workspaceAccess?: 'write';
  now?: Date;
  timezone?: string;
}

/** 动态模式快照输入。该数据随轮次变化，不能进入 cacheable runtime context。 */
export interface RuntimeModeSnapshotInput {
  phase: AgentPhase;
  interactionMode: InteractionMode;
  authorizationMode: AuthorizationMode;
  sandboxBackend: SandboxBackend | 'unknown';
  /** v2: PlanningState for dynamic runtime-state block */
  planningState?: PlanningState;
  taskId?: string;
  sideEffectsStarted?: boolean;
}

/** 可缓存运行时上下文输入 — 仅包含 session 稳定的字段 / Cacheable runtime context input — only session-stable fields */
export interface CacheableRuntimeContextInput {
  /** 工作目录 / Workspace path (stable within a session) */
  workspace: string;
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
    os: osTypeFn(),
    platform: osPlatformFn(),
    release: release(),
    shell: process.env.SHELL || 'bash',
    cwd: process.cwd(),
    workspace: input.workspace,
  };
}

/** 构建动态运行时上下文（含时间戳，不适合缓存）/ Build dynamic runtime context (includes timestamps, not cacheable) */
export function buildRuntimeContext(input: RuntimeContextInput): string {
  const info = getRuntimeSystemInfo(input);
  const lines = [
    'Dynamic runtime context:',
    `Time: ${info.currentTimeIso}`,
    `Timezone: ${info.timezone}`,
    `OS: ${info.os} ${info.release} (${info.platform})`,
    `Shell: ${info.shell}`,
    `CWD: ${info.cwd}`,
    `Workspace: ${info.workspace}`,
  ];

  return lines.join('\n');
}

/** 构建当前 agent 模式快照。此消息必须作为动态 runtime state 注入，不能进入缓存前缀。
 *  v2: 使用 source="runtime.kernel"，动态注入 planningState block。 */
export function buildRuntimeModeSnapshot(input: RuntimeModeSnapshotInput): string {
  const lines = [
    '<runtime-state source="runtime.kernel">',
    `phase: ${input.phase}`,
    `interaction_mode: ${input.interactionMode}`,
    `authorization_mode: ${input.authorizationMode}`,
    `sandbox_backend: ${input.sandboxBackend}`,
    ...(input.taskId ? [`task_id: ${input.taskId}`] : []),
    ...(input.sideEffectsStarted != null
      ? [`side_effects_started: ${input.sideEffectsStarted}`]
      : []),
  ];

  // dynamic plan state block from PlanningState
  if (input.planningState) {
    const ps = input.planningState;
    lines.push('');
    lines.push('plan:');
    lines.push(`  lifecycle: ${ps.kind}`);
    if (
      ps.kind === 'planning_draft' ||
      ps.kind === 'replanning_draft' ||
      ps.kind === 'awaiting_review' ||
      ps.kind === 'executing' ||
      ps.kind === 'completed'
    ) {
      lines.push(`  plan_id: ${ps.document.planId}`);
      lines.push(`  version: ${ps.document.version}`);
      lines.push(`  structural_digest: sha256:${ps.document.structuralDigest.slice(0, 16)}...`);
    }
    if ((ps.kind === 'planning_draft' || ps.kind === 'replanning_draft') && ps.revisionFeedback) {
      lines.push(`  revision_feedback: "${ps.revisionFeedback}"`);
    }
    if (ps.kind === 'executing') {
      lines.push('  steps:');
      for (const step of ps.document.steps) {
        lines.push(`    - ${step.id}: ${step.status}`);
      }
    }
    lines.push('');
    lines.push('policy:');
    const canEnterPlanning = input.sideEffectsStarted !== true;
    const canWriteDraft =
      canEnterPlanning &&
      (ps.kind === 'building_without_plan' ||
        ps.kind === 'planning_empty' ||
        ps.kind === 'planning_draft' ||
        ps.kind === 'replanning_draft');
    lines.push(`  write_plan_allowed: ${canWriteDraft || ps.kind === 'executing'}`);
    lines.push(`  write_plan_submit_allowed: ${canWriteDraft || ps.kind === 'executing'}`);
    lines.push(`  replan_allowed: ${ps.kind === 'executing'}`);
    lines.push(`  update_plan_allowed: ${ps.kind === 'executing'}`);
  }

  if (input.phase === 'planning') {
    lines.push(
      'Planning phase policy: read/search/research, ask_user, read_plan, and write_plan are allowed; workspace mutation, code execution, full access escalation, and side-effectful MCP/sub-agent work are not allowed until plan approval moves the phase to building. An initial write_plan(action="save") may enter planning only before side effects begin, followed by submit of the saved Artifact.',
    );
  } else {
    lines.push(
      'Building phase policy: execute the approved task under the current interaction mode and authorization; update_plan for progress tracking; write_plan(action="submit") may request a structural replan while an approved plan is executing; tool policy still enforces approval and sandbox boundaries.',
    );
  }
  lines.push('</runtime-state>');
  return lines.join('\n');
}

/**
 * 构建可缓存的运行时上下文（不含时间戳，适合 provider 前缀缓存）。
 *
 * **缓存契约**：此函数的输出在同一 session 内必须保持稳定。不得在此函数中
 * 注入任何逐请求变化的值（时间戳、token 计数、动态 skill 指令、上下文摘要等），
 * 否则会破坏 DeepSeek 等 provider 的前缀缓存命中机制。
 *
 * Build cacheable runtime context (no timestamps, cache-stable for provider prefix caching).
 *
 * **Cache contract**: The output of this function MUST remain stable within a session.
 * Do NOT inject any per-request variable values (timestamps, token counts, dynamic skill
 * instructions, context summaries, etc.) into this function, as it would break prefix cache
 * hit for providers like DeepSeek.
 */
export function buildCacheableRuntimeContext(input: CacheableRuntimeContextInput): string {
  const { workspace } = input;
  const osType = osTypeFn();
  const osPlatform = osPlatformFn();
  const shellPath = process.env.SHELL || 'bash';
  const posixWorkspace = toPosixPath(workspace);
  const lines = [
    'Cacheable runtime context:',
    `OS: ${osType} (${osPlatform})`,
    `Shell: ${shellPath}`,
    `Workspace: ${workspace}`,
  ];
  // 仅 Windows + bash 组合下追加 POSIX 路径提示，避免模型对 file 工具也用 MSYS2 路径
  // Only add POSIX path hint on Windows+bash, so the model doesn't use MSYS2 paths for file tools
  if (osPlatform === 'win32') {
    lines.push(
      `Note: for shell_execute commands, convert Windows paths to POSIX: replace backslashes with /, and change D:\\ to /d/. Example: ${workspace} → ${posixWorkspace}. File tools (read_file, edit_file, write_file) require paths relative to the workspace.`,
    );
  }
  return lines.join('\n');
}
