import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CredentialBackend,
  createCredentialVault,
  createOsCredentialBackend,
} from '@kite-ai/agent/config';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import { TraceConsumerCleanupError, TraceConsumerStore } from './trace-extensions/consumer-store';
import { TraceCredentialBroker } from './trace-extensions/credentials';
import { verifyTraceEngineAssets } from './trace-extensions/engine';
import { TraceHost } from './trace-extensions/host';
import { TraceHostError } from './trace-extensions/types';
import { verifyOtelAdapterAssets } from './trace-integrations/opentelemetry/assets';
import { otelIntegrationConfigSchema } from './trace-integrations/opentelemetry/configuration';
import { createOtelConsumer } from './trace-integrations/opentelemetry/consumer';
import { inspectOtelStore } from './trace-integrations/opentelemetry/store';
import type { TrajectorySource } from './trajectory';

/** Build verification may select a module URL; production composition always uses this module. */
export function selectTraceRuntimeAssetPaths(serviceModuleUrl: string | URL = import.meta.url) {
  const module = fileURLToPath(serviceModuleUrl);
  const directory = module.endsWith('.ts') ? join(dirname(module), '..', 'dist') : dirname(module);
  return {
    engine: join(directory, 'trace-extensions', 'engine', 'runtime'),
    opentelemetry: join(directory, 'trace-integrations', 'opentelemetry', 'runtime'),
  };
}
function privateScope(path: string): void {
  privateDirectory(path);
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(path) !== path ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
  )
    throw new TraceHostError('trace_private_scope_denied');
  defaultWindowsPathSecurity()?.verifyDirectory(path);
}
function privateDatabase(path: string): void {
  const windows = defaultWindowsPathSecurity();
  if (!existsSync(path)) {
    if (windows) windows.createFile(path);
    else writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    realpathSync.native(path) !== path ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
  )
    throw new TraceHostError('trace_private_scope_denied');
  windows?.verifyFile(path);
}
function authenticatedManifest(directory: string) {
  const root = realpathSync.native(directory),
    path = join(root, 'manifest.json'),
    stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 64 * 1024 ||
    realpathSync.native(path) !== path
  )
    throw new TraceHostError('trace_assets_unavailable');
  return {
    directory: root,
    manifestSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}
export interface ProfileTraceRuntime {
  host: TraceHost;
  /** A failed original-process retirement keeps the consumer DB alive and propagates the failure. */
  close(): Promise<void>;
}
/** Trusted retained ownership only; public capability diagnostics must not serialize the cause. */
export class TraceRuntimeCleanupError extends Error {
  readonly code = 'trace_cleanup_unconfirmed';
  constructor(originalError: unknown, cleanupError: unknown, store: { close(): void }) {
    super('trace_cleanup_unconfirmed', {
      cause: Object.freeze({ originalError, cleanupError, store }),
    });
  }
  toJSON() {
    return { code: this.code };
  }
}
/** Trusted Service composition only. Missing prebuilt assets must not stop the Agent authority. */
export function createProfileTraceRuntime(options: {
  profile: ProfileSelection;
  source: TrajectorySource;
  subjectId: string;
  credentialBackend?: CredentialBackend;
}): ProfileTraceRuntime {
  let store: TraceConsumerStore | undefined;
  try {
    const paths = selectTraceRuntimeAssetPaths();
    const assets = authenticatedManifest(paths.engine),
      otelAssets = authenticatedManifest(paths.opentelemetry);
    verifyTraceEngineAssets(assets);
    verifyOtelAdapterAssets(otelAssets);
    const root = join(options.profile.profilePath, 'trace');
    privateScope(root);
    const database = join(root, 'consumer.sqlite');
    privateDatabase(database);
    store = new TraceConsumerStore(database);
    const vault = createCredentialVault({
      backend:
        options.credentialBackend ??
        createOsCredentialBackend({
          service: 'kite-agent',
          accountNamespace: `profile-${options.profile.profileAccessKey}`,
        }),
    });
    const host = new TraceHost({
      store,
      source: options.source,
      subjectId: options.subjectId,
      assets,
      credentials: new TraceCredentialBroker(store, vault),
      trustedConsumerInspect: async (input) => {
        const config = otelIntegrationConfigSchema.parse(input.settings);
        return inspectOtelStore({
          path: join(
            root,
            'opentelemetry',
            createHash('sha256').update(input.installationId).digest('hex'),
            'adapter.sqlite',
          ),
          installationId: input.installationId,
          endpoint: config.endpoint,
        });
      },
      trustedConsumerFactory: async (input) => {
        const parent = join(root, 'opentelemetry');
        privateScope(parent);
        const directory = join(
          parent,
          createHash('sha256').update(input.installationId).digest('hex'),
        );
        privateScope(directory);
        const path = join(directory, 'adapter.sqlite');
        privateDatabase(path);
        return createOtelConsumer(input, { path, assets: otelAssets });
      },
    });
    const ownedStore = store;
    let close: Promise<void> | undefined;
    host.start();
    return {
      host,
      close: () =>
        (close ??= (async () => {
          await host.close();
          ownedStore.close();
        })()),
    };
  } catch (originalError) {
    if (originalError instanceof TraceConsumerCleanupError) {
      const retained = originalError.cause as {
        originalError: unknown;
        cleanupError: unknown;
        database: { close(): void };
      };
      throw new TraceRuntimeCleanupError(
        retained.originalError,
        retained.cleanupError,
        retained.database,
      );
    }
    if (store) {
      try {
        store.close();
      } catch (cleanupError) {
        throw new TraceRuntimeCleanupError(originalError, cleanupError, store);
      }
    }
    const unavailable = new TraceHostError('trace_unavailable');
    Object.defineProperty(unavailable, 'cause', { value: originalError });
    throw unavailable;
  }
}
