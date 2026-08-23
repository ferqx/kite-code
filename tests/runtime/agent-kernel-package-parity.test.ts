import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite/agent-kernel';
import {
  type AgentState,
  admitRecoveryAttempt as admitPackageRecoveryAttempt,
  admitRecoveryAttempt as admitRootRecoveryAttempt,
  advanceToolRecoveryResponse as advancePackageToolRecoveryResponse,
  advanceToolRecoveryResponse as advanceRootToolRecoveryResponse,
  assertCurrentRuntimeEvent as assertPackageEvent,
  assertCurrentRuntimeEvent as assertRootEvent,
  CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS,
  CURRENT_RUNTIME_EVENT_TYPE_COUNT,
  classifyToolOutcome as classifyPackageToolOutcome,
  classifyToolOutcome as classifyRootToolOutcome,
  closeToolRecoveryScope as closePackageToolRecoveryScope,
  closeToolRecoveryScope as closeRootToolRecoveryScope,
  createInitialAgentState,
  createToolRecoveryJournal as createPackageToolRecoveryJournal,
  createToolRecoveryJournal as createRootToolRecoveryJournal,
  decideCompletion as decidePackageCompletion,
  decideNextEffect as decidePackageEffect,
  decidePlannedCompletion,
  decideUnplannedCompletion,
  decodeCurrentRuntimeEventJson as decodePackageEvent,
  decodeCurrentRuntimeEventJson as decodeRootEvent,
  encodeCurrentAgentStateJson,
  encodeCurrentRuntimeEventJson as encodePackageEvent,
  hasActiveUnresolvedToolFailures as hasActivePackageUnresolvedToolFailures,
  hasActiveUnresolvedToolFailures as hasActiveRootUnresolvedToolFailures,
  hasUnresolvedToolFailures as hasPackageUnresolvedToolFailures,
  hasUnresolvedToolFailures as hasRootUnresolvedToolFailures,
  isToolOutcome as isPackageToolOutcome,
  isToolOutcome as isRootToolOutcome,
  isToolRecoveryJournalInvalid,
  isToolRecoveryResolution,
  isValidSchedulerFacts,
  type KernelEvent,
  mergeToolRecoveryJournals as mergePackageToolRecoveryJournals,
  mergeToolRecoveryJournals as mergeRootToolRecoveryJournals,
  normalizeAgentEvent,
  normalizeAgentToolOutcomeEvent,
  normalizeToolRecoveryJournal as normalizePackageToolRecoveryJournal,
  normalizeToolRecoveryJournal as normalizeRootToolRecoveryJournal,
  type ToolRecoveryJournal as PackageToolRecoveryJournal,
  toolFailureInstanceId as packageToolFailureInstanceId,
  toolInvocationFingerprint as packageToolInvocationFingerprint,
  toolOutcomeMetricStatus as packageToolOutcomeMetricStatus,
  toolOutcomeProtocolStatus as packageToolOutcomeProtocolStatus,
  toolOutcomeSucceeded as packageToolOutcomeSucceeded,
  trustedToolTiming as packageTrustedToolTiming,
  type ToolOutcome as RootToolOutcome,
  type ToolRecoveryJournal as RootToolRecoveryJournal,
  type RuntimeEventType,
  recordRecoveryFailure as recordPackageRecoveryFailure,
  recordRecoveryInvocation as recordPackageRecoveryInvocation,
  recordToolOwnedProgress as recordPackageToolOwnedProgress,
  recordRecoveryFailure as recordRootRecoveryFailure,
  recordRecoveryInvocation as recordRootRecoveryInvocation,
  recordToolOwnedProgress as recordRootToolOwnedProgress,
  reduceAgentState,
  toolFailureInstanceId as rootToolFailureInstanceId,
  toolInvocationFingerprint as rootToolInvocationFingerprint,
  toolOutcomeMetricStatus as rootToolOutcomeMetricStatus,
  toolOutcomeProtocolStatus as rootToolOutcomeProtocolStatus,
  toolOutcomeSucceeded as rootToolOutcomeSucceeded,
  trustedToolTiming as rootTrustedToolTiming,
  type SchedulerFacts,
  STATE_DEFAULT_EVENT_TYPES,
  STATE_DIAGNOSTIC_EVENT_TYPES,
  STATE_EVENT_REDUCER_COVERAGE,
  verificationSchemaAdmissionDigest,
} from '@kite/agent-kernel';
import { compileCapabilitySchema } from '@kite/builtin-runtime';
import { computePlanStructuralDigest } from '@kite/builtin-runtime/planning';
import type { PlanDocument } from '@kite/runtime-contract';
import {
  createDeterministicRuntimeIdSource,
  createRuntimeHostStateInitialState,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
  type RuntimeState,
} from '@kite/runtime-host';
import type { VerificationCheck } from '@kite/runtime-spi';
import { SQLITE_RUNTIME_STORE_SCHEMA_VERSION } from '@kite/runtime-storage-sqlite';
import { classifyFailure } from '#app/bootstrap/runtime/failures';
import { normalizeTerminalRuntimeEvent } from '#app/bootstrap/runtime/terminal-outcome';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { StateHostSessionHarness as AgentKernel } from '../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../scripts/support/runtime-storage';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OCCURRED_AT = '2026-08-20T00:00:00.000Z';

const STATE_EPOCH = 'kite-runtime-modularization-v1-2026-08-19';

const FAILURE_KINDS = [
  'model_invalid_tool_args',
  'model_refused',
  'model_timeout',
  'model_rate_limited',
  'model_server_error',
  'policy_denied',
  'phase_deferred',
  'phase_denied',
  'approval_rejected',
  'auto_review_rejected',
  'plan_revision_requested',
  'tool_runtime_error',
  'tool_timeout',
  'tool_invalid_args',
  'tool_not_found',
  'provider_auth_required',
  'provider_approval_required',
  'provider_unavailable',
  'provider_capability_changed',
  'user_input_cancelled',
  'user_input_timeout',
  'sandbox_error',
  'checkpoint_restore_error',
  'transcript_invariant_error',
  'loop_exhausted',
  'budget_exceeded',
  'artifact_invalid',
  'profile_invalid',
  'digest_invalid',
  'workspace_untrusted',
  'network_unavailable',
  'worktree_unavailable',
  'model_retry_exhausted',
  'mcp_unavailable',
  'persistence_unavailable',
  'resource_saturated',
  'process_limit_exceeded',
  'cancel_incomplete',
  'compaction_unqualified',
  'compaction_failed',
  'verification_failed',
  'verification_inconclusive',
  'mandatory_policy_unavailable',
  'unknown',
] as const;

const JOURNAL_FAILURE_OUTCOME = {
  schemaVersion: 1,
  status: 'failed',
  failure: { kind: 'tool_runtime_error', detailCode: 'runtime_exception' },
  dispatchState: 'not_started',
  externalEffects: 'none',
  replaySafety: 'pre_dispatch',
  recovery: {
    disposition: 'correct_args',
    maximumAdditionalCalls: 1,
    requiresNewModelResponse: true,
    safeAutomaticRetry: false,
  },
  timing: { source: 'runtime_boundary' },
} as const;

const JOURNAL_REJECTED_OUTCOME = {
  schemaVersion: 1,
  status: 'rejected',
  failure: { kind: 'approval_rejected', detailCode: 'approval_rejected' },
  dispatchState: 'not_started',
  externalEffects: 'none',
  replaySafety: 'pre_dispatch',
  recovery: {
    disposition: 'never',
    maximumAdditionalCalls: 0,
    requiresNewModelResponse: false,
    safeAutomaticRetry: false,
  },
  timing: { source: 'runtime_boundary' },
} as const;

type Probe<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function probe<T>(operation: () => T): Probe<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Parity fixture is not JSON serializable.');
  return serialized;
}

function stateBytes(value: unknown): string {
  return textBytes(stableJson(value));
}

function textBytes(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function firstByteDifference(left: string, right: string): number | null {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? null : length;
}

function jsonFromTextBytes(value: string): unknown {
  const pairs = value.match(/.{2}/gu) ?? [];
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16))),
  ) as unknown;
}

function jsonDiffs(
  root: unknown,
  packageValue: unknown,
  path = '$',
  output: Array<{ readonly path: string; readonly root: unknown; readonly package: unknown }> = [],
): readonly { readonly path: string; readonly root: unknown; readonly package: unknown }[] {
  if (output.length >= 12 || Object.is(root, packageValue)) return output;
  if (Array.isArray(root) && Array.isArray(packageValue)) {
    const length = Math.max(root.length, packageValue.length);
    for (let index = 0; index < length && output.length < 12; index += 1) {
      jsonDiffs(root[index], packageValue[index], `${path}[${index}]`, output);
    }
    return output;
  }
  if (isRecord(root) && isRecord(packageValue)) {
    const keys = [...new Set([...Object.keys(root), ...Object.keys(packageValue)])].sort();
    for (const key of keys) {
      if (output.length >= 12) break;
      jsonDiffs(root[key], packageValue[key], `${path}.${key}`, output);
    }
    return output;
  }
  output.push({ path, root, package: packageValue });
  return output;
}

function expectNoParityMismatches(mismatches: readonly unknown[], label: string): void {
  const cases = mismatches.slice(0, 40).map((mismatch) => {
    if (!isRecord(mismatch)) return mismatch;
    const identity = Object.fromEntries(
      ['type', 'case', 'kind', 'name'].flatMap((key) =>
        mismatch[key] === undefined ? [] : [[key, mismatch[key]]],
      ),
    );
    const firstDiff = Array.isArray(mismatch.diffs) ? mismatch.diffs[0] : undefined;
    return {
      ...identity,
      ...(firstDiff === undefined ? {} : { firstDiff }),
      ...(mismatch.case === 'throw-status' || mismatch.case === 'throw-signature'
        ? { root: mismatch.root, package: mismatch.package }
        : {}),
    };
  });
  expect(
    { count: mismatches.length, cases, first: mismatches[0] ?? null },
    `${label}; first exact diff: ${stableJson(mismatches[0] ?? null)}`,
  ).toEqual({ count: 0, cases: [], first: null });
}

function errorSignature(value: Probe<unknown>): string {
  return value.ok ? 'accepted' : `throw:${value.error}`;
}

