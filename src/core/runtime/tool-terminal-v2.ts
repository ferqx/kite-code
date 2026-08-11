import { classifyToolCapability } from '@/core/policies/tool-capabilities';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import {
  CORE_TOOL_FAILURE_BUDGET_V2,
  canonicalToolResultBytesV2,
  coreToolFailureContentV2,
  type FinalizedProjectedToolResultV2,
  finalizeProjectedToolResultV2,
  resolveBuiltinToolResultBudgetV2,
  resolveRuntimeToolResultBudgetV2,
  type ToolResultBudgetReceiptV2,
  toolResultDigestV2,
  validateFrozenRuntimeOutputSchemaV2,
} from '@/core/tools/result-budget-v2';
import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import type { RuntimeState, ToolResultMeta } from './state';

export interface VerifiedToolModelResultV2 {
  kind: 'verified_v2';
  terminalIdentity: string;
  ok: boolean;
  modelContent: string;
  streams?: { stdout: string; stderr: string };
  resultMeta: ToolResultMeta & { toolResultReceipt: ToolResultBudgetReceiptV2 };
}

export interface MigratedToolModelResultV2 {
  kind: 'legacy_unverified';
  migratedFromSchemaVersion: SupportedLegacySchemaVersionV22;
  originalEventPosition: number;
}

export type SupportedLegacySchemaVersionV22 =
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21;

export function isSupportedLegacySchemaVersionV22(
  value: unknown,
): value is SupportedLegacySchemaVersionV22 {
  return Number.isInteger(value) && typeof value === 'number' && value >= 2 && value <= 21;
}

export type ToolTerminalModelResultV2 = VerifiedToolModelResultV2 | MigratedToolModelResultV2;

