import { randomUUID } from 'node:crypto';
import type { SandboxPreparationIntentRecordV1 } from '@kite/runtime-contract';
import type {
  PreparedSandboxExecutionV1,
  SandboxExecutionBackendV1,
  SandboxExecutionDispatchIntentAcknowledgementV1,
  SandboxExecutionProviderFailureCodeV1,
  SandboxExecutionProviderResultV1,
  SandboxExecutionProviderV1,
  SandboxPreparationGrantV1,
  SandboxPreparationLifecycleV1,
  SandboxPreparationV1,
  SandboxPreparedProcessCleanupV1,
  SandboxPreparedProcessExecutionResultV1,
  SandboxPreparedProcessUnknownResultV1,
} from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from '../capability-binding';
import { projectApprovedProxyEnvironmentV1 } from './approved-proxy-environment';
import { sandboxBackendCapabilitiesV1 } from './execution/backend-capabilities';
import {
  type SandboxExecutionGrantAuthorityV1,
  sandboxCommandDigestV1,
  sandboxPreparationDigestV1,
} from './execution/grant-authority';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawnV1,
  cleanupWindowsSandboxRuntimeDirNoSpawnV1,
  sandboxRuntimeDirForPreparationV1,
  sandboxRuntimeRootsForPreparationV1,
} from './execution/local-runtime-filesystem';
import {
  type BuiltinSandboxPreparationInputV1,
  createBuiltinSandboxPreparationV1,
} from './preparation-authority';
import type { SandboxInvocationIdentityV1 } from './shell-contract';
import type { ResourceLimits, ShellFilesystemMode, ShellNetworkMode } from './types';

/**
 * Builtin-owned input for one already-authorized shell operation.
 *
 * The process mechanism is deliberately an SPI port.  This module never
 * imports the Host, starts a process, or selects a second shell supervisor.
 */
export interface BuiltinPreparedShellExecutionInputV1 {
  readonly identity: Readonly<SandboxInvocationIdentityV1>;
  readonly workspace: string;
  readonly command: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  readonly filesystemMode?: ShellFilesystemMode;
  readonly networkMode?: ShellNetworkMode;
  readonly executionTrust?: BuiltinSandboxPreparationInputV1['executionTrust'];
  /** Durable lifecycle is mandatory for allocating preparation and dispatch. */
  readonly lifecycle?: Readonly<SandboxPreparationLifecycleV1>;
}

