import type { SubagentLifecycleArtifactAccessV1 } from '@/core/persistence/subagent-lifecycle-artifacts';
import type { SubagentTaskArtifactAccessV1 } from '@/core/persistence/subagent-task-artifacts';
import type { SubagentProviderV1 } from '@/protocol/subagent-provider';
import { ChildRuntimeDriverV1 } from './child-runtime-driver';
import { SubagentGrantAuthorityV1 } from './grant-authority';
import { LocalSubagentProviderV1 } from './local-provider';

export interface GovernedSubagentCompositionV1 {
  readonly grants: SubagentGrantAuthorityV1;
  readonly driver: ChildRuntimeDriverV1;
  readonly provider: SubagentProviderV1;
  readonly taskArtifacts: SubagentTaskArtifactAccessV1;
  readonly lifecycleArtifacts: SubagentLifecycleArtifactAccessV1;
}

/** Sole production composition for the governed in-process child lifecycle. */
export function createGovernedLocalSubagentCompositionV1(options: {
  readonly integrityKey: Uint8Array;
  readonly taskArtifacts: SubagentTaskArtifactAccessV1;
  readonly lifecycleArtifacts: SubagentLifecycleArtifactAccessV1;
}): GovernedSubagentCompositionV1 {
  const taskArtifacts = options.taskArtifacts;
  const grants = new SubagentGrantAuthorityV1({ key: options.integrityKey });
  const lifecycleArtifacts = options.lifecycleArtifacts;
  const driver = new ChildRuntimeDriverV1();
  const provider = new LocalSubagentProviderV1(grants.verifier(), driver, taskArtifacts);
  return Object.freeze({ grants, driver, provider, taskArtifacts, lifecycleArtifacts });
}