function fixtureValue(field: string): unknown {
  if (field === 'readinessKey') return 'readiness-1';
  if (field === 'userGoal') return 'fixture goal';
  if (field === 'toolName') return 'fixture';
  if (field === 'content') return 'fixture content';
  if (field === 'purpose') return 'primary_agent';
  if (field === 'surfaceArtifact')
    return {
      kind: 'model_surface',
      artifactId: `pa_${'b'.repeat(64)}`,
      integrityIdentifier: `sha256:${'c'.repeat(64)}`,
      byteLength: 1,
    };
  if (field === 'surfaceIntegrityIdentifier') return `sha256:${'c'.repeat(64)}`;
  if (field === 'routeFingerprint') return `sha256:${'d'.repeat(64)}`;
  if (field === 'admission')
    return {
      providerAdmissionRevision: null,
      routeIdentityDigest: `sha256:${'e'.repeat(64)}`,
      payloadClassificationDigest: `sha256:${'f'.repeat(64)}`,
      admitted: true,
    };
  if (field === 'limits')
    return { maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 1_000 };
  if (field === 'preparedStateRevision') return 0;
  if (field === 'parentInvocationId' || field === 'parentToolCallId') return null;
  if (
    field === 'bindings' ||
    field === 'disclosures' ||
    field === 'loadedCapabilities' ||
    field === 'toolCalls' ||
    field === 'steps' ||
    field === 'checks' ||
    field === 'messages' ||
    field === 'events' ||
    field === 'requiredPermits'
  )
    return [];
  if (
    field === 'retryable' ||
    field === 'force' ||
    field === 'disposed' ||
    field === 'recoverable' ||
    field === 'cleanupConfirmed'
  )
    return false;
  if (
    field === 'attempt' ||
    field === 'maxAttempts' ||
    field === 'version' ||
    field === 'planSchemaVersion' ||
    field === 'repairAttempt' ||
    field === 'correctionAttempt' ||
    field === 'cleanupAttempt' ||
    field === 'sourceRevision' ||
    field === 'requestedAtRevision' ||
    field === 'delayMs' ||
    field === 'supervisorPid' ||
    field === 'processGroupId' ||
    field === 'retryAttempt' ||
    field === 'turnIndex' ||
    field === 'ordinal'
  )
    return 1;
  if (field.endsWith('At') || field === 'changedAt') return OCCURRED_AT;
  if (
    field === 'actor' ||
    field === 'name' ||
    field === 'mode' ||
    field === 'source' ||
    field === 'status' ||
    field === 'reason' ||
    field === 'message' ||
    field === 'command' ||
    field === 'path' ||
    field === 'stream' ||
    field === 'providerStatus' ||
    field === 'providerId' ||
    field === 'failureCode' ||
    field === 'decision' ||
    field === 'nextAction' ||
    field === 'guardVersion' ||
    field === 'executionMode' ||
    field === 'capabilityRevision' ||
    field === 'backend' ||
    field === 'enforcement' ||
    field === 'cleanupKind' ||
    field === 'dispatchCertainty' ||
    field === 'reasonCode'
  )
    return 'fixture';
  if (field.endsWith('Id') || field.endsWith('Digest') || field.endsWith('Revision')) {
    return 'fixture';
  }
  if (
    field === 'failure' ||
    field === 'result' ||
    field === 'outcome' ||
    field === 'approval' ||
    field === 'grant' ||
    field === 'plan' ||
    field === 'completionEvidence' ||
    field === 'artifact' ||
    field === 'snapshot' ||
    field === 'spec' ||
    field === 'checkpoint' ||
    field === 'estimate' ||
    field === 'reservation' ||
    field === 'actual' ||
    field === 'waiter' ||
    field === 'limits' ||
    field === 'error'
  )
    return {};
  return {};
}

/**
 * A deliberately mechanical State corpus. The fixture is only used to
 * exercise required-field, unknown-field, and non-JSON rejection paths; a
 * domain-specific event may still be rejected by both codecs for deeper
 * evidence reasons.
 */
function materializeEvent(type: RuntimeEventType): Record<string, unknown> {
  const value: Record<string, unknown> = { type };
  for (const field of CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[type]) {
    value[field] = fixtureValue(field);
  }
  if (type === 'authorization.changed') value.mode = 'default';
  if (type === 'interaction_mode.changed') {
    value.mode = 'accept_edits';
    value.source = 'user';
  }
  if (type === 'auto_review.requested') value.createdAt = OCCURRED_AT;
  if (type === 'model.invocation_prepared') {
    value.budget = { kind: 'no_budget', reason: 'resource_budget_disabled' };
  }
  return value;
}

function rootState(): RuntimeState {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    interactionMode: 'accept_edits',
    runtimeIdSource: createDeterministicRuntimeIdSource({
      seed: 'parity',
      epochMs: Date.parse(OCCURRED_AT),
    }),
  });
  return {
    ...state,
    toolRecovery: { ...state.toolRecovery, identityKey: IDENTITY_KEY },
  };
}

function packageState(): AgentState {
  return createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'parity-turn-0001',
    recoveryIdentityKey: IDENTITY_KEY,
    interactionMode: 'accept_edits',
  });
}

function rootCodec(value: unknown): Probe<{ readonly bytes: string; readonly decoded: unknown }> {
  return probe(() => {
    assertRootEvent(value);
    const encoded = stableJson(value);
    const decoded = decodeRootEvent(encoded);
    return { bytes: textBytes(encoded), decoded };
  });
}

function packageCodec(
  value: unknown,
): Probe<{ readonly bytes: string; readonly decoded: unknown }> {
  return probe(() => {
    assertPackageEvent(value);
    const encoded = encodePackageEvent(value);
    const decoded = decodePackageEvent(encoded);
    return { bytes: textBytes(encoded), decoded };
  });
}

function rootReducer(type: RuntimeEventType): Probe<string> {
  return probe(() => {
    const event = materializeEvent(type);
    assertRootEvent(event);
    return stateBytes(reduceRuntimeState(rootReducerState(type), event));
  });
}

function packageReducer(type: RuntimeEventType): Probe<string> {
  return probe(() => {
    const event = materializeEvent(type);
    assertPackageEvent(event);
    return textBytes(
      encodeCurrentAgentStateJson(reduceAgentState(packageReducerState(type), event)),
    );
  });
}

function reducerNeedsTool(type: RuntimeEventType): boolean {
  return CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[type].some((field) => field === 'toolCallId');
}

function rootReducerState(type: RuntimeEventType): RuntimeState {
  const state = type === 'user.message_appended' ? rootStateWithTask() : rootState();
  if (!reducerNeedsTool(type)) return state;
  return {
    ...state,
    tools: {
      ...state.tools,
      calls: {
        fixture: {
          toolCallId: 'fixture',
          name: 'fixture',
          modelMessageId: 'message-1',
          args: {},
          createdAtTurnId: state.turn.turnId,
          status: 'queued',
        },
      },
      queue: ['fixture'],
    },
  };
}

function packageReducerState(type: RuntimeEventType): AgentState {
  const state = type === 'user.message_appended' ? packageStateWithTask() : packageState();
  if (!reducerNeedsTool(type)) return state;
  return {
    ...state,
    tools: {
      ...state.tools,
      calls: {
        fixture: {
          toolCallId: 'fixture',
          name: 'fixture',
          modelMessageId: 'message-1',
          args: {},
          createdAtTurnId: state.turn.turnId,
          status: 'queued',
        },
      },
      queue: ['fixture'],
    },
  };
}

function rootStateWithTask(): RuntimeState {
  const state = rootState();
  return {
    ...state,
    activeTaskId: 'task-1',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        userGoal: 'goal',
        status: 'active',
        startedAtTurnId: state.turn.turnId,
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' },
        planHistory: [],
      },
    },
  };
}

function packageStateWithTask(): AgentState {
  const state = packageState();
  return {
    ...state,
    activeTaskId: 'task-1',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        userGoal: 'goal',
        status: 'active',
        startedAtTurnId: state.turn.turnId,
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' },
        planHistory: [],
      },
    },
  };
}

function toolFailureEvent(kind: string): Record<string, unknown> {
  return {
    type: 'tool.failed',
    toolCallId: 'tool-1',
    createdAt: OCCURRED_AT,
    failure: {
      kind,
      message: `fixture ${kind}`,
      retryable: false,
      modelFixable: false,
      needsUserIntervention: true,
      terminatesTurn: true,
      journal: true,
    },
  };
}

function canonicalOutcomeValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.outcome;
}

function rootToolOutcome(kind: string): Probe<unknown> {
  return probe(() => {
    const event = toolFailureEvent(kind);
    assertRootEvent(event);
    return canonicalOutcomeValue(normalizeCurrentToolOutcomeEvent(event, rootState(), OCCURRED_AT));
  });
}

function packageToolOutcome(kind: string): Probe<unknown> {
  return probe(() => {
    const event = toolFailureEvent(kind);
    assertPackageEvent(event);
    return canonicalOutcomeValue(
      normalizeAgentToolOutcomeEvent(event, packageState(), OCCURRED_AT),
    );
  });
}

function rootQueuedState(): RuntimeState {
  const state = rootState();
  return {
    ...state,
    tools: {
      ...state.tools,
      calls: {
        fixture: {
          toolCallId: 'fixture',
          name: 'fixture',
          modelMessageId: 'message-1',
          args: {},
          createdAtTurnId: state.turn.turnId,
          status: 'queued',
        },
      },
      queue: ['fixture'],
    },
  };
}

function packageQueuedState(): AgentState {
  const state = packageState();
  return {
    ...state,
    tools: {
      ...state.tools,
      calls: {
        fixture: {
          toolCallId: 'fixture',
          name: 'fixture',
          modelMessageId: 'message-1',
          args: {},
          createdAtTurnId: state.turn.turnId,
          status: 'queued',
        },
      },
      queue: ['fixture'],
    },
  };
}

const planDocument = {
  planSchemaVersion: 2,
  planId: 'plan-1',
  version: 1,
  title: 'Parity plan',
  bodyMarkdown: 'one completed step',
  steps: [{ id: 'step-1', title: 'step', status: 'completed' }],
  structuralDigest: 'digest-1',
  createdAtTurnId: 'parity-turn-0001',
  updatedAtTurnId: 'parity-turn-0001',
  completionEvidence: {
    schemaVersion: 1,
    verification: [],
    execution: [],
    skipped: [],
    unresolved: [],
  },
} satisfies PlanDocument;

