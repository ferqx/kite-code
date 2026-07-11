import { hasSameCommandGrant, normalizeAuthorizationState } from '@/core/harness/tool-policy';
import { parseMcpToolName } from '@/core/mcp/tool-adapter';
import { isReadOnlyShellCommand } from '@/core/tools/definitions';
import type { AuthorizationOverride, ThreadAuthorizationState } from '@/core/types';
import type { AgentPhase, ShellGrantUsed } from '@/protocol/events';
import type { ToolRisk } from './shell-classification';
import {
  classifyShellRisk,
  isDestructiveShellCommand,
  isNetworkCommand,
  isVcsMutationCommand,
  isWriteLikeShellCommand,
} from './shell-classification';

export type { ToolRisk };
export { classifyShellRisk, isDestructiveShellCommand };

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
  /** 按 MCP 服务器名降低风险等级的配置覆盖 / Per-server MCP risk overrides from config */
  mcpRiskOverride?: Record<string, 'read'>;
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
function classifyShellExecute(command: string): ApprovalDecision {
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

  if (isReadOnlyShellCommand(trimmed)) {
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
      reason: 'This command mutates version-control state.',
      userVisibleSummary: `Run version-control mutation command: ${trimmed}`,
      expectedEffects: ['Mutates git state', 'May change staged files, commits, or branches'],
    });
  }

  if (isWriteLikeShellCommand(trimmed)) {
    return requireApproval({
      risk: 'write_file',
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
      reason: 'This shell command may access the network.',
      userVisibleSummary: `Run network-capable shell command: ${trimmed}`,
      expectedEffects: ['May access network resources', 'May write downloaded or generated output'],
    });
  }

  return requireApproval({
    risk: 'execute_code',
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
    return deny({
      risk: params.fallbackRisk,
      reason: 'planning phase allows read-only inspection and plan updates only.',
      userVisibleSummary: `Rejected ${params.toolName} during planning phase.`,
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

  // exit_plan_mode — control tool, approval-policy passes through; interaction triggered by tool-controller
  // exit_plan_mode — passes through approval; plan_review interaction is triggered by tool-controller
  if (toolName === 'exit_plan_mode') {
    return allow({
      risk: 'plan',
      reason: 'Plan review submission does not mutate the workspace.',
      userVisibleSummary: 'Submit plan for user review.',
      expectedEffects: ['Triggers plan_review interrupt'],
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
    if (
      phase === 'planning' &&
      subagentType !== 'explore' &&
      subagentType !== 'plan' &&
      subagentType !== 'review'
    ) {
      return deny({
        risk: 'execute_code',
        reason: 'planning phase allows read-only sub-agents only.',
        userVisibleSummary: `Rejected ${String(subagentType ?? 'unknown')} sub-agent during planning phase.`,
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
      reason: 'Read-only web fetch with SSRF and privacy protection.',
      userVisibleSummary: `Fetch: ${rawUrl.slice(0, 60)}`,
      expectedEffects: [
        'Fetches a public web page',
        'Extracts and returns clean Markdown or raw text content',
      ],
    });
  }

  // 只读工作区检查 — 直接放行
  // Read-only workspace inspection — allow directly
  if (toolName === 'read_file' || toolName === 'search_content' || toolName === 'search_files') {
    return allow({
      risk: 'read',
      reason: 'Read-only workspace inspection.',
      userVisibleSummary: `Read workspace data using ${toolName}.`,
      expectedEffects: ['Reads workspace files', 'Does not intentionally mutate files'],
    });
  }

  // read_mcp_resource — 只读 MCP 资源
  // read_mcp_resource — read MCP resources only
  if (toolName === 'read_mcp_resource') {
    return allow({
      risk: 'read',
      reason: 'Read MCP resources only inspects remote content exposed by MCP servers.',
      userVisibleSummary: `Read MCP resource from ${String(toolArgs.server ?? 'MCP server')}: ${String(toolArgs.uri ?? '?')}`,
      expectedEffects: [
        'Reads content from external MCP server',
        'Does not mutate workspace files',
      ],
    });
  }

  // Skill — 只读指令加载到对话上下文
  // Skill — loads read-only instructions into conversation context
  if (toolName === 'Skill') {
    return allow({
      risk: 'read',
      reason: 'Skill invocation loads read-only instructions into conversation context.',
      userVisibleSummary: `Load skill: ${String(toolArgs.skill ?? '?')}`,
      expectedEffects: ['Loads skill instructions into conversation context', 'No side effects'],
    });
  }

  // shell_execute — 按命令内容分类
  // shell_execute — classify by command content
  if (toolName === 'shell_execute') {
    const command = String(toolArgs.command ?? '');

    // 兜底：destructive 命令在任何模式下都拒绝，不受 full_access / same_command 影响
    // Safety net: destructive commands are always denied regardless of authorization mode
    if (isDestructiveShellCommand(command)) {
      return deny({
        risk: 'destructive',
        reason: 'Destructive shell commands are denied by default.',
        userVisibleSummary: `Rejected destructive shell command: ${command}`,
        expectedEffects: ['No command will be executed'],
      });
    }

    // 只读命令在任何 access/phase 下都允许直通
    // Read-only commands bypass approval regardless of access/phase
    const shellDecision = classifyShellExecute(command);
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

  // 其余工具：planning 阶段拒绝
  // Remaining tools: deny during planning phase
  const phaseDenial = denyForPlanningPhase({
    toolName,
    phase,
    fallbackRisk: 'unknown',
  });
  if (phaseDenial) {
    return phaseDenial;
  }

  // write_file / edit_file — 修改工作区文件
  // write_file / edit_file — modify workspace files
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const path = String(toolArgs.path ?? '<unknown>');
    if (effectiveMode === 'full_access') {
      return allow({
        risk: 'write_file',
        reason: 'full_access is enabled for this thread.',
        userVisibleSummary: `Modify workspace file: ${path}`,
        expectedEffects: ['Modifies files inside the workspace', 'May overwrite existing content'],
        grantUsed: 'full_access',
      });
    }
    return requireApproval({
      risk: 'write_file',
      reason: 'This tool modifies workspace files.',
      userVisibleSummary: `Modify workspace file: ${path}`,
      expectedEffects: ['Modifies files inside the workspace', 'May overwrite existing content'],
    });
  }

  // mcp__* 工具 — 需要审批（或通过 full_access / config override 放行）
  // mcp__* tools — require approval (or allow via full_access / config override)
  if (toolName.startsWith('mcp__')) {
    const parsed = parseMcpToolName(toolName);
    const serverName = parsed?.serverName ?? '';
    const serverRisk = serverName ? params.mcpRiskOverride?.[serverName] : undefined;

    if (serverRisk === 'read') {
      return allow({
        risk: 'read',
        reason: `MCP server "${serverName}" risk explicitly lowered to read by config.`,
        userVisibleSummary: `Run MCP tool: ${toolName}`,
        expectedEffects: ['Calls MCP server tool (risk lowered by config)'],
      });
    }

    if (effectiveMode === 'full_access') {
      return allow({
        risk: 'mcp',
        reason: 'full_access is enabled for this thread.',
        userVisibleSummary: `Run MCP tool under full_access: ${toolName}`,
        expectedEffects: ['Calls external MCP server tool', 'May have side effects'],
        grantUsed: 'full_access',
      });
    }

    return requireApproval({
      risk: 'mcp',
      reason: 'MCP tools require user approval by default.',
      userVisibleSummary: `Run MCP tool: ${toolName}`,
      expectedEffects: ['Calls external MCP server tool', 'May have side effects'],
    });
  }

  // 未知工具 — 拒绝
  // Unknown tool — deny
  return deny({
    risk: 'unknown',
    reason: `Unknown tool: ${toolName}`,
    userVisibleSummary: `Rejected unknown tool: ${toolName}`,
    expectedEffects: ['No tool will be executed'],
  });
}
