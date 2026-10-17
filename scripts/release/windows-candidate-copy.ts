import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WindowsInstallationInventoryEntry } from '../../packages/agent/src/platform/windows-installation-removal';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';

/** Copy an inventoried tree; selection locks and scratch ownership stay with the caller. */
export function copyWindowsCandidate(
  source: string,
  entries: readonly WindowsInstallationInventoryEntry[],
  stage: {
    readonly root: string;
    record(path: string, kind: WindowsInstallationInventoryEntry['kind']): void;
  },
  owner: { keep(): void },
) {
  const target = stage.root;
  for (const entry of entries) stage.record(join(target, entry.path), entry.kind);
  try {
    defaultWindowsPathSecurity()!.copyPrivateArtifactFiles(
      source,
      target,
      entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path),
    );
    for (const entry of entries)
      if (entry.kind === 'directory' && !existsSync(join(target, entry.path)))
        privateDirectory(join(target, entry.path));
  } catch (error) {
    owner.keep();
    throw error;
  }
}
