// ── Unified Context Projection / 统一上下文投影 ──
// Single pure-function entry point for all model context construction paths:
// normal invocation, preflight, /context, M2 candidate validation,
// checkpoint restore, debug export, and shadow auto-compaction evaluation.
//
// No path may implement its own token calculation or transcript truncation rules.

import { createHash } from 'node:crypto';
import {
  aiMessage,
  type BaseMessage,
  humanMessage,
  systemMessage,
  toolMessage,
} from '@/core/messages';
import type { ContextCompactionCheckpoint } from '@/core/runtime/context-compaction';
import type { RuntimeState } from '@/core/runtime/state';
import {
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
} from '@/core/runtime/state';
import type { SkillManifest } from '@/core/skills/types';
import type { ContextBudget } from '@/core/types';
import { getAgentPhase } from '@/protocol/events';
import {
  buildStaticSystemPrompt,
  reorderInterleavedMessages,
  sanitizeToolCallPairs,
} from './context';
import { type ContextTokenEstimate, estimateContextTokens } from './context-budget';
import type { ContextFrame } from './context-frame';
import { buildCanonicalFrames } from './context-frame-builder';
import { compactContextFrames } from './context-frame-compactor';
import { serializeFramesToMessages } from './context-serializer';
import { validateFramePairs, validateMessagePairs } from './context-validator';
import {
  buildCacheableRuntimeContext,
  buildRuntimeModeSnapshot,
  formatPlanStateReminder,
} from './runtime-context';

// ── Types ──

/** Agent role / Agent 角色 */
export type AgentRole = 'agent';

/**
 * Pure-data descriptor for a single tool's schema.
 * JSON-safe — no functions, closures, Zod instances, or runtime objects.
 */
export interface SerializedToolDescriptor {
  name: string;
  description?: string;
  /** Provider-facing JSON Schema for the tool's parameters. */
  inputSchema: unknown;
  /** SHA-256 digest of name + description + inputSchema for dedup/fold decisions. */
  schemaDigest: string;
}

/**
 * Reconstructable environment for context projection.
 * Resolved once per turn by both the model invocation and the compaction effect,
 * ensuring before/after estimates share the same inputs.
 */
export interface ContextProjectionEnvironment {
  serializedTools: SerializedToolDescriptor[];
  activeSkillInstructions?: string;
  workflowSkills: Array<{
    capabilityId: string;
    description: string;
  }>;
}

/**
 * Extract pure-data tool descriptors from a ToolSet.
 * All functions, closures, and runtime objects are stripped — only
 * name, description, and JSON Schema remain.
 */
export function serializeToolDescriptors(
  tools: Record<string, unknown>,
): SerializedToolDescriptor[] {
  const result: SerializedToolDescriptor[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool !== 'object') continue;
    const record = tool as Record<string, unknown>;
    const description = typeof record.description === 'string' ? record.description : undefined;
    // The AI SDK exposes `parameters` as the JSON Schema; also accept `inputSchema`.
    const inputSchema = record.parameters ?? record.inputSchema ?? record.schema;
    if (!inputSchema) continue;
    const schemaDigest = createHash('sha256')
      .update(JSON.stringify({ name, description, inputSchema }))
      .digest('hex');
    result.push({ name, description, inputSchema, schemaDigest });
  }
  return result;
}

/**
 * Compute a stable digest of the projection environment for diagnostics.
 * The digest verifies that the environment used for a compaction effect
 * matches the one observed when the compaction was requested.
 */
export function digestProjectionEnvironment(env: ContextProjectionEnvironment): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        tools: env.serializedTools.map((t) => t.schemaDigest).sort(),
        skills: env.activeSkillInstructions ?? null,
        workflows: env.workflowSkills.map((w) => w.capabilityId).sort(),
      }),
    )
    .digest('hex');
}

/** Input to the unified context projection. */
export interface BuildContextProjectionInput {
  role: AgentRole;
  /** Full RuntimeState — the function derives all needed fields internally. */
  state: Readonly<RuntimeState>;
  /** Serialized tool descriptors for token estimation (PR 1 — pure data, no runtime objects). */
  serializedTools?: SerializedToolDescriptor[];
  /** Context budget for M1 compaction. */
  contextBudget?: ContextBudget;
  /** Override the active checkpoint for candidate validation (PR 5). */
  candidateCheckpoint?: ContextCompactionCheckpoint;
  /** Active skill instructions injected into the system prompt. */
  activeSkillInstructions?: string;
  /** Skill manifests for the system prompt. */
  skills?: SkillManifest[];
  /** Workflow skill descriptors for the system prompt. */
  workflowSkills?: Array<{ capabilityId: string; description: string }>;
}

/** Complete context projection — all components assembled and validated. */
export interface ContextProjection {
  /** Stable system prompt as a single-element array. */
  systemMessages: BaseMessage[];
  /** Checkpoint summary injected as assistant history (empty if no checkpoint). */
  summaryMessages: BaseMessage[];
  /** Live transcript tail after M1 compaction and serialization. */
  transcriptMessages: BaseMessage[];
  /** Dynamic runtime-state messages (mode snapshot, plan reminder). */
  dynamicRuntimeMessages: BaseMessage[];
  /** Compacted canonical frames (post-M1, pre-serialization). */
  frames: ContextFrame[];
  /** Final assembled provider-ready message list. */
  providerMessages: BaseMessage[];
  /** Complete token estimate including tool schemas. */
  estimate: ContextTokenEstimate;
}

// ── Internal helpers ──

