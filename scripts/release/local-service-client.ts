import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  createLocalKiteConnection,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  type LocalKiteConnection,
} from '@kite-ai/kite-local-runtime/client';
import {
  createKiteServiceEnvironment,
  createKiteServiceExecutableResolver,
  createNativeKiteServiceManagerComposition,
  KITE_SERVICE_ENVIRONMENT_ALLOWLIST,
  type KiteServiceManager,
  type KiteServiceManagerRequest,
} from '@kite-ai/kite-local-runtime/manager';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceHome,
  resolveLocalRuntimeServiceStatePaths,
} from '@kite-ai/kite-local-runtime/service';

const PROVIDER_ENVIRONMENT_KEYS = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OLLAMA_BASE_URL',
] as const);

const SOURCE_SERVICE_BUILD_PATHS = Object.freeze([
  'apps/kite-service',
  'packages',
  'package.json',
  'bun.lock',
  'tsconfig.json',
] as const);
const MAX_SOURCE_BUILD_UNTRACKED_FILES = 1_024;
const MAX_SOURCE_BUILD_UNTRACKED_BYTES = 64 * 1024 * 1024;

export interface ManagedLocalServiceConnector {
  connect(input: { readonly workspace: string }): Promise<LocalKiteConnection>;
}

export interface ManagedLocalServiceLifecycle {
  ensure(request?: KiteServiceManagerRequest): ReturnType<KiteServiceManager['ensure']>;
  status(request?: KiteServiceManagerRequest): ReturnType<KiteServiceManager['status']>;
  stop(request?: KiteServiceManagerRequest): ReturnType<KiteServiceManager['stop']>;
  restart(request?: KiteServiceManagerRequest): ReturnType<KiteServiceManager['restart']>;
}

export interface ManagedLocalServiceClientComposition {
  readonly connector: ManagedLocalServiceConnector;
  readonly lifecycle: ManagedLocalServiceLifecycle;
  readonly executableMode: 'source' | 'installed';
}

export interface ManagedLocalServiceClientCompositionOptions {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Canonical OS account home supplied by the release/platform adapter. */
  readonly systemHome?: string;
  /** Build-owned executable layout; callers may not infer this from Workspace or ambient env. */
  readonly executableMode?: 'source' | 'installed';
}

/**
 * Release/source entrypoint composition. App packages receive only typed connector/lifecycle
 * objects; neither terminal App imports the Service App or reconstructs state/process authority.
 */
