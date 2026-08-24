import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExecutionBoundary,
  ExecutionCapabilitySurface,
  ShellExecutor,
  ShellInput,
} from '@kite/builtin-runtime/sandbox';
import {
  composeAppSandboxExecutor,
  createPreparedAppShellExecutor,
  SANDBOX_PREPARATION_ABORTED_REASON,
} from '@/app/sandbox/composition';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  appPreparedShellExecutionPort,
} from '@/app/sandbox/prepared-tool-pipeline';
import { withAcknowledgedSandboxLifecycleForTest } from '../helpers/sandbox-executor';

const shellSurface: ExecutionCapabilitySurface = {
  inProcessReadOnlyTools: null,
  network: false,
  process: true,
  write: true,
  workspaceWrite: true,
  shell: true,
  skillChild: false,
  localStdioMcp: false,
  gitInspect: false,
  brokeredGitFeatureRevision: null,
};

function boundary(workspace: string, networkMode: 'off' | 'allowlist'): ExecutionBoundary {
  return {
    filesystemScope: 'workspace_write',
    workspaceRoot: workspace,
    networkMode,
    networkAllowlist: networkMode === 'allowlist' ? ['api.example.com'] : [],
    allowLocalAndPrivateNetwork: false,
    protectedPathPolicy: 'deny',
    maxProcessTreeSizePerShellInvocation: 32,
    sandboxRequired: true,
    sandboxUnavailable: 'fail',
  };
}

function acknowledgedShellInput(workspace: string, command: string): ShellInput {
  return {
    workspace,
    command,
    sandboxInvocationIdentity: {
      toolCallId: 'tool-shell-1',
      capabilityId: 'builtin:shell_execute',
      capabilityRevision: 'shell-effects-v1',
      invocationId: 'invocation-shell-1',
      attempt: 1,
      effectiveEffectsDigest: 'sha256:effects',
      admissionDigest: 'sha256:admission',
      cancellationCorrelation: 'cancel-shell-1',
    },
    sandboxPreparationLifecycle: {
      recordPreparationIntent: async () => ({
        acknowledged: true,
        stage: 'preparation_intent',
        intentDigest: 'sha256:intent',
      }),
      recordPreparationReady: async () => ({
        acknowledged: true,
        stage: 'preparation_ready',
        readyDigest: 'sha256:ready',
        preparationArtifact: {
          artifactId: 'sandbox-preparation-fixture',
          kind: 'sandbox_preparation',
          integrityIdentifier: 'sha256:preparation-artifact',
          byteLength: 1,
        },
      }),
      recordExecutionDispatchIntent: async (_prepared, input) => ({
        acknowledged: true,
        stage: 'execution_dispatch_intent',
        dispatchId: input.dispatchId,
        supervisorNonce: input.supervisorNonce,
        dispatchIntentDigest: 'sha256:dispatch',
      }),
      recordExecutionSupervisorStarted: async (_prepared, input) => ({
        acknowledged: true,
        stage: 'execution_supervisor_started',
        dispatchId: input.dispatchId,
        dispatchIntentDigest: input.dispatchIntentDigest,
        supervisorPid: input.supervisorPid,
        processGroupId: input.processGroupId,
        processStartIdentity: input.processStartIdentity,
      }),
      recordDisposalIntent: async (prepared) => ({
        acknowledged: true,
        stage: 'disposal_intent',
        purpose: prepared ? 'dispose' : 'reconcile_preparation_intent',
        lifecycleIntentDigest: 'sha256:cleanup',
        cleanupAttempt: 1,
      }),
      recordDisposalReceipt: async (input) => ({
        acknowledged: true,
        stage: 'disposal_receipt',
        purpose: input.purpose,
        lifecycleIntentDigest: input.lifecycleIntentDigest,
        cleanupAttempt: input.cleanupAttempt,
        disposed: input.disposed,
      }),
    },
  };
}

