import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
  ensureLocalRuntimeServiceHome,
  ensureLocalRuntimeServiceStateRoot,
  type KiteHomeIdentity,
  LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
  type LocalRuntimeServiceDirectoryLock,
  tryAcquireLocalRuntimeServiceLock,
} from '@kite-ai/kite-local-runtime/service';
import { z } from 'zod';
import {
  currentOssReleaseTarget,
  defaultOssCandidateArchivePath,
  ossCandidateManifestSchema,
  releaseLauncherArchivePaths,
  type VerifiedOssCandidate,
  verifyOssCandidate,
} from './oss-candidate';

const markerSchema = z
  .object({
    schema: z.literal('KiteCodeManagedInstall'),
    version: z.literal(2),
    canonicalRoot: z.string().min(1),
    currentCandidateId: z.string().regex(/^[a-f0-9]{24}$/),
    previousCandidateId: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .nullable(),
    target: z.string().regex(/^(macos|linux|windows)-(arm64|x64)$/),
    activePointer: z.literal('active'),
  })
  .strict();

export type InstallMarker = z.infer<typeof markerSchema>;
const MARKER_FILE = '.kite-code-managed.json';
export const ACTIVE_RELEASE_POINTER_FILE = 'active' as const;
const INSTALL_MARKER_VERSION = 2 as const;

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
  }
  const fence = acquireInstallerServiceFence(input.serviceHome);
  try {
    const releaseRoot = join(root, 'releases', candidate.candidateId);
    materializeRelease(candidate, releaseRoot);
    const manifest = verifyMaterializedRelease(releaseRoot, candidate.candidateId);
    assertInstallableRelease(manifest);
    assertMarkerWriteReady(root);
    activateRelease(root, releaseRoot, manifest);
    const marker: InstallMarker = {
      schema: 'KiteCodeManagedInstall',
      version: INSTALL_MARKER_VERSION,
      canonicalRoot: realpathSync.native(root),
      currentCandidateId: candidate.candidateId,
      previousCandidateId:
        existing && existing.currentCandidateId !== candidate.candidateId
          ? existing.currentCandidateId
          : (existing?.previousCandidateId ?? null),
      target: candidate.manifest.target.id,
      activePointer: ACTIVE_RELEASE_POINTER_FILE,
    };
    writeActiveReleasePointer(root, candidate.candidateId);
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
  const releaseRoot = join(root, 'releases', marker.previousCandidateId);
  const manifest = verifyMaterializedRelease(releaseRoot, marker.previousCandidateId);
  assertInstallableRelease(manifest);
  const fence = acquireInstallerServiceFence(options.serviceHome);
  try {
    assertMarkerWriteReady(root);
    activateRelease(root, releaseRoot, manifest);
    const next: InstallMarker = {
      ...marker,
      currentCandidateId: marker.previousCandidateId,
      previousCandidateId: marker.currentCandidateId,
      target: manifest.target.id,
    };
    writeActiveReleasePointer(root, marker.previousCandidateId);
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
  ordinaryStopManagedService(root, marker, options.serviceHome);
  const fence = acquireInstallerServiceFence(options.serviceHome);
  try {
    rmSync(root, { recursive: true, force: false });
  } finally {
    fence.release();
  }
}

export function readInstallStatus(prefix: string): InstallMarker {
  const root = requireManagedRoot(prefix);
  const marker = loadMarker(root);
  assertActiveReleasePointer(root, marker);
  return marker;
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
    syncDirectory(releasesRoot);
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

function activateRelease(
  root: string,
  releaseRoot: string,
  manifest: z.infer<typeof ossCandidateManifestSchema>,
): void {
  assertInstallableRelease(manifest);
  const suffix = manifest.target.os === 'win32' ? '.exe' : '';
  const binRoot = join(root, 'bin');
  if (existsSync(binRoot)) assertSafeDirectory(binRoot, 'Managed bin directory');
  else mkdirSync(binRoot, { mode: 0o700 });
  const launcherPaths = releaseLauncherArchivePaths(manifest);
  const launchers = [
    [`kite${suffix}`, launcherPaths.cli],
    [`kite-tui${suffix}`, launcherPaths.tui],
    [`kite-service${suffix}`, launcherPaths.service],
    [`kite-coordinator${suffix}`, launcherPaths.coordinator],
    [`kite-worker${suffix}`, launcherPaths.worker],
    [`kite-web-gateway${suffix}`, launcherPaths.gateway],
  ] as const;
  for (const [name] of launchers) {
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
  for (const [name, archivePath] of launchers) {
    const source = join(releaseRoot, ...archivePath.split('/'));
    const destination = join(binRoot, name);
    if (existsSync(destination)) {
      const active = readRegularFile(destination);
      const expected = readRegularFile(source);
      if (!active.equals(expected)) {
        throw new Error(`Stable launcher identity changed: ${name}`);
      }
      continue;
    }
    const temporary = `${destination}.next`;
    copyRegularFileAtomically(source, temporary, destination, 0o755);
  }
}

function assertInstallableRelease(manifest: z.infer<typeof ossCandidateManifestSchema>): void {
  if (manifest.releaseSlots === undefined) {
    throw new Error('Candidate is missing the release slot manifest; legacy candidate is blocked.');
  }
  const expected = executableArchivePathsForManifest(manifest);
  const files = new Set(manifest.files.map((entry) => entry.path));
  for (const [name, path] of Object.entries(expected)) {
    if (!files.has(path))
      throw new Error(`Candidate release slot ${name} is not archived: ${path}`);
  }
  const web = manifest.releaseSlots.web;
  if (web.entrypoint !== 'payload/web/index.html' || web.identity === null) {
    throw new Error('Candidate release slot web is not bound to its fixed payload entrypoint.');
  }
  if (!files.has(web.entrypoint)) {
    throw new Error(`Candidate release slot web is not archived: ${web.entrypoint}`);
  }
  if (!files.has('payload/web/api-docs/openapi.json')) {
    throw new Error('Candidate Web payload is missing its bundled Agent API contract.');
  }
  const launchers = releaseLauncherArchivePaths(manifest);
  for (const path of Object.values(launchers)) {
    if (!files.has(path)) throw new Error(`Candidate stable launcher is not archived: ${path}`);
  }
}

function executableArchivePathsForManifest(manifest: z.infer<typeof ossCandidateManifestSchema>): {
  cli: string;
  tui: string;
  service: string;
  coordinator: string;
  worker: string;
  gateway: string;
} {
  const suffix = manifest.target.os === 'win32' ? '.exe' : '';
  const slots = manifest.releaseSlots;
  if (!slots) throw new Error('Candidate release slots are unavailable.');
  const expected = {
    cli: `bin/kite${suffix}`,
    tui: `bin/kite-tui${suffix}`,
    service: `bin/kite-service${suffix}`,
    coordinator: `bin/kite-coordinator${suffix}`,
    worker: `bin/kite-worker${suffix}`,
    gateway: `bin/kite-web-gateway${suffix}`,
  } as const;
  for (const [name, path] of Object.entries(expected)) {
    const slot = slots[name as keyof typeof expected];
    if (slot.entrypoint !== path || slot.identity === null) {
      throw new Error(`Candidate release slot ${name} is not bound to its executable.`);
    }
  }
  return expected;
}

function copyRegularFileAtomically(
  source: string,
  temporary: string,
  destination: string,
  mode: number,
): void {
  const bytes = readRegularFile(source);
  writeFileSync(temporary, bytes, { mode, flag: 'wx' });
  try {
    chmodSync(temporary, mode);
    syncRegularFile(temporary);
    if (existsSync(destination)) {
      throw new Error(`Managed launcher appeared during activation: ${destination}`);
    }
    renameSync(temporary, destination);
    syncDirectory(dirname(destination));
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: false });
    throw error;
  }
}

function writeActiveReleasePointer(root: string, candidateId: string): void {
  if (!/^[a-f0-9]{24}$/u.test(candidateId))
    throw new Error('Active release candidate identity is invalid.');
  const pointer = join(root, ACTIVE_RELEASE_POINTER_FILE);
  if (existsSync(pointer)) {
    const stat = lstatSync(pointer);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error('Active release pointer is unsafe.');
  }
  const temporary = `${pointer}.next`;
  if (existsSync(temporary)) throw new Error('Active release pointer temporary already exists.');
  writeFileSync(temporary, `${candidateId}\n`, { mode: 0o600, flag: 'wx' });
  try {
    syncRegularFile(temporary);
    renameSync(temporary, pointer);
    syncDirectory(root);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: false });
    throw new Error('Active release pointer could not be atomically replaced.', { cause: error });
  }
}

