import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const releaseFileSchema = z
  .object({
    path: z.string().regex(/^(bin|docs)\/[A-Za-z0-9._-]+$/),
    sha256: digestSchema,
    size: z.number().int().nonnegative(),
  })
  .strict();

export const ossCandidateManifestV1Schema = z
  .object({
    schema: z.literal('KiteCodeOssCandidateManifestV1'),
    version: z.literal(1),
    productVersion: z.string().trim().min(1).max(128),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    sourceDate: z.string().datetime({ offset: true }),
    sourceDirty: z.boolean(),
    bunVersion: z.string().trim().min(1).max(64),
    target: z
      .object({
        id: z.string().regex(/^(macos|linux|windows)-(arm64|x64)$/),
        os: z.enum(['darwin', 'linux', 'win32']),
        arch: z.enum(['arm64', 'x64']),
        compileMode: z.literal('native'),
      })
      .strict(),
    integrity: z.literal('sha256-only-unsigned'),
    defaultCapabilities: z
      .object({
        autoCompaction: z.literal('off'),
        effectfulCapabilities: z.literal('off'),
        remoteTelemetry: z.literal('off'),
      })
      .strict(),
    files: z.array(releaseFileSchema).min(5).max(16),
  })
  .strict();

export type OssCandidateManifestV1 = z.infer<typeof ossCandidateManifestV1Schema>;

export interface OssReleaseTarget {
  id: string;
  os: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  executableSuffix: '' | '.exe';
}

export interface VerifiedOssCandidate {
  archivePath: string;
  archiveSha256: `sha256:${string}`;
  manifest: OssCandidateManifestV1;
  manifestBytes: Uint8Array;
  manifestSha256: `sha256:${string}`;
  candidateId: string;
  files: ReadonlyMap<string, Uint8Array>;
}

const RELEASE_ASSETS = [
  ['docs/MAINTAINER_CHECKLIST.md', 'release/oss-first-release/MAINTAINER_CHECKLIST.md'],
  ['docs/KNOWN_LIMITATIONS.md', 'release/oss-first-release/KNOWN_LIMITATIONS.md'],
  ['docs/RELEASE_NOTES.md', 'release/oss-first-release/RELEASE_NOTES.md'],
] as const;

export function currentOssReleaseTarget(): OssReleaseTarget {
  return resolveOssReleaseTarget(process.platform, process.arch);
}

export function resolveOssReleaseTarget(platform: NodeJS.Platform, arch: string): OssReleaseTarget {
  if (platform === 'darwin' && arch === 'arm64') {
    return target('macos-arm64', 'darwin', 'arm64');
  }
  if (platform === 'darwin' && arch === 'x64') {
    return target('macos-x64', 'darwin', 'x64');
  }
  if (platform === 'linux' && arch === 'arm64') {
    return target('linux-arm64', 'linux', 'arm64');
  }
  if (platform === 'linux' && arch === 'x64') {
    return target('linux-x64', 'linux', 'x64');
  }
  if (platform === 'win32' && arch === 'arm64') {
    return target('windows-arm64', 'win32', 'arm64');
  }
  if (platform === 'win32' && arch === 'x64') {
    return target('windows-x64', 'win32', 'x64');
  }
  throw new Error(`Unsupported release target: ${platform}/${arch}`);
}

export function defaultOssCandidateArchivePath(targetValue = currentOssReleaseTarget()): string {
  return resolve('dist', 'oss-candidate', `kite-code-${targetValue.id}.tar.gz`);
}