describe('App sandbox composition', () => {
  test('fails closed for a development sandbox override without a governed lifecycle', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const marker = join(workspace, 'development-override');
      const executor = composeAppSandboxExecutor({
        entrypoint: 'foreground_cli',
        workspace,
        config: { sandbox: { enabled: true } },
        sandboxEnabled: false,
      });
      const result = await executor({
        workspace,
        command: "bun -e \"require('node:fs').writeFileSync('development-override','explicit')\"",
      });
      expect(result.ok).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('runs an acknowledged command in the host shell when the native sandbox is disabled', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const marker = join(workspace, 'acknowledged-host-fallback');
      const executor = composeAppSandboxExecutor({
        entrypoint: 'foreground_cli',
        workspace,
        config: { sandbox: { enabled: true } },
        sandboxEnabled: false,
      });
      const decision = await executor.prepare();
      const result = await executor(
        acknowledgedShellInput(
          workspace,
          "bun -e \"require('node:fs').writeFileSync('acknowledged-host-fallback','ok')\"",
        ),
      );
      expect(decision).toMatchObject({
        mode: 'host_shell',
        backend: 'none',
        reason: 'sandbox_disabled',
      });
      expect(result.ok).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('exposes one prepared Shell port for the preselected host execution owner', async () => {
    const calls: string[] = [];
    const executor = createPreparedAppShellExecutor({
      workspace: '/workspace',
      sandboxEnabled: false,
      resolveBackend: () => 'none',
      createNativeExecutor: () => async () => {
        throw new Error('native executor must not run');
      },
      createHostExecutor: () => async (input) => {
        calls.push(input.command);
        return { ok: true, command: input.command, exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });
    const port = appPreparedShellExecutionPort(executor);
    if (!port) throw new Error('prepared Shell port is unavailable');
    const result = await port.execute({
      identity: {
        toolCallId: 'tool-shell-prepared',
        capabilityId: 'builtin:shell_execute',
        capabilityRevision: 'shell-revision',
        invocationId: 'shell-invocation',
        attempt: 1,
        effectiveEffectsDigest: 'effects-digest',
        admissionDigest: 'admission-digest',
        cancellationCorrelation: 'attempt-1',
      },
      workspace: '/workspace',
      command: 'printf ok',
      timeoutMs: 100,
      filesystemMode: 'workspace_only',
      networkMode: 'disabled',
    });

    expect(result).toMatchObject({
      ok: true,
      stdout: 'ok',
      executionPhase: 'go_started',
    });
    expect(calls).toEqual(['printf ok']);
  });

  test('fails closed instead of widening an unenforceable descendant allowlist', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const marker = join(workspace, 'must-not-exist');
      const executor = composeAppSandboxExecutor({
        entrypoint: 'tui',
        workspace,
        config: {
          sandbox: { enabled: true },
          executionBoundary: boundary(workspace, 'allowlist'),
          executionCapabilitySurface: shellSurface,
        },
      });
      const result = await executor({
        workspace,
        command: "bun -e \"require('node:fs').writeFileSync('must-not-exist','bypass')\"",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('refusing unsandboxed shell execution');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('fails closed when the sealed surface does not admit Shell', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const executor = composeAppSandboxExecutor({
        entrypoint: 'foreground_cli',
        workspace,
        config: {
          sandbox: { enabled: true },
          executionBoundary: boundary(workspace, 'off'),
          executionCapabilitySurface: { ...shellSurface, process: false, shell: false },
        },
      });
      const result = await executor({ workspace, command: 'printf bypass' });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('refusing unsandboxed shell execution');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('sealed composition fails closed when the sandbox is explicitly unavailable', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const executor = composeAppSandboxExecutor({
        entrypoint: 'foreground_cli',
        workspace,
        config: {
          sandbox: { enabled: true },
          executionBoundary: boundary(workspace, 'off'),
          executionCapabilitySurface: shellSurface,
        },
        sandboxEnabled: false,
      });
      const result = await executor({ workspace, command: 'printf bypass' });
      expect(result).toMatchObject({ ok: false, exitCode: -1 });
      expect(result.stderr).toContain('refusing unsandboxed shell execution');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('TUI selects host availability but still requires an acknowledged Runtime invocation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const executor = composeAppSandboxExecutor({
        entrypoint: 'tui',
        workspace,
        config: { sandbox: { enabled: true } },
        sandboxEnabled: false,
      });
      const decision = await executor.prepare();
      const result = await executor({ workspace, command: 'printf bypass' });
      expect(decision).toMatchObject({ mode: 'host_shell', backend: 'none' });
      expect(result).toMatchObject({ ok: false, exitCode: -1 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('defers backend resolution and makes user commands await the same preparation', async () => {
    let releaseYield!: () => void;
    const yieldGate = new Promise<void>((resolvePromise) => {
      releaseYield = resolvePromise;
    });
    let backendResolutions = 0;
    const executor = createPreparedAppShellExecutor({
      workspace: '/workspace',
      sandboxEnabled: true,
      yieldBeforeResolve: () => yieldGate,
      resolveBackend: () => {
        backendResolutions += 1;
        return 'none';
      },
      createNativeExecutor: () => {
        throw new Error('native executor must not be constructed without a backend');
      },
    });

    const preparation = executor.prepare();
    const execution = executor({ workspace: '/workspace', command: 'user-command' });
    expect(backendResolutions).toBe(0);

    releaseYield();
    const [decision, result] = await Promise.all([preparation, execution]);
    expect(backendResolutions).toBe(1);
    expect(decision).toMatchObject({ mode: 'denied', backend: 'none' });
    expect(result).toMatchObject({ ok: false, exitCode: -1 });
  });

  test('preserves the Windows runner availability reason while failing closed', async () => {
    const executor = createPreparedAppShellExecutor({
      workspace: 'C:/workspace',
      sandboxEnabled: true,
      yieldBeforeResolve: async () => {},
      resolveBackend: async () => ({
        backend: 'none',
        unavailableReason: 'windows_restricted_token_runner_unavailable',
      }),
      createNativeExecutor: () => {
        throw new Error('native executor must not be constructed');
      },
    });

    const decision = await executor.prepare();
    const result = await executor({ workspace: 'C:/workspace', command: 'user-command' });

    expect(decision).toMatchObject({
      mode: 'denied',
      backend: 'none',
      reason: 'windows_restricted_token_runner_unavailable',
    });
    expect(result).toMatchObject({ ok: false, exitCode: -1 });
  });

  test('startup selection is pure and defers command execution to the real workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-real-'));
    const constructedWorkspaces: string[] = [];
    const calls: Array<{ boundWorkspace: string; inputWorkspace: string; command: string }> = [];
    try {
      const executor = createPreparedAppShellExecutor({
        workspace,
        sandboxEnabled: true,
        yieldBeforeResolve: async () => {},
        resolveBackend: () => 'windows_restricted_token',
        createNativeExecutor: (boundWorkspace) => {
          constructedWorkspaces.push(boundWorkspace);
          return async (input) => {
            calls.push({
              boundWorkspace,
              inputWorkspace: input.workspace,
              command: input.command,
            });
            return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
          };
        },
      });

      const decision = await executor.prepare();
      expect(decision).toMatchObject({ mode: 'sandbox', backend: 'windows_restricted_token' });
      expect(constructedWorkspaces).toEqual([workspace]);
      expect(calls).toEqual([]);

      await executor({ workspace, command: 'user-command' });
      expect(calls[0]).toEqual({
        boundWorkspace: workspace,
        inputWorkspace: workspace,
        command: 'user-command',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('caches pure backend selection without running a preflight command', async () => {
    const nativeCommands: string[] = [];
    const executor = createPreparedAppShellExecutor({
      workspace: 'C:/workspace',
      sandboxEnabled: true,
      resolveBackend: () => 'windows_restricted_token',
      createNativeExecutor: () => async (input) => {
        nativeCommands.push(input.command);
        return {
          ok: false,
          command: input.command,
          exitCode: -1,
          stdout: '',
          stderr: 'sandbox startup failed',
        };
      },
    });

    const [first, second] = await Promise.all([executor.prepare(), executor.prepare()]);
    const result = await executor({ workspace: 'C:/workspace', command: 'user-command' });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ mode: 'sandbox', backend: 'windows_restricted_token' });
    expect(nativeCommands).toEqual(['user-command']);
    expect(result).toMatchObject({ ok: false, stderr: 'sandbox startup failed' });
  });

  test('never replays a user command in the host after sandbox preflight succeeds', async () => {
    const nativeCommands: string[] = [];
    const executor = createPreparedAppShellExecutor({
      workspace: '/workspace',
      sandboxEnabled: true,
      resolveBackend: () => 'bubblewrap',
      createNativeExecutor: () => async (input) => {
        nativeCommands.push(input.command);
        return {
          ok: false,
          command: input.command,
          exitCode: 7,
          stdout: '',
          stderr: 'script failed',
        };
      },
    });

    const result = await executor({ workspace: '/workspace', command: 'exit 7' });

    expect(result).toMatchObject({ ok: false, exitCode: 7, stderr: 'script failed' });
    expect(nativeCommands).toEqual(['exit 7']);
  });

  test('does not change an approved native environment after pre-dispatch unavailability', async () => {
    const nativeCommands: string[] = [];
    const hostCommands: string[] = [];
    const executor = createPreparedAppShellExecutor({
      workspace: '/workspace',
      sandboxEnabled: true,
      resolveBackend: () => 'seatbelt',
      createNativeExecutor: () => async (input) => {
        nativeCommands.push(input.command);
        return {
          ok: false,
          command: input.command,
          exitCode: -1,
          stdout: '',
          stderr: 'Sandbox backend_unavailable: seatbelt_descendant_containment_unproven',
          terminationReason: 'sandbox_denied',
          sandboxFailure: {
            code: 'backend_unavailable',
            stage: 'pre_dispatch',
            cleanupConfirmed: true,
          },
        };
      },
      createHostExecutor: () => async (input) => {
        hostCommands.push(input.command);
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'host result',
          stderr: '',
        };
      },
    });

    const result = await executor(acknowledgedShellInput('/workspace', 'git status --short'));

    expect(result).toMatchObject({
      ok: false,
      sandboxFailure: { code: 'backend_unavailable', stage: 'pre_dispatch' },
    });
    expect(nativeCommands).toEqual(['git status --short']);
    expect(hostCommands).toEqual([]);
  });

  test('prepared Shell port keeps the approved native environment on pre-dispatch unavailability', async () => {
    const nativeCommands: string[] = [];
    const hostCommands: string[] = [];
    const nativeExecutor: ShellExecutor = async (input) => ({
      ok: false,
      command: input.command,
      exitCode: -1,
      stdout: '',
      stderr: 'Prepared port must be used.',
    });
    Object.defineProperty(nativeExecutor, APP_PREPARED_SHELL_EXECUTION_, {
      value: Object.freeze({
        execute: async (input: { readonly command: string }) => {
          nativeCommands.push(input.command);
          return {
            ok: false as const,
            command: input.command,
            exitCode: -1,
            stdout: '',
            stderr: 'Sandbox backend_unavailable: seatbelt_descendant_containment_unproven',
            terminationReason: 'sandbox_denied' as const,
            sandboxFailure: {
              code: 'backend_unavailable' as const,
              stage: 'pre_dispatch' as const,
              cleanupConfirmed: true,
            },
            executionPhase: 'not_started' as const,
          };
        },
      }),
    });
    const executor = createPreparedAppShellExecutor({
      workspace: '/workspace',
      sandboxEnabled: true,
      resolveBackend: () => 'seatbelt',
      createNativeExecutor: () => nativeExecutor,
      createHostExecutor: () => async (input) => {
        hostCommands.push(input.command);
        return { ok: true, command: input.command, exitCode: 0, stdout: 'host result', stderr: '' };
      },
    });
    const port = appPreparedShellExecutionPort(executor);
    if (!port) throw new Error('prepared Shell port is unavailable');

    const result = await port.execute({
      identity: {
        toolCallId: 'tool-shell-prepared-fallback',
        capabilityId: 'builtin:shell_execute',
        capabilityRevision: 'shell-revision',
        invocationId: 'shell-invocation',
        attempt: 1,
        effectiveEffectsDigest: 'effects-digest',
        admissionDigest: 'admission-digest',
        cancellationCorrelation: 'attempt-1',
      },
      workspace: '/workspace',
      command: 'git status --short',
      timeoutMs: 100,
      filesystemMode: 'workspace_only',
      networkMode: 'disabled',
    });

    expect(result).toMatchObject({
      ok: false,
      executionPhase: 'not_started',
      sandboxFailure: { code: 'backend_unavailable', stage: 'pre_dispatch' },
    });
    expect(nativeCommands).toEqual(['git status --short']);
    expect(hostCommands).toEqual([]);
  });

  test.skipIf(process.platform !== 'darwin')(
    'rejects the legacy raw Seatbelt path after startup and requires the prepared port',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-seatbelt-fallback-'));
      try {
        const appExecutor = composeAppSandboxExecutor({
          entrypoint: 'foreground_cli',
          workspace,
          config: { sandbox: { enabled: true } },
        });
        const decision = await appExecutor.prepare();
        const executor = withAcknowledgedSandboxLifecycleForTest(appExecutor);
        const result = await executor({ workspace, command: 'printf seatbelt-host-fallback' });

        expect(decision).toMatchObject({ mode: 'sandbox', backend: 'seatbelt' });
        expect(result).toMatchObject({
          ok: false,
          exitCode: -1,
          terminationReason: 'sandbox_denied',
        });
        expect(result.stderr).toContain('App prepared Shell execution port');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  test('never falls back when pre-dispatch cleanup is unconfirmed', async () => {
    const hostCommands: string[] = [];
    const executor = createPreparedAppShellExecutor({
      workspace: '/workspace',
      sandboxEnabled: true,
      resolveBackend: () => 'seatbelt',
      createNativeExecutor: () => async (input) => ({
        ok: false,
        command: input.command,
        exitCode: -1,
        stdout: '',
        stderr: 'Sandbox abandonment cleanup failed.',
        terminationReason: 'sandbox_denied',
        sandboxFailure: {
          code: 'backend_unavailable',
          stage: 'pre_dispatch',
          cleanupConfirmed: false,
        },
      }),
      createHostExecutor: () => async (input) => {
        hostCommands.push(input.command);
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await executor(acknowledgedShellInput('/workspace', 'git status --short'));

    expect(result).toMatchObject({ ok: false, stderr: 'Sandbox abandonment cleanup failed.' });
    expect(hostCommands).toEqual([]);
  });

  test('aborting an in-flight preparation rejects it and the next prepare retries fresh', async () => {
    let resolveMode: 'hang-until-abort' | 'fast-success' = 'hang-until-abort';
    const executor = createPreparedAppShellExecutor({
      workspace: '/workspace',
      sandboxEnabled: true,
      resolveBackend: async (): Promise<'bubblewrap'> => {
        if (resolveMode === 'fast-success') return 'bubblewrap';
        // A platform probe can be genuinely unbounded (for example while a
        // Windows runner/process is being torn down).  abortPreparation must
        // settle the caller without waiting for that probe to return.
        await new Promise<never>(() => {});
        return 'bubblewrap';
      },
      createNativeExecutor: () => async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: 'executed',
        stderr: '',
      }),
    });

    const attempt = executor.prepare();
    // Let the attempt reach the hanging probe before aborting it.
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    executor.abortPreparation?.();
    await expect(attempt).rejects.toThrow(SANDBOX_PREPARATION_ABORTED_REASON);

    // The aborted attempt must not be cached: a fresh prepare() re-probes and
    // succeeds once the probe is fast.
    resolveMode = 'fast-success';
    await expect(executor.prepare()).resolves.toMatchObject({
      mode: 'sandbox',
      backend: 'bubblewrap',
    });
  });
});