function rootCompletedPlanState(): RuntimeState {
  const state = rootState();
  return {
    ...state,
    activeTaskId: 'task-1',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        userGoal: 'goal',
        status: 'active',
        startedAtTurnId: state.turn.turnId,
        sideEffectsStarted: false,
        planning: {
          kind: 'completed',
          document: planDocument,
          completedAtTurnId: state.turn.turnId,
        },
        planHistory: [planDocument],
      },
    },
  };
}

function packageCompletedPlanState(): AgentState {
  const state = packageState();
  return {
    ...state,
    activeTaskId: 'task-1',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        userGoal: 'goal',
        status: 'active',
        startedAtTurnId: state.turn.turnId,
        sideEffectsStarted: false,
        planning: {
          kind: 'completed',
          document: planDocument,
          completedAtTurnId: state.turn.turnId,
        },
        planHistory: [planDocument],
      },
    },
  };
}

type DifferentialEvent = Record<string, unknown> & { readonly type: RuntimeEventType };

/**
 * Apply the same deterministic event sequence to the root reducer and the
 * extracted Kernel reducer.  This deliberately compares every intermediate
 * snapshot, not only the final projection, so a reducer that silently no-ops
 * before its preconditions are established cannot hide behind a later event.
 */
function reduceDifferentialSequence(
  label: string,
  events: readonly DifferentialEvent[],
  initialRoot: RuntimeState = rootState(),
  initialPackage: AgentState = packageState(),
): readonly Record<string, unknown>[] {
  let root = initialRoot;
  let packageStateValue = initialPackage;
  const mismatches: Array<Record<string, unknown>> = [];

  for (const [index, event] of events.entries()) {
    const occurredAt = typeof event.createdAt === 'string' ? event.createdAt : OCCURRED_AT;
    const rootResult = probe(() =>
      reduceRuntimeState(
        root,
        normalizeCurrentToolOutcomeEvent(
          normalizeTerminalRuntimeEvent(event as never),
          root,
          occurredAt,
        ),
      ),
    );
    const packageResult = probe(() =>
      reduceAgentState(
        packageStateValue,
        normalizeAgentEvent(event as never, packageStateValue, occurredAt),
      ),
    );
    if (rootResult.ok !== packageResult.ok) {
      mismatches.push({
        label,
        index,
        type: event.type,
        case: 'throw-status',
        root: rootResult,
        package: packageResult,
      });
      continue;
    }
    if (!rootResult.ok || !packageResult.ok) {
      if (errorSignature(rootResult) !== errorSignature(packageResult)) {
        mismatches.push({
          label,
          index,
          type: event.type,
          case: 'throw-signature',
          root: rootResult,
          package: packageResult,
        });
      }
      continue;
    }

    root = rootResult.value;
    packageStateValue = packageResult.value;
    const rootBytes = stateBytes(root);
    const packageBytes = textBytes(encodeCurrentAgentStateJson(packageStateValue));
    if (rootBytes !== packageBytes) {
      const firstDifference = firstByteDifference(rootBytes, packageBytes);
      mismatches.push({
        label,
        index,
        type: event.type,
        case: 'state-bytes',
        rootByteLength: rootBytes.length,
        packageByteLength: packageBytes.length,
        firstByteDifference: firstDifference,
        rootByteContext:
          firstDifference === null
            ? ''
            : rootBytes.slice(Math.max(0, firstDifference - 80), firstDifference + 160),
        packageByteContext:
          firstDifference === null
            ? ''
            : packageBytes.slice(Math.max(0, firstDifference - 80), firstDifference + 160),
        diffs: jsonDiffs(jsonFromTextBytes(rootBytes), jsonFromTextBytes(packageBytes)),
      });
    }
  }

  return mismatches;
}

const DIFFERENTIAL_BUDGET = {
  version: 1 as const,
  maxRunDurationMs: 60_000,
  maxTurns: 10,
  maxModelRequests: 10,
  maxToolInvocations: 8,
  maxRunInputTokens: 10_000,
  maxRunOutputTokens: 10_000,
  maxConcurrentSubagents: 2,
  maxConcurrentWriters: 1,
  maxConcurrentToolInvocations: 2,
  maxConcurrentShellInvocations: 1,
  maxConcurrencyWaitMs: 10_000,
  maxArtifactBytes: 10_000,
};

function differentialUsage(
  source: 'actual' | 'versioned_upper_bound',
  toolInvocations = 0,
): Record<string, unknown> {
  return {
    counters: {
      turns: 0,
      modelRequests: 0,
      toolInvocations,
      inputTokens: 0,
      outputTokens: 0,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents: 0,
      activeWriters: 0,
      activeToolInvocations: toolInvocations,
      activeShellInvocations: 0,
    },
    source,
    ...(source === 'versioned_upper_bound' ? { estimatorVersion: 'parity-v1' } : {}),
  };
}

function differentialReservation(
  reservationId: string,
  invocationId: string,
  toolInvocations = 1,
): DifferentialEvent {
  return {
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId,
      runId: 'run-parity',
      invocationId,
      resourceKind: 'tool',
      executableUpperBound: differentialUsage('versioned_upper_bound', toolInvocations),
      state: 'reserved',
    },
  };
}

function differentialResourceSequence(): readonly DifferentialEvent[] {
  return [
    {
      type: 'resource_budget.configured',
      runId: 'run-parity',
      startedAt: OCCURRED_AT,
      deadlineAt: '2026-08-20T00:01:00.000Z',
      budget: DIFFERENTIAL_BUDGET,
    },
    differentialReservation('reservation-1', 'invocation-1'),
    { type: 'resource_budget.dispatch_started', reservationId: 'reservation-1' },
    { type: 'resource_budget.unknown', reservationId: 'reservation-1' },
    {
      type: 'resource_budget.reconciled',
      reservationId: 'reservation-1',
      actual: differentialUsage('actual', 1),
    },
    // This is intentionally stale after reconciliation; both reducers must
    // reject it without changing the ledger before the next event.
    { type: 'resource_budget.unknown', reservationId: 'reservation-1' },
    {
      type: 'resource_budget.waiter_enqueued',
      waiter: {
        version: 1,
        runId: 'run-parity',
        invocationId: 'waiter-1',
        requiredPermits: ['tool'],
        sequence: 0,
        enqueuedAt: OCCURRED_AT,
        deadlineAt: '2026-08-20T00:00:30.000Z',
        state: 'waiting',
      },
    },
    { type: 'resource_budget.waiter_promoted', invocationId: 'waiter-1' },
    {
      type: 'resource_budget.waiter_enqueued',
      waiter: {
        version: 1,
        runId: 'run-parity',
        invocationId: 'waiter-2',
        requiredPermits: ['tool'],
        sequence: 1,
        enqueuedAt: OCCURRED_AT,
        deadlineAt: '2026-08-20T00:00:30.000Z',
        state: 'waiting',
      },
    },
    { type: 'resource_budget.waiter_cancelled', invocationId: 'waiter-2' },
    {
      type: 'resource_budget.waiter_enqueued',
      waiter: {
        version: 1,
        runId: 'run-parity',
        invocationId: 'waiter-3',
        requiredPermits: ['tool'],
        sequence: 2,
        enqueuedAt: OCCURRED_AT,
        deadlineAt: '2026-08-20T00:00:30.000Z',
        state: 'waiting',
      },
    },
    { type: 'resource_budget.waiter_timed_out', invocationId: 'waiter-3' },
    differentialReservation('reservation-2', 'invocation-2'),
    { type: 'resource_budget.released', reservationId: 'reservation-2' },
    differentialReservation('reservation-3', 'invocation-3'),
    { type: 'resource_budget.dispatch_started', reservationId: 'reservation-3' },
    { type: 'resource_budget.unknown', reservationId: 'reservation-3' },
    {
      type: 'resource_budget.reconciled',
      reservationId: 'reservation-3',
      actual: differentialUsage('actual', 1),
    },
  ];
}

const DIFFERENTIAL_PLAN = {
  name: 'Parity plan',
  description: 'Inspect the runtime before making the change.',
  status: 'pending' as const,
  steps: [{ id: 'inspect', step: 'Inspect the runtime', status: 'pending' as const }],
};

const DIFFERENTIAL_PLAN_HASH = computePlanStructuralDigest({
  title: DIFFERENTIAL_PLAN.name,
  bodyMarkdown: DIFFERENTIAL_PLAN.description,
  steps: [{ id: 'inspect', title: 'Inspect the runtime', status: 'pending' }],
});

const DIFFERENTIAL_APPROVAL_REJECTED_OUTCOME = {
  schemaVersion: 1,
  status: 'rejected',
  failure: { kind: 'approval_rejected', detailCode: 'approval_rejected' },
  dispatchState: 'not_started',
  externalEffects: 'none',
  replaySafety: 'pre_dispatch',
  recovery: {
    disposition: 'never',
    maximumAdditionalCalls: 0,
    requiresNewModelResponse: false,
    safeAutomaticRetry: false,
  },
  timing: { source: 'runtime_boundary' },
};

const DIFFERENTIAL_AUTO_REVIEW_REJECTED_OUTCOME = {
  ...DIFFERENTIAL_APPROVAL_REJECTED_OUTCOME,
  failure: { kind: 'auto_review_rejected', detailCode: 'auto_review_rejected' },
};

function differentialPlanArtifact(planId = 'plan-parity', version = 1) {
  return {
    artifactId: `${planId}:v${version}`,
    taskId: 'task-parity',
    planId,
    version,
    fileName: `v${version}.md`,
    relativePath: `plans/task-parity/${planId}/v${version}.md`,
    displayPath: `/plans/task-parity/${planId}/v${version}.md`,
    structuralDigest: DIFFERENTIAL_PLAN_HASH,
    byteLength: 100,
  };
}

