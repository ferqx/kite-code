import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceStateRoot,
  type KiteHomeIdentity,
  LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
  type LocalRuntimeServiceDirectoryLock,
  readLocalRuntimeServiceDescriptor,
  readLocalRuntimeServiceLockIdentity,
  readLocalRuntimeServiceToken,
  tryAcquireLocalRuntimeServiceLock,
} from '@kite-ai/kite-local-runtime/service';
import { z } from 'zod';
import {
  currentOssReleaseTarget,
  defaultOssCandidateArchivePath,
  ossCandidateManifestSchema,
  type VerifiedOssCandidate,
  verifyOssCandidate,
} from './oss-candidate';

const markerSchema = z
  .object({
    schema: z.literal('KiteCodeManagedInstall'),
    version: z.literal(1),
    canonicalRoot: z.string().min(1),
    currentCandidateId: z.string().regex(/^[a-f0-9]{24}$/),
    previousCandidateId: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .nullable(),
    target: z.string().regex(/^(macos|linux|windows)-(arm64|x64)$/),
  })
  .strict();

type InstallMarker = z.infer<typeof markerSchema>;
const MARKER_FILE = '.kite-code-managed.json';

export function defaultInstallPrefix(): string {
  return resolve(userInfo().homedir, '.local', 'share', 'kite-code');
}

export async function installOssCandidate(input: {
  archivePath: string;
  prefix: string;
  /** Explicit test/custom identity; production defaults to the canonical OS-user Kite home. */
  serviceHome?: KiteHomeIdentity;
}): Promise<InstallMarker> {
  const candidate = await verifyOssCandidate(input.archivePath, currentOssReleaseTarget().id);
  const root = prepareManagedRoot(input.prefix);
  const existing = loadMarkerIfPresent(root);
  if (!existing && readdirSync(root).length > 0) {
    throw new Error('Install prefix is not empty and is not managed by Kite Code.');
  }
  if (existing) {
    assertMarkerRoot(root, existing);
    assertManagedTreeForUninstall(root, existing, 128);
    if (existing.target !== candidate.manifest.target.id) {
      throw new Error(
        `Managed install target ${existing.target} cannot be replaced by ${candidate.manifest.target.id}.`,
      );
    }
    ordinaryStopManagedService(root, existing);
  }
  const fence = acquireInstallerServiceFence(input.serviceHome);
  try {
    const releaseRoot = join(root, 'releases', candidate.candidateId);
    materializeRelease(candidate, releaseRoot);
    verifyMaterializedRelease(releaseRoot, candidate.candidateId);
    assertMarkerWriteReady(root);
    activateRelease(root, releaseRoot, candidate.manifest.target.os === 'win32');
    const marker: InstallMarker = {
      schema: 'KiteCodeManagedInstall',
      version: 1,
      canonicalRoot: realpathSync.native(root),
      currentCandidateId: candidate.candidateId,
      previousCandidateId:
        existing && existing.currentCandidateId !== candidate.candidateId
          ? existing.currentCandidateId
          : (existing?.previousCandidateId ?? null),
      target: candidate.manifest.target.id,
    };
    writeMarker(root, marker);
    return marker;
  } finally {
    fence.release();
  }
}

export function rollbackOssCandidate(
  prefix: string,
  options: { readonly serviceHome?: KiteHomeIdentity } = {},
): InstallMarker {
  const root = requireManagedRoot(prefix);
  const marker = loadMarker(root);
  assertManagedTreeForUninstall(root, marker, 128);
  if (!marker.previousCandidateId) throw new Error('No previous Kite Code candidate is available.');
  ordinaryStopManagedService(root, marker);
  const releaseRoot = join(root, 'releases', marker.previousCandidateId);
  const manifest = verifyMaterializedRelease(releaseRoot, marker.previousCandidateId);
  const fence = acquireInstallerServiceFence(options.serviceHome);
  try {
    assertMarkerWriteReady(root);
    activateRelease(root, releaseRoot, manifest.target.os === 'win32');
    const next: InstallMarker = {
      ...marker,
      currentCandidateId: marker.previousCandidateId,
      previousCandidateId: marker.currentCandidateId,
      target: manifest.target.id,
    };
    writeMarker(root, next);
    return next;
  } finally {
    fence.release();
  }
}

export function uninstallOssCandidate(
  prefix: string,
  options: { readonly serviceHome?: KiteHomeIdentity } = {},
): void {
  const root = requireManagedRoot(prefix);
  const marker = loadMarker(root);
  assertMarkerRoot(root, marker);
  assertManagedTreeForUninstall(root, marker, 128);
  ordinaryStopManagedService(root, marker);
  const fence = acquireInstallerServiceFence(options.serviceHome);
  try {
    rmSync(root, { recursive: true, force: false });
  } finally {
    fence.release();
  }
}

