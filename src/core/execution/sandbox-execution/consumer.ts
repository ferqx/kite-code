import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import { checkDangerousPaths } from '@/core/policies/dangerous-paths';
import type { SandboxBackend } from '@/core/sandbox/platform';
import { DEFAULT_RESOURCE_LIMITS } from '@/core/sandbox/types';
import {
  buildHostShellInvocationsV1,
  buildPolicyProvenReadOnlyHostShellInvocationsV1,
  resolveShellTimeoutMs,
  type ShellExecutor,
} from '@/core/tools/shell';
import { POLICY_PROVEN_READ_ONLY_EXECUTION } from '@/core/tools/trusted-readonly-environment';
import type { ShellInput, ShellResult } from '@/core/types';
import type {
  PreparedSandboxExecutionV1,
  SandboxExecutionProviderV1,
  SandboxPreparationGrantV1,
  SandboxPreparationV1,
} from '@/protocol/sandbox-execution-provider';
import { sandboxBackendCapabilitiesV1 } from './backend-capabilities';
import {
  type SandboxExecutionGrantAuthorityV1,
  sandboxCommandDigestV1,
  sandboxPreparationDigestV1,
} from './grant-authority';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawnV1,
  cleanupWindowsSandboxRuntimeDirNoSpawnV1,
  sandboxRuntimeDirForPreparationV1,
  sandboxRuntimeRootsForPreparationV1,
} from './local-runtime-filesystem';
import { executePosixSupervisedV1 } from './posix-supervisor';
import { decodeWindowsRestrictedTokenPreparedTransportV1 } from './windows-preparation';
import { executeWindowsRestrictedTokenPreparedV1 } from './windows-runtime';

export interface SandboxPreparationLifecycleV1 {
  recordPreparationIntent(
    preparation: Readonly<SandboxPreparationV1>,
  ): Promise<{ readonly intentDigest: string }>;
  recordPreparationReady(prepared: Readonly<PreparedSandboxExecutionV1>): Promise<boolean>;
  recordExecutionDispatchIntent(
    prepared: Readonly<PreparedSandboxExecutionV1>,
    input: { readonly dispatchId: string; readonly supervisorNonce: string },
  ): Promise<{ readonly dispatchIntentDigest: string }>;
  recordExecutionSupervisorStarted(
    prepared: Readonly<PreparedSandboxExecutionV1>,
    input: {
      readonly dispatchId: string;
      readonly dispatchIntentDigest: string;
      readonly supervisorPid: number;
      readonly processGroupId: number;
      readonly processStartIdentity: string;
    },
  ): Promise<boolean>;
  recordDisposalIntent(prepared: Readonly<PreparedSandboxExecutionV1> | null): Promise<{
    readonly purpose: 'dispose' | 'reconcile_preparation_intent';
    readonly lifecycleIntentDigest: string;
    readonly cleanupAttempt: number;
  } | null>;
  recordDisposalReceipt(input: {
    readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
    readonly purpose: 'dispose' | 'reconcile_preparation_intent';
    readonly lifecycleIntentDigest: string;
    readonly cleanupAttempt: number;
    readonly disposed: boolean;
  }): Promise<boolean>;
}

export interface SandboxExecutionConsumerOptionsV1 {
  readonly provider?: SandboxExecutionProviderV1;
  /**
   * Runtime-owned backend qualification. It is called only after the
   * allocating preparation intent has been durably acknowledged.
   */
  readonly resolveProviderAfterIntent?: () =>
    | SandboxExecutionProviderV1
    | Promise<SandboxExecutionProviderV1>;
  readonly resourceSemantics?: SandboxExecutionProviderV1['resourceSemantics'];
  readonly backend: Exclude<SandboxBackend, 'none'>;
  readonly grants: SandboxExecutionGrantAuthorityV1;
  readonly canonicalWorkspace: string;
  readonly executionBoundaryDigest: string;
  readonly protectedPathRevision: string;
  readonly maxProcessTreeTasks?: number;
  readonly resourceLimits?: Partial<typeof DEFAULT_RESOURCE_LIMITS>;
  readonly now?: () => number;
}