function lifecycleAndAuthorizationSequence(): readonly DifferentialEvent[] {
  const planArtifact = differentialPlanArtifact();
  return [
    {
      type: 'task.started',
      taskId: 'task-parity',
      userGoal: 'Implement the parity fixture',
      turnId: 'parity-turn-0001',
    },
    {
      type: 'tool.queued',
      toolCallId: 'plan-call',
      name: 'write_plan',
      args: { action: 'save', title: 'Parity plan' },
      taskId: 'task-parity',
      modelMessageId: 'message-plan',
      ordinal: 0,
      sideEffect: false,
      effectClass: 'plan_only',
      createdAt: OCCURRED_AT,
    },
    { type: 'planning.entered', taskId: 'task-parity', source: 'user_command' },
    {
      type: 'plan.drafted',
      toolCallId: 'plan-call',
      taskId: 'task-parity',
      plan: DIFFERENTIAL_PLAN,
      planId: 'plan-parity',
      version: 1,
      structuralHash: DIFFERENTIAL_PLAN_HASH,
      planSchemaVersion: 2,
      artifact: planArtifact,
    },
    {
      // Wrong plan identity and version must be a stale no-op while a draft is
      // active; this is intentionally followed by a valid review transition.
      type: 'plan.drafted',
      toolCallId: 'plan-call',
      taskId: 'task-parity',
      plan: DIFFERENTIAL_PLAN,
      planId: 'forged-plan',
      version: 1,
      structuralHash: 'sha256:forged',
      planSchemaVersion: 2,
      artifact: differentialPlanArtifact('forged-plan'),
    },
    {
      type: 'plan.review_requested',
      interactionId: 'plan-review-1',
      toolCallId: 'plan-call',
      taskId: 'task-parity',
      plan: DIFFERENTIAL_PLAN,
      planSummary: 'Parity plan',
      planId: 'plan-parity',
      version: 1,
      structuralDigest: DIFFERENTIAL_PLAN_HASH,
      artifact: planArtifact,
    },
    {
      type: 'plan.approved',
      interactionId: 'plan-review-1',
      toolCallId: 'plan-call',
      planId: 'plan-parity',
      version: 1,
      structuralDigest: DIFFERENTIAL_PLAN_HASH,
      executionMode: 'accept_edits',
    },
    {
      type: 'plan.replan_requested',
      toolCallId: 'plan-call',
      reason: 'The first step needs a fresh review.',
      supersedesPlanVersion: 1,
    },
    {
      type: 'plan.drafted',
      toolCallId: 'plan-call',
      taskId: 'task-parity',
      plan: DIFFERENTIAL_PLAN,
      planId: 'forged-plan-after-replan',
      version: 2,
      structuralHash: 'sha256:forged-after-replan',
      planSchemaVersion: 2,
      supersedesPlanVersion: 1,
      replanReason: 'The first step needs a fresh review.',
      artifact: differentialPlanArtifact('forged-plan-after-replan', 2),
    },
    {
      type: 'tool.queued',
      toolCallId: 'shell-approval',
      name: 'shell_execute',
      args: { command: 'echo parity', cwd: '/workspace' },
      taskId: 'task-parity',
      modelMessageId: 'message-approval',
      ordinal: 0,
      sideEffect: true,
      effectClass: 'external_side_effect',
      createdAt: OCCURRED_AT,
    },
    {
      type: 'approval.requested',
      interactionId: 'approval-1',
      toolCallId: 'shell-approval',
      approval: { kind: 'shell', command: 'echo parity', cwd: '/workspace' },
      createdAt: OCCURRED_AT,
    },
    {
      type: 'approval.granted',
      interactionId: 'approval-1',
      toolCallId: 'shell-approval',
      grant: 'approve_once',
      createdAt: '2026-08-20T00:00:01.000Z',
    },
    {
      type: 'tool.queued',
      toolCallId: 'shell-rejected',
      name: 'shell_execute',
      args: { command: 'echo rejected', cwd: '/workspace' },
      taskId: 'task-parity',
      modelMessageId: 'message-rejected',
      ordinal: 1,
      sideEffect: true,
      effectClass: 'external_side_effect',
      createdAt: OCCURRED_AT,
    },
    {
      type: 'approval.requested',
      interactionId: 'approval-2',
      toolCallId: 'shell-rejected',
      approval: { kind: 'shell', command: 'echo rejected', cwd: '/workspace' },
      createdAt: OCCURRED_AT,
    },
    {
      type: 'approval.rejected',
      interactionId: 'approval-2',
      toolCallId: 'shell-rejected',
      reason: 'fixture approval rejection',
      createdAt: '2026-08-20T00:00:01.500Z',
      outcome: DIFFERENTIAL_APPROVAL_REJECTED_OUTCOME,
    },
    {
      type: 'tool.queued',
      toolCallId: 'shell-auto-review',
      name: 'shell_execute',
      args: { command: 'echo auto-review', cwd: '/workspace' },
      taskId: 'task-parity',
      modelMessageId: 'message-auto-review',
      ordinal: 1,
      sideEffect: true,
      effectClass: 'external_side_effect',
      createdAt: OCCURRED_AT,
    },
    {
      type: 'auto_review.requested',
      reviewId: 'review-auto-1',
      toolCallId: 'shell-auto-review',
      toolName: 'shell_execute',
      reason: 'Automatic review is required for this command.',
      approval: { kind: 'shell', command: 'echo auto-review', cwd: '/workspace' },
      createdAt: OCCURRED_AT,
    },
    {
      type: 'auto_review.completed',
      reviewId: 'review-auto-1',
      toolCallId: 'shell-auto-review',
      result: { ok: true, approved: true, grant: 'approve_once', durationMs: 125 },
      createdAt: '2026-08-20T00:00:02.000Z',
    },
    {
      type: 'tool.queued',
      toolCallId: 'shell-auto-rejected',
      name: 'shell_execute',
      args: { command: 'echo auto-rejected', cwd: '/workspace' },
      taskId: 'task-parity',
      modelMessageId: 'message-auto-rejected',
      ordinal: 2,
      sideEffect: true,
      effectClass: 'external_side_effect',
      createdAt: OCCURRED_AT,
    },
    {
      type: 'auto_review.requested',
      reviewId: 'review-auto-2',
      toolCallId: 'shell-auto-rejected',
      toolName: 'shell_execute',
      reason: 'Automatic review rejects this deterministic fixture.',
      approval: { kind: 'shell', command: 'echo auto-rejected', cwd: '/workspace' },
      createdAt: '2026-08-20T00:00:02.500Z',
    },
    {
      type: 'auto_review.completed',
      reviewId: 'review-auto-2',
      toolCallId: 'shell-auto-rejected',
      result: {
        ok: true,
        approved: false,
        reason: 'fixture auto-review rejection',
        durationMs: 75,
      },
      createdAt: '2026-08-20T00:00:03.000Z',
      outcome: DIFFERENTIAL_AUTO_REVIEW_REJECTED_OUTCOME,
    },
    { type: 'turn.started', turnId: 'parity-turn-0002' },
    { type: 'task.completed', taskId: 'task-parity', turnId: 'parity-turn-0002' },
  ];
}

function workAndSkillSequence(): readonly DifferentialEvent[] {
  return [
    {
      type: 'task.started',
      taskId: 'task-work',
      userGoal: 'Run the work and skill lifecycle fixture',
      turnId: 'parity-turn-0001',
    },
    {
      type: 'tool.queued',
      toolCallId: 'work-tool',
      name: 'write_file',
      args: { path: 'fixture.txt', content: 'fixture' },
      taskId: 'task-work',
      modelMessageId: 'message-work',
      ordinal: 0,
      sideEffect: true,
      effectClass: 'workspace_write',
      createdAt: OCCURRED_AT,
    },
    { type: 'tool.started', toolCallId: 'work-tool', createdAt: OCCURRED_AT },
    { type: 'skill.catalog_refreshed', catalogRevision: 'skills-parity-1' },
    {
      type: 'skill.activation_started',
      activation: {
        activationId: 'skill-frame-1',
        taskId: 'task-work',
        skillId: 'skill-parity',
        activationRevision: 'skill-revision-1',
        requestedAt: OCCURRED_AT,
      },
    },
    {
      type: 'skill.frame_closed',
      activationId: 'skill-frame-1',
      status: 'closed',
      reason: 'completed',
      closedAt: '2026-08-20T00:00:03.000Z',
    },
  ];
}

