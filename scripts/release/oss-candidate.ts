import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const releaseFileSchema = z
  .object({
    path: z.string().regex(/^(?:bin|docs|native|payload|release|vendor)(?:\/[A-Za-z0-9._-]+)+$/),
    sha256: digestSchema,
    size: z.number().int().nonnegative(),
  })
  .strict();

const releaseSlotSchema = z
  .object({
    entrypoint: z
      .string()
      .regex(/^(?:bin|docs|native|payload|release|vendor)(?:\/[A-Za-z0-9._-]+)+$/)
      .nullable(),
    identity: digestSchema.nullable(),
  })
  .strict()
  .superRefine((slot, context) => {
    if ((slot.entrypoint === null) !== (slot.identity === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Release slots must provide both entrypoint and identity, or neither.',
      });
    }
  });

const releaseSlotsSchema = z
  .object({
    cli: releaseSlotSchema,
    tui: releaseSlotSchema,
    service: releaseSlotSchema,
    coordinator: releaseSlotSchema,
    worker: releaseSlotSchema,
    gateway: releaseSlotSchema,
    web: releaseSlotSchema,
  })
  .strict();

export const ossCandidateManifestSchema = z
  .object({
    schema: z.literal('KiteCodeOssCandidateManifest'),
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
    /** Explicitly optional for archive verification; installation requires this v1.1 shape. */
    releaseSlots: releaseSlotsSchema.optional(),
    files: z.array(releaseFileSchema).min(5).max(32),
  })
  .strict();

export type OssCandidateManifest = z.infer<typeof ossCandidateManifestSchema>;
export type OssCandidateReleaseSlots = z.infer<typeof releaseSlotsSchema>;

export interface OssReleaseTarget {
  id: string;
  os: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  executableSuffix: '' | '.exe';
}

