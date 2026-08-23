import { join } from 'node:path';
import { userKiteCodeDir } from '../model/artifact-paths';

/** Installation-private root for immutable user-level Plan Artifacts. */
export function planArtifactRoot(): string {
  return join(userKiteCodeDir(), 'plans');
}

/**
 * Deterministic path for one immutable Plan Artifact version.
 *
 * A Task owns exactly one version chain. Plan ID remains part of the Artifact
 * metadata and Runtime identity, but is deliberately not a filesystem segment.
 */
export function planArtifactPath(taskId: string, version: number): string {
  return join(planArtifactRoot(), taskId, `v${version}.md`);
}
