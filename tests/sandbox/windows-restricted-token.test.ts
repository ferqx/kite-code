import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeAppSandboxExecutorV1 } from '@/app/sandbox/composition';
import {
  buildWindowsRestrictedTokenEnvForTest,
  createWindowsRestrictedTokenCapabilitySidV1,
  createWindowsRestrictedTokenDirectWorkspaceV1,
  createWindowsRestrictedTokenInvocationName,
  resolveBunExecutableForWindowsRestrictedTokenV1,
  resolveWindowsRestrictedTokenFilesystemScopeV1,
  resolveWindowsRestrictedTokenNetworkModeV1,
  restrictedTokenNetworkUnsupportedReasonV1,
  wrapWindowsRestrictedTokenCommandV1,
} from '@/core/execution/sandbox-execution/windows-preparation';
import { decodeWindowsSandboxRunnerFrameV1 } from '@/core/execution/sandbox-execution/windows-runtime';
import {
  clearWindowsSandboxRunnerCacheV1,
  parseWindowsSandboxRunnerManifestV1,
  resolveInstalledWindowsRunnerManifestLocationV1,
  resolveWindowsSandboxRunnerV1,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
} from '@/core/sandbox/windows-runner';
import {
  createSandboxExecutor,
  type TestSandboxDisposalReceiptV1,
  withAcknowledgedSandboxLifecycleForTestV1,
} from '../helpers/sandbox-executor';

describe('Windows restricted-token invocation protocol', () => {
  test('accepts only exact framed exit receipts bound to the invocation', () => {
    const receipt = {
      version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      peakProcesses: 1,
      activeProcessLimit: 32,
      cleanupConfirmed: true,
      invocationName: 'sandbox-invocation',
      error: null,
    };
    const frame = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
    expect(
      decodeWindowsSandboxRunnerFrameV1(frame({ type: 'exit', receipt }), 'sandbox-invocation'),
    ).toEqual({ type: 'exit', receipt });
    for (const malformed of [
      { ...receipt, invocationName: 'other-invocation' },
      { ...receipt, cleanupConfirmed: 'true' },
      { ...receipt, exitCode: 2_147_483_648 },
      { ...receipt, peakProcesses: 33 },
      { ...receipt, unexpected: true },
    ]) {
      expect(() =>
        decodeWindowsSandboxRunnerFrameV1(
          frame({ type: 'exit', receipt: malformed }),
          'sandbox-invocation',
        ),
      ).toThrow('malformed frame');
    }
    expect(() =>
      decodeWindowsSandboxRunnerFrameV1(
        frame({ type: 'exit', receipt, unexpected: true }),
        'sandbox-invocation',
      ),
    ).toThrow('malformed frame');
  });

  test('rejects the previous wire protocol before sending full_access', () => {
    expect(WINDOWS_SANDBOX_PROTOCOL_VERSION).toBe(6);
    expect(
      parseWindowsSandboxRunnerManifestV1({
        version: 1,
        protocolVersion: 5,
        runnerVersion: '0.7.1',
        minimumWindowsVersion: '10.0.19045',
        runnerDigest: `sha256:${'a'.repeat(64)}`,
        runnerPath: 'runner.exe',
        shellRuntime: 'isksh',
        shellRuntimeDigest: `sha256:${'b'.repeat(64)}`,
        shellRuntimePath: 'vendor/isksh',
        coreutilsDigest: `sha256:${'c'.repeat(64)}`,
      }),
    ).toBeNull();
  });

  test('projects approved external files into a full-filesystem restricted-token invocation', () => {
    expect(
      resolveWindowsRestrictedTokenFilesystemScopeV1({
        configuredFilesystemScope: 'workspace_write',
        invocationFilesystemMode: 'allow_all',
      }),
    ).toBe('full_access');
    expect(
      resolveWindowsRestrictedTokenFilesystemScopeV1({
        configuredFilesystemScope: 'read_only',
        invocationFilesystemMode: 'workspace_only',
      }),
    ).toBe('read_only');
  });

  test('uses the native synthetic capability SID form without signed components', () => {
    expect(
      createWindowsRestrictedTokenCapabilitySidV1(() => '01234567-89ab-cdef-fedc-ba9876543210'),
    ).toBe('S-1-5-21-19088743-2309737967-4275878552-1985229328');
  });

  test('uses an ephemeral workspace SID only for an internal startup probe', () => {
    const values = ['S-1-5-21-1-2-3-4', 'S-1-5-21-5-6-7-8', 'S-1-5-21-9-10-11-12'];
    const createCapabilitySid = () => {
      const next = values.shift();
      if (!next) throw new Error('test SID sequence exhausted');
      return next;
    };
    expect(
      createWindowsRestrictedTokenDirectWorkspaceV1({ startupProbe: false, createCapabilitySid }),
    ).toEqual({ runtimeCapabilitySid: 'S-1-5-21-1-2-3-4' });
    expect(
      createWindowsRestrictedTokenDirectWorkspaceV1({ startupProbe: true, createCapabilitySid }),
    ).toEqual({
      runtimeCapabilitySid: 'S-1-5-21-5-6-7-8',
      ephemeralWorkspaceCapabilitySid: 'S-1-5-21-9-10-11-12',
    });
  });

  test('adds a distinct protected-path guard SID to approved filesystem calls', () => {
    const values = ['S-1-5-21-1-2-3-4', 'S-1-5-21-5-6-7-8'];
    const result = createWindowsRestrictedTokenDirectWorkspaceV1({
      startupProbe: false,
      approvedFilesystem: true,
      createCapabilitySid: () => values.shift()!,
    });
    expect(result).toEqual({
      runtimeCapabilitySid: 'S-1-5-21-1-2-3-4',
      approvedFilesystemGuardSid: 'S-1-5-21-5-6-7-8',
    });
  });

  test('generates a protocol-compatible cleanup identity per invocation', () => {
    const first = createWindowsRestrictedTokenInvocationName();
    const second = createWindowsRestrictedTokenInvocationName();
    expect(first).toMatch(/^kitecode\.[a-z0-9]{32}$/);
    expect(second).toMatch(/^kitecode\.[a-z0-9]{32}$/);
    expect(first).not.toBe(second);
  });
});

