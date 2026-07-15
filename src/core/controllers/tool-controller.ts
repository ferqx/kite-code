import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createBinding, digestCapability } from '@/core/capabilities/catalog';
import { validateCapabilityArguments } from '@/core/capabilities/schema';
import {
  publicSearchMetadata,
  searchableCapabilitySnapshot,
  searchCapabilities,
} from '@/core/capabilities/search';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import { buildToolApproval } from '@/core/harness/tool-policy';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { McpRuntimeProvider } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import {
  type CapabilityArtifactStore,
  defaultCapabilityArtifactStore,
} from '@/core/persistence/capability-artifacts';
import {
  defaultPlanArtifactStore,
  PlanArtifactError,
  type PlanArtifactStore,
} from '@/core/persistence/plan-artifacts';
import { evaluateToolApproval, isReadOnlyMcpPolicy } from '@/core/policies/approval-policy';
import { createModePolicy } from '@/core/policies/mode-policy';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import { genInteractionId } from '@/core/runtime/ids';
import type { RuntimeState } from '@/core/runtime/state';
import {
  computePlanStructuralDigest,
  getActivePlanning,
  getActiveTask,
  getAgentPhase,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import { evaluateSkillActivation, type SkillCatalogSnapshot } from '@/core/skills';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
} from '@/core/subagent/continuation-codec';
import { resumeSubAgent } from '@/core/subagent/runner';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import type { RestoredSubAgentContinuation, SubAgentEventSink } from '@/core/subagent/types';
import type { ShellExecutor } from '@/core/tools/shell';
import { verificationRequestForCapability, verificationRequestForSkill } from '@/core/verification';
import type { InteractionMode, PlanArtifactRef, PlanDocument } from '@/protocol/events';

type SubagentEvent = Parameters<SubAgentEventSink>[0];

function skillCapabilityCeilingViolation(
  state: RuntimeState,
  call: import('@/core/runtime/state').ToolCallRecord,
  request: import('@/core/harness/tool-requests').PendingToolRequest,
): string | null {
  const frames = Object.values(state.skills.frames).filter(
    (frame) => frame.status === 'active' && frame.taskId === state.activeTaskId,
  );
  if (
    frames.length === 0 ||
    request.name === 'activate_skill' ||
    request.name === 'complete_skill' ||
    request.name === 'read_skill_reference'
  )
    return null;
  const capabilityId = request.name.startsWith('mcp__')
    ? call.capabilityId
    : `builtin:${request.name}`;
  if (!capabilityId || frames.some((frame) => !frame.capabilityCeiling.includes(capabilityId))) {
    return `Skill capability ceiling does not allow '${capabilityId ?? request.name}'.`;
  }
  return null;
}

function forkToolCeiling(input: {
  capabilityCeiling: string[];
  mcpManager?: McpRuntimeProvider;
  turnId: string;
}): {
  allowedTools: Set<string>;
  mcpBindings: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }>;
} | null {
  const tools = new Set<string>();
  const mcpBindings: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }> = [];
  for (const capabilityId of input.capabilityCeiling) {
    if (capabilityId.startsWith('builtin:')) {
      tools.add(capabilityId.slice('builtin:'.length));
      continue;
    }
    const descriptor = input.mcpManager?.findCapability(capabilityId);
    if (
      descriptor?.kind !== 'mcp_tool' ||
      descriptor.availability !== 'available' ||
      !descriptor.inputSchema
    )
      return null;
    const binding = createBinding({
      descriptor,
      exposedToolName: `mcp__${descriptor.provider.id}__${descriptor.displayName}`,
      turnId: input.turnId,
    });
    tools.add(binding.exposedToolName);
    mcpBindings.push({ binding, descriptor });
  }
  return { allowedTools: tools, mcpBindings };
}

function forkRole(agent: string): 'explore' | 'plan' | 'code' | 'review' {
  return agent === 'explore' || agent === 'plan' || agent === 'review' ? agent : 'code';
}

function parseForkWorkflowOutput(
  summary: string,
  outputSchema: Record<string, unknown>,
): { ok: true; output: Record<string, unknown> } | { ok: false; reason: string } {
  let output: unknown;
  try {
    output = JSON.parse(summary);
  } catch {
    return {
      ok: false,
      reason: 'Forked Skill must return exactly one JSON object matching its output schema.',
    };
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, reason: 'Forked Skill output must be a JSON object.' };
  }
  const outputError = validateCapabilityArguments(outputSchema, output as Record<string, unknown>);
  return outputError
    ? { ok: false, reason: outputError }
    : { ok: true, output: output as Record<string, unknown> };
}

