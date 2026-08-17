import { existsSync, readFileSync } from 'node:fs';
import {
  buildCgroupPidsInvocationV1,
  type CgroupPidsRunnerV1,
} from '@/core/execution/sandbox-execution/cgroup-pids-contract';

export { buildCgroupPidsInvocationV1, type CgroupPidsRunnerV1 };

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
