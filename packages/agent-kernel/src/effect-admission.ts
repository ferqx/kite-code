import type { RuntimeEffect } from './effects';
import type { RuntimeEvent } from './events';
import { reduce } from './kernel';
import { normalizeAgentEvent } from './normalization';
import type { AgentState } from './state';

export interface AgentEffectLeaseIdentityV1 {
  readonly turnId: string;
  readonly effect: RuntimeEffect;
}

export interface SuspendedCapabilityTerminalRequirementV1 {
  readonly invocationId: string;
  readonly toolCallId: string;
}

type CapabilityTerminalEventV1 = Extract<
  RuntimeEvent,
  {
    type:
      | 'capability.execution_succeeded'
      | 'capability.execution_failed'
      | 'capability.execution_unknown';
  }
>;

function isCapabilityTerminalEventV1(event: RuntimeEvent): event is CapabilityTerminalEventV1 {
  return (
    event.type === 'capability.execution_succeeded' ||
    event.type === 'capability.execution_failed' ||
    event.type === 'capability.execution_unknown'
  );
}

function isToolTerminalEventV1(
  event: RuntimeEvent,
): event is Extract<
  RuntimeEvent,
  { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled' }
> {
  return (
    event.type === 'tool.finished' ||
    event.type === 'tool.failed' ||
    event.type === 'tool.rejected' ||
    event.type === 'tool.cancelled'
  );
}

/**
 * Determine which suspended capability receipts require Host-supplied terminal timestamps.
 * The Kernel never reads a clock; callers must bind every returned invocation exactly once.
 */
export function suspendedCapabilityTerminalRequirementsV1(
  state: Readonly<AgentState>,
  events: readonly RuntimeEvent[],
): readonly SuspendedCapabilityTerminalRequirementV1[] {
  const terminalInvocationIds = new Set(
    events.filter(isCapabilityTerminalEventV1).map((event) => event.invocationId),
  );
  const requirements: SuspendedCapabilityTerminalRequirementV1[] = [];
  for (const event of events) {
    if (!isToolTerminalEventV1(event)) continue;
    const invocation = Object.values(state.capabilities.invocations).find(
      (candidate) =>
        candidate.toolCallId === event.toolCallId &&
        candidate.status === 'running' &&
        Boolean(candidate.receiptRequirement),
    );
    if (!invocation || terminalInvocationIds.has(invocation.invocationId)) continue;
    terminalInvocationIds.add(invocation.invocationId);
    requirements.push({
      invocationId: invocation.invocationId,
      toolCallId: invocation.toolCallId,
    });
  }
  return requirements;
}

/** Close a suspended governed capability receipt in the same atomic Tool-terminal batch. */
export function attachSuspendedCapabilityTerminalsV1(
  state: Readonly<AgentState>,
  events: readonly RuntimeEvent[],
  finishedAtByInvocationId: Readonly<Record<string, string>>,
): readonly RuntimeEvent[] {
  const output: RuntimeEvent[] = [];
  for (const event of events) {
    if (!isToolTerminalEventV1(event)) {
      output.push(event);
      continue;
    }
    const invocation = Object.values(state.capabilities.invocations).find(
      (candidate) =>
        candidate.toolCallId === event.toolCallId &&
        candidate.status === 'running' &&
        Boolean(candidate.receiptRequirement),
    );
    if (
      !invocation ||
      output.some(
        (candidate) =>
          isCapabilityTerminalEventV1(candidate) &&
          candidate.invocationId === invocation.invocationId,
      )
    ) {
      output.push(event);
      continue;
    }
    const finishedAt = finishedAtByInvocationId[invocation.invocationId];
    if (!finishedAt || !Number.isFinite(Date.parse(finishedAt))) {
      throw new Error(
        `Suspended capability terminal ${invocation.invocationId} requires a valid Host timestamp.`,
      );
    }
    if (!invocation.artifact || !invocation.resultDigest || !invocation.evidenceDigest) {
      output.push({
        type: 'capability.execution_unknown',
        invocationId: invocation.invocationId,
        reason: 'Suspended Tool terminal has no committed capability result evidence.',
        finishedAt,
      });
    } else if (event.type === 'tool.finished' && event.result.ok) {
      output.push({
        type: 'capability.execution_succeeded',
        invocationId: invocation.invocationId,
        resultDigest: invocation.resultDigest,
        evidenceDigest: invocation.evidenceDigest,
        finishedAt,
        artifact: invocation.artifact,
        ...(invocation.externalReferences
          ? { externalReferences: invocation.externalReferences }
          : {}),
      });
    } else {
      const error =
        event.type === 'tool.finished'
          ? event.result.stderr || 'Suspended Tool interaction did not succeed.'
          : event.type === 'tool.failed'
            ? event.failure.message
            : event.reason;
      output.push({
        type: 'capability.execution_failed',
        invocationId: invocation.invocationId,
        error,
        resultDigest: invocation.resultDigest,
        evidenceDigest: invocation.evidenceDigest,
        finishedAt,
        artifact: invocation.artifact,
      });
    }
    output.push(event);
  }
  return output;
}

/** Enforce governed capability receipt + Tool terminal atomicity. */
export function assertCapabilityToolTerminalBatchV1(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentityV1,
  events: readonly RuntimeEvent[],
): void {
  if (lease.effect.type !== 'run_tools') return;
  const capabilityTerminals = events.filter(isCapabilityTerminalEventV1);
  for (const terminal of capabilityTerminals) {
    const invocation = state.capabilities.invocations[terminal.invocationId];
    if (!invocation?.receiptRequirement) continue;
    if (
      (terminal.type === 'capability.execution_succeeded' ||
        terminal.type === 'capability.execution_failed') &&
      terminal.artifact?.kind !== 'capability_result'
    ) {
      throw new Error('Governed capability terminal requires a private result Artifact.');
    }
    const matchingToolTerminal = events.some(
      (event) => isToolTerminalEventV1(event) && event.toolCallId === invocation.toolCallId,
    );
    if (!matchingToolTerminal) {
      throw new Error('Capability receipt and Tool terminal must commit in one atomic batch.');
    }
  }
  for (const event of events) {
    if (event.type !== 'verification.requested') continue;
    const sourceIds = event.spec.checks.flatMap((check) => {
      if (check.type === 'schema' && check.subject.kind === 'capability_artifact') {
        return [check.subject.invocationId];
      }
      if (check.type === 'mcp_read_after_write' || check.type === 'external_reference') {
        return [check.invocationId];
      }
      return check.type === 'reviewer' ? (check.invocationIds ?? []) : [];
    });
    for (const invocationId of sourceIds) {
      const invocation = state.capabilities.invocations[invocationId];
      if (!invocation?.receiptRequirement) continue;
      if (
        !capabilityTerminals.some(
          (terminal) =>
            terminal.type === 'capability.execution_succeeded' &&
            terminal.invocationId === invocationId,
        )
      ) {
        throw new Error('Verification cannot reference an uncommitted capability receipt.');
      }
    }
  }
}

/** Reject late success/failure/rejection for a Tool already durably cancelled. */
export function hasLateTerminalEventForCancelledToolV1(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentityV1,
  events: readonly RuntimeEvent[],
): boolean {
  if (lease.effect.type !== 'run_tools') return false;
  return events.some(
    (event) =>
      (event.type === 'tool.finished' ||
        event.type === 'tool.failed' ||
        event.type === 'tool.rejected') &&
      state.tools.calls[event.toolCallId]?.status === 'cancelled',
  );
}

/**
 * Shell siblings from one response may finish across unrelated revisions, but
 * only while the exact Tool/capability identity is still live.
 */
export function isConcurrentShellEffectEventCurrentV1(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentityV1,
  event: RuntimeEvent,
): boolean {
  if (lease.turnId !== state.turn.turnId || lease.effect.type !== 'run_tools') return false;
  if (
    event.type === 'capability.execution_started' ||
    event.type === 'capability.execution_succeeded' ||
    event.type === 'capability.execution_failed' ||
    event.type === 'capability.execution_unknown' ||
    event.type === 'capability.sandbox_preparation_intent_recorded' ||
    event.type === 'capability.sandbox_preparation_ready' ||
    event.type === 'capability.sandbox_execution_dispatch_intent_recorded' ||
    event.type === 'capability.sandbox_execution_supervisor_started' ||
    event.type === 'capability.sandbox_disposal_started' ||
    event.type === 'capability.sandbox_disposal_completed' ||
    event.type === 'capability.sandbox_preparation_abandonment_started' ||
    event.type === 'capability.sandbox_preparation_abandonment_completed'
  ) {
    const invocation = state.capabilities.invocations[event.invocationId];
    if (!invocation || !lease.effect.toolCallIds.includes(invocation.toolCallId)) return false;
    const call = state.tools.calls[invocation.toolCallId];
    return (
      call?.name === 'shell_execute' &&
      (call.status === 'queued' || call.status === 'approved' || call.status === 'running')
    );
  }
  if (!('toolCallId' in event) || typeof event.toolCallId !== 'string') return false;
  if (!lease.effect.toolCallIds.includes(event.toolCallId)) return false;
  const call = state.tools.calls[event.toolCallId];
  if (call?.name !== 'shell_execute') return false;
  switch (event.type) {
    case 'approval.requested':
    case 'auto_review.requested':
      return call.status === 'queued';
    case 'tool.started':
      return call.status === 'queued' || call.status === 'approved';
    case 'capability.invocation_recorded':
      return call.status === 'queued' || call.status === 'approved' || call.status === 'running';
    case 'tool.progress':
    case 'tool.finished':
      return call.status === 'running';
    case 'tool.failed':
    case 'tool.rejected':
      return call.status === 'queued' || call.status === 'approved' || call.status === 'running';
    case 'runtime.cancellation_diagnostic':
      return call.status === 'cancelled' || call.status === 'running';
    default:
      return false;
  }
}

/** Validate a concurrent Shell batch against each projected intermediate State value. */
export function isConcurrentShellEffectBatchCurrentV1(
  state: Readonly<AgentState>,
  lease: AgentEffectLeaseIdentityV1,
  events: readonly RuntimeEvent[],
  occurredAtForEvent: (index: number) => string,
): boolean {
  let projectedState = state;
  for (const [index, event] of events.entries()) {
    if (!isConcurrentShellEffectEventCurrentV1(projectedState, lease, event)) return false;
    const occurredAt = occurredAtForEvent(index);
    if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return false;
    const canonicalEvent = normalizeAgentEvent(event, projectedState, occurredAt);
    projectedState = reduce(projectedState, [canonicalEvent]);
  }
  return true;
}