export type ToolTerminalEventV2 = Extract<
  RuntimeEvent,
  { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' | 'tool.cancelled' }
>;

function terminalContentV1(
  state: RuntimeState,
  event: ToolTerminalEventV2,
): {
  ok: boolean;
  content: string;
  resultMeta: ToolResultMeta;
  raw: unknown;
  streams?: { stdout: string; stderr: string };
} {
  const call = state.tools.calls[event.toolCallId];
  switch (event.type) {
    case 'tool.finished': {
      const suppliedDigest = event.result.resultMeta?.toolResultReceipt?.modelContentDigest;
      const candidates = [event.result.stdout, event.result.stderr];
      const receiptContent = suppliedDigest
        ? candidates.find(
            (candidate) =>
              toolResultDigestV2('tool-result-model-content:v2', candidate) === suppliedDigest,
          )
        : undefined;
      return {
        ok: event.result.ok,
        content: receiptContent ?? (event.result.stdout || event.result.stderr),
        resultMeta: event.result.resultMeta ?? {},
        raw: event.result,
        streams: { stdout: event.result.stdout, stderr: event.result.stderr },
      };
    }
    case 'tool.failed': {
      const failure =
        event.failure ??
        classifyFailure('tool_runtime_error', event.error ?? 'Tool failed unexpectedly.');
      return {
        ok: false,
        content: JSON.stringify({
          ok: false,
          error: {
            kind: failure.kind,
            message: failure.message,
            retryable: failure.retryable,
            model_fixable: failure.modelFixable,
          },
          next_step: failure.modelFixable
            ? 'Explain the failure, adjust the request or choose another available capability, and continue the conversation.'
            : 'Explain the failure to the user and continue without assuming the tool succeeded.',
        }),
        resultMeta: {},
        raw: { failure },
      };
    }
    case 'tool.rejected': {
      const failure = event.failure ?? classifyFailure('policy_denied', event.reason);
      const deferredUntilBuilding = failure.kind === 'phase_deferred';
      const deniedByPlanningPhase = failure.kind === 'phase_denied';
      return {
        ok: false,
        content: JSON.stringify(
          deferredUntilBuilding
            ? {
                ok: false,
                deferred: true,
                reason: 'phase_constraint',
                until_phase: 'building',
                tool: call?.name ?? 'unknown',
                arguments: call?.args,
                next_step:
                  'Do not retry or request approval while planning. Preserve this command in the plan execution or verification section, then invoke it only after plan approval changes the phase to building.',
              }
            : deniedByPlanningPhase
              ? {
                  ok: false,
                  rejected: true,
                  reason: 'phase_constraint',
                  phase: 'planning',
                  tool: call?.name ?? 'unknown',
                  arguments: call?.args,
                  message: event.reason,
                  next_step:
                    'Do not retry or request approval while planning. Use read-only inspection capabilities and preserve the intended implementation in the plan for execution after plan approval.',
                }
              : {
                  ok: false,
                  rejected: true,
                  error: {
                    kind: failure.kind,
                    message: event.reason,
                    retryable: failure.retryable,
                    model_fixable: failure.modelFixable,
                  },
                  next_step:
                    'Respect the rejection, explain it when relevant, and continue without assuming the tool ran.',
                },
        ),
        resultMeta: {},
        raw: { failure },
      };
    }
    case 'tool.cancelled':
      return {
        ok: false,
        content: event.reason,
        resultMeta: {},
        raw: { reason: event.reason },
      };
  }
}

function budgetForCall(state: RuntimeState, toolCallId: string) {
  const call = state.tools.calls[toolCallId];
  if (call?.resultBudgetV2) return call.resultBudgetV2;
  const spec = call ? builtinToolRegistry.get(call.name) : undefined;
  if (spec) {
    return resolveBuiltinToolResultBudgetV2({
      toolName: spec.name,
      budget: spec.modelResultBudgetV2,
      governanceRevision: spec.governanceRevision,
    });
  }
  if (call?.bindingId && call.capabilityRevision) {
    return resolveRuntimeToolResultBudgetV2({
      toolIdentity: call.capabilityId ?? call.name,
      catalogRevision: state.capabilities.catalogRevision || 'legacy_unknown',
      bindingRevision: call.capabilityRevision,
      budget: { kind: 'serialized', maxUtf8Bytes: 128 * 1_024 },
    });
  }
  return resolveBuiltinToolResultBudgetV2({
    toolName: 'core-tool-failure:v1',
    budget: CORE_TOOL_FAILURE_BUDGET_V2,
  });
}

function receiptMatchesResolvedBudget(input: {
  receipt: ToolResultBudgetReceiptV2;
  resultMeta: ToolResultMeta;
  modelContent: string;
  resolved: ReturnType<typeof budgetForCall>;
  expectedProjectionMode: 'compat_v1' | 'budget_v2';
  streams?: { stdout: string; stderr: string };
  requireStreams?: boolean;
}): boolean {
  const { receipt, resultMeta, modelContent, resolved, expectedProjectionMode, streams } = input;
  try {
    if (resolved.outputSchema) validateFrozenRuntimeOutputSchemaV2(resolved.outputSchema);
  } catch {
    return false;
  }
  if (
    receipt.version !== 2 ||
    receipt.projectionMode !== expectedProjectionMode ||
    receipt.toolIdentity !== resolved.toolIdentity ||
    receipt.bindingDigest !== resolved.bindingDigest ||
    receipt.validatorId !== resolved.validatorId ||
    receipt.modelContentDigest !==
      toolResultDigestV2('tool-result-model-content:v2', modelContent) ||
    receipt.modelContentUtf8Bytes !== Buffer.byteLength(modelContent, 'utf8') ||
    receipt.rawResultDigest !== resultMeta.rawResultDigest ||
    !/^[0-9a-f]{64}$/.test(receipt.rawResultDigest)
  ) {
    return false;
  }
  if (
    canonicalToolResultBytesV2(receipt.continuation) !==
    canonicalToolResultBytesV2(resultMeta.continuation)
  ) {
    return false;
  }
  if (expectedProjectionMode === 'compat_v1') {
    if (
      receipt.policyId !== 'tool-result-compat:v1' ||
      receipt.projectorId !== 'compat-projector:v1' ||
      receipt.projectorRevision !== 'compat-projector:v1'
    ) {
      return false;
    }
  } else if (
    receipt.policyId !== resolved.policyId ||
    receipt.projectorId !== resolved.projectorId ||
    receipt.projectorRevision !== resolved.projectorRevision
  ) {
    return false;
  }
  const budget = resolved.budget;
  if (
    expectedProjectionMode === 'budget_v2' &&
    (budget.kind === 'serialized' || budget.kind === 'structured' || budget.kind === 'line_window')
  ) {
    if (receipt.modelContentUtf8Bytes > budget.maxUtf8Bytes) return false;
  }
  if (
    expectedProjectionMode === 'budget_v2' &&
    budget.kind === 'line_window' &&
    receipt.continuation?.kind !== 'line_byte_cursor_v2'
  ) {
    return false;
  }
  if (budget.kind === 'structured') {
    try {
      JSON.parse(modelContent);
    } catch {
      return false;
    }
  }
  if (budget.kind === 'stream_head_tail' && input.requireStreams) {
    const proof = receipt.streamProjection;
    if (
      !streams ||
      !proof ||
      streams.stdout.length > budget.maxCharsPerStream ||
      streams.stderr.length > budget.maxCharsPerStream ||
      proof.stdoutChars !== streams.stdout.length ||
      proof.stderrChars !== streams.stderr.length ||
      proof.stdoutDigest !== toolResultDigestV2('tool-result-stream-stdout:v2', streams.stdout) ||
      proof.stderrDigest !== toolResultDigestV2('tool-result-stream-stderr:v2', streams.stderr)
    ) {
      return false;
    }
  }
  if (
    expectedProjectionMode === 'budget_v2' &&
    budget.kind === 'stream_head_tail' &&
    (!receipt.streamProjection ||
      receipt.streamProjection.stdoutChars > budget.maxCharsPerStream ||
      receipt.streamProjection.stderrChars > budget.maxCharsPerStream ||
      !/^[0-9a-f]{64}$/.test(receipt.streamProjection.stdoutDigest) ||
      !/^[0-9a-f]{64}$/.test(receipt.streamProjection.stderrDigest))
  ) {
    return false;
  }
  return true;
}

function hasVerifiedModelResult(event: ToolTerminalEventV2): event is ToolTerminalEventV2 & {
  modelResult: VerifiedToolModelResultV2;
} {
  return event.modelResult?.kind === 'verified_v2';
}

function terminalIdentityV2(
  event: ToolTerminalEventV2,
  result: Omit<VerifiedToolModelResultV2, 'terminalIdentity'>,
): string {
  const { modelResult: _modelResult, ...terminalWithTimestamp } = event;
  const terminal = {
    ...terminalWithTimestamp,
  } as typeof terminalWithTimestamp & {
    createdAt?: string;
  };
  // Store envelope checksum binds persistence timestamps. Terminal identity binds
  // semantic payload and remains stable when Kernel assigns createdAt.
  delete terminal.createdAt;
  return toolResultDigestV2(
    'tool-terminal-event:v2',
    canonicalToolResultBytesV2({ terminal, result }),
  );
}

function resolvedBudgetForReceipt(
  state: RuntimeState,
  event: ToolTerminalEventV2,
  receipt: ToolResultBudgetReceiptV2,
) {
  if (receipt.toolIdentity === 'builtin:core-tool-failure:v1') {
    return resolveBuiltinToolResultBudgetV2({
      toolName: 'core-tool-failure:v1',
      budget: CORE_TOOL_FAILURE_BUDGET_V2,
    });
  }
  return budgetForCall(state, event.toolCallId);
}

export function validateVerifiedToolTerminalEventV2(
  state: RuntimeState,
  event: ToolTerminalEventV2,
  expectedProjectionMode?: 'compat_v1' | 'budget_v2',
): asserts event is ToolTerminalEventV2 & {
  modelResult: VerifiedToolModelResultV2;
} {
  if (!hasVerifiedModelResult(event)) {
    throw new Error(`Schema-v22 tool terminal '${event.type}' is missing verified model result.`);
  }
  const result = event.modelResult;
  const receipt = result.resultMeta.toolResultReceipt;
  const projectionMode = expectedProjectionMode ?? receipt.projectionMode;
  const resolved = resolvedBudgetForReceipt(state, event, receipt);
  if (
    !receiptMatchesResolvedBudget({
      receipt,
      resultMeta: result.resultMeta,
      modelContent: result.modelContent,
      resolved,
      expectedProjectionMode: projectionMode,
      streams: result.streams,
      requireStreams: event.type === 'tool.finished',
    }) ||
    canonicalToolResultBytesV2(result.resultMeta.toolResultReceipt) !==
      canonicalToolResultBytesV2(receipt) ||
    result.terminalIdentity !==
      terminalIdentityV2(event, {
        kind: result.kind,
        ok: result.ok,
        modelContent: result.modelContent,
        ...(result.streams ? { streams: result.streams } : {}),
        resultMeta: result.resultMeta,
      })
  ) {
    throw new Error(`Invalid verified terminal receipt for tool call '${event.toolCallId}'.`);
  }
  if (event.type !== 'tool.finished' && result.ok) {
    throw new Error(`Non-finished terminal '${event.type}' cannot carry an ok model result.`);
  }
  if (receipt.toolIdentity !== 'builtin:core-tool-failure:v1') {
    const projected = terminalContentV1(state, event);
    if (
      result.modelContent !== projected.content ||
      result.ok !== projected.ok ||
      canonicalToolResultBytesV2(result.streams) !==
        canonicalToolResultBytesV2(projected.streams) ||
      (event.type === 'tool.finished' &&
        event.result.resultMeta?.toolResultReceipt !== undefined &&
        canonicalToolResultBytesV2(event.result.resultMeta?.toolResultReceipt) !==
          canonicalToolResultBytesV2(receipt))
    ) {
      throw new Error(`Terminal payload does not match verified result '${event.toolCallId}'.`);
    }
  }
  if (receipt.toolIdentity === 'builtin:core-tool-failure:v1') {
    if (
      event.type === 'tool.finished' &&
      canonicalToolResultBytesV2(event.result.resultMeta) !==
        canonicalToolResultBytesV2(result.resultMeta)
    ) {
      throw new Error(`Core tool failure metadata does not match terminal '${event.toolCallId}'.`);
    }
    if (receipt.projectionMode !== 'budget_v2') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.modelContent);
    } catch {
      throw new Error('Core tool failure result must be a sealed JSON envelope.');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { code?: unknown }).code !== 'core-tool-failure:v1' ||
      result.ok
    ) {
      throw new Error('Core tool failure result has invalid sealed content.');
    }
  }
}

