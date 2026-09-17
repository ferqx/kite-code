import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  FILESYSTEM_CAPABILITY_REVISIONS_,
} from '@kite-ai/builtin-runtime';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';

describe('RM-12 Builtin Runtime input boundary', () => {
  test('rejects forged file input and exposes no Git inspect executor', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    let mechanismCalls = 0;
    const context = {
      grant: {
        grantId: 'grant',
        capabilityId: 'builtin:read_file',
        capabilityRevision: FILESYSTEM_CAPABILITY_REVISIONS_['builtin:read_file'],
        authority: {},
      },
      requestDigest: 'request-digest',
      signal: new AbortController().signal,
      environment: {
        environmentId: 'test',
        kind: 'in_process' as const,
        mechanisms: {
          filesystem: {
            allowExternalPaths: false,
            dispatch: async () => {
              mechanismCalls++;
              throw new Error('invalid input reached the filesystem mechanism');
            },
          },
        },
      },
      attempt: { invocationId: 'invocation', attemptId: 'attempt' },
    };
    const readExecutor = registry.executor('builtin:read_file');
    if (!readExecutor) throw new Error('RM-12 filesystem executor is missing');
    expect(registry.executor('builtin:git_inspect')).toBeUndefined();

    const invalidRead = await readExecutor.execute(
      {
        invocationId: 'invocation',
        capabilityId: 'builtin:read_file',
        capabilityRevision: FILESYSTEM_CAPABILITY_REVISIONS_['builtin:read_file'],
        input: { path: 42 },
      },
      context,
    );
    expect(invalidRead).toMatchObject({
      status: 'failed',
      dispatchCertainty: 'none',
      failure: { code: 'invalid_input' },
    });
    expect(mechanismCalls).toBe(0);
  });
});
