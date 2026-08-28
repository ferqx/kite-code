import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  type StateFailureModeContext as FailureModeContext,
  type StateFailureModeResolution as FailureModeResolution,
  STATE_RUNTIME_FAILURE_MODES_ as RUNTIME_FAILURE_MODES_,
  type StateRuntimeFailureMode as RuntimeFailureMode,
  type RuntimeState,
  runtimeHostStateResolveFailureMode as resolveFailureMode,
} from '@kite-ai/runtime-host/kernel-adapter';
import { classifyFailure } from '#kite-service/bootstrap/runtime/failures';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';
import { projectRuntimeClientEvent } from '../../src/runtime-client/event-projector';

const EXPECTED_FAILURE_MODES = [
  'artifact_invalid',
  'profile_invalid',
  'digest_invalid',
  'workspace_untrusted',
  'sandbox_unavailable',
  'network_controller_unavailable',
  'worktree_failure',
  'model_timeout',
  'model_rate_limit',
  'model_server_error',
  'mcp_discovery_failure',
  'mcp_auth_failure',
  'mcp_revision_failure',
  'mcp_transport_failure',
  'disk_full',
  'filesystem_read_only',
  'sqlite_busy',
  'sqlite_corrupt',
  'budget_exhausted',
  'tool_permit_timeout',
  'shell_permit_timeout',
  'process_tree_limit',
  'cancel_timeout',
  'compaction_unqualified',
  'compaction_failed',
  'verification_failed',
  'verification_inconclusive',
  'metadata_logger_failure',
  'optional_telemetry_failure',
  'mandatory_admin_policy_unavailable',
  'optional_rollout_unavailable',
] as const satisfies readonly RuntimeFailureMode[];

type ExpectedResolution = Omit<FailureModeResolution, 'version' | 'mode' | 'reasonCode'>;

interface FailureFixture {
  context?: FailureModeContext;
  expected: ExpectedResolution;
}

function terminalExpected(input: {
  reason: NonNullable<FailureModeResolution['terminalReason']>;
  status?: NonNullable<FailureModeResolution['terminalOutcome']>['status'];
  durableState?: FailureModeResolution['durableState'];
  effects?: FailureModeResolution['externalSideEffects'];
  safeRetry?: boolean;
  recoveryEntry?: FailureModeResolution['recoveryEntry'];
  pendingVerification?: boolean;
  fallback?: FailureModeResolution['fallback'];
}): ExpectedResolution {
  const status = input.status ?? 'blocked';
  const effects = input.effects ?? 'none';
  const safeRetry = input.safeRetry ?? false;
  const recoveryEntry = input.recoveryEntry ?? 'operator_action';
  const pendingVerification = input.pendingVerification ?? false;
  return {
    disposition: 'block',
    newInvocationCount: 0,
    durableState: input.durableState ?? status,
    externalSideEffects: effects,
    terminalReason: input.reason,
    userMessage: input.reason.replaceAll('_', ' '),
    safeRetry,
    recoveryEntry,
    pendingVerification,
    fallback: input.fallback ?? 'none',
    terminalOutcome: {
      version: 1,
      status,
      reasonCode: input.reason,
      knownExternalEffects: effects,
      safeRetry,
      recoveryEntry,
      pendingVerification,
    },
  };
}

const preDispatchBlocked = (
  reason: NonNullable<FailureModeResolution['terminalReason']>,
): ExpectedResolution => terminalExpected({ reason });

const unknownTerminal = (
  reason: NonNullable<FailureModeResolution['terminalReason']>,
  input: Partial<Parameters<typeof terminalExpected>[0]> = {},
): ExpectedResolution =>
  terminalExpected({
    reason,
    status: 'unknown',
    effects: 'unknown',
    recoveryEntry: 'reconcile',
    ...input,
  });

const optionalMcp = (safeRetry: boolean): ExpectedResolution => ({
  disposition: 'degrade',
  newInvocationCount: 0,
  durableState: 'capability_disabled',
  externalSideEffects: 'none',
  terminalReason: null,
  userMessage: 'Affected MCP binding unavailable',
  safeRetry,
  recoveryEntry: safeRetry ? 'retry' : 'operator_action',
  pendingVerification: false,
  fallback: 'disable_affected_binding',
  terminalOutcome: null,
});

const diagnosticsDegraded: ExpectedResolution = {
  disposition: 'degrade',
  newInvocationCount: 0,
  durableState: 'diagnostic_channel_disabled',
  externalSideEffects: 'none',
  terminalReason: null,
  userMessage: 'Optional diagnostics unavailable; runtime continues',
  safeRetry: false,
  recoveryEntry: 'none',
  pendingVerification: false,
  fallback: 'disable_diagnostic_channel',
  terminalOutcome: null,
};

