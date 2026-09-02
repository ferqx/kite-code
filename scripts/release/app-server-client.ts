import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  type BunStdioChildSpawnFactory,
  createKiteAppServerClient,
} from '@kite-ai/kite-local-runtime/client';
import {
  createKiteHomeIdentity,
  ensureKiteProfileHome,
  ensurePrivateKiteHomeDirectory,
} from '@kite-ai/kite-local-runtime/service';
import type { RuntimeClientInfo } from '@kite-ai/runtime-client';
import {
  explicitKiteHomeArgument,
  installedBuildIdentity,
  resolveInstalledReleaseExecutable,
  selectKiteServiceEnvironmentSource,
  sourceKiteSessionStorePathFromCanonicalRoots,
  sourceServiceBuildIdentity,
} from './local-service-client';

export interface ManagedLocalAppServerOptions {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly systemHome?: string;
  readonly executableMode?: 'source' | 'installed';
  readonly repositoryRoot?: string;
  readonly processExecutable?: string;
  /** Source-mode test/development override; installed mode always uses candidate-pinned assets. */
  readonly sourceWebStaticRoot?: string;
  /** Isolated release tests only; production leaves child creation to the typed transport. */
  readonly spawn?: BunStdioChildSpawnFactory;
}

export interface ManagedLocalAppServerComposition {
  readonly mode: 'source' | 'installed';
  readonly buildId: string;
  readonly runtimeRoot: string;
  readonly configRoot: string;
  connect(input: {
    readonly workspace: string;
    readonly clientInfo: RuntimeClientInfo;
  }): ReturnType<typeof createKiteAppServerClient>;
  readonly connector: {
    connect(input: {
      readonly workspace: string;
      readonly clientInfo?: RuntimeClientInfo;
    }): Promise<ReturnType<typeof createKiteAppServerClient>>;
  };
}

