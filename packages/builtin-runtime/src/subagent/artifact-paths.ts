import { join } from 'node:path';
import { userKiteCodeDir } from '../model/artifact-paths';

/** Root for private immutable delegated task bodies; never model/event/log visible. */
export function subagentTaskArtifactRoot(): string {
  return join(userKiteCodeDir(), 'subagent-tasks');
}

/** Root for sealed Provider handles needed by restore/reconciliation. */
export function subagentLifecycleArtifactRoot(): string {
  return join(userKiteCodeDir(), 'subagent-lifecycles');
}

/** Root for private immutable suspended child continuations. */
export function subagentContinuationArtifactRoot(): string {
  return join(userKiteCodeDir(), 'subagent-continuations');
}