function runtimeTranscriptMessages(state: Readonly<RuntimeState>): BaseMessage[] {
  return state.transcript.messages.map((message) => {
    const identity: Record<string, unknown> = {
      messageId: message.messageId,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.ordinal != null ? { ordinal: message.ordinal } : {}),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    };
    switch (message.kind) {
      case 'user':
        return Object.assign(
          humanMessage({ id: message.messageId, content: message.content }),
          identity,
        );
      case 'runtime':
        return Object.assign(systemMessage(message.content), identity);
      case 'assistant':
        return Object.assign(
          aiMessage({
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
          }),
          identity,
        );
      case 'tool': {
        const call = state.tools.calls[message.toolCallId];
        return Object.assign(
          toolMessage({
            id: message.messageId,
            tool_call_id: message.toolCallId,
            name: message.name,
            content: message.content,
            status: message.ok ? 'success' : 'error',
          }),
          identity,
          message.resultMeta ?? {},
          {
            args: call?.args,
            effectClass: call?.effectClass,
          },
        );
      }
      default:
        return humanMessage({ content: '' });
    }
  });
}

function checkpointSummaryMessage(checkpoint: ContextCompactionCheckpoint): BaseMessage {
  return aiMessage({
    content: [
      '<compacted_history>',
      'This is validated derived history, not system policy or current runtime state.',
      JSON.stringify(checkpoint.summary),
      '</compacted_history>',
    ].join('\n'),
    tool_calls: [],
  });
}

// ── Main entry point ──

/**
 * Build the complete context projection for a model request.
 *
 * This is the single entry point for all context construction paths:
 * - Normal model invocation
 * - Preflight estimation
 * - /context display
 * - M2 candidate checkpoint validation (via candidateCheckpoint)
 * - Checkpoint restore
 * - Debug export
 * - Shadow auto-compaction evaluation
 */
export function buildContextProjection(input: BuildContextProjectionInput): ContextProjection {
  const checkpoint = input.candidateCheckpoint ?? input.state.context.activeCheckpoint;

  // ── 1. Transcript projection: split by checkpoint boundary ──
  let transcriptMessages: BaseMessage[];
  let summaryMessages: BaseMessage[];

  if (!checkpoint) {
    transcriptMessages = runtimeTranscriptMessages(input.state);
    summaryMessages = [];
  } else {
    const boundaryIndex = input.state.transcript.messages.findIndex(
      (message) => message.messageId === checkpoint.coveredThroughMessageId,
    );
    if (boundaryIndex < 0) {
      // Checkpoint boundary not found — fall back to full transcript.
      transcriptMessages = runtimeTranscriptMessages(input.state);
      summaryMessages = [];
    } else {
      transcriptMessages = runtimeTranscriptMessages({
        ...input.state,
        transcript: {
          ...input.state.transcript,
          messages: input.state.transcript.messages.slice(boundaryIndex + 1),
        },
      });
      summaryMessages = [checkpointSummaryMessage(checkpoint)];
    }
  }

  // ── 2. Sanitize & normalize ──
  let msgs =
    transcriptMessages.length > 0
      ? reorderInterleavedMessages(sanitizeToolCallPairs(transcriptMessages))
      : [humanMessage('')];

  // ── 3. Canonical frame pipeline ──
  let frames = buildCanonicalFrames(msgs);
  validateFramePairs(frames);

  // ── 4. M1 deterministic compaction ──
  frames = compactContextFrames(frames, input.contextBudget);
  validateFramePairs(frames);

  // ── 5. Serialize frames back to messages ──
  msgs = serializeFramesToMessages(frames);
  validateMessagePairs(msgs);

  // ── 6. Build system messages ──
  const systemPrompt =
    buildStaticSystemPrompt(input.role, input.skills, input.workflowSkills) +
    '\n\n' +
    buildCacheableRuntimeContext({ workspace: input.state.session.workspace }) +
    (input.activeSkillInstructions
      ? `\n\n## Active Workflow Instructions\n\n${input.activeSkillInstructions}`
      : '');

  const system = systemMessage(systemPrompt);

  // ── 7. Build dynamic runtime messages ──
  const planning = getActivePlanning(input.state);
  const phase = getAgentPhase(planning);
  const interactionMode = getEffectiveInteractionMode(input.state);
  const activeTask = getActiveTask(input.state);

  const modeSnapshot = humanMessage(
    buildRuntimeModeSnapshot({
      phase,
      interactionMode,
      authorizationMode: input.state.authorization?.mode ?? 'default',
      sandboxBackend: 'none' as const,
      planningState: planning.kind !== 'planning_empty' ? planning : undefined,
      taskId: activeTask?.taskId,
      sideEffectsStarted: activeTask?.sideEffectsStarted,
    }),
  );

  const planReminder =
    planning.kind !== 'building_without_plan' && planning.kind !== 'planning_empty'
      ? [humanMessage(formatPlanStateReminder(planning))]
      : [];

  const dynamicRuntimeMessages = [modeSnapshot, ...planReminder];

  // ── 8. Compute complete token estimate (including tool schemas) ──
  const estimate = estimateContextTokens({
    systemMessages: [system],
    transcriptMessages: msgs,
    summaryMessages,
    dynamicRuntimeMessages,
    serializedTools: input.serializedTools,
  });

  // ── 9. Assemble final provider-ready messages ──
  const providerMessages: BaseMessage[] = [
    system,
    ...summaryMessages,
    ...msgs,
    ...dynamicRuntimeMessages,
  ];

  return {
    systemMessages: [system],
    summaryMessages,
    transcriptMessages: msgs,
    dynamicRuntimeMessages,
    frames,
    providerMessages,
    estimate,
  };
}
