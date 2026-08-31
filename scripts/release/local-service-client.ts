import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { KITE_SERVICE_ENVIRONMENT_ALLOWLIST } from '@kite-ai/kite-local-runtime/manager';

const PROVIDER_ENVIRONMENT_KEYS = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OLLAMA_BASE_URL',
] as const);

const SOURCE_SERVICE_BUILD_PATHS = Object.freeze([
  'apps/kite-cli',
  'apps/kite-service',
  'apps/kite-web',
  'packages',
  'scripts/release/entrypoints/cli.ts',
  'scripts/release/entrypoints/launcher.ts',
  'scripts/release/entrypoints/service.ts',
  'scripts/release/entrypoints/tui.ts',
  'scripts/release/local-service-client.ts',
  'scripts/release/single-service-native-client.ts',
  'package.json',
  'bun.lock',
  'tsconfig.json',
] as const);
const MAX_SOURCE_BUILD_UNTRACKED_FILES = 1_024;
const MAX_SOURCE_BUILD_UNTRACKED_BYTES = 64 * 1024 * 1024;

export function explicitKiteHomeArgument(argv: readonly string[]): string | undefined {
  const positions = argv.flatMap((value, index) => (value === '--kite-home' ? [index] : []));
  if (positions.length === 0) return undefined;
  if (positions.length !== 1) throw new Error('--kite-home may be supplied only once.');
  const value = argv[(positions[0] ?? -1) + 1];
  if (!value || (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value))) {
    throw new Error('--kite-home requires an absolute path.');
  }
  return value;
}

export function selectKiteServiceEnvironmentSource(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (const key of [...KITE_SERVICE_ENVIRONMENT_ALLOWLIST, ...PROVIDER_ENVIRONMENT_KEYS]) {
    result[key] = source[key];
  }
  return Object.freeze(result);
}

export function sourceServiceBuildIdentity(repositoryRoot: string): string {
  const treeResult = Bun.spawnSync(
    [
      'git',
      '-C',
      repositoryRoot,
      'ls-tree',
      '-r',
      '-z',
      'HEAD',
      '--',
      ...SOURCE_SERVICE_BUILD_PATHS,
    ],
    {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    },
  );
  if (treeResult.exitCode !== 0) {
    throw new Error('Source Service build identity is unavailable.');
  }
  const sourceTreeId = createHash('sha256')
    .update('kite-source-service-tree-v1\0')
    .update(treeResult.stdout)
    .digest('hex')
    .slice(0, 40);
  const diffResult = Bun.spawnSync(
    ['git', '-C', repositoryRoot, 'diff', '--binary', 'HEAD', '--', ...SOURCE_SERVICE_BUILD_PATHS],
    {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    },
  );
  const untrackedResult = Bun.spawnSync(
    [
      'git',
      '-C',
      repositoryRoot,
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...SOURCE_SERVICE_BUILD_PATHS,
    ],
    {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    },
  );
  if (diffResult.exitCode !== 0 || untrackedResult.exitCode !== 0) {
    throw new Error('Source Service working-tree identity is unavailable.');
  }
  const untracked = untrackedResult.stdout.toString().split('\0').filter(Boolean).sort();
  if (untracked.length > MAX_SOURCE_BUILD_UNTRACKED_FILES) {
    throw new Error('Source Service working tree exceeds the untracked file bound.');
  }
  if (diffResult.stdout.byteLength === 0 && untracked.length === 0) return `dev:${sourceTreeId}`;

  const digest = createHash('sha256');
  digest.update('kite-source-service-build-v1\0');
  digest.update(sourceTreeId);
  digest.update('\0tracked\0');
  digest.update(diffResult.stdout);
  let untrackedBytes = 0;
  for (const path of untracked) {
    const absolute = resolve(repositoryRoot, path);
    const fromRoot = relative(repositoryRoot, absolute);
    if (
      !fromRoot ||
      fromRoot === '..' ||
      fromRoot.startsWith('../') ||
      fromRoot.startsWith('..\\') ||
      isAbsolute(fromRoot)
    ) {
      throw new Error('Source Service untracked path escaped the repository.');
    }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Source Service untracked input is not a regular file.');
    }
    untrackedBytes += stat.size;
    if (untrackedBytes > MAX_SOURCE_BUILD_UNTRACKED_BYTES) {
      throw new Error('Source Service working tree exceeds the untracked byte bound.');
    }
    digest.update('\0untracked\0');
    digest.update(path);
    digest.update('\0');
    digest.update(readFileSync(absolute));
  }
  return `dev:${sourceTreeId}:dirty:${digest.digest('hex')}`;
}

