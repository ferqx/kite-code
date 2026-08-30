import { randomUUID } from 'node:crypto';
import type { CoordinatorOsIdentity } from '@kite-ai/kite-local-runtime/coordinator';
import { readCoordinatorProcessStartIdentity } from '@kite-ai/kite-local-runtime/coordinator';
import type { KiteCoordinatorComposition, KiteCoordinatorCompositionOptions } from './ports';

export interface KiteCoordinatorMainEnvironment {
  readonly home: string;
  readonly coordinationHome: string;
  readonly catalogPath: string;
  readonly layoutGeneration: string;
  readonly buildId: string;
  readonly executableMode: 'source' | 'installed';
  readonly companionRoot: string;
  readonly webStaticRoot: string;
  readonly readinessFd: number;
  readonly peerOsIdentity: CoordinatorOsIdentity;
}

export interface KiteCoordinatorProcessEnvironment extends KiteCoordinatorMainEnvironment {
  readonly processStartIdentity: string;
  readonly instanceId: string;
}

export interface KiteCoordinatorMainDependencies {
  /** Explicit manager-provided environment; ambient process.env is never read implicitly. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Injectable composition seam for tests and the future managed launcher wiring. */
  readonly createComposition?: (
    environment: KiteCoordinatorProcessEnvironment,
  ) => KiteCoordinatorComposition | Promise<KiteCoordinatorComposition>;
  /** Server-owned process probe; the manager cannot know a child's OS start token before spawn. */
  readonly readProcessStartIdentity?: () => Promise<string | undefined>;
  readonly createInstanceId?: () => string;
}

const COORDINATOR_ENTRY_ARGS = Object.freeze(['coordinator', 'run'] as const);

/**
 * Resolve only the manager-provided Coordinator environment. Missing values are a hard failure:
 * this entry never consults HOME, cwd, an active pointer, or a default Catalog path.
 */
export function resolveKiteCoordinatorMainEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): KiteCoordinatorMainEnvironment {
  const home = requiredAbsolute(source, 'KITE_COORDINATOR_HOME');
  const coordinationHome = requiredAbsolute(source, 'KITE_COORDINATOR_COORDINATION_HOME');
  const catalogPath = requiredAbsolute(source, 'KITE_COORDINATOR_CATALOG_PATH');
  const layoutGeneration = requiredIdentifier(source, 'KITE_COORDINATOR_LAYOUT_GENERATION');
  const buildId = requiredIdentifier(source, 'KITE_COORDINATOR_BUILD_ID');
  const executableMode = requiredExecutableMode(source.KITE_COORDINATOR_EXECUTABLE_MODE);
  const companionRoot = requiredAbsolute(source, 'KITE_COORDINATOR_COMPANION_ROOT');
  const webStaticRoot = requiredAbsolute(source, 'KITE_COORDINATOR_WEB_STATIC_ROOT');
  const readinessFd = parseFd(source.KITE_COORDINATOR_READY_FD);
  const peerOsIdentity = parseOsIdentity(source);
  return Object.freeze({
    home,
    coordinationHome,
    catalogPath,
    layoutGeneration,
    buildId,
    executableMode,
    companionRoot,
    webStaticRoot,
    readinessFd,
    peerOsIdentity,
  });
}