export interface BuiltinPreparedShellExecutionConsumerOptionsV1 {
  /** Provider resolution is called once, after allocating intent acknowledgement. */
  readonly provider?: SandboxExecutionProviderV1;
  readonly resolveProviderAfterIntent?: () =>
    | SandboxExecutionProviderV1
    | Promise<SandboxExecutionProviderV1>;
  readonly resourceSemantics?: SandboxExecutionProviderV1['resourceSemantics'];
  readonly backend: Exclude<SandboxExecutionBackendV1, 'none'>;
  readonly grants: SandboxExecutionGrantAuthorityV1;
  readonly preparedProcess: import('@kite/runtime-spi').SandboxPreparedProcessExecutionPortV1;
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

export type BuiltinPreparedShellExecutionKindV1 = 'completed' | 'terminated' | 'failed' | 'unknown';

export interface BuiltinPreparedShellDisposalEvidenceV1 {
  readonly purpose: 'dispose' | 'reconcile_preparation_intent';
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
  readonly acknowledged: boolean;
  readonly disposed: boolean;
}

/** JSON-safe Builtin projection; `processResult` preserves the SPI terminal union. */
export interface BuiltinPreparedShellExecutionResultV1 {
  readonly kind: BuiltinPreparedShellExecutionKindV1;
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly processResult: Readonly<SandboxPreparedProcessExecutionResultV1> | null;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanupV1> | null;
  readonly terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
  readonly sandboxFailure?: {
    readonly code: SandboxExecutionProviderFailureCodeV1;
    readonly stage: 'pre_dispatch' | 'post_dispatch';
    readonly cleanupConfirmed: boolean;
  };
  readonly disposal?: Readonly<BuiltinPreparedShellDisposalEvidenceV1>;
}

/**
 * Builtin Shell/Sandbox consumer candidate for RMV1-16 Shell C.
 *
 * The sequence is intentionally linear and single-attempt:
 * intent → provider prepare → ready → dispatch intent → injected Host process
 * port → disposal intent → provider cleanup → disposal receipt.  A missing
 * pre-GO acknowledgement never reaches the process port.  A post-GO unknown
 * is returned as the SPI unknown union and is never changed into a failure or
 * retried.
 */
export function createBuiltinPreparedShellExecutionConsumerV1(
  options: BuiltinPreparedShellExecutionConsumerOptionsV1,
): (
  input: Readonly<BuiltinPreparedShellExecutionInputV1>,
) => Promise<Readonly<BuiltinPreparedShellExecutionResultV1>> {
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

    let preparation: Readonly<SandboxPreparationV1>;
    try {
      preparation = createBuiltinSandboxPreparationV1({
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
      const intent = await acknowledgePreparationIntentV1(lifecycle!, preparation);
      if (!intent.ok) {
        return denied(input, intent.message, 'command_denied', false);
      }
      intentDigest = intent.intentDigest;
      intentAcknowledged = true;
    }

    let provider: SandboxExecutionProviderV1 | undefined;
    let providerPrepareAttempted = false;
    let prepared: Readonly<PreparedSandboxExecutionV1> | undefined;
    let preparationReadyAcknowledged = false;
    let processResult: Readonly<SandboxPreparedProcessExecutionResultV1> | null = null;
    let result: BuiltinPreparedShellExecutionResultV1 = denied(
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

        let grant: Readonly<SandboxPreparationGrantV1>;
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
            (error): SandboxExecutionProviderResultV1<PreparedSandboxExecutionV1> => ({
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

        const identityFailure = validatePreparedIdentityV1({
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
          const ready = await acknowledgePreparationReadyV1(lifecycle!, prepared);
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
        const dispatch = await acknowledgeDispatchIntentV1(lifecycle, prepared, dispatchIdentity);
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
            ephemeralEnvironment: projectApprovedProxyEnvironmentV1({
              networkMode: input.networkMode ?? 'disabled',
            }),
          });
        } catch (error) {
          // The SPI port may have crossed GO before throwing.  Preserve the
          // conservative terminal signal; never turn this into a retryable fail.
          processResult = unknownProcessResultV1('post_go_transport_lost', message(error));
        }
        result = projectProcessResultV1(input.command, processResult);
      }
    } finally {
      if (lifecycle && intentAcknowledged) {
        const cleanup = await disposeV1({
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
          result: withPostDispatchFailureV1(
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

async function disposeV1(input: {
  readonly input: Readonly<BuiltinPreparedShellExecutionInputV1>;
  readonly lifecycle: Readonly<SandboxPreparationLifecycleV1>;
  readonly grants: SandboxExecutionGrantAuthorityV1;
  readonly provider: SandboxExecutionProviderV1 | undefined;
  readonly providerPrepareAttempted: boolean;
  readonly prepared: Readonly<PreparedSandboxExecutionV1> | undefined;
  readonly preparation: Readonly<SandboxPreparationV1>;
  readonly intentDigest: string;
  readonly preparationReadyAcknowledged: boolean;
  readonly processResult: Readonly<SandboxPreparedProcessExecutionResultV1> | null;
  readonly backend: Exclude<SandboxExecutionBackendV1, 'none'>;
  readonly result: Readonly<BuiltinPreparedShellExecutionResultV1>;
}): Promise<{ readonly result: Readonly<BuiltinPreparedShellExecutionResultV1> }> {
  const cleanupPrepared = input.preparationReadyAcknowledged ? (input.prepared ?? null) : null;
  const disposal = await input.lifecycle.recordDisposalIntent(cleanupPrepared).catch(() => null);
  if (!isDisposalIntentV1(disposal, cleanupPrepared !== null)) {
    return {
      result: withPostDispatchFailureV1(
        input.result,
        'dispose_failed',
        false,
        'Sandbox disposal intent acknowledgement failed.',
      ),
    };
  }

  let cleanupConfirmed = false;
  try {
    cleanupConfirmed = cleanupConfirmedV1({
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
        intent: preparationIntentRecordV1(input.preparation, input.intentDigest),
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
  const receiptAcknowledged = isDisposalReceiptV1(
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
      result: withPostDispatchFailureV1(
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

function validatePreparedIdentityV1(input: {
  readonly prepared: Readonly<PreparedSandboxExecutionV1>;
  readonly preparation: Readonly<SandboxPreparationV1>;
  readonly identity: Readonly<SandboxInvocationIdentityV1>;
  readonly resourceSemantics: SandboxExecutionProviderV1['resourceSemantics'];
  readonly backend: Exclude<SandboxExecutionBackendV1, 'none'>;
  readonly now: () => number;
}): string | null {
  const { prepared, preparation, identity } = input;
  if (!isDeepFrozenV1(prepared)) return 'Prepared sandbox plan is not deeply frozen.';
  if (
    prepared.schema !== 'kite.sandbox-execution-provider.v1' ||
    prepared.kind !== 'prepared_sandbox_execution'
  ) {
    return 'Prepared sandbox plan schema is invalid.';
  }
  if (prepared.preparationDigest !== sandboxPreparationDigestV1(preparation)) {
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
    digestValueV1(prepared.backendCapabilities) !==
    digestValueV1(sandboxBackendCapabilitiesV1(input.backend))
  ) {
    return 'Prepared sandbox plan backend evidence mismatch.';
  }
  if (
    prepared.commandDigest !== preparation.commandDigest ||
    sandboxCommandDigestV1(prepared.approvedArgv) !== preparation.commandDigest ||
    !sameStringArrayV1(prepared.approvedArgv, preparation.argv)
  ) {
    return 'Prepared sandbox plan changed the approved command identity.';
  }
  if (!Number.isSafeInteger(prepared.expiresAtMs) || prepared.expiresAtMs <= input.now()) {
    return 'Prepared sandbox plan expired.';
  }
  return null;
}

async function acknowledgePreparationIntentV1(
  lifecycle: Readonly<SandboxPreparationLifecycleV1>,
  preparation: Readonly<SandboxPreparationV1>,
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

async function acknowledgePreparationReadyV1(
  lifecycle: Readonly<SandboxPreparationLifecycleV1>,
  prepared: Readonly<PreparedSandboxExecutionV1>,
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

async function acknowledgeDispatchIntentV1(
  lifecycle: Readonly<SandboxPreparationLifecycleV1>,
  prepared: Readonly<PreparedSandboxExecutionV1>,
  identity: Readonly<{ readonly dispatchId: string; readonly supervisorNonce: string }>,
): Promise<
  | {
      readonly ok: true;
      readonly acknowledgement: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>;
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

function projectProcessResultV1(
  command: string,
  processResult: Readonly<SandboxPreparedProcessExecutionResultV1>,
): BuiltinPreparedShellExecutionResultV1 {
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
  input: Readonly<BuiltinPreparedShellExecutionInputV1>,
  code: SandboxExecutionProviderFailureCodeV1,
  failureMessage: string,
  stage: 'pre_dispatch' | 'post_dispatch',
  cleanupConfirmed = false,
): BuiltinPreparedShellExecutionResultV1 {
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
  input: Readonly<BuiltinPreparedShellExecutionInputV1>,
  failureMessage: string,
  code: SandboxExecutionProviderFailureCodeV1,
  cleanupConfirmed: boolean,
): BuiltinPreparedShellExecutionResultV1 {
  return providerFailure(input, code, failureMessage, 'pre_dispatch', cleanupConfirmed);
}

function cancelled(
  input: Readonly<BuiltinPreparedShellExecutionInputV1>,
): BuiltinPreparedShellExecutionResultV1 {
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

function withPostDispatchFailureV1(
  result: Readonly<BuiltinPreparedShellExecutionResultV1>,
  code: SandboxExecutionProviderFailureCodeV1,
  cleanupConfirmed: boolean,
  failureMessage: string,
): BuiltinPreparedShellExecutionResultV1 {
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

function cleanupConfirmedV1(input: {
  readonly preparation: Readonly<SandboxPreparationV1>;
  readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
  readonly processResult: Readonly<SandboxPreparedProcessExecutionResultV1> | null;
  readonly backend: Exclude<SandboxExecutionBackendV1, 'none'>;
}): boolean {
  if (input.processResult && !input.processResult.processCleanup.confirmedExited) return false;
  if (!input.prepared) {
    return input.backend === 'windows_restricted_token'
      ? cleanupWindowsSandboxRuntimeDirNoSpawnV1(
          sandboxRuntimeDirForPreparationV1(
            input.preparation.canonicalWorkspace,
            sandboxPreparationDigestV1(input.preparation),
          ),
        )
      : cleanupPosixSandboxRuntimeRootsNoSpawnV1(
          sandboxRuntimeRootsForPreparationV1(
            input.preparation.canonicalWorkspace,
            sandboxPreparationDigestV1(input.preparation),
          ),
        );
  }
  if (input.prepared.cleanup.kind === 'none') return true;
  if (input.prepared.cleanup.kind === 'windows_restricted_token') {
    const path = input.prepared.cleanup.recoveryPayload.path;
    return typeof path === 'string' && cleanupWindowsSandboxRuntimeDirNoSpawnV1(path);
  }
  const controlRoot = input.prepared.cleanup.recoveryPayload.controlRoot;
  const dataRoot = input.prepared.cleanup.recoveryPayload.dataRoot;
  return (
    typeof controlRoot === 'string' &&
    typeof dataRoot === 'string' &&
    cleanupPosixSandboxRuntimeRootsNoSpawnV1({ controlRoot, dataRoot })
  );
}

function preparationIntentRecordV1(
  preparation: Readonly<SandboxPreparationV1>,
  intentDigest: string,
): SandboxPreparationIntentRecordV1 {
  return {
    attempt: preparation.attempt,
    toolCallId: preparation.toolCallId,
    capabilityId: preparation.capabilityId,
    capabilityRevision: preparation.capabilityRevision,
    canonicalWorkspace: preparation.canonicalWorkspace,
    effectiveEffectsDigest: preparation.effectiveEffectsDigest,
    admissionDigest: preparation.admissionDigest,
    preparationDigest: sandboxPreparationDigestV1(preparation),
    commandDigest: preparation.commandDigest,
    executionBoundaryDigest: preparation.executionBoundaryDigest,
    resourceSemantics: 'allocating',
    intentDigest,
    recordedAt: '',
  };
}

function isDisposalIntentV1(
  value: Awaited<ReturnType<SandboxPreparationLifecycleV1['recordDisposalIntent']>> | null,
  hasPrepared: boolean,
): value is Awaited<ReturnType<SandboxPreparationLifecycleV1['recordDisposalIntent']>> {
  return Boolean(
    value &&
      value.purpose === (hasPrepared ? 'dispose' : 'reconcile_preparation_intent') &&
      value.lifecycleIntentDigest &&
      Number.isSafeInteger(value.cleanupAttempt) &&
      value.cleanupAttempt > 0,
  );
}

function isDisposalReceiptV1(
  value: Awaited<ReturnType<SandboxPreparationLifecycleV1['recordDisposalReceipt']>> | null,
  intent: Awaited<ReturnType<SandboxPreparationLifecycleV1['recordDisposalIntent']>>,
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

function unknownProcessResultV1(
  code: SandboxPreparedProcessUnknownResultV1['unknown']['code'],
  failureMessage: string,
): Readonly<SandboxPreparedProcessUnknownResultV1> {
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

function sameStringArrayV1(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isDeepFrozenV1(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every((child) =>
    isDeepFrozenV1(child, seen),
  );
}

function digestValueV1(value: unknown): string {
  return digestCapabilityBindingValueV1(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
