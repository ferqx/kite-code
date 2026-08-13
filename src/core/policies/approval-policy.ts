import { isAbsolute, resolve } from 'node:path';
import { hasSameCommandGrant, normalizeAuthorizationState } from '@/core/harness/tool-policy';
import {
  checkDangerousCanonicalPathV1,
  checkDangerousPaths,
} from '@/core/policies/dangerous-paths';
import { isPathInsideWorkspace, msys2ToWindowsPath } from '@/core/tools/path-utils';
import type { AuthorizationOverride, ThreadAuthorizationState } from '@/core/types';
import type { CapabilityApproval, EffectProfile } from '@/protocol/capabilities';
import type { AgentPhase, ShellGrantUsed } from '@/protocol/events';
import type { ToolEffects, ToolRisk } from './shell-classification';
import {
  classifyShellEffects,
  classifyShellRisk,
  isDestructiveRmOnCriticalPaths,
  isDestructiveRmOnWorkspace,
  isDestructiveShellCommand,
  isNetworkCommand,
  isVcsMutationCommand,
  isWriteLikeShellCommand,
} from './shell-classification';
import { classifyToolCapability, type ToolCapability } from './tool-capabilities';

export type { ToolRisk };
export { classifyShellRisk, isDestructiveShellCommand };

export interface RuntimeMcpPolicy {
  effects: EffectProfile;
  minimumApproval: CapabilityApproval;
}

export function isReadOnlyMcpPolicy(policy: RuntimeMcpPolicy | undefined): boolean {
  return (
    policy?.minimumApproval === 'none' &&
    [policy.effects.filesystem, policy.effects.network, policy.effects.externalState].every(
      (effect) => effect === 'none' || effect === 'read',
    )
  );
}

/** evaluateToolApproval 的输入参数 / Input parameters for evaluateToolApproval */
export interface EvaluateToolApprovalParams {
  /** 工具名称（如 'shell_execute', 'write_file', 'mcp__server__tool'）/ Tool name */
  toolName: string;
  /** 工具参数 / Tool arguments */
  toolArgs: Record<string, unknown>;
  /** 当前 agent 阶段: 'planning' 或 'building' / Current agent phase */
  phase: AgentPhase;
  /** 工作区路径（same_command 授权匹配用）/ Workspace path for same_command grant matching */
  workspace?: string;
  /** 线程 ID（same_command 授权匹配用）/ Thread ID for same_command grant matching */
  threadId?: string;
  /** 线程授权状态；null/undefined → 默认模式 / Thread authorization state; null/undefined → default */
  authorization?: ThreadAuthorizationState | null;
  /** 运行时授权覆盖（如来自 checkpoint 或父线程）/ Runtime authorization override */
  override?: AuthorizationOverride;
  /** Runtime-resolved local MCP policy. Server annotations never reach this input directly. */
  mcpPolicy?: RuntimeMcpPolicy;
  /** Classification captured by the runtime queue, when available. */
  capability?: ToolCapability;
}

/** 审批决策结果 / Approval decision result */
export interface ApprovalDecision {
  /** 规范化策略动作: allow / ask / deny / Canonical policy action */
  decision: 'allow' | 'ask' | 'deny';
  /** 工具是否允许执行 / Whether the tool is allowed to execute */
  allowed: boolean;
  /** 执行前是否需要用户审批 / Whether user approval is required before execution */
  requiresApproval: boolean;
  /** 风险分类 / Risk classification */
  risk: ToolRisk;
  /** 可叠加的网络与文件系统副作用 / Additive network and filesystem effects */
  effects?: ToolEffects;
  /** 决策原因 / Reason for the decision */
  reason: string;
  /** 用户可见的摘要描述 / Human-readable summary for UI display */
  userVisibleSummary: string;
  /** 预期的副作用 / Expected side effects */
  expectedEffects: string[];
  /** 已使用的授权（如有）/ Which grant was used, if any */
  grantUsed: ShellGrantUsed;
  /** 是否建议沙盒（信息性）/ Whether sandbox is recommended (informational) */
  requiresSandbox?: boolean;
  /** 导致拒绝的阶段约束（如有）/ Phase constraint that caused denial, if applicable */
  phaseConstraint?: AgentPhase;
}

