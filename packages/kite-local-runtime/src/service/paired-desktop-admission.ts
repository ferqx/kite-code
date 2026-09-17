import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type PairedDesktopServiceManifest,
  pairedDesktopManifestDigest,
  parsePairedDesktopServiceManifest,
} from '../paired-desktop-manifest';
import {
  type LegacyKiteProcessIdentity,
  observeLegacyKiteStoreProcesses,
  readKitePairedDesktopParentIdentity,
} from './legacy-store-processes';

export type PairedDesktopStoreAdmissionReason =
  | 'unsupported_platform'
  | 'desktop_identity_mismatch'
  | 'paired_manifest_mismatch'
  | 'desktop_parent_unverified'
  | 'other_distribution_differs'
  | 'other_distribution_unknown'
  | 'distribution_inspection_incomplete'
  | 'legacy_process_busy'
  | 'legacy_process_inspection_incomplete';

export type PairedDesktopStoreAdmission =
  | { readonly admitted: false; readonly reason: PairedDesktopStoreAdmissionReason }
  | {
      readonly admitted: true;
      readonly evidence: {
        readonly scope: 'paired_desktop';
        readonly serviceSha256: string;
        readonly manifestSha256: string;
        readonly parent: LegacyKiteProcessIdentity;
        readonly observedAt: string;
      };
    };

/** Standalone artifact check used by the admission reviewer; no process or user Store access. */
export function verifyPairedDesktopServiceArtifact(input: {
  readonly executablePath: string;
  readonly expectedManifestDigest: string;
  readonly expectedBuildId: string;
}): {
  readonly serviceSha256: string;
  readonly manifestSha256: string;
  readonly manifest: PairedDesktopServiceManifest;
} {
  const manifestPath = join(dirname(input.executablePath), 'desktop.json');
  const bytes = readSmallRegularFile(manifestPath, 16_384);
  const manifest = parsePairedDesktopServiceManifest(JSON.parse(bytes.toString('utf8')) as unknown);
  const manifestSha256 = pairedDesktopManifestDigest(manifest);
  if (
    !/^[a-f0-9]{64}$/u.test(input.expectedManifestDigest) ||
    manifestSha256 !== input.expectedManifestDigest ||
    manifest.buildId !== input.expectedBuildId ||
    manifest.expectedServerVersion !==
      `kite-app-server-v1-${createHash('sha256').update(manifest.buildId).digest('hex')}`
  )
    throw new Error('Paired Desktop manifest does not match the embedded host identity.');
  const serviceSha256 = hashRegularFile(input.executablePath);
  if (serviceSha256 !== manifest.executableSha256) {
    throw new Error('Paired Desktop Service executable does not match its manifest.');
  }
  return Object.freeze({ manifest, manifestSha256, serviceSha256 });
}

/** Review only paired Desktop entrypoints; maintenance and source revalidation belong to Service. */
export function reviewPairedDesktopStoreAdmission(input: {
  readonly canonicalKiteHome: string;
  readonly runtimeRoot: string;
  readonly sourceRepositoryRoot?: string;
  readonly knownManagedPrefixes?: readonly string[];
}): PairedDesktopStoreAdmission {
  if (process.platform !== 'darwin') return { admitted: false, reason: 'unsupported_platform' };
  let home: string;
  let runtimeRoot: string;
  let executablePath: string;
  try {
    home = realpathSync.native(input.canonicalKiteHome);
    runtimeRoot = realpathSync.native(input.runtimeRoot);
    executablePath = realpathSync.native(process.execPath);
  } catch {
    return { admitted: false, reason: 'desktop_identity_mismatch' };
  }
  const environment = process.env;
  if (
    environment.KITE_STANDALONE_EXECUTABLE !== '1' ||
    environment.KITE_CODE_HOME !== runtimeRoot ||
    environment.KITE_CODE_CONFIG_HOME !== home ||
    process.argv[2] !== 'app-server' ||
    process.argv[3] !== 'run-stdio' ||
    process.argv.length !== 4 ||
    runtimeRoot === join(home, 'source-profiles') ||
    runtimeRoot.startsWith(`${join(home, 'source-profiles')}/`)
  )
    return { admitted: false, reason: 'desktop_identity_mismatch' };
  let paired: ReturnType<typeof verifyPairedDesktopServiceArtifact>;
  try {
    paired = verifyPairedDesktopServiceArtifact({
      executablePath,
      expectedManifestDigest: environment.KITE_DESKTOP_PAIRED_MANIFEST_SHA256 ?? '',
      expectedBuildId: environment.KITE_APP_SERVER_BUILD_ID ?? '',
    });
  } catch {
    return { admitted: false, reason: 'paired_manifest_mismatch' };
  }
  const parent = readKitePairedDesktopParentIdentity({
    pid: process.ppid,
    serviceExecutablePath: executablePath,
    ...(input.sourceRepositoryRoot ? { sourceRepositoryRoot: input.sourceRepositoryRoot } : {}),
  });
  if (!parent) return { admitted: false, reason: 'desktop_parent_unverified' };
  const distribution = inspectPairedDesktopDistribution({
    serviceSha256: paired.serviceSha256,
    manifestSha256: paired.manifestSha256,
    knownManagedPrefixes: input.knownManagedPrefixes ?? [],
    searchPath: environment.PATH ?? '',
  });
  if (distribution !== 'clear') return { admitted: false, reason: distribution };
  const observation = observeLegacyKiteStoreProcesses({
    exclude: [parent],
    managedInstallPrefixes: input.knownManagedPrefixes,
  });
  if (observation.status === 'busy') return { admitted: false, reason: 'legacy_process_busy' };
  if (observation.status !== 'complete')
    return { admitted: false, reason: 'legacy_process_inspection_incomplete' };
  return {
    admitted: true,
    evidence: {
      scope: 'paired_desktop',
      serviceSha256: paired.serviceSha256,
      manifestSha256: paired.manifestSha256,
      parent,
      observedAt: new Date().toISOString(),
    },
  };
}