export async function buildOssCandidate(
  input: {
    target?: OssReleaseTarget;
    archivePath?: string;
    productVersion?: string;
    commitSha?: string;
    sourceDate?: string;
  } = {},
): Promise<VerifiedOssCandidate> {
  const releaseTarget = input.target ?? currentOssReleaseTarget();
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    version?: unknown;
  };
  const productVersion =
    input.productVersion ?? expectString(packageJson.version, 'package version');
  const commitSha = input.commitSha ?? gitOutput(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error('Release commit must be a full SHA-1.');
  const sourceDate = canonicalSourceDate(
    input.sourceDate ?? gitOutput(['show', '-s', '--format=%cI', commitSha]),
  );
  const sourceDirty = gitOutput(['status', '--porcelain']).length > 0;
  const archivePath = resolve(input.archivePath ?? defaultOssCandidateArchivePath(releaseTarget));
  if (releaseTarget.os !== process.platform || releaseTarget.arch !== process.arch) {
    throw new Error(
      `Candidate builds must run natively on ${releaseTarget.os}/${releaseTarget.arch}; current host is ${process.platform}/${process.arch}.`,
    );
  }
  const stageDirectory = join(dirname(archivePath), '.stage', releaseTarget.id);
  mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });

  const executableSuffix = releaseTarget.executableSuffix;
  const cliPath = join(stageDirectory, `kite${executableSuffix}`);
  const tuiPath = join(stageDirectory, `kite-tui${executableSuffix}`);
  await compileExecutable('scripts/release/entrypoints/cli.ts', cliPath);
  await compileExecutable('scripts/release/entrypoints/tui.ts', tuiPath);
  if (process.platform !== 'win32') {
    chmodSync(cliPath, 0o755);
    chmodSync(tuiPath, 0o755);
  }

  const archiveFiles = new Map<string, Uint8Array>();
  archiveFiles.set(`bin/kite${executableSuffix}`, readBytes(cliPath));
  archiveFiles.set(`bin/kite-tui${executableSuffix}`, readBytes(tuiPath));
  for (const [archiveName, sourcePath] of RELEASE_ASSETS) {
    archiveFiles.set(archiveName, readBytes(resolve(sourcePath)));
  }
  const releaseFiles = [...archiveFiles]
    .map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.byteLength }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: OssCandidateManifestV1 = ossCandidateManifestV1Schema.parse({
    schema: 'KiteCodeOssCandidateManifestV1',
    version: 1,
    productVersion,
    commitSha,
    sourceDate,
    sourceDirty,
    bunVersion: Bun.version,
    target: {
      id: releaseTarget.id,
      os: releaseTarget.os,
      arch: releaseTarget.arch,
      compileMode: 'native',
    },
    integrity: 'sha256-only-unsigned',
    defaultCapabilities: {
      autoCompaction: 'off',
      effectfulCapabilities: 'off',
      remoteTelemetry: 'off',
    },
    files: releaseFiles,
  });
  await writeOssCandidateArchive({ archivePath, manifest, files: archiveFiles });
  return verifyOssCandidate(archivePath, releaseTarget.id);
}

export async function verifyOssCandidate(
  archiveInput: string,
  expectedTargetId?: string,
): Promise<VerifiedOssCandidate> {
  const archivePath = resolve(archiveInput);
  const archiveBytes = readBytes(archivePath);
  const archiveSha256 = sha256(archiveBytes);
  verifyArchiveSidecar(archivePath, archiveSha256);
  const tarPaths = listRegularTarPaths(archiveBytes);
  const archive = new Bun.Archive(archiveBytes);
  const archived = await archive.files();
  const files = new Map<string, Uint8Array>();
  for (const [path, file] of archived) files.set(path, new Uint8Array(await file.arrayBuffer()));
  if (tarPaths.length !== files.size || tarPaths.some((path) => !files.has(path))) {
    throw new Error('Archive contains unsupported or non-regular entries.');
  }
  const manifestBytes = requiredFile(files, 'manifest.json');
  const manifest = ossCandidateManifestV1Schema.parse(parseJson(manifestBytes, 'manifest'));
  if (expectedTargetId && manifest.target.id !== expectedTargetId) {
    throw new Error(`Candidate target ${manifest.target.id} does not match ${expectedTargetId}.`);
  }
  const expectedPaths = new Set([
    'manifest.json',
    'CHECKSUMS.sha256',
    ...manifest.files.map((entry) => entry.path),
  ]);
  if (
    files.size !== expectedPaths.size ||
    [...files.keys()].some((path) => !expectedPaths.has(path))
  ) {
    throw new Error('Candidate archive has missing or unknown files.');
  }
  const uniqueManifestPaths = new Set(manifest.files.map((entry) => entry.path));
  if (uniqueManifestPaths.size !== manifest.files.length) {
    throw new Error('Candidate manifest repeats a file path.');
  }
  for (const entry of manifest.files) {
    const bytes = requiredFile(files, entry.path);
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`Candidate file checksum mismatch: ${entry.path}`);
    }
  }
  const expectedChecksums = encodeChecksums(manifest.files);
  if (new TextDecoder().decode(requiredFile(files, 'CHECKSUMS.sha256')) !== expectedChecksums) {
    throw new Error('CHECKSUMS.sha256 does not match the manifest.');
  }
  const manifestSha256 = sha256(manifestBytes);
  return {
    archivePath,
    archiveSha256,
    manifest,
    manifestBytes,
    manifestSha256,
    candidateId: manifestSha256.slice('sha256:'.length, 'sha256:'.length + 24),
    files,
  };
}

export async function createSmokeVariantCandidate(
  verified: VerifiedOssCandidate,
  archivePath: string,
): Promise<VerifiedOssCandidate> {
  const files = new Map<string, Uint8Array>();
  for (const entry of verified.manifest.files)
    files.set(entry.path, requiredFile(verified.files, entry.path));
  const manifest = ossCandidateManifestV1Schema.parse({
    ...verified.manifest,
    productVersion: `${verified.manifest.productVersion}-smoke-next`,
  });
  await writeOssCandidateArchive({ archivePath, manifest, files });
  return verifyOssCandidate(archivePath, manifest.target.id);
}

export function executableArchivePaths(manifest: OssCandidateManifestV1): {
  cli: string;
  tui: string;
} {
  const suffix = manifest.target.os === 'win32' ? '.exe' : '';
  return { cli: `bin/kite${suffix}`, tui: `bin/kite-tui${suffix}` };
}

