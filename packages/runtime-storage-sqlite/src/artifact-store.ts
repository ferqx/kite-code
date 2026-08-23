import { type ArtifactPort, createArtifactPort } from '@kite/runtime-host/storage';

/** Resolve the adapter's Artifact port once; SQLite never interprets artifact payloads. */
export function resolveSqliteArtifactStore(artifacts?: ArtifactPort): ArtifactPort {
  return artifacts ?? createArtifactPort();
}
