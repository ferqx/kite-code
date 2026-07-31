import type { FailureKind, TerminalReasonCodeV1 } from './failures';
import { classifyFailure } from './failures';
import type { RunTerminalOutcomeV1, RuntimeTerminalStatusV1 } from './terminal-outcome';
import { failedTerminalOutcomeV1, projectTerminalOutcomeV1 } from './terminal-outcome';

export const RUNTIME_FAILURE_MODES_V1 = Object.freeze([
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
] as const);

export type RuntimeFailureModeV1 = (typeof RUNTIME_FAILURE_MODES_V1)[number];

export type FailureModeDispositionV1 = 'continue' | 'block' | 'degrade';

export type FailureModeDurableStateV1 =
  | RuntimeTerminalStatusV1
  | 'preserved'
  | 'capability_disabled'
  | 'verification_required'
  | 'diagnostic_channel_disabled'
  | 'rollout_fallback';

export type FailureModeFallbackV1 =
  | 'none'
  | 'bounded_model_retry'
  | 'disable_process_and_write'
  | 'in_process_read_only_network_off'
  | 'network_off'
  | 'disable_affected_binding'
  | 'safe_read_only_diagnostics'
  | 'preserve_transcript_new_session_handoff'
  | 'disable_diagnostic_channel'
  | 'embedded_profile'
  | 'disable_only_cache';

export interface FailureModeResolutionV1 {
  version: 1;
  mode: RuntimeFailureModeV1;
  disposition: FailureModeDispositionV1;
  /** Automatic effectful invocations admitted in response to this failure. */
  newInvocationCount: 0 | 1;
  durableState: FailureModeDurableStateV1;
  externalSideEffects: RunTerminalOutcomeV1['knownExternalEffects'];
  reasonCode: RuntimeFailureModeV1;
  terminalReason: TerminalReasonCodeV1 | null;
  userMessage: string;
  safeRetry: boolean;
  recoveryEntry: RunTerminalOutcomeV1['recoveryEntry'];
  pendingVerification: boolean;
  fallback: FailureModeFallbackV1;
  terminalOutcome: RunTerminalOutcomeV1 | null;
}

export interface FailureModeContextV1 {
  remainingModelRetryAttempts?: number;
  requiredMcpStep?: boolean;
  processCleanupConfirmed?: boolean;
  sandboxReadOnlyProfileAllowed?: boolean;
  sandboxReadOnlyConformancePassed?: boolean;
  validDisableOnlyCache?: boolean;
  /** Evidence already recorded for the run before this failure was resolved. */
  knownExternalEffects?: RunTerminalOutcomeV1['knownExternalEffects'];
}

interface TerminalSpec {
  failureKind: FailureKind;
  reasonCode?: TerminalReasonCodeV1;
  externalSideEffects?: RunTerminalOutcomeV1['knownExternalEffects'];
  pendingVerification?: boolean;
  fallback?: FailureModeFallbackV1;
  status?: RuntimeTerminalStatusV1;
  safeRetry?: boolean;
  recoveryEntry?: RunTerminalOutcomeV1['recoveryEntry'];
}

function joinExternalEffects(
  local: RunTerminalOutcomeV1['knownExternalEffects'] | undefined,
  existing: RunTerminalOutcomeV1['knownExternalEffects'] | undefined,
): RunTerminalOutcomeV1['knownExternalEffects'] {
  if (local === undefined) return existing ?? 'unknown';
  if (existing === undefined) return local;
  if (local === 'unknown' || existing === 'unknown') return 'unknown';
  if (local === 'known' || existing === 'known') return 'known';
  return 'none';
}