export function createManagedLocalServiceClientComposition(
  options: ManagedLocalServiceClientCompositionOptions = {},
): ManagedLocalServiceClientComposition {
  const sourceEnvironment = options.environment ?? process.env;
  const systemHome = realpathSync(options.systemHome ?? userInfo().homedir);
  const explicitHome = explicitKiteHomeArgument(options.argv ?? process.argv);
  const home = ensureLocalRuntimeServiceHome(
    createKiteHomeIdentity(
      explicitHome ?? join(systemHome, '.kite-code'),
      explicitHome === undefined ? 'os_user_home' : 'explicit_argument',
    ),
  );
  const statePaths = resolveLocalRuntimeServiceStatePaths(home);
  const executableMode = options.executableMode ?? 'source';
  const installed = executableMode === 'installed';
  const sourceBuildId = installed
    ? 'dev:installed-placeholder'
    : sourceServiceBuildIdentity(resolve(import.meta.dir, '../..'));
  const installedBuildId = installed ? installedBuildIdentity(process.execPath) : sourceBuildId;
  const expectedBuildId = installed ? installedBuildId : sourceBuildId;
  const source = selectKiteServiceEnvironmentSource(sourceEnvironment);
  const environment = {
    async resolve() {
      const value = createKiteServiceEnvironment({
        homeRoot: home.root,
        stateRoot: statePaths.root,
        source,
        systemHome,
        ...(process.platform === 'win32' ? { userProfile: systemHome } : {}),
        nodeEnvironment: 'production',
        allowedKeys: PROVIDER_ENVIRONMENT_KEYS,
      });
      ensureNeutralDirectory(value.cwd);
      return value;
    },
  };
  const sourceExecutable = resolve(import.meta.dir, '../../apps/kite-service/src/executable.ts');
  const installedExecutable = join(
    dirname(process.execPath),
    process.platform === 'win32' ? 'kite-service.exe' : 'kite-service',
  );
  const native = createNativeKiteServiceManagerComposition({
    home,
    environment,
    executableMode,
    executableResolver: createKiteServiceExecutableResolver({
      source: sourceExecutable,
      installed: installedExecutable,
      sourceBuildId,
      installedBuildId,
    }),
    expectedBuildId,
  });
  const withMode = (request?: KiteServiceManagerRequest): KiteServiceManagerRequest => ({
    ...(request ?? {}),
    executableMode,
  });
  const lifecycle: ManagedLocalServiceLifecycle = Object.freeze({
    ensure: (request?: KiteServiceManagerRequest) => native.manager.ensure(withMode(request)),
    status: (request?: KiteServiceManagerRequest) => native.manager.status(withMode(request)),
    stop: (request?: KiteServiceManagerRequest) => native.manager.stop(withMode(request)),
    restart: (request?: KiteServiceManagerRequest) => native.manager.restart(withMode(request)),
  });
  const connector: ManagedLocalServiceConnector = Object.freeze({
    connect: async (input: { readonly workspace: string }) => {
      const connection = createLocalKiteConnection({
        manager: native.ensure,
        state: native.clientState,
        workspace: input.workspace,
        clientInfo: {
          name: 'kite-terminal',
          version: '0.1.0',
          instanceId: `terminal_${randomUUID()}`,
        },
        clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
      });
      try {
        await connection.prepareAppControl();
        return connection;
      } catch (error) {
        await connection.close('app_control_prepare_failed').catch(() => undefined);
        throw error;
      }
    },
  });
  return Object.freeze({ connector, lifecycle, executableMode });
}

function explicitKiteHomeArgument(argv: readonly string[]): string | undefined {
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

function ensureNeutralDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Service neutral cwd is not a real directory.');
  }
  if (readdirSync(path).length !== 0) {
    throw new Error('Service neutral cwd must remain empty.');
  }
  chmodSync(path, 0o700);
}

export function sourceServiceBuildIdentity(repositoryRoot: string): string {
  const commitResult = Bun.spawnSync(['git', '-C', repositoryRoot, 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const commit = commitResult.stdout.toString().trim();
  if (commitResult.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('Source Service build identity is unavailable.');
  }
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
  if (diffResult.stdout.byteLength === 0 && untracked.length === 0) return `dev:${commit}`;

  const digest = createHash('sha256');
  digest.update('kite-source-service-build-v1\0');
  digest.update(commit);
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
  return `dev:${commit}:dirty:${digest.digest('hex')}`;
}

function installedBuildIdentity(executable: string): string {
  const installRoot = dirname(dirname(executable));
  const marker = JSON.parse(
    readFileSync(join(installRoot, '.kite-code-managed.json'), 'utf8'),
  ) as unknown;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error(`Managed install identity is invalid for ${basename(executable)}.`);
  }
  const record = marker as Record<string, unknown>;
  const exactKeys = [
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
    record.version !== 1 ||
    record.canonicalRoot !== realpathSync.native(installRoot) ||
    typeof record.currentCandidateId !== 'string' ||
    !/^[a-f0-9]{24}$/u.test(record.currentCandidateId)
  ) {
    throw new Error(`Managed candidate identity is invalid for ${basename(executable)}.`);
  }
  const materializedId = readFileSync(
    join(installRoot, 'releases', record.currentCandidateId, '.candidate-id'),
    'utf8',
  ).trim();
  if (materializedId !== record.currentCandidateId) {
    throw new Error(`Managed candidate identity is invalid for ${basename(executable)}.`);
  }
  return record.currentCandidateId;
}
