import { join } from 'node:path';
import { userKiteCodeDirV1 } from '../model/artifact-paths';

/** Root for private immutable delegated task bodies; never model/event/log visible. */
export function subagentTaskArtifactRootV1(): string {
  return join(userKiteCodeDirV1(), 'subagent-tasks');
}

/** Root for sealed Provider handles needed by restore/reconciliation. */
export function subagentLifecycleArtifactRootV1(): string {
  return join(userKiteCodeDirV1(), 'subagent-lifecycles');
}

/** Root for private immutable suspended child continuations. */
export function subagentContinuationArtifactRootV1(): string {
  return join(userKiteCodeDirV1(), 'subagent-continuations');
}