export function readInstallStatus(prefix: string): InstallMarker {
  const root = requireManagedRoot(prefix);
  return loadMarker(root);
}

function materializeRelease(candidate: VerifiedOssCandidate, releaseRoot: string): void {
  const releasesRoot = dirname(releaseRoot);
  if (existsSync(releasesRoot)) assertSafeDirectory(releasesRoot, 'Managed releases directory');
  else mkdirSync(releasesRoot, { mode: 0o700 });
  if (existsSync(releaseRoot)) {
    verifyMaterializedRelease(releaseRoot, candidate.candidateId);
    return;
  }
  const temporaryRoot = `${releaseRoot}.next`;
  if (existsSync(temporaryRoot)) {
    throw new Error('Managed release staging directory already exists.');
  }
  mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  try {
    for (const [path, bytes] of candidate.files) {
      const destination = join(temporaryRoot, ...path.split('/'));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, { mode: path.startsWith('bin/') ? 0o755 : 0o600 });
    }
    writeFileSync(join(temporaryRoot, '.candidate-id'), `${candidate.candidateId}\n`, {
      mode: 0o600,
    });
    verifyMaterializedRelease(temporaryRoot, candidate.candidateId);
    renameSync(temporaryRoot, releaseRoot);
  } catch (error) {
    if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: false });
    throw error;
  }
}

function verifyMaterializedRelease(releaseRoot: string, candidateId: string) {
  assertSafeDirectory(releaseRoot, 'Managed release directory');
  const idPath = join(releaseRoot, '.candidate-id');
  if (readRegularFile(idPath).toString('utf8') !== `${candidateId}\n`) {
    throw new Error('Managed release candidate identity does not match its directory.');
  }
  const manifestBytes = new Uint8Array(readRegularFile(join(releaseRoot, 'manifest.json')));
  const actualCandidateId = createHash('sha256').update(manifestBytes).digest('hex').slice(0, 24);
  if (actualCandidateId !== candidateId) throw new Error('Managed release manifest was replaced.');
  const manifest = ossCandidateManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
  );
  for (const entry of manifest.files) {
    const path = join(releaseRoot, ...entry.path.split('/'));
    if (!existsSync(path) || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`Managed release file is missing or unsafe: ${entry.path}`);
    }
    const bytes = readFileSync(path);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.byteLength !== entry.size || digest !== entry.sha256) {
      throw new Error(`Managed release file checksum mismatch: ${entry.path}`);
    }
  }
  return manifest;
}

function activateRelease(root: string, releaseRoot: string, windows: boolean): void {
  const suffix = windows ? '.exe' : '';
  const binRoot = join(root, 'bin');
  if (existsSync(binRoot)) assertSafeDirectory(binRoot, 'Managed bin directory');
  else mkdirSync(binRoot, { mode: 0o700 });
  for (const name of [`kite${suffix}`, `kite-tui${suffix}`, `kite-service${suffix}`]) {
    const destination = join(binRoot, name);
    if (existsSync(`${destination}.next`)) {
      throw new Error(`Managed activation temporary already exists: ${name}`);
    }
    if (existsSync(destination)) {
      const destinationStat = lstatSync(destination);
      if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
        throw new Error(`Managed launcher is unsafe: ${name}`);
      }
    }
  }
  for (const name of [`kite${suffix}`, `kite-tui${suffix}`, `kite-service${suffix}`]) {
    const source = join(releaseRoot, 'bin', name);
    const destination = join(binRoot, name);
    const temporary = `${destination}.next`;
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    if (!windows) chmodSync(temporary, 0o755);
    if (existsSync(destination)) {
      rmSync(destination, { force: false });
    }
    renameSync(temporary, destination);
  }
}

function prepareManagedRoot(prefix: string): string {
  const root = validatePrefixInput(prefix);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error('Install prefix cannot be a symbolic link.');
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!statSync(root).isDirectory()) throw new Error('Install prefix is not a directory.');
  return root;
}

function requireManagedRoot(prefix: string): string {
  const root = validatePrefixInput(prefix);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) {
    throw new Error('Managed install root is missing or unsafe.');
  }
  assertMarkerRoot(root, loadMarker(root));
  return root;
}

