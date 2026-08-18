import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LINUX_CGROUP_DESCENDANT_CLEANUP_ARTIFACT_CLASS_V1,
  LINUX_CGROUP_DESCENDANT_CLEANUP_SCHEMA_V1,
  type LinuxCgroupCleanupChildV1,
  type LinuxCgroupCleanupCommandResultV1,
  type LinuxCgroupCleanupHostV1,
  runLinuxCgroupDescendantCleanupV1,
  writeLinuxCgroupDescendantCleanupArtifactV1,
} from '../../scripts/evals/linux-cgroup-descendant-cleanup';
import { parseCanonicalJson } from '../../scripts/release/canonical-json';

const IDENTITY = '12345678-1234-4234-8234-123456789abc';
const UNIT = `kite-sandbox-${IDENTITY}.scope`;
const CGROUP_PATH = `/user.slice/user-1000.slice/${UNIT}`;
const CGROUP_DIR = `/sys/fs/cgroup${CGROUP_PATH}`;

describe('Linux cgroup descendant cleanup candidate eval', () => {
  test('does not allocate anything without explicit native opt-in', async () => {
    let calls = 0;
    const host = fakeHost({
      onCall: () => {
        calls += 1;
      },
    });
    const result = await runLinuxCgroupDescendantCleanupV1({ host });
    expect(result).toMatchObject({
      schema: LINUX_CGROUP_DESCENDANT_CLEANUP_SCHEMA_V1,
      artifactClass: LINUX_CGROUP_DESCENDANT_CLEANUP_ARTIFACT_CLASS_V1,
      status: 'unavailable',
      reason: 'native_opt_in_required',
      nativeOptIn: false,
      productionEvidence: false,
      productionSupported: false,
    });
    expect(calls).toBe(0);
  });

  test('returns structured unavailable on non-Linux before probing binaries', async () => {
    let calls = 0;
    const host = fakeHost({
      platform: 'darwin',
      onCall: () => {
        calls += 1;
      },
    });
    const result = await runLinuxCgroupDescendantCleanupV1({ host, nativeOptIn: true });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'non_linux' });
    expect(calls).toBe(0);
  });

  test.each([
    ['cgroup_v2_unavailable', { controllersPath: false }],
    ['cgroup_pids_controller_unavailable', { controllers: 'cpu memory\n' }],
    ['systemd_run_unavailable', { runner: null }],
    ['systemctl_unavailable', { systemctl: null }],
    ['user_systemd_unavailable', { userSystemd: false }],
  ] as const)('returns structured unavailable for missing %s', async (reason, overrides) => {
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost(overrides),
      nativeOptIn: true,
      identity: IDENTITY,
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(reason);
  });

  test('does not pass when the wrapper wait rejects even if ready data exists', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({ childWaitRejects: true, hostState }),
      nativeOptIn: true,
      identity: IDENTITY,
      pollIntervalMs: 1,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'scope_disposal_unconfirmed',
    });
    expect(hostState.stopRequested).toBe(true);
  });

  test('passes only after exact unit/control-group, TasksMax, fork EAGAIN, ownership, kill-all and empty proof', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const host = fakeHost({ hostState });
    const result = await runLinuxCgroupDescendantCleanupV1({
      host,
      nativeOptIn: true,
      identity: IDENTITY,
      maxTasks: 16,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({
      status: 'passed',
      reason: 'none',
      checks: {
        exactRuntimeOwnedUnit: true,
        controlGroupExact: true,
        tasksMax: true,
        forkEagain: true,
        descendantOwnership: true,
        exactKillAll: true,
        populatedZeroBeforePathDisappearance: true,
        emptyCgroupProcsBeforePathDisappearance: true,
      },
    });
    expect(hostState.killInvoked).toBe(true);
    expect(hostState.stopRequested).toBe(false);
    expect(hostState.spawnedArgv).toEqual([
      '/usr/bin/systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--slice-inherit',
      '--expand-environment=no',
      '--property=TasksAccounting=yes',
      '--property=TasksMax=16',
      `--unit=${UNIT}`,
      '--',
      '/usr/bin/python3',
      '/fake/kite-cgroup-eval/fixture.py',
      '/fake/kite-cgroup-eval/ready.json',
      '/fake/kite-cgroup-eval/go',
      '/fake/kite-cgroup-eval/stop',
      '16',
    ]);
    expect(JSON.stringify(result)).not.toContain('/sys/fs/cgroup');
    expect(JSON.stringify(result)).not.toContain('12345678');
  });

  test('classifies a ControlGroup/unit mismatch as unsupported while cleaning the generated exact unit', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({
        hostState,
        controlGroup: '/user.slice/user-1000.slice/other.scope',
      }),
      nativeOptIn: true,
      identity: IDENTITY,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({ status: 'unsupported', reason: 'scope_identity_mismatch' });
    expect(hostState.killInvoked).toBe(true);
    expect(hostState.stopRequested).toBe(true);
  });

  test('classifies disappearance before populated=0 and empty cgroup.procs as unsupported', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({ hostState, disappearOnKill: true }),
      nativeOptIn: true,
      identity: IDENTITY,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'scope_disappeared_before_empty',
      checks: { exactKillAll: true },
    });
    expect(hostState.stopRequested).toBe(true);
  });

  test('classifies TasksMax/fork failure as unsupported', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({
        hostState,
        pidsMax: '8',
        fixturePidsMax: '8',
        forkEagain: false,
      }),
      nativeOptIn: true,
      identity: IDENTITY,
      maxTasks: 16,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({ status: 'unsupported', reason: 'tasks_max_failed' });
    expect(hostState.killInvoked).toBe(true);
    expect(hostState.stopRequested).toBe(true);
  });

  test('classifies detached descendant ownership failure as unsupported', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({
        hostState,
        descendantCgroupPath: '/user.slice/escaped.scope',
      }),
      nativeOptIn: true,
      identity: IDENTITY,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'descendant_ownership_failed',
    });
    expect(hostState.killInvoked).toBe(true);
    expect(hostState.stopRequested).toBe(true);
  });

  test('rejects a session leader that does not prove the second fork', async () => {
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({ descendantSessionId: 4243 }),
      nativeOptIn: true,
      identity: IDENTITY,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'descendant_ownership_failed',
    });
  });

  test('does not pass when the exact wrapper cannot be observed exited', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({ childSettles: false, hostState }),
      nativeOptIn: true,
      identity: IDENTITY,
      pollIntervalMs: 1,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'scope_disposal_unconfirmed',
    });
    expect(hostState.stopRequested).toBe(true);
  });

  test('does not escape or pass when child kill throws during failed disposal', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({ childSettles: false, childKillThrows: true, hostState }),
      nativeOptIn: true,
      identity: IDENTITY,
      pollIntervalMs: 1,
      timeoutMs: 20,
    });
    expect(result.status).toBe('unsupported');
    expect(hostState.stopRequested).toBe(true);
  });

  test('classifies exact kill-all failure as unsupported', async () => {
    const hostState = {
      killInvoked: false,
      stopRequested: false,
      spawnedArgv: [] as readonly string[],
    };
    const result = await runLinuxCgroupDescendantCleanupV1({
      host: fakeHost({ killExitCode: 1, hostState }),
      nativeOptIn: true,
      identity: IDENTITY,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({ status: 'unsupported', reason: 'kill_all_failed' });
    expect(hostState.stopRequested).toBe(true);
  });

  test('writes canonical owner-only candidate artifact without production evidence fields', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-cgroup-eval-artifact-'));
    const output = join(directory, 'candidate.json');
    const result = await runLinuxCgroupDescendantCleanupV1({ host: fakeHost() });
    writeLinuxCgroupDescendantCleanupArtifactV1(output, result);
    const bytes = readFileSync(output);
    expect(parseCanonicalJson(bytes)).toEqual(result);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain('platform-capability-evidence');
    expect(JSON.stringify(result)).not.toContain('supportMatrix');
    expect(JSON.stringify(result)).not.toContain('approved');
    // Keep the fixture's owner-only artifact test independent from the host's
    // default umask while ensuring chmod does not broaden permissions.
    chmodSync(output, 0o600);
    expect(() => writeLinuxCgroupDescendantCleanupArtifactV1(output, result)).toThrow();
  });

  test('CLI artifact write failure is nonzero and does not overwrite stale output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-cgroup-eval-cli-'));
    const output = join(directory, 'stale.json');
    writeFileSync(output, 'stale-candidate-bytes', { mode: 0o600 });
    const child = Bun.spawn(
      [
        process.execPath,
        'run',
        'scripts/evals/linux-cgroup-descendant-cleanup.ts',
        '--output',
        output,
      ],
      { cwd: process.cwd(), stdout: 'ignore', stderr: 'ignore' },
    );
    expect(await child.exited).not.toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('stale-candidate-bytes');
  });
});