/**
 * Revalidate the self-contained proof retained by a schema-v22 rolling snapshot.
 * The event payload is intentionally unavailable here, so terminalIdentity is
 * checked as a Store-checksum-bound identity while every reproducible receipt,
 * binding, continuation and model-content fact is recomputed.
 */
export function validateStoredVerifiedToolResultV2(input: {
  state: RuntimeState;
  toolCallId: string;
  modelContent: string;
  resultMeta: ToolResultMeta;
}): void {
  const { state, toolCallId, modelContent, resultMeta } = input;
  const receipt = resultMeta.toolResultReceipt;
  if (
    !receipt ||
    !resultMeta.terminalIdentity ||
    !/^[0-9a-f]{64}$/.test(resultMeta.terminalIdentity) ||
    !resultMeta.terminalKind
  ) {
    throw new Error(`Schema-v22 snapshot tool '${toolCallId}' is missing terminal proof.`);
  }
  const resolved =
    receipt.toolIdentity === 'builtin:core-tool-failure:v1'
      ? resolveBuiltinToolResultBudgetV2({
          toolName: 'core-tool-failure:v1',
          budget: CORE_TOOL_FAILURE_BUDGET_V2,
        })
      : budgetForCall(state, toolCallId);
  if (
    !receiptMatchesResolvedBudget({
      receipt,
      resultMeta,
      modelContent,
      resolved,
      expectedProjectionMode: receipt.projectionMode,
    })
  ) {
    throw new Error(`Schema-v22 snapshot tool '${toolCallId}' has an invalid terminal receipt.`);
  }
}

