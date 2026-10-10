import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  type VerifiedTerminalBundle,
  verifyTerminalBundle,
} from '../../apps/cli/host/terminal-artifact';
import {
  parseWindowsTerminalInstallationMarker,
  readWindowsTerminalInstallation,
  retainWindowsTerminalFrontdoor,
  type WindowsTerminalInstallationMarker,
  windowsTerminalFrontdoorNames,
} from '../../apps/cli/host/windows-terminal-installation';
import { createAssetFileHasher } from '../../apps/service/src/asset-file-hash';
import {
  retainWindowsTerminalRuntimeFiles,
  verifyTerminalRuntimeBundle,
} from '../../apps/service/src/runtime-assets';
import { acquireFileLock } from '../../packages/agent/src/platform/locks';
import {
  type WindowsInstallationCoordination,
  windowsInstallationCoordination,
} from '../../packages/agent/src/platform/windows-installation-coordination';
import {
  retainWindowsInstallationRemoval,
  type WindowsInstallationInventoryEntry,
  WindowsInstallationRemovalAcquireUnknownError,
} from '../../packages/agent/src/platform/windows-installation-removal';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';
import type { InstalledTerminalBundle } from './terminal-bundle';
import { rejectBundleOutput } from './terminal-paths';

const pattern = /^[a-f0-9]{64}$/;
const markerName = '.kite-terminal-install.json';
interface InstallationOwner {
  coordination: WindowsInstallationCoordination;
  retain(resource: { release(): void }): void;
  keep(): void;
  confirmed(): void;
}
const pendingOwners = new Set<object>();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function denied(code: string): never {
  throw Error(`terminal_windows_${code}`);
}
function platform() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    denied('install_platform_unsupported');
}
/** Keep the real external EX until all exact objects have closed successfully. */
function underSelection<T>(prefix: string, run: (owner: InstallationOwner) => T): T {
  platform();
  const resources: { release(): void }[] = [];
  let keep = false;
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  pendingOwners.add(resources);
  try {
    const coordination = windowsInstallationCoordination(resolve(prefix));
    let selectionLock: ReturnType<typeof acquireFileLock> | undefined;
    resources.push({
      release() {
        // Closing the namespace is part of this exact selection owner's lifetime.
        // An unknown close must retain the real EX region for the next attempt.
        coordination.release();
        selectionLock?.release();
      },
    });
    selectionLock = acquireFileLock(coordination.selectionLockPath, 'exclusive');
    coordination.verify();
    result = run({
      coordination,
      retain(resource) {
        resources.push(resource);
      },
      keep() {
        keep = true;
      },
      confirmed() {
        keep = false;
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (!keep) {
    try {
      while (resources.length) {
        resources.at(-1)!.release();
        resources.pop();
      }
      pendingOwners.delete(resources);
    } catch (cleanup) {
      throw new AggregateError(
        failed ? [failure, cleanup] : [cleanup],
        'terminal_windows_close_unknown',
      );
    }
  }
  if (failed) throw failure;
  return result as T;
}

/** Only this invocation's finite scratch inventory may be removed. A failure keeps EX. */
function scratch(owner: InstallationOwner) {
  const root = join(owner.coordination.root, `stage-${randomUUID()}`);
  const entries = new Map<string, WindowsInstallationInventoryEntry['kind']>();
  let removal: ReturnType<typeof retainWindowsInstallationRemoval> | undefined;
  const record = (path: string, kind: WindowsInstallationInventoryEntry['kind']) => {
    const name = relative(root, path).split(sep).join('/');
    if (!name || name.startsWith('../') || entries.has(name)) denied('scratch_unknown');
    entries.set(name, kind);
  };
  owner.retain({
    release() {
      if (!removal && !existsSync(root)) return;
      removal ??= retainWindowsInstallationRemoval({
        root,
        inventory: [...entries]
          .filter(([path]) => existsSync(join(root, path)))
          .map(([path, kind]) => ({ path, kind })),
      });
      removal.remove();
      removal.release();
    },
  });
  if (existsSync(root)) denied('scratch_unknown');
  privateDirectory(root);
  return { root, record };
}
function selection(root: string): { current: string; previous: string | null } | undefined {
  const bytes = defaultWindowsPathSecurity()!.readScopeFile(join(root, 'active'), 256, true);
  if (!bytes) return undefined;
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
  if (
    lines.length !== 3 ||
    lines[2] !== '' ||
    !pattern.test(lines[0]!) ||
    (lines[1] !== '' && !pattern.test(lines[1]!))
  )
    denied('active_invalid');
  return { current: lines[0]!, previous: lines[1] || null };
}
function publish(owner: InstallationOwner, path: string, bytes: Uint8Array) {
  const security = defaultWindowsPathSecurity()!;
  const stage = scratch(owner);
  const temporary = join(stage.root, 'value');
  stage.record(temporary, 'file');
  security.writePrivateFile(temporary, bytes);
  security.syncPrivateFile(temporary);
  security.movePrivateEntry(temporary, path, true);
  const actual = security.readScopeFile(path, Math.max(1, bytes.length), true);
  if (!actual || hash(actual) !== hash(bytes)) denied('publication_unconfirmed');
}
function publishSelection(
  owner: InstallationOwner,
  root: string,
  current: string,
  previous: string | null,
) {
  publish(owner, join(root, 'active'), Buffer.from(`${current}\n${previous ?? ''}\n`));
}
function bootstrap(
  bundle: Pick<VerifiedTerminalBundle, 'digest' | 'manifest'>,
  root: string,
): WindowsTerminalInstallationMarker {
  return parseWindowsTerminalInstallationMarker(
    {
      version: 2,
      root,
      bootstrap: {
        candidateId: bundle.digest,
        files: windowsTerminalFrontdoorNames.map((name) => {
          const file = bundle.manifest.files.find(
            (file) => file.path === `windows-frontdoor/${name}`,
          );
          if (file?.mode !== 493) denied('frontdoor_unavailable');
          return { name, size: file.size, sha256: file.sha256 };
        }),
      },
    },
    root,
  );
}
function candidates(root: string): string[] {
  defaultWindowsPathSecurity()!.verifyDirectory(join(root, 'releases'));
  const ids = readdirSync(join(root, 'releases')).sort();
  if (ids.some((id) => !pattern.test(id))) denied('install_unknown_entry');
  return ids;
}
function installed(root: string) {
  const marker = readWindowsTerminalInstallation(root);
  if (readdirSync(root).some((name) => ![markerName, 'active', 'bin', 'releases'].includes(name)))
    denied('install_unknown_entry');
  return marker;
}
function inventory(root: string): WindowsInstallationInventoryEntry[] {
  const entries: WindowsInstallationInventoryEntry[] = [];
  const visit = (directory: string, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(join(directory, name));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        denied('install_unknown_entry');
      const kind = stat.isDirectory() ? 'directory' : 'file';
      entries.push({ path: relative, kind });
      if (kind === 'directory') visit(join(directory, name), relative);
    }
  };
  visit(root);
  return entries;
}
function copyCandidate(source: string, target: string, stage: ReturnType<typeof scratch>) {
  const security = defaultWindowsPathSecurity()!;
  for (const name of readdirSync(source).sort()) {
    const from = join(source, name),
      to = join(target, name),
      stat = lstatSync(from);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      stage.record(to, 'directory');
      privateDirectory(to, security);
      copyCandidate(from, to, stage);
    } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      stage.record(to, 'file');
      security.copyPrivateFile(from, to);
    } else denied('candidate_changed');
  }
}

/** Windows-only managed owner. Coordination and application data are outside its deletion root. */
export function installWindowsTerminalBundle(input: {
  bundleRoot: string;
  prefix: string;
}): InstalledTerminalBundle {
  platform();
  const bundle = verifyTerminalBundle(input.bundleRoot);
  const requested = resolve(input.prefix);
  rejectBundleOutput(bundle.root, requested);
  return underSelection(requested, (owner) => {
    const { coordination } = owner;
    const security = defaultWindowsPathSecurity()!;
    const source = retainWindowsTerminalRuntimeFiles(bundle.root);
    owner.retain(source);
    if (verifyTerminalBundle(bundle.root).digest !== bundle.digest) denied('candidate_changed');
    privateDirectory(coordination.prefix, security);
    const root = realpathSync(coordination.prefix);
    if (root !== coordination.prefix) denied('install_identity_mismatch');
    let marker: WindowsTerminalInstallationMarker;
    if (existsSync(join(root, markerName))) marker = installed(root);
    else {
      if (readdirSync(root).length) denied('install_not_empty');
      marker = bootstrap(bundle, root);
      publish(owner, join(root, markerName), Buffer.from(JSON.stringify(marker)));
    }
    const old = selection(root);
    privateDirectory(join(root, 'releases'), security);
    const ids = candidates(root);
    if (old) {
      if (!ids.includes(old.current) || (old.previous && !ids.includes(old.previous)))
        denied('active_invalid');
      for (const id of new Set([old.current, ...(old.previous ? [old.previous] : [])]))
        if (verifyTerminalBundle(join(root, 'releases', id)).digest !== id)
          denied('candidate_changed');
      owner.retain(retainWindowsTerminalFrontdoor(marker));
    }
    const releaseRoot = join(root, 'releases', bundle.digest);
    if (!existsSync(releaseRoot)) {
      const stage = scratch(owner);
      copyCandidate(bundle.root, stage.root, stage);
      if (verifyTerminalBundle(stage.root).digest !== bundle.digest) denied('candidate_changed');
      source.verify();
      security.movePrivateEntry(stage.root, releaseRoot);
    }
    security.verifyDirectory(releaseRoot);
    if (verifyTerminalBundle(releaseRoot).digest !== bundle.digest) denied('candidate_changed');
    const bootstrapRoot = join(root, 'releases', marker.bootstrap.candidateId);
    const original = verifyTerminalBundle(bootstrapRoot);
    if (JSON.stringify(bootstrap(original, root)) !== JSON.stringify(marker))
      denied('bootstrap_changed');
    privateDirectory(join(root, 'bin'), security);
    for (const file of marker.bootstrap.files) {
      const target = join(root, 'bin', file.name);
      if (!existsSync(target)) {
        if (old) denied('bootstrap_changed');
        security.copyPrivateFile(join(bootstrapRoot, 'windows-frontdoor', file.name), target);
      }
    }
    const frontdoor = retainWindowsTerminalFrontdoor(marker);
    owner.retain(frontdoor);
    source.verify();
    frontdoor.verify();
    coordination.verify();
    const previousCandidateId =
      old?.current === bundle.digest ? old.previous : (old?.current ?? null);
    publishSelection(owner, root, bundle.digest, previousCandidateId);
    return { root, candidateId: bundle.digest, releaseRoot, previousCandidateId };
  });
}
export function rollbackWindowsTerminalBundle(prefix: string): InstalledTerminalBundle {
  return underSelection(prefix, (owner) => {
    const { coordination } = owner;
    const root = coordination.prefix;
    const marker = installed(root);
    const frontdoor = retainWindowsTerminalFrontdoor(marker);
    owner.retain(frontdoor);
    const old = selection(root);
    if (!old?.previous) denied('previous_unavailable');
    const ids = candidates(root);
    if (!ids.includes(old.current) || !ids.includes(old.previous)) denied('active_invalid');
    const releaseRoot = join(root, 'releases', old.previous);
    if (verifyTerminalBundle(releaseRoot).digest !== old.previous) denied('candidate_changed');
    frontdoor.verify();
    coordination.verify();
    publishSelection(owner, root, old.previous, old.current);
    return { root, candidateId: old.previous, releaseRoot, previousCandidateId: old.current };
  });
}
export function uninstallWindowsTerminalBundle(prefix: string): void {
  underSelection(prefix, (owner) => {
    const { coordination } = owner;
    const root = coordination.prefix;
    const marker = installed(root);
    const old = selection(root);
    const ids = candidates(root);
    if (
      !old ||
      !ids.includes(old.current) ||
      (old.previous && !ids.includes(old.previous)) ||
      !ids.includes(marker.bootstrap.candidateId)
    )
      denied('active_invalid');
    for (const id of ids)
      owner.retain(acquireFileLock(coordination.candidateLockPath(id), 'exclusive'));
    // DELETE-capable original objects are retained from the outset. Ordinary SH pins
    // have all exited; no release/reopen or path-recursive deletion handoff is used.
    let removal: ReturnType<typeof retainWindowsInstallationRemoval>;
    try {
      removal = retainWindowsInstallationRemoval({ root, inventory: inventory(root) });
    } catch (error) {
      if (error instanceof WindowsInstallationRemovalAcquireUnknownError) owner.keep();
      throw error;
    }
    owner.retain(removal);
    if (
      JSON.stringify(readWindowsTerminalInstallation(root)) !== JSON.stringify(marker) ||
      JSON.stringify(selection(root)) !== JSON.stringify(old)
    )
      denied('install_identity_mismatch');
    for (const id of ids) {
      const candidate = verifyTerminalRuntimeBundle(join(root, 'releases', id), removal);
      if (candidate.digest !== id) denied('candidate_changed');
      if (
        id === marker.bootstrap.candidateId &&
        JSON.stringify(bootstrap(candidate, root)) !== JSON.stringify(marker)
      )
        denied('bootstrap_changed');
    }
    // Verification uses the same exact DELETE-purpose originals; a second ordinary
    // deny-delete pin would be incompatible with those original Windows handles.
    const fileHash = createAssetFileHasher();
    for (const file of marker.bootstrap.files) {
      const path = join(root, 'bin', file.name),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.size !== file.size || fileHash(path, file.size) !== file.sha256)
        denied('bootstrap_changed');
    }
    if (
      readdirSync(join(root, 'bin')).sort().join(',') !==
      [...windowsTerminalFrontdoorNames].sort().join(',')
    )
      denied('install_unknown_entry');
    removal.verify();
    coordination.verify();
    // A partial deletion keeps the exact native owner and all real external EX.
    owner.keep();
    removal.remove();
    removal.release();
    owner.confirmed();
  });
}
