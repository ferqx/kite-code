import type { SubagentProviderV1 } from '@kite/runtime-spi';
import { SubagentGrantAuthorityV1 } from './grant-authority';
import {
  type BuiltinSubagentTaskArtifactAccessV1,
  type LocalSubagentLifecycleDriverV1,
  LocalSubagentProviderV1,
} from './local-provider';

export interface GovernedSubagentCompositionV1<
  TLifecycleArtifacts = unknown,
  TDriver extends LocalSubagentLifecycleDriverV1 = LocalSubagentLifecycleDriverV1,
  TTaskArtifacts extends BuiltinSubagentTaskArtifactAccessV1 = BuiltinSubagentTaskArtifactAccessV1,
> {
  readonly grants: SubagentGrantAuthorityV1;
  readonly driver: TDriver;
  readonly provider: SubagentProviderV1;
  readonly taskArtifacts: TTaskArtifacts;
  readonly lifecycleArtifacts: TLifecycleArtifacts;
}

/** Sole production composition for the governed in-process child lifecycle. */
export function createGovernedLocalSubagentCompositionV1<
  TLifecycleArtifacts,
  TDriver extends LocalSubagentLifecycleDriverV1,
  TTaskArtifacts extends BuiltinSubagentTaskArtifactAccessV1,
>(options: {
  readonly driver: TDriver;
  readonly taskArtifacts: TTaskArtifacts;
  readonly lifecycleArtifacts: TLifecycleArtifacts;
}): GovernedSubagentCompositionV1<TLifecycleArtifacts, TDriver, TTaskArtifacts> {
  const grants = new SubagentGrantAuthorityV1();
  const provider = new LocalSubagentProviderV1(
    grants.verifier(),
    options.driver,
    options.taskArtifacts,
  );
  return Object.freeze({
    grants,
    driver: options.driver,
    provider,
    taskArtifacts: options.taskArtifacts,
    lifecycleArtifacts: options.lifecycleArtifacts,
  });
}