const TERMINAL_SNAPSHOT_STATUSES = new Set([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);

interface TerminalStateExpectationV2 {
  terminalKind: ToolTerminalEventV2['type'];
  status: 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'exhausted';
  ok: boolean;
}

function terminalStateExpectationForEventV2(
  event: RuntimeEvent,
  toolCallId: string,
): TerminalStateExpectationV2 | undefined {
  if (
    (event.type === 'tool.finished' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.rejected' ||
      event.type === 'tool.cancelled') &&
    event.toolCallId === toolCallId
  ) {
    if (event.type === 'tool.finished') {
      const ok = event.modelResult?.kind === 'verified_v2' ? event.modelResult.ok : event.result.ok;
      return {
        terminalKind: event.type,
        status: event.result.status === 'exhausted' ? 'exhausted' : ok ? 'succeeded' : 'failed',
        ok,
      };
    }
    if (event.type === 'tool.failed') {
      return { terminalKind: event.type, status: 'failed', ok: false };
    }
    if (event.type === 'tool.rejected') {
      return { terminalKind: event.type, status: 'rejected', ok: false };
    }
    return { terminalKind: event.type, status: 'cancelled', ok: false };
  }
  if (event.type === 'approval.rejected' && event.toolCallId === toolCallId) {
    return { terminalKind: 'tool.rejected', status: 'rejected', ok: false };
  }
  if (
    event.type === 'auto_review.completed' &&
    event.toolCallId === toolCallId &&
    event.result.ok &&
    !event.result.approved
  ) {
    return { terminalKind: 'tool.rejected', status: 'rejected', ok: false };
  }
  if (event.type === 'provider.action_required' && event.originatingToolCallId === toolCallId) {
    return { terminalKind: 'tool.failed', status: 'failed', ok: false };
  }
  if (event.type === 'user_input.answered' && event.toolCallId === toolCallId) {
    return { terminalKind: 'tool.finished', status: 'succeeded', ok: true };
  }
  if (event.type === 'user_input.cancelled' && event.toolCallId === toolCallId) {
    return { terminalKind: 'tool.finished', status: 'failed', ok: false };
  }
  if (event.type === 'plan.review_cancelled' && event.toolCallId === toolCallId) {
    return { terminalKind: 'tool.cancelled', status: 'cancelled', ok: false };
  }
  return undefined;
}

/** Validate the canonical settled-call/result pairing restored from a v22 snapshot. */
export function validateRestoredTerminalStateV2(
  state: RuntimeState,
  cutoverEventPosition: number,
  persistedEvents: readonly { id: number; event: RuntimeEvent }[],
  options: { allowBranchNormalizedLegacyBase?: boolean } = {},
): void {
  const messagesByCall = new Map<
    string,
    Array<Extract<RuntimeState['transcript']['messages'][number], { kind: 'tool' }>>
  >();
  for (const message of state.transcript.messages) {
    if (message.kind !== 'tool') continue;
    const entries = messagesByCall.get(message.toolCallId) ?? [];
    entries.push(message);
    messagesByCall.set(message.toolCallId, entries);
  }

  for (const [toolCallId, call] of Object.entries(state.tools.calls)) {
    if (!TERMINAL_SNAPSHOT_STATUSES.has(call.status)) continue;
    const messages = messagesByCall.get(toolCallId) ?? [];
    if (messages.length !== 1 || !call.result?.resultMeta) {
      throw new Error(`Schema-v22 settled tool '${toolCallId}' lacks one canonical result.`);
    }
    const message = messages[0]!;
    const callMeta = call.result.resultMeta;
    const messageMeta = message.resultMeta;
    if (
      !messageMeta ||
      canonicalToolResultBytesV2(callMeta) !== canonicalToolResultBytesV2(messageMeta)
    ) {
      throw new Error(`Schema-v22 settled tool '${toolCallId}' has inconsistent result metadata.`);
    }
    const migration = messageMeta.terminalMigration;
    if (migration) {
      const source = persistedEvents.find((entry) => entry.id === migration.originalEventPosition);
      const expectation = source
        ? terminalStateExpectationForEventV2(source.event, toolCallId)
        : undefined;
      if (
        migration.kind !== 'legacy_unverified' ||
        !isSupportedLegacySchemaVersionV22(migration.migratedFromSchemaVersion) ||
        !Number.isInteger(migration.originalEventPosition) ||
        migration.originalEventPosition <= 0 ||
        (migration.originalEventPosition > cutoverEventPosition &&
          !options.allowBranchNormalizedLegacyBase) ||
        messageMeta.digestScope !== 'legacy_unknown' ||
        messageMeta.toolResultReceipt !== undefined ||
        messageMeta.terminalIdentity !== undefined ||
        !messageMeta.terminalKind ||
        ((!source || !expectation) && !options.allowBranchNormalizedLegacyBase) ||
        (source &&
          expectation &&
          (expectation.terminalKind !== messageMeta.terminalKind ||
            expectation.status !== call.status ||
            expectation.ok !== call.result.ok ||
            expectation.ok !== message.ok))
      ) {
        throw new Error(`Schema-v22 legacy tool '${toolCallId}' has invalid migration provenance.`);
      }
    } else {
      validateStoredVerifiedToolResultV2({
        state,
        toolCallId,
        modelContent: message.content,
        resultMeta: messageMeta,
      });
      const durableTerminals = persistedEvents.filter(
        (entry): entry is { id: number; event: ToolTerminalEventV2 } =>
          entry.id <= cutoverEventPosition &&
          (entry.event.type === 'tool.finished' ||
            entry.event.type === 'tool.failed' ||
            entry.event.type === 'tool.rejected' ||
            entry.event.type === 'tool.cancelled') &&
          entry.event.toolCallId === toolCallId &&
          entry.event.modelResult?.kind === 'verified_v2' &&
          entry.event.modelResult.terminalIdentity === messageMeta.terminalIdentity,
      );
      if (durableTerminals.length !== 1) {
        throw new Error(`Schema-v22 tool '${toolCallId}' lacks one durable terminal identity.`);
      }
      const durable = durableTerminals[0]!.event;
      validateVerifiedToolTerminalEventV2(state, durable);
      const expectation = terminalStateExpectationForEventV2(durable, toolCallId);
      if (
        !expectation ||
        expectation.terminalKind !== messageMeta.terminalKind ||
        expectation.status !== call.status ||
        expectation.ok !== call.result.ok ||
        expectation.ok !== message.ok ||
        durable.modelResult?.kind !== 'verified_v2' ||
        durable.modelResult.modelContent !== message.content ||
        durable.modelResult.ok !== expectation.ok ||
        canonicalToolResultBytesV2(durable.modelResult.resultMeta.toolResultReceipt) !==
          canonicalToolResultBytesV2(messageMeta.toolResultReceipt)
      ) {
        throw new Error(`Schema-v22 tool '${toolCallId}' terminal identity does not match state.`);
      }
    }
    messagesByCall.delete(toolCallId);
  }
  if (messagesByCall.size > 0) {
    throw new Error('Schema-v22 snapshot contains a Tool Result without one settled call.');
  }
}

/** Production constructor: every terminal is self-contained before Kernel persistence. */
export function finalizeToolTerminalEventV2(
  state: RuntimeState,
  event: ToolTerminalEventV2,
  projectionMode: 'compat_v1' | 'budget_v2' = 'compat_v1',
): ToolTerminalEventV2 & { modelResult: VerifiedToolModelResultV2 } {
  if (hasVerifiedModelResult(event)) {
    validateVerifiedToolTerminalEventV2(state, event, projectionMode);
    return event;
  }
  const projected = terminalContentV1(state, event);
  const suppliedReceipt = projected.resultMeta.toolResultReceipt;
  const resolvedBudget = budgetForCall(state, event.toolCallId);
  const suppliedResolvedBudget = suppliedReceipt
    ? resolvedBudgetForReceipt(state, event, suppliedReceipt)
    : resolvedBudget;
  if (
    suppliedReceipt &&
    receiptMatchesResolvedBudget({
      receipt: suppliedReceipt,
      resultMeta: projected.resultMeta,
      modelContent: projected.content,
      resolved: suppliedResolvedBudget,
      expectedProjectionMode: projectionMode,
      streams: projected.streams,
      requireStreams: event.type === 'tool.finished',
    })
  ) {
    const modelResultWithoutIdentity = {
      kind: 'verified_v2' as const,
      ok: projected.ok,
      modelContent: projected.content,
      resultMeta: projected.resultMeta as ToolResultMeta & {
        toolResultReceipt: ToolResultBudgetReceiptV2;
      },
      ...(projected.streams ? { streams: projected.streams } : {}),
    };
    return {
      ...event,
      modelResult: Object.freeze({
        ...modelResultWithoutIdentity,
        terminalIdentity: terminalIdentityV2(event, modelResultWithoutIdentity),
      }),
    };
  }
  let finalized: FinalizedProjectedToolResultV2<ToolResultMeta>;
  try {
    const cannotResolveTrustedBudget =
      resolvedBudget.toolIdentity === 'builtin:core-tool-failure:v1';
    const producerProofRequired =
      resolvedBudget.budget.kind === 'stream_head_tail' ||
      resolvedBudget.budget.kind === 'line_window';
    const suppliedReceiptValid =
      suppliedReceipt !== undefined &&
      receiptMatchesResolvedBudget({
        receipt: suppliedReceipt,
        resultMeta: projected.resultMeta,
        modelContent: projected.content,
        resolved: suppliedResolvedBudget,
        expectedProjectionMode: projectionMode,
        streams: projected.streams,
        requireStreams: event.type === 'tool.finished',
      });
    const useCoreFailure =
      projectionMode === 'budget_v2' &&
      (cannotResolveTrustedBudget ||
        (!suppliedReceiptValid && (event.type !== 'tool.finished' || producerProofRequired)));
    const safeContent = useCoreFailure
      ? coreToolFailureContentV2(
          event.type === 'tool.finished' ? 'unverified_result' : event.type.replace('tool.', ''),
        )
      : projected.content;
    finalized = finalizeProjectedToolResultV2({
      rawResult: useCoreFailure ? { code: 'unverified_terminal' } : projected.raw,
      projected: {
        ok: useCoreFailure ? false : projected.ok,
        modelContent: safeContent,
        ...(useCoreFailure || !projected.streams ? {} : { streams: projected.streams }),
        resultMeta: useCoreFailure ? {} : projected.resultMeta,
      },
      resolvedBudget: useCoreFailure
        ? resolveBuiltinToolResultBudgetV2({
            toolName: 'core-tool-failure:v1',
            budget: CORE_TOOL_FAILURE_BUDGET_V2,
          })
        : resolvedBudget,
      projectionMode,
      continuation: useCoreFailure ? undefined : projected.resultMeta.continuation,
    });
  } catch {
    const content = coreToolFailureContentV2('projection_failed');
    finalized = finalizeProjectedToolResultV2({
      rawResult: { code: 'projection_failed' },
      projected: { ok: false, modelContent: content, resultMeta: {} },
      resolvedBudget: resolveBuiltinToolResultBudgetV2({
        toolName: 'core-tool-failure:v1',
        budget: CORE_TOOL_FAILURE_BUDGET_V2,
      }),
      projectionMode: 'budget_v2',
    });
  }
  const modelResultWithoutIdentity = {
    kind: 'verified_v2' as const,
    ok: finalized.ok,
    modelContent: finalized.modelContent,
    resultMeta: finalized.resultMeta,
    ...(finalized.streams ? { streams: finalized.streams } : {}),
  };
  return {
    ...event,
    modelResult: Object.freeze({
      ...modelResultWithoutIdentity,
      terminalIdentity: terminalIdentityV2(event, modelResultWithoutIdentity),
    }),
  };
}

export function finalizeToolTerminalBatchV2(
  state: RuntimeState,
  events: readonly RuntimeEvent[],
  projectionMode: 'compat_v1' | 'budget_v2' = 'compat_v1',
): RuntimeEvent[] {
  let projectedState = state;
  return events.map((event) => {
    const finalized =
      event.type === 'tool.finished' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.rejected' ||
      event.type === 'tool.cancelled'
        ? finalizeToolTerminalEventV2(projectedState, event, projectionMode)
        : event;
    // Keep call lookup current for batches that queue and terminate a call atomically.
    if (event.type === 'tool.queued') {
      const capability = classifyToolCapability(event.name, event.args);
      projectedState = {
        ...projectedState,
        tools: {
          ...projectedState.tools,
          calls: {
            ...projectedState.tools.calls,
            [event.toolCallId]: {
              toolCallId: event.toolCallId,
              modelMessageId: event.modelMessageId ?? '',
              name: event.name,
              args: event.args,
              status: 'queued',
              createdAtTurnId: projectedState.turn.turnId,
              effectClass: event.effectClass ?? capability.effectClass,
              sideEffect: event.sideEffect ?? capability.sideEffect,
              classificationReason: event.classificationReason ?? capability.classificationReason,
              ...(event.bindingId ? { bindingId: event.bindingId } : {}),
              ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
              ...(event.capabilityRevision ? { capabilityRevision: event.capabilityRevision } : {}),
              ...(event.resultBudgetV2 ? { resultBudgetV2: event.resultBudgetV2 } : {}),
            },
          },
        },
      };
    }
    return finalized;
  });
}

type TerminalControlV2 = {
  label: string;
  toolCallId: string;
  terminalTypes: ReadonlySet<ToolTerminalEventV2['type']>;
};

function terminalControlV2(event: RuntimeEvent): TerminalControlV2 | undefined {
  if (event.type === 'approval.rejected' && event.toolCallId) {
    return {
      label: 'approval.rejected',
      toolCallId: event.toolCallId,
      terminalTypes: new Set(['tool.rejected']),
    };
  }
  if (event.type === 'auto_review.completed' && event.result.ok && !event.result.approved) {
    return {
      label: 'Rejected auto_review.completed',
      toolCallId: event.toolCallId,
      terminalTypes: new Set(['tool.rejected']),
    };
  }
  if (event.type === 'user_input.answered' || event.type === 'user_input.cancelled') {
    return {
      label: event.type,
      toolCallId: event.toolCallId,
      terminalTypes: new Set(['tool.finished']),
    };
  }
  if (event.type === 'plan.review_cancelled' && event.toolCallId) {
    return {
      label: event.type,
      toolCallId: event.toolCallId,
      terminalTypes: new Set(['tool.cancelled']),
    };
  }
  if (event.type === 'provider.action_required') {
    return {
      label: event.type,
      toolCallId: event.originatingToolCallId,
      terminalTypes: new Set(['tool.failed']),
    };
  }
  return undefined;
}

function isToolTerminalV2(event: RuntimeEvent): event is ToolTerminalEventV2 {
  return (
    event.type === 'tool.finished' ||
    event.type === 'tool.failed' ||
    event.type === 'tool.rejected' ||
    event.type === 'tool.cancelled'
  );
}

function callHasCanonicalTerminalV2(state: Readonly<RuntimeState> | undefined, toolCallId: string) {
  const status = state?.tools.calls[toolCallId]?.status;
  if (!status || !['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(status)) {
    return false;
  }
  return state?.transcript.messages.some(
    (message) => message.kind === 'tool' && message.toolCallId === toolCallId,
  );
}

/**
 * Validate the crash-safe ordering subset of a terminal CAS batch.
 *
 * Non-terminal lifecycle/audit events may be interleaved, but controls must
 * own their immediate target terminal, all sibling terminals precede resource
 * reconciliation, and turn.aborted is the final ordering boundary.
 */
export function assertToolTerminalControlBatchV2(
  events: readonly RuntimeEvent[],
  state?: Readonly<RuntimeState>,
): void {
  const terminalCalls = new Set<string>();
  let sawTerminal = false;
  let sawResourceFact = false;
  let sawTurnAborted = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (
      (event.type === 'approval.rejected' || event.type === 'plan.review_cancelled') &&
      !event.toolCallId
    ) {
      throw new Error(`${event.type} production control is missing toolCallId.`);
    }
    const isTerminal = isToolTerminalV2(event);
    const control = terminalControlV2(event);
    const isResourceFact = event.type.startsWith('resource_budget.');
    if (sawTurnAborted && (isTerminal || control || isResourceFact)) {
      throw new Error(
        'Tool terminal/control/resource fact must precede turn.aborted in one batch.',
      );
    }
    if (event.type === 'turn.aborted') sawTurnAborted = true;
    if (control && (sawTerminal || sawResourceFact)) {
      throw new Error(`${control.label} control must precede target and sibling terminals.`);
    }
    if (isTerminal && sawResourceFact) {
      throw new Error('Tool terminal must precede resource facts in the same batch.');
    }
    if (isResourceFact) sawResourceFact = true;
    if (isTerminal) {
      sawTerminal = true;
      if (terminalCalls.has(event.toolCallId)) {
        throw new Error(`Duplicate tool terminal for '${event.toolCallId}' in one batch.`);
      }
      terminalCalls.add(event.toolCallId);
    }
    if (control) {
      // A provider recovery prompt can be a pure control when an earlier
      // committed batch already owns the canonical failed result. It must
      // never manufacture a second/backfilled result in that case.
      const alreadyTerminal =
        event.type === 'provider.action_required' &&
        callHasCanonicalTerminalV2(state, event.originatingToolCallId);
      if (alreadyTerminal) continue;
      const companion = events[index + 1];
      if (
        !companion ||
        !isToolTerminalV2(companion) ||
        companion.toolCallId !== control.toolCallId ||
        !control.terminalTypes.has(companion.type)
      ) {
        throw new Error(
          `${control.label} requires an immediate matching ${[...control.terminalTypes].join('|')} terminal.`,
        );
      }
    }
  }
}
