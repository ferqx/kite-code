import {
  isIdentifier,
  RUNTIME_TOOL_DISPLAY_NAMES_,
  type RuntimeClientEvent,
  type RuntimeToolDisplayName,
} from '@kite-ai/runtime-contract';
import { runtimeHostStateAssertCurrentRuntimeEvent } from '@kite-ai/runtime-host';
import type { RuntimeEvent } from '../bootstrap/runtime/state-runtime';
import { projectRuntimeClientCommand, projectRuntimeClientText } from './safe-text';

export interface RuntimeClientEventProjectionContext {
  readonly sessionRevision: number;
}

/**
 * Exhaustive safety boundary from current State facts to the closed Client vocabulary.
 * Unsupported current facts are omitted; raw objects never pass through.
 */
export function projectRuntimeClientEvent(
  event: RuntimeEvent,
  context: RuntimeClientEventProjectionContext,
): RuntimeClientEvent | undefined {
  runtimeHostStateAssertCurrentRuntimeEvent(event);
  switch (event.type) {
    case 'user.message_appended':
      return {
        type: 'user.message',
        messageId: event.messageId,
        kind: 'task',
        text: projectRuntimeClientText(event.content),
      };
    case 'model.requested':
      return { type: 'model.requested', requestId: event.requestId };
    case 'planning.entered':
      return { type: 'planning.entered', taskId: event.taskId };
    case 'planning.exited':
      return { type: 'planning.exited', taskId: event.taskId };
    case 'interaction_mode.changed':
      return { type: 'interaction_mode.changed', mode: event.mode };
    case 'model.text_delta':
      return {
        type: 'model.text_delta',
        requestId: event.requestId,
        text: projectRuntimeClientText(event.text),
      };
    case 'model.responded':
      return {
        type: 'model.responded',
        requestId: projectRuntimeModelResponseRequestId(event),
        messageId: event.messageId,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        toolCallCount: event.toolCalls?.length ?? 0,
        ...(event.text ? { summary: projectRuntimeClientText(event.text) } : {}),
      };
    case 'model.retry':
      return {
        type: 'model.retry',
        requestId: event.invocationId,
        attempt: event.attempt,
        delayMs: event.delayMs,
      };
    case 'model.cache_metrics':
      return {
        type: 'model.cache',
        inputTokens: event.inputTokens,
        cacheHitTokens: event.cacheHitTokens,
        cacheMissTokens: event.cacheMissTokens,
      };
    case 'tool.queued':
      return {
        type: 'tool.queued',
        toolId: event.toolCallId,
        ...(event.modelMessageId === undefined
          ? {}
          : { presentationGroupId: event.modelMessageId }),
        toolName: projectRuntimeToolDisplayName(event.name),
        ...toolDisplayLabelField(event.name),
        presentation: projectRuntimeToolPresentation(event),
        arguments: projectRuntimeClientArguments(event.args),
        summary: 'Queued.',
      };
    case 'tool.started':
      return { type: 'tool.started', toolId: event.toolCallId };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        toolId: event.toolCallId,
        summary: projectRuntimeClientText(event.chunk, 8_192),
        stream: event.stream,
        ...(event.lineCount === undefined ? {} : { lineCount: event.lineCount }),
      };
    case 'tool.finished':
      return {
        type: 'tool.finished',
        toolId: event.toolCallId,
        toolName: projectRuntimeToolDisplayName(event.name),
        ...toolDisplayLabelField(event.name),
        presentation: projectRuntimeTerminalToolPresentation(event),
        result: projectRuntimeClientToolResult(event.result),
        summary: event.result.ok ? 'Completed.' : 'Failed.',
      };
    case 'tool.failed':
      return { type: 'tool.failed', toolId: event.toolCallId, summary: 'Tool execution failed.' };
    case 'tool.rejected':
      return {
        type: 'tool.rejected',
        toolId: event.toolCallId,
        summary: 'Tool execution rejected.',
      };
    case 'tool.cancelled':
      return {
        type: 'tool.cancelled',
        toolId: event.toolCallId,
        summary: 'Tool execution cancelled.',
      };
    case 'tool.file_change':
      return {
        type: 'tool.file_changed',
        toolId: event.toolCallId,
        change: event.kind === 'add' ? 'added' : event.kind === 'edit' ? 'modified' : 'deleted',
        summary: 'Workspace file changed.',
      };
    case 'approval.requested': {
      const interaction = {
        kind: 'approval' as const,
        interactionId: event.interactionId,
        sessionRevision: context.sessionRevision,
        generation: event.queueGeneration ?? 0,
        grants: event.approval.grantOptions,
        command: projectRuntimeClientCommand(event.approval.command),
        title: projectRuntimeClientText(event.approval.tool, 8_192),
        summary: projectRuntimeClientText(event.approval.summary, 8_192),
      };
      return {
        type: 'approval.queued',
        interaction,
        queueSequence: event.queueSequence ?? 0,
      };
    }
    case 'approval.granted':
      return {
        type: 'approval.granted',
        interactionId: event.interactionId,
        generation: event.generation,
      };
    case 'approval.batch_released':
      return {
        type: 'approval.granted',
        interactionId: event.interactionId,
        generation: event.generation,
      };
    case 'approval.rejected':
      return {
        type: 'approval.rejected',
        interactionId: event.interactionId,
        generation: event.generation,
        summary: 'Approval rejected.',
      };
    case 'user_input.requested':
      return {
        type: 'input.requested',
        interaction: {
          kind: 'input',
          interactionId: event.interactionId,
          sessionRevision: context.sessionRevision,
          question: projectRuntimeClientText(event.request.question),
          allowFreeText: event.request.allow_free_text,
          options: event.request.options.map((option) => ({
            id: option.id,
            label: projectRuntimeClientText(option.label, 512),
            ...(option.description
              ? { description: projectRuntimeClientText(option.description, 1_024) }
              : {}),
          })),
        },
      };
    case 'user_input.answered':
      return { type: 'input.answered', interactionId: event.interactionId };
    case 'user_input.cancelled':
      return { type: 'input.cancelled', interactionId: event.interactionId };
    case 'plan.review_requested':
      return {
        type: 'plan.review_requested',
        interaction: {
          kind: 'plan_review',
          interactionId: event.interactionId,
          sessionRevision: context.sessionRevision,
          plan: {
            planId: event.planId,
            version: event.version,
            structuralDigest: event.structuralDigest,
          },
          title: projectRuntimeClientText(event.plan.name, 8_192),
          summary: projectRuntimeClientText(event.planSummary, 8_192),
        },
      };
    case 'plan.progress_updated':
      return {
        type: 'plan.progress',
        planId: event.planId,
        version: event.version,
        structuralDigest: event.structuralDigest,
        status: event.plan.status,
      };
    case 'plan.completed':
      return {
        type: 'plan.completed',
        planId: event.planId,
        version: event.version,
        structuralDigest: event.structuralDigest,
      };
    case 'plan.approved':
      return {
        type: 'plan.approved',
        interactionId: event.interactionId,
        sessionRevision: context.sessionRevision,
        mode: event.executionMode,
      };
    case 'plan.revision_requested':
      return settled(event.interactionId, context.sessionRevision, 'rejected');
    case 'plan.review_cancelled':
      return settled(event.interactionId, context.sessionRevision, 'cancelled');
    case 'provider.action_required':
      return {
        type: 'provider.action',
        interaction: {
          kind: 'provider_action',
          interactionId: event.interactionId,
          sessionRevision: context.sessionRevision,
          provider: { providerId: event.providerId },
          action: event.action,
          title: 'Provider action required',
        },
        status: 'required',
      };
    case 'provider.action_started':
      // `started` means the recovery interaction is now waiting on its user
      // decision; it is not a settlement. The bridge still publishes this
      // durable revision as an event-less notification.
      return undefined;
    case 'provider.action_completed':
      return settled(event.interactionId, context.sessionRevision, 'completed');
    case 'provider.action_deferred':
      return settled(event.interactionId, context.sessionRevision, 'cancelled');
    case 'provider.action_failed':
      return settled(event.interactionId, context.sessionRevision, 'rejected');
    case 'provider.admission_required':
      return {
        type: 'provider.action',
        interaction: {
          kind: 'provider_action',
          interactionId: event.interactionId,
          sessionRevision: context.sessionRevision,
          provider: { providerId: event.providerId },
          action: event.retryable ? 'retry' : 'approve',
          title: 'Provider admission required',
        },
        status: 'required',
      };
    case 'provider.admission_satisfied':
      return settled(event.interactionId, context.sessionRevision, 'completed');
    case 'provider.admission_waived':
      return settled(event.interactionId, context.sessionRevision, 'completed');
    case 'provider.admission_cancelled':
      return settled(event.interactionId, context.sessionRevision, 'cancelled');
    case 'verification.requested':
      return {
        type: 'verification.status',
        interaction: {
          kind: 'verification',
          interactionId: event.verificationId,
          sessionRevision: context.sessionRevision,
          verification: {
            verificationId: event.verificationId,
            revision: event.requestedAt,
          },
          title: 'Verification required',
        },
        status: 'pending',
      };
    case 'subagent.started':
      return {
        type: 'subagent.started',
        subagentId: event.subagent.id,
        role: event.subagent.role,
        name: projectRuntimeClientText(
          'name' in event.subagent ? event.subagent.name : event.subagent.task,
          8_192,
        ),
      };
    case 'subagent.step':
      return {
        type: 'subagent.step',
        subagentId: event.subagent.id,
        toolName: projectRuntimeClientText(event.subagent.toolName, 8_192),
        status: 'started',
        ...toolDisplayLabelField(event.subagent.toolName),
        arguments: projectRuntimeClientArguments(event.subagent.toolArgs),
        ...(event.subagent.durationMs === undefined
          ? {}
          : { durationMs: event.subagent.durationMs }),
      };
    case 'subagent.tool_result':
      return {
        type: 'subagent.step',
        subagentId: event.subagent.id,
        toolName: projectRuntimeClientText(event.subagent.toolName, 8_192),
        status: event.subagent.ok ? 'completed' : 'failed',
        ...toolDisplayLabelField(event.subagent.toolName),
        result: { ok: event.subagent.ok },
        ...(event.subagent.summary === undefined
          ? event.subagent.failureReason === undefined
            ? {}
            : { summary: projectRuntimeClientText(event.subagent.failureReason, 8_192) }
          : { summary: projectRuntimeClientText(event.subagent.summary, 8_192) }),
        ...(event.subagent.totalLines === undefined
          ? {}
          : { totalLines: event.subagent.totalLines }),
        ...(event.subagent.durationMs === undefined
          ? {}
          : { durationMs: event.subagent.durationMs }),
      };
    case 'subagent.completed':
      return {
        type: 'subagent.completed',
        subagentId: event.subagent.id,
        summary: projectRuntimeClientText(event.subagent.summary, 8_192),
      };
    case 'subagent.failed':
      return {
        type: 'subagent.failed',
        subagentId: event.subagent.id,
        summary: projectRuntimeClientText(event.subagent.summary ?? event.subagent.error, 8_192),
      };
    case 'context.compaction_requested':
      return {
        type: 'context.compaction',
        status: 'requested',
        usedTokens: event.estimate.totalInputTokens,
      };
    case 'context.compaction_completed':
      return { type: 'context.compaction', status: 'completed' };
    case 'context.compaction_failed':
      return {
        type: 'context.compaction',
        status: 'failed',
        summary: 'Context compaction failed.',
      };
    case 'context.compaction_reset':
      return { type: 'context.compaction', status: 'reset' };
    case 'task.completed':
      return { type: 'task.terminal', taskId: event.taskId, status: 'completed' };
    case 'task.cancelled':
      return { type: 'task.terminal', taskId: event.taskId, status: 'cancelled' };
    case 'turn.completed':
      return { type: 'turn.terminal', turnId: event.turnId, status: 'completed' };
    case 'turn.aborted':
      return {
        type: 'turn.terminal',
        turnId: event.turnId,
        status: event.cause === 'user' ? 'cancelled' : 'failed',
        ...(event.cause === undefined ? {} : { cause: event.cause }),
      };
    case 'run.completed':
      return {
        type: 'run.terminal',
        runId: event.turnId,
        status: 'completed',
        summary: projectRuntimeClientText(event.output, 8_192),
        ...(event.outcome
          ? {
              outcome: {
                status: event.outcome.status,
                reasonCode: event.outcome.reasonCode,
                safeRetry: event.outcome.safeRetry,
                recoveryEntry: event.outcome.recoveryEntry,
              },
            }
          : {}),
      };
    case 'run.error': {
      // An exhausted model-attempt outcome describes the terminal wrapper;
      // the classified attempt remains the actionable, content-free cause.
      const attemptFailure =
        event.outcome?.reasonCode === 'model_retry_exhausted' && event.failure?.kind !== 'unknown'
          ? event.failure
          : undefined;
      return {
        type: 'run.failure',
        runId: event.turnId ?? 'runtime-run',
        code:
          attemptFailure?.kind ??
          event.outcome?.reasonCode ??
          event.failure?.kind ??
          'runtime_error',
        retryable:
          attemptFailure?.retryable ??
          event.outcome?.safeRetry ??
          event.failure?.retryable ??
          event.recoverable,
        recoveryEntry:
          event.outcome?.recoveryEntry ??
          (event.failure?.retryable || event.recoverable ? 'retry' : 'new_run'),
      };
    }
    case 'model.reasoning_delta':
      return projectRuntimeReasoningActivity(
        'streaming',
        event.requestId,
        event.segmentId,
        event.text,
      );
    case 'model.reasoning_completed':
      return projectRuntimeReasoningActivity(
        'completed',
        event.requestId,
        event.segmentId,
        event.text,
      );
    default:
      return undefined;
  }
}

