// ── Model Controller / 模型控制器 ──
// Kernel 原生模型调用：从 RuntimeState 构建上下文 → 调用模型 → 返回 RuntimeEvent[]。
// 不依赖 LangGraph 状态、不产生副作用。
//
// Kernel-native model invocation: build context from RuntimeState → call model → return RuntimeEvent[].
// No LangGraph state dependency, no side effects.

import { extractPromptCacheMetrics } from '@/core/cache-metrics';
import { createBinding } from '@/core/capabilities/catalog';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import type { McpManager } from '@/core/mcp';
import {
  type AIMessage,
  aiMessage,
  type BaseMessage,
  humanMessage,
  toolMessage,
} from '@/core/messages';
import { prepareModelContext } from '@/core/model/context';
import type { SupportedChatModel } from '@/core/model/factory';
import { invokeBoundModel } from '@/core/model/invoke';
import { classifyToolCapability } from '@/core/policies/tool-capabilities';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import { genInteractionId } from '@/core/runtime/ids';
import type { RuntimeState, TranscriptMessage } from '@/core/runtime/state';
import {
  getActivePlanning,
  getActiveTask,
  getAgentPhase,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import { skillFrameInvalidationReason } from '@/core/skills/activation';
import type { SkillCatalogSnapshot } from '@/core/skills/catalog';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import { createAgentTools } from '@/core/tools/definitions';
import type { ShellExecutor } from '@/core/tools/shell';

// ── 辅助函数 / Helpers ──

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((block: unknown) => {
        if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
          return String((block as Record<string, unknown>).text);
        }
        return '';
      })
      .join('');
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function extractReasoningText(message: AIMessage | undefined): string | undefined {
  const reasoning =
    (message?.additional_kwargs?.reasoning_content as string | undefined) ??
    ((message as unknown as Record<string, unknown> | undefined)?.reasoning_content as
      | string
      | undefined);
  return reasoning && reasoning.length > 0 ? reasoning : undefined;
}

/** Convert invalid provider tool arguments into durable queued-and-failed facts. */
export function eventsForInvalidModelToolCalls(
  calls: Array<{ id: string; name: string; args: { _parse_error?: string } }>,
  messageId: string,
  ordinalStart: number,
): RuntimeEvent[] {
  return calls.flatMap((call, index) => [
    {
      type: 'tool.queued' as const,
      toolCallId: call.id,
      name: call.name,
      args: call.args,
      modelMessageId: messageId,
      ordinal: ordinalStart + index,
    },
    {
      type: 'tool.failed' as const,
      toolCallId: call.id,
      failure: classifyFailure(
        'model_invalid_tool_args',
        String(call.args._parse_error ?? 'invalid model tool arguments'),
      ),
    },
  ]);
}

function runtimeTranscriptMessages(messages: TranscriptMessage[]): BaseMessage[] {
  return messages.map((message) => {
    switch (message.kind) {
      case 'user':
        return humanMessage({ id: message.messageId, content: message.content });
      case 'assistant':
        return aiMessage({
          id: message.messageId,
          content: message.content ?? '',
          tool_calls: message.toolCalls.map((call) => ({
            ...call,
            args: (call.args ?? {}) as Record<string, unknown>,
            type: 'tool_call' as const,
          })),
          additional_kwargs: {
            ...(message.reasoningText ? { reasoning_content: message.reasoningText } : {}),
          },
        });
      case 'tool':
        return toolMessage({
          tool_call_id: message.toolCallId,
          name: message.name,
          content: message.content,
          status: message.ok ? 'success' : 'error',
        });
      default:
        return humanMessage({ content: '' });
    }
  });
}

