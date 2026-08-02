import { existsSync, readFileSync } from 'node:fs';

export interface CgroupPidsRunnerV1 {
  mechanism: 'systemd_user_scope_tasks_max';
  executable: string;
}

/**
 * Wrap one invocation in a transient user scope whose cgroup-v2 pids
 * controller applies before the sandboxed command starts.
 */
export function buildCgroupPidsInvocationV1(input: {
  runner: CgroupPidsRunnerV1;
  maxTasks: number;
  command: readonly string[];
}): string[] {
  if (!Number.isInteger(input.maxTasks) || input.maxTasks < 1) {
    throw new Error('cgroup pids maxTasks must be a positive integer.');
  }
  if (input.command.length === 0 || input.command.some((part) => part.length === 0)) {
    throw new Error('cgroup pids invocation requires a non-empty command.');
  }
  return [
    input.runner.executable,
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '--slice-inherit',
    '--expand-environment=no',
    '--property=TasksAccounting=yes',
    `--property=TasksMax=${input.maxTasks}`,
    '--',
    ...input.command,
  ];
}

/**
 * Availability is established by a real transient-scope launch, not by the
 * presence of systemd-run alone. This intentionally fails closed when the
 * user manager, cgroup-v2 pids controller, or delegation is unavailable.
 */
export function findUsableCgroupPidsRunnerV1(): CgroupPidsRunnerV1 | null {
  if (process.platform !== 'linux') return null;
  const controllersPath = '/sys/fs/cgroup/cgroup.controllers';
  if (!existsSync(controllersPath)) return null;
  try {
    const controllers = new Set(readFileSync(controllersPath, 'utf8').trim().split(/\s+/));
    if (!controllers.has('pids')) return null;
  } catch {
    return null;
  }
  const executable = Bun.which('systemd-run');
  if (!executable) return null;
  const runner = { mechanism: 'systemd_user_scope_tasks_max' as const, executable };
  try {
    const probe = Bun.spawnSync(
      buildCgroupPidsInvocationV1({
        runner,
        maxTasks: 64,
        command: ['/bin/true'],
      }),
      { stdout: 'ignore', stderr: 'ignore' },
    );
    return probe.exitCode === 0 ? Object.freeze(runner) : null;
  } catch {
    return null;
  }
}