export interface ManagedLocalAppServerTarget {
  readonly mode: 'source' | 'installed';
  readonly buildId: string;
  readonly runtimeRoot: string;
  readonly configRoot: string;
  readonly systemHome: string;
  readonly executable: string;
  readonly webStaticRoot: string;
  readonly argumentsPrefix: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

/** Resolve only the client distribution's matching child; never inspect a running Service. */
export function createManagedLocalAppServerComposition(
  options: ManagedLocalAppServerOptions = {},
): ManagedLocalAppServerComposition {
  const target = resolveManagedLocalAppServerTarget(options);
  prepareManagedLocalAppServerTarget(target);
  const { mode, buildId, runtimeRoot, configRoot, systemHome, executable, environment } = target;
  const argumentsPrefix = target.argumentsPrefix;
  const connect = (input: {
    readonly workspace: string;
    readonly clientInfo: RuntimeClientInfo;
  }) => {
    const workspace = realpathSync.native(input.workspace);
    const stat = lstatSync(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('App Server Workspace must be a canonical directory.');
    }
    return createKiteAppServerClient({
      executable,
      ...(argumentsPrefix ? { argumentsPrefix } : {}),
      buildId,
      runtimeRoot,
      configRoot,
      osHome: systemHome,
      workspace,
      cwd: systemRoot(systemHome),
      environment,
      clientInfo: input.clientInfo,
      ...(options.spawn ? { spawn: options.spawn } : {}),
    });
  };
  return Object.freeze({
    mode,
    buildId,
    runtimeRoot,
    configRoot,
    connect,
    connector: Object.freeze({
      async connect(input: {
        readonly workspace: string;
        readonly clientInfo?: RuntimeClientInfo;
      }) {
        return connect({
          workspace: input.workspace,
          clientInfo:
            input.clientInfo ??
            Object.freeze({
              name: 'kite-terminal',
              version: '0.1.0',
              instanceId: `terminal_${randomUUID()}`,
            }),
        });
      },
    }),
  });
}

export function resolveManagedLocalAppServerTarget(
  options: ManagedLocalAppServerOptions = {},
): ManagedLocalAppServerTarget {
  const sourceEnvironment = options.environment ?? process.env;
  const systemHome = realpathSync.native(options.systemHome ?? userInfo().homedir);
  const explicitHome = explicitKiteHomeArgument(options.argv ?? process.argv);
  const home = createKiteHomeIdentity(
    explicitHome ?? join(systemHome, '.kite-code'),
    explicitHome === undefined ? 'os_user_home' : 'explicit_argument',
  );
  const mode = options.executableMode ?? 'source';
  const repositoryRoot =
    mode === 'source'
      ? canonicalRepositoryRoot(options.repositoryRoot ?? resolve(import.meta.dir, '../..'))
      : undefined;
  const processExecutable = realpathSync.native(options.processExecutable ?? process.execPath);
  const candidateRoot = sourceEnvironment.KITE_CODE_RELEASE_ROOT;
  const buildId =
    mode === 'source'
      ? sourceServiceBuildIdentity(repositoryRoot!)
      : installedBuildIdentity(processExecutable, { candidateRoot });
  const runtimeRoot =
    mode === 'source'
      ? dirname(sourceKiteSessionStorePathFromCanonicalRoots(home.root, repositoryRoot!))
      : home.root;
  const selected = selectKiteServiceEnvironmentSource(sourceEnvironment);
  const environment: Record<string, string> = { NODE_ENV: 'production' };
  for (const [key, value] of Object.entries(selected)) {
    if (value !== undefined) environment[key] = value;
  }
  if (mode === 'installed') environment.KITE_STANDALONE_EXECUTABLE = '1';
  const sourceEntrypoint =
    mode === 'source'
      ? join(repositoryRoot!, 'scripts', 'release', 'entrypoints', 'service.ts')
      : undefined;
  if (sourceEntrypoint) assertSourceEntrypoint(repositoryRoot!, sourceEntrypoint);
  const executable =
    mode === 'source'
      ? processExecutable
      : resolveInstalledReleaseExecutable('kite-service', {
          executable: processExecutable,
          candidateRoot,
        });
  if (mode === 'installed' && options.sourceWebStaticRoot !== undefined) {
    throw new Error('Installed App Server Web assets must remain candidate-pinned.');
  }
  const webStaticRoot =
    mode === 'source'
      ? resolve(options.sourceWebStaticRoot ?? join(repositoryRoot!, 'apps', 'kite-web', 'dist'))
      : join(candidateRoot ?? dirname(dirname(processExecutable)), 'payload', 'web');
  return Object.freeze({
    mode,
    buildId,
    runtimeRoot,
    configRoot: home.root,
    systemHome,
    executable,
    webStaticRoot,
    argumentsPrefix: Object.freeze(sourceEntrypoint ? [sourceEntrypoint] : []),
    environment: Object.freeze(environment),
  });
}

export function prepareManagedLocalAppServerTarget(target: ManagedLocalAppServerTarget): void {
  const home = ensureKiteProfileHome(createKiteHomeIdentity(target.configRoot));
  if (home.root !== target.configRoot) {
    throw new Error('App Server Kite Home identity changed during validation.');
  }
  if (target.mode !== 'source') return;
  const digest = basename(target.runtimeRoot);
  const ensured = ensurePrivateKiteHomeDirectory(home, ['source-profiles', digest]);
  if (ensured !== target.runtimeRoot) {
    throw new Error('Source App Server profile identity changed.');
  }
}

function canonicalRepositoryRoot(path: string): string {
  const root = realpathSync.native(path);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Source repository root must be a canonical directory.');
  }
  return root;
}

function assertSourceEntrypoint(repositoryRoot: string, entrypoint: string): void {
  const canonical = realpathSync.native(entrypoint);
  const fromRoot = relative(repositoryRoot, canonical);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')) {
    throw new Error('Source App Server entrypoint escaped the repository.');
  }
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Source App Server entrypoint must be a canonical regular file.');
  }
}

function systemRoot(systemHome: string): string {
  const match = /^(?:[A-Za-z]:[\\/]|\/)/u.exec(systemHome)?.[0];
  if (!match) throw new Error('System home has no absolute root.');
  return realpathSync.native(match);
}