function activeInlineSkillInstructions(
  state: RuntimeState,
  catalog: SkillCatalogSnapshot | undefined,
): string | undefined {
  if (!catalog) return undefined;
  const sections = Object.values(state.skills.frames)
    .filter((frame) => frame.status === 'active' && frame.contextMode === 'inline')
    .flatMap((frame) => {
      const entry = catalog.entries.find(
        (candidate) =>
          !candidate.shadowedBy &&
          candidate.descriptor.capabilityId === frame.skillId &&
          candidate.descriptor.revision === frame.skillRevision &&
          candidate.contract,
      );
      return entry?.contract
        ? [
            [
              `## Active Workflow Skill: ${entry.contract.name}`,
              entry.contract.instructions,
              entry.contract.files.some((path) =>
                /^(?:scripts|references|assets|evals)\//.test(path),
              )
                ? `Declared supporting files are not injected. Read one on demand with read_skill_reference using activation ID ${frame.activationId}: ${entry.contract.files.filter((path) => /^(?:scripts|references|assets|evals)\//.test(path)).join(', ')}`
                : '',
              `When finished, call complete_skill with this activation ID: ${frame.activationId}. Its output must match the contract schema.`,
            ]
              .filter(Boolean)
              .join('\n\n'),
          ]
        : [];
    });
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

/**
 * Kernel-native model effect.  It uses only RuntimeState and emits all model
 * facts required by the reducer, including transient retry events captured
 * from the model's built-in retry listener.
 */
export async function invokeRuntimeModel(params: {
  model: SupportedChatModel;
  state: RuntimeState;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  subagentEventSink?: SubAgentEventSink;
  signal?: AbortSignal;
  /** Persists bindings before the model can emit a dynamic MCP tool call. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
}): Promise<RuntimeEvent[]> {
  const { state } = params;
  const requestId = genInteractionId();
  const retryEvents: RuntimeEvent[] = [];

  // 注册 retry listener — 模型通过 transientRetryMiddleware 实现重试，
  // 通过 setRetryListener 回调来收集重试事件为 RuntimeEvent。
  // Register retry listener — the model retries via transientRetryMiddleware,
  // we collect retry events as RuntimeEvents through the listener callback.
  params.model.setRetryListener((attempt, maxAttempts, error, delayMs) => {
    retryEvents.push({
      type: 'model.retry',
      attempt,
      maxAttempts,
      error: typeof error === 'string' ? error : String(error).slice(0, 200),
      delayMs,
    });
  });

  try {
    const flags = getFeatureFlags(params.config);
    if (
      params.skillCatalog &&
      params.state.skills.catalogRevision !== params.skillCatalog.revision
    ) {
      params.emitRuntimeEvent?.({
        type: 'skill.catalog_refreshed',
        catalogRevision: params.skillCatalog.revision,
      });
    }
    if (params.skillCatalog) {
      for (const frame of Object.values(params.state.skills.frames)) {
        if (frame.status !== 'active') continue;
        const reason = skillFrameInvalidationReason(frame, params.skillCatalog);
        if (reason) {
          params.emitRuntimeEvent?.({
            type: 'skill.frame_closed',
            activationId: frame.activationId,
            status: 'invalidated',
            reason,
            closedAt: new Date().toISOString(),
          });
        }
      }
    }
    const mcpBindings =
      flags.capabilityCatalogV1 && flags.mcpRuntimeBindingV1 && params.mcpManager
        ? params.mcpManager
            .getCapabilitySnapshot()
            .descriptors.filter(
              (descriptor) =>
                descriptor.kind === 'mcp_tool' && descriptor.availability === 'available',
            )
            .map((descriptor) => ({
              descriptor,
              binding: createBinding({
                descriptor,
                exposedToolName: `mcp__${descriptor.provider.id}__${descriptor.displayName}`,
                turnId: state.turn.turnId,
              }),
            }))
        : [];
    if (mcpBindings.length > 0) {
      params.emitRuntimeEvent?.({
        type: 'capability.bindings_issued',
        catalogRevision: params.mcpManager?.getCapabilitySnapshot().revision ?? '',
        bindings: mcpBindings.map(({ binding }) => binding),
      });
    }
    const tools = createAgentTools({
      workspace: state.session.workspace,
      shellExecutor: params.shellExecutor,
      mcpManager: params.mcpManager,
      mcpBindings,
      skills: params.skills,
      skillOptions: params.skillOptions,
      skillCatalog: params.skillCatalog,
      activeSkillFrames: Object.values(state.skills.frames).filter(
        (frame) => frame.status === 'active' && frame.contextMode === 'inline',
      ),
      config: params.config,
      subagentEventSink: params.subagentEventSink,
      subagentSignal: params.signal,
      signal: params.signal,
      model: params.model,
      threadId: state.session.threadId,
      authorization: state.authorization,
      workspaceAccess: state.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(state)),
      interactionMode: getEffectiveInteractionMode(state),
    });
    const planning = getActivePlanning(state);
    const phase = getAgentPhase(planning);
    const prepared = prepareModelContext(
      'agent',
      {
        workspace: state.session.workspace,
        messages: runtimeTranscriptMessages(state.transcript.messages),
        final: state.transcript.final ?? '',
        workspaceAccess: state.workspaceAccess,
        phase,
        interactionMode: getEffectiveInteractionMode(state),
        authorization: state.authorization,
        planningState: planning,
        taskId: getActiveTask(state)?.taskId,
        sideEffectsStarted: getActiveTask(state)?.sideEffectsStarted,
        workflowSkills: params.skillCatalog?.capabilities.descriptors
          .filter(
            (descriptor) => descriptor.kind === 'skill' && descriptor.availability === 'available',
          )
          .map((descriptor) => ({
            capabilityId: descriptor.capabilityId,
            description: descriptor.description,
          })),
        activeSkillInstructions: activeInlineSkillInstructions(state, params.skillCatalog),
      },
      undefined,
    );
    const response = await invokeBoundModel({
      model: params.model,
      tools,
      messages: prepared.messages,
      signal: params.signal,
    });
    const toolCalls =
      response.tool_calls?.map((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: call.name,
        args: call.args,
      })) ?? [];
    const invalidToolCalls = (
      (
        response as unknown as {
          invalid_tool_calls?: Array<{ id?: string; name?: string; args?: string; error?: string }>;
        }
      ).invalid_tool_calls ?? []
    )
      .filter(
        (call): call is { id?: string; name: string; args: string; error?: string } =>
          typeof call.name === 'string' && typeof call.args === 'string',
      )
      .map((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: call.name,
        args: {
          _raw_invalid_args: call.args,
          _parse_error: call.error ?? 'invalid JSON arguments',
        },
      }));
    const events: RuntimeEvent[] = [
      ...retryEvents,
      { type: 'model.requested', requestId },
      {
        type: 'model.responded',
        messageId: response.id ?? requestId,
        toolCalls: [...toolCalls, ...invalidToolCalls],
        reasoningText: extractReasoningText(response),
        text: extractText(response.content),
      },
    ];

    const cacheMetrics = extractPromptCacheMetrics(response);
    if (cacheMetrics && (cacheMetrics.cacheHitTokens > 0 || cacheMetrics.cacheMissTokens > 0)) {
      events.push({
        type: 'model.cache_metrics',
        inputTokens: cacheMetrics.inputTokens,
        cacheHitTokens: cacheMetrics.cacheHitTokens,
        cacheMissTokens: cacheMetrics.cacheMissTokens,
        hitRate: cacheMetrics.hitRate,
      });
    }

    const messageId = response.id ?? requestId;
    let ordinal = 0;
    for (const call of toolCalls) {
      const capability = classifyToolCapability(call.name, call.args);
      const binding = mcpBindings.find(
        ({ binding: candidate }) => candidate.exposedToolName === call.name,
      )?.binding;
      events.push({
        type: 'tool.queued',
        toolCallId: call.id,
        taskId: params.state.activeTaskId ?? undefined,
        name: call.name,
        args: call.args,
        modelMessageId: messageId,
        ordinal: ordinal++,
        effectClass: capability.effectClass,
        sideEffect: capability.sideEffect,
        classificationReason: capability.classificationReason,
        ...(binding
          ? {
              bindingId: binding.bindingId,
              capabilityId: binding.capabilityId,
              capabilityRevision: binding.capabilityRevision,
            }
          : {}),
      });
    }
    events.push(...eventsForInvalidModelToolCalls(invalidToolCalls, messageId, ordinal));
    return events;
  } finally {
    params.model.setRetryListener(null);
  }
}
