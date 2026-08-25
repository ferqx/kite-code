import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  PLANNING_CAPABILITY_REVISION_,
  PLANNING_OPERATION_ID_,
} from '#builtin-runtime';
import { createRuntimeModuleRegistry } from '#runtime-spi';

describe('RM-13 Builtin Runtime closure', () => {
  test('binds shell_execute to the sole registered owner and executor', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    expect(registry.capability(PLANNING_OPERATION_ID_)).toMatchObject({
      capabilityId: PLANNING_OPERATION_ID_,
      revision: PLANNING_CAPABILITY_REVISION_,
      providerId: 'kite-builtin-runtime-planning',
    });
    expect(registry.executor(PLANNING_OPERATION_ID_)).toMatchObject({
      capabilityId: PLANNING_OPERATION_ID_,
      capabilityRevision: PLANNING_CAPABILITY_REVISION_,
      providerId: 'kite-builtin-runtime-planning',
    });
  });

  test('rejects forged input before invoking the Shell mechanism', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    const executor = registry.executor(PLANNING_OPERATION_ID_);
    if (!executor) throw new Error('RM-13 executor is missing.');
    let mechanismCalls = 0;
    const receipt = await executor.execute(
      {
        invocationId: 'invocation',
        capabilityId: PLANNING_OPERATION_ID_,
        capabilityRevision: PLANNING_CAPABILITY_REVISION_,
        input: { command: 'pwd', timeout_ms: 0, extra: true },
      },
      {
        grant: {
          grantId: 'grant',
          capabilityId: PLANNING_OPERATION_ID_,
          capabilityRevision: PLANNING_CAPABILITY_REVISION_,
          authority: {},
        },
        requestDigest: 'request-digest',
        signal: new AbortController().signal,
        environment: {
          environmentId: 'test',
          kind: 'in_process',
          mechanisms: {
            shell: {
              execute: async () => {
                mechanismCalls++;
                throw new Error('forged input reached Shell');
              },
            },
          },
        },
        attempt: { invocationId: 'invocation', attemptId: 'attempt' },
      },
    );
    expect(receipt).toMatchObject({
      status: 'failed',
      dispatchCertainty: 'none',
      failure: { code: 'invalid_input' },
    });
    expect(mechanismCalls).toBe(0);
  });
});
