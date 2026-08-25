import { existsSync, readFileSync } from 'node:fs';
import { buildCgroupPidsInvocation, type CgroupPidsRunner } from './cgroup-pids-contract';

export { buildCgroupPidsInvocation, type CgroupPidsRunner };

/**
 * Discovery deliberately returns unavailable until Runtime can acknowledge
 * the exact scope/cgroup identity before GO and persist an empty receipt.
 * Binary/controller presence alone must never allocate or advertise a scope.
 */
export function findUsableCgroupPidsRunner(): CgroupPidsRunner | null {
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
  const systemctlExecutable = Bun.which('systemctl');
  if (!executable || !systemctlExecutable) return null;
  // Discovery must not allocate a transient scope until the Runtime can
  // durably acknowledge its exact unit/cgroup identity before GO and retain
  // an empty proof across restore. That lifecycle field is not available yet.
  // Keep the candidate argv contract testable, but do not advertise a runner
  // or create a native resource as a usability probe.
  return null;
}