function validatePrefixInput(prefix: string): string {
  if (!prefix.trim()) throw new Error('Install prefix is required.');
  const root = resolve(prefix);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error('Install prefix cannot be a symbolic link.');
  }
  const home = realpathSync.native(userInfo().homedir);
  const repository = realpathSync.native(resolve(import.meta.dir, '../..'));
  const existingParent = nearestExistingParent(root);
  const canonicalRoot = resolve(
    realpathSync.native(existingParent),
    relative(existingParent, root),
  );
  const filesystemRoot = parse(canonicalRoot).root;
  if (
    samePath(canonicalRoot, filesystemRoot) ||
    (existsSync(canonicalRoot) && samePath(realpathSync.native(canonicalRoot), home))
  ) {
    throw new Error('Install prefix cannot be a filesystem root or the user home.');
  }
  if (isPathWithin(repository, canonicalRoot)) {
    throw new Error('Install prefix cannot be the repository root or one of its descendants.');
  }
  return canonicalRoot;
}

function nearestExistingParent(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Install prefix has no existing parent.');
    current = parent;
  }
  return current;
}

function markerPath(root: string): string {
  return join(root, MARKER_FILE);
}

function loadMarkerIfPresent(root: string): InstallMarker | undefined {
  return existsSync(markerPath(root)) ? loadMarker(root) : undefined;
}

function loadMarker(root: string): InstallMarker {
  try {
    return markerSchema.parse(JSON.parse(readRegularFile(markerPath(root)).toString('utf8')));
  } catch {
    throw new Error('Kite Code install marker is missing or invalid.');
  }
}

function assertMarkerRoot(root: string, marker: InstallMarker): void {
  if (marker.canonicalRoot !== realpathSync.native(root)) {
    throw new Error('Kite Code install marker does not match the canonical prefix.');
  }
}

function writeMarker(root: string, marker: InstallMarker): void {
  const parsed = markerSchema.parse(marker);
  const temporary = join(root, `${MARKER_FILE}.next`);
  assertMarkerWriteReady(root);
  writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  if (existsSync(markerPath(root))) {
    const markerStat = lstatSync(markerPath(root));
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
      throw new Error('Managed marker path is unsafe.');
    }
    rmSync(markerPath(root), { force: false });
  }
  renameSync(temporary, markerPath(root));
}

function assertMarkerWriteReady(root: string): void {
  const temporary = join(root, `${MARKER_FILE}.next`);
  if (existsSync(temporary)) throw new Error('Managed marker temporary already exists.');
  if (existsSync(markerPath(root))) {
    const markerStat = lstatSync(markerPath(root));
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
      throw new Error('Managed marker path is unsafe.');
    }
  }
}

function assertManagedTreeForUninstall(
  root: string,
  marker: InstallMarker,
  maxEntries: number,
): void {
  const expected = new Set<string>([MARKER_FILE, 'bin', 'releases']);
  const windows = marker.target.startsWith('windows-');
  const suffix = windows ? '.exe' : '';
  expected.add(`bin/kite${suffix}`);
  expected.add(`bin/kite-tui${suffix}`);
  expected.add(`bin/kite-service${suffix}`);
  const releasesRoot = join(root, 'releases');
  assertSafeDirectory(releasesRoot, 'Managed releases directory');
  const releaseIds = new Set<string>();
  for (const entry of readdirSync(releasesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) {
      throw new Error(`Managed releases directory contains an unknown entry: ${entry.name}`);
    }
    releaseIds.add(entry.name);
    const releaseRelative = `releases/${entry.name}`;
    expected.add(releaseRelative);
    const manifest = verifyMaterializedRelease(join(root, releaseRelative), entry.name);
    if (entry.name === marker.currentCandidateId && manifest.target.id !== marker.target) {
      throw new Error('Managed marker target does not match the active release.');
    }
    for (const path of ['.candidate-id', 'manifest.json', 'CHECKSUMS.sha256']) {
      expected.add(`${releaseRelative}/${path}`);
    }
    for (const file of manifest.files) addExpectedPath(expected, `${releaseRelative}/${file.path}`);
  }
  if (!releaseIds.has(marker.currentCandidateId)) {
    throw new Error('Managed active release is missing.');
  }
  if (marker.previousCandidateId && !releaseIds.has(marker.previousCandidateId)) {
    throw new Error('Managed rollback release is missing.');
  }
  verifyActiveLauncher(root, marker.currentCandidateId, `kite${suffix}`);
  verifyActiveLauncher(root, marker.currentCandidateId, `kite-tui${suffix}`);
  verifyActiveLauncher(root, marker.currentCandidateId, `kite-service${suffix}`);

  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > maxEntries)
        throw new Error('Managed install tree exceeds the uninstall safety bound.');
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (!expected.has(relativePath)) {
        throw new Error(`Managed install contains an unknown entry: ${relativePath}`);
      }
      if (entry.isSymbolicLink())
        throw new Error(`Managed install contains a symbolic link: ${path}`);
      if (entry.isDirectory()) pending.push(path);
      else if (!entry.isFile())
        throw new Error(`Managed install contains an unsupported entry: ${path}`);
    }
  }
}