function readDeclaredSkillReference(input: {
  sourcePath: string;
  files: string[];
  path: string;
}): { ok: true; content: string; encoding: 'utf8' | 'base64' } | { ok: false; reason: string } {
  const normalized = input.path.replaceAll('\\', '/');
  if (
    !/^(?:scripts|references|assets|evals)\//.test(normalized) ||
    !input.files.includes(normalized) ||
    normalized.includes('\0')
  ) {
    return {
      ok: false,
      reason: 'Skill reference is not declared by the active Workflow Contract.',
    };
  }
  const root = resolve(input.sourcePath);
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'Skill reference path escapes its Skill directory.' };
  }
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, reason: 'Skill reference must be a regular non-symlink file.' };
    }
    if (stat.size > 128 * 1024) {
      return {
        ok: false,
        reason:
          'Skill reference exceeds the 128 KiB direct-read limit; expose it through an Artifact in a later workflow step.',
      };
    }
    const content = readFileSync(target);
    const utf8 = content.toString('utf8');
    return Buffer.from(utf8, 'utf8').equals(content)
      ? { ok: true, content: utf8, encoding: 'utf8' }
      : { ok: true, content: content.toString('base64'), encoding: 'base64' };
  } catch (error) {
    return {
      ok: false,
      reason: `Unable to read Skill reference: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Resolve a sub-agent continuation that was rejected (user denied the approval).
 *  Emits subagent.failed + tool.finished so the TUI transitions the sub-agent block
 *  from awaiting_approval to error, and the task tool produces a result for the model.
 *  Called by the runner after approval.rejected is processed. */
export function resolveRejectedSubagentContinuation(
  state: RuntimeState,
  toolCallId: string,
): RuntimeEvent[] {
  const snapshot = state.suspendedSubagents[toolCallId];
  if (!snapshot) return [];
  const continuation = deserializeSubagentContinuation(snapshot);

  const blockedToolName = continuation.blockedTool.toolName;
  const subagentId = continuation.id;
  const rejectionMsg = `Sub-agent tool "${blockedToolName}" was rejected by user.`;

  return [
    {
      type: 'subagent.failed',
      subagent: {
        id: subagentId,
        error: rejectionMsg,
        summary: rejectionMsg,
        toolCallCount: continuation.toolCallCount,
        durationMs: 0,
      },
    } as RuntimeEvent,
    {
      type: 'tool.finished',
      toolCallId,
      name: 'task',
      result: {
        ok: false,
        command: '',
        exitCode: -1,
        stdout: '',
        stderr: rejectionMsg,
        status: 'error',
      },
    },
  ];
}

/** Convert the subagent runner's private callback payload into a durable public fact. */
export function toRuntimeSubagentEvent(event: SubagentEvent): RuntimeEvent {
  switch (event.type) {
    case 'start':
      return { type: 'subagent.started', subagent: event.data };
    case 'step':
      return { type: 'subagent.step', subagent: event.data };
    case 'tool_result':
      return { type: 'subagent.tool_result', subagent: event.data };
    case 'done':
      return { type: 'subagent.completed', subagent: event.data };
    case 'error':
      return { type: 'subagent.failed', subagent: event.data };
    case 'cache_metrics':
      return { type: 'subagent.cache_metrics', subagent: event.data };
  }
}

/**
 * Resume a sub-agent after approval: execute the blocked tool with the
 * approved grant, then continue the sub-agent loop from the saved state.
 * Returns all RuntimeEvents produced by the resumed sub-agent execution.
 */
async function handleSubAgentResume(params: {
  state: RuntimeState;
  toolCallId: string;
  continuation: RestoredSubAgentContinuation;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  emitSubagentEvent: SubAgentEventSink;
}): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const { continuation } = params;
  const { toolName: blockedToolName, args: blockedToolArgs } = continuation.blockedTool;

  // Execute the previously-blocked tool with the approval grant
  const call = params.state.tools.calls[params.toolCallId];
  const blockedRequest = toolRequestFromCall(
    {
      id: params.toolCallId,
      name: blockedToolName,
      args: blockedToolArgs,
    },
    params.state.session.workspace,
  );

  let toolResult: ToolExecutionResult;
  if (blockedRequest) {
    toolResult = await runApprovedTool({
      workspace: params.state.session.workspace,
      request: blockedRequest,
      shellExecutor: params.shellExecutor,
      workspaceAccess: params.state.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(params.state)),
      authorization: params.state.authorization,
      approvedGrant: call?.approvalGrant ?? 'none',
      threadId: params.state.session.threadId,
      mcpManager: params.mcpManager,
      skillManifests: params.skillManifests,
      skillOptions: params.skillOptions,
      signal: params.signal,
      taskConfig: params.taskConfig,
      taskModel: params.taskModel,
      subagentEventSink: params.emitSubagentEvent,
    });
  } else {
    toolResult = {
      ok: false,
      command: blockedToolName,
      exitCode: -1,
      stdout: '',
      stderr: `Failed to build tool request for "${blockedToolName}".`,
      status: 'error',
    };
  }

  // Resume the sub-agent with the tool result
  const result = await resumeSubAgent(
    {
      config: params.taskConfig!,
      workspace: params.state.session.workspace,
      role: continuation.role,
      task: continuation.task,
      shellExecutor: params.shellExecutor,
      mcpManager: params.mcpManager,
      skills: params.skillManifests,
      skillOptions: params.skillOptions,
      authorization: params.state.authorization,
      workspaceAccess: params.state.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(params.state)),
      threadId: params.state.session.threadId,
      timeoutMs: 30 * 60 * 1000,
      signal: params.signal ?? new AbortController().signal,
      eventSink: params.emitSubagentEvent,
      model: params.taskModel,
      depth: 1,
      maxDepth: 0,
    },
    continuation,
    {
      toolCallId: continuation.blockedTool.toolCallId,
      toolName: blockedToolName,
      result: toolResult,
    },
  );

  // 子 agent 恢复后再次 blocked → 上报审批，不发射 tool.finished
  if (result.blocked) {
    const blocked = result.blocked;
    const subagentId = blocked.continuation.id;
    events.push({
      type: 'subagent.suspended',
      toolCallId: params.toolCallId,
      snapshot: serializeSubagentContinuation(blocked.continuation, {
        toolCallId: blocked.toolCallId,
        toolName: blocked.toolName,
        args: blocked.args,
        command: blocked.command,
      }),
    });
    const blockedDecision = evaluateToolApproval({
      toolName: blocked.toolName,
      toolArgs: blocked.args,
      phase: getAgentPhase(getActivePlanning(params.state)),
      workspace: params.state.session.workspace,
      threadId: params.state.session.threadId,
      authorization: params.state.authorization,
    });
    const blockedApproval = buildToolApproval({
      workspace: params.state.session.workspace,
      threadId: params.state.session.threadId,
      request: {
        id: blocked.toolCallId,
        name: blocked.toolName,
        args: blocked.args,
        protectedCommand: blocked.command,
      } as import('@/core/harness/tool-requests').PendingToolRequest,
      decision: blockedDecision,
    }) as import('@/protocol/events').ToolApprovalPayload;
    blockedApproval.subagentId = subagentId;
    events.push({
      type: 'approval.requested',
      interactionId: genInteractionId(),
      toolCallId: params.toolCallId,
      approval: blockedApproval,
    });
    return events;
  }

  // Emit tool.finished for the task tool — the sub-agent has produced its final result
  const output = JSON.stringify(result);
  const ok = result.ok !== false;
  events.push({
    type: 'tool.finished',
    toolCallId: params.toolCallId,
    name: 'task',
    result: {
      ok,
      command: 'task',
      exitCode: ok ? 0 : -1,
      stdout: output,
      stderr: ok ? '' : output,
      status: ok ? ('success' as const) : ('error' as const),
    },
  });

  return events;
}

/**
 * Kernel-native tool effect.  It derives the execution request from the
 * persisted call record and returns facts only; it never creates a ToolMessage
 * or mutates a graph channel.
 */
export async function executeRuntimeTools(params: {
  state: RuntimeState;
  toolCallIds: string[];
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  subagentEventSink?: SubAgentEventSink;
  planArtifactStore?: PlanArtifactStore;
  capabilityArtifactStore?: CapabilityArtifactStore;
  /** Runtime sink used to publish tool lifecycle/progress events while execution is running. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
}): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  // Keep the direct-call API unchanged for tests and legacy callers.  The
  // Runtime runner replaces push with a streaming sink, so events are applied
  // and rendered as soon as they are produced instead of after the tool exits.
  if (params.emitRuntimeEvent) {
    const append = events.push.bind(events);
    events.push = (...items: RuntimeEvent[]) => {
      for (const item of items) params.emitRuntimeEvent?.(item);
      return append();
    };
  }
  const planArtifacts = params.planArtifactStore ?? defaultPlanArtifactStore;
  const capabilityArtifacts = params.capabilityArtifactStore ?? defaultCapabilityArtifactStore;
  const emitSubagentEvent: SubAgentEventSink = (event) => {
    events.push(toRuntimeSubagentEvent(event));
    params.subagentEventSink?.(event);
  };
  for (const toolCallId of params.toolCallIds) {
    const call = params.state.tools.calls[toolCallId];
    if (!call || (call.status !== 'queued' && call.status !== 'approved')) continue;
    const request = toolRequestFromCall(
      { id: call.toolCallId, name: call.name, args: (call.args ?? {}) as Record<string, unknown> },
      params.state.session.workspace,
    );
    if (!request) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure('tool_not_found', `Unsupported tool '${call.name}'.`),
      });
      continue;
    }
    const ceilingViolation = skillCapabilityCeilingViolation(params.state, call, request);
    if (ceilingViolation) {
      events.push({ type: 'tool.rejected', toolCallId, reason: ceilingViolation });
      continue;
    }
    if (request.name.startsWith('mcp__')) {
      const flags = params.taskConfig ? getFeatureFlags(params.taskConfig) : undefined;
      const binding = call.bindingId
        ? params.state.capabilities.bindings[call.bindingId]
        : undefined;
      const descriptor = binding
        ? params.mcpManager?.findCapability(binding.capabilityId)
        : undefined;
      const invalidReason =
        !flags?.capabilityCatalogV1 || !flags.mcpRuntimeBindingV1
          ? 'MCP Runtime binding is disabled by feature flag.'
          : !binding || binding.issuedForTurnId !== call.createdAtTurnId
            ? 'MCP tool call has no valid Runtime-issued binding.'
            : !descriptor || descriptor.revision !== binding.capabilityRevision
              ? 'MCP capability changed after binding; request a new model turn before calling it.'
              : descriptor.availability !== 'available' || !descriptor.inputSchema
                ? 'MCP capability is unavailable for execution.'
                : validateCapabilityArguments(
                    descriptor.inputSchema,
                    request.args as Record<string, unknown>,
                  );
      if (invalidReason) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure('tool_invalid_args', invalidReason),
        });
        continue;
      }
    }
    if (request.name === 'capability_search') {
      const flags = params.taskConfig ? getFeatureFlags(params.taskConfig) : getFeatureFlags();
      if (!flags.capabilitySearchV1) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'Capability search is disabled by feature flag.',
        });
        continue;
      }
      if (request.args.query.length < 2) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure('tool_invalid_args', 'Capability search query is too short.'),
        });
        continue;
      }
      const snapshot = searchableCapabilitySnapshot({
        mcp: params.mcpManager?.getCapabilitySnapshot(),
        skills: params.skillCatalog?.capabilities,
      });
      const candidates = searchCapabilities({
        snapshot,
        query: request.args.query,
        limit: request.args.limit,
      });
      const searchId = digestCapability({
        threadId: params.state.session.threadId,
        turnId: params.state.turn.turnId,
        toolCallId,
        query: request.args.query,
        catalogRevision: snapshot.revision,
      });
      events.push({
        type: 'capability.search_completed',
        result: {
          searchId,
          query: request.args.query,
          catalogRevision: snapshot.revision,
          requestedAtTurnId: params.state.turn.turnId,
          candidates,
        },
      });
      events.push({
        type: 'tool.finished',
        toolCallId,
        name: request.name,
        result: {
          ok: true,
          command: request.name,
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            search_id: searchId,
            candidate_count: candidates.length,
            candidates: publicSearchMetadata(candidates),
            next_step:
              'The Runtime will disclose current matching capabilities on the next model call.',
          }),
          stderr: '',
        },
      });
      continue;
    }
    if (request.name === 'activate_skill') {
      const flags = params.taskConfig ? getFeatureFlags(params.taskConfig) : getFeatureFlags();
      const descriptor = params.skillCatalog?.capabilities.descriptors.find(
        (candidate) => candidate.capabilityId === request.args.skill_id,
      );
      const disclosure = params.state.capabilities.disclosures[request.args.skill_id];
      if (
        flags.capabilitySearchV1 &&
        (!descriptor ||
          !disclosure ||
          disclosure.issuedForTurnId !== params.state.turn.turnId ||
          disclosure.capabilityRevision !== descriptor.revision)
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'Skill is not disclosed for this model turn; search again before activation.',
        });
        continue;
      }
      const activation = params.skillCatalog
        ? evaluateSkillActivation({
            state: params.state,
            catalog: params.skillCatalog,
            flags,
            request: {
              skillId: request.args.skill_id,
              input: request.args.input,
              requestedBy: 'model',
              implicit: true,
            },
          })
        : { ok: false as const, reason: 'Skill catalog is unavailable.' };
      if (!activation.ok) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: activation.reason,
        });
        continue;
      }
      if (activation.activation.contextMode === 'fork') {
        const entry = params.skillCatalog?.entries.find(
          (candidate) =>
            !candidate.shadowedBy &&
            candidate.descriptor.capabilityId === activation.activation.skillId &&
            candidate.descriptor.revision === activation.activation.skillRevision &&
            candidate.contract,
        );
        const forkCeiling = forkToolCeiling({
          capabilityCeiling: activation.activation.capabilityCeiling,
          mcpManager: params.mcpManager,
          turnId: params.state.turn.turnId,
        });
        if (!entry?.contract || !forkCeiling || !params.taskConfig || !params.taskModel) {
          events.push({
            type: 'tool.rejected',
            toolCallId,
            reason:
              'Forked Skill requires a current compiled contract, Runtime model, and resolvable capability bindings.',
          });
          continue;
        }
        events.push(...activation.events);
        const result = await runTaskSubAgent(
          {
            config: params.taskConfig,
            workspace: params.state.session.workspace,
            shellExecutor: params.shellExecutor,
            mcpManager: params.mcpManager,
            skills: params.skillManifests,
            skillOptions: params.skillOptions,
            allowedTools: forkCeiling.allowedTools,
            mcpBindings: forkCeiling.mcpBindings,
            authorization: params.state.authorization,
            workspaceAccess: params.state.workspaceAccess,
            phase: getAgentPhase(getActivePlanning(params.state)),
            threadId: params.state.session.threadId,
            eventSink: emitSubagentEvent,
            signal: params.signal,
            model: params.taskModel,
            maxDepth: 0,
          },
          {
            subagent_type: forkRole(activation.activation.agent),
            task: [
              entry.contract.instructions,
              '## Validated Workflow Input',
              JSON.stringify(activation.activation.input),
              '## Required completion format',
              'When the work is complete, respond with only one JSON object. Do not add Markdown or commentary.',
              `The object must validate against this output schema: ${JSON.stringify(entry.contract.outputSchema)}`,
            ].join('\n\n'),
          },
        );
        const validatedOutput = result.ok
          ? parseForkWorkflowOutput(result.summary, entry.contract.outputSchema)
          : { ok: false as const, reason: result.error ?? result.summary };
        const completed = result.ok && validatedOutput.ok;
        const failureReason = validatedOutput.ok ? undefined : validatedOutput.reason;
        events.push({
          type: 'skill.frame_closed',
          activationId: activation.activation.activationId,
          status: completed ? 'closed' : 'invalidated',
          reason: completed
            ? 'Forked Skill execution completed.'
            : (failureReason ?? 'Forked Skill execution failed.'),
          closedAt: new Date().toISOString(),
          ...(completed ? { output: validatedOutput.output } : {}),
        });
        if (completed && getFeatureFlags(params.taskConfig).verificationV1) {
          const verification = verificationRequestForSkill({
            activation: activation.activation,
            contract: entry.contract,
            sourcePath: entry.sourcePath,
            workspace: params.state.session.workspace,
          });
          if (verification) events.push(verification);
        }
        events.push({
          type: 'tool.finished',
          toolCallId,
          name: request.name,
          result: {
            ok: completed,
            command: request.name,
            exitCode: completed ? 0 : -1,
            stdout: JSON.stringify({
              ok: completed,
              activation_id: activation.activation.activationId,
              skill_id: activation.activation.skillId,
              context_mode: 'fork',
              ...(completed ? { output: validatedOutput.output } : { summary: result.summary }),
            }),
            stderr: completed ? '' : (failureReason ?? 'Forked Skill execution failed.'),
            status: completed ? 'success' : 'error',
          },
        });
        continue;
      }
      events.push(...activation.events);
      events.push({
        type: 'tool.finished',
        toolCallId,
        name: request.name,
        result: {
          ok: true,
          command: request.name,
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            activation_id: activation.activation.activationId,
            skill_id: activation.activation.skillId,
            context_mode: activation.activation.contextMode,
          }),
          stderr: '',
        },
      });
      continue;
    }
    if (request.name === 'read_skill_reference') {
      const frame = params.state.skills.frames[request.args.activation_id];
      const entry =
        frame &&
        params.skillCatalog?.entries.find(
          (candidate) =>
            !candidate.shadowedBy &&
            candidate.descriptor.capabilityId === frame.skillId &&
            candidate.descriptor.revision === frame.skillRevision &&
            candidate.contract,
        );
      if (
        frame?.status !== 'active' ||
        frame.taskId !== params.state.activeTaskId ||
        !entry?.contract
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'Skill frame is unavailable or changed.',
        });
        continue;
      }
      const reference = readDeclaredSkillReference({
        sourcePath: entry.sourcePath,
        files: entry.contract.files,
        path: request.args.path,
      });
      if (!reference.ok) {
        events.push({ type: 'tool.rejected', toolCallId, reason: reference.reason });
        continue;
      }
      events.push({
        type: 'tool.finished',
        toolCallId,
        name: request.name,
        result: {
          ok: true,
          command: request.name,
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            activation_id: frame.activationId,
            path: request.args.path,
            encoding: reference.encoding,
            content: reference.content,
          }),
          stderr: '',
        },
      });
      continue;
    }
    if (request.name === 'complete_skill') {
      const frame = params.state.skills.frames[request.args.activation_id];
      const entry =
        frame &&
        params.skillCatalog?.entries.find(
          (candidate) =>
            !candidate.shadowedBy &&
            candidate.descriptor.capabilityId === frame.skillId &&
            candidate.descriptor.revision === frame.skillRevision &&
            candidate.contract,
        );
      if (
        frame?.status !== 'active' ||
        frame.taskId !== params.state.activeTaskId ||
        !entry?.contract
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'Skill frame is unavailable or changed.',
        });
        continue;
      }
      const contract = entry.contract;
      const outputError = validateCapabilityArguments(contract.outputSchema, request.args.output);
      if (outputError) {
        events.push({ type: 'tool.rejected', toolCallId, reason: outputError });
        continue;
      }
      events.push({
        type: 'skill.frame_closed',
        activationId: frame.activationId,
        status: 'closed',
        reason: 'Workflow completed with validated structured output.',
        closedAt: new Date().toISOString(),
        output: request.args.output,
      });
      if (params.taskConfig && getFeatureFlags(params.taskConfig).verificationV1) {
        const verification = verificationRequestForSkill({
          activation: frame,
          contract,
          sourcePath: entry.sourcePath,
          workspace: params.state.session.workspace,
        });
        if (verification) events.push(verification);
      }
      events.push({
        type: 'tool.finished',
        toolCallId,
        name: request.name,
        result: {
          ok: true,
          command: request.name,
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            activation_id: frame.activationId,
            output: request.args.output,
          }),
          stderr: '',
        },
      });
      continue;
    }
    if (request.name === 'Skill') {
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason:
          'Legacy prompt Skill loading is retired. Use a Runtime Workflow Contract activation.',
      });
      continue;
    }
    if (request.name === 'ask_user') {
      const hasQuestion = request.args.question.trim().length > 0;
      const hasBatchQuestions = (request.args.questions?.length ?? 0) > 0;
      if (!hasQuestion && !hasBatchQuestions) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'tool_invalid_args',
            'ask_user requires a non-empty question or questions array.',
          ),
        });
        continue;
      }
      events.push({
        type: 'user_input.requested',
        interactionId: genInteractionId(),
        toolCallId,
        request: request.args,
      });
      continue;
    }

    if (request.name === 'read_plan') {
      const args = request.args as {
        plan_id: string;
        version?: number;
        structural_digest?: string;
      };
      const planning = getActivePlanning(params.state);
      const task = getActiveTask(params.state);
      const taskId = task?.taskId ?? `legacy-${params.state.session.threadId}`;
      const document =
        planning.kind === 'planning_draft' ||
        planning.kind === 'replanning_draft' ||
        planning.kind === 'awaiting_review' ||
        planning.kind === 'executing' ||
        planning.kind === 'completed'
          ? planning.document
          : undefined;
      const version = args.version ?? document?.version;
      if (!document || args.plan_id !== document.planId || version !== document.version) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'read_plan must reference the active Task plan and its current version.',
        });
        continue;
      }
      if (args.structural_digest && args.structural_digest !== document.structuralDigest) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'read_plan structural_digest does not match the active Artifact.',
        });
        continue;
      }
      const artifactRef = document.artifact ?? {
        artifactId: `${document.planId}:v${document.version}`,
        taskId,
        planId: document.planId,
        version: document.version,
        fileName: `v${document.version}.md`,
        relativePath: '',
        displayPath: '',
        structuralDigest: document.structuralDigest,
        byteLength: 0,
      };
      try {
        const artifact = planArtifacts.read(artifactRef);
        events.push({
          type: 'tool.finished',
          toolCallId,
          name: 'read_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'plan_loaded',
              task_id: taskId,
              plan_id: artifact.plan.planId,
              version: artifact.plan.version,
              structural_digest: artifact.plan.structuralDigest,
              title: artifact.plan.title,
              body_markdown: artifact.plan.bodyMarkdown,
              steps: artifact.plan.steps,
              artifact: artifact.artifact,
            }),
            stderr: '',
          },
        });
      } catch (error) {
        const reason =
          error instanceof PlanArtifactError ? error.message : 'Unable to read the Plan Artifact.';
        events.push({ type: 'tool.rejected', toolCallId, reason });
      }
      continue;
    }

    // ── Plan tools ──

    if (request.name === 'write_plan') {
      const args = request.args as {
        title?: string;
        body_markdown?: string;
        steps?: Array<{ id: string; title: string }>;
        expected_version?: number;
        action?: 'save' | 'submit';
        replan_reason?: string;
        plan_id?: string;
        version?: number;
        structural_digest?: string;
      };
      const action = args.action ?? 'save';
      const hasDocument =
        typeof args.title === 'string' &&
        typeof args.body_markdown === 'string' &&
        Array.isArray(args.steps);
      const hasArtifactRef =
        typeof args.plan_id === 'string' &&
        Number.isInteger(args.version) &&
        typeof args.structural_digest === 'string';
      const planning = getActivePlanning(params.state);
      const phase = getAgentPhase(planning);
      const task = getActiveTask(params.state);
      const taskId = task?.taskId ?? `legacy-${params.state.session.threadId}`;
      const isSubmitExisting = action === 'submit' && hasArtifactRef && !hasDocument;
      const isLegacyDocumentSubmit = action === 'submit' && hasDocument;
      const autoEnter =
        phase === 'building' &&
        planning.kind === 'building_without_plan' &&
        (action === 'save' || isLegacyDocumentSubmit) &&
        Boolean(task && !task.sideEffectsStarted);
      const draftWrite =
        (planning.kind === 'planning_empty' || planning.kind === 'planning_draft') &&
        hasDocument &&
        (action === 'save' || isLegacyDocumentSubmit) &&
        (task == null || !task.sideEffectsStarted);
      const replanDraftSubmit =
        planning.kind === 'replanning_draft' && (isSubmitExisting || isLegacyDocumentSubmit);
      const replan =
        phase === 'building' && planning.kind === 'executing' && args.action === 'submit';
      const submitExistingAllowed =
        isSubmitExisting &&
        (planning.kind === 'planning_draft' || planning.kind === 'replanning_draft') &&
        args.plan_id === planning.document.planId &&
        args.version === planning.document.version &&
        args.structural_digest === planning.document.structuralDigest;
      const sideEffectsBlockDraft =
        hasDocument &&
        (action === 'save' || isLegacyDocumentSubmit) &&
        task?.sideEffectsStarted === true;
      if (!draftWrite && !replanDraftSubmit && !autoEnter && !replan && !submitExistingAllowed) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: isSubmitExisting
            ? 'submit must reference the current saved plan_id, version, and structural_digest.'
            : sideEffectsBlockDraft
              ? 'write_plan cannot save a new plan after side effects have started.'
              : 'write_plan requires a complete plan document when saving.',
        });
        continue;
      }
      if (autoEnter && task) {
        events.push({ type: 'planning.entered', taskId: task.taskId, source: 'model_request' });
      }
      if (replan && planning.kind === 'executing') {
        events.push({
          type: 'plan.replan_requested',
          toolCallId,
          reason: args.replan_reason ?? (args.body_markdown ?? '').slice(0, 500),
          supersedesPlanVersion: planning.document.version,
        });
      }

      if (submitExistingAllowed) {
        let artifact: ReturnType<typeof defaultPlanArtifactStore.read>;
        try {
          artifact = planArtifacts.read({
            artifactId: `${args.plan_id}:v${args.version}`,
            taskId,
            planId: args.plan_id!,
            version: args.version!,
            fileName: `v${args.version}.md`,
            relativePath: '',
            displayPath: '',
            structuralDigest: args.structural_digest!,
            byteLength: 0,
          });
        } catch (error) {
          const reason =
            error instanceof PlanArtifactError
              ? error.message
              : 'Unable to read the saved Plan Artifact.';
          events.push({ type: 'tool.rejected', toolCallId, reason });
          continue;
        }
        const document = artifact.plan;
        const plan = {
          name: document.title,
          description: document.bodyMarkdown,
          status: 'pending' as const,
          steps: document.steps.map((step) => ({
            step: step.title,
            id: step.id,
            status: step.status,
          })),
        };
        const interactionId = genInteractionId();
        events.push({
          type: 'plan.review_requested',
          interactionId,
          toolCallId,
          taskId,
          plan,
          planSummary: `${document.title}\n\n${document.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`,
          planId: document.planId,
          version: document.version,
          structuralDigest: document.structuralDigest,
          artifact: artifact.artifact,
        });
        for (const sibling of Object.values(params.state.tools.calls)) {
          if (
            sibling.status === 'queued' &&
            sibling.modelMessageId === call.modelMessageId &&
            (sibling.ordinal ?? 0) > (call.ordinal ?? 0)
          ) {
            events.push({
              type: 'tool.cancelled',
              toolCallId: sibling.toolCallId,
              reason: 'Cancelled because an earlier tool call opened an interaction.',
            });
          }
        }
        continue;
      }

      if (!hasDocument) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'write_plan save requires title, body_markdown, and steps.',
        });
        continue;
      }
      // Version conflict check
      if (
        args.expected_version != null &&
        (planning.kind === 'planning_draft' || planning.kind === 'replanning_draft') &&
        args.expected_version !== planning.document.version
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: `Version conflict: expected v${args.expected_version}, current is v${planning.document.version}.`,
        });
        continue;
      }
      const previous =
        planning.kind === 'planning_draft' || planning.kind === 'replanning_draft'
          ? planning.document
          : undefined;
      const replanMetadata =
        replan && planning.kind === 'executing'
          ? {
              supersedesPlanVersion: planning.document.version,
              replanReason: args.replan_reason ?? (args.body_markdown ?? '').slice(0, 500),
            }
          : planning.kind === 'replanning_draft'
            ? {
                supersedesPlanVersion: planning.supersedesPlanVersion,
                replanReason: planning.replanReason,
              }
            : previous?.supersedesPlanVersion != null
              ? {
                  supersedesPlanVersion: previous.supersedesPlanVersion,
                  replanReason: previous.replanReason ?? '',
                }
              : {};
      const candidateDocument: PlanDocument = {
        planId: previous?.planId ?? crypto.randomUUID(),
        version: (previous?.version ?? 0) + 1,
        title: args.title!,
        bodyMarkdown: args.body_markdown!,
        steps: args.steps!.map(({ id, title }) => ({ id, title, status: 'pending' as const })),
        structuralDigest: '',
        createdAtTurnId: previous?.createdAtTurnId ?? params.state.turn.turnId,
        updatedAtTurnId: params.state.turn.turnId,
        ...replanMetadata,
      };
      candidateDocument.structuralDigest = computePlanStructuralDigest(candidateDocument);

      // A repeated save with identical structure is idempotent and does not create vN+1.
      const document =
        previous && previous.structuralDigest === candidateDocument.structuralDigest
          ? { ...candidateDocument, ...previous, updatedAtTurnId: params.state.turn.turnId }
          : candidateDocument;
      let artifact: PlanArtifactRef;
      try {
        artifact = planArtifacts.write(taskId, document);
      } catch (error) {
        const reason =
          error instanceof PlanArtifactError
            ? error.message
            : 'Unable to persist the Plan Artifact.';
        events.push({ type: 'tool.rejected', toolCallId, reason });
        continue;
      }
      const submit = isLegacyDocumentSubmit;

      events.push({
        type: 'plan.drafted',
        toolCallId,
        planId: document.planId,
        version: document.version,
        plan: {
          name: document.title,
          description: document.bodyMarkdown,
          status: 'pending',
          steps: document.steps.map((step) => ({
            step: step.title,
            id: step.id,
            status: step.status,
          })),
        },
        structuralHash: document.structuralDigest,
        taskId,
        artifact,
        ...replanMetadata,
      });

      if (submit) {
        // Emit review_requested — tool stays pending until user decision
        const interactionId = genInteractionId();
        events.push({
          type: 'plan.review_requested',
          interactionId,
          toolCallId,
          plan: {
            name: document.title,
            description: document.bodyMarkdown,
            status: 'pending',
            steps: document.steps.map((step) => ({
              step: step.title,
              id: step.id,
              status: step.status,
            })),
          },
          planSummary: `${document.title}\n\n${document.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`,
          planId: document.planId,
          version: document.version,
          structuralDigest: document.structuralDigest,
          taskId,
          artifact,
        });
        // Cancel later sibling tool calls
        for (const sibling of Object.values(params.state.tools.calls)) {
          if (
            sibling.status === 'queued' &&
            sibling.modelMessageId === call.modelMessageId &&
            (sibling.ordinal ?? 0) > (call.ordinal ?? 0)
          ) {
            events.push({
              type: 'tool.cancelled',
              toolCallId: sibling.toolCallId,
              reason: 'Cancelled because an earlier tool call opened an interaction.',
            });
          }
        }
      } else {
        // Save-only: finish tool call immediately
        events.push({
          type: 'tool.finished',
          toolCallId,
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'draft_saved',
              task_id: taskId,
              plan_id: document.planId,
              version: document.version,
              structural_digest: document.structuralDigest,
              artifact: {
                artifact_id: artifact.artifactId,
                file_name: artifact.fileName,
                path: artifact.displayPath,
                relative_path: artifact.relativePath,
                structural_digest: artifact.structuralDigest,
                byte_length: artifact.byteLength,
              },
              next_action: 'submit',
            }),
            stderr: '',
          },
        });
      }
      continue;
    }

    if (request.name === 'update_plan') {
      const args = request.args as {
        plan_id: string;
        updates: Array<{ step_id: string; status: string; note?: string }>;
        complete_plan?: boolean;
      };
      const planning = getActivePlanning(params.state);
      const phase = getAgentPhase(planning);
      if (phase !== 'building') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'update_plan is only available in building phase after plan approval.',
        });
        continue;
      }
      if (planning.kind !== 'executing') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'No executing plan. Wait for plan approval first.',
        });
        continue;
      }
      const doc = planning.document;
      if (args.plan_id !== doc.planId) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: `Plan ID mismatch: expected ${args.plan_id}, current is ${doc.planId}.`,
        });
        continue;
      }
      const unknownStep = args.updates.find(
        (update) => !doc.steps.some((step) => step.id === update.step_id),
      );
      if (unknownStep) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: `Unknown plan step ID: ${unknownStep.step_id}.`,
        });
        continue;
      }
      const plan = {
        name: doc.title,
        description: doc.bodyMarkdown,
        status: args.complete_plan ? ('completed' as const) : ('in_progress' as const),
        steps: doc.steps.map((step) => {
          const update = args.updates.find((candidate) => candidate.step_id === step.id);
          return {
            step: step.title,
            id: step.id,
            status: (update?.status ?? step.status) as
              | 'pending'
              | 'in_progress'
              | 'completed'
              | 'skipped',
            note: update?.note ?? step.note,
          };
        }),
      };
      if (
        args.complete_plan &&
        plan.steps.some((step) => step.status === 'pending' || step.status === 'in_progress')
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'Cannot complete plan while steps are pending or in progress.',
        });
        continue;
      }
      events.push({
        type: 'plan.progress_updated',
        toolCallId,
        plan,
      });
      if (args.complete_plan) {
        events.push({
          type: 'plan.completed',
          toolCallId,
          plan,
        });
      }
      events.push({
        type: 'tool.finished',
        toolCallId,
        name: 'update_plan',
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            plan_id: doc.planId,
            updated_steps: args.updates.map((update) => update.step_id),
            plan_completed: args.complete_plan ?? false,
          }),
          stderr: '',
        },
      });
      continue;
    }

    const mcpDescriptor =
      request.name.startsWith('mcp__') && call.bindingId
        ? params.mcpManager?.findCapability(
            params.state.capabilities.bindings[call.bindingId]?.capabilityId ?? '',
          )
        : undefined;
    const mcpPolicy = mcpDescriptor
      ? {
          effects: mcpDescriptor.effectiveEffects,
          minimumApproval: mcpDescriptor.policy.minimumApproval,
        }
      : undefined;
    const decision = evaluateToolApproval({
      toolName: request.name,
      toolArgs: request.args as Record<string, unknown>,
      phase: getAgentPhase(getActivePlanning(params.state)),
      workspace: params.state.session.workspace,
      threadId: params.state.session.threadId,
      authorization: params.state.authorization,
      ...(mcpPolicy ? { mcpPolicy } : {}),
    });
    if (!decision.allowed) {
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason: decision.userVisibleSummary,
        failure: classifyFailure('policy_denied', decision.userVisibleSummary),
      });
      continue;
    }
    const requiresEffectReview =
      !isReadOnlyMcpPolicy(mcpPolicy) &&
      params.state.authorization.mode !== 'full_access' &&
      getEffectiveInteractionMode(params.state) !== 'full' &&
      Boolean(
        decision.effects?.network ||
          decision.effects?.externalWrite ||
          decision.effects?.uncertainEffects,
      );
    const requiresDirectMcpApproval = mcpDescriptor?.policy.minimumApproval === 'user';
    if (
      (decision.requiresApproval || requiresEffectReview || requiresDirectMcpApproval) &&
      call.status !== 'approved'
    ) {
      // Delegate mode-specific routing to mode-policy
      const effectiveMode = getEffectiveInteractionMode(params.state);
      const modePolicy = createModePolicy(effectiveMode);
      const modeDecision = modePolicy.shouldApproveTool({
        interactionMode: effectiveMode as InteractionMode,
        phase: getAgentPhase(getActivePlanning(params.state)),
        planKind: getActivePlanning(params.state).kind,
        toolName: request.name,
        toolRisk: decision.risk,
        effects: decision.effects,
        circuitBreakerTripped: params.state.autoReview.circuitBreakerTripped,
      });

      if (requiresDirectMcpApproval) {
        const approval = buildToolApproval({
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          request,
          decision,
          ...(mcpDescriptor && call.capabilityId && call.capabilityRevision
            ? {
                capability: {
                  capabilityId: call.capabilityId,
                  capabilityRevision: call.capabilityRevision,
                  effectiveEffects: mcpDescriptor.effectiveEffects,
                },
              }
            : {}),
        }) as import('@/protocol/events').ToolApprovalPayload;
        events.push({
          type: 'approval.requested',
          interactionId: genInteractionId(),
          toolCallId,
          approval,
        });
        continue;
      }
      if (modeDecision.kind === 'deny') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: modeDecision.reason ?? decision.userVisibleSummary,
          failure: classifyFailure(
            'policy_denied',
            modeDecision.reason ?? decision.userVisibleSummary,
          ),
        });
        continue;
      }

      if (modeDecision.kind === 'allow') {
        // Mode policy auto-approves this tool (e.g. accept_edits file edits, full_access)
        // Fall through to direct execution below
      } else if (modeDecision.kind === 'need_auto_review') {
        const approval = buildToolApproval({
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          request,
          decision,
          ...(mcpDescriptor && call.capabilityId && call.capabilityRevision
            ? {
                capability: {
                  capabilityId: call.capabilityId,
                  capabilityRevision: call.capabilityRevision,
                  effectiveEffects: mcpDescriptor.effectiveEffects,
                },
              }
            : {}),
        }) as unknown as import('@/protocol/events').ToolApprovalPayload;
        events.push({
          type: 'auto_review.requested',
          reviewId: genInteractionId(),
          toolCallId,
          toolName: request.name,
          reason: decision.reason,
          approval,
        });
        continue;
      } else {
        const approval = buildToolApproval({
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          request,
          decision,
          ...(mcpDescriptor && call.capabilityId && call.capabilityRevision
            ? {
                capability: {
                  capabilityId: call.capabilityId,
                  capabilityRevision: call.capabilityRevision,
                  effectiveEffects: mcpDescriptor.effectiveEffects,
                },
              }
            : {}),
        }) as unknown as import('@/protocol/events').ToolApprovalPayload;
        events.push({
          type: 'approval.requested',
          interactionId: genInteractionId(),
          toolCallId,
          approval,
        });
        continue;
      }
    }

    if (request.name === 'task') {
      // ── Sub-agent approval resume path ──
      // When a sub-agent paused for approval, the task tool call was set to
      // 'approved' by the reducer.  Instead of starting a fresh sub-agent,
      // execute the blocked tool with the approved grant and resume.
      const suspended = params.state.suspendedSubagents[toolCallId];
      if (suspended && call.status === 'approved') {
        const restored = deserializeSubagentContinuation(suspended);
        const resumeEvents = await handleSubAgentResume({
          state: params.state,
          toolCallId,
          continuation: restored,
          shellExecutor: params.shellExecutor,
          mcpManager: params.mcpManager,
          skillManifests: params.skillManifests,
          skillOptions: params.skillOptions,
          signal: params.signal,
          taskConfig: params.taskConfig,
          taskModel: params.taskModel,
          emitSubagentEvent,
        });
        events.push(...resumeEvents);
        continue;
      }

      // ── Normal sub-agent execution ──
      events.push({ type: 'tool.started', toolCallId });
      const progress: RuntimeEvent[] = [];
      try {
        const result = await runApprovedTool({
          workspace: params.state.session.workspace,
          request,
          shellExecutor: params.shellExecutor,
          workspaceAccess: params.state.workspaceAccess,
          phase: getAgentPhase(getActivePlanning(params.state)),
          authorization: params.state.authorization,
          approvedGrant: call.approvalGrant ?? 'none',
          threadId: params.state.session.threadId,
          mcpManager: params.mcpManager,
          skillManifests: params.skillManifests,
          skillOptions: params.skillOptions,
          signal: params.signal,
          interactionMode: getEffectiveInteractionMode(params.state),
          taskConfig: params.taskConfig,
          taskModel: params.taskModel,
          subagentEventSink: emitSubagentEvent,
          onShellProgress: (chunk, stream) =>
            progress.push({ type: 'tool.progress', toolCallId, chunk, stream }),
        });
        events.push(...progress);

        // ── Sub-agent blocked for approval → surface through Runtime Kernel ──
        if (result.subagentResult?.blocked) {
          const blocked = result.subagentResult.blocked;
          const subagentId = blocked.continuation.id;
          // Serialize continuation into RuntimeState for persistence
          events.push({
            type: 'subagent.suspended',
            toolCallId,
            snapshot: serializeSubagentContinuation(blocked.continuation, {
              toolCallId: blocked.toolCallId,
              toolName: blocked.toolName,
              args: blocked.args,
              command: blocked.command,
            }),
          });

          // Build approval payload for the blocked sub-agent tool
          const blockedDecision = evaluateToolApproval({
            toolName: blocked.toolName,
            toolArgs: blocked.args,
            phase: getAgentPhase(getActivePlanning(params.state)),
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            authorization: params.state.authorization,
          });
          const blockedApproval = buildToolApproval({
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            request: {
              id: blocked.toolCallId,
              name: blocked.toolName,
              args: blocked.args,
              protectedCommand: blocked.command,
            } as import('@/core/harness/tool-requests').PendingToolRequest,
            decision: blockedDecision,
          }) as import('@/protocol/events').ToolApprovalPayload;
          blockedApproval.subagentId = subagentId;

          events.push({
            type: 'approval.requested',
            interactionId: genInteractionId(),
            toolCallId,
            approval: blockedApproval,
          });
          // Do NOT emit tool.finished — the task tool is paused, waiting for approval
          continue;
        }

        events.push({
          type: 'tool.finished',
          toolCallId,
          name: request.name,
          result: {
            ok: result.ok !== false,
            command: result.command ?? request.protectedCommand,
            exitCode: result.exitCode ?? 0,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            status:
              result.status === 'exhausted'
                ? 'exhausted'
                : result.ok === false
                  ? 'error'
                  : 'success',
          },
        });
      } catch (error) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'tool_runtime_error',
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
      continue;
    }

    const invocation = createMcpInvocationRecord({
      state: params.state,
      call,
      descriptor: mcpDescriptor,
      flags: params.taskConfig ? getFeatureFlags(params.taskConfig) : undefined,
    });
    const executionRequest =
      invocation?.idempotencyKeyArgument && invocation.idempotencyKey
        ? ({
            ...request,
            args: {
              ...request.args,
              [invocation.idempotencyKeyArgument]: invocation.idempotencyKey,
            },
          } as typeof request)
        : request;
    if (invocation) events.push(invocation.recorded);
    events.push({ type: 'tool.started', toolCallId });
    if (invocation) {
      events.push({
        type: 'capability.execution_started',
        invocationId: invocation.invocationId,
        startedAt: new Date().toISOString(),
      });
    }
    const progress: RuntimeEvent[] = [];
    try {
      const result = await runApprovedTool({
        workspace: params.state.session.workspace,
        request: executionRequest,
        shellExecutor: params.shellExecutor,
        workspaceAccess: params.state.workspaceAccess,
        phase: getAgentPhase(getActivePlanning(params.state)),
        authorization: params.state.authorization,
        approvedGrant: call.approvalGrant ?? 'none',
        threadId: params.state.session.threadId,
        mcpManager: params.mcpManager,
        ...(mcpPolicy ? { mcpPolicy } : {}),
        skillManifests: params.skillManifests,
        skillOptions: params.skillOptions,
        signal: params.signal,
        interactionMode: getEffectiveInteractionMode(params.state),
        taskConfig: params.taskConfig,
        taskModel: params.taskModel,
        subagentEventSink: emitSubagentEvent,
        onShellProgress: (chunk, stream) =>
          progress.push({ type: 'tool.progress', toolCallId, chunk, stream }),
      });
      events.push(...progress);

      if (invocation) {
        const terminal = invocationTerminalEvent(
          invocation.invocationId,
          result,
          new Date().toISOString(),
          capabilityArtifacts,
        );
        events.push(terminal);
        if (
          terminal.type === 'capability.execution_succeeded' &&
          mcpDescriptor &&
          params.taskConfig &&
          getFeatureFlags(params.taskConfig).verificationV1
        ) {
          events.push(
            verificationRequestForCapability({
              invocationId: invocation.invocationId,
              capabilityId: mcpDescriptor.capabilityId,
              effects: mcpDescriptor.effectiveEffects,
              taskId: call.taskId ?? params.state.activeTaskId ?? undefined,
              externalReferences: terminal.externalReferences,
            }),
          );
        }
      }

      // 文件变更事件 — write_file / edit_file 的结果通知 TUI
      // File change event — notify TUI of write_file / edit_file results
      if (result.ok !== false && (request.name === 'write_file' || request.name === 'edit_file')) {
        const filePath = String((request.args as Record<string, unknown>).path ?? '');
        if (filePath) {
          events.push({
            type: 'tool.file_change',
            toolCallId,
            path: filePath,
            kind: request.name === 'edit_file' ? 'edit' : 'add',
            preview: (result.stdout ?? result.stderr ?? '').slice(0, 500) || undefined,
          });
        }
      }

      events.push({
        type: 'tool.finished',
        toolCallId,
        name: request.name,
        result: {
          ok: result.ok !== false,
          command: result.command ?? request.protectedCommand,
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          status:
            result.status === 'exhausted' ? 'exhausted' : result.ok === false ? 'error' : 'success',
        },
      });
    } catch (error) {
      if (invocation) {
        events.push({
          type: 'capability.execution_failed',
          invocationId: invocation.invocationId,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        });
      }
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'tool_runtime_error',
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }
  return events;
}

function createMcpInvocationRecord(params: {
  state: RuntimeState;
  call: RuntimeState['tools']['calls'][string];
  descriptor: import('@/protocol/capabilities').CapabilityDescriptor | undefined;
  flags: ReturnType<typeof getFeatureFlags> | undefined;
}):
  | {
      invocationId: string;
      idempotencyKey?: string;
      idempotencyKeyArgument?: string;
      recorded: Extract<RuntimeEvent, { type: 'capability.invocation_recorded' }>;
    }
  | undefined {
  if (
    !params.flags?.mcpExecutionRecordV1 ||
    !params.call.name.startsWith('mcp__') ||
    !params.descriptor ||
    !requiresDurableInvocation(params.descriptor.effectiveEffects)
  ) {
    return undefined;
  }
  const invocationId = digestCapability({
    threadId: params.state.session.threadId,
    toolCallId: params.call.toolCallId,
    capabilityId: params.descriptor.capabilityId,
    capabilityRevision: params.descriptor.revision,
    arguments: params.call.args,
  });
  const planning = getActivePlanning(params.state);
  const planId = 'document' in planning ? planning.document?.planId : undefined;
  const authorizationDigest = digestCapability({
    approvalHash: params.call.approvalHash ?? null,
    approvalGrant: params.call.approvalGrant ?? 'none',
    threadId: params.state.session.threadId,
    taskId: params.call.taskId ?? params.state.activeTaskId ?? null,
  });
  const idempotencyKeyArgument = params.descriptor.execution?.idempotencyKeyArgument;
  const idempotencyKey =
    params.descriptor.execution?.retry === 'idempotency_key' && idempotencyKeyArgument
      ? digestCapability({ invocationId, capabilityId: params.descriptor.capabilityId })
      : undefined;
  return {
    invocationId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(idempotencyKeyArgument ? { idempotencyKeyArgument } : {}),
    recorded: {
      type: 'capability.invocation_recorded',
      invocationId,
      toolCallId: params.call.toolCallId,
      capabilityId: params.descriptor.capabilityId,
      capabilityRevision: params.descriptor.revision,
      ...((params.call.taskId ?? params.state.activeTaskId)
        ? { taskId: params.call.taskId ?? params.state.activeTaskId ?? undefined }
        : {}),
      ...(planId ? { planId } : {}),
      argumentsDigest: digestCapability(params.call.args),
      authorizationDigest,
      effectiveEffectsDigest: digestCapability(params.descriptor.effectiveEffects),
      effectiveEffects: params.descriptor.effectiveEffects,
      recordedAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

function requiresDurableInvocation(
  effects: import('@/protocol/capabilities').EffectProfile,
): boolean {
  return [effects.filesystem, effects.network, effects.externalState].some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

function invocationTerminalEvent(
  invocationId: string,
  result: ToolExecutionResult,
  finishedAt: string,
  artifactStore: CapabilityArtifactStore,
): Extract<
  RuntimeEvent,
  { type: 'capability.execution_succeeded' | 'capability.execution_failed' }
> {
  if (
    result.ok === false ||
    !result.capabilityResult ||
    result.capabilityResult.status !== 'success'
  ) {
    return {
      type: 'capability.execution_failed',
      invocationId,
      error:
        result.capabilityResult?.error?.message ??
        result.stderr ??
        'MCP provider did not produce a successful capability result.',
      finishedAt,
    };
  }
  const externalReferences = result.capabilityResult.content.flatMap((content) => {
    const uri = typeof content.uri === 'string' ? content.uri : undefined;
    const nestedUri =
      content.resource &&
      typeof content.resource === 'object' &&
      typeof (content.resource as Record<string, unknown>).uri === 'string'
        ? ((content.resource as Record<string, unknown>).uri as string)
        : undefined;
    return [uri, nestedUri].filter((value): value is string => Boolean(value));
  });
  let artifact: import('@/protocol/capabilities').CapabilityArtifactRef | undefined;
  try {
    artifact = artifactStore.write(invocationId, result.capabilityResult);
  } catch {
    // The result remains available in the current turn, but a receipt never
    // claims evidence that failed to reach the restricted Artifact Store.
  }
  return {
    type: 'capability.execution_succeeded',
    invocationId,
    resultDigest: digestCapability(result.capabilityResult),
    evidenceDigest: digestCapability({
      content: result.capabilityResult.content,
      structuredContent: result.capabilityResult.structuredContent,
    }),
    finishedAt,
    ...(artifact ? { artifact } : {}),
    ...(externalReferences.length > 0 ? { externalReferences } : {}),
  };
}