// ── 决策构建器 / Decision builder functions ──

type DecisionInput = Omit<
  ApprovalDecision,
  'decision' | 'allowed' | 'requiresApproval' | 'grantUsed'
> & {
  grantUsed?: ShellGrantUsed;
};

function allow(input: DecisionInput): ApprovalDecision {
  return {
    decision: 'allow',
    allowed: true,
    requiresApproval: false,
    grantUsed: input.grantUsed ?? 'none',
    ...input,
  };
}

function requireApproval(input: DecisionInput): ApprovalDecision {
  return {
    decision: 'ask',
    allowed: true,
    requiresApproval: true,
    grantUsed: input.grantUsed ?? 'none',
    ...input,
  };
}

function deny(input: DecisionInput): ApprovalDecision {
  return {
    decision: 'deny',
    allowed: false,
    requiresApproval: false,
    grantUsed: input.grantUsed ?? 'none',
    ...input,
  };
}

// ── 内部分类器 / Internal classifiers ──

/** 对 shell_execute 命令进行分类（内部使用 classifyShellRisk）/ Classify shell_execute command */
function classifyShellExecute(
  command: string,
  workspace: string,
  capability: ToolCapability,
): ApprovalDecision {
  const trimmed = (command ?? '').trim();
  if (!trimmed) {
    return deny({
      risk: 'unknown',
      reason: 'shell_execute requires a non-empty command.',
      userVisibleSummary: 'Rejected empty shell command.',
      expectedEffects: ['No command will be executed'],
    });
  }

  if (isDestructiveShellCommand(trimmed)) {
    return deny({
      risk: 'destructive',
      reason: 'Destructive shell commands are denied by default.',
      userVisibleSummary: `Rejected destructive shell command: ${trimmed}`,
      expectedEffects: ['No command will be executed'],
    });
  }

  const effects = classifyShellEffects(trimmed, workspace);

  if (capability.effectClass === 'read_only') {
    if (effects.externalRead) {
      return requireApproval({
        risk: 'read',
        effects,
        reason: 'This shell command reads files outside the workspace.',
        userVisibleSummary: `Read external files with Shell: ${trimmed}`,
        expectedEffects: ['Reads files outside the workspace boundary'],
      });
    }
    return allow({
      risk: 'read',
      reason: 'Command is classified as read-only.',
      userVisibleSummary: `Run read-only shell command: ${trimmed}`,
      expectedEffects: [
        'Reads local workspace or git metadata',
        'Does not intentionally mutate files',
      ],
    });
  }

  if (isVcsMutationCommand(trimmed)) {
    return requireApproval({
      risk: 'vcs_mutation',
      effects,
      reason: 'This command mutates version-control state.',
      userVisibleSummary: `Run version-control mutation command: ${trimmed}`,
      expectedEffects: ['Mutates git state', 'May change staged files, commits, or branches'],
    });
  }

  if (isWriteLikeShellCommand(trimmed)) {
    return requireApproval({
      risk: 'write_file',
      effects,
      reason: 'This shell command may modify workspace files.',
      userVisibleSummary: `Run workspace-mutating shell command: ${trimmed}`,
      expectedEffects: [
        'May modify files inside the workspace',
        'May create cache, temp, or dependency output',
      ],
    });
  }

  if (isNetworkCommand(trimmed)) {
    return requireApproval({
      risk: 'network',
      effects,
      reason: 'This shell command may access the network.',
      userVisibleSummary: `Run network-capable shell command: ${trimmed}`,
      expectedEffects: ['May access network resources', 'May write downloaded or generated output'],
    });
  }

  return requireApproval({
    risk: 'execute_code',
    effects,
    reason: 'This shell command executes local project code or an arbitrary program.',
    userVisibleSummary: `Run shell command: ${trimmed}`,
    expectedEffects: ['Executes local project code', 'May create cache or temporary output'],
  });
}

