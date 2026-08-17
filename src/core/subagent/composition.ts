import type { SubagentProviderV1 } from '@/protocol/subagent-provider';
import { ChildRuntimeDriverV1 } from './child-runtime-driver';
import { SubagentGrantAuthorityV1 } from './grant-authority';
import { LocalSubagentProviderV1 } from './local-provider';

export interface GovernedSubagentCompositionV1 {
  readonly grants: SubagentGrantAuthorityV1;
  readonly driver: ChildRuntimeDriverV1;
  readonly provider: SubagentProviderV1;
}

/** Sole production composition for the governed in-process child lifecycle. */
export function createGovernedLocalSubagentCompositionV1(): GovernedSubagentCompositionV1 {
  const grants = new SubagentGrantAuthorityV1();
  const driver = new ChildRuntimeDriverV1();
  const provider = new LocalSubagentProviderV1(grants.verifier(), driver);
  return Object.freeze({ grants, driver, provider });
}
