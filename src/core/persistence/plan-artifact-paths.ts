import { join } from 'node:path';
import { planArtifactPath as legacyArtifactPath, planArtifactRoot } from '@/core/config/paths';

/**
 * Deterministic path for one immutable Plan Artifact version.
 *
 * A Task owns exactly one version chain. Plan ID remains part of the Artifact
 * metadata and Runtime identity, but is deliberately not a filesystem segment.
 */
export function planArtifactPath(taskId: string, version: number): string {
  return join(planArtifactRoot(), taskId, `v${version}.md`);
}

/** Read-only location used by artifacts written before the flattened layout. */
export function legacyPlanArtifactPath(taskId: string, planId: string, version: number): string {
  return legacyArtifactPath(taskId, planId, version);
}
