import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  RMV1_13_CAPABILITY_REVISION_V1,
  RMV1_13_OPERATION_ID_V1,
} from '#builtin-runtime';
import { createRuntimeModuleRegistryV1 } from '#runtime-spi';

describe('RMV1-13 Builtin Runtime closure', () => {
  test('binds shell_execute to the sole registered owner and executor', () => {
    const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
    expect(registry.capability(RMV1_13_OPERATION_ID_V1)).toMatchObject({
      capabilityId: RMV1_13_OPERATION_ID_V1,
      revision: RMV1_13_CAPABILITY_REVISION_V1,
      providerId: 'kite-builtin-runtime-rmv1-13',
    });
    expect(registry.executor(RMV1_13_OPERATION_ID_V1)).toMatchObject({
      capabilityId: RMV1_13_OPERATION_ID_V1,
      capabilityRevision: RMV1_13_CAPABILITY_REVISION_V1,
      providerId: 'kite-builtin-runtime-rmv1-13',
    });
  });

  test('rejects forged input before invoking the Shell mechanism', async () => {
    const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
    const executor = registry.executor(RMV1_13_OPERATION_ID_V1);
    if (!executor) throw new Error('RMV1-13 executor is missing.');
    let mechanismCalls = 0;
    const receipt = await executor.execute(
      {
        invocationId: 'invocation',
        capabilityId: RMV1_13_OPERATION_ID_V1,
        capabilityRevision: RMV1_13_CAPABILITY_REVISION_V1,
        input: { command: 'pwd', timeout_ms: 0, extra: true },
      },
      {
        grant: {
          grantId: 'grant',
          capabilityId: RMV1_13_OPERATION_ID_V1,
          capabilityRevision: RMV1_13_CAPABILITY_REVISION_V1,
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
