import { describe, expect, test } from 'bun:test';
import {
  buildCgroupPidsInvocation,
  buildCgroupPidsKillInvocation,
  createCgroupPidsUnitName,
  findUsableCgroupPidsRunner,
  isCgroupPidsPath,
  isCgroupPidsUnitName,
  LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_,
  parseCgroupPidsEmpty,
  parseCgroupPidsPopulated,
  parseLinuxCgroupScopeIdentity,
} from '@kite/builtin-runtime/sandbox';

describe('cgroup v2 pids invocation', () => {
  test('builds an argv-only transient user scope with an exact task ceiling', () => {
    expect(
      buildCgroupPidsInvocation({
        runner: {
          mechanism: 'systemd_user_scope_tasks_max',
          executable: '/usr/bin/systemd-run',
          systemctlExecutable: '/usr/bin/systemctl',
        },
        maxTasks: 32,
        command: ['/usr/bin/bwrap', '--unshare-pid', '/bin/sh', '-c', 'printf "$HOME"'],
        unitName: 'kite-sandbox-12345678-1234-4234-8234-123456789abc.scope',
      }),
    ).toEqual([
      '/usr/bin/systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--slice-inherit',
      '--expand-environment=no',
      '--property=TasksAccounting=yes',
      '--property=TasksMax=32',
      '--unit=kite-sandbox-12345678-1234-4234-8234-123456789abc.scope',
      '--',
      '/usr/bin/bwrap',
      '--unshare-pid',
      '/bin/sh',
      '-c',
      'printf "$HOME"',
    ]);
  });

  test('rejects invalid limits and empty commands before spawn', () => {
    const runner = {
      mechanism: 'systemd_user_scope_tasks_max' as const,
      executable: '/usr/bin/systemd-run',
      systemctlExecutable: '/usr/bin/systemctl',
    };
    expect(() =>
      buildCgroupPidsInvocation({
        runner,
        maxTasks: 0,
        command: ['/bin/true'],
        unitName: 'kite-sandbox-12345678-1234-4234-8234-123456789abc.scope',
      }),
    ).toThrow('positive integer');
    expect(() =>
      buildCgroupPidsInvocation({
        runner,
        maxTasks: 1,
        command: [],
        unitName: 'kite-sandbox-12345678-1234-4234-8234-123456789abc.scope',
      }),
    ).toThrow('non-empty command');
  });

  test('rejects a non-runtime unit identity before spawn', () => {
    const runner = {
      mechanism: 'systemd_user_scope_tasks_max' as const,
      executable: '/usr/bin/systemd-run',
      systemctlExecutable: '/usr/bin/systemctl',
    };
    expect(() =>
      buildCgroupPidsInvocation({
        runner,
        maxTasks: 1,
        command: ['/bin/true'],
        unitName: 'untrusted.scope',
      }),
    ).toThrow('Runtime-owned unit name');
  });

  test('requires a cgroup path to terminate at the exact Runtime-owned unit', () => {
    const unit = 'kite-sandbox-12345678-1234-4234-8234-123456789abc.scope';
    expect(isCgroupPidsUnitName(unit)).toBe(true);
    expect(isCgroupPidsPath(`/user.slice/user-1000.slice/${unit}`, unit)).toBe(true);
    expect(isCgroupPidsPath(`/user.slice/user-1000.slice/other.scope`, unit)).toBe(false);
    expect(isCgroupPidsPath(`/user.slice/../${unit}`, unit)).toBe(false);
    expect(isCgroupPidsPath(`/user.slice//${unit}`, unit)).toBe(false);
    expect(() => createCgroupPidsUnitName('ABCDEF12')).toThrow('unit identity is invalid');
    expect(() => createCgroupPidsUnitName('--------')).toThrow('unit identity is invalid');
  });

  test('projects consumer kill-all argv without invoking systemd', () => {
    const unitName = 'kite-sandbox-12345678-1234-4234-8234-123456789abc.scope';
    expect(
      buildCgroupPidsKillInvocation({
        scope: {
          unitName,
          runnerExecutable: '/usr/bin/systemd-run',
          systemctlExecutable: '/usr/bin/systemctl',
          cgroupPath: `/user.slice/user-1000.slice/${unitName}`,
        },
      }),
    ).toEqual([
      '/usr/bin/systemctl',
      '--user',
      '--no-ask-password',
      '--quiet',
      'kill',
      '--kill-who=all',
      '--signal=SIGKILL',
      'kite-sandbox-12345678-1234-4234-8234-123456789abc.scope',
    ]);
    expect(parseCgroupPidsPopulated('populated 0\nfrozen 0\n')).toBe(false);
    expect(parseCgroupPidsPopulated('populated 1\nfrozen 0\n')).toBe(true);
    expect(parseCgroupPidsPopulated('populated 0\npopulated 1\n')).toBeUndefined();
    expect(parseCgroupPidsPopulated('populated  0\n')).toBeUndefined();
    expect(parseCgroupPidsPopulated('not-a-cgroup-events-file')).toBeUndefined();
    expect(parseCgroupPidsEmpty('')).toBe(true);
    expect(parseCgroupPidsEmpty('\n')).toBeUndefined();
    expect(parseCgroupPidsEmpty('1234\n')).toBe(false);
  });

  test('keeps private unit authority disjoint from an argv/path mismatch', () => {
    const unitName = 'kite-sandbox-12345678-1234-4234-8234-123456789abc.scope';
    const argv = buildCgroupPidsInvocation({
      runner: {
        mechanism: 'systemd_user_scope_tasks_max',
        executable: '/usr/bin/systemd-run',
        systemctlExecutable: '/usr/bin/systemctl',
      },
      maxTasks: 4,
      command: ['/bin/true'],
      unitName,
    });
    const candidate = {
      schema: LINUX_CGROUP_SCOPE_CANDIDATE_SCHEMA_,
      unitName,
      runnerExecutable: '/usr/bin/systemd-run',
      systemctlExecutable: '/usr/bin/systemctl',
      cgroupPath: `/user.slice/user-1000.slice/${unitName}`,
    } as const;
    expect(
      parseLinuxCgroupScopeIdentity({
        argv,
        candidate,
      }),
    ).toEqual({
      invalid: false,
      scope: {
        unitName,
        runnerExecutable: '/usr/bin/systemd-run',
        systemctlExecutable: '/usr/bin/systemctl',
        cgroupPath: `/user.slice/user-1000.slice/${unitName}`,
      },
    });
    expect(parseLinuxCgroupScopeIdentity({ argv, candidate: {} }).invalid).toBe(true);
    expect(
      parseLinuxCgroupScopeIdentity({
        argv,
        candidate: { ...candidate, unexpected: true },
      }).invalid,
    ).toBe(true);
    expect(
      parseLinuxCgroupScopeIdentity({
        argv: [
          '/usr/bin/systemd-run',
          '--user',
          '--scope',
          '--quiet',
          '--collect',
          '--slice-inherit',
          '--expand-environment=no',
          '--property=TasksAccounting=yes',
          '--property=TasksMax=4',
          `--unit=${unitName}`,
          '--unexpected',
          '--',
          '/bin/true',
        ],
        candidate,
      }).invalid,
    ).toBe(true);
    expect(
      parseLinuxCgroupScopeIdentity({
        argv: [
          ...argv.slice(0, 9),
          '--unit=kite-sandbox-22345678-1234-4234-8234-123456789abc.scope',
          ...argv.slice(10),
        ],
        candidate,
      }).invalid,
    ).toBe(true);
    expect(
      parseLinuxCgroupScopeIdentity({
        argv: [...argv.slice(0, 10), `--unit=${unitName}`, ...argv.slice(10)],
        candidate,
      }).invalid,
    ).toBe(true);
    expect(
      parseLinuxCgroupScopeIdentity({
        argv: [...argv.slice(0, 9), ...argv.slice(10), `--unit=${unitName}`],
        candidate,
      }).invalid,
    ).toBe(true);
    expect(() =>
      buildCgroupPidsKillInvocation({
        scope: {
          ...candidate,
          systemctlExecutable: '/usr/bin/../bin/systemctl',
        },
      }),
    ).toThrow('cleanup authority is invalid');
  });

  test('does not advertise a runner before durable scope authority exists', () => {
    expect(findUsableCgroupPidsRunner()).toBeNull();
  });
});
