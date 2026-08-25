import {
  decodeWindowsRestrictedTokenPreparedTransport,
  type ShellInput,
  type ShellResult,
} from '@kite-ai/builtin-runtime/sandbox';
import { createRuntimeHostSandboxPreparedProcessExecutionPort } from '@kite-ai/runtime-host';
import type {
  SandboxExecutionBackend,
  SandboxPreparedProcessCleanup,
  SandboxPreparedProcessExecutionPort,
  SandboxPreparedProcessExecutionResult,
} from '@kite-ai/runtime-spi';
import { executeWindowsRestrictedTokenPrepared } from './windows-restricted-token-runtime';

/** App selects the platform adapter; Host remains the generic process owner. */
export function createAppSandboxPreparedProcessExecutionPort(
  backend: Exclude<SandboxExecutionBackend, 'none'>,
): SandboxPreparedProcessExecutionPort {
  return backend === 'windows_restricted_token'
    ? createWindowsPreparedProcessExecutionPort()
    : createRuntimeHostSandboxPreparedProcessExecutionPort();
}

function createWindowsPreparedProcessExecutionPort(): SandboxPreparedProcessExecutionPort {
  return Object.freeze({
    execute: async (
      input: Parameters<SandboxPreparedProcessExecutionPort['execute']>[0],
    ): Promise<Readonly<SandboxPreparedProcessExecutionResult>> => {
      const prepared = input.prepared;
      if (
        prepared.backend !== 'windows_restricted_token' ||
        prepared.transport !== 'windows_restricted_token_v1' ||
        prepared.stdin === null ||
        !Object.isFrozen(prepared)
      ) {
        return failed('invalid_prepared_execution', 'Windows prepared identity is invalid.');
      }
      let transport: ReturnType<typeof decodeWindowsRestrictedTokenPreparedTransport>;
      try {
        transport = decodeWindowsRestrictedTokenPreparedTransport(prepared.stdin);
      } catch (error) {
        return failed(
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
        return failed('invalid_prepared_execution', 'Windows prepared transport is cross-bound.');
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
        const outcome = await executeWindowsRestrictedTokenPrepared(
          shellInput,
          transport,
          {
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
                acknowledgement.dispatchIntentDigest ===
                  input.dispatchIntent.dispatchIntentDigest &&
                acknowledgement.supervisorPid === started.supervisorPid &&
                acknowledgement.processGroupId === started.processGroupId &&
                acknowledgement.processStartIdentity === started.processStartIdentity
              );
            },
            onGoStarted: () => {
              goStarted = true;
            },
          },
          {
            supervisorNonce: input.dispatchIntent.supervisorNonce,
          },
        );
        const cleanup = projectProcessCleanup(outcome.processCleanup);
        if (!goStarted) {
          return failed(
            supervisorAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
            outcome.stderr || 'Windows supervisor failed before GO.',
            supervisorAttempted ? 'supervisor_started_before_go' : 'not_started',
            cleanup,
          );
        }
        if (!cleanup.confirmedExited) {
          return unknown(
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
          return unknown(
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
          ? unknown('post_go_transport_lost', message, unknownCleanup())
          : failed(
              supervisorAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
              message,
              supervisorAttempted ? 'supervisor_started_before_go' : 'not_started',
              supervisorAttempted ? unknownCleanup() : cleanNoProcess(),
            );
      }
    },
  });
}

function failed(
  code: 'invalid_prepared_execution' | 'supervisor_start_not_acknowledged' | 'spawn_failed',
  message: string,
  executionPhase: 'not_started' | 'supervisor_started_before_go' = 'not_started',
  processCleanup: Readonly<SandboxPreparedProcessCleanup> = cleanNoProcess(),
): Readonly<SandboxPreparedProcessExecutionResult> {
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

function unknown(
  code: 'post_go_terminal_unknown' | 'post_go_transport_lost' | 'post_go_cleanup_unknown',
  message: string,
  processCleanup: Readonly<SandboxPreparedProcessCleanup>,
  stdout = '',
): Readonly<SandboxPreparedProcessExecutionResult> {
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

function projectProcessCleanup(
  cleanup: Readonly<NonNullable<ShellResult['processCleanup']>> | undefined,
): Readonly<SandboxPreparedProcessCleanup> {
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

function cleanNoProcess(): Readonly<SandboxPreparedProcessCleanup> {
  return Object.freeze({
    confirmedExited: true,
    gracefulRequested: false,
    forced: false,
    unconfirmedDescendantCount: 0,
  });
}

function unknownCleanup(): Readonly<SandboxPreparedProcessCleanup> {
  return Object.freeze({
    confirmedExited: false,
    gracefulRequested: false,
    forced: false,
    unconfirmedDescendantCount: 1,
  });
}
