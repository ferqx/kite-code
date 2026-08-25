import type { SandboxBackend } from './platform';
import type { BoundaryEnforcement } from './types';

export type ProcessTreeHardLimitMechanism =
  | 'none'
  | 'cgroup_pids'
  | 'windows_job_active_process_limit'
  | 'accepted_equivalent';

export interface ProcessTreeCapabilityEvidence {
  hardCountMechanism: ProcessTreeHardLimitMechanism;
  hardCountLimit: BoundaryEnforcement;
  terminationCleanup: BoundaryEnforcement;
}

/**
 * Project independently verified hard-count and cleanup evidence. A process
 * group, PID namespace, Job Object termination, or successful descendant
 * cleanup cannot by itself satisfy the per-invocation hard-count contract.
 */
export function projectProcessTreeCapability(input: {
  hardLimitMechanism: ProcessTreeHardLimitMechanism;
  hardLimitConformancePassed: boolean;
  terminationCleanupConformancePassed: boolean;
}): ProcessTreeCapabilityEvidence {
  return {
    hardCountMechanism: input.hardLimitMechanism,
    hardCountLimit:
      input.hardLimitMechanism !== 'none' && input.hardLimitConformancePassed
        ? 'enforced'
        : 'unsupported',
    terminationCleanup: input.terminationCleanupConformancePassed ? 'enforced' : 'unsupported',
  };
}

/**
 * Project only independently observed native conformance. Callers must not
 * infer enforcement from binary discovery or a configured numeric limit.
 */
export function currentProcessTreeCapability(
  backend: SandboxBackend,
  conformance: {
    hardLimitMechanism?: ProcessTreeHardLimitMechanism;
    hardLimitConformancePassed?: boolean;
    terminationCleanupConformancePassed?: boolean;
  } = {},
): ProcessTreeCapabilityEvidence {
  if (backend === 'bubblewrap' && conformance.hardLimitMechanism === 'cgroup_pids') {
    return projectProcessTreeCapability({
      hardLimitMechanism: 'cgroup_pids',
      hardLimitConformancePassed: conformance.hardLimitConformancePassed === true,
      terminationCleanupConformancePassed: conformance.terminationCleanupConformancePassed === true,
    });
  }
  if (
    backend === 'windows_restricted_token' &&
    conformance.hardLimitMechanism === 'windows_job_active_process_limit'
  ) {
    return projectProcessTreeCapability({
      hardLimitMechanism: 'windows_job_active_process_limit',
      hardLimitConformancePassed: conformance.hardLimitConformancePassed === true,
      terminationCleanupConformancePassed: conformance.terminationCleanupConformancePassed === true,
    });
  }
  return projectProcessTreeCapability({
    hardLimitMechanism: 'none',
    hardLimitConformancePassed: false,
    terminationCleanupConformancePassed: false,
  });
}