export interface VerifiedOssCandidate {
  archivePath: string;
  archiveSha256: `sha256:${string}`;
  manifest: OssCandidateManifest;
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

/**
 * The Windows restricted-token executor validates these files at runtime.
 * They must travel with a standalone candidate: source-relative lookup is
 * deliberately unavailable after the Bun executable has been installed.
 */
const WINDOWS_SANDBOX_RELEASE_ASSETS = [
  [
    'release/platform-capabilities/windows-runner.json',
    'release/platform-capabilities/windows-runner.json',
  ],
  [
    'native/windows-sandbox-runner/target/release/kite-windows-runner.exe',
    'native/windows-sandbox-runner/target/release/kite-windows-runner.exe',
  ],
  ['vendor/isksh/isksh.exe', 'vendor/isksh/isksh.exe'],
  ['vendor/isksh/coreutils.exe', 'vendor/isksh/coreutils.exe'],
  ['vendor/isksh/COREUTILS.md', 'vendor/isksh/COREUTILS.md'],
  ['vendor/isksh/LICENSE-APACHE', 'vendor/isksh/LICENSE-APACHE'],
  ['vendor/isksh/LICENSE-MIT', 'vendor/isksh/LICENSE-MIT'],
  ['vendor/isksh/LICENSE.coreutils', 'vendor/isksh/LICENSE.coreutils'],
] as const;

export function releaseLauncherArchivePaths(manifest: OssCandidateManifest): {
  cli: string;
  tui: string;
  service: string;
} {
  return releaseLauncherArchivePathsForTarget(manifest.target.os);
}

function releaseLauncherArchivePathsForTarget(os: OssReleaseTarget['os']): {
  cli: string;
  tui: string;
  service: string;
} {
  const suffix = os === 'win32' ? '.exe' : '';
  return {
    cli: `release/launchers/kite${suffix}`,
    tui: `release/launchers/kite-tui${suffix}`,
    service: `release/launchers/kite-service${suffix}`,
  };
}

/**
 * Resolve every workspace package export directly to repository source. Bun standalone on
 * Windows can crash while pretty-printing a backslash path reached
 * through a workspace symlink, so standalone builds must never enter those
 * node_modules links.
 */
export const STANDALONE_WORKSPACE_ENTRYPOINTS_: Readonly<Record<string, string>> = Object.freeze({
  '@kite-ai/kite-cli': 'apps/kite-cli/src/index.ts',
  '@kite-ai/kite-cli/cli': 'apps/kite-cli/src/cli/executable.ts',
  '@kite-ai/kite-cli/tui': 'apps/kite-cli/src/tui/executable.tsx',
  '@kite-ai/kite-service': 'apps/kite-service/src/index.ts',
  '@kite-ai/agent-api-contract': 'packages/agent-api-contract/src/index.ts',
  '@kite-ai/agent-api-client': 'packages/agent-api-client/src/index.ts',
  '@kite-ai/kite-app-contract': 'packages/kite-app-contract/src/index.ts',
  '@kite-ai/kite-app-contract/worker-controller':
    'packages/kite-app-contract/src/worker-controller.ts',
  '@kite-ai/kite-local-runtime/client': 'packages/kite-local-runtime/src/client/index.ts',
  '@kite-ai/kite-local-runtime/coordinator': 'packages/kite-local-runtime/src/coordinator/index.ts',
  '@kite-ai/kite-local-runtime/manager': 'packages/kite-local-runtime/src/manager/index.ts',
  '@kite-ai/kite-local-runtime/service': 'packages/kite-local-runtime/src/service/index.ts',
  '@kite-ai/agent-kernel': 'packages/agent-kernel/src/index.ts',
  '@kite-ai/builtin-runtime': 'packages/builtin-runtime/src/index.ts',
  '@kite-ai/builtin-runtime/capability': 'packages/builtin-runtime/src/capability.ts',
  '@kite-ai/builtin-runtime/filesystem': 'packages/builtin-runtime/src/filesystem/index.ts',
  '@kite-ai/builtin-runtime/git': 'packages/builtin-runtime/src/git/index.ts',
  '@kite-ai/builtin-runtime/mcp': 'packages/builtin-runtime/src/mcp/index.ts',
  '@kite-ai/builtin-runtime/model': 'packages/builtin-runtime/src/model/index.ts',
  '@kite-ai/builtin-runtime/planning': 'packages/builtin-runtime/src/planning/index.ts',
  '@kite-ai/builtin-runtime/sandbox': 'packages/builtin-runtime/src/sandbox/index.ts',
  '@kite-ai/builtin-runtime/skills': 'packages/builtin-runtime/src/skills/index.ts',
  '@kite-ai/builtin-runtime/subagent': 'packages/builtin-runtime/src/subagent/index.ts',
  '@kite-ai/builtin-runtime/verification': 'packages/builtin-runtime/src/verification/index.ts',
  '@kite-ai/builtin-runtime/web': 'packages/builtin-runtime/src/web/index.ts',
  '@kite-ai/runtime-contract': 'packages/runtime-contract/src/index.ts',
  '@kite-ai/runtime-client': 'packages/runtime-client/src/index.ts',
  '@kite-ai/runtime-host': 'packages/runtime-host/src/index.ts',
  '@kite-ai/runtime-host/kernel-adapter': 'packages/runtime-host/src/kernel-adapter/index.ts',
  '@kite-ai/runtime-host/observability': 'packages/runtime-host/src/observability/index.ts',
  '@kite-ai/runtime-host/storage': 'packages/runtime-host/src/storage/index.ts',
  '@kite-ai/runtime-protocol': 'packages/runtime-protocol/src/index.ts',
  '@kite-ai/runtime-server': 'packages/runtime-server/src/index.ts',
  '@kite-ai/runtime-spi': 'packages/runtime-spi/src/index.ts',
  '@kite-ai/runtime-spi/model': 'packages/runtime-spi/src/model-surface.ts',
  '@kite-ai/runtime-storage-sqlite': 'packages/runtime-storage-sqlite/src/index.ts',
});

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
  const servicePath = join(stageDirectory, `kite-service${executableSuffix}`);
  const launcherPath = join(stageDirectory, `kite-release-launcher${executableSuffix}`);
  await compileOssReleaseExecutable('scripts/release/entrypoints/cli.ts', cliPath);
  await compileOssReleaseExecutable('scripts/release/entrypoints/tui.ts', tuiPath);
  await compileOssReleaseExecutable('scripts/release/entrypoints/service.ts', servicePath);
  await compileOssReleaseExecutable('scripts/release/entrypoints/launcher.ts', launcherPath);
  const webAssets = await buildWebReleaseAssets(join(stageDirectory, 'web'));
  if (process.platform !== 'win32') {
    chmodSync(cliPath, 0o755);
    chmodSync(tuiPath, 0o755);
    chmodSync(servicePath, 0o755);
    chmodSync(launcherPath, 0o755);
  }