function capabilitySequence(): readonly DifferentialEvent[] {
  const artifact = (artifactId: string, kind: string) => ({
    artifactId,
    kind,
    integrityIdentifier: `sha256:${artifactId.padEnd(64, '0').slice(0, 64)}`,
    byteLength: 1,
  });
  return [
    {
      type: 'capability.search_completed',
      result: {
        searchId: 'search-parity',
        query: 'read fixture',
        catalogRevision: 'catalog-parity-1',
        requestedAtTurnId: 'parity-turn-0001',
        candidates: [
          {
            capabilityId: 'builtin:read_file',
            capabilityRevision: 'read-revision-1',
            displayName: 'read_file',
          },
        ],
      },
    },
    {
      type: 'capability.bindings_issued',
      catalogRevision: 'catalog-parity-1',
      searchId: 'search-parity',
      bindings: [
        {
          bindingId: 'binding-read-1',
          capabilityId: 'builtin:read_file',
          capabilityRevision: 'read-revision-1',
          exposedToolName: 'read_file',
          schemaDigest: 'schema-read-1',
          issuedForTurnId: 'parity-turn-0001',
        },
      ],
      disclosures: [
        {
          capabilityId: 'builtin:read_file',
          capabilityRevision: 'read-revision-1',
          issuedForTurnId: 'parity-turn-0001',
        },
      ],
      loadedCapabilities: [
        {
          capabilityId: 'builtin:read_file',
          capabilityRevision: 'read-revision-1',
          firstLoadedAtTurnId: 'parity-turn-0001',
        },
      ],
    },
    {
      type: 'capability.invocation_recorded',
      invocationId: 'filesystem-invocation',
      toolCallId: 'filesystem-call',
      capabilityId: 'builtin:read_file',
      capabilityRevision: 'read-revision-1',
      taskId: 'task-capability',
      argumentsDigest: 'arguments-filesystem',
      authorizationDigest: 'authorization-filesystem',
      admissionDigest: 'admission-filesystem',
      effectiveEffectsDigest: 'effects-filesystem',
      effectiveEffects: { filesystem: 'read' },
      receiptRequirement: 'effect_receipt',
      retryEligibility: 'none',
      recordedAt: OCCURRED_AT,
    },
    {
      type: 'capability.execution_started',
      invocationId: 'filesystem-invocation',
      startedAt: OCCURRED_AT,
      attempt: 1,
    },
    {
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'filesystem-invocation',
      attempt: 1,
      capabilityRevision: 'read-revision-1',
      argumentsDigest: 'arguments-filesystem',
      admissionDigest: 'admission-filesystem',
      operationDigest: 'operation-filesystem',
      searchBoundaryDigest: null,
      lexicalTargetDigest: 'lexical-filesystem',
      canonicalWorkspaceDigest: 'workspace-filesystem',
      protectedPathRevision: 'protected-paths-1',
      approvalSummaryDigest: 'approval-filesystem',
      effectiveEffectsDigest: 'effects-filesystem',
      intentDigest: 'intent-filesystem',
      recordedAt: OCCURRED_AT,
    },
    {
      type: 'capability.filesystem_mutation_ready',
      invocationId: 'filesystem-invocation',
      attempt: 1,
      intentDigest: 'intent-filesystem',
      operationDigest: 'operation-filesystem',
      targetIdentityDigest: 'target-filesystem',
      preimageDigest: null,
      preimageArtifact: artifact('preimage-filesystem', 'filesystem_preimage'),
      readyDigest: 'ready-filesystem',
      readyAt: '2026-08-20T00:00:01.000Z',
    },
    {
      type: 'capability.execution_result_recorded',
      invocationId: 'filesystem-invocation',
      resultDigest: 'result-filesystem',
      evidenceDigest: 'evidence-filesystem',
      recordedAt: '2026-08-20T00:00:02.000Z',
      artifact: artifact('result-filesystem', 'capability_result'),
    },
    {
      type: 'capability.execution_succeeded',
      invocationId: 'filesystem-invocation',
      resultDigest: 'result-filesystem-final',
      evidenceDigest: 'evidence-filesystem-final',
      finishedAt: '2026-08-20T00:00:03.000Z',
      artifact: artifact('result-filesystem-final', 'capability_result'),
    },
    {
      type: 'capability.invocation_recorded',
      invocationId: 'sandbox-invocation',
      toolCallId: 'sandbox-call',
      capabilityId: 'builtin:shell_execute',
      capabilityRevision: 'shell-revision-1',
      argumentsDigest: 'arguments-shell',
      authorizationDigest: 'authorization-shell',
      admissionDigest: 'admission-shell',
      effectiveEffectsDigest: 'effects-shell',
      effectiveEffects: { externalState: 'write' },
      recordedAt: OCCURRED_AT,
    },
    {
      type: 'capability.execution_started',
      invocationId: 'sandbox-invocation',
      startedAt: OCCURRED_AT,
      attempt: 1,
    },
    {
      type: 'capability.sandbox_preparation_intent_recorded',
      invocationId: 'sandbox-invocation',
      attempt: 1,
      toolCallId: 'sandbox-call',
      capabilityId: 'builtin:shell_execute',
      capabilityRevision: 'shell-revision-1',
      canonicalWorkspace: '/workspace',
      effectiveEffectsDigest: 'effects-shell',
      admissionDigest: 'admission-shell',
      preparationDigest: 'preparation-shell',
      commandDigest: 'command-shell',
      executionBoundaryDigest: 'boundary-shell',
      resourceSemantics: 'allocating',
      intentDigest: 'intent-shell',
      recordedAt: OCCURRED_AT,
    },
    {
      type: 'capability.sandbox_preparation_ready',
      invocationId: 'sandbox-invocation',
      attempt: 1,
      intentDigest: 'intent-shell',
      preparationDigest: 'preparation-shell',
      commandDigest: 'command-shell',
      planDigest: 'plan-shell',
      backend: 'none',
      backendCapabilitiesDigest: 'backend-shell',
      enforcement: 'full',
      resourceSemantics: 'allocating',
      cleanupDigest: 'cleanup-shell',
      preparationArtifact: artifact('preparation-shell', 'sandbox_preparation'),
      readyDigest: 'ready-shell',
      readyAt: '2026-08-20T00:00:01.000Z',
    },
    {
      type: 'capability.sandbox_execution_dispatch_intent_recorded',
      invocationId: 'sandbox-invocation',
      attempt: 1,
      readyDigest: 'ready-shell',
      planDigest: 'plan-shell',
      dispatchId: 'dispatch-shell',
      supervisorNonce: 'nonce-shell',
      dispatchIntentDigest: 'dispatch-intent-shell',
      recordedAt: '2026-08-20T00:00:02.000Z',
    },
    {
      type: 'capability.sandbox_execution_supervisor_started',
      invocationId: 'sandbox-invocation',
      attempt: 1,
      dispatchId: 'dispatch-shell',
      dispatchIntentDigest: 'dispatch-intent-shell',
      supervisorPid: 10,
      processGroupId: 11,
      processStartIdentity: 'process-shell',
      startedAt: '2026-08-20T00:00:02.000Z',
    },
    {
      type: 'capability.sandbox_disposal_started',
      invocationId: 'sandbox-invocation',
      attempt: 1,
      readyDigest: 'ready-shell',
      lifecycleIntentDigest: 'lifecycle-shell',
      startedAt: '2026-08-20T00:00:03.000Z',
    },
    {
      type: 'capability.sandbox_disposal_completed',
      invocationId: 'sandbox-invocation',
      attempt: 1,
      readyDigest: 'ready-shell',
      lifecycleIntentDigest: 'lifecycle-shell',
      cleanupAttempt: 1,
      disposed: true,
      disposedAt: '2026-08-20T00:00:04.000Z',
    },
    {
      type: 'capability.execution_unknown',
      invocationId: 'sandbox-invocation',
      reason: 'provider outcome was not observed',
      finishedAt: '2026-08-20T00:00:05.000Z',
    },
    {
      type: 'capability.reconciliation_resolved',
      invocationId: 'sandbox-invocation',
      decision: 'confirmed_failure',
      reason: 'provider reported a failed command',
      reconciledAt: '2026-08-20T00:00:06.000Z',
    },
    {
      type: 'capability.invocation_recorded',
      invocationId: 'subagent-invocation',
      toolCallId: 'subagent-call',
      capabilityId: 'builtin:task',
      capabilityRevision: 'task-revision-1',
      argumentsDigest: 'arguments-task',
      authorizationDigest: 'authorization-task',
      effectiveEffectsDigest: 'effects-task',
      effectiveEffects: { externalState: 'write' },
      recordedAt: OCCURRED_AT,
    },
    {
      type: 'capability.execution_started',
      invocationId: 'subagent-invocation',
      startedAt: OCCURRED_AT,
      attempt: 1,
    },
    {
      type: 'capability.subagent_dispatch_intent_recorded',
      invocationId: 'subagent-invocation',
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'child-invocation',
      taskArtifact: artifact('task-subagent', 'subagent_task'),
      dispatchIntentDigest: 'dispatch-subagent',
      recordedAt: OCCURRED_AT,
    },
    {
      type: 'capability.subagent_handle_recorded',
      invocationId: 'subagent-invocation',
      attempt: 1,
      dispatchIntentDigest: 'dispatch-subagent',
      handleArtifact: artifact('handle-subagent', 'subagent_handle'),
      handleIntegrityIdentifier: 'handle-integrity-subagent',
      recordedAt: '2026-08-20T00:00:01.000Z',
    },
    {
      type: 'capability.subagent_observation_recorded',
      invocationId: 'subagent-invocation',
      attempt: 1,
      dispatchIntentDigest: 'dispatch-subagent',
      status: 'completed',
      observedAt: '2026-08-20T00:00:02.000Z',
    },
    {
      type: 'capability.subagent_cleanup_started',
      invocationId: 'subagent-invocation',
      attempt: 1,
      dispatchIntentDigest: 'dispatch-subagent',
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      startedAt: '2026-08-20T00:00:03.000Z',
    },
    {
      type: 'capability.subagent_cleanup_completed',
      invocationId: 'subagent-invocation',
      attempt: 1,
      dispatchIntentDigest: 'dispatch-subagent',
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      cleanupConfirmed: true,
      completedAt: '2026-08-20T00:00:04.000Z',
    },
    {
      type: 'capability.execution_result_recorded',
      invocationId: 'subagent-invocation',
      resultDigest: 'result-subagent',
      evidenceDigest: 'evidence-subagent',
      recordedAt: '2026-08-20T00:00:05.000Z',
      artifact: artifact('result-subagent', 'capability_result'),
    },
    {
      type: 'capability.execution_succeeded',
      invocationId: 'subagent-invocation',
      resultDigest: 'result-subagent-final',
      evidenceDigest: 'evidence-subagent-final',
      finishedAt: '2026-08-20T00:00:06.000Z',
      artifact: artifact('result-subagent-final', 'capability_result'),
    },
  ];
}

type RecoveryFailureInput = Parameters<typeof recordRootRecoveryFailure>[1];
type RecoveryAdmissionInput = Parameters<typeof admitRootRecoveryAttempt>[1];
type RecoveryInvocationInput = Parameters<typeof recordRootRecoveryInvocation>[1];
type RecoveryProgressInput = Parameters<typeof recordRootToolOwnedProgress>[1];
type RecoveryCloseInput = Parameters<typeof closeRootToolRecoveryScope>[1];
type RecoveryMergeScope = Parameters<typeof mergeRootToolRecoveryJournals>[3];
type RecoveryFingerprintInput = Parameters<typeof rootToolInvocationFingerprint>[0];
type RecoveryAdvanceInput = Parameters<typeof advanceRootToolRecoveryResponse>[1];

type RecoveryJournalApi<Journal> = {
  readonly create: (identityKey: string) => Journal;
  readonly fingerprint: (input: RecoveryFingerprintInput) => string;
  readonly recordFailure: (journal: Journal, input: RecoveryFailureInput) => Journal;
  readonly advance: (journal: Journal, input: RecoveryAdvanceInput) => Journal;
  readonly admit: (journal: Journal, input: RecoveryAdmissionInput) => unknown;
  readonly recordInvocation: (journal: Journal, input: RecoveryInvocationInput) => Journal;
  readonly recordProgress: (journal: Journal, input: RecoveryProgressInput) => Journal;
  readonly close: (journal: Journal, input: RecoveryCloseInput) => Journal;
  readonly merge: (parent: Journal, child: Journal, scope: RecoveryMergeScope) => Journal;
  readonly normalize: (journal: Journal) => Journal;
  readonly order: (journal: Journal) => readonly string[];
  readonly hasUnresolved: (journal: Journal) => boolean;
  readonly hasActive: (
    journal: Journal,
    scope: { readonly taskId?: string | null; readonly turnId?: string },
  ) => boolean;
};

