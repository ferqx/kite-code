import { randomUUID } from 'node:crypto';
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
import { basename, dirname, join, resolve } from 'node:path';
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
  'OLLAMA_BASE_URL',
] as const);

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
  const sourceBuildId = sourceBuildIdentity(installed);
  const installedBuildId = installed ? installedBuildIdentity(process.execPath) : sourceBuildId;
  const expectedBuildId = installed ? installedBuildId : sourceBuildId;
  const source = explicitEnvironmentSource(sourceEnvironment);
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

function explicitEnvironmentSource(
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

function sourceBuildIdentity(installed: boolean): string {
  if (installed) return 'dev:installed-placeholder';
  const repositoryRoot = resolve(import.meta.dir, '../..');
  const result = Bun.spawnSync(['git', '-C', repositoryRoot, 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const commit = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('Source Service build identity is unavailable.');
  }
  return `dev:${commit}`;
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
