import type { AgentConfig } from '@/core/config/index';
import type { McpRuntimeProvider } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { ShellExecutor } from '@/core/tools/shell';
import { DEFAULT_SUBAGENT_TIMEOUT_MS, getRoleConfig } from './roles';
import { runSubAgent } from './runner';
import type { SubAgentEventSink, SubAgentResult } from './types';

export interface TaskToolDeps {
  config: AgentConfig;
  workspace: string;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  allowedTools?: Set<string>;
  mcpBindings?: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }>;
  authorization?: import('@/core/types').ThreadAuthorizationState;
  workspaceAccess?: import('@/protocol/events').WorkspaceAccess;
  phase?: import('@/protocol/events').AgentPhase;
  /** Current parent Runtime interaction mode, inherited by the child execution. */
  interactionMode: import('@/protocol/events').InteractionMode;
  projectInstructions?: import('@/core/model/project-instructions').ProjectInstructionSnapshot;
  threadId?: string;
  recoveryIdentityKey?: string;
  eventSink: SubAgentEventSink;
  signal?: AbortSignal;
  model?: SupportedChatModel;
  providerDataAdmission?: import('@/core/config/provider-data-admission').ProviderDataAdmissionGateV1;
  descendantResourceAdmission?: import('@/core/runtime/resource-budget-admission').DescendantResourceAdmissionV1;
  modelInvocationGateway?: import('@/core/model/invocation-gateway').ModelInvocationGatewayV1;
  modelInvocationPersistence?: import('@/core/model/invocation-gateway').ModelInvocationPersistenceV1;
  modelInvocationParentId?: string;
  modelInvocationParentToolCallId?: string;
  modelInvocationParentReservationId?: string;
  toolDispatcher?: import('./types').SubAgentToolDispatcherV1;
  maxDepth?: number;
  /** 写入前文件原像记录器，透传给子 agent 的工具执行（ADR-0042 §4）。 */
  recordFilePreimage?: import('@/core/runtime/file-checkpoints').FilePreimageRecorder;
}

const MAX_CONCURRENT = 10;
const activeCounts = new Map<string, number>();

export async function runTaskSubAgent(
  deps: TaskToolDeps,
  args: { subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string },
): Promise<SubAgentResult> {
  const key = deps.threadId ?? deps.workspace;
  const activeCount = activeCounts.get(key) ?? 0;
  if (activeCount >= MAX_CONCURRENT) {
    const summary = `Maximum concurrent sub-agents (${MAX_CONCURRENT}) reached. Wait for running sub-agents to complete.`;
    return { ok: false, summary, error: summary, toolCallCount: 0, durationMs: 0 };
  }

  activeCounts.set(key, activeCount + 1);
  try {
    const baseRole = getRoleConfig(args.subagent_type);
    return await runSubAgent({
      config: deps.config,
      workspace: deps.workspace,
      role: {
        ...baseRole,
        ...(deps.allowedTools
          ? {
              allowedTools: new Set(
                [...deps.allowedTools].filter(
                  (toolName) => !baseRole.allowedTools || baseRole.allowedTools.has(toolName),
                ),
              ),
            }
          : {}),
      },
      task: args.task,
      shellExecutor: deps.shellExecutor,
      gitBroker: deps.gitBroker,
      mcpManager: deps.mcpManager,
      skills: deps.skills,
      skillOptions: deps.skillOptions,
      mcpBindings: deps.mcpBindings,
      authorization: deps.authorization,
      workspaceAccess: deps.workspaceAccess,
      phase: deps.phase,
      interactionMode: deps.interactionMode,
      projectInstructions: deps.projectInstructions,
      threadId: deps.threadId,
      recoveryIdentityKey: deps.recoveryIdentityKey,
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      signal: deps.signal ?? new AbortController().signal,
      eventSink: deps.eventSink,
      model: deps.model,
      providerDataAdmission: deps.providerDataAdmission,
      descendantResourceAdmission: deps.descendantResourceAdmission,
      modelInvocationGateway: deps.modelInvocationGateway,
      modelInvocationPersistence: deps.modelInvocationPersistence,
      modelInvocationParentId: deps.modelInvocationParentId,
      modelInvocationParentToolCallId: deps.modelInvocationParentToolCallId,
      modelInvocationParentReservationId: deps.modelInvocationParentReservationId,
      toolDispatcher: deps.toolDispatcher,
      depth: 1,
      maxDepth: deps.maxDepth ?? 0,
      recordFilePreimage: deps.recordFilePreimage,
    });
  } finally {
    const next = (activeCounts.get(key) ?? 1) - 1;
    if (next > 0) activeCounts.set(key, next);
    else activeCounts.delete(key);
  }
}