/** Fixed platform locations plus explicit managed prefixes; an unknown Kite PATH slot refuses. */
export function inspectPairedDesktopDistribution(input: {
  readonly serviceSha256: string;
  readonly manifestSha256: string;
  readonly knownManagedPrefixes: readonly string[];
  readonly searchPath: string;
  readonly defaultManagedPrefix?: string;
  readonly applicationRoots?: readonly string[];
}):
  | 'clear'
  | 'other_distribution_differs'
  | 'other_distribution_unknown'
  | 'distribution_inspection_incomplete' {
  const home = userInfo().homedir;
  const prefixes = [
    input.defaultManagedPrefix ?? join(home, '.local/share/kite-code'),
    ...input.knownManagedPrefixes,
  ];
  const applications = input.applicationRoots ?? ['/Applications', join(home, 'Applications')];
  if (
    prefixes.some((value) => !isAbsolute(value)) ||
    applications.some((value) => !isAbsolute(value))
  )
    return 'distribution_inspection_incomplete';
  try {
    for (const prefix of prefixes) {
      if (!lstatSync(prefix, { throwIfNoEntry: false })) continue;
      const active = readSmallRegularFile(join(prefix, 'active'), 64).toString('utf8');
      if (!/^[a-f0-9]{24}\n$/u.test(active)) return 'other_distribution_unknown';
      const candidate = join(prefix, 'releases', active.trim(), 'bin', 'kite-service');
      if (hashRegularFile(candidate) !== input.serviceSha256) return 'other_distribution_differs';
    }
    if (!input.searchPath) return 'distribution_inspection_incomplete';
    for (const directory of input.searchPath.split(':')) {
      if (!isAbsolute(directory)) return 'distribution_inspection_incomplete';
      let names: string[];
      try {
        names = readdirSync(directory);
      } catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) continue;
        throw error;
      }
      if (!names.some((name) => /^(?:kite|kite-tui|kite-service)(?:\.exe)?$/iu.test(name)))
        continue;
      const known = prefixes.some((prefix) => directory === join(prefix, 'bin'));
      if (!known) return 'other_distribution_unknown';
    }
    for (const root of applications) {
      const stat = lstatSync(root, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return 'distribution_inspection_incomplete';
      for (const name of readdirSync(root)) {
        if (!/^kite\.app$/iu.test(name)) continue;
        const service = join(root, name, 'Contents/Resources/service/kite-service');
        if (hashRegularFile(service) !== input.serviceSha256) return 'other_distribution_differs';
        const manifestBytes = readSmallRegularFile(join(dirname(service), 'desktop.json'), 16_384);
        if (
          pairedDesktopManifestDigest(JSON.parse(manifestBytes.toString('utf8')) as unknown) !==
          input.manifestSha256
        )
          return 'other_distribution_differs';
      }
    }
    return 'clear';
  } catch {
    return 'distribution_inspection_incomplete';
  }
}

function readSmallRegularFile(path: string, maxBytes: number): Buffer {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > maxBytes
  )
    throw new Error('Paired Desktop file is not a bounded regular file.');
  return readFileSync(path);
}

function hashRegularFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('Paired Desktop executable is unsafe.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size)
      throw new Error('Paired Desktop executable changed while opening.');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw new Error('Paired Desktop executable changed while hashing.');
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