type RecoveryJournalCorpusResult = {
  readonly admission: unknown;
  readonly journals: readonly unknown[];
  readonly predicates: readonly unknown[];
};

function runRecoveryJournalCorpus<Journal>(
  api: RecoveryJournalApi<Journal>,
): RecoveryJournalCorpusResult {
  const journals: Journal[] = [];
  const initial = api.create(IDENTITY_KEY);
  journals.push(initial);

  const firstFingerprint = api.fingerprint({
    toolName: 'read_file',
    parsedArgs: { path: 'src/example.ts', line_end: 12 },
    identityRevision: 'rmv1-s6-recovery-v1',
  });
  const first = api.recordFailure(initial, {
    toolCallId: 'recovery-call-1',
    toolName: 'read_file',
    invocationFingerprint: firstFingerprint,
    modelMessageId: 'recovery-model-1',
    taskId: 'recovery-task-1',
    turnId: 'recovery-turn-1',
    outcome: JOURNAL_FAILURE_OUTCOME as RootToolOutcome,
  });
  journals.push(first);
  const firstId = api.order(first)[0]!;

  const advanced = api.advance(first, {
    taskId: 'recovery-task-1',
    turnId: 'recovery-turn-1',
    modelMessageId: 'recovery-model-2',
    toolCalls: [{ id: 'recovery-call-2', name: 'read_file' }],
  });
  journals.push(advanced);

  const admissionInput: RecoveryAdmissionInput = {
    toolCallId: 'recovery-call-2',
    toolName: 'read_file',
    invocationFingerprint: api.fingerprint({
      toolName: 'read_file',
      parsedArgs: { path: 'src/example.ts', line_end: 20 },
      identityRevision: 'rmv1-s6-recovery-v1',
    }),
    modelMessageId: 'recovery-model-2',
    mode: 'model_correction',
    taskId: 'recovery-task-1',
    turnId: 'recovery-turn-1',
  };
  const admission = api.admit(advanced, admissionInput);
  const admitted =
    isRecord(admission) && admission.admitted === true && typeof admission.recoveryOf === 'string'
      ? api.recordInvocation(advanced, {
          toolCallId: admissionInput.toolCallId,
          recoveryOf: admission.recoveryOf,
          mode: admissionInput.mode,
        })
      : advanced;
  journals.push(admitted);

  const second = api.recordFailure(admitted, {
    toolCallId: admissionInput.toolCallId,
    toolName: admissionInput.toolName,
    invocationFingerprint: admissionInput.invocationFingerprint,
    modelMessageId: admissionInput.modelMessageId,
    taskId: admissionInput.taskId,
    turnId: admissionInput.turnId,
    outcome: {
      ...JOURNAL_FAILURE_OUTCOME,
      lineage: { recoveryOf: firstId },
    } as RootToolOutcome,
  });
  journals.push(second);
  const secondId = api.order(second).find((id) => id !== firstId)!;

  const progressed = api.recordProgress(second, {
    kind: 'receipt',
    referenceId: 'recovery-receipt-2',
    resolvesFailureIds: [secondId],
  });
  journals.push(progressed);

  const closed = api.close(progressed, {
    kind: 'failure',
    failureIds: [firstId],
    resolution: 'replanned',
  });
  journals.push(closed);

  const child = api.recordFailure(api.create(IDENTITY_KEY), {
    toolCallId: 'recovery-child-call-1',
    toolName: 'git_inspect',
    invocationFingerprint: api.fingerprint({
      toolName: 'git_inspect',
      parsedArgs: { path: '.' },
      identityRevision: 'rmv1-s6-recovery-v1',
    }),
    modelMessageId: 'recovery-child-model-1',
    taskId: 'recovery-child-task',
    turnId: 'recovery-child-turn',
    outcome: JOURNAL_REJECTED_OUTCOME as RootToolOutcome,
  });
  const merged = api.merge(closed, child, {
    taskId: 'recovery-task-1',
    turnId: 'recovery-turn-1',
  });
  journals.push(merged);
  journals.push(api.normalize(merged));

  return {
    admission,
    journals,
    predicates: [
      api.hasUnresolved(merged),
      api.hasActive(merged, { taskId: 'recovery-task-1', turnId: 'recovery-turn-1' }),
      api.hasActive(merged, { taskId: 'different-task', turnId: 'different-turn' }),
    ],
  };
}

const ROOT_RECOVERY_JOURNAL_API: RecoveryJournalApi<RootToolRecoveryJournal> = {
  create: (identityKey) => createRootToolRecoveryJournal(identityKey),
  fingerprint: (input) => rootToolInvocationFingerprint(input),
  recordFailure: (journal, input) => recordRootRecoveryFailure(journal, input),
  advance: (journal, input) => advanceRootToolRecoveryResponse(journal, input),
  admit: (journal, input) => admitRootRecoveryAttempt(journal, input),
  recordInvocation: (journal, input) => recordRootRecoveryInvocation(journal, input),
  recordProgress: (journal, input) => recordRootToolOwnedProgress(journal, input),
  close: (journal, input) => closeRootToolRecoveryScope(journal, input),
  merge: (parent, child, scope) =>
    mergeRootToolRecoveryJournals(parent, child, IDENTITY_KEY, scope),
  normalize: (journal) => normalizeRootToolRecoveryJournal(journal, IDENTITY_KEY),
  order: (journal) => journal.order,
  hasUnresolved: (journal) => hasRootUnresolvedToolFailures(journal),
  hasActive: (journal, scope) => hasActiveRootUnresolvedToolFailures(journal, scope),
};

const PACKAGE_RECOVERY_JOURNAL_API: RecoveryJournalApi<PackageToolRecoveryJournal> = {
  create: (identityKey) => createPackageToolRecoveryJournal(identityKey),
  fingerprint: (input) => packageToolInvocationFingerprint(input),
  recordFailure: (journal, input) => recordPackageRecoveryFailure(journal, input),
  advance: (journal, input) => advancePackageToolRecoveryResponse(journal, input),
  admit: (journal, input) => admitPackageRecoveryAttempt(journal, input),
  recordInvocation: (journal, input) => recordPackageRecoveryInvocation(journal, input),
  recordProgress: (journal, input) => recordPackageToolOwnedProgress(journal, input),
  close: (journal, input) => closePackageToolRecoveryScope(journal, input),
  merge: (parent, child, scope) =>
    mergePackageToolRecoveryJournals(parent, child, IDENTITY_KEY, scope),
  normalize: (journal) => normalizePackageToolRecoveryJournal(journal, IDENTITY_KEY),
  order: (journal) => journal.order,
  hasUnresolved: (journal) => hasPackageUnresolvedToolFailures(journal),
  hasActive: (journal, scope) => hasActivePackageUnresolvedToolFailures(journal, scope),
};

