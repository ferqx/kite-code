import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { retainWindowsArtifactScope } from './windows-artifact-scope';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
  type WindowsPrivateRead,
} from './windows-path-security';

export interface WindowsInstallationCoordination {
  readonly root: string;
  readonly prefix: string;
  readonly selectionLockPath: string;
  candidateLockPath(id: string): string;
  verify(): void;
  release(): void;
}

const maximumMarkerBytes = 16384;
/** Outer and inner are independent regions in the same durable installation namespace. */
export function deriveNativeWindowsUseKeys(candidateId: string): {
  readonly outer: string;
  readonly terminal: string;
} {
  if (!/^[0-9a-f]{64}$/.test(candidateId)) denied();
  return Object.freeze({
    outer: candidateId,
    terminal: createHash('sha256').update(`${candidateId}\0terminal`, 'utf8').digest('hex'),
  });
}
function denied(): never {
  throw Error('windows_installation_coordination_denied');
}
function canonicalPrefix(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 32760 ||
    !/^[a-zA-Z]:\\/.test(value) ||
    value.includes('/') ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    resolve(value) !== value
  )
    denied();
  const components = value.slice(3).split('\\');
  for (const component of components)
    if (
      !component ||
      component.length > 255 ||
      /[<>:"|?*]/.test(component) ||
      /[. ]$/.test(component) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component)
    )
      denied();
  const parent = dirname(value);
  const physicalParent = realpathSync(parent);
  // Case differences share one namespace; short-name/reparse/other path aliases do not.
  if (physicalParent.toLowerCase() !== parent.toLowerCase()) denied();
  const canonical = existsSync(value) ? realpathSync(value) : join(physicalParent, basename(value));
  if (canonical.toLowerCase() !== value.toLowerCase()) denied();
  return canonical;
}

/** Stable outside the replaceable install root; never grants a file lock by itself. */
export function windowsInstallationCoordination(prefix: string): WindowsInstallationCoordination {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_installation_coordination_platform_unsupported');
  const security = defaultWindowsPathSecurity()!;
  const canonical = canonicalPrefix(prefix);
  const parent = dirname(canonical);
  security.verifyPath(parent);
  security.verifyScopeDirectory(parent);
  security.verifyPath(canonical);
  const normalized = canonical.toLowerCase();
  const key = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const root = join(parent, `.kite-install-coordination-${key}`);
  const markerPath = join(root, 'installation.json');
  const expected = new TextEncoder().encode(JSON.stringify({ version: 1, prefix: normalized }));
  if (expected.length > maximumMarkerBytes) denied();
  privateDirectory(root, security);
  // This existing scope requires a current-SID-owned, public-safe immediate parent.
  // Higher system ancestors are identity-pinned without requiring current SID ownership.
  const scope = retainWindowsArtifactScope(root);
  let marker: WindowsPrivateRead | undefined;
  let released = false;
  const verifyMarker = () => {
    const bytes = security.readScopeFile(markerPath, maximumMarkerBytes, true);
    if (!bytes) denied();
    let record: unknown;
    try {
      record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      denied();
    }
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).sort().join(',') !== 'prefix,version' ||
      Reflect.get(record, 'version') !== 1 ||
      Reflect.get(record, 'prefix') !== normalized
    )
      denied();
  };
  try {
    if (security.readScopeFile(markerPath, maximumMarkerBytes, true) === null) {
      try {
        security.writePrivateFile(markerPath, expected);
      } catch (error) {
        // A concurrent creator is adopted only after the same private read and exact marker check.
        if (security.readScopeFile(markerPath, maximumMarkerBytes, true) === null) throw error;
      }
    }
    marker = security.retainPrivateFile(markerPath);
    const verify = () => {
      if (released || !marker) throw Error('windows_installation_coordination_released');
      scope.verify();
      security.verifyDirectory(root);
      marker.verify();
      verifyMarker();
    };
    verify();
    return Object.freeze({
      root,
      prefix: canonical,
      selectionLockPath: join(root, 'selection.lock'),
      candidateLockPath(id: string) {
        verify();
        if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) denied();
        return join(root, `use-${id}.lock`);
      },
      verify,
      release() {
        if (released) return;
        // Failed marker closure keeps the original namespace ancestry retained for a retry.
        marker?.close();
        marker = undefined;
        scope.release();
        released = true;
      },
    });
  } catch (error) {
    try {
      marker?.close();
      marker = undefined;
      scope.release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'windows_installation_coordination_close_failed');
    }
    throw error;
  }
}