const sandboxDegraded: ExpectedResolution = {
  disposition: 'degrade',
  newInvocationCount: 0,
  durableState: 'capability_disabled',
  externalSideEffects: 'none',
  terminalReason: null,
  userMessage: 'Process and write capabilities unavailable',
  safeRetry: false,
  recoveryEntry: 'operator_action',
  pendingVerification: false,
  fallback: 'disable_process_and_write',
  terminalOutcome: null,
};

const FIXTURES = {
  artifact_invalid: { expected: preDispatchBlocked('artifact_invalid') },
  profile_invalid: { expected: preDispatchBlocked('profile_invalid') },
  digest_invalid: { expected: preDispatchBlocked('digest_invalid') },
  workspace_untrusted: { expected: preDispatchBlocked('workspace_untrusted') },
  sandbox_unavailable: {
    context: { knownExternalEffects: 'none' },
    expected: sandboxDegraded,
  },
  network_controller_unavailable: {
    context: { knownExternalEffects: 'none' },
    expected: {
      ...sandboxDegraded,
      userMessage: 'Network-dependent capabilities unavailable',
      fallback: 'network_off',
    },
  },
  worktree_failure: { expected: preDispatchBlocked('worktree_unavailable') },
  model_timeout: { expected: unknownTerminal('model_retry_exhausted') },
  model_rate_limit: { expected: unknownTerminal('model_retry_exhausted') },
  model_server_error: { expected: unknownTerminal('model_retry_exhausted') },
  mcp_discovery_failure: {
    context: { knownExternalEffects: 'none' },
    expected: optionalMcp(true),
  },
  mcp_auth_failure: {
    context: { knownExternalEffects: 'none' },
    expected: optionalMcp(false),
  },
  mcp_revision_failure: {
    context: { knownExternalEffects: 'none' },
    expected: optionalMcp(false),
  },
  mcp_transport_failure: {
    context: { knownExternalEffects: 'none' },
    expected: optionalMcp(true),
  },
  disk_full: {
    expected: unknownTerminal('persistence_unavailable', {
      fallback: 'safe_read_only_diagnostics',
    }),
  },
  filesystem_read_only: {
    expected: unknownTerminal('persistence_unavailable', {
      fallback: 'safe_read_only_diagnostics',
    }),
  },
  sqlite_busy: {
    expected: unknownTerminal('persistence_unavailable', {
      fallback: 'safe_read_only_diagnostics',
    }),
  },
  sqlite_corrupt: {
    expected: unknownTerminal('persistence_unavailable', {
      fallback: 'safe_read_only_diagnostics',
    }),
  },
  budget_exhausted: {
    expected: unknownTerminal('budget_exhausted', {
      status: 'budget_exhausted',
      durableState: 'budget_exhausted',
    }),
  },
  tool_permit_timeout: {
    expected: unknownTerminal('tool_concurrency_saturated', {
      status: 'resource_saturated',
      durableState: 'resource_saturated',
    }),
  },
  shell_permit_timeout: {
    expected: unknownTerminal('shell_concurrency_saturated', {
      status: 'resource_saturated',
      durableState: 'resource_saturated',
    }),
  },
  process_tree_limit: { expected: unknownTerminal('cancel_incomplete') },
  cancel_timeout: { expected: unknownTerminal('cancel_incomplete') },
  compaction_unqualified: {
    expected: unknownTerminal('compaction_unqualified', {
      fallback: 'preserve_transcript_new_session_handoff',
    }),
  },
  compaction_failed: {
    expected: unknownTerminal('compaction_failed', {
      fallback: 'preserve_transcript_new_session_handoff',
    }),
  },
  verification_failed: {
    expected: unknownTerminal('verification_failed', {
      durableState: 'verification_required',
      pendingVerification: true,
    }),
  },
  verification_inconclusive: {
    expected: unknownTerminal('verification_inconclusive', {
      durableState: 'verification_required',
      pendingVerification: true,
    }),
  },
  metadata_logger_failure: {
    context: { knownExternalEffects: 'none' },
    expected: diagnosticsDegraded,
  },
  optional_telemetry_failure: {
    context: { knownExternalEffects: 'none' },
    expected: diagnosticsDegraded,
  },
  mandatory_admin_policy_unavailable: {
    expected: preDispatchBlocked('mandatory_policy_unavailable'),
  },
  optional_rollout_unavailable: {
    context: { knownExternalEffects: 'none' },
    expected: {
      disposition: 'degrade',
      newInvocationCount: 0,
      durableState: 'rollout_fallback',
      externalSideEffects: 'none',
      terminalReason: null,
      userMessage: 'Optional rollout unavailable; permissions remain unchanged or tighter',
      safeRetry: false,
      recoveryEntry: 'none',
      pendingVerification: false,
      fallback: 'embedded_profile',
      terminalOutcome: null,
    },
  },
} as const satisfies Record<RuntimeFailureMode, FailureFixture>;

