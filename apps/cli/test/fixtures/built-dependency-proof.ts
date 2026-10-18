import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface InstalledDependencyProof {
  name: string;
  version: string;
  manifestSha256: string;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function manifestProof(name: string, text: string): InstalledDependencyProof {
  const manifest = JSON.parse(text) as { name?: unknown; version?: unknown };
  if (manifest.name !== name || typeof manifest.version !== 'string' || !manifest.version)
    throw Error(`owned_declared_dependency_invalid:${name}`);
  return { name, version: manifest.version, manifestSha256: hash(text) };
}
export function installedDependency(name: string, owner: string): InstalledDependencyProof {
  for (const search of createRequire(join(owner, 'package.json')).resolve.paths(
    `${name}/package.json`,
  ) ?? []) {
    const path = join(search, name, 'package.json');
    if (existsSync(path)) return manifestProof(name, readFileSync(path, 'utf8'));
  }
  throw Error(`owned_declared_dependency_missing:${name}`);
}

/** The caller has verified the candidate manifest, including this metadata file.
 * Compare its real bytes with the original installed manifest, not another build's guess.
 */
export function verifyBuiltDependency(
  name: string,
  owner: string,
  expected: InstalledDependencyProof,
  bundled: boolean,
): InstalledDependencyProof {
  let actual: InstalledDependencyProof;
  if (bundled) {
    const metadata = JSON.parse(readFileSync(join(owner, 'BUNDLED-DEPENDENCIES.json'), 'utf8')) as {
      version?: unknown;
      coverage?: unknown;
      roots?: unknown;
      packages?: unknown;
    };
    if (
      metadata.version !== 1 ||
      metadata.coverage !== 'installed-declared-graph' ||
      !Array.isArray(metadata.roots) ||
      metadata.roots.filter((root) => root === name).length !== 1 ||
      !Array.isArray(metadata.packages)
    )
      throw Error(`owned_bundled_dependency_roots_invalid:${name}`);
    // A transitive copy may have the same name at another version (for example hono).
    const matches = metadata.packages.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        entry.name === name &&
        entry.version === expected.version &&
        entry.manifestSha256 === expected.manifestSha256,
    );
    if (matches.length !== 1 || typeof matches[0].manifestText !== 'string')
      throw Error(`owned_bundled_dependency_identity_invalid:${name}`);
    actual = manifestProof(name, matches[0].manifestText);
  } else actual = installedDependency(name, owner);
  if (
    actual.name !== expected.name ||
    actual.version !== expected.version ||
    actual.manifestSha256 !== expected.manifestSha256
  )
    throw Error(`owned_declared_dependency_changed:${name}`);
  return actual;
}
