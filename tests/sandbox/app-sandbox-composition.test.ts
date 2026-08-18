import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeAppSandboxExecutorV1,
  createPreparedAppShellExecutorV1,
  SANDBOX_PREPARATION_ABORTED_REASON,
} from '@/app/sandbox/composition';
import type { ExecutionBoundaryV1, ExecutionCapabilitySurfaceV1 } from '@/core/sandbox/types';
import type { ShellInput } from '@/core/types';
import { withAcknowledgedSandboxLifecycleForTestV1 } from '../helpers/sandbox-executor';

const shellSurface: ExecutionCapabilitySurfaceV1 = {
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

function boundary(workspace: string, networkMode: 'off' | 'allowlist'): ExecutionBoundaryV1 {
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
      recordPreparationIntent: async () => ({ intentDigest: 'sha256:intent' }),
      recordPreparationReady: async () => true,
      recordExecutionDispatchIntent: async () => ({
        dispatchIntentDigest: 'sha256:dispatch',
      }),
      recordExecutionSupervisorStarted: async () => true,
      recordDisposalIntent: async (prepared) => ({
        purpose: prepared ? 'dispose' : 'reconcile_preparation_intent',
        lifecycleIntentDigest: 'sha256:cleanup',
        cleanupAttempt: 1,
      }),
      recordDisposalReceipt: async () => true,
    },
  };
}

describe('App sandbox composition', () => {
  test('fails closed for a development sandbox override without a governed lifecycle', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const marker = join(workspace, 'development-override');
      const executor = composeAppSandboxExecutorV1({
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
      const executor = composeAppSandboxExecutorV1({
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

  test('fails closed instead of widening an unenforceable descendant allowlist', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const marker = join(workspace, 'must-not-exist');
      const executor = composeAppSandboxExecutorV1({
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
      const executor = composeAppSandboxExecutorV1({
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
      const executor = composeAppSandboxExecutorV1({
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
      const executor = composeAppSandboxExecutorV1({
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
    const executor = createPreparedAppShellExecutorV1({
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
    const executor = createPreparedAppShellExecutorV1({
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
      const executor = createPreparedAppShellExecutorV1({
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
    const executor = createPreparedAppShellExecutorV1({
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
    const executor = createPreparedAppShellExecutorV1({
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

  test('falls back exactly once after typed pre-dispatch backend unavailability and confirmed cleanup', async () => {
    const nativeCommands: string[] = [];
    const hostCommands: string[] = [];
    const executor = createPreparedAppShellExecutorV1({
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

    expect(result).toMatchObject({ ok: true, stdout: 'host result' });
    expect(nativeCommands).toEqual(['git status --short']);
    expect(hostCommands).toEqual(['git status --short']);
  });

  test.skipIf(process.platform !== 'darwin')(
    'runs an acknowledged command through the real Seatbelt-unavailable App composition',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-seatbelt-fallback-'));
      try {
        const appExecutor = composeAppSandboxExecutorV1({
          entrypoint: 'foreground_cli',
          workspace,
          config: { sandbox: { enabled: true } },
        });
        const decision = await appExecutor.prepare();
        const executor = withAcknowledgedSandboxLifecycleForTestV1(appExecutor);
        const result = await executor({ workspace, command: 'printf seatbelt-host-fallback' });

        expect(decision).toMatchObject({ mode: 'sandbox', backend: 'seatbelt' });
        expect(result).toMatchObject({
          ok: true,
          exitCode: 0,
          stdout: 'seatbelt-host-fallback',
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  test('never falls back when pre-dispatch cleanup is unconfirmed', async () => {
    const hostCommands: string[] = [];
    const executor = createPreparedAppShellExecutorV1({
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
    const executor = createPreparedAppShellExecutorV1({
      workspace: '/workspace',
      sandboxEnabled: true,
      resolveBackend: async (): Promise<'bubblewrap'> => {
        if (resolveMode === 'fast-success') return 'bubblewrap';
        await new Promise((resolveAwait) => setTimeout(resolveAwait, 30));
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