  const archiveFiles = new Map<string, Uint8Array>();
  const cliBytes = readBytes(cliPath);
  const tuiBytes = readBytes(tuiPath);
  const serviceBytes = readBytes(servicePath);
  const launcherBytes = readBytes(launcherPath);
  archiveFiles.set(`bin/kite${executableSuffix}`, cliBytes);
  archiveFiles.set(`bin/kite-tui${executableSuffix}`, tuiBytes);
  archiveFiles.set(`bin/kite-service${executableSuffix}`, serviceBytes);
  const launcherPaths = releaseLauncherArchivePathsForTarget(releaseTarget.os);
  archiveFiles.set(launcherPaths.cli, launcherBytes);
  archiveFiles.set(launcherPaths.tui, launcherBytes);
  archiveFiles.set(launcherPaths.service, launcherBytes);
  for (const [archiveName, sourcePath] of RELEASE_ASSETS) {
    archiveFiles.set(archiveName, readBytes(resolve(sourcePath)));
  }
  for (const [assetPath, assetBytes] of webAssets) {
    archiveFiles.set(`payload/web/${assetPath}`, assetBytes);
  }
  if (releaseTarget.os === 'win32') {
    for (const [archiveName, sourcePath] of WINDOWS_SANDBOX_RELEASE_ASSETS) {
      archiveFiles.set(archiveName, readBytes(resolve(sourcePath)));
    }
  }
  const releaseFiles = [...archiveFiles]
    .map(([path, bytes]) => ({ path, sha256: sha256(bytes), size: bytes.byteLength }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: OssCandidateManifest = ossCandidateManifestSchema.parse({
    schema: 'KiteCodeOssCandidateManifest',
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
    releaseSlots: {
      cli: { entrypoint: `bin/kite${executableSuffix}`, identity: sha256(cliBytes) },
      tui: { entrypoint: `bin/kite-tui${executableSuffix}`, identity: sha256(tuiBytes) },
      service: {
        entrypoint: `bin/kite-service${executableSuffix}`,
        identity: sha256(serviceBytes),
      },
      coordinator: { entrypoint: null, identity: null },
      worker: { entrypoint: null, identity: null },
      gateway: { entrypoint: null, identity: null },
      web: {
        entrypoint: 'payload/web/index.html',
        identity: sha256(requiredFile(archiveFiles, 'payload/web/index.html')),
      },
    },
    files: releaseFiles,
  });
  await writeOssCandidateArchive({ archivePath, manifest, files: archiveFiles });
  return verifyOssCandidate(archivePath, releaseTarget.id);
}

async function buildWebReleaseAssets(outputDirectory: string): Promise<Map<string, Uint8Array>> {
  const repositoryRoot = resolve(import.meta.dir, '../..');
  const result = Bun.spawnSync(
    [
      process.execPath,
      'x',
      'vite',
      'build',
      '--outDir',
      outputDirectory,
      '--emptyOutDir',
      '--sourcemap',
      'false',
    ],
    {
      cwd: resolve(repositoryRoot, 'apps/kite-web'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  if (result.exitCode !== 0) {
    throw new Error('Web release assets could not be built.');
  }
  const root = resolve(outputDirectory);
  const assets = new Map<string, Uint8Array>();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) throw new Error('Web release assets contain a symlink.');
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('Web release assets contain an unsupported entry.');
      }
      const path = relative(root, absolute).replaceAll('\\', '/');
      if (
        path !== 'index.html' &&
        path !== 'api-docs/openapi.json' &&
        !/^assets\/[A-Za-z0-9_-]+\.(?:css|js)$/u.test(path)
      ) {
        throw new Error(`Web release asset is outside the fixed allowlist: ${path}`);
      }
      assets.set(path, readBytes(absolute));
    }
  }
  if (!assets.has('index.html') || ![...assets].some(([path]) => path.endsWith('.js'))) {
    throw new Error('Web release assets are incomplete.');
  }
  return assets;
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
  const manifest = ossCandidateManifestSchema.parse(parseJson(manifestBytes, 'manifest'));
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
  validateReleaseSlots(manifest, files);
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

function validateReleaseSlots(
  manifest: OssCandidateManifest,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  if (manifest.releaseSlots === undefined) return;
  for (const name of ['coordinator', 'worker', 'gateway'] as const) {
    const slot = manifest.releaseSlots[name];
    if (slot.entrypoint !== null || slot.identity !== null) {
      throw new Error(`Retired release slot ${name} must be empty.`);
    }
  }
  const web = manifest.releaseSlots.web;
  if (web.entrypoint !== 'payload/web/index.html' || web.identity === null) {
    throw new Error('Release slot web is not bound to its fixed payload path.');
  }
  if (!files.has('payload/web/api-docs/openapi.json')) {
    throw new Error('Release slot web is missing its bundled Agent API contract.');
  }
  for (const [name, slot] of Object.entries(manifest.releaseSlots)) {
    if (slot.entrypoint === null || slot.identity === null) continue;
    const bytes = files.get(slot.entrypoint);
    if (bytes === undefined) {
      throw new Error(`Release slot ${name} points to a missing entrypoint: ${slot.entrypoint}`);
    }
    if (sha256(bytes) !== slot.identity) {
      throw new Error(`Release slot ${name} identity does not match: ${slot.entrypoint}`);
    }
  }
}

export async function createSmokeVariantCandidate(
  verified: VerifiedOssCandidate,
  archivePath: string,
): Promise<VerifiedOssCandidate> {
  const files = new Map<string, Uint8Array>();
  for (const entry of verified.manifest.files)
    files.set(entry.path, requiredFile(verified.files, entry.path));
  const manifest = ossCandidateManifestSchema.parse({
    ...verified.manifest,
    productVersion: `${verified.manifest.productVersion}-smoke-next`,
  });
  await writeOssCandidateArchive({ archivePath, manifest, files });
  return verifyOssCandidate(archivePath, manifest.target.id);
}

export function executableArchivePaths(manifest: OssCandidateManifest): {
  cli: string;
  tui: string;
  service: string;
  coordinator: string | null;
  worker: string | null;
  gateway: string | null;
  web: string | null;
} {
  const suffix = manifest.target.os === 'win32' ? '.exe' : '';
  return {
    cli: `bin/kite${suffix}`,
    tui: `bin/kite-tui${suffix}`,
    service: `bin/kite-service${suffix}`,
    coordinator: manifest.releaseSlots?.coordinator.entrypoint ?? null,
    worker: manifest.releaseSlots?.worker.entrypoint ?? null,
    gateway: manifest.releaseSlots?.gateway.entrypoint ?? null,
    web: manifest.releaseSlots?.web.entrypoint ?? null,
  };
}

export async function compileOssReleaseExecutable(
  entrypoint: string,
  outfile: string,
): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, '../..');
  const result = await Bun.build({
    entrypoints: [resolve(entrypoint)],
    root: repositoryRoot,
    tsconfig: resolve(repositoryRoot, 'tsconfig.json'),
    compile: {
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
    minify: true,
    sourcemap: 'none',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env.KITE_STANDALONE_EXECUTABLE': JSON.stringify('1'),
    },
    plugins: [
      {
        name: 'standalone-release-stubs',
        setup(builder) {
          const resolveSource = (base: string): string | undefined => {
            for (const candidate of [
              base,
              `${base}.ts`,
              `${base}.tsx`,
              `${base}.js`,
              `${base}.jsx`,
              `${base}.json`,
              join(base, 'index.ts'),
              join(base, 'index.tsx'),
              join(base, 'index.js'),
            ]) {
              try {
                if (statSync(candidate).isFile()) return candidate;
              } catch {
                // Try the next canonical source extension.
              }
            }
            return undefined;
          };
          builder.onResolve({ filter: /^\.\.?\// }, (args) => {
            const base = resolve(dirname(args.importer), args.path);
            const path = resolveSource(base);
            return path ? { path } : undefined;
          });
          builder.onResolve({ filter: /^(?:#|@\/)/ }, (args) => {
            const exact =
              {
                '#agent-kernel': 'packages/agent-kernel/src/index.ts',
                '#builtin-runtime': 'packages/builtin-runtime/src/index.ts',
                '#builtin-runtime/sandbox': 'packages/builtin-runtime/src/sandbox/index.ts',
                '#builtin-runtime/mcp': 'packages/builtin-runtime/src/mcp/index.ts',
                '#builtin-runtime/model': 'packages/builtin-runtime/src/model/index.ts',
                '#builtin-runtime/web': 'packages/builtin-runtime/src/web/index.ts',
                '#runtime-spi': 'packages/runtime-spi/src/index.ts',
                '#runtime-host': 'packages/runtime-host/src/index.ts',
              }[args.path] ?? undefined;
            if (exact) return { path: resolve(repositoryRoot, exact) };
            const prefix = [
              ['#kite-cli/', 'apps/kite-cli/src/'],
              ['#kite-service/', 'apps/kite-service/src/'],
              ['#builtin-runtime/sandbox/', 'packages/builtin-runtime/src/sandbox/'],
              ['#runtime-host/', 'packages/runtime-host/src/'],
              ['@/', 'src/'],
            ] as const;
            for (const [specifier, directory] of prefix) {
              if (!args.path.startsWith(specifier)) continue;
              const path = resolveSource(
                resolve(repositoryRoot, directory, args.path.slice(specifier.length)),
              );
              return path ? { path } : undefined;
            }
            return undefined;
          });
          builder.onResolve({ filter: /^@kite-ai\// }, (args) => {
            const entrypoint = STANDALONE_WORKSPACE_ENTRYPOINTS_[args.path];
            return entrypoint ? { path: resolve(repositoryRoot, entrypoint) } : undefined;
          });
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
  manifest: OssCandidateManifest;
  files: ReadonlyMap<string, Uint8Array>;
}): Promise<void> {
  const archivePath = resolve(input.archivePath);
  mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
  const manifest = ossCandidateManifestSchema.parse(input.manifest);
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
