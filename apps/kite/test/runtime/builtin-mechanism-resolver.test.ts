import { describe, expect, test } from 'bun:test';
import type { BuiltinWorkspaceFilesystemInvocationDispatcher } from '@kite-ai/builtin-runtime/filesystem';
import {
  AppBuiltinMechanismResolverError,
  type AppBuiltinPreassembledMechanismResolverInput,
  type AppBuiltinShellExecutorInput,
  createAppBuiltinMechanismResolver,
} from '#app/bootstrap/runtime/builtin-mechanism-resolver';
import type { BuiltinShellExecutionResult } from '#builtin-runtime';
import type {
  CapabilityPolicyEffects,
  GitInspectRequest,
  RuntimeJsonValue,
  WorkspaceFilesystemOperation,
} from '#runtime-spi';

const WORKSPACE = '/tmp/kite-mechanism-resolver';
const BASELINE_SANDBOX_SCOPE = Object.freeze({
  kind: 'baseline' as const,
  filesystem: 'workspace_write' as const,
  network: 'disabled' as const,
  digest: 'scope-baseline',
});
const FULL_SANDBOX_SCOPE = Object.freeze({
  kind: 'unrestricted' as const,
  filesystem: 'full_access' as const,
  network: 'allow_all' as const,
  digest: 'scope-full',
});

function frozenJson<T extends RuntimeJsonValue>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozenJson(child);
    Object.freeze(value);
  }
  return value;
}

