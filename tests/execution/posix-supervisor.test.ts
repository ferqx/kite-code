import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxBackendCapabilitiesV1 } from '@/core/execution/sandbox-execution';
import type { SandboxPreparationLifecycleV1 } from '@/core/execution/sandbox-execution/consumer';
import {
  executePosixSupervisedV1,
  reconcilePosixSupervisorV1,
  terminatePosixSupervisorV1,
} from '@/core/execution/sandbox-execution/posix-supervisor';
import {
  type PosixSupervisorIdentityV1,
  readComparablePosixProcessStartIdentityV1,
} from '@/core/execution/sandbox-execution/posix-supervisor-identity';
import {
  createPosixSupervisorLockV1,
  type PosixSupervisorLockIdentityV1,
} from '@/core/execution/sandbox-execution/posix-supervisor-lock';
import type { PreparedSandboxExecutionV1 } from '@/protocol/sandbox-execution-provider';
import { compileOssReleaseExecutableV1 } from '../../scripts/release/oss-candidate';

const POSIX = process.platform === 'darwin' || process.platform === 'linux';

describe.skipIf(!POSIX)('POSIX sandbox supervisor', () => {
  test('the actual compiled release CLI embeds the supervisor and inherits only its minimal env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-standalone-'));
    const executable = join(root, 'kite');
    try {
      await compileOssReleaseExecutableV1('scripts/release/entrypoints/cli.ts', executable);
      const prepared = plan(root, [
        '/bin/sh',
        '-c',
        'printf packaged-ok; env | grep -E "^(NODE_OPTIONS|BUN_OPTIONS|OPENAI_API_KEY)=" || true',
      ]);
      let startedIdentity = '';
      const result = await executePosixSupervisedV1({
        shell: { workspace: root, command: 'packaged supervisor probe' },
        prepared,
        lifecycle: lifecycle((identity) => {
          startedIdentity = identity;
        }),
        dispatchId: '12345678-1234-4234-8234-123456789abc',
        supervisorNonce: 'standalone-nonce',
        dispatchIntentDigest: 'sha256:standalone-dispatch',
        timeoutMs: 5_000,
        supervisorExecutablePath: executable,
      });

      const cleanupExpected = process.platform !== 'darwin';
      expect(result.cleanupConfirmed).toBe(cleanupExpected);
      expect(result.outcome.ok).toBe(cleanupExpected);
      expect(result.outcome.stdout).toBe('packaged-ok');
      expect(startedIdentity).toMatch(
        process.platform === 'darwin' ? /^darwin:proc_bsdinfo:/ : /^linux:/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('restore waits for the inherited pre-spawn lock before confirming no-spawn cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-lock-'));
    const lockIdentity: PosixSupervisorLockIdentityV1 = {
      version: 1,
      dispatchId: '22345678-1234-4234-8234-123456789abc',
      supervisorNonce: 'restore-nonce',
      dispatchIntentDigest: 'sha256:restore-dispatch',
    };
    let child: Bun.Subprocess | undefined;
    try {
      const lock = createPosixSupervisorLockV1(root, lockIdentity);
      child = Bun.spawn(['/bin/sleep', '60'], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', lock.fd],
        env: { PATH: '/usr/bin:/bin' },
      });
      lock.close();
      let settled = false;
      const reconciliation = reconcilePosixSupervisorV1({
        runtimePath: root,
        dispatch: {
          attempt: 1,
          readyDigest: 'ready',
          planDigest: 'plan',
          dispatchId: lockIdentity.dispatchId,
          supervisorNonce: lockIdentity.supervisorNonce,
          dispatchIntentDigest: lockIdentity.dispatchIntentDigest,
          status: 'intent_recorded',
          recordedAt: new Date().toISOString(),
        },
        descendantContainmentProven: true,
      }).then((confirmed) => {
        settled = true;
        return confirmed;
      });
      await Bun.sleep(50);
      expect(settled).toBe(false);
      child.kill('SIGKILL');
      await child.exited;
      // Intent-only means GO was never acknowledged, so no descendant exists;
      // the lock release alone is sufficient for this no-spawn branch.
      expect(await reconciliation).toBe(true);
    } finally {
      try {
        child?.kill('SIGKILL');
      } catch {
        // Already exited.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restore after spawn terminates the exact supervised process tree before cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-restore-'));
    const dispatchId = '42345678-1234-4234-8234-123456789abc';
    const supervisorNonce = 'restore-after-spawn-nonce';
    const dispatchIntentDigest = 'sha256:restore-after-spawn-dispatch';
    const descendantPath = join(root, 'descendant.pid');
    let started:
      | {
          readonly supervisorPid: number;
          readonly processGroupId: number;
          readonly processStartIdentity: string;
        }
      | undefined;
    try {
      const execution = executePosixSupervisedV1({
        shell: { workspace: root, command: 'restore-after-spawn probe' },
        prepared: plan(root, [
          '/bin/sh',
          '-c',
          `sleep 60 & descendant=$!; printf '%s' "$descendant" > ${JSON.stringify(descendantPath)}; wait`,
        ]),
        lifecycle: {
          ...lifecycle(() => {}),
          async recordExecutionSupervisorStarted(_prepared, input) {
            started = input;
            return true;
          },
        },
        dispatchId,
        supervisorNonce,
        dispatchIntentDigest,
        timeoutMs: 300,
      });
      await waitForFile(descendantPath);
      if (!started) throw new Error('supervisor start identity was not recorded');
      const descendantPid = Number(readFileSync(descendantPath, 'utf8'));
      expect(() => process.kill(descendantPid, 0)).not.toThrow();

      expect(
        await reconcilePosixSupervisorV1({
          runtimePath: join(root, 'control'),
          dispatch: {
            attempt: 1,
            readyDigest: 'ready',
            planDigest: 'plan',
            dispatchId,
            supervisorNonce,
            dispatchIntentDigest,
            status: 'supervisor_started',
            recordedAt: new Date().toISOString(),
            ...started,
          },
          descendantContainmentProven: process.platform !== 'darwin',
        }),
      ).toBe(process.platform !== 'darwin');
      expect(await waitForPidExit(descendantPid)).toBe(true);
      expect((await execution).cleanupConfirmed).toBe(process.platform !== 'darwin');
    } finally {
      if (started) {
        try {
          process.kill(-started.processGroupId, 'SIGKILL');
        } catch {
          // Reconciliation already removed the process group.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a same-era forged start identity never signals a live process group', async () => {
    const child = Bun.spawn(['/bin/sleep', '60'], {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env: { PATH: '/usr/bin:/bin' },
    });
    try {
      const exact = await waitForIdentity(child.pid);
      const forged = forgeStartIdentity(exact);
      const forgedRecord: PosixSupervisorIdentityV1 = {
        version: 1,
        dispatchId: '32345678-1234-4234-8234-123456789abc',
        supervisorNonce: 'identity-nonce',
        dispatchIntentDigest: 'sha256:identity-dispatch',
        pid: child.pid,
        processGroupId: child.pid,
        processStartIdentity: forged,
      };
      expect(await terminatePosixSupervisorV1(forgedRecord)).toBe(false);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      expect(
        await terminatePosixSupervisorV1({
          ...forgedRecord,
          processStartIdentity: exact,
        }),
      ).toBe(true);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
      await child.exited;
    }
  });

  test.skipIf(process.platform !== 'linux')(
    'a detached session descendant hits the fixed drain deadline and never reports cleanup true',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-detached-'));
      const descendantPath = join(root, 'detached.pid');
      let descendantPid = 0;
      try {
        const startedAt = Date.now();
        const result = await executePosixSupervisedV1({
          shell: { workspace: root, command: 'detached-session-negative' },
          prepared: plan(root, [
            '/bin/sh',
            '-c',
            `setsid /bin/sh -c 'printf %s $$ > ${JSON.stringify(descendantPath)}; sleep 60' & wait`,
          ]),
          lifecycle: lifecycle(() => {}),
          dispatchId: '62345678-1234-4234-8234-123456789abc',
          supervisorNonce: 'detached-negative-nonce',
          dispatchIntentDigest: 'sha256:detached-negative-dispatch',
          timeoutMs: 100,
        });
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(result.cleanupConfirmed).toBe(false);
        expect(result.outcome.processCleanup?.confirmedExited).toBe(false);
        if (existsSync(descendantPath))
          descendantPid = Number(readFileSync(descendantPath, 'utf8'));
      } finally {
        if (descendantPid > 0) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // The detached negative exited independently.
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    'a Darwin detached session descendant never upgrades PGID cleanup to containment',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-darwin-detached-'));
      const descendantPath = join(root, 'detached.pid');
      const readyPath = join(root, 'detached.ready');
      const stopPath = join(root, 'detached.stop');
      const fixturePath = join(root, 'detached-fixture.py');
      const dispatchId = '72345678-1234-4234-8234-123456789abc';
      const supervisorNonce = 'darwin-detached-negative-nonce';
      const dispatchIntentDigest = 'sha256:darwin-detached-negative-dispatch';
      let descendantPid = 0;
      let descendantIdentity: string | undefined;
      let supervisorIdentity: PosixSupervisorIdentityV1 | undefined;
      const abort = new AbortController();
      let execution: Promise<Awaited<ReturnType<typeof executePosixSupervisedV1>>> | undefined;
      try {
        writeFileSync(
          fixturePath,
          [
            'import os, sys, time',
            'pid_path, ready_path, stop_path = sys.argv[1:4]',
            'owner = os.fork()',
            'if owner == 0:',
            '    os.setsid()',
            '    child = os.fork()',
            '    if child == 0:',
            '        while not os.path.exists(stop_path):',
            '            time.sleep(0.05)',
            '        os._exit(0)',
            '    with open(pid_path, "w") as stream:',
            '        stream.write(str(child))',
            '    with open(ready_path, "w") as stream:',
            '        stream.write("ready")',
            '    os.waitpid(child, 0)',
            '    os._exit(0)',
            'os.waitpid(owner, 0)',
          ].join('\n'),
          { mode: 0o700 },
        );
        execution = executePosixSupervisedV1({
          shell: {
            workspace: root,
            command: 'darwin-detached-session-negative',
            signal: abort.signal,
          },
          prepared: plan(root, [
            '/bin/sh',
            '-c',
            `/usr/bin/python3 ${JSON.stringify(fixturePath)} ${JSON.stringify(descendantPath)} ${JSON.stringify(readyPath)} ${JSON.stringify(stopPath)} & wait`,
          ]),
          lifecycle: {
            ...lifecycle(() => {}),
            async recordExecutionSupervisorStarted(_prepared, input) {
              supervisorIdentity = {
                version: 1,
                dispatchId,
                supervisorNonce,
                dispatchIntentDigest,
                pid: input.supervisorPid,
                processGroupId: input.processGroupId,
                processStartIdentity: input.processStartIdentity,
              };
              return true;
            },
          },
          dispatchId,
          supervisorNonce,
          dispatchIntentDigest,
          timeoutMs: 10_000,
        });
        await waitForFile(readyPath);
        descendantPid = Number(readFileSync(descendantPath, 'utf8'));
        descendantIdentity = await waitForIdentity(descendantPid);
        abort.abort();
        const result = await execution;
        expect(result.cleanupConfirmed).toBe(false);
        expect(result.outcome.processCleanup?.confirmedExited).toBe(false);
        expect(readComparablePosixProcessStartIdentityV1(descendantPid)).toBe(descendantIdentity);
      } finally {
        abort.abort();
        await execution?.catch(() => undefined);
        if (descendantPid === 0) {
          try {
            await waitForFile(readyPath);
            descendantPid = Number(readFileSync(descendantPath, 'utf8'));
            descendantIdentity = await waitForIdentity(descendantPid);
          } catch {
            // The supervisor may have exited before the detached fixture published.
          }
        }
        writeFileSync(stopPath, 'stop');
        if (descendantPid > 0) {
          try {
            if (
              descendantIdentity &&
              readComparablePosixProcessStartIdentityV1(descendantPid) === descendantIdentity
            ) {
              process.kill(descendantPid, 'SIGKILL');
            }
          } catch {
            // The detached negative may have exited independently.
          }
          expect(await waitForPidExit(descendantPid)).toBe(true);
        }
        if (supervisorIdentity) await terminatePosixSupervisorV1(supervisorIdentity);
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

function plan(runtimePath: string, argv: readonly string[]): PreparedSandboxExecutionV1 {
  const controlRoot = join(runtimePath, 'control');
  const dataRoot = join(runtimePath, 'data');
  mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  return {
    schema: 'kite.sandbox-execution-provider.v1',
    kind: 'prepared_sandbox_execution',
    planId: 'standalone-plan',
    toolCallId: 'tool-call',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'revision',
    invocationId: 'invocation',
    attempt: 1,
    canonicalWorkspace: runtimePath,
    effectiveEffectsDigest: 'effects',
    admissionDigest: 'admission',
    preparationDigest: 'preparation',
    commandDigest: 'command',
    approvedArgv: argv,
    argv,
    cwd: runtimePath,
    env: null,
    stdin: null,
    transport: 'stdio',
    backend: process.platform === 'linux' ? 'bubblewrap' : 'seatbelt',
    backendCapabilities: sandboxBackendCapabilitiesV1(
      process.platform === 'linux' ? 'bubblewrap' : 'seatbelt',
    ),
    enforcement: 'partial',
    resourceSemantics: 'allocating',
    expiresAtMs: Date.now() + 60_000,
    cleanup: {
      kind: 'runtime_directory',
      resourceId: 'standalone-runtime',
      recoveryPayload: { controlRoot, dataRoot },
    },
  };
}

function lifecycle(onStarted: (identity: string) => void): SandboxPreparationLifecycleV1 {
  return {
    async recordPreparationIntent() {
      throw new Error('not used');
    },
    async recordPreparationReady() {
      throw new Error('not used');
    },
    async recordExecutionDispatchIntent() {
      throw new Error('not used');
    },
    async recordExecutionSupervisorStarted(_prepared, input) {
      onStarted(input.processStartIdentity);
      return true;
    },
    async recordDisposalIntent() {
      return {
        purpose: 'dispose' as const,
        lifecycleIntentDigest: 'test-disposal',
        cleanupAttempt: 1,
      };
    },
    async recordDisposalReceipt() {
      return true;
    },
  };
}

async function waitForIdentity(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const identity = readComparablePosixProcessStartIdentityV1(pid);
    if (identity) return identity;
    await Bun.sleep(10);
  }
  throw new Error('process identity was not observable');
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error('supervised descendant did not start');
}

async function waitForPidExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}

function forgeStartIdentity(identity: string): string {
  const parts = identity.split(':');
  const index = identity.startsWith('darwin:proc_bsdinfo:') ? 3 : 2;
  parts[index] = String(BigInt(parts[index]!) + 1n);
  return parts.join(':');
}