function readActiveReleasePointer(root: string): string {
  const pointer = join(root, ACTIVE_RELEASE_POINTER_FILE);
  const value = readRegularFile(pointer).toString('utf8');
  if (!/^[a-f0-9]{24}\n$/u.test(value)) throw new Error('Active release pointer is invalid.');
  return value.trim();
}

function syncRegularFile(path: string): void {
  // Windows FlushFileBuffers requires a handle opened with write access. Bun
  // surfaces the read-only-handle rejection as EPERM even for a regular file.
  const descriptor = openSync(path, process.platform === 'win32' ? 'r+' : 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  // Windows has no portable directory-fsync primitive in Node. The temporary
  // regular file is still flushed before atomic rename; Windows write-through
  // durability remains a platform qualification requirement.
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
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
  syncDirectory(root);
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
  const expected = new Set<string>([MARKER_FILE, ACTIVE_RELEASE_POINTER_FILE, 'bin', 'releases']);
  const windows = marker.target.startsWith('windows-');
  const suffix = windows ? '.exe' : '';
  expected.add(`bin/kite${suffix}`);
  expected.add(`bin/kite-tui${suffix}`);
  expected.add(`bin/kite-service${suffix}`);
  expected.add(`bin/kite-coordinator${suffix}`);
  expected.add(`bin/kite-worker${suffix}`);
  expected.add(`bin/kite-web-gateway${suffix}`);
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
    assertInstallableRelease(manifest);
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
  assertActiveReleasePointer(root, marker);
  const activeManifest = verifyMaterializedRelease(
    join(root, 'releases', marker.currentCandidateId),
    marker.currentCandidateId,
  );
  assertInstallableRelease(activeManifest);
  verifyActiveLauncher(root, marker.currentCandidateId, activeManifest, `kite${suffix}`);
  verifyActiveLauncher(root, marker.currentCandidateId, activeManifest, `kite-tui${suffix}`);
  verifyActiveLauncher(root, marker.currentCandidateId, activeManifest, `kite-service${suffix}`);
  verifyActiveLauncher(
    root,
    marker.currentCandidateId,
    activeManifest,
    `kite-coordinator${suffix}`,
  );
  verifyActiveLauncher(root, marker.currentCandidateId, activeManifest, `kite-worker${suffix}`);
  verifyActiveLauncher(
    root,
    marker.currentCandidateId,
    activeManifest,
    `kite-web-gateway${suffix}`,
  );

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

function assertActiveReleasePointer(root: string, marker: InstallMarker): void {
  if (marker.activePointer !== ACTIVE_RELEASE_POINTER_FILE) {
    throw new Error('Managed marker points to an unsupported active release pointer.');
  }
  if (readActiveReleasePointer(root) !== marker.currentCandidateId) {
    throw new Error('Managed active release pointer does not match its marker.');
  }
}

function verifyActiveLauncher(
  root: string,
  candidateId: string,
  manifest: z.infer<typeof ossCandidateManifestSchema>,
  name: string,
): void {
  const launcherPaths = releaseLauncherArchivePaths(manifest);
  const archivePath = name.startsWith('kite-service')
    ? launcherPaths.service
    : name.startsWith('kite-tui')
      ? launcherPaths.tui
      : launcherPaths.cli;
  const active = readRegularFile(join(root, 'bin', name));
  const stored = readRegularFile(join(root, 'releases', candidateId, ...archivePath.split('/')));
  if (!active.equals(stored)) throw new Error(`Managed active launcher does not match: ${name}`);
}

function ordinaryStopManagedService(
  root: string,
  marker: InstallMarker,
  serviceHome?: KiteHomeIdentity,
): void {
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
  const homeArguments = serviceHome ? ['--kite-home', serviceHome.root] : [];
  const stopped = Bun.spawnSync([executable, 'service', 'stop', ...homeArguments], spawnOptions);
  if (stopped.exitCode !== 0) {
    throw new Error('Managed Service ordinary stop failed; active candidate is unchanged.');
  }
  const status = Bun.spawnSync(
    [executable, 'service', 'status', '--json', ...homeArguments],
    spawnOptions,
  );
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
    identity = ensureLocalRuntimeServiceHome(createKiteHomeIdentity(codeRoot, 'os_user_home'));
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
  // This fence serializes installer lifecycle operations but deliberately does not
  // inspect or stop the running companion. Pointer activation is independent from
  // an already-running immutable candidate process.
  return lock;
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