/**
 * Durable model completions predate required ephemeral request identity. Keep
 * their established invocation-or-message identity rule in one place so live
 * terminal events and replayed display events stay correlated.
 */
export function projectRuntimeModelResponseRequestId(
  event: Extract<RuntimeEvent, { type: 'model.responded' }>,
): string {
  return event.invocationId ?? event.messageId;
}

const RUNTIME_TOOL_DISPLAY_NAME_SET = new Set<string>(RUNTIME_TOOL_DISPLAY_NAMES_);

/**
 * The State event's tool name is not safe presentation text. Keep only a
 * fixed built-in category; dynamic MCP names and unrecognized provider names
 * cannot carry caller-controlled content across the Runtime Client boundary.
 */
export function projectRuntimeToolDisplayName(name: string): RuntimeToolDisplayName {
  if (RUNTIME_TOOL_DISPLAY_NAME_SET.has(name)) return name as RuntimeToolDisplayName;
  return name.startsWith('mcp__') ? 'mcp_tool' : 'other';
}

/** Keeps canonical categories closed while retaining bounded local dynamic labels. */
export function projectRuntimeToolDisplayLabel(name: string): string | undefined {
  if (RUNTIME_TOOL_DISPLAY_NAME_SET.has(name)) return undefined;
  if (name.startsWith('mcp__')) return 'mcp:dynamic_tool';
  const label = projectRuntimeClientText(name, 512);
  return label.length === 0 ? undefined : label;
}