/** Internal foreground entry. Only exact `coordinator run` is accepted. */
export async function runKiteCoordinatorMain(
  args: readonly string[] = [],
  dependencies: KiteCoordinatorMainDependencies = {},
): Promise<void> {
  if (
    args.length !== COORDINATOR_ENTRY_ARGS.length ||
    args.some((value, index) => value !== COORDINATOR_ENTRY_ARGS[index])
  ) {
    throw new Error(
      'Kite Coordinator internal entry requires the exact `coordinator run` arguments.',
    );
  }
  if (!dependencies.environment || !dependencies.createComposition) {
    throw new Error('Kite Coordinator requires explicit manager environment and composition.');
  }
  const managerEnvironment = resolveKiteCoordinatorMainEnvironment(dependencies.environment);
  const processStartIdentity = await (
    dependencies.readProcessStartIdentity ?? (() => readCoordinatorProcessStartIdentity())
  )();
  if (!processStartIdentity) {
    throw new Error('Kite Coordinator process start identity is unavailable.');
  }
  const instanceId = (dependencies.createInstanceId ?? (() => `coordinator_${randomUUID()}`))();
  requiredIdentifier({ value: instanceId }, 'value');
  const environment: KiteCoordinatorProcessEnvironment = Object.freeze({
    ...managerEnvironment,
    processStartIdentity,
    instanceId,
  });
  const composition = await dependencies.createComposition(environment);
  let primaryError: unknown;
  try {
    const started = await composition.server.start();
    if (started.outcome !== 'applied') {
      throw new Error(started.diagnostic ?? 'Coordinator startup failed.');
    }
    const stopped = await composition.server.waitForShutdown();
    if (stopped.outcome !== 'applied') {
      throw new Error(stopped.diagnostic ?? 'Coordinator shutdown failed.');
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await composition[Symbol.asyncDispose]();
  } catch (cleanupError) {
    if (primaryError === undefined) primaryError = cleanupError;
  }
  if (primaryError !== undefined) throw primaryError;
}

function requiredValue(source: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = source[name];
  if (
    value === undefined ||
    value.length === 0 ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new Error(`Kite Coordinator requires explicit ${name}.`);
  }
  return value;
}

function requiredAbsolute(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredValue(source, name);
  if (!(value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value))) {
    throw new Error(`Kite Coordinator ${name} must be an absolute path.`);
  }
  return value;
}

function requiredIdentifier(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredValue(source, name);
  if (value.length > 512) throw new Error(`Kite Coordinator ${name} is oversized.`);
  return value;
}

function parseFd(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error('Kite Coordinator requires an explicit readiness fd.');
  }
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > 1_024)
    throw new Error('Kite Coordinator readiness fd is invalid.');
  return fd;
}

function requiredExecutableMode(value: string | undefined): 'source' | 'installed' {
  if (value !== 'source' && value !== 'installed') {
    throw new Error('Kite Coordinator requires an explicit executable mode.');
  }
  return value;
}

function parseOsIdentity(
  source: Readonly<Record<string, string | undefined>>,
): CoordinatorOsIdentity {
  const uid = source.KITE_COORDINATOR_OS_UID;
  const sid = source.KITE_COORDINATOR_OS_SID;
  if (uid !== undefined && sid !== undefined) {
    throw new Error('Kite Coordinator OS identity must use exactly one platform form.');
  }
  if (uid !== undefined && /^\d+$/u.test(uid)) {
    const value = Number(uid);
    if (Number.isSafeInteger(value)) return { kind: 'posix_uid', uid: value };
  }
  if (sid !== undefined && /^S-\d-(?:\d+-){1,15}\d+$/u.test(sid)) {
    return { kind: 'windows_sid', sid };
  }
  throw new Error('Kite Coordinator requires an explicit validated OS identity.');
}

/** Map parsed main environment to composition inputs when a launcher has all control ports. */
export function coordinatorCompositionInputFromMainEnvironment(
  environment: KiteCoordinatorProcessEnvironment,
  dependencies: Omit<
    KiteCoordinatorCompositionOptions,
    'home' | 'catalogStorage' | 'identity' | 'processStartIdentity' | 'peerOsIdentity' | 'readiness'
  > & {
    readonly home: KiteCoordinatorCompositionOptions['home'];
    readonly catalogStorage: KiteCoordinatorCompositionOptions['catalogStorage'];
    readonly identity: KiteCoordinatorCompositionOptions['identity'];
    readonly readiness: KiteCoordinatorCompositionOptions['readiness'];
  },
): KiteCoordinatorCompositionOptions {
  return {
    ...dependencies,
    home: dependencies.home,
    catalogStorage: {
      ...dependencies.catalogStorage,
      canonicalKiteHomeRoot: environment.home,
      catalogPath: environment.catalogPath,
      layoutGeneration: environment.layoutGeneration,
    },
    identity: {
      ...dependencies.identity,
      instanceId: environment.instanceId,
      buildId: environment.buildId,
    },
    processStartIdentity: environment.processStartIdentity,
    peerOsIdentity: environment.peerOsIdentity,
    readiness: dependencies.readiness,
  };
}
