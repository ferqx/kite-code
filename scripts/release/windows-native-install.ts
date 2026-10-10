import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  OWNED_CLI_REGISTRATION_FILE,
  readCLIRegistration,
  sameCLIRegistration,
} from '../../apps/cli/host/cli-registration';
import {
  parseWindowsNativeInstallationMarker,
  readWindowsNativeInstallation,
  retainWindowsNativeFrontdoor,
  type WindowsNativeInstallationMarker,
  windowsNativeFrontdoorNames,
} from '../../apps/cli/host/windows-native-installation';
import { createAssetFileHasher } from '../../apps/service/src/asset-file-hash';
import {
  retainWindowsNativeRuntimeFiles,
  type VerifiedNativeRuntimeBundle,
  verifyNativeRuntimeBundle,
} from '../../apps/service/src/native-runtime-assets';
import { retainWindowsTerminalRuntimeFiles } from '../../apps/service/src/runtime-assets';
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
import {
  acquireCLIRegistrationLocks,
  registerNativeCLIWhileLocked,
  unregisterNativeCLIWhileLocked,
  verifyCLIRegistrationTargetWhileLocked,
} from './cli-registration';
import type { InstalledNativeBundle } from './native-install';
import { rejectBundleOutput } from './terminal-paths';

const pattern = /^[a-f0-9]{64}$/;
const markerName = '.kite-native-install.json';
interface InstallationOwner {
  coordination: WindowsInstallationCoordination;
  locks: ReturnType<typeof acquireCLIRegistrationLocks>;
  retain(resource: { release(): void }): void;
  keep(): void;
  confirmed(): void;
}
const pendingOwners = new Set<object>();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function denied(code: string): never {
  throw Error(`native_windows_${code}`);
}
function platform() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    denied('install_platform_unsupported');
}
/** Keep the real external EX until all exact objects have closed successfully. */
function underSelection<T>(
  prefix: string,
  terminalPrefix: string | undefined,
  run: (owner: InstallationOwner) => T,
): T {
  platform();
  const resources: { release(): void }[] = [];
  let keep = false;
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  pendingOwners.add(resources);
  try {
    const coordination = windowsInstallationCoordination(resolve(prefix));
    let locks: ReturnType<typeof acquireCLIRegistrationLocks> = [];
    resources.push({
      release() {
        // Closing the namespace is part of this exact selection owner's lifetime.
        // An unknown close must retain the real EX region for the next attempt.
        coordination.release();
        while (locks.length) {
          locks.at(-1)!.release();
          locks.pop();
        }
      },
    });
    locks = acquireCLIRegistrationLocks([
      coordination.prefix,
      ...(terminalPrefix ? [terminalPrefix] : []),
    ]);
    coordination.verify();
    result = run({
      coordination,
      locks,
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
        'native_windows_close_unknown',
      );
    }
  }
  if (failed) throw failure;
  return result as T;
}

/** Opaque Windows transfer APIs retain failed closes internally but expose no retry port.
 * Preserve this invocation's real EX owners on their failure, even after rename succeeded.
 */