function baseInput(
  overrides: Partial<AppBuiltinPreassembledMechanismResolverInput> = {},
): AppBuiltinPreassembledMechanismResolverInput {
  return {
    executionMechanism: 'catalog',
    workspace: WORKSPACE,
    canonicalArguments: frozenJson({}),
    grantUsed: 'none',
    interactionMode: 'accept_edits',
    sandboxScope: BASELINE_SANDBOX_SCOPE,
    policyEffects: Object.freeze({}),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function mechanism<T extends Record<string, unknown>>(
  record: T,
): Readonly<Record<string, unknown>> {
  return Object.freeze(record);
}

function shellResult(): BuiltinShellExecutionResult {
  return {
    ok: true,
    command: 'fixture',
    exitCode: 0,
    stdout: '',
    stderr: '',
    intent: 'inspect',
  };
}

describe('App Builtin mechanism resolver', () => {
  test('returns one frozen empty catalog map and rejects dedicated seams', () => {
    const resolve = createAppBuiltinMechanismResolver();
    const catalog = resolve(baseInput());
    expect(catalog).toEqual({});
    expect(Object.isFrozen(catalog)).toBe(true);

    for (const executionMechanism of ['subagent', 'user_input', 'model', 'verification'] as const) {
      expect(() => resolve(baseInput({ executionMechanism }))).toThrow(
        AppBuiltinMechanismResolverError,
      );
    }
  });

  test('preserves raw filesystem paths and keeps external read/write grant boundaries', async () => {
    const calls: WorkspaceFilesystemOperation[] = [];
    const filesystemRuntime: BuiltinWorkspaceFilesystemInvocationDispatcher = Object.freeze({
      dispatch: async (operation: WorkspaceFilesystemOperation) => {
        calls.push(operation);
        return { ok: true } as never;
      },
    });
    const resolve = createAppBuiltinMechanismResolver();
    const readPolicy: CapabilityPolicyEffects = Object.freeze({ externalRead: true });
    const readMap = resolve(
      baseInput({
        executionMechanism: 'filesystem',
        canonicalArguments: frozenJson({ path: 'outside.txt' }),
        policyEffects: readPolicy,
        filesystemRuntime,
      }),
    );
    const readMechanism = readMap.filesystem as {
      readonly allowExternalPaths: boolean;
      readonly dispatch: (operation: WorkspaceFilesystemOperation) => Promise<unknown>;
    };
    expect(readMechanism.allowExternalPaths).toBe(true);
    await readMechanism.dispatch({
      kind: 'read_file',
      path: 'outside.txt',
      pathScope: 'workspace_only',
    });
    expect(calls[0]?.path).toBe('outside.txt');
    expect(calls[0]?.pathScope).toBe('external_read');

    calls.length = 0;
    const writePolicy: CapabilityPolicyEffects = Object.freeze({ externalWrite: true });
    const noGrantMap = resolve(
      baseInput({
        executionMechanism: 'filesystem',
        canonicalArguments: frozenJson({ path: 'write.txt', content: 'x' }),
        policyEffects: writePolicy,
        grantUsed: 'none',
        filesystemRuntime,
      }),
    );
    const noGrantMechanism = noGrantMap.filesystem as {
      readonly allowExternalPaths: boolean;
      readonly dispatch: (operation: WorkspaceFilesystemOperation) => Promise<unknown>;
    };
    expect(noGrantMechanism.allowExternalPaths).toBe(false);
    await noGrantMechanism.dispatch({
      kind: 'write_file',
      path: 'write.txt',
      pathScope: 'approved_external',
      content: 'x',
    });
    expect(calls[0]?.pathScope).toBe('workspace_only');

    calls.length = 0;
    const grantedMap = resolve(
      baseInput({
        executionMechanism: 'filesystem',
        canonicalArguments: frozenJson({ path: 'write.txt', content: 'x' }),
        policyEffects: writePolicy,
        grantUsed: 'same_command',
        filesystemRuntime,
      }),
    );
    const grantedMechanism = grantedMap.filesystem as {
      readonly allowExternalPaths: boolean;
      readonly dispatch: (operation: WorkspaceFilesystemOperation) => Promise<unknown>;
    };
    expect(grantedMechanism.allowExternalPaths).toBe(true);
    await grantedMechanism.dispatch({
      kind: 'write_file',
      path: 'write.txt',
      pathScope: 'workspace_only',
      content: 'x',
    });
    expect(calls[0]?.pathScope).toBe('approved_external');
  });

  test('keeps git inspect and shell cancellation/progress/timeout facts exact', async () => {
    const controller = new AbortController();
    let inspectedSignal: AbortSignal | undefined;
    const gitBroker = Object.freeze({
      inspect: async (_request: GitInspectRequest, signal?: AbortSignal) => {
        inspectedSignal = signal;
        return { ok: true, output: 'status' };
      },
    });
    const resolve = createAppBuiltinMechanismResolver();
    const gitMap = resolve(
      baseInput({ executionMechanism: 'git', signal: controller.signal, gitBroker }),
    );
    const git = gitMap.git as {
      readonly inspect: (request: GitInspectRequest, signal?: AbortSignal) => Promise<unknown>;
    };
    await git.inspect({ operation: 'status' });
    expect(inspectedSignal).toBe(controller.signal);

    const progress: unknown[] = [];
    const shellInputs: AppBuiltinShellExecutorInput[] = [];
    const shellExecutor = Object.freeze({
      execute: async (input: Readonly<AppBuiltinShellExecutorInput>) => {
        shellInputs.push(input);
        return shellResult();
      },
    });
    const shellMap = resolve(
      baseInput({
        executionMechanism: 'shell',
        canonicalArguments: frozenJson({ command: 'pwd' }),
        interactionMode: 'full',
        sandboxScope: FULL_SANDBOX_SCOPE,
        policyEffects: Object.freeze({ network: true, externalRead: true }),
        signal: controller.signal,
        shellExecutor,
        onProgress: (event) => progress.push(event),
      }),
    );
    const shell = shellMap.shell as {
      readonly execute: (
        input: Readonly<{ command: string; timeoutMs: number }>,
      ) => Promise<unknown>;
    };
    await shell.execute({ command: 'pwd', timeoutMs: 321 });
    expect(shellInputs).toHaveLength(1);
    expect(shellInputs[0]).toMatchObject({
      workspace: WORKSPACE,
      command: 'pwd',
      timeoutMs: 321,
      signal: controller.signal,
      readOnly: true,
      networkAccess: 'approved',
      filesystemAccess: 'approved_external',
    });
    shellInputs[0]?.onProgress?.('progress', 'stdout');
    expect(progress).toEqual(['progress']);

    const unsafeMap = resolve(
      baseInput({
        executionMechanism: 'shell',
        canonicalArguments: frozenJson({ command: 'echo x > file' }),
        shellExecutor,
      }),
    );
    const unsafeShell = unsafeMap.shell as typeof shell;
    await unsafeShell.execute({ command: 'echo x > file', timeoutMs: 100 });
    expect(shellInputs[1]?.readOnly).toBe(false);

    const uncertainMap = resolve(
      baseInput({
        executionMechanism: 'shell',
        canonicalArguments: frozenJson({ command: 'custom-tool' }),
        grantUsed: 'approve_once',
        authorizationKind: 'approved_call',
        policyEffects: Object.freeze({ uncertainEffects: true }),
        shellExecutor,
      }),
    );
    await (uncertainMap.shell as typeof shell).execute({ command: 'custom-tool', timeoutMs: 100 });
    expect(shellInputs[2]).toMatchObject({
      networkAccess: 'none',
      filesystemAccess: 'workspace_only',
    });
    await expect(
      Promise.resolve().then(() => shell.execute({ command: 'different', timeoutMs: 100 })),
    ).rejects.toThrow(AppBuiltinMechanismResolverError);

    const aborted = new AbortController();
    aborted.abort();
    const callsBeforeAbort = shellInputs.length;
    const abortedMap = resolve(
      baseInput({
        executionMechanism: 'shell',
        canonicalArguments: frozenJson({ command: 'pwd' }),
        shellExecutor,
        signal: aborted.signal,
      }),
    );
    const abortedShell = abortedMap.shell as typeof shell;
    await expect(
      Promise.resolve().then(() => abortedShell.execute({ command: 'pwd', timeoutMs: 100 })),
    ).rejects.toThrow(AppBuiltinMechanismResolverError);
    expect(shellInputs).toHaveLength(callsBeforeAbort);
  });

  test('treats approve_once as a bound one-call grant without widening policy effects', async () => {
    const filesystemCalls: WorkspaceFilesystemOperation[] = [];
    const filesystemRuntime: BuiltinWorkspaceFilesystemInvocationDispatcher = Object.freeze({
      dispatch: async (operation: WorkspaceFilesystemOperation) => {
        filesystemCalls.push(operation);
        return { ok: true } as never;
      },
    });
    const filesystem = createAppBuiltinMechanismResolver()(
      baseInput({
        executionMechanism: 'filesystem',
        canonicalArguments: frozenJson({ path: '../outside.txt', content: 'x' }),
        grantUsed: 'approve_once',
        authorizationKind: 'approved_call',
        policyEffects: Object.freeze({ externalWrite: true }),
        filesystemRuntime,
      }),
    );
    const filesystemMechanism = filesystem.filesystem as {
      readonly allowExternalPaths: boolean;
      readonly dispatch: (operation: WorkspaceFilesystemOperation) => Promise<unknown>;
    };
    expect(filesystemMechanism.allowExternalPaths).toBe(true);
    await filesystemMechanism.dispatch({
      kind: 'write_file',
      path: '../outside.txt',
      pathScope: 'approved_external',
      content: 'x',
    });
    expect(filesystemCalls[0]?.pathScope).toBe('approved_external');

    const filesystemWithoutPolicy = createAppBuiltinMechanismResolver()(
      baseInput({
        executionMechanism: 'filesystem',
        canonicalArguments: frozenJson({ path: '../outside.txt', content: 'x' }),
        grantUsed: 'approve_once',
        authorizationKind: 'approved_call',
        policyEffects: Object.freeze({}),
        filesystemRuntime,
      }),
    );
    const constrainedFilesystem = filesystemWithoutPolicy.filesystem as typeof filesystemMechanism;
    expect(constrainedFilesystem.allowExternalPaths).toBe(false);
    await constrainedFilesystem.dispatch({
      kind: 'write_file',
      path: '../outside.txt',
      pathScope: 'approved_external',
      content: 'x',
    });
    expect(filesystemCalls[1]?.pathScope).toBe('workspace_only');

    const shellInputs: AppBuiltinShellExecutorInput[] = [];
    const shellExecutor = Object.freeze({
      execute: async (input: Readonly<AppBuiltinShellExecutorInput>) => {
        shellInputs.push(input);
        return shellResult();
      },
    });
    const resolve = createAppBuiltinMechanismResolver();

    const approved = resolve(
      baseInput({
        executionMechanism: 'shell',
        canonicalArguments: frozenJson({ command: 'curl https://example.test' }),
        grantUsed: 'approve_once',
        authorizationKind: 'approved_call',
        policyEffects: Object.freeze({ network: true }),
        shellExecutor,
      }),
    );
    const approvedShell = approved.shell as {
      readonly execute: (
        input: Readonly<{ command: string; timeoutMs: number }>,
      ) => Promise<unknown>;
    };
    await approvedShell.execute({ command: 'curl https://example.test', timeoutMs: 100 });
    expect(shellInputs[0]?.networkAccess).toBe('none');
    expect(shellInputs[0]?.filesystemAccess).toBe('workspace_only');

    const noPolicyEffect = resolve(
      baseInput({
        executionMechanism: 'shell',
        canonicalArguments: frozenJson({ command: 'curl https://example.test' }),
        grantUsed: 'approve_once',
        authorizationKind: 'approved_call',
        policyEffects: Object.freeze({}),
        shellExecutor,
      }),
    );
    const noPolicyShell = noPolicyEffect.shell as typeof approvedShell;
    await noPolicyShell.execute({ command: 'curl https://example.test', timeoutMs: 100 });
    expect(shellInputs[1]?.networkAccess).toBe('none');
    expect(shellInputs[1]?.filesystemAccess).toBe('workspace_only');

    const policyAllow = baseInput({
      executionMechanism: 'shell',
      canonicalArguments: frozenJson({ command: 'curl https://example.test' }),
      grantUsed: 'approve_once',
      authorizationKind: 'policy_allow',
      policyEffects: Object.freeze({ network: true }),
      shellExecutor,
    });
    expect(() => resolve(policyAllow)).toThrow(AppBuiltinMechanismResolverError);
    expect(() =>
      resolve(
        baseInput({
          executionMechanism: 'shell',
          canonicalArguments: frozenJson({ command: 'curl https://example.test' }),
          grantUsed: 'approve_once',
          policyEffects: Object.freeze({ network: true }),
          shellExecutor,
        }),
      ),
    ).toThrow(AppBuiltinMechanismResolverError);
    expect(() =>
      resolve(
        baseInput({
          executionMechanism: 'shell',
          canonicalArguments: frozenJson({ command: 'curl https://example.test' }),
          grantUsed: 'not-a-grant' as never,
          authorizationKind: 'approved_call',
          shellExecutor,
        }),
      ),
    ).toThrow(AppBuiltinMechanismResolverError);
  });

  test('passes only one exact frozen preassembled wrapper for web, MCP, Skill, or planning', () => {
    const resolve = createAppBuiltinMechanismResolver();
    const web = mechanism({ fetch: async () => ({ ok: true }) });
    const runtime = mechanism({
      getCapabilitySnapshot: () => ({}),
      getProviderDirectorySnapshot: () => ({}),
      getResourceDirectorySnapshot: () => ({}),
      findCapability: () => undefined,
      callCapability: async () => ({}),
      readResource: async () => ({}),
    });
    const mcp = mechanism({ runtime });
    const skill = mechanism({
      catalog: Object.freeze({}),
      flags: Object.freeze({}),
      state: Object.freeze({}),
      verificationEnabled: true,
    });
    const planning = mechanism({ read: () => ({}), update: () => ({}), write: () => ({}) });

    for (const [executionMechanism, wrapper] of [
      ['web', web],
      ['mcp', mcp],
      ['skill', skill],
      ['planning', planning],
    ] as const) {
      const result = resolve(
        baseInput({
          executionMechanism,
          preassembledMechanism: Object.freeze({ [executionMechanism]: wrapper }),
        }),
      );
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.keys(result)).toEqual([executionMechanism]);
      expect(result[executionMechanism]).toBe(wrapper);
    }
  });

  test('fails closed for missing, wrong-key, duplicate, mutable, and malformed mechanisms', () => {
    const resolve = createAppBuiltinMechanismResolver();
    const filesystemRuntime: BuiltinWorkspaceFilesystemInvocationDispatcher = Object.freeze({
      dispatch: async () => ({ ok: true }) as never,
    });
    expect(() =>
      resolve(baseInput({ executionMechanism: 'filesystem', filesystemRuntime })),
    ).not.toThrow();
    expect(() => resolve(baseInput({ executionMechanism: 'git' }))).toThrow(
      AppBuiltinMechanismResolverError,
    );
    expect(() =>
      resolve(
        baseInput({
          executionMechanism: 'web',
          preassembledMechanism: Object.freeze({ wrong: Object.freeze({}) }),
        }),
      ),
    ).toThrow(AppBuiltinMechanismResolverError);
    expect(() =>
      resolve(
        baseInput({
          executionMechanism: 'web',
          preassembledMechanism: Object.freeze({
            web: Object.freeze({ fetch: () => ({}) }),
            mcp: Object.freeze({}),
          }),
        }),
      ),
    ).toThrow(AppBuiltinMechanismResolverError);
    expect(() =>
      resolve(
        baseInput({
          executionMechanism: 'web',
          preassembledMechanism: { web: Object.freeze({ fetch: () => ({}) }) },
        }),
      ),
    ).toThrow(AppBuiltinMechanismResolverError);
    expect(() =>
      resolve(
        baseInput({
          executionMechanism: 'shell',
          canonicalArguments: frozenJson({}),
          shellExecutor: Object.freeze({ execute: async () => shellResult() }),
        }),
      ),
    ).toThrow(AppBuiltinMechanismResolverError);
    expect(() =>
      resolve(
        baseInput({
          executionMechanism: 'filesystem',
          canonicalArguments: frozenJson({ path: 'x' }),
          filesystemRuntime,
          policyEffects: { externalRead: true },
        }),
      ),
    ).toThrow(AppBuiltinMechanismResolverError);
  });
});
