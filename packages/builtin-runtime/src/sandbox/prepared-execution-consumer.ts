import { randomUUID } from 'node:crypto';
import type { SandboxPreparationIntentRecord } from '@kite-ai/runtime-contract';
import type {
  PreparedSandboxExecution,
  SandboxExecutionBackend,
  SandboxExecutionDispatchIntentAcknowledgement,
  SandboxExecutionProvider,
  SandboxExecutionProviderFailureCode,
  SandboxExecutionProviderResult,
  SandboxPreparation,
  SandboxPreparationGrant,
  SandboxPreparationLifecycle,
  SandboxPreparedProcessCleanup,
  SandboxPreparedProcessExecutionResult,
  SandboxPreparedProcessUnknownResult,
} from '@kite-ai/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';
import { projectApprovedProxyEnvironment } from './approved-proxy-environment';
import { sandboxBackendCapabilities } from './execution/backend-capabilities';
import {
  type SandboxExecutionGrantAuthority,
  sandboxCommandDigest,
  sandboxPreparationDigest,
} from './execution/grant-authority';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawn,
  cleanupWindowsSandboxRuntimeDirNoSpawn,
  sandboxRuntimeDirForPreparation,
  sandboxRuntimeRootsForPreparation,
} from './execution/local-runtime-filesystem';
import {
  type BuiltinSandboxPreparationInput,
  createBuiltinSandboxPreparation,
} from './preparation-authority';
import type { SandboxInvocationIdentity } from './shell-contract';
import type { ResourceLimits, ShellFilesystemMode, ShellNetworkMode } from './types';

/**
 * Builtin-owned input for one already-authorized shell operation.
 *
 * The process mechanism is deliberately an SPI port.  This module never
 * imports the Host, starts a process, or selects a second shell supervisor.
 */
export interface BuiltinPreparedShellExecutionInput {
  readonly identity: Readonly<SandboxInvocationIdentity>;
  readonly workspace: string;
  readonly command: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  readonly filesystemMode?: ShellFilesystemMode;
  readonly networkMode?: ShellNetworkMode;
  readonly executionTrust?: BuiltinSandboxPreparationInput['executionTrust'];
  /** Durable lifecycle is mandatory for allocating preparation and dispatch. */
  readonly lifecycle?: Readonly<SandboxPreparationLifecycle>;
}

export interface BuiltinPreparedShellExecutionConsumerOptions {
  /** Provider resolution is called once, after allocating intent acknowledgement. */
  readonly provider?: SandboxExecutionProvider;
  readonly resolveProviderAfterIntent?: () =>
    | SandboxExecutionProvider
    | Promise<SandboxExecutionProvider>;
  readonly resourceSemantics?: SandboxExecutionProvider['resourceSemantics'];
  readonly backend: Exclude<SandboxExecutionBackend, 'none'>;
  readonly grants: SandboxExecutionGrantAuthority;
  readonly preparedProcess: import('@kite-ai/runtime-spi').SandboxPreparedProcessExecutionPort;
  readonly canonicalWorkspace: string;
  readonly executionBoundaryDigest: string;
  readonly protectedPathRevision: string;
  readonly maxProcessTreeTasks?: number;
  readonly resourceLimits?: Partial<ResourceLimits>;
  readonly now?: () => number;
  readonly createDispatchIdentity?: () => Readonly<{
    readonly dispatchId: string;
    readonly supervisorNonce: string;
  }>;
}

export type BuiltinPreparedShellExecutionKind = 'completed' | 'terminated' | 'failed' | 'unknown';

export interface BuiltinPreparedShellDisposalEvidence {
  readonly purpose: 'dispose' | 'reconcile_preparation_intent';
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
  readonly acknowledged: boolean;
  readonly disposed: boolean;
}

/** JSON-safe Builtin projection; `processResult` preserves the SPI terminal union. */
export interface BuiltinPreparedShellExecutionResult {
  readonly kind: BuiltinPreparedShellExecutionKind;
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly processResult: Readonly<SandboxPreparedProcessExecutionResult> | null;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanup> | null;
  readonly terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
  readonly sandboxFailure?: {
    readonly code: SandboxExecutionProviderFailureCode;
    readonly stage: 'pre_dispatch' | 'post_dispatch';
    readonly cleanupConfirmed: boolean;
  };
  readonly disposal?: Readonly<BuiltinPreparedShellDisposalEvidence>;
}