describe('RM State package parity harness', () => {
  test('keeps the exact initial State snapshot bytes', () => {
    expect(stateBytes(rootState())).toBe(textBytes(encodeCurrentAgentStateJson(packageState())));
  });

  test('pins the recovery corpus to State, Store4, and the RM epoch', () => {
    const root = rootState();
    const packageStateValue = packageState();
    expect(SQLITE_RUNTIME_STORE_SCHEMA_VERSION).toBe(5);
    expect(root.schemaVersion).toBe(26);
    expect(packageStateValue.schemaVersion).toBe(26);
    expect(root.formatEpoch).toBe(STATE_EPOCH);
    expect(packageStateValue.formatEpoch).toBe(STATE_EPOCH);
    expect('projectIdentity' in root).toBe(false);
    expect('projectIdentity' in packageStateValue).toBe(false);
  });

  test('mechanically compares JSON-safe recovery fingerprints, failure ids, and journal mutations', () => {
    const fingerprintInputs: readonly RecoveryFingerprintInput[] = [
      {
        toolName: 'read_file',
        parsedArgs: { path: 'src/example.ts', line_end: 12 },
        identityRevision: 'rmv1-s6-recovery-v1',
      },
      {
        toolName: 'git_inspect',
        parsedArgs: { path: '.', mode: 'status' },
        identityRevision: 'rmv1-s6-recovery-v1',
      },
      {
        toolName: 'mcp__server__tool',
        parseCode: 'invalid_json',
        pathCategory: 'unknown',
        unparsedArgs: { raw: 'é😀', position: 2 },
        identityRevision: 'dynamic-revision-v1',
      },
      {
        toolName: 'mcp__server__tool',
        parseCode: 'tool_unavailable',
        pathCategory: 'none',
        unparsedArgs: ['opaque', null, true],
        identityRevision: 'dynamic-revision-v1',
      },
    ];
    const rootFingerprints = fingerprintInputs.map((input) => rootToolInvocationFingerprint(input));
    const packageFingerprints = fingerprintInputs.map((input) =>
      packageToolInvocationFingerprint(input),
    );
    expect(packageFingerprints).toEqual(rootFingerprints);

    const failureIdOutcomes = [JOURNAL_FAILURE_OUTCOME, JOURNAL_REJECTED_OUTCOME] as const;
    const rootFailureIds = failureIdOutcomes.map((outcome, index) =>
      rootToolFailureInstanceId({
        toolCallId: `failure-id-call-${index + 1}`,
        invocationFingerprint: rootFingerprints[index]!,
        outcome: outcome as RootToolOutcome,
      }),
    );
    const packageFailureIds = failureIdOutcomes.map((outcome, index) =>
      packageToolFailureInstanceId({
        toolCallId: `failure-id-call-${index + 1}`,
        invocationFingerprint: packageFingerprints[index]!,
        outcome,
      }),
    );
    expect(packageFailureIds).toEqual(rootFailureIds);

    const rootCorpus = runRecoveryJournalCorpus(ROOT_RECOVERY_JOURNAL_API);
    const packageCorpus = runRecoveryJournalCorpus(PACKAGE_RECOVERY_JOURNAL_API);
    expect(packageCorpus).toEqual(rootCorpus);
    expect(packageCorpus.admission).toEqual({
      admitted: true,
      recoveryOf: expect.any(String),
    });
  });

  test('records fail-closed identity and non-JSON boundaries without a Core fallback', () => {
    const invalidCreate = probe(() => createPackageToolRecoveryJournal('not-a-host-key'));
    expect(invalidCreate.ok).toBe(false);
    expect(invalidCreate.ok ? '' : invalidCreate.error).toContain('canonical host-supplied key');

    const rootInvalidCreate = probe(() => createRootToolRecoveryJournal('not-a-host-key'));
    expect(rootInvalidCreate.ok).toBe(false);

    const invalidNormalize = probe(() =>
      normalizePackageToolRecoveryJournal(null, undefined as unknown as string),
    );
    expect(invalidNormalize.ok).toBe(false);
    expect(invalidNormalize.ok ? '' : invalidNormalize.error).toContain(
      'Host-supplied identityKey',
    );

    const rootInvalidNormalize = probe(() =>
      normalizeRootToolRecoveryJournal(null, undefined as unknown as string),
    );
    expect(rootInvalidNormalize.ok).toBe(false);

    const forged = {
      ...createPackageToolRecoveryJournal(IDENTITY_KEY),
      identityKey: 'f'.repeat(64),
    };
    const packageForged = normalizePackageToolRecoveryJournal(forged, IDENTITY_KEY);
    expect(isToolRecoveryJournalInvalid(packageForged)).toBe(true);
    expect(packageForged.identityKey).toBe(IDENTITY_KEY);
    expect(isToolRecoveryResolution('user_action')).toBe(true);
    expect(isToolRecoveryResolution('provider')).toBe(false);

    const nonJsonInput = {
      toolName: 'read_file',
      parsedArgs: undefined,
    } satisfies RecoveryFingerprintInput;
    const packageNonJson = probe(() => packageToolInvocationFingerprint(nonJsonInput));
    expect(packageNonJson.ok).toBe(false);
    expect(packageNonJson.ok ? '' : packageNonJson.error).toContain('not JSON serializable');
    const rootNonJson = probe(() => rootToolInvocationFingerprint(nonJsonInput));
    expect(rootNonJson.ok).toBe(false);
    expect(rootNonJson.ok ? '' : rootNonJson.error).toContain('not JSON serializable');
  });

  test('keeps the 136-event codec corpus mechanically comparable', () => {
    const eventTypes = Object.keys(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS) as RuntimeEventType[];
    expect(eventTypes).toHaveLength(CURRENT_RUNTIME_EVENT_TYPE_COUNT);

    const mismatches: Array<Record<string, unknown>> = [];
    for (const type of eventTypes) {
      const baseline = materializeEvent(type);
      const rootBaseline = rootCodec(baseline);
      const packageBaseline = packageCodec(materializeEvent(type));
      if (errorSignature(rootBaseline) !== errorSignature(packageBaseline)) {
        mismatches.push({ type, case: 'baseline', root: rootBaseline, package: packageBaseline });
      }

      for (const field of CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[type]) {
        const missing = materializeEvent(type);
        delete missing[field];
        const rootMissing = rootCodec(missing);
        const packageMissing = packageCodec(materializeEventWithDeletion(type, field));
        if (errorSignature(rootMissing) !== errorSignature(packageMissing)) {
          mismatches.push({
            type,
            case: `missing:${field}`,
            root: rootMissing,
            package: packageMissing,
          });
        }
      }

      const unknown = materializeEvent(type);
      unknown.unknownParityField = null;
      const rootUnknown = rootCodec(unknown);
      const packageUnknown = packageCodec(materializeEventWithUnknown(type));
      if (errorSignature(rootUnknown) !== errorSignature(packageUnknown)) {
        mismatches.push({
          type,
          case: 'unknown-field',
          root: rootUnknown,
          package: packageUnknown,
        });
      }

      const bytes = materializeEvent(type);
      const firstField = CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[type][0];
      if (firstField) bytes[firstField] = new Uint8Array([0xde, 0xad]);
      const rootBytes = rootCodec(bytes);
      const packageBytes = packageCodec(materializeEventWithBytes(type));
      if (errorSignature(rootBytes) !== errorSignature(packageBytes)) {
        mismatches.push({
          type,
          case: `bytes:${firstField ?? 'none'}`,
          root: rootBytes,
          package: packageBytes,
        });
      }
    }

    expectNoParityMismatches(mismatches, 'codec parity mismatch');
  });

  test('compares all 128 non-legacy-default reducer cases by state bytes or throw', () => {
    const eventTypes = Object.values(STATE_EVENT_REDUCER_COVERAGE)
      .flat()
      .filter((type) => !new Set<string>(STATE_DEFAULT_EVENT_TYPES).has(type));
    expect(eventTypes).toHaveLength(128);

    const mismatches: Array<Record<string, unknown>> = [];
    for (const type of eventTypes) {
      const root = rootReducer(type);
      const packageResult = packageReducer(type);
      if (root.ok !== packageResult.ok) {
        mismatches.push({ type, case: 'throw-status', root, package: packageResult });
      } else if (root.ok && packageResult.ok && root.value !== packageResult.value) {
        mismatches.push({
          type,
          case: 'state-bytes',
          diffs: jsonDiffs(jsonFromTextBytes(root.value), jsonFromTextBytes(packageResult.value)),
        });
      }
    }

    expectNoParityMismatches(mismatches, 'reducer parity mismatch');
  });

  test('compares the seven diagnostic/no-op discriminants independently', () => {
    expect(STATE_DIAGNOSTIC_EVENT_TYPES).toHaveLength(22);
    expect(STATE_DEFAULT_EVENT_TYPES).toHaveLength(7);

    const mismatches: Array<Record<string, unknown>> = [];
    for (const type of STATE_DEFAULT_EVENT_TYPES) {
      const root = rootReducer(type);
      const packageResult = packageReducer(type);
      if (root.ok !== packageResult.ok) {
        mismatches.push({ type, case: 'throw-status', root, package: packageResult });
      } else if (root.ok && packageResult.ok && root.value !== packageResult.value) {
        mismatches.push({
          type,
          case: 'state-bytes',
          diffs: jsonDiffs(jsonFromTextBytes(root.value), jsonFromTextBytes(packageResult.value)),
        });
      }
    }

    expectNoParityMismatches(mismatches, 'diagnostic parity mismatch');
  });

  test('compares all 44 canonical failure normalization cases without weakening the recovery contract', () => {
    const kinds = FAILURE_KINDS;
    expect(kinds).toHaveLength(44);
    const mismatches: Array<Record<string, unknown>> = [];
    for (const kind of kinds) {
      const root = rootToolOutcome(kind);
      const packageResult = packageToolOutcome(kind);
      if (
        root.ok !== packageResult.ok ||
        (root.ok && packageResult.ok && stableJson(root.value) !== stableJson(packageResult.value))
      ) {
        mismatches.push({ kind, root, package: packageResult });
      }
    }
    expectNoParityMismatches(mismatches, 'ToolOutcome parity mismatch');
  });

  test('keeps Core outcome APIs as direct package identity and preserves typed classifier facts', () => {
    expect(classifyRootToolOutcome).toBe(classifyPackageToolOutcome);
    expect(isRootToolOutcome).toBe(isPackageToolOutcome);
    expect(rootTrustedToolTiming).toBe(packageTrustedToolTiming);
    expect(rootToolOutcomeSucceeded).toBe(packageToolOutcomeSucceeded);
    expect(rootToolOutcomeProtocolStatus).toBe(packageToolOutcomeProtocolStatus);
    expect(rootToolOutcomeMetricStatus).toBe(packageToolOutcomeMetricStatus);

    const authority = {
      dispatchState: 'started' as const,
      externalEffects: 'known' as const,
      replaySafety: 'idempotency_receipt' as const,
    };
    const cases = [
      { status: 'success' as const },
      {
        status: 'failed' as const,
        failure: {
          kind: 'tool_runtime_error' as const,
          message: 'redacted fixture',
          retryable: true,
          modelFixable: true,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
        toolAdvice: { detailCode: 'runtime_exception', disposition: 'correct_args' } as const,
      },
      {
        status: 'rejected' as const,
        failure: {
          kind: 'approval_rejected' as const,
          message: 'redacted fixture',
          retryable: false,
          modelFixable: false,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
        authority: { ...authority, approvalDenied: true },
      },
      {
        status: 'failed' as const,
        failure: {
          kind: 'tool_runtime_error' as const,
          message: 'redacted fixture',
          retryable: true,
          modelFixable: true,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
        classifierDiagnostic: 'classifier_missing' as const,
      },
      {
        status: 'timed_out' as const,
        failure: {
          kind: 'tool_timeout' as const,
          message: 'redacted fixture',
          retryable: true,
          modelFixable: false,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        },
      },
    ];

    for (const fixture of cases) {
      const input = {
        ...fixture,
        authority: 'authority' in fixture ? (fixture.authority ?? authority) : authority,
        timing: { queueMs: 3.4, executionMs: 7.6, approvalWaitMs: -1, totalActiveMs: 20 },
        unknownFields: {
          hasUnknown: true,
          count: 1,
          toolClass: 'builtin_other' as const,
          schemaRevision: 'rmv1-s6-outcome-v1',
        },
      };
      const root = classifyRootToolOutcome(input);
      const packageOutcome = classifyPackageToolOutcome(input);
      expect(root).toEqual(packageOutcome);
      expect(isRootToolOutcome(root)).toBe(true);
      expect(isPackageToolOutcome(packageOutcome)).toBe(true);
      expect(rootToolOutcomeSucceeded(root)).toBe(packageToolOutcomeSucceeded(packageOutcome));
      expect(rootToolOutcomeProtocolStatus(root)).toBe(
        packageToolOutcomeProtocolStatus(packageOutcome),
      );
      expect(rootToolOutcomeMetricStatus(root)).toBe(
        packageToolOutcomeMetricStatus(packageOutcome),
      );
    }

    const failureCorpus = FAILURE_KINDS.map((kind) => ({
      status: 'failed' as const,
      failure: classifyFailure(kind, 'redacted 44-kind fixture'),
      authority: {
        ...authority,
        ...(kind === 'policy_denied' || kind === 'mandatory_policy_unavailable'
          ? { policyDenied: true }
          : {}),
        ...(kind === 'auto_review_rejected' ? { approvalDenied: true } : {}),
      },
      timing: { queueMs: 3, executionMs: 7, approvalWaitMs: 2, totalActiveMs: 20 },
      unknownFields: {
        hasUnknown: true,
        count: 1,
        toolClass: 'builtin_other' as const,
        schemaRevision: 'rmv1-s6-outcome-v1',
      },
    }));
    expect(failureCorpus).toHaveLength(44);
    for (const input of failureCorpus) {
      const root = classifyRootToolOutcome(input);
      const packageOutcome = classifyPackageToolOutcome(input);
      expect(root).toEqual(packageOutcome);
      expect(isRootToolOutcome(root)).toBe(true);
      expect(isPackageToolOutcome(packageOutcome)).toBe(true);
    }

    const baseInput = {
      status: 'failed' as const,
      failure: {
        kind: 'tool_runtime_error' as const,
        message: 'redacted fixture',
        retryable: true,
        modelFixable: true,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      },
      authority,
    };
    const builtinObservation = classifyRootToolOutcome({
      ...baseInput,
      unknownFields: {
        hasUnknown: true,
        count: 1,
        toolClass: 'builtin_read',
        schemaRevision: 'rmv1-s6-outcome-v1',
      },
    });
    const mcpObservation = classifyRootToolOutcome({
      ...baseInput,
      unknownFields: {
        hasUnknown: true,
        count: 1,
        toolClass: 'mcp_tool',
        schemaRevision: 'rmv1-s6-outcome-v1',
      },
    });
    expect({
      status: builtinObservation.status,
      failure: builtinObservation.failure,
      recovery: builtinObservation.recovery,
      dispatchState: builtinObservation.dispatchState,
      externalEffects: builtinObservation.externalEffects,
    }).toEqual({
      status: mcpObservation.status,
      failure: mcpObservation.failure,
      recovery: mcpObservation.recovery,
      dispatchState: mcpObservation.dispatchState,
      externalEffects: mcpObservation.externalEffects,
    });
    expect(builtinObservation.unknownFields?.toolClass).toBe('builtin_read');
    expect(mcpObservation.unknownFields?.toolClass).toBe('mcp_tool');
  });

  test('rejects malformed scheduler facts before selecting an executable effect', () => {
    const malformedFacts: SchedulerFacts = { traits: {}, approval: {} };
    Object.defineProperty(malformedFacts, 'traits', { configurable: true, value: null });
    expect(isValidSchedulerFacts(malformedFacts)).toBe(false);

    const packageDecision = probe(() => decidePackageEffect(packageState(), malformedFacts));
    expect(packageDecision).toEqual({
      ok: true,
      value: {
        type: 'recovery_blocked',
        reason: 'Host scheduling facts are malformed or contain executable data.',
        failureKind: 'persistence_unavailable',
      },
    });
  });

  test('compares completion V1/V2 blockers on the same logical fixtures', () => {
    const v1 = [
      {
        name: 'idle',
        root: decideUnplannedCompletion(rootState()),
        package: decidePackageCompletion(packageState()),
      },
      {
        name: 'queued-tool',
        root: decideUnplannedCompletion(rootQueuedState()),
        package: decidePackageCompletion(packageQueuedState()),
      },
    ];
    const v2 = {
      root: probe(() => decidePlannedCompletion(rootCompletedPlanState())),
      package: probe(() => decidePackageCompletion(packageCompletedPlanState())),
    };
    const mismatches: Array<unknown> = v1.filter(
      (entry) => stableJson(entry.root) !== stableJson(entry.package),
    );
    if (
      v2.root.ok !== v2.package.ok ||
      (v2.root.ok && v2.package.ok && stableJson(v2.root.value) !== stableJson(v2.package.value))
    ) {
      mismatches.push({ name: 'v2-completed-plan', root: v2.root, package: v2.package });
    }
    expectNoParityMismatches(mismatches, 'completion parity mismatch');
  });

  test('compares task/turn/plan, approval, and auto-review lifecycle sequences', () => {
    const mismatches = reduceDifferentialSequence(
      'lifecycle-and-authorization',
      lifecycleAndAuthorizationSequence(),
    );
    expectNoParityMismatches(mismatches, 'lifecycle/authorization sequence parity mismatch');
  });

  test('compares ResourceBudget configure/reserve/dispatch/reconcile/release/unknown/waiter sequences', () => {
    const mismatches = reduceDifferentialSequence(
      'resource-budget',
      differentialResourceSequence(),
    );
    expectNoParityMismatches(mismatches, 'resource budget sequence parity mismatch');
  });

  test('compares work side-effect and skill frame lifecycle sequences', () => {
    const mismatches = reduceDifferentialSequence('work-and-skill', workAndSkillSequence());
    expectNoParityMismatches(mismatches, 'work/skill sequence parity mismatch');
  });

  test('compares capability search/binding, filesystem, sandbox, subagent, and terminal sequences', () => {
    const mismatches = reduceDifferentialSequence('capability', capabilitySequence());
    expectNoParityMismatches(mismatches, 'capability sequence parity mismatch');
  });

  test('projects the current schema compiler result as an identity-bound Kernel fact', () => {
    const deeplyNested: Record<string, unknown> = { type: 'string' };
    for (let index = 0; index < 40; index += 1) {
      Object.assign(deeplyNested, {
        type: 'object',
        properties: { nested: structuredClone(deeplyNested) },
      });
    }
    const cases: readonly {
      readonly name: string;
      readonly check: VerificationCheck;
    }[] = [
      {
        name: 'valid-schema',
        check: {
          checkId: 'check-1',
          description: 'valid object schema',
          type: 'schema',
          subject: { kind: 'literal', value: {} },
          schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      },
      {
        name: 'non-object-root',
        check: {
          checkId: 'check-1',
          description: 'non-object root',
          type: 'schema',
          subject: { kind: 'literal', value: {} },
          schema: { type: 'string' },
        },
      },
      {
        name: 'malformed-property-schema',
        check: {
          checkId: 'check-1',
          description: 'malformed property schema',
          type: 'schema',
          subject: { kind: 'literal', value: {} },
          schema: { type: 'object', properties: { value: 1 } },
        },
      },
      {
        name: 'unknown-keyword',
        check: {
          checkId: 'check-1',
          description: 'unknown keyword schema',
          type: 'schema',
          subject: { kind: 'literal', value: {} },
          schema: { type: 'object', unknownKeyword: true },
        },
      },
      {
        name: 'utf8-within-budget',
        check: {
          checkId: 'check-1',
          description: 'UTF-8 schema within budget',
          type: 'schema',
          subject: { kind: 'literal', value: {} },
          schema: { type: 'object', description: '界'.repeat(1_000) },
        },
      },
      {
        name: 'utf8-over-budget',
        check: {
          checkId: 'check-1',
          description: 'UTF-8 schema over budget',
          type: 'schema',
          subject: { kind: 'literal', value: {} },
          schema: { type: 'object', description: '界'.repeat(90_000) },
        },
      },
      {
        name: 'depth-over-budget',
        check: {
          checkId: 'check-1',
          description: 'schema depth over budget',
          type: 'schema',
          subject: { kind: 'literal', value: {} },
          schema: deeplyNested,
        },
      },
      {
        name: 'mcp-output-schema',
        check: {
          checkId: 'check-1',
          description: 'MCP output schema',
          type: 'mcp_read_after_write',
          invocationId: 'invocation-1',
          capabilityId: 'mcp:fixture',
          capabilityRevision: 'revision-1',
          arguments: {},
          outputSchema: { type: 'object', properties: { value: 1 } },
        },
      },
    ];

    for (const candidate of cases) {
      const initial = rootState();
      const checks: VerificationCheck[] = [candidate.check];
      const event = {
        type: 'verification.requested',
        verificationId: `verification-${candidate.name}`,
        mode: 'required',
        spec: {
          schemaVersion: 1,
          verificationId: `verification-${candidate.name}`,
          subject: candidate.name,
          repair: { maxAttempts: 1 },
          checks,
        },
        requestedAt: OCCURRED_AT,
      } as RuntimeEvent;
      const verificationSchemaAdmissions = checks.map((check) => {
        if (check.type === 'schema') {
          const compiled = compileCapabilitySchema(check.schema);
          return {
            schemaDigest: verificationSchemaAdmissionDigest(check.schema),
            schemaDiagnostic: compiled.ok ? null : compiled.diagnostic,
          };
        }
        if (check.type === 'mcp_read_after_write' && check.outputSchema) {
          const compiled = compileCapabilitySchema(check.outputSchema);
          return {
            outputSchemaDigest: verificationSchemaAdmissionDigest(check.outputSchema),
            outputSchemaDiagnostic: compiled.ok ? null : compiled.diagnostic,
          };
        }
        return null;
      });
      const expected = reduceAgentState(initial as AgentState, event as KernelEvent, {
        verificationSchemaAdmissions,
      }).verification;
      const store = openStateStoreForTest(':memory:');
      const kernel = new AgentKernel({
        store,
        initialState: initial,
        interactionMode: 'accept_edits',
        runtimeIdSource: createDeterministicRuntimeIdSource({
          seed: `schema-${candidate.name}`,
          epochMs: Date.parse(OCCURRED_AT),
        }),
      });
      kernel.processEvent(event);
      expect(stableJson(kernel.getState().verification), candidate.name).toBe(stableJson(expected));
      kernel.close();
    }
  });
});

function materializeEventWithDeletion(
  type: RuntimeEventType,
  field: string,
): Record<string, unknown> {
  const value = materializeEvent(type);
  delete value[field];
  return value;
}

function materializeEventWithUnknown(type: RuntimeEventType): Record<string, unknown> {
  const value = materializeEvent(type);
  value.unknownParityField = null;
  return value;
}

function materializeEventWithBytes(type: RuntimeEventType): Record<string, unknown> {
  const value = materializeEvent(type);
  const firstField = CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS[type][0];
  if (firstField) value[firstField] = new Uint8Array([0xde, 0xad]);
  return value;
}