function terminalResolution(
  mode: RuntimeFailureModeV1,
  spec: TerminalSpec,
  knownExternalEffects?: RunTerminalOutcomeV1['knownExternalEffects'],
): FailureModeResolutionV1 {
  const failure = classifyFailure(spec.failureKind, mode);
  const externalSideEffects = joinExternalEffects(spec.externalSideEffects, knownExternalEffects);
  const projectedOutcome = failedTerminalOutcomeV1(failure, {
    knownExternalEffects: externalSideEffects,
    pendingVerification: spec.pendingVerification,
    reasonCode: spec.reasonCode,
  });
  const terminalOutcome: RunTerminalOutcomeV1 = {
    ...projectedOutcome,
    status:
      externalSideEffects === 'unknown'
        ? projectedOutcome.status
        : (spec.status ?? projectedOutcome.status),
    safeRetry:
      externalSideEffects === 'unknown' ? false : (spec.safeRetry ?? projectedOutcome.safeRetry),
    recoveryEntry:
      externalSideEffects === 'unknown'
        ? 'reconcile'
        : (spec.recoveryEntry ?? projectedOutcome.recoveryEntry),
  };
  return {
    version: 1,
    mode,
    disposition: 'block',
    newInvocationCount: 0,
    durableState:
      spec.pendingVerification === true ? 'verification_required' : terminalOutcome.status,
    externalSideEffects: terminalOutcome.knownExternalEffects,
    reasonCode: mode,
    terminalReason: terminalOutcome.reasonCode,
    userMessage: projectTerminalOutcomeV1(terminalOutcome).label,
    safeRetry: terminalOutcome.safeRetry,
    recoveryEntry: terminalOutcome.recoveryEntry,
    pendingVerification: terminalOutcome.pendingVerification,
    fallback: spec.fallback ?? 'none',
    terminalOutcome,
  };
}

function degradedResolution(
  mode: RuntimeFailureModeV1,
  input: Pick<
    FailureModeResolutionV1,
    | 'durableState'
    | 'externalSideEffects'
    | 'userMessage'
    | 'safeRetry'
    | 'recoveryEntry'
    | 'pendingVerification'
    | 'fallback'
  >,
  knownExternalEffects?: RunTerminalOutcomeV1['knownExternalEffects'],
): FailureModeResolutionV1 {
  return {
    version: 1,
    mode,
    disposition: 'degrade',
    newInvocationCount: 0,
    reasonCode: mode,
    terminalReason: null,
    terminalOutcome: null,
    ...input,
    externalSideEffects: joinExternalEffects(input.externalSideEffects, knownExternalEffects),
  };
}

const TERMINAL_FAILURE_MODES = Object.freeze({
  artifact_invalid: { failureKind: 'artifact_invalid', externalSideEffects: 'none' },
  profile_invalid: { failureKind: 'profile_invalid', externalSideEffects: 'none' },
  digest_invalid: { failureKind: 'digest_invalid', externalSideEffects: 'none' },
  workspace_untrusted: { failureKind: 'workspace_untrusted', externalSideEffects: 'none' },
  worktree_failure: { failureKind: 'worktree_unavailable', externalSideEffects: 'none' },
  disk_full: {
    failureKind: 'persistence_unavailable',
    fallback: 'safe_read_only_diagnostics',
  },
  filesystem_read_only: {
    failureKind: 'persistence_unavailable',
    fallback: 'safe_read_only_diagnostics',
  },
  sqlite_busy: {
    failureKind: 'persistence_unavailable',
    fallback: 'safe_read_only_diagnostics',
  },
  sqlite_corrupt: {
    failureKind: 'persistence_unavailable',
    fallback: 'safe_read_only_diagnostics',
  },
  budget_exhausted: { failureKind: 'budget_exceeded' },
  tool_permit_timeout: {
    failureKind: 'resource_saturated',
    reasonCode: 'tool_concurrency_saturated',
  },
  shell_permit_timeout: {
    failureKind: 'resource_saturated',
    reasonCode: 'shell_concurrency_saturated',
  },
  compaction_unqualified: {
    failureKind: 'compaction_unqualified',
    fallback: 'preserve_transcript_new_session_handoff',
  },
  compaction_failed: {
    failureKind: 'compaction_failed',
    fallback: 'preserve_transcript_new_session_handoff',
  },
  verification_failed: {
    failureKind: 'verification_failed',
    pendingVerification: true,
  },
  verification_inconclusive: {
    failureKind: 'verification_inconclusive',
    pendingVerification: true,
  },
  mandatory_admin_policy_unavailable: {
    failureKind: 'mandatory_policy_unavailable',
    externalSideEffects: 'none',
  },
} as const satisfies Partial<Record<RuntimeFailureModeV1, TerminalSpec>>);

