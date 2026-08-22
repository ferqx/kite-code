// ── Unified Context Projection / 统一上下文投影 ──
// Single pure-function entry point for all model context construction paths:
// normal invocation, preflight, /context, M2 candidate validation,
// checkpoint restore, debug export, and shadow auto-compaction evaluation.
//
// No path may implement its own token calculation or transcript truncation rules.

import { createHash } from 'node:crypto';
import type { SkillManifest } from '../skills/types';
import { serializeCompactionSummary } from './compaction-summary-frame';
import {
  type AgentRole,
  buildStaticSystemPrompt,
  type PromptContractVersion,
  reorderInterleavedMessages,
  sanitizeToolCallPairs,
} from './context';
import { type ContextTokenEstimate, estimateContextTokens } from './context-budget';
import type { ContextFrame } from './context-frame';
import { buildCanonicalFrames } from './context-frame-builder';
import { serializeFramesToMessages } from './context-serializer';
import { validateFramePairs, validateMessagePairs } from './context-validator';
import { aiMessage, type BaseMessage, humanMessage, systemMessage, toolMessage } from './messages';
import {
  formatProjectInstructionSnapshot,
  type ProjectInstructionSnapshot,
} from './project-instructions';
import { buildCacheableRuntimeContext, buildRuntimeModeSnapshot } from './runtime-context';
import {
  type BuiltinContextCheckpointViewV1,
  type BuiltinRuntimeStateViewV1,
  type BuiltinSandboxBackendV1,
  getBuiltinActivePlanningV1,
  getBuiltinActiveTaskV1,
  getBuiltinAgentPhaseV1,
  getBuiltinEffectiveInteractionModeV1,
} from './runtime-view';

// ── Types ──

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
  promptContractVersion?: PromptContractVersion;
  projectInstructions?: ProjectInstructionSnapshot;
  sandboxBackend?: BuiltinSandboxBackendV1 | 'unknown';
  /** Inputs that can change projection/summary semantics without changing tool schemas. */
  leaseMetadata?: {
    providerName: string;
    modelName: string;
    modelCapabilities: unknown;
    estimator: string;
    summaryPolicy: unknown;
  };
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
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
  };
  return createHash('sha256')
    .update(
      stable({
        tools: env.serializedTools
          .map((tool) => ({
            name: tool.name,
            description: tool.description ?? null,
            schemaDigest: tool.schemaDigest,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        skills: env.activeSkillInstructions ?? null,
        workflows: env.workflowSkills
          .map((workflow) => ({
            capabilityId: workflow.capabilityId,
            description: workflow.description,
          }))
          .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
        promptContractVersion: env.promptContractVersion ?? 'legacy',
        projectInstructionRevision: env.projectInstructions?.revision ?? null,
        sandboxBackend: env.sandboxBackend ?? 'unknown',
        leaseMetadata: env.leaseMetadata ?? null,
      }),
    )
    .digest('hex');
}

/** Input to the unified context projection. */
export interface BuildContextProjectionInput {
  role: AgentRole;
  /** Full RuntimeState — the function derives all needed fields internally. */
  state: Readonly<BuiltinRuntimeStateViewV1>;
  /** Serialized tool descriptors for token estimation (PR 1 — pure data, no runtime objects). */
  serializedTools?: SerializedToolDescriptor[];
  /** Override the active checkpoint for candidate validation (PR 5). */
  candidateCheckpoint?: BuiltinContextCheckpointViewV1;
  /** Active skill instructions injected into the system prompt. */
  activeSkillInstructions?: string;
  /** Skill manifests for the system prompt. */
  skills?: SkillManifest[];
  /** Workflow skill descriptors for the system prompt. */
  workflowSkills?: Array<{ capabilityId: string; description: string }>;
  promptContractVersion?: PromptContractVersion;
  projectInstructions?: ProjectInstructionSnapshot;
  sandboxBackend?: BuiltinSandboxBackendV1 | 'unknown';
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

function runtimeTranscriptMessages(state: Readonly<BuiltinRuntimeStateViewV1>): BaseMessage[] {
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
              id: call.id,
              name: call.name,
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

function checkpointSummaryMessage(checkpoint: BuiltinContextCheckpointViewV1): BaseMessage {
  return aiMessage({
    content: serializeCompactionSummary(checkpoint.summary),
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
  const frames = buildCanonicalFrames(msgs);
  validateFramePairs(frames);

  // ── 4. Serialize frames back to messages ──
  msgs = serializeFramesToMessages(frames);
  validateMessagePairs(msgs);

  // ── 6. Build system messages ──
  const promptContractVersion = input.promptContractVersion ?? 'legacy';
  const staticPrompt = buildStaticSystemPrompt(
    input.role,
    input.skills,
    input.workflowSkills,
    promptContractVersion,
  );
  const cacheableEnvironment =
    buildCacheableRuntimeContext({ workspace: input.state.session.workspace }) +
    (input.activeSkillInstructions
      ? `\n\n## Active Workflow Instructions\n\n${input.activeSkillInstructions}`
      : '');
  const systemMessages =
    promptContractVersion === 'v2'
      ? [systemMessage(staticPrompt), systemMessage(cacheableEnvironment)]
      : [systemMessage(`${staticPrompt}\n\n${cacheableEnvironment}`)];
  const projectInstructionMessages =
    input.projectInstructions &&
    (input.projectInstructions.documents.length > 0 ||
      input.projectInstructions.warnings.length > 0)
      ? [humanMessage(formatProjectInstructionSnapshot(input.projectInstructions))]
      : [];

  // ── 7. Build dynamic runtime messages ──
  const planning = getBuiltinActivePlanningV1(input.state);
  const phase = getBuiltinAgentPhaseV1(planning);
  const interactionMode = getBuiltinEffectiveInteractionModeV1(input.state);
  const activeTask = getBuiltinActiveTaskV1(input.state);

  const modeSnapshot = humanMessage(
    buildRuntimeModeSnapshot({
      phase,
      interactionMode,
      authorizationMode: input.state.authorization?.mode ?? 'default',
      sandboxBackend: input.sandboxBackend ?? 'unknown',
      planningState: planning.kind !== 'planning_empty' ? planning : undefined,
      taskId: activeTask?.taskId,
      sideEffectsStarted: activeTask?.sideEffectsStarted,
    }),
  );

  const dynamicRuntimeMessages = [modeSnapshot];

  // ── 8. Compute complete token estimate (including tool schemas) ──
  const estimate = estimateContextTokens({
    systemMessages,
    transcriptMessages: [...projectInstructionMessages, ...msgs],
    summaryMessages,
    dynamicRuntimeMessages,
    serializedTools: input.serializedTools,
  });

  // ── 9. Assemble final provider-ready messages ──
  const providerMessages: BaseMessage[] = [
    ...systemMessages,
    ...summaryMessages,
    ...msgs,
    // Project rules refresh from disk for each request. Keep them after the
    // durable conversation prefix so a changed rule does not invalidate the
    // system/history cache; they still precede the generated runtime state.
    ...projectInstructionMessages,
    ...dynamicRuntimeMessages,
  ];

  return {
    systemMessages,
    summaryMessages,
    transcriptMessages: msgs,
    dynamicRuntimeMessages,
    frames,
    providerMessages,
    estimate,
  };
}
