import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  nativeBundleEntries,
  verifyNativeRuntimeBundle,
} from '@kite-ai/service/native-runtime-assets';
import {
  OWNED_CLI_REGISTRATION_FILE,
  readCLIRegistration,
  sameCLIRegistration,
} from '../../apps/cli/host/cli-registration';
import {
  acquireCLIRegistrationLocks,
  registerNativeCLIWhileLocked,
  unregisterNativeCLIWhileLocked,
  verifyCLIRegistrationTargetWhileLocked,
} from './cli-registration';
import { rejectBundleOutput } from './terminal-paths';

const marker = '.kite-native-install.json',
  pattern = /^[a-f0-9]{64}$/;
function fail(code: string): never {
  throw Error(`native_${code}`);
}
const text = (path: string) => new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
const present = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });
function directory(path: string) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (s.mode & 0o022) !== 0 ||
    (process.getuid && s.uid !== process.getuid())
  )
    fail('directory_unsafe');
}
function regular(path: string, mode: number) {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    (s.mode & 0o777) !== mode ||
    (process.getuid && s.uid !== process.getuid())
  )
    fail('install_file_unsafe');
  return s;
}
function sync(path: string) {
  const s = lstatSync(path);
  if (s.isSymbolicLink()) return;
  if (s.isDirectory()) for (const name of readdirSync(path)) sync(join(path, name));
  const fd = openSync(path, constants.O_RDONLY | (s.isDirectory() ? constants.O_DIRECTORY : 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function durable(path: string, content: string, mode = 0o600) {
  const tmp = join(dirname(path), `.publish-${randomUUID()}`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(tmp, { force: true });
  }
}
function createDirectory(path: string) {
  if (present(path)) {
    directory(path);
    return;
  }
  createDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(dirname(path));
}
function installed(root: string) {
  directory(root);
  regular(join(root, marker), 0o600);
  const raw = JSON.parse(text(join(root, marker)));
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 2 ||
    raw.version !== 1 ||
    raw.root !== root ||
    !Object.keys(raw).every((key) => ['root', 'version'].includes(key))
  )
    fail('install_identity_mismatch');
}
function active(root: string) {
  regular(join(root, 'active'), 0o600);
  const lines = text(join(root, 'active')).split('\n');
  if (
    lines.length !== 3 ||
    lines[2] !== '' ||
    !pattern.test(lines[0]!) ||
    (lines[1] !== '' && !pattern.test(lines[1]!)) ||
    lines[0] === lines[1]
  )
    fail('active_invalid');
  return { current: lines[0]!, previous: lines[1] || null };
}
function launcher(name: 'desktop' | 'cli' | 'tui' = 'desktop') {
  const electron = nativeBundleEntries(process.platform).electron;
  return `#!/bin/sh\nset -eu\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS ELECTRON_RUN_AS_NODE\nroot=$(CDPATH= cd -P -- "\${0%/*}/.." && pwd)\nIFS= read -r candidate < "$root/active"\ncase "$candidate" in ''|*[!0-9a-f]*) echo native_active_invalid >&2; exit 1;; esac\n[ "\${#candidate}" -eq 64 ] || exit 1\n${name === 'desktop' ? `exec "$root/releases/$candidate/${electron}" "$root/releases/$candidate/app" "$@"` : `exec "$root/releases/$candidate/terminal/runtime/bun" "$root/releases/$candidate/terminal/entrypoints/native-${name}.js" "$@"`}\n`;
}
function copy(source: string, destination: string) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
  else if (stat.isDirectory()) {
    mkdirSync(destination, { mode: 0o700 });
    for (const name of readdirSync(source)) copy(join(source, name), join(destination, name));
  } else if (stat.isFile()) {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, stat.mode & 0o777);
  } else fail('copy_unsupported');
}
/** Discover the closed install tree; content validation may follow acquiring every use lease. */
function inventory(root: string, verifyContent = true) {
  installed(root);
  regular(join(root, '.install.lock'), 0o600);
  if (lstatSync(join(root, '.install.lock')).size !== 0) fail('install_file_unsafe');
  if (
    readdirSync(root).sort().join(',') !==
    [
      marker,
      '.install.lock',
      'active',
      'bin',
      'releases',
      ...(readCLIRegistration(root, true) ? [OWNED_CLI_REGISTRATION_FILE] : []),
    ]
      .sort()
      .join(',')
  )
    fail('install_unknown_entry');
  const selection = active(root);
  directory(join(root, 'bin'));
  if (
    readdirSync(join(root, 'bin')).sort().join(',') !==
    ['kite', 'kite-desktop', 'kite-tui'].sort().join(',')
  )
    fail('install_unknown_entry');
  for (const [file, name] of [
    ['kite', 'cli'],
    ['kite-tui', 'tui'],
    ['kite-desktop', 'desktop'],
  ] as const) {
    regular(join(root, 'bin', file), 0o755);
    if (text(join(root, 'bin', file)) !== launcher(name)) fail('launcher_changed');
  }
  directory(join(root, 'releases'));
  const entries = readdirSync(join(root, 'releases'));
  const candidates = entries.filter((name) => pattern.test(name)).sort();
  if (
    !candidates.includes(selection.current) ||
    (selection.previous && !candidates.includes(selection.previous))
  )
    fail('active_invalid');
  for (const name of entries) {
    if (pattern.test(name)) {
      const candidate = join(root, 'releases', name);
      directory(candidate);
      directory(join(candidate, 'terminal'));
      if (verifyContent && verifyNativeRuntimeBundle(candidate).digest !== name)
        fail('candidate_changed');
    } else if (/^\.use-[a-f0-9]{64}\.lock$/.test(name) && candidates.includes(name.slice(5, -5))) {
      if (regular(join(root, 'releases', name), 0o600).size !== 0) fail('install_file_unsafe');
    } else fail('install_unknown_entry');
  }
  return { selection, candidates };
}
function platform() {
  if (!['darwin', 'linux'].includes(process.platform)) fail('install_platform_unsupported');
}
export interface InstalledNativeBundle {
  root: string;
  candidateId: string;
  releaseRoot: string;
  previousCandidateId: string | null;
}
export function installNativeBundle(input: {
  bundleRoot: string;
  prefix: string;
  cliPrefix?: string;
}): InstalledNativeBundle {
  platform();
  const source = resolve(input.bundleRoot),
    leases: ReturnType<typeof acquireArtifactAccess>[] = [];
  let stage: string | undefined;
  try {
    leases.push(acquireArtifactAccess({ root: source, mode: 'shared' }));
    leases.push(acquireArtifactAccess({ root: join(source, 'terminal'), mode: 'shared' }));
    const bundle = verifyNativeRuntimeBundle(source),
      root = resolve(input.prefix);
    rejectBundleOutput(source, root);
    createDirectory(root);
    const existing = present(join(root, marker));
    if (!existing && readdirSync(root).some((name) => name !== '.install.lock'))
      fail('install_not_empty');
    const owned = existing ? readCLIRegistration(root, true) : undefined;
    const cliPrefix = input.cliPrefix ? realpathSync(input.cliPrefix) : owned?.terminalPrefix;
    const locks = acquireCLIRegistrationLocks([root, ...(cliPrefix ? [cliPrefix] : [])]);
    try {
      if (owned && cliPrefix !== owned.terminalPrefix)
        throw Error('cli_registration_already_owned');
      if (cliPrefix) verifyCLIRegistrationTargetWhileLocked(cliPrefix, locks);
      if (!sameCLIRegistration(owned, existing ? readCLIRegistration(root, true) : undefined))
        throw Error('cli_registration_changed');
      const previous = existing ? inventory(root).selection : undefined;
      if (!existing) {
        if (readdirSync(root).some((name) => name !== '.install.lock')) fail('install_not_empty');
        durable(join(root, marker), `${JSON.stringify({ version: 1, root })}\n`);
        mkdirSync(join(root, 'releases'), { mode: 0o700 });
        mkdirSync(join(root, 'bin'), { mode: 0o700 });
        for (const [file, name] of [
          ['kite', 'cli'],
          ['kite-tui', 'tui'],
          ['kite-desktop', 'desktop'],
        ] as const)
          durable(join(root, 'bin', file), launcher(name), 0o755);
      }
      const releaseRoot = join(root, 'releases', bundle.digest);
      if (!present(releaseRoot)) {
        stage = join(root, 'releases', `.stage-${randomUUID()}`);
        copy(source, stage);
        if (
          verifyNativeRuntimeBundle(stage).digest !== bundle.digest ||
          verifyNativeRuntimeBundle(source).digest !== bundle.digest
        )
          fail('candidate_changed');
        sync(stage);
        renameSync(stage, releaseRoot);
        stage = undefined;
        syncDirectory(join(root, 'releases'));
      }
      if (verifyNativeRuntimeBundle(releaseRoot).digest !== bundle.digest)
        fail('candidate_changed');
      const previousCandidateId =
        previous?.current === bundle.digest ? previous.previous : (previous?.current ?? null);
      durable(join(root, 'active'), `${bundle.digest}\n${previousCandidateId ?? ''}\n`);
      if (
        cliPrefix &&
        (input.cliPrefix || sameCLIRegistration(owned, readCLIRegistration(cliPrefix)))
      )
        registerNativeCLIWhileLocked({ nativePrefix: root, terminalPrefix: cliPrefix }, locks);
      return { root, candidateId: bundle.digest, releaseRoot, previousCandidateId };
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      for (const lock of locks.reverse()) lock.release();
    }
  } finally {
    for (const lease of leases.reverse()) lease.release();
  }
}
export function rollbackNativeBundle(prefix: string): InstalledNativeBundle {
  platform();
  const root = resolve(prefix);
  installed(root);
  const owned = readCLIRegistration(root, true);
  const locks = acquireCLIRegistrationLocks([
    root,
    ...(owned && present(owned.terminalPrefix) ? [owned.terminalPrefix] : []),
  ]);
  try {
    if (!sameCLIRegistration(owned, readCLIRegistration(root, true)))
      throw Error('cli_registration_changed');
    const { selection } = inventory(root);
    if (!selection.previous) fail('previous_unavailable');
    const releaseRoot = join(root, 'releases', selection.previous);
    durable(join(root, 'active'), `${selection.previous}\n${selection.current}\n`);
    if (
      owned &&
      present(owned.terminalPrefix) &&
      sameCLIRegistration(owned, readCLIRegistration(owned.terminalPrefix))
    )
      registerNativeCLIWhileLocked(
        { nativePrefix: root, terminalPrefix: owned.terminalPrefix },
        locks,
      );
    return {
      root,
      candidateId: selection.previous,
      releaseRoot,
      previousCandidateId: selection.current,
    };
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}
/** Both levels of every managed candidate must be idle before any install-root mutation. */
export function uninstallNativeBundle(prefix: string): void {
  platform();
  const root = resolve(prefix);
  installed(root);
  const owned = readCLIRegistration(root, true);
  const locks = acquireCLIRegistrationLocks([
      root,
      ...(owned && present(owned.terminalPrefix) ? [owned.terminalPrefix] : []),
    ]),
    uses: ReturnType<typeof acquireArtifactAccess>[] = [];
  let removed: string | undefined;
  try {
    if (!sameCLIRegistration(owned, readCLIRegistration(root, true)))
      throw Error('cli_registration_changed');
    const original = inventory(root, false);
    for (const id of original.candidates) {
      const candidate = join(root, 'releases', id);
      uses.push(acquireArtifactAccess({ root: candidate, mode: 'exclusive' }));
      uses.push(acquireArtifactAccess({ root: join(candidate, 'terminal'), mode: 'exclusive' }));
    }
    for (const id of original.candidates)
      if (verifyNativeRuntimeBundle(join(root, 'releases', id)).digest !== id)
        fail('candidate_changed');
    const checked = inventory(root, false);
    if (
      checked.selection.current !== original.selection.current ||
      checked.selection.previous !== original.selection.previous ||
      checked.candidates.join(',') !== original.candidates.join(',')
    )
      fail('install_changed');
    unregisterNativeCLIWhileLocked(root, locks);
    removed = join(dirname(root), `.native-uninstall-${randomUUID()}`);
    renameSync(root, removed);
    syncDirectory(dirname(root));
  } finally {
    for (const use of uses.reverse()) use.release();
    for (const lock of locks.reverse()) lock.release();
  }
  if (removed) {
    rmSync(removed, { recursive: true, force: false });
    syncDirectory(dirname(root));
  }
}