const MCP_FAILURE_KIND = Object.freeze({
  mcp_discovery_failure: 'mcp_unavailable',
  mcp_auth_failure: 'provider_auth_required',
  mcp_revision_failure: 'provider_capability_changed',
  mcp_transport_failure: 'mcp_unavailable',
} as const satisfies Partial<Record<RuntimeFailureModeV1, FailureKind>>);

function modelFailureResolution(
  mode: Extract<RuntimeFailureModeV1, 'model_timeout' | 'model_rate_limit' | 'model_server_error'>,
  remainingModelRetryAttempts: number,
  knownExternalEffects?: RunTerminalOutcomeV1['knownExternalEffects'],
): FailureModeResolutionV1 {
  if (remainingModelRetryAttempts <= 0) {
    return terminalResolution(mode, { failureKind: 'model_retry_exhausted' }, knownExternalEffects);
  }
  const existingExternalEffects = knownExternalEffects ?? 'unknown';
  if (existingExternalEffects === 'unknown') {
    return terminalResolution(
      mode,
      { failureKind: 'unknown', reasonCode: 'unknown' },
      existingExternalEffects,
    );
  }
  return {
    version: 1,
    mode,
    disposition: 'continue',
    newInvocationCount: 1,
    durableState: 'preserved',
    externalSideEffects: joinExternalEffects('none', existingExternalEffects),
    reasonCode: mode,
    terminalReason: null,
    userMessage: 'Retrying model request within the configured retry budget',
    safeRetry: true,
    recoveryEntry: 'retry',
    pendingVerification: false,
    fallback: 'bounded_model_retry',
    terminalOutcome: null,
  };
}

/**
 * Resolve the minimum RFC failure-mode contract without parsing display text.
 * Callers may narrow capabilities further, but cannot admit more invocations or a weaker fallback.
 */
