export interface CgroupPidsRunnerV1 {
  mechanism: 'systemd_user_scope_tasks_max';
  executable: string;
}

/** Pure argv projection for a Runtime-qualified cgroup-v2 runner. */
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