export function installedBuildIdentity(executable: string): string {
  const hintedCandidateRoot = process.env.KITE_CODE_RELEASE_ROOT;
  if (hintedCandidateRoot !== undefined && !isAbsolute(hintedCandidateRoot)) {
    throw new Error(`Managed candidate root is not absolute for ${basename(executable)}.`);
  }
  const executablePath =
    hintedCandidateRoot === undefined ? realpathSync.native(executable) : undefined;
  const candidateRoot = resolve(
    hintedCandidateRoot ?? dirname(dirname(executablePath ?? executable)),
  );
  const candidateId = basename(candidateRoot);
  if (!/^[a-f0-9]{24}$/u.test(candidateId)) {
    throw new Error(`Managed candidate identity is invalid for ${basename(executable)}.`);
  }
  if (realpathSync.native(candidateRoot) !== candidateRoot) {
    throw new Error(`Managed candidate root is not immutable for ${basename(executable)}.`);
  }
  const installRoot = dirname(dirname(candidateRoot));
  if (basename(dirname(candidateRoot)) !== 'releases') {
    throw new Error(`Managed candidate layout is invalid for ${basename(executable)}.`);
  }
  const marker = JSON.parse(
    readFileSync(join(installRoot, '.kite-code-managed.json'), 'utf8'),
  ) as unknown;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error(`Managed install identity is invalid for ${basename(executable)}.`);
  }
  const record = marker as Record<string, unknown>;
  const exactKeys = [
    'activePointer',
    'canonicalRoot',
    'currentCandidateId',
    'previousCandidateId',
    'schema',
    'target',
    'version',
  ];
  if (
    Object.keys(record).sort().join('\0') !== exactKeys.join('\0') ||
    record.schema !== 'KiteCodeManagedInstall' ||
    record.version !== 2 ||
    record.canonicalRoot !== realpathSync.native(installRoot) ||
    typeof record.currentCandidateId !== 'string' ||
    !/^[a-f0-9]{24}$/u.test(record.currentCandidateId) ||
    record.currentCandidateId !== candidateId ||
    record.activePointer !== 'active'
  ) {
    throw new Error(`Managed candidate identity is invalid for ${basename(executable)}.`);
  }
  const activePointer = readFileSync(join(installRoot, 'active'), 'utf8');
  if (!/^[a-f0-9]{24}\n$/u.test(activePointer)) {
    throw new Error(`Managed active release pointer is invalid for ${basename(executable)}.`);
  }
  if (activePointer.trim() !== record.currentCandidateId) {
    throw new Error(`Managed active release pointer is inconsistent for ${basename(executable)}.`);
  }
  const materializedId = readFileSync(join(candidateRoot, '.candidate-id'), 'utf8').trim();
  if (materializedId !== candidateId) {
    throw new Error(`Managed candidate identity is invalid for ${basename(executable)}.`);
  }
  const manifest = readFileSync(join(candidateRoot, 'manifest.json'));
  const manifestCandidateId = createHash('sha256').update(manifest).digest('hex').slice(0, 24);
  if (manifestCandidateId !== candidateId) {
    throw new Error(`Managed candidate manifest identity is invalid for ${basename(executable)}.`);
  }
  return candidateId;
}

export function resolveInstalledReleaseExecutable(
  name: 'kite-service',
  input: {
    readonly executable?: string;
    readonly candidateRoot?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): string {
  const candidateRoot = input.candidateRoot ?? process.env.KITE_CODE_RELEASE_ROOT;
  if (candidateRoot !== undefined && !isAbsolute(candidateRoot)) {
    throw new Error(`Managed candidate root is not absolute for ${name}.`);
  }
  const suffix = (input.platform ?? process.platform) === 'win32' ? '.exe' : '';
  const binRoot =
    candidateRoot === undefined
      ? dirname(input.executable ?? process.execPath)
      : join(candidateRoot, 'bin');
  return join(binRoot, `${name}${suffix}`);
}