export function resolveFailureModeV1(
  mode: RuntimeFailureModeV1,
  context: FailureModeContextV1 = {},
): FailureModeResolutionV1 {
  if (mode === 'model_timeout' || mode === 'model_rate_limit' || mode === 'model_server_error') {
    return modelFailureResolution(
      mode,
      context.remainingModelRetryAttempts ?? 0,
      context.knownExternalEffects,
    );
  }

  const terminalSpec = TERMINAL_FAILURE_MODES[mode as keyof typeof TERMINAL_FAILURE_MODES] as
    | TerminalSpec
    | undefined;
  if (terminalSpec) {
    return terminalResolution(mode, terminalSpec, context.knownExternalEffects);
  }

  const mcpFailureKind = MCP_FAILURE_KIND[mode as keyof typeof MCP_FAILURE_KIND];
  if (mcpFailureKind) {
    if (context.requiredMcpStep === true) {
      if (mode === 'mcp_revision_failure') {
        return terminalResolution(
          mode,
          {
            failureKind: 'provider_capability_changed',
            reasonCode: 'blocked',
            status: 'blocked',
            safeRetry: false,
            recoveryEntry: 'operator_action',
          },
          context.knownExternalEffects,
        );
      }
      const requiredFailureKind =
        mode === 'mcp_auth_failure' ? 'provider_auth_required' : 'mcp_unavailable';
      return terminalResolution(
        mode,
        { failureKind: requiredFailureKind },
        context.knownExternalEffects,
      );
    }
    const existingExternalEffects = context.knownExternalEffects ?? 'unknown';
    if (existingExternalEffects === 'unknown') {
      return terminalResolution(
        mode,
        { failureKind: 'unknown', reasonCode: 'unknown' },
        existingExternalEffects,
      );
    }
    return degradedResolution(
      mode,
      {
        durableState: 'capability_disabled',
        externalSideEffects: 'none',
        userMessage: 'Affected MCP binding unavailable',
        safeRetry: classifyFailure(mcpFailureKind, mode).retryable,
        recoveryEntry: classifyFailure(mcpFailureKind, mode).retryable
          ? 'retry'
          : 'operator_action',
        pendingVerification: false,
        fallback: 'disable_affected_binding',
      },
      existingExternalEffects,
    );
  }

  if (
    (context.knownExternalEffects ?? 'unknown') === 'unknown' &&
    (mode === 'sandbox_unavailable' ||
      mode === 'network_controller_unavailable' ||
      mode === 'metadata_logger_failure' ||
      mode === 'optional_telemetry_failure' ||
      mode === 'optional_rollout_unavailable')
  ) {
    return terminalResolution(mode, { failureKind: 'unknown', reasonCode: 'unknown' }, 'unknown');
  }

  switch (mode) {
    case 'sandbox_unavailable':
      return degradedResolution(
        mode,
        {
          durableState: 'capability_disabled',
          externalSideEffects: 'none',
          userMessage: 'Process and write capabilities unavailable',
          safeRetry: false,
          recoveryEntry: 'operator_action',
          pendingVerification: false,
          fallback:
            context.sandboxReadOnlyProfileAllowed === true &&
            context.sandboxReadOnlyConformancePassed === true
              ? 'in_process_read_only_network_off'
              : 'disable_process_and_write',
        },
        context.knownExternalEffects,
      );
    case 'network_controller_unavailable':
      return degradedResolution(
        mode,
        {
          durableState: 'capability_disabled',
          externalSideEffects: 'none',
          userMessage: 'Network-dependent capabilities unavailable',
          safeRetry: false,
          recoveryEntry: 'operator_action',
          pendingVerification: false,
          fallback: 'network_off',
        },
        context.knownExternalEffects,
      );
    case 'process_tree_limit':
      return context.processCleanupConfirmed === true
        ? terminalResolution(
            mode,
            {
              failureKind: 'process_limit_exceeded',
              reasonCode: 'process_limit_exceeded',
              externalSideEffects: 'known',
            },
            context.knownExternalEffects,
          )
        : terminalResolution(
            mode,
            {
              failureKind: 'cancel_incomplete',
              reasonCode: 'cancel_incomplete',
              externalSideEffects: 'unknown',
            },
            context.knownExternalEffects,
          );
    case 'cancel_timeout':
      return terminalResolution(
        mode,
        {
          failureKind: 'cancel_incomplete',
          reasonCode: 'cancel_incomplete',
          externalSideEffects: 'unknown',
        },
        context.knownExternalEffects,
      );
    case 'metadata_logger_failure':
    case 'optional_telemetry_failure':
      return degradedResolution(
        mode,
        {
          durableState: 'diagnostic_channel_disabled',
          externalSideEffects: 'none',
          userMessage: 'Optional diagnostics unavailable; runtime continues',
          safeRetry: false,
          recoveryEntry: 'none',
          pendingVerification: false,
          fallback: 'disable_diagnostic_channel',
        },
        context.knownExternalEffects,
      );
    case 'optional_rollout_unavailable':
      return degradedResolution(
        mode,
        {
          durableState: 'rollout_fallback',
          externalSideEffects: 'none',
          userMessage: 'Optional rollout unavailable; permissions remain unchanged or tighter',
          safeRetry: false,
          recoveryEntry: 'none',
          pendingVerification: false,
          fallback:
            context.validDisableOnlyCache === true ? 'disable_only_cache' : 'embedded_profile',
        },
        context.knownExternalEffects,
      );
    default:
      throw new Error(`Unhandled runtime failure mode: ${mode}`);
  }
}