function transfer<T>(owner: InstallationOwner, run: () => T): T {
  try {
    return run();
  } catch (error) {
    owner.keep();
    throw error;
  }
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
    (lines[1] !== '' && (!pattern.test(lines[1]!) || lines[1] === lines[0]))
  )
    denied('active_invalid');
  return { current: lines[0]!, previous: lines[1] || null };
}
function publish(owner: InstallationOwner, path: string, bytes: Uint8Array) {
  const security = defaultWindowsPathSecurity()!;
  const stage = scratch(owner);
  const temporary = join(stage.root, 'value');
  stage.record(temporary, 'file');
  transfer(owner, () => security.writePrivateFile(temporary, bytes));
  transfer(owner, () => security.syncPrivateFile(temporary));
  transfer(owner, () => security.movePrivateEntry(temporary, path, true));
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
  bundle: Pick<VerifiedNativeRuntimeBundle, 'digest' | 'manifest'>,
  root: string,
): WindowsNativeInstallationMarker {
  return parseWindowsNativeInstallationMarker(
    {
      version: 2,
      root,
      bootstrap: {
        candidateId: bundle.digest,
        files: windowsNativeFrontdoorNames.map((name) => {
          const file = bundle.manifest.files.find((file) => file.path === `app/${name}`);
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
  const marker = readWindowsNativeInstallation(root);
  if (
    readdirSync(root).some(
      (name) =>
        ![markerName, 'active', 'bin', 'releases', OWNED_CLI_REGISTRATION_FILE].includes(name),
    )
  )
    denied('install_unknown_entry');
  readCLIRegistration(root, true);
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
function copyCandidate(
  source: string,
  target: string,
  stage: ReturnType<typeof scratch>,
  owner: InstallationOwner,
) {
  const security = defaultWindowsPathSecurity()!;
  for (const name of readdirSync(source).sort()) {
    const from = join(source, name),
      to = join(target, name),
      stat = lstatSync(from);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      stage.record(to, 'directory');
      privateDirectory(to, security);
      copyCandidate(from, to, stage, owner);
    } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      stage.record(to, 'file');
      transfer(owner, () => security.copyPrivateFile(from, to));
    } else denied('candidate_changed');
  }
}

/** Windows-only managed owner. Coordination and application data are outside its deletion root. */
export function installWindowsNativeBundle(input: {
  bundleRoot: string;
  prefix: string;
  cliPrefix?: string;
}): InstalledNativeBundle {
  platform();
  const bundle = verifyNativeRuntimeBundle(input.bundleRoot);
  const requested = resolve(input.prefix);
  rejectBundleOutput(bundle.root, requested);
  const owned = existsSync(join(requested, markerName))
    ? readCLIRegistration(requested, true)
    : undefined;
  const cliPrefix = input.cliPrefix ? realpathSync(input.cliPrefix) : owned?.terminalPrefix;
  if (owned && cliPrefix !== owned.terminalPrefix) throw Error('cli_registration_already_owned');
  const target = cliPrefix && (input.cliPrefix || existsSync(cliPrefix)) ? cliPrefix : undefined;
  return underSelection(requested, target, (owner) => {
    const { coordination } = owner;
    const security = defaultWindowsPathSecurity()!;
    const source = retainWindowsNativeRuntimeFiles(bundle.root);
    owner.retain(source);
    const innerSource = retainWindowsTerminalRuntimeFiles(join(bundle.root, 'terminal'));
    owner.retain(innerSource);
    if (verifyNativeRuntimeBundle(bundle.root).digest !== bundle.digest)
      denied('candidate_changed');
    privateDirectory(coordination.prefix, security);
    const root = realpathSync(coordination.prefix);
    if (root !== coordination.prefix) denied('install_identity_mismatch');
    if (!sameCLIRegistration(owned, readCLIRegistration(root, true)))
      throw Error('cli_registration_changed');
    if (target) verifyCLIRegistrationTargetWhileLocked(target, owner.locks);
    let marker: WindowsNativeInstallationMarker;
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
        if (verifyNativeRuntimeBundle(join(root, 'releases', id)).digest !== id)
          denied('candidate_changed');
      owner.retain(retainWindowsNativeFrontdoor(marker));
    }
    const releaseRoot = join(root, 'releases', bundle.digest);
    if (!existsSync(releaseRoot)) {
      const stage = scratch(owner);
      copyCandidate(bundle.root, stage.root, stage, owner);
      if (verifyNativeRuntimeBundle(stage.root).digest !== bundle.digest)
        denied('candidate_changed');
      source.verify();
      innerSource.verify();
      transfer(owner, () => security.movePrivateEntry(stage.root, releaseRoot));
    }
    security.verifyDirectory(releaseRoot);
    if (verifyNativeRuntimeBundle(releaseRoot).digest !== bundle.digest)
      denied('candidate_changed');
    const bootstrapRoot = join(root, 'releases', marker.bootstrap.candidateId);
    const original = verifyNativeRuntimeBundle(bootstrapRoot);
    if (JSON.stringify(bootstrap(original, root)) !== JSON.stringify(marker))
      denied('bootstrap_changed');
    privateDirectory(join(root, 'bin'), security);
    for (const file of marker.bootstrap.files) {
      const target = join(root, 'bin', file.name);
      if (!existsSync(target)) {
        if (old) denied('bootstrap_changed');
        transfer(owner, () =>
          security.copyPrivateFile(join(bootstrapRoot, 'app', file.name), target),
        );
      }
    }
    const frontdoor = retainWindowsNativeFrontdoor(marker);
    owner.retain(frontdoor);
    source.verify();
    innerSource.verify();
    frontdoor.verify();
    coordination.verify();
    const previousCandidateId =
      old?.current === bundle.digest ? old.previous : (old?.current ?? null);
    publishSelection(owner, root, bundle.digest, previousCandidateId);
    if (target && (input.cliPrefix || sameCLIRegistration(owned, readCLIRegistration(target))))
      registerNativeCLIWhileLocked({ nativePrefix: root, terminalPrefix: target }, owner.locks);
    return { root, candidateId: bundle.digest, releaseRoot, previousCandidateId };
  });
}
export function rollbackWindowsNativeBundle(prefix: string): InstalledNativeBundle {
  platform();
  const requested = resolve(prefix);
  const owned = readCLIRegistration(requested, true);
  const target = owned && existsSync(owned.terminalPrefix) ? owned.terminalPrefix : undefined;
  return underSelection(requested, target, (owner) => {
    const { coordination } = owner;
    const root = coordination.prefix;
    const marker = installed(root);
    const frontdoor = retainWindowsNativeFrontdoor(marker);
    owner.retain(frontdoor);
    if (!sameCLIRegistration(owned, readCLIRegistration(root, true)))
      throw Error('cli_registration_changed');
    const registrationTarget =
      target && sameCLIRegistration(owned, readCLIRegistration(target)) ? target : undefined;
    if (registrationTarget) verifyCLIRegistrationTargetWhileLocked(registrationTarget, owner.locks);
    const old = selection(root);
    if (!old?.previous) denied('previous_unavailable');
    const ids = candidates(root);
    if (!ids.includes(old.current) || !ids.includes(old.previous)) denied('active_invalid');
    const releaseRoot = join(root, 'releases', old.previous);
    if (verifyNativeRuntimeBundle(releaseRoot).digest !== old.previous) denied('candidate_changed');
    frontdoor.verify();
    coordination.verify();
    publishSelection(owner, root, old.previous, old.current);
    if (registrationTarget)
      registerNativeCLIWhileLocked(
        { nativePrefix: root, terminalPrefix: registrationTarget },
        owner.locks,
      );
    return { root, candidateId: old.previous, releaseRoot, previousCandidateId: old.current };
  });
}
export function uninstallWindowsNativeBundle(prefix: string): void {
  platform();
  const requested = resolve(prefix);
  const owned = readCLIRegistration(requested, true);
  const target = owned && existsSync(owned.terminalPrefix) ? owned.terminalPrefix : undefined;
  underSelection(requested, target, (owner) => {
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
    if (!sameCLIRegistration(owned, readCLIRegistration(root, true)))
      throw Error('cli_registration_changed');
    for (const id of ids) {
      owner.retain(acquireFileLock(coordination.candidateLockPath(id), 'exclusive'));
      owner.retain(
        acquireFileLock(
          coordination.candidateLockPath(hash(Buffer.from(`${id}\0terminal`))),
          'exclusive',
        ),
      );
    }
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
      JSON.stringify(readWindowsNativeInstallation(root)) !== JSON.stringify(marker) ||
      JSON.stringify(selection(root)) !== JSON.stringify(old)
    )
      denied('install_identity_mismatch');
    for (const id of ids) {
      const candidate = verifyNativeRuntimeBundle(join(root, 'releases', id), removal);
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
      [...windowsNativeFrontdoorNames].sort().join(',')
    )
      denied('install_unknown_entry');
    removal.verify();
    coordination.verify();
    // The registration owner deletes only its external forward record; the Native
    // reverse record remains inside these original DELETE handles until full removal.
    unregisterNativeCLIWhileLocked(root, owner.locks, removal);
    removal.verify();
    // A partial deletion keeps the exact native owner and all real external EX.
    owner.keep();
    removal.remove();
    removal.release();
    owner.confirmed();
  });
}