interface FakeHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly controllersPath?: boolean;
  readonly controllers?: string;
  readonly runner?: string | null;
  readonly systemctl?: string | null;
  readonly userSystemd?: boolean;
  readonly controlGroup?: string;
  readonly pidsMax?: string;
  readonly fixturePidsMax?: string;
  readonly forkEagain?: boolean;
  readonly descendantCgroupPath?: string;
  readonly descendantOwned?: boolean;
  readonly descendantParentPid?: number;
  readonly descendantSessionId?: number;
  readonly childSettles?: boolean;
  readonly childWaitRejects?: boolean;
  readonly childKillThrows?: boolean;
  readonly killExitCode?: number;
  readonly disappearOnKill?: boolean;
  readonly onCall?: () => void;
  readonly hostState?: {
    killInvoked: boolean;
    stopRequested: boolean;
    spawnedArgv: readonly string[];
  };
}

function fakeHost(options: FakeHostOptions = {}): LinuxCgroupCleanupHostV1 {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const hostState = options.hostState ?? {
    killInvoked: false,
    stopRequested: false,
    spawnedArgv: [],
  };
  const controllersPath = '/sys/fs/cgroup/cgroup.controllers';
  if (options.controllersPath !== false) {
    files.set(controllersPath, options.controllers ?? 'cpu memory pids\n');
    directories.add('/sys/fs/cgroup');
  }
  directories.add(CGROUP_DIR);
  files.set(`${CGROUP_DIR}/pids.max`, options.pidsMax ?? '16\n');
  files.set(`${CGROUP_DIR}/cgroup.events`, 'populated 1\nfrozen 0\n');
  files.set(`${CGROUP_DIR}/cgroup.procs`, '4242\n');

  const readyPath = '/fake/kite-cgroup-eval/ready.json';
  const goPath = '/fake/kite-cgroup-eval/go';
  const stopPath = '/fake/kite-cgroup-eval/stop';
  const fixturePath = '/fake/kite-cgroup-eval/fixture.py';
  const initialFacts = {
    ready: true,
    pidsMax: options.fixturePidsMax ?? options.pidsMax ?? '16',
    forkEagain: false,
    descendantCgroupPath: '',
    descendantPid: 0,
    descendantParentPid: 0,
    descendantSessionId: 0,
    descendantOwned: false,
  };
  const facts = {
    ...initialFacts,
    forkEagain: options.forkEagain ?? true,
    descendantCgroupPath: options.descendantCgroupPath ?? CGROUP_PATH,
    descendantPid: 4243,
    descendantParentPid: options.descendantParentPid ?? 1,
    descendantSessionId: options.descendantSessionId ?? 4242,
    descendantOwned: options.descendantOwned ?? true,
  };
  let resolveChild: ((exitCode: number) => void) | undefined;
  const childPromise = new Promise<number>((resolve) => {
    resolveChild = resolve;
  });

  return {
    platform: options.platform ?? 'linux',
    findExecutable: (name) => {
      options.onCall?.();
      if (name === 'systemd-run')
        return options.runner === null ? undefined : (options.runner ?? '/usr/bin/systemd-run');
      if (name === 'systemctl')
        return options.systemctl === null ? undefined : (options.systemctl ?? '/usr/bin/systemctl');
      if (name === 'python3') return '/usr/bin/python3';
      return undefined;
    },
    pathExists: (path) => {
      options.onCall?.();
      return directories.has(path) || files.has(path);
    },
    readText: (path) => {
      options.onCall?.();
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing fake file ${path}`);
      return value;
    },
    checkUserSystemd: async () => {
      options.onCall?.();
      return options.userSystemd ?? true;
    },
    run: async (argv): Promise<LinuxCgroupCleanupCommandResultV1> => {
      options.onCall?.();
      if (argv.includes('show') && argv.includes('--property=ControlGroup')) {
        return {
          exitCode: 0,
          stdout: `${options.controlGroup ?? CGROUP_PATH}\n`,
          stderr: '',
        };
      }
      if (argv.includes('kill')) {
        hostState.killInvoked = true;
        if (options.childSettles !== false && !options.childWaitRejects) resolveChild?.(0);
        if (options.disappearOnKill) {
          directories.delete(CGROUP_DIR);
          files.delete(`${CGROUP_DIR}/cgroup.events`);
          files.delete(`${CGROUP_DIR}/cgroup.procs`);
        } else {
          files.set(`${CGROUP_DIR}/cgroup.events`, 'populated 0\nfrozen 0\n');
          files.set(`${CGROUP_DIR}/cgroup.procs`, '');
        }
        return { exitCode: options.killExitCode ?? 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    spawn: (argv): LinuxCgroupCleanupChildV1 => {
      options.onCall?.();
      hostState.spawnedArgv = [...argv];
      files.set(readyPath, JSON.stringify(initialFacts));
      files.set(fixturePath, '# fake fixture');
      files.set('/proc/4243/cgroup', `0::${CGROUP_PATH}\n`);
      const descendantParentPid = options.descendantParentPid ?? 1;
      const descendantSessionId = options.descendantSessionId ?? 4242;
      files.set(
        '/proc/4243/stat',
        `4243 (kite-fixture) S ${descendantParentPid} 4242 ${descendantSessionId} 0 0 0 0 0 0 0\n`,
      );
      return {
        pid: 4242,
        wait: () =>
          options.childWaitRejects
            ? Promise.reject(new Error('fake wait rejected'))
            : options.childSettles === false
              ? new Promise<number>(() => undefined)
              : childPromise,
        kill: () => {
          if (options.childKillThrows) throw new Error('fake kill failed');
        },
      };
    },
    createTempDirectory: () => '/fake/kite-cgroup-eval',
    writeText: (path, value) => {
      files.set(path, value);
      if (path === stopPath) {
        hostState.stopRequested = true;
        if (options.childSettles !== false && !options.childWaitRejects) resolveChild?.(143);
      }
      if (path === goPath) files.set(readyPath, JSON.stringify(facts));
    },
    removePath: () => undefined,
  };
}
