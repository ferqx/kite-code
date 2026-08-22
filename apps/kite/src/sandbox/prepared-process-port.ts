import {
  decodeWindowsRestrictedTokenPreparedTransportV1,
  type ShellInput,
  type ShellResult,
} from '@kite/builtin-runtime/sandbox';
import { createRuntimeHostSandboxPreparedProcessExecutionPortV1 } from '@kite/runtime-host';
import type {
  SandboxExecutionBackendV1,
  SandboxPreparedProcessCleanupV1,
  SandboxPreparedProcessExecutionPortV1,
  SandboxPreparedProcessExecutionResultV1,
} from '@kite/runtime-spi';
import { executeWindowsRestrictedTokenPreparedV1 } from './windows-restricted-token-runtime';

/** App selects the platform adapter; Host remains the generic process owner. */
export function createAppSandboxPreparedProcessExecutionPortV1(
  backend: Exclude<SandboxExecutionBackendV1, 'none'>,
): SandboxPreparedProcessExecutionPortV1 {
  return backend === 'windows_restricted_token'
    ? createWindowsPreparedProcessExecutionPortV1()
    : createRuntimeHostSandboxPreparedProcessExecutionPortV1();
}

function createWindowsPreparedProcessExecutionPortV1(): SandboxPreparedProcessExecutionPortV1 {
  return Object.freeze({
    execute: async (
      input: Parameters<SandboxPreparedProcessExecutionPortV1['execute']>[0],
    ): Promise<Readonly<SandboxPreparedProcessExecutionResultV1>> => {
      const prepared = input.prepared;
      if (
        prepared.backend !== 'windows_restricted_token' ||
        prepared.transport !== 'windows_restricted_token_v1' ||
        prepared.stdin === null ||
        !Object.isFrozen(prepared)
      ) {
        return failedV1('invalid_prepared_execution', 'Windows prepared identity is invalid.');
      }
      let transport: ReturnType<typeof decodeWindowsRestrictedTokenPreparedTransportV1>;
      try {
        transport = decodeWindowsRestrictedTokenPreparedTransportV1(prepared.stdin);
      } catch (error) {
        return failedV1(
          'invalid_prepared_execution',
          error instanceof Error ? error.message : 'Windows prepared transport is invalid.',
        );
      }
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
        return failedV1('invalid_prepared_execution', 'Windows prepared transport is cross-bound.');
      }

      let supervisorAttempted = false;
      let goStarted = false;
      const shellInput: ShellInput = {
        workspace: prepared.canonicalWorkspace,
        command: prepared.approvedArgv.join(' '),
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      };
      try {
        const outcome = await executeWindowsRestrictedTokenPreparedV1(shellInput, transport, {
          acknowledgeSupervisorStarted: async (started) => {
            supervisorAttempted = true;
            const acknowledgement = await input.lifecycle.recordExecutionSupervisorStarted(
              prepared,
              {
                dispatchId: input.dispatchIntent.dispatchId,
                dispatchIntentDigest: input.dispatchIntent.dispatchIntentDigest,
                ...started,
              },
            );
            return (
              acknowledgement.acknowledged === true &&
              acknowledgement.stage === 'execution_supervisor_started' &&
              acknowledgement.dispatchId === input.dispatchIntent.dispatchId &&
              acknowledgement.dispatchIntentDigest === input.dispatchIntent.dispatchIntentDigest &&
              acknowledgement.supervisorPid === started.supervisorPid &&
              acknowledgement.processGroupId === started.processGroupId &&
              acknowledgement.processStartIdentity === started.processStartIdentity
            );
          },
          onGoStarted: () => {
            goStarted = true;
          },
        });
        const cleanup = cleanupV1(outcome.processCleanup);
        if (!goStarted) {
          return failedV1(
            supervisorAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
            outcome.stderr || 'Windows supervisor failed before GO.',
            supervisorAttempted ? 'supervisor_started_before_go' : 'not_started',
            cleanup,
          );
        }
        if (!cleanup.confirmedExited) {
          return unknownV1(
            'post_go_cleanup_unknown',
            outcome.stderr || 'Windows process cleanup is unknown.',
            cleanup,
            outcome.stdout,
          );
        }
        if (
          outcome.terminationReason === 'timed_out' ||
          outcome.terminationReason === 'cancelled'
        ) {
          return Object.freeze({
            kind: 'terminated' as const,
            executionPhase: 'go_started' as const,
            terminationReason: outcome.terminationReason,
            exitCode: outcome.exitCode,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            processCleanup: cleanup,
          });
        }
        if (outcome.exitCode === -1) {
          return unknownV1(
            'post_go_terminal_unknown',
            outcome.stderr || 'Windows process terminal is unknown.',
            cleanup,
            outcome.stdout,
          );
        }
        return Object.freeze({
          kind: 'completed' as const,
          executionPhase: 'go_started' as const,
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          processCleanup: cleanup,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return goStarted
          ? unknownV1('post_go_transport_lost', message, unknownCleanupV1())
          : failedV1(
              supervisorAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
              message,
              supervisorAttempted ? 'supervisor_started_before_go' : 'not_started',
              supervisorAttempted ? unknownCleanupV1() : cleanNoProcessV1(),
            );
      }
    },
  });
}

function failedV1(
  code: 'invalid_prepared_execution' | 'supervisor_start_not_acknowledged' | 'spawn_failed',
  message: string,
  executionPhase: 'not_started' | 'supervisor_started_before_go' = 'not_started',
  processCleanup: Readonly<SandboxPreparedProcessCleanupV1> = cleanNoProcessV1(),
): Readonly<SandboxPreparedProcessExecutionResultV1> {
  return Object.freeze({
    kind: 'failed' as const,
    executionPhase,
    exitCode: null,
    stdout: '',
    stderr: message,
    failure: Object.freeze({ code, message }),
    processCleanup,
  });
}

function unknownV1(
  code: 'post_go_terminal_unknown' | 'post_go_transport_lost' | 'post_go_cleanup_unknown',
  message: string,
  processCleanup: Readonly<SandboxPreparedProcessCleanupV1>,
  stdout = '',
): Readonly<SandboxPreparedProcessExecutionResultV1> {
  return Object.freeze({
    kind: 'unknown' as const,
    executionPhase: 'unknown_after_go' as const,
    exitCode: null,
    stdout,
    stderr: message,
    unknown: Object.freeze({ code, message }),
    retryable: false as const,
    processCleanup,
  });
}

function cleanupV1(
  cleanup: Readonly<NonNullable<ShellResult['processCleanup']>> | undefined,
): Readonly<SandboxPreparedProcessCleanupV1> {
  return Object.freeze({
    confirmedExited: cleanup?.confirmedExited === true,
    gracefulRequested: cleanup?.gracefulRequested === true,
    forced: cleanup?.forced === true,
    unconfirmedDescendantCount:
      Number.isSafeInteger(cleanup?.unconfirmedDescendantCount) &&
      Number(cleanup?.unconfirmedDescendantCount) >= 0
        ? Number(cleanup?.unconfirmedDescendantCount)
        : 1,
  });
}

function cleanNoProcessV1(): Readonly<SandboxPreparedProcessCleanupV1> {
  return Object.freeze({
    confirmedExited: true,
    gracefulRequested: false,
    forced: false,
    unconfirmedDescendantCount: 0,
  });
}

function unknownCleanupV1(): Readonly<SandboxPreparedProcessCleanupV1> {
  return Object.freeze({
    confirmedExited: false,
    gracefulRequested: false,
    forced: false,
    unconfirmedDescendantCount: 1,
  });
}