function toolDisplayLabelField(name: string): Readonly<Record<string, string>> {
  const displayLabel = projectRuntimeToolDisplayLabel(name);
  return displayLabel === undefined ? {} : { displayLabel };
}

function projectRuntimeReasoningActivity(
  state: 'streaming' | 'completed',
  requestId: string,
  segmentId: string | undefined,
  text: string,
): RuntimeClientEvent | undefined {
  if (!isIdentifier(requestId) || segmentId === undefined || !isIdentifier(segmentId))
    return undefined;
  const projectedText = projectRuntimeClientText(text);
  return projectedText.length === 0
    ? undefined
    : { type: 'reasoning.activity', requestId, state, segmentId, text: projectedText };
}

/**
 * The one content-free rendering classification produced while the App still
 * owns raw arguments. It carries no execution authority to the Client.
 */
export function projectRuntimeToolPresentation(
  event: Extract<RuntimeEvent, { type: 'tool.queued' }>,
) {
  if (event.name === 'task' || event.toolCallId.startsWith('subagent-tool:'))
    return 'hidden' as const;
  if (
    event.name === 'read_file' ||
    event.name === 'search_content' ||
    event.name === 'search_files' ||
    event.name === 'read_mcp_resource'
  ) {
    return 'exploration' as const;
  }
  return event.name === 'shell_execute' && isExplorationShell(event.args)
    ? ('exploration' as const)
    : ('standalone' as const);
}

