import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectApprovedProxyEnvironmentV1 } from '@kite/builtin-runtime/sandbox';
import type { RuntimeHostSandboxPreparationLifecycleV1 } from '@kite/runtime-host';
import {
  type AuthorityKeyV1,
  buildPosixSupervisorEnvironmentV1,
  createPosixSupervisorLockV1,
  executePosixSupervisedV1,
  type PosixSupervisorIdentityV1,
  type PosixSupervisorLockIdentityV1,
  readComparablePosixProcessStartIdentityV1,
  reconcilePosixSupervisorV1,
  terminatePosixSupervisorV1,
} from '@kite/runtime-host';
import type { PreparedSandboxExecutionV1, SandboxPreparationLifecycleV1 } from '@kite/runtime-spi';
import { sandboxBackendCapabilitiesV1 } from '#app/sandbox/runtime-execution';
import { compileOssReleaseExecutableV1 } from '../../scripts/release/oss-candidate';

const POSIX = process.platform === 'darwin' || process.platform === 'linux';
const TEST_AUTHORITY_FRAME_KEY_V1: AuthorityKeyV1 = Object.freeze({
  keyId: 'test:posix-supervisor',
  key: new Uint8Array(32).fill(7),
});

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
        prepared,
        lifecycle: supervisorLifecycle(
          spiLifecycle((identity) => {
            startedIdentity = identity;
          }),
        ),
        dispatchId: '12345678-1234-4234-8234-123456789abc',
        supervisorNonce: 'standalone-nonce',
        dispatchIntentDigest: 'sha256:standalone-dispatch',
        authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
        timeoutMs: 5_000,
        supervisorExecutablePath: executable,
      });

      const cleanupExpected = process.platform !== 'darwin';
      expect(result.cleanupConfirmed).toBe(cleanupExpected);
      expect(result.outcome.exitCode === 0 && result.cleanupConfirmed).toBe(cleanupExpected);
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
        prepared: plan(root, [
          '/bin/sh',
          '-c',
          `sleep 60 & descendant=$!; printf '%s' "$descendant" > ${JSON.stringify(descendantPath)}; wait`,
        ]),
        lifecycle: {
          ...supervisorLifecycle(spiLifecycle(() => {})),
          async recordExecutionSupervisorStarted(_prepared, input) {
            started = input;
            return true;
          },
        },
        dispatchId,
        supervisorNonce,
        dispatchIntentDigest,
        authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
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

  test('generic ephemeral environment rejects fixed process authority overrides', () => {
    const fixedKeys = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] as const;
    for (const key of fixedKeys) {
      expect(() =>
        buildPosixSupervisorEnvironmentV1(
          '/tmp/runtime-host-overlay-test',
          Object.freeze({ [key]: 'forged' }),
        ),
      ).toThrow(`cannot override '${key}'`);
    }
    expect(() =>
      buildPosixSupervisorEnvironmentV1('/tmp/runtime-host-overlay-test', {
        HTTP_PROXY: 'http://proxy.example.test:8080',
      }),
    ).toThrow('must be a frozen object');
    expect(
      buildPosixSupervisorEnvironmentV1(
        '/tmp/runtime-host-overlay-test',
        Object.freeze({ HTTP_PROXY: 'http://proxy.example.test:8080' }),
      ),
    ).toMatchObject({ HTTP_PROXY: 'http://proxy.example.test:8080' });
  });

  test('supervisor start acknowledgement failure sends no prepared process command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-no-go-'));
    const marker = join(root, 'started.marker');
    try {
      const result = await executePosixSupervisedV1({
        prepared: plan(root, ['/bin/sh', '-c', `printf started > ${JSON.stringify(marker)}`]),
        lifecycle: {
          ...supervisorLifecycle(spiLifecycle(() => {})),
          async recordExecutionSupervisorStarted() {
            return false;
          },
        },
        dispatchId: '82345678-1234-4234-8234-123456789abc',
        supervisorNonce: 'no-go-nonce',
        dispatchIntentDigest: 'sha256:no-go-dispatch',
        authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
        timeoutMs: 5_000,
      });
      expect(existsSync(marker)).toBe(false);
      expect(result.outcome.exitCode).toBe(-1);
      expect(result.outcome.processCleanup?.confirmedExited).toBe(result.cleanupConfirmed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ephemeral overlay reaches the actual child while disabled execution sees no proxy', async () => {
    const run = async (label: string, overlay: Readonly<Record<string, string>>) => {
      const root = mkdtempSync(join(tmpdir(), `kite-supervisor-overlay-${label}-`));
      try {
        return await executePosixSupervisedV1({
          prepared: plan(root, [
            '/bin/sh',
            '-c',
            `printf '%s|%s' "\${HTTP_PROXY-}" "\${NO_PROXY-}"`,
          ]),
          lifecycle: supervisorLifecycle(spiLifecycle(() => {})),
          dispatchId: `${label === 'approved' ? '92345678' : 'a2345678'}-1234-4234-8234-123456789abc`,
          supervisorNonce: `${label}-overlay-nonce`,
          dispatchIntentDigest: `sha256:${label}-overlay-dispatch`,
          authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
          timeoutMs: 5_000,
          ephemeralEnvironment: overlay,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    const proxySource = {
      HTTP_PROXY: 'http://proxy.example.test:8080',
      NO_PROXY: 'localhost,127.0.0.1',
    };
    const approved = await run(
      'approved',
      projectApprovedProxyEnvironmentV1({ networkMode: 'allow_all', source: proxySource }),
    );
    const disabled = await run(
      'disabled',
      projectApprovedProxyEnvironmentV1({ networkMode: 'disabled', source: proxySource }),
    );
    expect(approved.outcome.stdout).toBe('http://proxy.example.test:8080|localhost,127.0.0.1');
    expect(disabled.outcome.stdout).toBe('|');
  });

  test('prepared/ephemeral environment conflicts fail before spawn or GO', async () => {
    const cases = [
      {
        label: 'fixed',
        overlay: Object.freeze({ PATH: '/forged' }),
        preparedEnvironment: null,
      },
      {
        label: 'invalid',
        overlay: Object.freeze({ 'bad-key': 'forged' }) as Readonly<Record<string, string>>,
        preparedEnvironment: null,
      },
      {
        label: 'mutable',
        overlay: { HTTP_PROXY: 'mutable' } as Readonly<Record<string, string>>,
        preparedEnvironment: null,
      },
      {
        label: 'conflict',
        overlay: Object.freeze({ HTTP_PROXY: 'overlay' }),
        preparedEnvironment: Object.freeze({ HTTP_PROXY: 'prepared' }),
      },
    ] as const;
    for (const testCase of cases) {
      const root = mkdtempSync(
        join(tmpdir(), `kite-supervisor-overlay-negative-${testCase.label}-`),
      );
      const marker = join(root, 'started.marker');
      try {
        const result = await executePosixSupervisedV1({
          prepared: plan(
            root,
            ['/bin/sh', '-c', `printf started > ${JSON.stringify(marker)}`],
            testCase.preparedEnvironment,
          ),
          lifecycle: supervisorLifecycle(spiLifecycle(() => {})),
          dispatchId: `${testCase.label === 'fixed' ? 'b2345678' : testCase.label === 'invalid' ? 'c2345678' : testCase.label === 'mutable' ? 'd2345678' : 'e2345678'}-1234-4234-8234-123456789abc`,
          supervisorNonce: `${testCase.label}-overlay-negative-nonce`,
          dispatchIntentDigest: `sha256:${testCase.label}-overlay-negative-dispatch`,
          authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
          timeoutMs: 5_000,
          ephemeralEnvironment: testCase.overlay,
        });
        expect(existsSync(marker)).toBe(false);
        expect(result.outcome.exitCode).toBe(-1);
        expect(result.cleanupConfirmed).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('non-frozen prepared plan or nested authority fails before spawn or GO', async () => {
    const cases = [
      {
        label: 'top-level',
        prepare: (base: PreparedSandboxExecutionV1) => ({ ...base }),
      },
      {
        label: 'argv',
        prepare: (base: PreparedSandboxExecutionV1) =>
          Object.freeze({ ...base, argv: [...base.argv] }),
      },
      {
        label: 'approved-argv',
        prepare: (base: PreparedSandboxExecutionV1) =>
          Object.freeze({ ...base, approvedArgv: [...base.approvedArgv] }),
      },
      {
        label: 'environment',
        prepare: (base: PreparedSandboxExecutionV1) =>
          Object.freeze({ ...base, env: { HTTP_PROXY: 'prepared' } }),
      },
      {
        label: 'backend-capabilities',
        prepare: (base: PreparedSandboxExecutionV1) =>
          Object.freeze({
            ...base,
            backendCapabilities: {
              ...base.backendCapabilities,
              filesystem: { ...base.backendCapabilities.filesystem },
            },
          }),
      },
      {
        label: 'backend-network',
        prepare: (base: PreparedSandboxExecutionV1) =>
          Object.freeze({
            ...base,
            backendCapabilities: {
              ...base.backendCapabilities,
              network: { ...base.backendCapabilities.network },
            },
          }),
      },
      {
        label: 'cleanup',
        prepare: (base: PreparedSandboxExecutionV1) =>
          Object.freeze({ ...base, cleanup: { ...base.cleanup } }),
      },
      {
        label: 'recovery-payload',
        prepare: (base: PreparedSandboxExecutionV1) =>
          Object.freeze({
            ...base,
            cleanup: Object.freeze({
              ...base.cleanup,
              recoveryPayload: { ...base.cleanup.recoveryPayload },
            }),
          }),
      },
    ] as const;
    for (const [index, testCase] of cases.entries()) {
      const root = mkdtempSync(join(tmpdir(), `kite-supervisor-plan-negative-${testCase.label}-`));
      const marker = join(root, 'started.marker');
      try {
        const prepared = testCase.prepare(
          plan(root, ['/bin/sh', '-c', `printf started > ${JSON.stringify(marker)}`]),
        );
        const result = await executePosixSupervisedV1({
          prepared,
          lifecycle: supervisorLifecycle(spiLifecycle(() => {})),
          dispatchId: `${String(index + 1).padStart(8, '0')}-1234-4234-8234-123456789abc`,
          supervisorNonce: `${testCase.label}-plan-negative-nonce`,
          dispatchIntentDigest: `sha256:${testCase.label}-plan-negative-dispatch`,
          authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
          timeoutMs: 5_000,
        });
        expect(existsSync(marker)).toBe(false);
        expect(result.outcome.exitCode).toBe(-1);
        expect(result.cleanupConfirmed).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('prepared identity stays stable when the caller wrapper changes after acknowledgement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-prepared-identity-'));
    const marker = join(root, 'started.marker');
    let current = plan(root, ['/bin/sh', '-c', `printf stable > ${JSON.stringify(marker)}`]);
    const forged = Object.freeze({
      ...current,
      approvedArgv: Object.freeze(['/bin/sh', '-c', `printf forged > ${JSON.stringify(marker)}`]),
      argv: Object.freeze(['/bin/sh', '-c', `printf forged > ${JSON.stringify(marker)}`]),
    });
    try {
      await executePosixSupervisedV1({
        get prepared() {
          return current;
        },
        lifecycle: {
          ...supervisorLifecycle(spiLifecycle(() => {})),
          async recordExecutionSupervisorStarted() {
            current = forged;
            return true;
          },
        },
        dispatchId: '42345678-1234-4234-8234-123456789abc',
        supervisorNonce: 'prepared-identity-nonce',
        dispatchIntentDigest: 'sha256:prepared-identity-dispatch',
        authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
        timeoutMs: 5_000,
      });
      expect(readFileSync(marker, 'utf8')).toBe('stable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Host supervision source has no Shell DTO or raw command authority', () => {
    const source = readFileSync(
      new URL('../../packages/runtime-host/src/posix-supervisor.ts', import.meta.url),
      'utf8',
    );
    const retiredHostShellName = ['RuntimeHost', 'Shell', 'Supervision'].join('');
    expect(source).not.toContain(retiredHostShellName);
    expect(source).not.toMatch(/input\.shell|readonly command/);
    expect(source).not.toContain('networkMode');
    expect(source).not.toContain('HTTP_PROXY');
  });

  test.each([
    [
      'truncated authority key',
      { key: { ...TEST_AUTHORITY_FRAME_KEY_V1, key: new Uint8Array(0) } },
    ],
    ['zero dispatch identity', { dispatchId: '' }],
  ] as readonly [
    string,
    { readonly key?: AuthorityKeyV1; readonly dispatchId?: string },
  ][])('fails closed before spawning on %s', async (_label, override) => {
    const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-invalid-bootstrap-'));
    try {
      const result = await executePosixSupervisedV1({
        prepared: plan(root, ['/bin/true']),
        lifecycle: supervisorLifecycle(spiLifecycle(() => {})),
        dispatchId: override.dispatchId ?? 'e2345678-1234-4234-8234-123456789abc',
        supervisorNonce: 'invalid-bootstrap-nonce',
        dispatchIntentDigest: 'sha256:invalid-bootstrap-dispatch',
        authorityFrameKey: override.key ?? TEST_AUTHORITY_FRAME_KEY_V1,
        timeoutMs: 1_000,
      });
      expect(result.outcome.exitCode).toBe(-1);
      expect(result.cleanupConfirmed).toBe(true);
      expect(result.outcome.stderr).toMatch(/unavailable|invalid/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['tampered authenticator', 'tamper'],
    ['wrong peer', 'wrong-peer'],
    ['unknown field', 'unknown-field'],
    ['replayed sequence', 'replay'],
    ['wrong derived key', 'wrong-derived-key'],
  ] as const)(
    'rejects a forged %s frame before reporting success',
    async (_label, mode) => {
      const root = mkdtempSync(join(tmpdir(), `kite-supervisor-frame-${mode}-`));
      const script = writeForgedSupervisorScript(root, mode);
      try {
        const result = await executePosixSupervisedV1({
          prepared: plan(root, ['/bin/true']),
          lifecycle: supervisorLifecycle(spiLifecycle(() => {})),
          dispatchId: 'f2345678-1234-4234-8234-123456789abc',
          supervisorNonce: `frame-${mode}-nonce`,
          dispatchIntentDigest: `sha256:frame-${mode}-dispatch`,
          authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
          timeoutMs: 5_000,
          supervisorExecutablePath: script,
        });
        expect(result.outcome.exitCode).toBe(-1);
        expect(result.outcome.stdout).toBe('');
        expect(result.outcome.stderr.toLowerCase()).toContain(
          mode === 'tamper'
            ? 'authenticator'
            : mode === 'wrong-peer'
              ? 'identity'
              : mode === 'unknown-field'
                ? 'identity'
                : mode === 'replay'
                  ? 'replay'
                  : 'authenticator',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(process.platform !== 'linux')(
    'a detached session descendant hits the fixed drain deadline and never reports cleanup true',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-supervisor-detached-'));
      const descendantPath = join(root, 'detached.pid');
      let descendantPid = 0;
      try {
        const startedAt = Date.now();
        const result = await executePosixSupervisedV1({
          prepared: plan(root, [
            '/bin/sh',
            '-c',
            `setsid /bin/sh -c 'printf %s $$ > ${JSON.stringify(descendantPath)}; sleep 60' & wait`,
          ]),
          lifecycle: supervisorLifecycle(spiLifecycle(() => {})),
          dispatchId: '62345678-1234-4234-8234-123456789abc',
          supervisorNonce: 'detached-negative-nonce',
          dispatchIntentDigest: 'sha256:detached-negative-dispatch',
          authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
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
          signal: abort.signal,
          prepared: plan(root, [
            '/bin/sh',
            '-c',
            `/usr/bin/python3 ${JSON.stringify(fixturePath)} ${JSON.stringify(descendantPath)} ${JSON.stringify(readyPath)} ${JSON.stringify(stopPath)} & wait`,
          ]),
          lifecycle: {
            ...supervisorLifecycle(spiLifecycle(() => {})),
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
          authorityFrameKey: TEST_AUTHORITY_FRAME_KEY_V1,
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

function plan(
  runtimePath: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>> | null = null,
): PreparedSandboxExecutionV1 {
  const controlRoot = join(runtimePath, 'control');
  const dataRoot = join(runtimePath, 'data');
  mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const backendCapabilities = sandboxBackendCapabilitiesV1(
    process.platform === 'linux' ? 'bubblewrap' : 'seatbelt',
  );
  return Object.freeze({
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
    approvedArgv: Object.freeze([...argv]),
    argv: Object.freeze([...argv]),
    cwd: runtimePath,
    env: env === null ? null : Object.freeze({ ...env }),
    stdin: null,
    transport: 'stdio',
    backend: process.platform === 'linux' ? 'bubblewrap' : 'seatbelt',
    backendCapabilities: Object.freeze({
      ...backendCapabilities,
      filesystem: Object.freeze({ ...backendCapabilities.filesystem }),
      network: Object.freeze({ ...backendCapabilities.network }),
    }),
    enforcement: 'partial',
    resourceSemantics: 'allocating',
    expiresAtMs: Date.now() + 60_000,
    cleanup: Object.freeze({
      kind: 'runtime_directory',
      resourceId: 'standalone-runtime',
      recoveryPayload: Object.freeze({ controlRoot, dataRoot }),
    }),
  });
}

function writeForgedSupervisorScript(
  root: string,
  mode: 'tamper' | 'wrong-peer' | 'unknown-field' | 'replay' | 'wrong-derived-key',
): string {
  const target = join(root, 'forged-supervisor.ts');
  const identityModule = new URL(
    '../../packages/runtime-host/src/posix-supervisor-identity.ts',
    import.meta.url,
  ).pathname;
  const source = `#!${process.execPath}
import { createHmac } from 'node:crypto';
import { closeSync, readSync } from 'node:fs';
import { connect } from 'node:net';
import {
  readComparablePosixProcessStartIdentityV1,
  writePosixSupervisorIdentityV1,
} from '${identityModule}';

const mode = '${mode}';
const marker = '--kite-internal-posix-supervisor-v1';
const start = process.argv.indexOf(marker);
const args = process.argv.slice(start + 1);
const socketPath = args[0];
const identityPath = args[1];
const dispatchId = args[4];
const supervisorNonce = args[5];
const dispatchIntentDigest = args[6];
const keyBytes = Buffer.alloc(4096);
let keyLength = 0;
while (true) {
  const count = readSync(4, keyBytes, keyLength, keyBytes.length - keyLength, null);
  if (count === 0) break;
  keyLength += count;
  if (keyLength === keyBytes.length) process.exit(125);
}
closeSync(4);
if (keyLength < 11 || keyBytes.subarray(0, 8).toString('ascii') !== 'KITEAFK1' || keyBytes[8] !== 1) process.exit(125);
const keyIdLength = keyBytes.readUInt16BE(9);
const keyStart = 11;
const keyEnd = keyStart + keyIdLength;
if (keyIdLength < 1 || keyEnd + 32 !== keyLength) process.exit(125);
const keyId = keyBytes.subarray(keyStart, keyEnd).toString('utf8');
if (!keyId || Buffer.from(keyId, 'utf8').compare(keyBytes.subarray(keyStart, keyEnd)) !== 0) process.exit(125);
let key = Buffer.from(keyBytes.subarray(keyEnd, keyEnd + 32));
keyBytes.fill(0);
const canonical = (value) => JSON.stringify(sort(value));
const sort = (value) => Array.isArray(value)
  ? value.map(sort)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]))
    : value;
const wire = (peerId, sequence, payload, extra) => {
  const unsigned = {
    schema: 'kite.runtime-authority-frame.v1',
    domain: 'sandbox-posix-v1',
    peerId,
    invocationId: dispatchId,
    sequence,
    payload,
  };
  const authenticator = 'hmac-sha256:' + createHmac('sha256', key)
    .update('kite-runtime-authority-v1:frame\\0')
    .update(canonical(unsigned))
    .digest('hex');
  return JSON.stringify({ ...unsigned, authenticator, ...(extra ?? {}) }) + '\\n';
};
const ready = {
  type: 'ready',
  dispatchId,
  supervisorNonce,
  dispatchIntentDigest,
  pid: process.pid,
  processGroupId: process.pid,
  processStartIdentity: readComparablePosixProcessStartIdentityV1(process.pid),
};
const socket = connect(socketPath, () => {
  if (mode === 'unknown-field') {
    socket.write(wire('posix-supervisor-child', 0, ready, { extraField: true }));
    return;
  }
  if (mode === 'wrong-peer') {
    socket.write(wire('forged-peer', 0, ready));
    return;
  }
  writePosixSupervisorIdentityV1(identityPath, {
    version: 1,
    dispatchId,
    supervisorNonce,
    dispatchIntentDigest,
    pid: process.pid,
    processGroupId: process.pid,
    processStartIdentity: ready.processStartIdentity,
  });
  if (mode === 'tamper') {
    const frame = JSON.parse(wire('posix-supervisor-child', 0, ready));
    frame.authenticator = frame.authenticator.slice(0, -1) + (frame.authenticator.endsWith('0') ? '1' : '0');
    socket.write(JSON.stringify(frame) + '\\n');
    return;
  }
  if (mode === 'wrong-derived-key') {
    key = Buffer.from(key);
    key[0] ^= 1;
    socket.write(wire('posix-supervisor-child', 0, ready));
    return;
  }
  socket.write(wire('posix-supervisor-child', 0, ready));
  socket.on('data', () => {
    if (mode === 'replay') socket.write(wire('posix-supervisor-child', 0, ready));
  });
});
socket.on('error', () => process.exit(125));
`;
  writeFileSync(target, source, { mode: 0o700 });
  return target;
}

function spiLifecycle(onStarted: (identity: string) => void): SandboxPreparationLifecycleV1 {
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
      return Object.freeze({
        acknowledged: true as const,
        stage: 'execution_supervisor_started' as const,
        dispatchId: input.dispatchId,
        dispatchIntentDigest: input.dispatchIntentDigest,
        supervisorPid: input.supervisorPid,
        processGroupId: input.processGroupId,
        processStartIdentity: input.processStartIdentity,
      });
    },
    async recordDisposalIntent() {
      return Object.freeze({
        acknowledged: true as const,
        stage: 'disposal_intent' as const,
        purpose: 'dispose' as const,
        lifecycleIntentDigest: 'test-disposal',
        cleanupAttempt: 1,
      });
    },
    async recordDisposalReceipt(input) {
      return Object.freeze({
        acknowledged: true as const,
        stage: 'disposal_receipt' as const,
        purpose: input.purpose,
        lifecycleIntentDigest: input.lifecycleIntentDigest,
        cleanupAttempt: input.cleanupAttempt,
        disposed: input.disposed,
      });
    },
  };
}

function supervisorLifecycle(
  lifecycle: SandboxPreparationLifecycleV1,
): RuntimeHostSandboxPreparationLifecycleV1 {
  return {
    recordExecutionSupervisorStarted: async (prepared, input) => {
      const acknowledgement = await lifecycle.recordExecutionSupervisorStarted(prepared, input);
      return (
        acknowledgement.acknowledged === true &&
        acknowledgement.stage === 'execution_supervisor_started' &&
        acknowledgement.dispatchId === input.dispatchId &&
        acknowledgement.dispatchIntentDigest === input.dispatchIntentDigest &&
        acknowledgement.supervisorPid === input.supervisorPid &&
        acknowledgement.processGroupId === input.processGroupId &&
        acknowledgement.processStartIdentity === input.processStartIdentity
      );
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
