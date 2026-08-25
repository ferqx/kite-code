import { describe, expect, test } from 'bun:test';
import { createBuiltinRuntimeModules, GIT_CAPABILITY_REVISIONS_ } from '#builtin-runtime';
import { createRuntimeModuleRegistry } from '#runtime-spi';

describe('RM-12 Builtin Runtime input boundary', () => {
  test('rejects forged input before invoking a filesystem or Git mechanism', async () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    let mechanismCalls = 0;
    const context = {
      grant: {
        grantId: 'grant',
        capabilityId: 'builtin:read_file',
        capabilityRevision: GIT_CAPABILITY_REVISIONS_['builtin:read_file'],
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
          git: {
            inspect: async () => {
              mechanismCalls++;
              throw new Error('invalid input reached the Git mechanism');
            },
          },
        },
      },
      attempt: { invocationId: 'invocation', attemptId: 'attempt' },
    };
    const readExecutor = registry.executor('builtin:read_file');
    const gitExecutor = registry.executor('builtin:git_inspect');
    if (!readExecutor || !gitExecutor) throw new Error('RM-12 executors are missing');

    const invalidRead = await readExecutor.execute(
      {
        invocationId: 'invocation',
        capabilityId: 'builtin:read_file',
        capabilityRevision: GIT_CAPABILITY_REVISIONS_['builtin:read_file'],
        input: { path: 42 },
      },
      context,
    );
    const invalidGit = await gitExecutor.execute(
      {
        invocationId: 'invocation',
        capabilityId: 'builtin:git_inspect',
        capabilityRevision: GIT_CAPABILITY_REVISIONS_['builtin:git_inspect'],
        input: { operation: 'diff', paths: ['safe.ts', 42] },
      },
      {
        ...context,
        grant: {
          ...context.grant,
          capabilityId: 'builtin:git_inspect',
          capabilityRevision: GIT_CAPABILITY_REVISIONS_['builtin:git_inspect'],
        },
      },
    );

    expect(invalidRead).toMatchObject({
      status: 'failed',
      dispatchCertainty: 'none',
      failure: { code: 'invalid_input' },
    });
    expect(invalidGit).toMatchObject({
      status: 'failed',
      dispatchCertainty: 'none',
      failure: { code: 'invalid_input' },
    });
    expect(mechanismCalls).toBe(0);
  });
});
