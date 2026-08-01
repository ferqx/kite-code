import type { SandboxBackend } from './platform';
import type { BoundaryEnforcementV1 } from './types';

export type ProcessTreeHardLimitMechanismV1 =
  | 'none'
  | 'cgroup_pids'
  | 'windows_job_active_process_limit'
  | 'accepted_equivalent';

export interface ProcessTreeCapabilityEvidenceV1 {
  hardCountMechanism: ProcessTreeHardLimitMechanismV1;
  hardCountLimit: BoundaryEnforcementV1;
  terminationCleanup: BoundaryEnforcementV1;
}

/**
 * Project independently verified hard-count and cleanup evidence. A process
 * group, PID namespace, Job Object termination, or successful descendant
 * cleanup cannot by itself satisfy the per-invocation hard-count contract.
 */
function projectProcessTreeCapabilityV1(input: {
  hardLimitMechanism: ProcessTreeHardLimitMechanismV1;
  hardLimitConformancePassed: boolean;
  terminationCleanupConformancePassed: boolean;
}): ProcessTreeCapabilityEvidenceV1 {
  return {
    hardCountMechanism: input.hardLimitMechanism,
    hardCountLimit:
      input.hardLimitMechanism !== 'none' && input.hardLimitConformancePassed
        ? 'enforced'
        : 'unsupported',
    terminationCleanup: input.terminationCleanupConformancePassed ? 'enforced' : 'unsupported',
  };
}

/** Current native backends have termination guards but no accepted hard limiter. */
export function currentProcessTreeCapabilityV1(
  _backend: SandboxBackend,
): ProcessTreeCapabilityEvidenceV1 {
  return projectProcessTreeCapabilityV1({
    hardLimitMechanism: 'none',
    hardLimitConformancePassed: false,
    terminationCleanupConformancePassed: false,
  });
}
