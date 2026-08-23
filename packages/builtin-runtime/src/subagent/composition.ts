import type { SubagentProvider } from '@kite/runtime-spi';
import { SubagentGrantAuthority } from './grant-authority';
import {
  type BuiltinSubagentTaskArtifactAccess,
  type LocalSubagentLifecycleDriver,
  LocalSubagentProvider,
} from './local-provider';

export interface GovernedSubagentComposition<
  TLifecycleArtifacts = unknown,
  TDriver extends LocalSubagentLifecycleDriver = LocalSubagentLifecycleDriver,
  TTaskArtifacts extends BuiltinSubagentTaskArtifactAccess = BuiltinSubagentTaskArtifactAccess,
> {
  readonly grants: SubagentGrantAuthority;
  readonly driver: TDriver;
  readonly provider: SubagentProvider;
  readonly taskArtifacts: TTaskArtifacts;
  readonly lifecycleArtifacts: TLifecycleArtifacts;
}

/** Sole production composition for the governed in-process child lifecycle. */
export function createGovernedLocalSubagentComposition<
  TLifecycleArtifacts,
  TDriver extends LocalSubagentLifecycleDriver,
  TTaskArtifacts extends BuiltinSubagentTaskArtifactAccess,
>(options: {
  readonly driver: TDriver;
  readonly taskArtifacts: TTaskArtifacts;
  readonly lifecycleArtifacts: TLifecycleArtifacts;
}): GovernedSubagentComposition<TLifecycleArtifacts, TDriver, TTaskArtifacts> {
  const grants = new SubagentGrantAuthority();
  const provider = new LocalSubagentProvider(
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