function expectExactResolution(
  mode: RuntimeFailureMode,
  expected: ExpectedResolution,
  context?: FailureModeContext,
): void {
  expect(resolveFailureMode(mode, context)).toEqual({
    version: 1,
    mode,
    reasonCode: mode,
    ...expected,
  });
}

function fixtureContext(fixture: FailureFixture): FailureModeContext | undefined {
  return fixture.context;
}

describe('RFC failure-mode conformance v1', () => {
  test('ratchets the independent canonical list to exactly 31 failure modes', () => {
    expect(RUNTIME_FAILURE_MODES_).toHaveLength(31);
    expect(RUNTIME_FAILURE_MODES_).toEqual(EXPECTED_FAILURE_MODES);
    expect(Object.keys(FIXTURES)).toEqual([...EXPECTED_FAILURE_MODES]);
  });

  test('covers every failure mode with an exact canonical resolution', () => {
    for (const mode of EXPECTED_FAILURE_MODES) {
      const fixture = FIXTURES[mode];
      expectExactResolution(mode, fixture.expected, fixtureContext(fixture));
    }
  });

  test('uses the same terminal outcome through Core persistence and Client projection', () => {
    const store = openStateStoreForTest(':memory:');
    try {
      for (const mode of EXPECTED_FAILURE_MODES) {
        const fixture = FIXTURES[mode];
        const resolution = resolveFailureMode(mode, fixtureContext(fixture));
        if (!resolution.terminalOutcome) continue;
        const message = `fixture ${mode}`;
        const event = {
          type: 'run.error' as const,
          message,
          recoverable: false,
          failure: classifyFailure('unknown', message),
          outcome: resolution.terminalOutcome,
        };
        const coreState = reduceRuntimeState(
          createRuntimeHostStateInitialState({
            recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
            threadId: mode,
            userId: 'u',
            workspace: '/',
          }),
          event,
        );
        store.saveSnapshot(mode, coreState);
        expect(store.loadSnapshot<RuntimeState>(mode)?.terminalOutcome).toEqual(
          resolution.terminalOutcome,
        );

        const clientEvent = projectRuntimeClientEvent(event, {
          sessionRevision: coreState.revision,
        });
        if (!clientEvent) throw new Error('expected a projected failure lifecycle event');
        expect(clientEvent).toEqual({
          type: 'run.failure',
          runId: 'runtime-run',
          code: resolution.terminalOutcome.reasonCode,
          retryable: resolution.terminalOutcome.safeRetry,
          recoveryEntry: resolution.terminalOutcome.recoveryEntry,
        });
      }
    } finally {
      store.close();
    }
  });

  test.each([
    'model_timeout',
    'model_rate_limit',
    'model_server_error',
  ] as const)('%s admits exactly one retry only while the bounded retry budget remains', (mode) => {
    expectExactResolution(
      mode,
      {
        disposition: 'continue',
        newInvocationCount: 1,
        durableState: 'preserved',
        externalSideEffects: 'none',
        terminalReason: null,
        userMessage: 'Retrying model request within the configured retry budget',
        safeRetry: true,
        recoveryEntry: 'retry',
        pendingVerification: false,
        fallback: 'bounded_model_retry',
        terminalOutcome: null,
      },
      { remainingModelRetryAttempts: 1, knownExternalEffects: 'none' },
    );
    expectExactResolution(mode, unknownTerminal('model_retry_exhausted'), {
      remainingModelRetryAttempts: 0,
    });
  });

  test('never continues or degrades while prior external effects remain unknown', () => {
    for (const [mode, context] of [
      ['model_timeout', { remainingModelRetryAttempts: 1 }],
      ['mcp_discovery_failure', {}],
      ['sandbox_unavailable', {}],
      ['metadata_logger_failure', {}],
      ['optional_rollout_unavailable', {}],
    ] as const) {
      expectExactResolution(mode, unknownTerminal('unknown'), {
        ...context,
        knownExternalEffects: 'unknown',
      });
    }
  });

  test('treats omitted external-effect evidence as unknown before continuing or degrading', () => {
    for (const [mode, context] of [
      ['model_timeout', { remainingModelRetryAttempts: 1 }],
      ['mcp_discovery_failure', {}],
      [
        'sandbox_unavailable',
        { sandboxReadOnlyProfileAllowed: true, sandboxReadOnlyConformancePassed: true },
      ],
      ['network_controller_unavailable', {}],
      ['metadata_logger_failure', {}],
      ['optional_telemetry_failure', {}],
      ['optional_rollout_unavailable', { validDisableOnlyCache: true }],
    ] as const) {
      expectExactResolution(mode, unknownTerminal('unknown'), context);
    }
  });

  test('propagates known prior external effects through nonterminal resolutions', () => {
    expectExactResolution(
      'model_timeout',
      {
        disposition: 'continue',
        newInvocationCount: 1,
        durableState: 'preserved',
        externalSideEffects: 'known',
        terminalReason: null,
        userMessage: 'Retrying model request within the configured retry budget',
        safeRetry: true,
        recoveryEntry: 'retry',
        pendingVerification: false,
        fallback: 'bounded_model_retry',
        terminalOutcome: null,
      },
      { remainingModelRetryAttempts: 1, knownExternalEffects: 'known' },
    );
    expectExactResolution(
      'mcp_discovery_failure',
      { ...optionalMcp(true), externalSideEffects: 'known' },
      { knownExternalEffects: 'known' },
    );
  });

  test.each([
    ['mcp_discovery_failure', 'mcp_unavailable', true, 'retry'],
    ['mcp_auth_failure', 'blocked', false, 'operator_action'],
    ['mcp_revision_failure', 'blocked', false, 'operator_action'],
    ['mcp_transport_failure', 'mcp_unavailable', true, 'retry'],
  ] as const)('%s locks required-binding retry and recovery semantics', (mode, reason, safeRetry, recoveryEntry) => {
    expectExactResolution(mode, terminalExpected({ reason, safeRetry, recoveryEntry }), {
      requiredMcpStep: true,
      knownExternalEffects: 'none',
    });
  });

  test('requires both profile authorization and conformance for read-only sandbox fallback', () => {
    for (const sandboxReadOnlyProfileAllowed of [false, true]) {
      for (const sandboxReadOnlyConformancePassed of [false, true]) {
        const fallback =
          sandboxReadOnlyProfileAllowed && sandboxReadOnlyConformancePassed
            ? 'in_process_read_only_network_off'
            : 'disable_process_and_write';
        expectExactResolution(
          'sandbox_unavailable',
          { ...sandboxDegraded, fallback },
          {
            sandboxReadOnlyProfileAllowed,
            sandboxReadOnlyConformancePassed,
            knownExternalEffects: 'none',
          },
        );
      }
    }
  });

  test('required MCP revision drift preserves unknown evidence and requires reconciliation', () => {
    expectExactResolution('mcp_revision_failure', unknownTerminal('blocked'), {
      requiredMcpStep: true,
      knownExternalEffects: 'unknown',
    });
  });

  test('treats process cleanup as confirmed only on explicit positive evidence', () => {
    for (const processCleanupConfirmed of [false, undefined]) {
      expectExactResolution('process_tree_limit', unknownTerminal('cancel_incomplete'), {
        processCleanupConfirmed,
      });
    }
    expectExactResolution(
      'process_tree_limit',
      terminalExpected({
        reason: 'process_limit_exceeded',
        status: 'budget_exhausted',
        durableState: 'budget_exhausted',
        effects: 'known',
      }),
      { processCleanupConfirmed: true },
    );
  });

  test.each([
    ['budget_exhausted', 'budget_exhausted', 'budget_exhausted', 'none'],
    ['disk_full', 'persistence_unavailable', 'blocked', 'safe_read_only_diagnostics'],
    ['verification_failed', 'verification_failed', 'verification_required', 'none'],
  ] as const)('%s propagates known external-effect evidence instead of inventing none', (mode, reason, durableState, fallback) => {
    expectExactResolution(
      mode,
      terminalExpected({
        reason,
        status: mode === 'budget_exhausted' ? 'budget_exhausted' : 'blocked',
        durableState,
        effects: 'known',
        pendingVerification: mode === 'verification_failed',
        fallback,
      }),
      { knownExternalEffects: 'known' },
    );
  });

  test('uses only a valid disable-only rollout cache; otherwise embedded profile', () => {
    expectExactResolution(
      'optional_rollout_unavailable',
      { ...FIXTURES.optional_rollout_unavailable.expected, fallback: 'disable_only_cache' },
      { validDisableOnlyCache: true, knownExternalEffects: 'none' },
    );
    expectExactResolution(
      'optional_rollout_unavailable',
      FIXTURES.optional_rollout_unavailable.expected,
      { knownExternalEffects: 'none' },
    );
  });
});
