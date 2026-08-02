import { describe, expect, test } from 'bun:test';
import { buildCgroupPidsInvocationV1 } from '@/core/sandbox/cgroup-pids';

describe('cgroup v2 pids invocation', () => {
  test('builds an argv-only transient user scope with an exact task ceiling', () => {
    expect(
      buildCgroupPidsInvocationV1({
        runner: { mechanism: 'systemd_user_scope_tasks_max', executable: '/usr/bin/systemd-run' },
        maxTasks: 32,
        command: ['/usr/bin/bwrap', '--unshare-pid', '/bin/sh', '-c', 'printf "$HOME"'],
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
    };
    expect(() =>
      buildCgroupPidsInvocationV1({ runner, maxTasks: 0, command: ['/bin/true'] }),
    ).toThrow('positive integer');
    expect(() => buildCgroupPidsInvocationV1({ runner, maxTasks: 1, command: [] })).toThrow(
      'non-empty command',
    );
  });
});