async function compileExecutable(entrypoint: string, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(entrypoint)],
    compile: {
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
    minify: true,
    sourcemap: 'none',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [
      {
        name: 'standalone-release-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({
            path: 'react-devtools-core',
            namespace: 'kite-release-stub',
          }));
          builder.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({
            path: '@napi-rs/keyring',
            namespace: 'kite-keyring-stub',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'kite-release-stub' }, () => ({
            contents: 'export default { initialize() {}, connectToDevTools() {} };',
            loader: 'js',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'kite-keyring-stub' }, () => ({
            contents: `
              const unavailable = () => {
                throw new Error('Native credential store is unavailable in the standalone candidate.');
              };
              export class AsyncEntry {
                async getSecret() { return unavailable(); }
                async setSecret() { return unavailable(); }
                async deleteCredential() { return unavailable(); }
              }
              export const findCredentialsAsync = async () => unavailable();
            `,
            loader: 'js',
          }));
        },
      },
    ],
  });
  if (!result.success) {
    const summary = result.logs.map((entry) => entry.message).join('; ');
    throw new Error(`Bun compile failed for ${entrypoint}: ${summary}`);
  }
  if (!existsSync(outfile) || !statSync(outfile).isFile()) {
    throw new Error(`Bun compile did not create ${outfile}.`);
  }
}

export async function writeOssCandidateArchive(input: {
  archivePath: string;
  manifest: OssCandidateManifestV1;
  files: ReadonlyMap<string, Uint8Array>;
}): Promise<void> {
  const archivePath = resolve(input.archivePath);
  mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
  const manifest = ossCandidateManifestV1Schema.parse(input.manifest);
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const entries: Record<string, Uint8Array | string> = {
    'CHECKSUMS.sha256': encodeChecksums(manifest.files),
    'manifest.json': manifestBytes,
  };
  for (const entry of manifest.files) {
    const bytes = input.files.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`Cannot archive unverified candidate file: ${entry.path}`);
    }
    entries[entry.path] = bytes;
  }
  const sortedEntries = Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)),
  );
  const archive = new Bun.Archive(sortedEntries);
  const tarBytes = normalizeTarMetadata(await archive.bytes());
  const archiveBytes = gzipSync(tarBytes, { level: 9 });
  writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
  const archiveDigest = sha256(archiveBytes).slice('sha256:'.length);
  writeFileSync(`${archivePath}.sha256`, `${archiveDigest}  ${basename(archivePath)}\n`, {
    mode: 0o600,
  });
}

function normalizeTarMetadata(input: Uint8Array): Uint8Array {
  const tar = new Uint8Array(input);
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = tarString(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Cannot normalize invalid tar entry size.');

    header.set(new TextEncoder().encode('00000000000\0'), 136);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(new TextEncoder().encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148);

    const size = Number.parseInt(sizeText, 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return tar;
}

function listRegularTarPaths(archiveBytes: Uint8Array): string[] {
  const tar =
    archiveBytes[0] === 0x1f && archiveBytes[1] === 0x8b ? gunzipSync(archiveBytes) : archiveBytes;
  const paths: string[] = [];
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const type = header[156];
    if (type !== 0 && type !== 0x30)
      throw new Error(`Archive entry is not a regular file: ${path}`);
    if (!safeArchivePath(path) || paths.includes(path))
      throw new Error(`Unsafe archive path: ${path}`);
    const sizeText = tarString(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error(`Invalid tar size for ${path}.`);
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar size for ${path}.`);
    paths.push(path);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

function safeArchivePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString('utf8');
}

function verifyArchiveSidecar(archivePath: string, archiveSha256: `sha256:${string}`): void {
  const sidecarPath = `${archivePath}.sha256`;
  if (!existsSync(sidecarPath)) throw new Error(`Missing archive checksum: ${sidecarPath}`);
  const expected = `${archiveSha256.slice('sha256:'.length)}  ${basename(archivePath)}\n`;
  if (readFileSync(sidecarPath, 'utf8') !== expected) {
    throw new Error('Archive checksum sidecar does not match candidate bytes.');
  }
}

function encodeChecksums(files: readonly z.infer<typeof releaseFileSchema>[]): string {
  return [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.sha256.slice('sha256:'.length)}  ${entry.path}\n`)
    .join('');
}

function requiredFile(files: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`Candidate archive is missing ${path}.`);
  return bytes;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`Candidate ${label} is not valid JSON.`);
  }
}

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function gitOutput(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed.`);
  return result.stdout.toString().trim();
}

function canonicalSourceDate(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Release source date is invalid.');
  return new Date(milliseconds).toISOString();
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing.`);
  return value;
}

function target(
  id: string,
  os: OssReleaseTarget['os'],
  arch: OssReleaseTarget['arch'],
): OssReleaseTarget {
  return { id, os, arch, executableSuffix: os === 'win32' ? '.exe' : '' };
}