/** Runtime consumer: the only owner of process spawn, timeout, cancellation, output and cleanup. */
export function createSandboxExecutionConsumerV1(
  options: SandboxExecutionConsumerOptionsV1,
): ShellExecutor {
  const now = options.now ?? Date.now;
  return async (input) => {
    const lifecycle = input.sandboxPreparationLifecycle;
    const identity = input.sandboxInvocationIdentity;
    if (!identity) return denied(input, 'Sandbox invocation identity is missing.');
    const resourceSemantics =
      options.resourceSemantics ?? options.provider?.resourceSemantics ?? 'pure';
    if (resourceSemantics === 'allocating' && !lifecycle) {
      return denied(input, 'Allocating sandbox preparation requires a durable Runtime lifecycle.');
    }
    if (input.signal?.aborted) return cancelled(input);
    let workspace: string;
    try {
      workspace = realpathSync.native(resolve(options.canonicalWorkspace));
    } catch (error) {
      return denied(input, error instanceof Error ? error.message : String(error));
    }
    if (workspace !== realpathSync.native(resolve(input.workspace))) {
      return denied(input, 'Sandbox invocation Workspace mismatch.');
    }
    const deniedPath = checkDangerousPaths(input.command);
    if (deniedPath) {
      return denied(input, `Rejected: command references protected path '${deniedPath}'`);
    }
    const argv = exactHostArgv(input);
    const limits = { ...DEFAULT_RESOURCE_LIMITS, ...options.resourceLimits };
    const preparation: SandboxPreparationV1 = deepFreeze({
      schema: 'kite.sandbox-execution-provider.v1',
      toolCallId: identity.toolCallId,
      capabilityId: identity.capabilityId,
      capabilityRevision: identity.capabilityRevision,
      invocationId: identity.invocationId,
      attempt: identity.attempt,
      effectiveEffectsDigest: identity.effectiveEffectsDigest,
      admissionDigest: identity.admissionDigest,
      canonicalWorkspace: workspace,
      argv,
      commandDigest: sandboxCommandDigestV1(argv),
      executionBoundaryDigest: options.executionBoundaryDigest,
      protectedPathRevision: options.protectedPathRevision,
      filesystemMode: input.filesystemMode ?? 'workspace_only',
      networkMode: input.networkMode ?? 'disabled',
      executionTrust:
        input.executionTrust === POLICY_PROVEN_READ_ONLY_EXECUTION
          ? POLICY_PROVEN_READ_ONLY_EXECUTION
          : null,
      resourceLimits: {
        ...limits,
        maxProcessTreeTasks: options.maxProcessTreeTasks ?? null,
      },
      timeoutMs: resolveShellTimeoutMs(input.timeoutMs),
      cancellationCorrelation: identity.cancellationCorrelation,
    });
    let intentDigest: string | undefined;
    if (resourceSemantics === 'allocating') {
      try {
        intentDigest = (await lifecycle!.recordPreparationIntent(preparation)).intentDigest;
      } catch {
        return denied(input, 'Sandbox preparation intent acknowledgement failed.');
      }
      if (!intentDigest) return denied(input, 'Sandbox preparation intent was not acknowledged.');
    }
    let provider: SandboxExecutionProviderV1;
    try {
      provider = options.resolveProviderAfterIntent
        ? await options.resolveProviderAfterIntent()
        : options.provider!;
    } catch (error) {
      const outcome = denied(
        input,
        `Sandbox backend qualification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return resourceSemantics === 'allocating'
        ? abandonPreparationAfterIntent({
            input,
            preparation,
            intentDigest: intentDigest!,
            lifecycle: lifecycle!,
            grants: options.grants,
            outcome,
            backend: options.backend,
          })
        : outcome;
    }
    if (!provider || provider.resourceSemantics !== resourceSemantics) {
      const outcome = denied(
        input,
        'Sandbox backend qualification returned invalid resource semantics.',
      );
      return resourceSemantics === 'allocating'
        ? abandonPreparationAfterIntent({
            input,
            preparation,
            intentDigest: intentDigest!,
            lifecycle: lifecycle!,
            grants: options.grants,
            outcome,
            backend: options.backend,
          })
        : outcome;
    }
    let grant: Readonly<SandboxPreparationGrantV1>;
    try {
      grant = options.grants.issue({
        preparation,
        resourceSemantics,
        ...(intentDigest ? { preparationIntentDigest: intentDigest } : {}),
      });
    } catch (error) {
      const outcome = denied(input, error instanceof Error ? error.message : String(error));
      return resourceSemantics === 'allocating'
        ? abandonPreparationAfterIntent({
            input,
            preparation,
            intentDigest: intentDigest!,
            lifecycle: lifecycle!,
            provider,
            grants: options.grants,
            outcome,
            backend: options.backend,
          })
        : outcome;
    }
    const activeProvider = provider;
    const preparedResult = await activeProvider
      .prepare({ grant, signal: input.signal })
      .catch((error) => ({
        ok: false as const,
        failure: {
          code: 'preparation_failed' as const,
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    if (!preparedResult.ok) {
      const failureOutcome = providerFailure(
        input,
        preparedResult.failure.code,
        preparedResult.failure.message,
      );
      return resourceSemantics === 'allocating'
        ? abandonPreparationAfterIntent({
            input,
            preparation,
            intentDigest: intentDigest!,
            lifecycle: lifecycle!,
            provider: activeProvider,
            grants: options.grants,
            outcome: failureOutcome,
            backend: options.backend,
          })
        : failureOutcome;
    }
    const prepared = preparedResult.observation;
    let outcome: ShellResult = denied(input, 'Sandbox execution did not produce an outcome.');
    let cleanupConfirmed = true;
    let preparationReadyAcknowledged = resourceSemantics !== 'allocating';
    try {
      if (prepared.preparationDigest !== sandboxPreparationDigestV1(preparation)) {
        outcome = denied(input, 'Prepared sandbox plan does not match its preparation.');
      } else if (
        prepared.toolCallId !== identity.toolCallId ||
        prepared.capabilityId !== identity.capabilityId ||
        prepared.capabilityRevision !== identity.capabilityRevision ||
        prepared.invocationId !== identity.invocationId ||
        prepared.attempt !== identity.attempt ||
        prepared.canonicalWorkspace !== workspace ||
        prepared.cwd !== workspace ||
        prepared.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
        prepared.admissionDigest !== identity.admissionDigest
      ) {
        outcome = denied(input, 'Prepared sandbox plan changed the invocation identity.');
      } else if (prepared.resourceSemantics !== provider.resourceSemantics) {
        outcome = denied(input, 'Prepared sandbox plan resource semantics mismatch.');
      } else if (
        prepared.backend !== options.backend ||
        digestCapability(prepared.backendCapabilities) !==
          digestCapability(sandboxBackendCapabilitiesV1(options.backend))
      ) {
        outcome = denied(input, 'Prepared sandbox backend evidence mismatch.');
      } else if (prepared.commandDigest !== preparation.commandDigest) {
        outcome = denied(input, 'Prepared sandbox plan changed the approved command identity.');
      } else if (
        sandboxCommandDigestV1(prepared.approvedArgv) !== preparation.commandDigest ||
        JSON.stringify(prepared.approvedArgv) !== JSON.stringify(preparation.argv)
      ) {
        outcome = denied(input, 'Prepared sandbox plan changed the approved argv.');
      } else if (prepared.expiresAtMs <= now()) {
        outcome = denied(input, 'Prepared sandbox plan expired.');
      } else if (input.signal?.aborted) {
        outcome = cancelled(input);
      } else {
        let ready = resourceSemantics !== 'allocating';
        if (!ready) {
          try {
            ready = await lifecycle!.recordPreparationReady(prepared);
          } catch {
            ready = false;
          }
        }
        if (!ready) {
          outcome = denied(input, 'Sandbox preparation-ready acknowledgement failed.');
        } else {
          preparationReadyAcknowledged = true;
          if (!lifecycle) {
            outcome = denied(
              input,
              'Prepared sandbox execution requires a durable dispatch lifecycle.',
            );
          } else {
            const dispatchId = randomUUID();
            const supervisorNonce = randomUUID();
            let dispatchIntentDigest = '';
            try {
              dispatchIntentDigest = (
                await lifecycle.recordExecutionDispatchIntent(prepared, {
                  dispatchId,
                  supervisorNonce,
                })
              ).dispatchIntentDigest;
            } catch {
              dispatchIntentDigest = '';
            }
            if (!dispatchIntentDigest) {
              outcome = denied(input, 'Sandbox execution dispatch intent acknowledgement failed.');
            } else {
              const spawned = await spawnPrepared(input, prepared, lifecycle, {
                dispatchId,
                supervisorNonce,
                dispatchIntentDigest,
              });
              outcome = spawned.outcome;
              cleanupConfirmed = spawned.cleanupConfirmed;
            }
          }
        }
      }
    } finally {
      const cleanupPrepared = preparationReadyAcknowledged ? prepared : null;
      let disposalIntentDigest = '';
      let cleanupAttempt = 0;
      let disposalPurpose: 'dispose' | 'reconcile_preparation_intent' = 'dispose';
      try {
        const intent = await lifecycle?.recordDisposalIntent(cleanupPrepared);
        disposalPurpose = intent?.purpose ?? 'dispose';
        disposalIntentDigest = intent?.lifecycleIntentDigest ?? '';
        cleanupAttempt = intent?.cleanupAttempt ?? 0;
      } catch {
        disposalIntentDigest = '';
      }
      const runtimeCleanupConfirmed = Boolean(
        disposalIntentDigest &&
          cleanupConfirmed &&
          (disposalPurpose === 'reconcile_preparation_intent'
            ? options.backend !== 'windows_restricted_token' &&
              cleanupPosixSandboxRuntimeRootsNoSpawnV1(
                sandboxRuntimeRootsForPreparationV1(
                  workspace,
                  sandboxPreparationDigestV1(preparation),
                ),
              )
            : prepared.cleanup.kind === 'runtime_directory'
              ? typeof prepared.cleanup.recoveryPayload.controlRoot === 'string' &&
                typeof prepared.cleanup.recoveryPayload.dataRoot === 'string' &&
                cleanupPosixSandboxRuntimeRootsNoSpawnV1({
                  controlRoot: prepared.cleanup.recoveryPayload.controlRoot,
                  dataRoot: prepared.cleanup.recoveryPayload.dataRoot,
                })
              : prepared.cleanup.kind === 'windows_restricted_token' ||
                prepared.cleanup.kind === 'none'),
      );
      const cleanupGrantInput = {
        lifecycleIntentDigest: disposalIntentDigest,
        cleanupAttempt,
        cleanupConfirmed: runtimeCleanupConfirmed,
      };
      const dispose = disposalIntentDigest
        ? await Promise.resolve()
            .then(() =>
              disposalPurpose === 'dispose'
                ? activeProvider.dispose({
                    grant: options.grants.issueCleanup({
                      purpose: 'dispose',
                      prepared,
                      ...cleanupGrantInput,
                    }),
                    prepared,
                  })
                : activeProvider.reconcilePreparationIntent({
                    grant: options.grants.issueCleanup({
                      purpose: 'reconcile_preparation_intent',
                      intent: preparationIntentRecord(preparation, intentDigest!),
                      invocationId: preparation.invocationId,
                      ...cleanupGrantInput,
                    }),
                  }),
            )
            .catch((error) => ({
              ok: false as const,
              failure: {
                code: 'dispose_failed' as const,
                message: error instanceof Error ? error.message : String(error),
              },
            }))
        : {
            ok: false as const,
            failure: {
              code: 'dispose_failed' as const,
              message: 'Sandbox disposal grant was not issued without durable intent.',
            },
          };
      let disposalReceiptAcknowledged = false;
      try {
        disposalReceiptAcknowledged =
          (await lifecycle?.recordDisposalReceipt({
            prepared: cleanupPrepared,
            purpose: disposalPurpose,
            lifecycleIntentDigest: disposalIntentDigest,
            cleanupAttempt,
            disposed: dispose.ok,
          })) ?? false;
      } catch {
        disposalReceiptAcknowledged = false;
      }
      if (!disposalIntentDigest) {
        outcome = {
          ...outcome,
          ok: false,
          exitCode: -1,
          stderr: appendTerminal(
            outcome?.stderr ?? '',
            'Sandbox disposal intent acknowledgement failed.',
          ),
        };
      }
      if (!dispose.ok) {
        outcome = {
          ...outcome,
          ok: false,
          exitCode: -1,
          stderr: appendTerminal(
            outcome?.stderr ?? '',
            `Sandbox cleanup failed: ${dispose.failure.message}`,
          ),
        };
      } else if (!disposalReceiptAcknowledged) {
        outcome = {
          ...outcome,
          ok: false,
          exitCode: -1,
          stderr: appendTerminal(
            outcome?.stderr ?? '',
            'Sandbox disposal receipt acknowledgement failed.',
          ),
        };
      }
    }
    return outcome;
  };
}

async function spawnPrepared(
  input: ShellInput,
  prepared: Readonly<PreparedSandboxExecutionV1>,
  lifecycle: SandboxPreparationLifecycleV1,
  dispatch: {
    readonly dispatchId: string;
    readonly supervisorNonce: string;
    readonly dispatchIntentDigest: string;
  },
): Promise<{ readonly outcome: ShellResult; readonly cleanupConfirmed: boolean }> {
  if (prepared.transport === 'windows_restricted_token_v1') {
    return spawnWindowsPrepared(input, prepared);
  }
  return executePosixSupervisedV1({
    shell: input,
    prepared,
    lifecycle,
    ...dispatch,
    timeoutMs: resolveShellTimeoutMs(input.timeoutMs),
  });
}

async function abandonPreparationAfterIntent(input: {
  readonly input: ShellInput;
  readonly preparation: Readonly<SandboxPreparationV1>;
  readonly intentDigest: string;
  readonly lifecycle: SandboxPreparationLifecycleV1;
  readonly provider?: SandboxExecutionProviderV1;
  readonly grants: SandboxExecutionGrantAuthorityV1;
  readonly outcome: ShellResult;
  readonly backend: Exclude<SandboxBackend, 'none'>;
}): Promise<ShellResult> {
  const intent = await input.lifecycle.recordDisposalIntent(null).catch(() => null);
  if (intent?.purpose !== 'reconcile_preparation_intent') {
    return {
      ...input.outcome,
      ok: false,
      exitCode: -1,
      stderr: appendTerminal(
        input.outcome.stderr,
        'Sandbox abandonment intent acknowledgement failed.',
      ),
    };
  }
  const cleanupConfirmed =
    input.backend === 'windows_restricted_token'
      ? // Preparation may already have allocated the deterministic Windows
        // runtime before discovering that its runner or transport is unusable.
        // Confirm that exact digest-addressed entry is gone before issuing a
        // cleanup grant; do not turn a failed cleanup into host fallback.
        cleanupWindowsSandboxRuntimeDirNoSpawnV1(
          sandboxRuntimeDirForPreparationV1(
            input.preparation.canonicalWorkspace,
            sandboxPreparationDigestV1(input.preparation as SandboxPreparationV1),
          ),
        )
      : cleanupPosixSandboxRuntimeRootsNoSpawnV1(
          sandboxRuntimeRootsForPreparationV1(
            input.preparation.canonicalWorkspace,
            sandboxPreparationDigestV1(input.preparation as SandboxPreparationV1),
          ),
        );
  const disposed = input.provider
    ? await input.provider
        .reconcilePreparationIntent({
          grant: input.grants.issueCleanup({
            purpose: 'reconcile_preparation_intent',
            intent: preparationIntentRecord(input.preparation, input.intentDigest),
            invocationId: input.preparation.invocationId,
            lifecycleIntentDigest: intent.lifecycleIntentDigest,
            cleanupAttempt: intent.cleanupAttempt,
            cleanupConfirmed,
          }),
        })
        .catch(() => ({ ok: false as const }))
    : cleanupConfirmed
      ? { ok: true as const }
      : { ok: false as const };
  const receipt = await input.lifecycle
    .recordDisposalReceipt({
      prepared: null,
      purpose: 'reconcile_preparation_intent',
      lifecycleIntentDigest: intent.lifecycleIntentDigest,
      cleanupAttempt: intent.cleanupAttempt,
      disposed: disposed.ok,
    })
    .catch(() => false);
  if (disposed.ok && receipt) {
    return input.outcome.sandboxFailure
      ? {
          ...input.outcome,
          sandboxFailure: {
            ...input.outcome.sandboxFailure,
            cleanupConfirmed: true,
          },
        }
      : input.outcome;
  }
  return {
    ...input.outcome,
    ok: false,
    exitCode: -1,
    stderr: appendTerminal(input.outcome.stderr, 'Sandbox abandonment cleanup failed.'),
  };
}

async function spawnWindowsPrepared(
  input: ShellInput,
  prepared: Readonly<PreparedSandboxExecutionV1>,
): Promise<{ readonly outcome: ShellResult; readonly cleanupConfirmed: boolean }> {
  if (prepared.backend !== 'windows_restricted_token' || prepared.stdin === null) {
    return {
      outcome: denied(input, 'Windows sandbox prepared transport is invalid.'),
      cleanupConfirmed: false,
    };
  }
  try {
    const transport = decodeWindowsRestrictedTokenPreparedTransportV1(prepared.stdin);
    if (
      prepared.argv.length !== 1 ||
      transport.runner.path !== prepared.argv[0] ||
      transport.workspaceRoot !== prepared.cwd ||
      transport.runtimeRoot !== prepared.cleanup.recoveryPayload.path ||
      prepared.stdin !== prepared.cleanup.recoveryPayload.transport ||
      transport.request.cwd !== prepared.cwd ||
      transport.request.runtimeRoot !== transport.runtimeRoot ||
      transport.request.invocationName !== prepared.cleanup.resourceId
    ) {
      return {
        outcome: denied(input, 'Windows sandbox prepared transport identity mismatch.'),
        cleanupConfirmed: false,
      };
    }
    const outcome = await executeWindowsRestrictedTokenPreparedV1(input, transport);
    return {
      outcome,
      cleanupConfirmed: outcome.processCleanup?.confirmedExited === true,
    };
  } catch (error) {
    return {
      outcome: denied(
        input,
        `Windows sandbox prepared transport could not be consumed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
      cleanupConfirmed: false,
    };
  }
}

function exactHostArgv(input: ShellInput): readonly string[] {
  const candidates =
    input.executionTrust === POLICY_PROVEN_READ_ONLY_EXECUTION
      ? buildPolicyProvenReadOnlyHostShellInvocationsV1(input.command, input.workspace)
      : buildHostShellInvocationsV1(input.command);
  const argv = candidates[0]?.argv;
  if (!argv) throw new Error('No trusted shell interpreter is available.');
  return Object.freeze([...argv]);
}

function preparationIntentRecord(
  preparation: Readonly<SandboxPreparationV1>,
  intentDigest: string,
): import('@/protocol/capabilities').SandboxPreparationIntentRecordV1 {
  return {
    attempt: preparation.attempt,
    toolCallId: preparation.toolCallId,
    capabilityId: preparation.capabilityId,
    capabilityRevision: preparation.capabilityRevision,
    canonicalWorkspace: preparation.canonicalWorkspace,
    effectiveEffectsDigest: preparation.effectiveEffectsDigest,
    admissionDigest: preparation.admissionDigest,
    preparationDigest: sandboxPreparationDigestV1(preparation as SandboxPreparationV1),
    commandDigest: preparation.commandDigest,
    executionBoundaryDigest: preparation.executionBoundaryDigest,
    resourceSemantics: 'allocating',
    intentDigest,
    recordedAt: '',
  };
}

function providerFailure(
  input: ShellInput,
  code: import('@/protocol/sandbox-execution-provider').SandboxExecutionProviderFailureCodeV1,
  message: string,
): ShellResult {
  if (code === 'cancelled') return cancelled(input);
  return {
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: `Sandbox ${code}: ${message}`,
    terminationReason: 'sandbox_denied',
    sandboxFailure: {
      code,
      stage: 'pre_dispatch',
      cleanupConfirmed: false,
    },
  };
}

function denied(input: ShellInput, message: string): ShellResult {
  return providerFailure(input, 'command_denied', message);
}

function cancelled(input: ShellInput): ShellResult {
  return {
    ok: false,
    command: input.command,
    exitCode: 130,
    stdout: '',
    stderr: 'Command cancelled by user.',
    terminationReason: 'cancelled',
  };
}

function appendTerminal(stderr: string, message: string): string {
  return stderr.trimEnd() ? `${stderr.trimEnd()}\n${message}` : message;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
}