describe('Windows restricted-token environment', () => {
  test('puts the private runtime, Coreutils, shell runtime, and verified Bun first', () => {
    const env = buildWindowsRestrictedTokenEnvForTest(
      {
        PATH: 'C:\\host\\path',
        SystemRoot: 'C:\\Windows',
        OPENAI_API_KEY: 'secret',
        HTTP_PROXY: 'http://proxy:8080',
      } as NodeJS.ProcessEnv,
      'C:\\runtime',
      'C:\\vendor\\isksh',
      'C:\\tools\\bun\\bun.exe',
    );
    expect(env.PATH).toBe(
      'C:\\runtime;C:\\runtime\\kite-coreutils;C:\\vendor\\isksh;C:\\tools\\bun;C:\\host\\path',
    );
    expect(env.BUN_INSTALL_CACHE_DIR).toBe('C:\\runtime\\bun-cache');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  test('removes Workspace-controlled and relative inherited PATH entries for policy reads', () => {
    const env = buildWindowsRestrictedTokenEnvForTest(
      {
        PATH: 'C:\\workspace;C:\\workspace\\bin;.;C:\\safe\\bin',
        SystemRoot: 'C:\\Windows',
      } as NodeJS.ProcessEnv,
      'C:\\runtime',
      'C:\\vendor\\isksh',
      'C:\\workspace\\bun.exe',
      {
        workspaceRoot: 'C:\\workspace',
        policyProvenReadOnly: true,
        canonicalizePath: (path) => path.replaceAll('/', '\\'),
      },
    );
    expect(env.PATH).toBe(
      'C:\\runtime;C:\\runtime\\kite-coreutils;C:\\vendor\\isksh;C:\\safe\\bin',
    );
  });

  test('accepts only canonical Bun executable names for the PATH entry', () => {
    expect(
      resolveBunExecutableForWindowsRestrictedTokenV1({
        which: () => 'C:\\tools\\bun.exe',
        execPath: null,
        realpath: (path) => path,
      }),
    ).toBe('C:\\tools\\bun.exe');
    expect(
      resolveBunExecutableForWindowsRestrictedTokenV1({
        which: () => 'C:\\tools\\kite.exe',
        execPath: null,
        realpath: (path) => path,
      }),
    ).toBeNull();
  });
});

describe('Windows standalone runner discovery', () => {
  test('resolves the active candidate payload for both managed launchers', () => {
    for (const launcher of ['kite.exe', 'kite-tui.exe']) {
      const location = resolveInstalledWindowsRunnerManifestLocationV1({
        executablePath: `C:\\Kite\\bin\\${launcher}`,
        readFile: (path) => {
          expect(path).toBe('C:\\Kite\\.kite-code-managed.json');
          return JSON.stringify({ currentCandidateId: 'a'.repeat(24) });
        },
      });
      expect(location).toEqual({
        path: `C:\\Kite\\releases\\${'a'.repeat(24)}\\release\\platform-capabilities\\windows-runner-v1.json`,
        base: `C:\\Kite\\releases\\${'a'.repeat(24)}`,
      });
    }
  });

  test('does not treat an arbitrary Bun or malformed installation marker as a managed launcher', () => {
    expect(
      resolveInstalledWindowsRunnerManifestLocationV1({
        executablePath: 'C:\\tools\\bun.exe',
      }),
    ).toBeNull();
    expect(
      resolveInstalledWindowsRunnerManifestLocationV1({
        executablePath: 'C:\\Kite\\bin\\kite.exe',
        readFile: () => JSON.stringify({ currentCandidateId: 'not-a-candidate' }),
      }),
    ).toBeNull();
  });

  test('a custom manifest failure does not poison the production runner cache', () => {
    clearWindowsSandboxRunnerCacheV1();
    const baseline = resolveWindowsSandboxRunnerV1();
    if (!baseline) return;

    clearWindowsSandboxRunnerCacheV1();
    expect(
      resolveWindowsSandboxRunnerV1({
        manifestPath: join(tmpdir(), 'missing-kite-windows-runner-manifest.json'),
      }),
    ).toBeNull();
    expect(resolveWindowsSandboxRunnerV1()).toEqual(baseline);
    clearWindowsSandboxRunnerCacheV1();
  });
});

describe('Windows restricted-token network capability', () => {
  test('rejects the allowlist broker but projects an approved development network grant', () => {
    expect(
      restrictedTokenNetworkUnsupportedReasonV1({
        hasNetworkBroker: true,
      }),
    ).toContain('Network broker');
    expect(
      restrictedTokenNetworkUnsupportedReasonV1({
        hasNetworkBroker: false,
      }),
    ).toBeNull();
    expect(
      resolveWindowsRestrictedTokenNetworkModeV1({
        configuredNetworkMode: 'disabled',
        invocationNetworkMode: 'disabled',
      }),
    ).toBe('off');
    expect(
      resolveWindowsRestrictedTokenNetworkModeV1({
        configuredNetworkMode: 'disabled',
        invocationNetworkMode: 'allow_all',
      }),
    ).toBe('allow_all');
  });
});

describe('Windows restricted-token package-manager command normalization', () => {
  test('routes bare package-manager names through Windows command shims', () => {
    const wrapped = wrapWindowsRestrictedTokenCommandV1('npm --version');
    expect(wrapped).toContain('npm() { cmd.exe /d /c npm.cmd "$@"; }');
    expect(wrapped).toEndWith('\nnpm --version');
  });

  test('converts POSIX drive paths without changing URLs or non-drive paths', () => {
    if (process.platform !== 'win32') return;
    const wrapped = wrapWindowsRestrictedTokenCommandV1(
      'ls /d/Code/kite-code/src "/c/Program Files"; echo https://example.test/d/path /dev/null',
    );
    expect(wrapped).toEndWith(
      '\nls D:/Code/kite-code/src "C:/Program Files"; echo https://example.test/d/path /dev/null',
    );
  });

  test('converts a redirection path without treating cmd switches as drive roots', () => {
    if (process.platform !== 'win32') return;
    const wrapped = wrapWindowsRestrictedTokenCommandV1(
      'cat </d/input.txt; cmd.exe /d /c "echo ok"',
    );
    expect(wrapped).toEndWith('\ncat <D:/input.txt; cmd.exe /d /c "echo ok"');
  });
});
describe('trusted sandbox backend selection', () => {
  test('does not redetect after composition selected an unavailable backend', async () => {
    const executor = createSandboxExecutor({
      enabled: true,
      workspace: process.cwd(),
      selectedBackend: 'none',
      unavailableFallback: 'fail',
    });
    const result = await executor({ workspace: process.cwd(), command: 'echo should-not-run' });
    expect(result).toMatchObject({ ok: false, exitCode: -1 });
    expect(result.stderr).toContain('sandbox_backend_unavailable');
  });
});

const nativeRestrictedTokenE2e =
  process.platform === 'win32' &&
  process.env.KITE_RUN_WINDOWS_RESTRICTED_TOKEN_E2E === '1' &&
  resolveWindowsSandboxRunnerV1() !== null
    ? test
    : test.skip;

describe('Windows restricted-token native E2E', () => {
  nativeRestrictedTokenE2e(
    'fails closed after acknowledged preparation intent and before native command dispatch',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kite-windows-restricted-token-e2e-'));
      try {
        const appExecutor = composeAppSandboxExecutorV1({
          entrypoint: 'tui',
          workspace,
          config: { sandbox: { enabled: true } },
          hostFallbackPolicy: 'deny',
        });
        const prepared = await appExecutor.prepare();
        if (
          prepared.mode === 'denied' &&
          prepared.reason?.includes('restricted_token_parent_already_restricted')
        ) {
          return;
        }
        expect(prepared).toMatchObject({
          mode: 'sandbox',
          backend: 'windows_restricted_token',
        });
        const transitions: string[] = [];
        let disposalReceipt: TestSandboxDisposalReceiptV1 | undefined;
        const executor = withAcknowledgedSandboxLifecycleForTestV1(appExecutor, {
          onTransition: (transition) => transitions.push(transition),
          onDisposalReceipt: (receipt) => {
            disposalReceipt = receipt;
          },
        });
        const denied = await executor({
          workspace,
          command: 'printf MUST_NOT_RUN > direct-output.txt',
          timeoutMs: 60_000,
        });
        expect(denied).toMatchObject({
          ok: false,
          exitCode: -1,
          terminationReason: 'sandbox_denied',
        });
        expect(denied.stderr).toContain('windows_handle_relative_runtime_cleanup_unavailable');
        expect(denied.stderr).toContain('Sandbox abandonment cleanup failed.');
        expect(denied.stdout).toBe('');
        expect(transitions).toEqual([
          'preparation_intent_recorded',
          'preparation_reconciliation_intent_recorded',
          'disposal_receipt_unconfirmed',
        ]);
        expect(disposalReceipt).toMatchObject({
          prepared: null,
          purpose: 'reconcile_preparation_intent',
          cleanupAttempt: 1,
          disposed: false,
        });
        expect(disposalReceipt?.lifecycleIntentDigest).toMatch(
          /^test-reconcile_preparation_intent:test:/u,
        );
        expect(existsSync(join(workspace, 'direct-output.txt'))).toBe(false);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    360_000,
  );
});