/** planning 阶段拒绝非只读工具 / Deny non-read tools during planning phase */
function denyForPlanningPhase(params: {
  toolName: string;
  phase: AgentPhase;
  fallbackRisk: ToolRisk;
}): ApprovalDecision | null {
  if (params.phase === 'planning') {
    if (params.toolName === 'write_file' || params.toolName === 'edit_file') {
      const outcome =
        params.toolName === 'write_file' ? 'No file was written.' : 'No file was edited.';
      return deny({
        risk: params.fallbackRisk,
        reason:
          'Plan mode is read-only. Workspace edits must be described in the plan and applied only after plan approval.',
        userVisibleSummary: `Plan mode is read-only. ${outcome} Describe the intended change in the plan and apply it after plan approval.`,
        expectedEffects: ['No workspace file was modified'],
        phaseConstraint: 'planning',
      });
    }
    return deny({
      risk: params.fallbackRisk,
      reason: `planning phase allows read-only inspection and plan updates only; rejected ${params.toolName}.`,
      userVisibleSummary:
        'Plan mode is read-only. This operation did not run and cannot be approved while planning. Use read-only inspection or describe the intended implementation in the plan, then run it after plan approval.',
      expectedEffects: ['No workspace mutation or code execution will run'],
      phaseConstraint: 'planning',
    });
  }
  return null;
}

// ── 主入口 / Main entry point ──

/**
 * 纯函数：评估工具是否允许执行、是否需要审批，以及风险分类。
 *
 * 与 tool-policy.ts 中的 evaluateToolPolicy 使用完全相同的分类逻辑，
 * 但接收显式参数，解耦自 LangGraph 的 PendingToolRequest 类型。
 *
 * Pure function: evaluate whether a tool is allowed, requires approval,
 * and its risk classification.
 *
 * Uses the SAME classification logic as evaluateToolPolicy in tool-policy.ts,
 * but accepts explicit parameters, decoupled from LangGraph's PendingToolRequest.
 */