function verifyActiveLauncher(root: string, candidateId: string, name: string): void {
  const active = readRegularFile(join(root, 'bin', name));
  const stored = readRegularFile(join(root, 'releases', candidateId, 'bin', name));
  if (!active.equals(stored)) throw new Error(`Managed active launcher does not match: ${name}`);
}

function ordinaryStopManagedService(root: string, marker: InstallMarker): void {
  const suffix = marker.target.startsWith('windows-') ? '.exe' : '';
  const executable = join(root, 'bin', `kite${suffix}`);
  const spawnOptions = {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.platform === 'win32'
        ? { USERPROFILE: userInfo().homedir }
        : { HOME: userInfo().homedir }),
    },
  } as const;
  const stopped = Bun.spawnSync([executable, 'service', 'stop'], spawnOptions);
  if (stopped.exitCode !== 0) {
    throw new Error('Managed Service ordinary stop failed; active candidate is unchanged.');
  }
  const status = Bun.spawnSync([executable, 'service', 'status', '--json'], spawnOptions);
  if (status.exitCode !== 0) {
    throw new Error('Managed Service stop could not be confirmed; active candidate is unchanged.');
  }
  let value: unknown;
  try {
    value = JSON.parse(status.stdout.toString()) as unknown;
  } catch {
    throw new Error(
      'Managed Service stop returned an invalid result; active candidate is unchanged.',
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('outcome' in value) ||
    value.outcome !== 'applied' ||
    !('state' in value) ||
    value.state !== 'absent'
  ) {
    throw new Error('Managed Service is busy or unavailable; active candidate is unchanged.');
  }
}

function acquireInstallerServiceFence(
  suppliedIdentity?: KiteHomeIdentity,
): LocalRuntimeServiceDirectoryLock {
  let identity = suppliedIdentity;
  if (!identity) {
    const systemHome = realpathSync.native(userInfo().homedir);
    const codeRoot = join(systemHome, '.kite-code');
    mkdirSync(codeRoot, { recursive: true, mode: 0o700 });
    identity = createKiteHomeIdentity(realpathSync.native(codeRoot), 'os_user_home');
  }
  const paths = ensureLocalRuntimeServiceStateRoot(identity);
  const lock = tryAcquireLocalRuntimeServiceLock(paths, 'lifecycle', {
    schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
    nonce: randomBytes(24).toString('base64url'),
    pid: process.pid,
    operation: 'restart',
    createdAt: new Date().toISOString(),
  });
  if (!lock) {
    throw new Error('Managed Service lifecycle is busy; active candidate is unchanged.');
  }
  try {
    if (
      readLocalRuntimeServiceDescriptor(paths) !== undefined ||
      readLocalRuntimeServiceToken(paths, 'access') !== undefined ||
      readLocalRuntimeServiceToken(paths, 'control') !== undefined ||
      readLocalRuntimeServiceLockIdentity(paths, 'instance') !== undefined
    ) {
      throw new Error('Managed Service owner is still present; active candidate is unchanged.');
    }
    return lock;
  } catch (error) {
    lock.release();
    throw error;
  }
}

function addExpectedPath(expected: Set<string>, path: string): void {
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    expected.add(parts.slice(0, index).join('/'));
  }
}

function assertSafeDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing.`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is unsafe.`);
}

function readRegularFile(path: string): Buffer {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Managed file is unsafe: ${path}`);
  return readFileSync(path);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (import.meta.main) {
  const action = process.argv[2] ?? 'status';
  const prefix = option('--prefix', defaultInstallPrefix());
  if (!prefix) throw new Error('--prefix requires a path.');
  if (action === 'install') {
    const archivePath = option('--archive', defaultOssCandidateArchivePath());
    if (!archivePath) throw new Error('--archive requires a path.');
    const marker = await installOssCandidate({ archivePath, prefix });
    console.log(JSON.stringify({ status: 'installed', prefix: resolve(prefix), ...marker }));
  } else if (action === 'rollback') {
    const marker = rollbackOssCandidate(prefix);
    console.log(JSON.stringify({ status: 'rolled_back', prefix: resolve(prefix), ...marker }));
  } else if (action === 'uninstall') {
    uninstallOssCandidate(prefix);
    console.log(JSON.stringify({ status: 'uninstalled', prefix: resolve(prefix) }));
  } else if (action === 'status') {
    console.log(
      JSON.stringify({
        status: 'installed',
        prefix: resolve(prefix),
        ...readInstallStatus(prefix),
      }),
    );
  } else {
    throw new Error(`Unknown installer action: ${action}`);
  }
}