/**
 * Builtin Shell/Sandbox consumer candidate for RM-16 Shell C.
 *
 * The sequence is intentionally linear and single-attempt:
 * intent → provider prepare → ready → dispatch intent → injected Host process
 * port → disposal intent → provider cleanup → disposal receipt.  A missing
 * pre-GO acknowledgement never reaches the process port.  A post-GO unknown
 * is returned as the SPI unknown union and is never changed into a failure or
 * retried.
 */
export function createBuiltinPreparedShellExecutionConsumer(
  options: BuiltinPreparedShellExecutionConsumerOptions,
): (
  input: Readonly<BuiltinPreparedShellExecutionInput>,
) => Promise<Readonly<BuiltinPreparedShellExecutionResult>> {
  const now = options.now ?? Date.now;
  const createDispatchIdentity =
    options.createDispatchIdentity ??
    (() => Object.freeze({ dispatchId: randomUUID(), supervisorNonce: randomUUID() }));

  return async (input) => {
    const resourceSemantics =
      options.resourceSemantics ?? options.provider?.resourceSemantics ?? 'allocating';
    const lifecycle = input.lifecycle;
    if (!input.identity) {
      return denied(input, 'Sandbox invocation identity is missing.', 'command_denied', false);
    }
    if (resourceSemantics === 'allocating' && !lifecycle) {
      return denied(
        input,
        'Allocating sandbox preparation requires a durable lifecycle.',
        'command_denied',
        false,
      );
    }
    if (input.signal?.aborted) return cancelled(input);

    let preparation: Readonly<SandboxPreparation>;
    try {
      preparation = createBuiltinSandboxPreparation({
        identity: input.identity,
        canonicalWorkspace: options.canonicalWorkspace,
        workspace: input.workspace,
        command: input.command,
        executionBoundaryDigest: options.executionBoundaryDigest,
        protectedPathRevision: options.protectedPathRevision,
        ...(input.filesystemMode ? { filesystemMode: input.filesystemMode } : {}),
        ...(input.networkMode ? { networkMode: input.networkMode } : {}),
        ...(input.executionTrust ? { executionTrust: input.executionTrust } : {}),
        ...(options.maxProcessTreeTasks !== undefined
          ? { maxProcessTreeTasks: options.maxProcessTreeTasks }
          : {}),
        ...(options.resourceLimits ? { resourceLimits: options.resourceLimits } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      }).preparation;
    } catch (error) {
      return denied(input, message(error), 'preparation_failed', false);
    }

    let intentDigest: string | undefined;
    let intentAcknowledged = false;
    if (resourceSemantics === 'allocating') {
      const intent = await acknowledgePreparationIntent(lifecycle!, preparation);
      if (!intent.ok) {
        return denied(input, intent.message, 'command_denied', false);
      }
      intentDigest = intent.intentDigest;
      intentAcknowledged = true;
    }

    let provider: SandboxExecutionProvider | undefined;
    let providerPrepareAttempted = false;
    let prepared: Readonly<PreparedSandboxExecution> | undefined;
    let preparationReadyAcknowledged = false;
    let processResult: Readonly<SandboxPreparedProcessExecutionResult> | null = null;
    let result: BuiltinPreparedShellExecutionResult = denied(
      input,
      'Sandbox execution did not produce an outcome.',
      'command_denied',
      false,
    );

    try {
      for (let attempt = 0; attempt < 1; attempt += 1) {
        try {
          provider = options.resolveProviderAfterIntent
            ? await options.resolveProviderAfterIntent()
            : options.provider;
        } catch (error) {
          result = denied(
            input,
            `Sandbox backend qualification failed: ${message(error)}`,
            'backend_unavailable',
            false,
          );
          break;
        }
        if (!provider || provider.resourceSemantics !== resourceSemantics) {
          result = denied(
            input,
            'Sandbox backend qualification returned invalid resource semantics.',
            'backend_unavailable',
            false,
          );
          break;
        }

        let grant: Readonly<SandboxPreparationGrant>;
        try {
          grant = options.grants.issue({
            preparation,
            resourceSemantics,
            ...(intentDigest ? { preparationIntentDigest: intentDigest } : {}),
          });
        } catch (error) {
          result = denied(input, message(error), 'invalid_grant', false);
          break;
        }

        providerPrepareAttempted = true;
        const preparedResult = await provider
          .prepare({
            grant,
            ...(input.signal ? { signal: input.signal } : {}),
          })
          .catch(
            (error): SandboxExecutionProviderResult<PreparedSandboxExecution> => ({
              ok: false,
              failure: Object.freeze({ code: 'preparation_failed', message: message(error) }),
            }),
          );
        if (!preparedResult.ok) {
          result = providerFailure(
            input,
            preparedResult.failure.code,
            preparedResult.failure.message,
            'pre_dispatch',
          );
          break;
        }
        prepared = preparedResult.observation;

        const identityFailure = validatePreparedIdentity({
          prepared,
          preparation,
          identity: input.identity,
          resourceSemantics,
          backend: options.backend,
          now,
        });
        if (identityFailure) {
          result = denied(input, identityFailure, 'invalid_grant', false);
          break;
        }

        if (resourceSemantics === 'allocating') {
          const ready = await acknowledgePreparationReady(lifecycle!, prepared);
          if (!ready.ok) {
            result = denied(input, ready.message, 'command_denied', false);
            break;
          }
          preparationReadyAcknowledged = true;
        }

        if (!lifecycle) {
          result = denied(
            input,
            'Prepared dispatch requires a durable lifecycle.',
            'command_denied',
            false,
          );
          break;
        }
        if (input.signal?.aborted) {
          result = cancelled(input);
          break;
        }

        const dispatchIdentity = createDispatchIdentity();
        const dispatch = await acknowledgeDispatchIntent(lifecycle, prepared, dispatchIdentity);
        if (!dispatch.ok) {
          result = denied(input, dispatch.message, 'command_denied', false);
          break;
        }

        try {
          const remainingLifetimeMs = prepared.expiresAtMs - now();
          if (remainingLifetimeMs <= 0) {
            result = denied(
              input,
              'Prepared sandbox plan expired before dispatch.',
              'expired_grant',
              false,
            );
            break;
          }
          processResult = await options.preparedProcess.execute({
            prepared,
            dispatchIntent: dispatch.acknowledgement,
            lifecycle,
            timeoutMs: Math.min(preparation.timeoutMs, remainingLifetimeMs),
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
            ephemeralEnvironment: projectApprovedProxyEnvironment({
              networkMode: input.networkMode ?? 'disabled',
            }),
          });
        } catch (error) {
          // The SPI port may have crossed GO before throwing.  Preserve the
          // conservative terminal signal; never turn this into a retryable fail.
          processResult = unknownProcessResult('post_go_transport_lost', message(error));
        }
        result = projectProcessResult(input.command, processResult);
      }
    } finally {
      if (lifecycle && intentAcknowledged) {
        const cleanup = await dispose({
          input,
          lifecycle,
          grants: options.grants,
          provider,
          providerPrepareAttempted,
          prepared,
          preparation,
          intentDigest: intentDigest!,
          preparationReadyAcknowledged,
          processResult,
          backend: options.backend,
          result,
        }).catch(() => ({
          result: withPostDispatchFailure(
            result,
            'dispose_failed',
            false,
            'Sandbox disposal could not be completed.',
          ),
        }));
        result = cleanup.result;
      }
    }
    return result;
  };
}

async function dispose(input: {
  readonly input: Readonly<BuiltinPreparedShellExecutionInput>;
  readonly lifecycle: Readonly<SandboxPreparationLifecycle>;
  readonly grants: SandboxExecutionGrantAuthority;
  readonly provider: SandboxExecutionProvider | undefined;
  readonly providerPrepareAttempted: boolean;
  readonly prepared: Readonly<PreparedSandboxExecution> | undefined;
  readonly preparation: Readonly<SandboxPreparation>;
  readonly intentDigest: string;
  readonly preparationReadyAcknowledged: boolean;
  readonly processResult: Readonly<SandboxPreparedProcessExecutionResult> | null;
  readonly backend: Exclude<SandboxExecutionBackend, 'none'>;
  readonly result: Readonly<BuiltinPreparedShellExecutionResult>;
}): Promise<{ readonly result: Readonly<BuiltinPreparedShellExecutionResult> }> {
  const cleanupPrepared = input.preparationReadyAcknowledged ? (input.prepared ?? null) : null;
  const disposal = await input.lifecycle.recordDisposalIntent(cleanupPrepared).catch(() => null);
  if (!isDisposalIntent(disposal, cleanupPrepared !== null)) {
    return {
      result: withPostDispatchFailure(
        input.result,
        'dispose_failed',
        false,
        'Sandbox disposal intent acknowledgement failed.',
      ),
    };
  }

  let cleanupConfirmed = false;
  try {
    cleanupConfirmed = isCleanupConfirmed({
      preparation: input.preparation,
      prepared: cleanupPrepared,
      processResult: input.processResult,
      backend: input.backend,
    });
  } catch {
    cleanupConfirmed = false;
  }
  let disposed = false;
  try {
    if (disposal.purpose === 'reconcile_preparation_intent') {
      const cleanupGrant = input.grants.issueCleanup({
        purpose: disposal.purpose,
        intent: preparationIntentRecord(input.preparation, input.intentDigest),
        invocationId: input.preparation.invocationId,
        lifecycleIntentDigest: disposal.lifecycleIntentDigest,
        cleanupAttempt: disposal.cleanupAttempt,
        cleanupConfirmed: cleanupConfirmed || !input.providerPrepareAttempted,
      });
      const reconciled =
        input.provider && input.providerPrepareAttempted
          ? await input.provider
              .reconcilePreparationIntent({ grant: cleanupGrant })
              .catch(() => null)
          : null;
      disposed = input.providerPrepareAttempted ? reconciled?.ok === true : cleanupConfirmed;
    } else if (input.provider && cleanupPrepared && input.providerPrepareAttempted) {
      const cleanupGrant = input.grants.issueCleanup({
        purpose: 'dispose',
        prepared: cleanupPrepared,
        lifecycleIntentDigest: disposal.lifecycleIntentDigest,
        cleanupAttempt: disposal.cleanupAttempt,
        cleanupConfirmed,
      });
      const disposedResult = await input.provider
        .dispose({ grant: cleanupGrant, prepared: cleanupPrepared })
        .catch(() => null);
      disposed = disposedResult?.ok === true;
    } else {
      disposed = cleanupConfirmed;
    }
  } catch {
    disposed = false;
  }

  const receipt = await input.lifecycle
    .recordDisposalReceipt({
      prepared: cleanupPrepared,
      purpose: disposal.purpose,
      lifecycleIntentDigest: disposal.lifecycleIntentDigest,
      cleanupAttempt: disposal.cleanupAttempt,
      disposed,
    })
    .catch(() => null);
  const receiptAcknowledged = isDisposalReceipt(
    receipt,
    disposal,
    cleanupPrepared !== null,
    disposed,
  );
  const evidence = Object.freeze({
    purpose: disposal.purpose,
    lifecycleIntentDigest: disposal.lifecycleIntentDigest,
    cleanupAttempt: disposal.cleanupAttempt,
    acknowledged: receiptAcknowledged,
    disposed,
  });
  if (!disposed || !receiptAcknowledged) {
    return {
      result: withPostDispatchFailure(
        { ...input.result, disposal: evidence },
        'dispose_failed',
        cleanupConfirmed,
        disposed
          ? 'Sandbox disposal receipt acknowledgement failed.'
          : 'Sandbox cleanup could not be confirmed.',
      ),
    };
  }
  const resultWithCleanupEvidence = input.result.sandboxFailure
    ? Object.freeze({
        ...input.result,
        sandboxFailure: Object.freeze({
          ...input.result.sandboxFailure,
          cleanupConfirmed: true,
        }),
        disposal: evidence,
      })
    : Object.freeze({ ...input.result, disposal: evidence });
  return { result: resultWithCleanupEvidence };
}

function validatePreparedIdentity(input: {
  readonly prepared: Readonly<PreparedSandboxExecution>;
  readonly preparation: Readonly<SandboxPreparation>;
  readonly identity: Readonly<SandboxInvocationIdentity>;
  readonly resourceSemantics: SandboxExecutionProvider['resourceSemantics'];
  readonly backend: Exclude<SandboxExecutionBackend, 'none'>;
  readonly now: () => number;
}): string | null {
  const { prepared, preparation, identity } = input;
  if (!isDeepFrozen(prepared)) return 'Prepared sandbox plan is not deeply frozen.';
  if (
    prepared.schema !== 'kite.sandbox-execution-provider.v1' ||
    prepared.kind !== 'prepared_sandbox_execution'
  ) {
    return 'Prepared sandbox plan schema is invalid.';
  }
  if (prepared.preparationDigest !== sandboxPreparationDigest(preparation)) {
    return 'Prepared sandbox plan does not match its preparation.';
  }
  if (
    prepared.toolCallId !== identity.toolCallId ||
    prepared.capabilityId !== identity.capabilityId ||
    prepared.capabilityRevision !== identity.capabilityRevision ||
    prepared.invocationId !== identity.invocationId ||
    prepared.attempt !== identity.attempt ||
    prepared.canonicalWorkspace !== preparation.canonicalWorkspace ||
    prepared.cwd !== preparation.canonicalWorkspace ||
    prepared.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    prepared.admissionDigest !== identity.admissionDigest
  ) {
    return 'Prepared sandbox plan changed the invocation identity.';
  }
  if (
    prepared.resourceSemantics !== input.resourceSemantics ||
    prepared.backend !== input.backend ||
    prepared.backendCapabilities.backend !== input.backend
  ) {
    return 'Prepared sandbox plan backend or resource semantics mismatch.';
  }
  if (
    digestValue(prepared.backendCapabilities) !==
    digestValue(sandboxBackendCapabilities(input.backend))
  ) {
    return 'Prepared sandbox plan backend evidence mismatch.';
  }
  const scopeFailure = validatePreparedScopeEvidence({ prepared, preparation });
  if (scopeFailure) return scopeFailure;
  if (
    prepared.commandDigest !== preparation.commandDigest ||
    sandboxCommandDigest(prepared.approvedArgv) !== preparation.commandDigest ||
    !sameStringArray(prepared.approvedArgv, preparation.argv)
  ) {
    return 'Prepared sandbox plan changed the approved command identity.';
  }
  if (!Number.isSafeInteger(prepared.expiresAtMs) || prepared.expiresAtMs <= input.now()) {
    return 'Prepared sandbox plan expired.';
  }
  return null;
}

/**
 * Restrictive baseline scopes may only claim native boundary evidence that the
 * backend publishes as enforced.  An `allow_all` scope is different: Policy
 * has already sealed an exact development approval for unrestricted access,
 * so it must not be reinterpreted as production `allowlist` or `full_access`
 * qualification evidence. This check remains before the process port; it
 * preserves the Windows V6 rule that approved network requires an explicitly
 * approved full filesystem scope.
 */
function validatePreparedScopeEvidence(input: {
  readonly prepared: Readonly<PreparedSandboxExecution>;
  readonly preparation: Readonly<SandboxPreparation>;
}): string | null {
  const filesystemCapability =
    input.preparation.filesystemMode === 'allow_all'
      ? 'full_access'
      : input.preparation.executionTrust === 'policy_proven_read_only'
        ? 'read_only'
        : 'workspace_write';
  if (
    input.preparation.filesystemMode === 'allow_all' &&
    input.preparation.executionTrust === 'policy_proven_read_only'
  ) {
    return 'Prepared sandbox scope cannot combine full filesystem access with read-only trust.';
  }
  const lowerAssuranceWindowsDevelopment = input.prepared.backend === 'windows_restricted_token';
  if (
    input.preparation.filesystemMode !== 'allow_all' &&
    !lowerAssuranceWindowsDevelopment &&
    input.prepared.backendCapabilities.filesystem[filesystemCapability] !== 'enforced'
  ) {
    return `Prepared sandbox filesystem scope '${filesystemCapability}' is unsupported by backend evidence.`;
  }
  if (
    input.preparation.networkMode === 'allow_all' &&
    lowerAssuranceWindowsDevelopment &&
    input.preparation.filesystemMode !== 'allow_all'
  ) {
    return 'Windows approved network requires an explicit full filesystem scope.';
  }
  if (
    input.preparation.networkMode === 'disabled' &&
    !lowerAssuranceWindowsDevelopment &&
    input.prepared.backendCapabilities.network.off !== 'enforced'
  ) {
    return "Prepared sandbox network scope 'off' is unsupported by backend evidence.";
  }
  return null;
}

async function acknowledgePreparationIntent(
  lifecycle: Readonly<SandboxPreparationLifecycle>,
  preparation: Readonly<SandboxPreparation>,
): Promise<
  | { readonly ok: true; readonly intentDigest: string }
  | { readonly ok: false; readonly message: string }
> {
  try {
    const acknowledgement = await lifecycle.recordPreparationIntent(preparation);
    if (
      acknowledgement.acknowledged !== true ||
      acknowledgement.stage !== 'preparation_intent' ||
      !acknowledgement.intentDigest
    ) {
      return { ok: false, message: 'Sandbox preparation intent was not acknowledged.' };
    }
    return { ok: true, intentDigest: acknowledgement.intentDigest };
  } catch (error) {
    return {
      ok: false,
      message: `Sandbox preparation intent acknowledgement failed: ${message(error)}`,
    };
  }
}

async function acknowledgePreparationReady(
  lifecycle: Readonly<SandboxPreparationLifecycle>,
  prepared: Readonly<PreparedSandboxExecution>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  try {
    const acknowledgement = await lifecycle.recordPreparationReady(prepared);
    if (
      acknowledgement.acknowledged !== true ||
      acknowledgement.stage !== 'preparation_ready' ||
      !acknowledgement.readyDigest ||
      !acknowledgement.preparationArtifact
    ) {
      return { ok: false, message: 'Sandbox preparation-ready acknowledgement failed.' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `Sandbox preparation-ready acknowledgement failed: ${message(error)}`,
    };
  }
}

async function acknowledgeDispatchIntent(
  lifecycle: Readonly<SandboxPreparationLifecycle>,
  prepared: Readonly<PreparedSandboxExecution>,
  identity: Readonly<{ readonly dispatchId: string; readonly supervisorNonce: string }>,
): Promise<
  | {
      readonly ok: true;
      readonly acknowledgement: Readonly<SandboxExecutionDispatchIntentAcknowledgement>;
    }
  | { readonly ok: false; readonly message: string }
> {
  if (!identity.dispatchId || !identity.supervisorNonce) {
    return { ok: false, message: 'Sandbox dispatch identity is empty.' };
  }
  try {
    const acknowledgement = await lifecycle.recordExecutionDispatchIntent(prepared, identity);
    if (
      acknowledgement.acknowledged !== true ||
      acknowledgement.stage !== 'execution_dispatch_intent' ||
      acknowledgement.dispatchId !== identity.dispatchId ||
      acknowledgement.supervisorNonce !== identity.supervisorNonce ||
      !acknowledgement.dispatchIntentDigest
    ) {
      return { ok: false, message: 'Sandbox execution dispatch intent acknowledgement failed.' };
    }
    return { ok: true, acknowledgement };
  } catch (error) {
    return {
      ok: false,
      message: `Sandbox execution dispatch intent acknowledgement failed: ${message(error)}`,
    };
  }
}

function projectProcessResult(
  command: string,
  processResult: Readonly<SandboxPreparedProcessExecutionResult>,
): BuiltinPreparedShellExecutionResult {
  switch (processResult.kind) {
    case 'completed':
      return Object.freeze({
        kind: 'completed',
        ok: processResult.exitCode === 0 && processResult.processCleanup.confirmedExited,
        command,
        exitCode: processResult.exitCode,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        processResult,
        processCleanup: processResult.processCleanup,
      });
    case 'terminated':
      return Object.freeze({
        kind: 'terminated',
        ok: false,
        command,
        exitCode: processResult.exitCode,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        processResult,
        processCleanup: processResult.processCleanup,
        terminationReason: processResult.terminationReason,
      });
    case 'failed':
      return Object.freeze({
        kind: 'failed',
        ok: false,
        command,
        exitCode: processResult.exitCode ?? -1,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        processResult,
        processCleanup: processResult.processCleanup,
      });
    case 'unknown':
      return Object.freeze({
        kind: 'unknown',
        ok: false,
        command,
        exitCode: -1,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        processResult,
        processCleanup: processResult.processCleanup,
      });
  }
}

function providerFailure(
  input: Readonly<BuiltinPreparedShellExecutionInput>,
  code: SandboxExecutionProviderFailureCode,
  failureMessage: string,
  stage: 'pre_dispatch' | 'post_dispatch',
  cleanupConfirmed = false,
): BuiltinPreparedShellExecutionResult {
  if (code === 'cancelled') return cancelled(input);
  return Object.freeze({
    kind: 'failed',
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: `Sandbox ${code}: ${failureMessage}`,
    processResult: null,
    processCleanup: null,
    terminationReason: 'sandbox_denied',
    sandboxFailure: Object.freeze({ code, stage, cleanupConfirmed }),
  });
}

function denied(
  input: Readonly<BuiltinPreparedShellExecutionInput>,
  failureMessage: string,
  code: SandboxExecutionProviderFailureCode,
  cleanupConfirmed: boolean,
): BuiltinPreparedShellExecutionResult {
  return providerFailure(input, code, failureMessage, 'pre_dispatch', cleanupConfirmed);
}

function cancelled(
  input: Readonly<BuiltinPreparedShellExecutionInput>,
): BuiltinPreparedShellExecutionResult {
  return Object.freeze({
    kind: 'terminated',
    ok: false,
    command: input.command,
    exitCode: 130,
    stdout: '',
    stderr: 'Command cancelled by user.',
    processResult: null,
    processCleanup: null,
    terminationReason: 'cancelled',
  });
}

function withPostDispatchFailure(
  result: Readonly<BuiltinPreparedShellExecutionResult>,
  code: SandboxExecutionProviderFailureCode,
  cleanupConfirmed: boolean,
  failureMessage: string,
): BuiltinPreparedShellExecutionResult {
  const stderr = result.stderr.trimEnd()
    ? `${result.stderr.trimEnd()}\n${failureMessage}`
    : failureMessage;
  const processResult = result.processResult;
  if (
    processResult?.executionPhase === 'go_started' ||
    processResult?.executionPhase === 'unknown_after_go'
  ) {
    const unknown =
      processResult.kind === 'unknown'
        ? Object.freeze({ ...processResult, stderr })
        : Object.freeze({
            kind: 'unknown' as const,
            executionPhase: 'unknown_after_go' as const,
            exitCode: null,
            stdout: processResult.stdout,
            stderr,
            unknown: Object.freeze({
              code: 'post_go_cleanup_unknown' as const,
              message: failureMessage,
            }),
            retryable: false as const,
            processCleanup: processResult.processCleanup,
          });
    return Object.freeze({
      ...result,
      kind: 'unknown',
      ok: false,
      exitCode: -1,
      stderr,
      processResult: unknown,
      processCleanup: unknown.processCleanup,
      sandboxFailure: Object.freeze({ code, stage: 'post_dispatch', cleanupConfirmed }),
    });
  }
  return Object.freeze({
    ...result,
    ok: false,
    exitCode: result.kind === 'unknown' ? -1 : result.exitCode,
    stderr,
    sandboxFailure: Object.freeze({ code, stage: 'post_dispatch', cleanupConfirmed }),
  });
}

function isCleanupConfirmed(input: {
  readonly preparation: Readonly<SandboxPreparation>;
  readonly prepared: Readonly<PreparedSandboxExecution> | null;
  readonly processResult: Readonly<SandboxPreparedProcessExecutionResult> | null;
  readonly backend: Exclude<SandboxExecutionBackend, 'none'>;
}): boolean {
  if (input.processResult && !input.processResult.processCleanup.confirmedExited) return false;
  if (!input.prepared) {
    return input.backend === 'windows_restricted_token'
      ? cleanupWindowsSandboxRuntimeDirNoSpawn(
          sandboxRuntimeDirForPreparation(
            input.preparation.canonicalWorkspace,
            sandboxPreparationDigest(input.preparation),
          ),
        )
      : cleanupPosixSandboxRuntimeRootsNoSpawn(
          sandboxRuntimeRootsForPreparation(
            input.preparation.canonicalWorkspace,
            sandboxPreparationDigest(input.preparation),
          ),
        );
  }
  if (input.prepared.cleanup.kind === 'none') return true;
  if (input.prepared.cleanup.kind === 'windows_restricted_token') {
    const path = input.prepared.cleanup.recoveryPayload.path;
    return typeof path === 'string' && cleanupWindowsSandboxRuntimeDirNoSpawn(path);
  }
  const controlRoot = input.prepared.cleanup.recoveryPayload.controlRoot;
  const dataRoot = input.prepared.cleanup.recoveryPayload.dataRoot;
  return (
    typeof controlRoot === 'string' &&
    typeof dataRoot === 'string' &&
    cleanupPosixSandboxRuntimeRootsNoSpawn({ controlRoot, dataRoot })
  );
}

function preparationIntentRecord(
  preparation: Readonly<SandboxPreparation>,
  intentDigest: string,
): SandboxPreparationIntentRecord {
  return {
    attempt: preparation.attempt,
    toolCallId: preparation.toolCallId,
    capabilityId: preparation.capabilityId,
    capabilityRevision: preparation.capabilityRevision,
    canonicalWorkspace: preparation.canonicalWorkspace,
    effectiveEffectsDigest: preparation.effectiveEffectsDigest,
    admissionDigest: preparation.admissionDigest,
    preparationDigest: sandboxPreparationDigest(preparation),
    commandDigest: preparation.commandDigest,
    executionBoundaryDigest: preparation.executionBoundaryDigest,
    resourceSemantics: 'allocating',
    intentDigest,
    recordedAt: '',
  };
}

function isDisposalIntent(
  value: Awaited<ReturnType<SandboxPreparationLifecycle['recordDisposalIntent']>> | null,
  hasPrepared: boolean,
): value is Awaited<ReturnType<SandboxPreparationLifecycle['recordDisposalIntent']>> {
  return Boolean(
    value &&
      value.purpose === (hasPrepared ? 'dispose' : 'reconcile_preparation_intent') &&
      value.lifecycleIntentDigest &&
      Number.isSafeInteger(value.cleanupAttempt) &&
      value.cleanupAttempt > 0,
  );
}

function isDisposalReceipt(
  value: Awaited<ReturnType<SandboxPreparationLifecycle['recordDisposalReceipt']>> | null,
  intent: Awaited<ReturnType<SandboxPreparationLifecycle['recordDisposalIntent']>>,
  hasPrepared: boolean,
  disposed: boolean,
): boolean {
  return Boolean(
    value &&
      value.acknowledged === true &&
      value.stage === 'disposal_receipt' &&
      value.purpose === intent.purpose &&
      value.lifecycleIntentDigest === intent.lifecycleIntentDigest &&
      value.cleanupAttempt === intent.cleanupAttempt &&
      value.disposed === disposed &&
      hasPrepared === (value.purpose === 'dispose'),
  );
}

function unknownProcessResult(
  code: SandboxPreparedProcessUnknownResult['unknown']['code'],
  failureMessage: string,
): Readonly<SandboxPreparedProcessUnknownResult> {
  return Object.freeze({
    kind: 'unknown',
    executionPhase: 'unknown_after_go',
    exitCode: null,
    stdout: '',
    stderr: failureMessage,
    unknown: Object.freeze({ code, message: failureMessage }),
    retryable: false,
    processCleanup: Object.freeze({
      confirmedExited: false,
      gracefulRequested: false,
      forced: false,
      unconfirmedDescendantCount: 1,
    }),
  });
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every((child) =>
    isDeepFrozen(child, seen),
  );
}

function digestValue(value: unknown): string {
  return digestCapabilityBindingValue(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