export function evaluateToolApproval(params: EvaluateToolApprovalParams): ApprovalDecision {
  const { toolName, toolArgs, phase, workspace = '', threadId = '' } = params;
  const capability = params.capability ?? classifyToolCapability(toolName, toolArgs);
  const authorization = normalizeAuthorizationState(params.authorization);
  const effectiveMode = params.override?.current ?? authorization.mode;

  // write_plan — pure control tool, saves draft without triggering user review
  // write_plan — pure control tool, does not mutate the workspace
  if (toolName === 'write_plan') {
    return allow({
      risk: 'plan',
      reason: 'Plan draft writes do not mutate the workspace.',
      userVisibleSummary: 'Save plan draft.',
      expectedEffects: ['Updates runtime state only'],
    });
  }

  // update_plan — progress update only, no workspace mutation
  // update_plan — progress update only, does not mutate the workspace
  if (toolName === 'update_plan') {
    return allow({
      risk: 'plan',
      reason: 'Plan progress updates do not mutate the workspace.',
      userVisibleSummary: 'Update plan step progress.',
      expectedEffects: ['Updates runtime state only'],
    });
  }

  // ask_user — 用户澄清中断，不修改工作区
  // ask_user — user clarification interrupt, does not mutate the workspace
  if (toolName === 'ask_user') {
    return allow({
      risk: 'plan',
      reason: 'User clarification interrupts do not mutate the workspace.',
      userVisibleSummary: 'Ask the user a focused clarification question.',
      expectedEffects: ['Interrupts for user input', 'Does not read or write workspace files'],
    });
  }

  // task — 子 agent 调度；planning 阶段仅允许只读子 agent
  // task — sub-agent dispatch; planning phase allows read-only sub-agents only
  if (toolName === 'task') {
    const subagentType = toolArgs.subagent_type as string | undefined;
    if (phase === 'planning' && subagentType !== 'explore' && subagentType !== 'plan') {
      return deny({
        risk: 'execute_code',
        reason: 'planning phase allows read-only sub-agents only.',
        userVisibleSummary: `Plan mode did not start the ${String(subagentType ?? 'unknown')} sub-agent. Use an explore or plan sub-agent, or describe the implementation in the plan for execution after plan approval.`,
        expectedEffects: ['No implementation sub-agent will run during planning'],
        phaseConstraint: 'planning',
      });
    }
    return allow({
      risk: 'plan',
      reason:
        'Sub-agent dispatch is a coordination tool; sub-agent actions have their own approval flow.',
      userVisibleSummary: 'Dispatch a specialized sub-agent for an isolated task.',
      expectedEffects: [
        'Runs a sub-agent in an isolated context',
        'Sub-agent tool calls follow their own approval rules',
      ],
    });
  }

  // web_fetch — 只读网络工具，含隐私/SSRF 扫描
  // web_fetch — read-only network tool with privacy/SSRF protection
  if (toolName === 'web_fetch') {
    const rawUrl = ((toolArgs.url as string | undefined) ?? '').trim();

    let urlObj: URL | null = null;
    try {
      urlObj = new URL(rawUrl);
    } catch {
      /* invalid URL — let the tool executor report the error */
    }
    if (!urlObj) {
      return deny({
        risk: 'network',
        reason: 'Invalid URL format.',
        userVisibleSummary: 'Blocked a web fetch with an invalid URL.',
        expectedEffects: ['No request will be sent'],
      });
    }
    // 拒绝 https://user:pass@host
    // Reject URLs with embedded userinfo
    if (urlObj.username || urlObj.password) {
      return deny({
        risk: 'network',
        reason: 'URL must not contain embedded credentials (userinfo).',
        userVisibleSummary: 'Blocked a web fetch to a URL with embedded credentials.',
        expectedEffects: ['No request will be sent'],
      });
    }
    // 拒绝 query string 中包含疑似 token/key 的长值
    // Reject URLs with long credential-like values in query string
    if (/[?&](?:token|key|secret|password|auth|api_key)=[^&]{20,}/i.test(rawUrl)) {
      return deny({
        risk: 'network',
        reason: 'URL query parameters appear to contain credentials.',
        userVisibleSummary: 'Blocked a web fetch to a URL containing credentials in query.',
        expectedEffects: ['No request will be sent'],
      });
    }

    return allow({
      risk: 'network',
      effects: { network: true },
      reason: 'Read-only web fetch with SSRF and privacy protection.',
      userVisibleSummary: `Fetch: ${rawUrl.slice(0, 60)}`,
      expectedEffects: [
        'Fetches a public web page',
        'Extracts and returns clean Markdown or raw text content',
      ],
    });
  }

  // 只读工作区检查 — 直接放行（外部路径需审批）
  // Read-only workspace inspection — allow directly (external paths require approval)
  if (toolName === 'read_file' || toolName === 'search_content' || toolName === 'search_files') {
    const pathParam = String(toolArgs.path ?? (toolName === 'read_file' ? '<unknown>' : '.'));
    // MSYS2 路径（/c/proj/...）先归一化为 Windows 原生格式再判断外部性，
    // 否则 resolve() 会把 '/c/...' 挂到当前盘符，工作区内路径被误判为外部。
    // Normalize MSYS2-style paths (/c/proj/...) before the external check;
    // otherwise resolve() roots '/c/...' at the current drive and an
    // in-workspace path is misclassified as external. No-op outside Windows.
    const normalizedPath = msys2ToWindowsPath(pathParam);
    const dangerousPath =
      checkDangerousPaths(normalizedPath) ??
      checkDangerousCanonicalPathV1(normalizedPath, workspace);
    if (dangerousPath) {
      return deny({
        risk: 'destructive',
        reason: `Protected path '${dangerousPath}' cannot be accessed by model-driven tools.`,
        userVisibleSummary: `Blocked protected path access: ${dangerousPath}`,
        expectedEffects: ['No protected file will be read'],
      });
    }
    const isOutside = (() => {
      if (normalizedPath.startsWith('~')) return true;
      try {
        return !isPathInsideWorkspace(
          workspace,
          isAbsolute(normalizedPath) ? normalizedPath : resolve(workspace, normalizedPath),
        );
      } catch {
        return true;
      }
    })();
    if (isOutside) {
      // 展示归一化后的路径，与 write 分支摘要口径一致（非 Windows 平台两者相同）。
      // Show the normalized path, consistent with the write branch summaries
      // (identical to the raw path off Windows).
      const label =
        toolName === 'read_file'
          ? `Read external file: ${normalizedPath}`
          : toolName === 'search_content'
            ? `Search content in external path: ${normalizedPath}`
            : `Search files in external path: ${normalizedPath}`;
      if (effectiveMode === 'full_access') {
        return allow({
          risk: 'read',
          effects: { externalRead: true },
          reason: 'full_access is enabled for this thread.',
          userVisibleSummary: label,
          expectedEffects: ['Reads files outside the workspace boundary'],
          grantUsed: 'full_access',
        });
      }
      return requireApproval({
        risk: 'read',
        effects: { externalRead: true },
        reason: 'This tool reads files outside the workspace.',
        userVisibleSummary: label,
        expectedEffects: ['Reads files outside the workspace boundary'],
      });
    }
    return allow({
      risk: 'read',
      reason: 'Read-only workspace inspection.',
      userVisibleSummary: `Read workspace data using ${toolName}.`,
      expectedEffects: ['Reads workspace files', 'Does not intentionally mutate files'],
    });
  }

  // MCP metadata tools — 只读取内存快照，不访问远端 / read in-memory snapshots, no remote access
  if (toolName === 'list_mcp_tools') {
    return allow({
      risk: 'read',
      reason: 'MCP tool inventory reads in-memory capability and provider snapshots.',
      userVisibleSummary: `List MCP tools${toolArgs.provider ? ` from ${String(toolArgs.provider)}` : ''}.`,
      expectedEffects: [
        'Reads cached capability metadata from in-memory snapshots',
        'Does not mutate workspace files',
        'Does not access remote MCP servers',
      ],
    });
  }

  // read_mcp_resource — 资源位置可能是外部服务
  // read_mcp_resource — resource locations may be externally managed
  if (toolName === 'list_mcp_resources' || toolName === 'read_mcp_resource') {
    return allow({
      risk: 'read',
      reason: 'MCP resource metadata and content may be remote or externally managed.',
      userVisibleSummary:
        toolName === 'list_mcp_resources'
          ? `List MCP resources${toolArgs.server ? ` from ${String(toolArgs.server)}` : ''}.`
          : `Read MCP resource from ${String(toolArgs.server ?? 'MCP server')}: ${String(toolArgs.uri ?? '?')}`,
      expectedEffects: [
        toolName === 'list_mcp_resources'
          ? 'Reads cached resource metadata from connected MCP servers'
          : 'Reads content from external MCP server',
        'Does not mutate workspace files',
      ],
    });
  }

  // shell_execute — 按命令内容分类
  // shell_execute — classify by command content
  if (toolName === 'shell_execute') {
    const command = String(toolArgs.command ?? '');

    const dangerousPath = checkDangerousPaths(command);
    if (dangerousPath) {
      return deny({
        risk: 'destructive',
        reason: `Protected path '${dangerousPath}' cannot be accessed by model-driven Shell.`,
        userVisibleSummary: `Blocked protected path access: ${dangerousPath}`,
        expectedEffects: ['No command will be executed'],
      });
    }

    // 兜底：destructive 命令在任何模式下都拒绝，不受 full_access / same_command 影响
    // Safety net: destructive commands are always denied regardless of authorization mode
    // rm -rf 例外：只拒绝工作区代码和关键系统路径，其余降级为 write_file 走正常审批
    // rm -rf exception: only deny workspace code + critical system paths;
    // everything else downgrades to write_file → normal mode-based approval
    if (isDestructiveShellCommand(command)) {
      if (isDestructiveRmOnWorkspace(command, workspace)) {
        return deny({
          risk: 'destructive',
          reason: 'rm -rf must not delete workspace code.',
          userVisibleSummary: `Rejected destructive rm targeting workspace: ${command}`,
          expectedEffects: ['No command will be executed'],
        });
      }
      if (isDestructiveRmOnCriticalPaths(command)) {
        return deny({
          risk: 'destructive',
          reason: 'rm -rf must not delete critical system paths.',
          userVisibleSummary: `Rejected destructive rm targeting critical system paths: ${command}`,
          expectedEffects: ['No command will be executed'],
        });
      }
      const phaseDenial = denyForPlanningPhase({
        toolName,
        phase,
        fallbackRisk: 'write_file',
      });
      if (phaseDenial) {
        return phaseDenial;
      }
      // Non-critical rm -rf: downgrade to write_file; mode policy handles approval
      return requireApproval({
        risk: 'write_file',
        effects: classifyShellEffects(command, workspace),
        reason: 'rm -rf on non-critical paths; downgraded to write_file risk.',
        userVisibleSummary: `Remove files: ${command}`,
        expectedEffects: ['Deletes files and directories outside workspace and system paths'],
      });
    }

    // 只读命令在任何 access/phase 下都允许直通
    // Read-only commands bypass approval regardless of access/phase
    const shellDecision = classifyShellExecute(command, workspace, capability);
    if (shellDecision.allowed && !shellDecision.requiresApproval && shellDecision.risk === 'read') {
      return shellDecision;
    }

    // planning 阶段拒绝所有非只读 shell，不受 authorization 影响
    // Full mode / same_command grants are only valid during building phase
    const phaseDenial = denyForPlanningPhase({
      toolName,
      phase,
      fallbackRisk: classifyShellRisk(command),
    });
    if (phaseDenial) {
      return phaseDenial;
    }

    // 检查 full_access 或 same_command 授权
    // Check full_access or same_command authorization
    const trimmed = command.trim();
    if (trimmed) {
      if (effectiveMode === 'full_access') {
        return allow({
          risk: classifyShellRisk(trimmed),
          effects: classifyShellEffects(trimmed, workspace),
          reason: 'full_access is enabled for this thread.',
          userVisibleSummary: `Run shell command under full_access: ${trimmed}`,
          expectedEffects: [
            'Executes without additional shell approval in the current thread',
            'May read, write, delete, access network, or mutate version-control state',
          ],
          grantUsed: 'full_access',
        });
      }

      if (
        hasSameCommandGrant(authorization, {
          workspace,
          threadId,
          command: trimmed,
        })
      ) {
        return allow({
          risk: classifyShellRisk(trimmed),
          effects: classifyShellEffects(trimmed, workspace),
          reason:
            'same_command grant matches this exact command in the current thread and workspace.',
          userVisibleSummary: `Run previously approved shell command: ${trimmed}`,
          expectedEffects: [
            'Executes the exact command previously approved for this thread and workspace',
          ],
          grantUsed: 'same_command',
        });
      }
    }

    return shellDecision;
  }

  // write_file / edit_file — 修改文件（工作区内外分别处理）
  // write_file / edit_file — modify files (handle internal vs external paths)
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const phaseDenial = denyForPlanningPhase({
      toolName,
      phase,
      fallbackRisk: 'write_file',
    });
    if (phaseDenial) return phaseDenial;

    const rawPath = String(toolArgs.path ?? '<unknown>');
    // 与只读分支一致：先做 MSYS2 归一化再判断外部性（非 Windows 平台透传）。
    // Same as the read branch: normalize MSYS2 paths before the external check.
    const path = msys2ToWindowsPath(rawPath);
    const dangerousPath =
      checkDangerousPaths(path) ?? checkDangerousCanonicalPathV1(path, workspace);
    if (dangerousPath) {
      return deny({
        risk: 'destructive',
        reason: `Protected path '${dangerousPath}' cannot be modified by model-driven tools.`,
        userVisibleSummary: `Blocked protected path modification: ${dangerousPath}`,
        expectedEffects: ['No protected file will be modified'],
      });
    }
    // 绝对路径可能指向工作区内部——解析后再判断外部性
    // Absolute path may resolve inside workspace — check after resolution
    const isOutside = (() => {
      if (path.startsWith('~')) return true;
      try {
        return !isPathInsideWorkspace(
          workspace,
          isAbsolute(path) ? path : resolve(workspace, path),
        );
      } catch {
        return true; // 解析失败，保守视为外部路径
      }
    })();
    if (effectiveMode === 'full_access') {
      return allow({
        risk: 'write_file',
        ...(isOutside ? { effects: { externalWrite: true } } : {}),
        reason: 'full_access is enabled for this thread.',
        userVisibleSummary: `Modify ${isOutside ? 'external ' : 'workspace '}file: ${path}`,
        expectedEffects: [
          `Modifies files ${isOutside ? 'outside' : 'inside'} the workspace`,
          'May overwrite existing content',
        ],
        grantUsed: 'full_access',
      });
    }
    return requireApproval({
      risk: 'write_file',
      ...(isOutside ? { effects: { externalWrite: true } } : {}),
      reason: isOutside
        ? 'This tool modifies files outside the workspace.'
        : 'This tool modifies workspace files.',
      userVisibleSummary: `Modify ${isOutside ? 'external ' : 'workspace '}file: ${path}`,
      expectedEffects: isOutside
        ? ['Modifies files outside the workspace boundary', 'May overwrite existing content']
        : ['Modifies files inside the workspace', 'May overwrite existing content'],
    });
  }

  // MCP policy is derived from a bound descriptor, never a free server name.
  if (toolName.startsWith('mcp__')) {
    if (isReadOnlyMcpPolicy(params.mcpPolicy)) {
      return allow({
        risk: 'read',
        reason: 'Runtime-local MCP policy classifies this bound capability as read-only.',
        userVisibleSummary: `Run MCP tool: ${toolName}`,
        expectedEffects: ['Calls a locally classified read-only MCP capability'],
      });
    }
    const phaseDenial = denyForPlanningPhase({
      toolName,
      phase,
      fallbackRisk: 'mcp',
    });
    if (phaseDenial) return phaseDenial;
    return requireApproval({
      risk: 'mcp',
      effects: { uncertainEffects: true },
      reason: 'MCP tools require user approval by default.',
      userVisibleSummary: `Run MCP tool: ${toolName}`,
      expectedEffects: ['Calls external MCP server tool', 'May have side effects'],
    });
  }

  // Generic fallback — derive policy from Registry-sourced effectClass instead
  // of a hand-written tool-name matrix.  Only tools with explicit security
  // boundaries (web_fetch URL checks, shell command classifiers, file external-path
  // guards, MCP binding validation) need dedicated branches above.
  switch (capability.effectClass) {
    case 'read_only':
      return allow({
        risk: 'read',
        reason: `Registry classifies ${toolName} as read-only.`,
        userVisibleSummary: `Run ${toolName}`,
        expectedEffects: ['Reads data without mutating workspace or external state'],
      });
    case 'plan_only':
      return allow({
        risk: 'plan',
        reason: `Registry classifies ${toolName} as plan-only.`,
        userVisibleSummary: `Run ${toolName}`,
        expectedEffects: ['Updates runtime state only'],
      });
    case 'workspace_write':
      if (phase === 'planning') {
        return deny({
          risk: 'write_file',
          reason: `planning phase rejects workspace writes (${toolName}).`,
          userVisibleSummary: `Rejected ${toolName} during planning phase.`,
          expectedEffects: ['No workspace files will be modified'],
          phaseConstraint: 'planning',
        });
      }
      if (effectiveMode === 'full_access') {
        return allow({
          risk: 'write_file',
          reason: 'full_access is enabled for this thread.',
          userVisibleSummary: `Modify workspace via ${toolName}`,
          expectedEffects: ['Modifies workspace files'],
          grantUsed: 'full_access',
        });
      }
      return requireApproval({
        risk: 'write_file',
        reason: `${toolName} modifies workspace files.`,
        userVisibleSummary: `Modify workspace via ${toolName}`,
        expectedEffects: ['Modifies workspace files'],
      });
    case 'external_side_effect':
      if (phase === 'planning') {
        return deny({
          risk: 'unknown',
          reason: `planning phase rejects external side effects (${toolName}).`,
          userVisibleSummary: `Rejected ${toolName} during planning phase.`,
          expectedEffects: ['No external side effects from planning'],
          phaseConstraint: 'planning',
        });
      }
      return requireApproval({
        risk: 'unknown',
        effects: { uncertainEffects: true },
        reason: `${toolName} may have external side effects.`,
        userVisibleSummary: `Run ${toolName}`,
        expectedEffects: ['May have external side effects'],
      });
    default:
      return deny({
        risk: 'unknown',
        reason: `Unknown tool: ${toolName}`,
        userVisibleSummary: `Rejected unknown tool: ${toolName}`,
        expectedEffects: ['No tool will be executed'],
      });
  }
}