function isExplorationShell(args: unknown): boolean {
  if (!isRecord(args) || args.intent !== 'inspect' || typeof args.command !== 'string')
    return false;
  const command = args.command.trim();
  return (
    isPureLsCommand(command) ||
    ['rg ', 'grep ', 'ag ', 'ack ', 'git grep ', 'find ./', 'find /'].some((prefix) =>
      command.startsWith(prefix),
    )
  );
}

function isPureLsCommand(command: string): boolean {
  return /^ls(?:\s|$)/.test(command) && !/[|&;<>\n\r`]|\$\(/.test(command);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const SECRET_ARGUMENT_KEY = /(?:authorization|api[ _-]?key|token|secret|password)/iu;
const MAX_ARGUMENT_DEPTH = 16;
const MAX_ARGUMENT_KEYS = 128;
const MAX_ARGUMENT_ITEMS = 256;

/** Retains ordinary local detail while deterministically removing unsafe or secret values. */
function projectRuntimeClientArguments(value: unknown): Readonly<Record<string, unknown>> {
  const projected = projectRuntimeClientJson(value, 0);
  return isRecord(projected) ? projected : {};
}

function projectRuntimeClientJson(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return projectRuntimeClientText(value);
  if (typeof value === 'number')
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
      ? value
      : null;
  if (depth >= MAX_ARGUMENT_DEPTH || typeof value !== 'object' || value === null) return null;
  if (Array.isArray(value))
    return value
      .slice(0, MAX_ARGUMENT_ITEMS)
      .map((entry) => projectRuntimeClientJson(entry, depth + 1));
  if (!isRecord(value)) return null;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, MAX_ARGUMENT_KEYS)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) continue;
    output[key] = SECRET_ARGUMENT_KEY.test(key)
      ? '[redacted]'
      : projectRuntimeClientJson(descriptor.value, depth + 1);
  }
  return output;
}

function projectRuntimeClientToolResult(
  result: Extract<RuntimeEvent, { type: 'tool.finished' }>['result'],
) {
  return {
    ok: result.ok,
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : 0,
    stdout: projectRuntimeClientText(result.stdout),
    stderr: projectRuntimeClientText(result.stderr),
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(result.totalLines === undefined ||
    !Number.isSafeInteger(result.totalLines) ||
    result.totalLines < 0
      ? {}
      : { totalLines: result.totalLines }),
    ...(result.toolTokenCount === undefined ||
    !Number.isSafeInteger(result.toolTokenCount) ||
    result.toolTokenCount < 0
      ? {}
      : { toolTokenCount: result.toolTokenCount }),
    ...(result.terminationReason === undefined
      ? {}
      : { terminationReason: result.terminationReason }),
  };
}

/**
 * A terminal event has no arguments. Preserve only classifications provable
 * from its closed name/ID facts; shell intentionally fails closed.
 */
function projectRuntimeTerminalToolPresentation(
  event: Extract<RuntimeEvent, { type: 'tool.finished' }>,
) {
  if (event.name === 'task' || event.toolCallId.startsWith('subagent-tool:'))
    return 'hidden' as const;
  return event.name === 'read_file' ||
    event.name === 'search_content' ||
    event.name === 'search_files' ||
    event.name === 'read_mcp_resource'
    ? ('exploration' as const)
    : ('standalone' as const);
}

function settled(
  interactionId: string,
  sessionRevision: number,
  outcome: 'completed' | 'rejected' | 'cancelled' | 'expired',
): RuntimeClientEvent {
  return { type: 'interaction.settled', interactionId, sessionRevision, outcome };
}
