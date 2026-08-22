import { describe, expect, test } from 'bun:test';
import {
  BuiltinShellExecutionUnknownErrorV1,
  createBuiltinRuntimeModules,
  RMV1_13_CAPABILITY_REVISION_V1,
  RMV1_13_EXECUTOR_REVISION_V1,
} from '@kite/builtin-runtime';
import { createRuntimeModuleRegistryV1 } from '@kite/runtime-spi';

function request() {
  return {
    invocationId: 'shell-invocation-1',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: RMV1_13_CAPABILITY_REVISION_V1,
    input: { command: 'printf ok' },
  } as const;
}

function context(execute: () => Promise<Record<string, unknown>>) {
  return {
    grant: {
      grantId: 'grant-1',
      capabilityId: 'builtin:shell_execute',
      capabilityRevision: RMV1_13_CAPABILITY_REVISION_V1,
      authority: {},
    },
    requestDigest: 'request-digest-1',
    signal: new AbortController().signal,
    environment: {
      environmentId: 'test',
      kind: 'in_process' as const,
      mechanisms: Object.freeze({ shell: Object.freeze({ execute }) }),
    },
    attempt: { invocationId: 'shell-invocation-1', attemptId: 'attempt-1' },
  };
}

describe('Builtin Shell operation terminal certainty', () => {
  test('throws the package marker for post-GO unknown instead of emitting a normal failure', async () => {
    const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
    const executor = registry.executor('builtin:shell_execute');
    if (!executor) throw new Error('Shell executor is unavailable.');

    await expect(
      executor.execute(
        request(),
        context(async () => ({
          ok: false,
          command: 'printf ok',
          exitCode: -1,
          stdout: '',
          stderr: 'terminal transport lost',
          intent: 'inspect',
          executionPhase: 'unknown_after_go',
          processCleanup: {
            confirmedExited: false,
            gracefulRequested: false,
            forced: false,
            unconfirmedDescendantCount: 1,
          },
        })),
      ),
    ).rejects.toBeInstanceOf(BuiltinShellExecutionUnknownErrorV1);
  });

  test('preserves confirmed cleanup and pre-dispatch sandbox evidence in the result', async () => {
    const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
    const executor = registry.executor('builtin:shell_execute');
    if (!executor) throw new Error('Shell executor is unavailable.');
    const receipt = await executor.execute(
      request(),
      context(async () => ({
        ok: false,
        command: 'printf ok',
        exitCode: -1,
        stdout: '',
        stderr: 'sandbox unavailable',
        intent: 'inspect',
        terminationReason: 'sandbox_denied',
        executionPhase: 'not_started',
        sandboxFailure: {
          code: 'backend_unavailable',
          stage: 'pre_dispatch',
          cleanupConfirmed: true,
        },
        processCleanup: {
          confirmedExited: true,
          gracefulRequested: false,
          forced: false,
          unconfirmedDescendantCount: 0,
        },
      })),
    );

    expect(receipt).toMatchObject({
      status: 'succeeded',
      executorRevision: RMV1_13_EXECUTOR_REVISION_V1,
      value: {
        ok: false,
        resultMeta: {
          executionPhase: 'not_started',
          sandboxFailure: {
            code: 'backend_unavailable',
            stage: 'pre_dispatch',
            cleanupConfirmed: true,
          },
          processCleanup: { confirmedExited: true, unconfirmedDescendantCount: 0 },
        },
      },
    });
  });
});
