import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeAppSandboxExecutorV1 } from '@/app/sandbox/composition';
import type { PendingToolRequest } from '@/core/harness/tool-requests';
import { runApprovedTool } from '@/core/harness/tool-runner';
import { createSandboxExecutor } from '@/core/sandbox/executor';
import { resolveWindowsManagedNetworkSetupStatusV1 } from '@/core/sandbox/windows-network-setup';
import {
  buildWindowsRestrictedTokenEnvForTest,
  createWindowsRestrictedTokenCapabilitySidV1,
  createWindowsRestrictedTokenDirectWorkspaceV1,
  createWindowsRestrictedTokenExecutor,
  createWindowsRestrictedTokenInvocationName,
  resolveBunExecutableForWindowsRestrictedTokenV1,
  resolveWindowsRestrictedTokenNetworkModeV1,
  restrictedTokenNetworkUnsupportedReasonV1,
  wrapWindowsRestrictedTokenCommandV1,
} from '@/core/sandbox/windows-restricted-token';
import {
  clearWindowsSandboxRunnerCacheV1,
  resolveInstalledWindowsRunnerManifestLocationV1,
  resolveWindowsSandboxRunnerV1,
} from '@/core/sandbox/windows-runner';

describe('Windows restricted-token invocation protocol', () => {
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
    'runs local commands directly without UAC and gates the managed-network smoke separately',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kite-windows-restricted-token-e2e-'));
      const posixWorkspace = workspace.replace(
        /^([a-zA-Z]):[\\/]/u,
        (_full, drive: string) => `/${drive.toLowerCase()}/`,
      );
      let repairFailure = '';
      try {
        writeFileSync(join(workspace, '.env'), 'ORIGINAL_SECRET\n');
        writeFileSync(
          join(workspace, 'protected-write.js'),
          `const fs = require('node:fs');
try {
  fs.writeFileSync('.env', 'OVERWRITTEN\\n');
  process.exit(2);
} catch {
  console.log('PROTECTED_WRITE_BLOCKED');
}
`,
        );
        const executor = composeAppSandboxExecutorV1({
          entrypoint: 'tui',
          workspace,
          config: { sandbox: { enabled: true } },
        });
        const prepared = await executor.prepare();
        if (
          prepared.mode === 'host_shell' &&
          prepared.reason?.includes('restricted_token_parent_already_restricted')
        ) {
          return;
        }
        expect(prepared).toMatchObject({
          mode: 'sandbox',
          backend: 'windows_restricted_token',
        });
        const normal = await executor({
          workspace,
          command: `printf DIRECT_OK > direct-output.txt; test -f ${posixWorkspace}/direct-output.txt; printf POSIX_PATH_OK:; printf PWD:; pwd; printf :; cat direct-output.txt`,
          timeoutMs: 60_000,
        });
        expect(normal).toMatchObject({
          ok: true,
          exitCode: 0,
          processCleanup: { confirmedExited: true },
        });
        expect(normal.stdout.toLowerCase()).toContain(
          `PWD:${realpathSync.native(workspace)}`.toLowerCase(),
        );
        expect(normal.stdout).toContain('POSIX_PATH_OK');
        expect(normal.stdout).toContain('DIRECT_OK');
        expect(readFileSync(join(workspace, 'direct-output.txt'), 'utf8')).toBe('DIRECT_OK');

        const runtimeSmokes = [
          { command: 'node --version', output: /\d+\.\d+\.\d+/ },
          { command: 'npm --version', output: /\d+\.\d+\.\d+/ },
          { command: 'bun --version', output: /\d+\.\d+\.\d+/ },
          { command: "cmd.exe /d /c 'echo CMD_OK'", output: /CMD_OK/ },
          {
            command:
              "powershell.exe -NoLogo -NoProfile -NonInteractive -Command 'Write-Output POWERSHELL_OK'",
            output: /POWERSHELL_OK/,
          },
        ];
        for (const smoke of runtimeSmokes) {
          const result = await executor({
            workspace,
            command: smoke.command,
            timeoutMs: 60_000,
          });
          expect(result).toMatchObject({
            ok: true,
            exitCode: 0,
            processCleanup: { confirmedExited: true },
          });
          expect(result.stdout).toMatch(smoke.output);
        }

        const protectedWriteBeforeReplace = await executor({
          workspace,
          command: 'node protected-write.js',
          timeoutMs: 15_000,
        });
        expect(protectedWriteBeforeReplace).toMatchObject({ ok: true, exitCode: 0 });
        expect(protectedWriteBeforeReplace.stdout).toContain('PROTECTED_WRITE_BLOCKED');
        expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('ORIGINAL_SECRET\n');

        // Editors commonly save through an atomic replace. The persistent
        // capability ledger must revalidate the replacement object's DACL.
        rmSync(join(workspace, '.env'));
        writeFileSync(join(workspace, '.env'), 'HOST_REPLACED_SECRET\n');
        const protectedWriteAfterReplace = await executor({
          workspace,
          command: 'node protected-write.js',
          timeoutMs: 15_000,
        });
        expect(protectedWriteAfterReplace).toMatchObject({ ok: true, exitCode: 0 });
        expect(protectedWriteAfterReplace.stdout).toContain('PROTECTED_WRITE_BLOCKED');
        expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('HOST_REPLACED_SECRET\n');

        if (process.env.KITE_RUN_WINDOWS_MANAGED_NETWORK_E2E === '1') {
          const approvedNetwork = await runApprovedTool({
            workspace,
            request: {
              id: 'approved-runtime-script',
              name: 'shell_execute',
              args: {
                command:
                  'curl.exe --fail --silent --show-error --connect-timeout 8 --max-time 15 https://example.com/ -o NUL && echo APPROVED_SCHANNEL_OK',
              },
              reason: 'Run an approved Schannel HTTPS smoke test',
              protectedCommand: 'curl.exe',
            } as PendingToolRequest,
            interactionMode: 'accept_edits',
            approvedGrant: 'approve_once',
            shellExecutor: executor,
          });
          expect(approvedNetwork).toMatchObject({ ok: true, exitCode: 0 });
          expect(approvedNetwork.stdout).toContain('APPROVED_SCHANNEL_OK');
          const protectedWrite = await runApprovedTool({
            workspace,
            request: {
              id: 'approved-indirect-protected-write',
              name: 'shell_execute',
              args: { command: 'node protected-write.js && npm --version' },
              reason:
                'Verify managed Online Node/npm execution and indirect sensitive-write protection',
              protectedCommand: 'node',
            } as PendingToolRequest,
            interactionMode: 'accept_edits',
            approvedGrant: 'approve_once',
            shellExecutor: executor,
          });
          expect(protectedWrite).toMatchObject({ ok: true, exitCode: 0 });
          expect(protectedWrite.stdout).toContain('PROTECTED_WRITE_BLOCKED');
          expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('HOST_REPLACED_SECRET\n');
        } else if ((await resolveWindowsManagedNetworkSetupStatusV1()).state === 'missing') {
          const unconfiguredNetwork = await runApprovedTool({
            workspace,
            request: {
              id: 'unconfigured-approved-runtime-script',
              name: 'shell_execute',
              args: { command: 'curl.exe https://www.microsoft.com/ -o NUL' },
              reason: 'Verify missing setup fails without entering the setup control plane',
              protectedCommand: 'curl.exe',
            } as PendingToolRequest,
            interactionMode: 'accept_edits',
            approvedGrant: 'approve_once',
            shellExecutor: executor,
          });
          expect(unconfiguredNetwork.ok).toBe(false);
          expect(unconfiguredNetwork.stderr).toContain('managed_network_setup_required');
        }

        const readOnlyExecutor = createWindowsRestrictedTokenExecutor({
          enabled: true,
          workspace,
          filesystemScope: 'read_only',
        });
        const readOnly = await readOnlyExecutor({
          workspace,
          command: 'printf denied > read-only-output.txt',
          timeoutMs: 15_000,
        });
        expect(readOnly.ok).toBe(false);
        expect(existsSync(join(workspace, 'read-only-output.txt'))).toBe(false);
      } finally {
        const runner = resolveWindowsSandboxRunnerV1();
        try {
          if (runner) {
            const repair = Bun.spawnSync([runner.path, '--repair-restricted-token', workspace], {
              stdout: 'ignore',
              stderr: 'pipe',
            });
            if (repair.exitCode !== 0) {
              repairFailure = `restricted-token test ACL repair failed: ${Buffer.from(
                repair.stderr,
              ).toString('utf8')}`;
            }
          }
        } finally {
          rmSync(workspace, { recursive: true, force: true });
        }
      }
      expect(repairFailure).toBe('');
    },
    360_000,
  );
});
