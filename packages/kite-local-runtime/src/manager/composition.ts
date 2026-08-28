import type { LocalRuntimeClientStatePort, LocalRuntimeServiceEnsurePort } from '../client';
import type { KiteHomeIdentity, LocalRuntimeServiceDescriptor } from '../service';
import { createKiteServiceManager } from './manager';
import { createKiteServiceManagerNativePorts } from './native';
import {
  createKiteServiceManagerNativeProcessPort,
  createKiteServiceManagerNativeSpawnPort,
} from './native-process';
import type {
  KiteServiceManager,
  KiteServiceManagerEnvironmentPort,
  KiteServiceManagerExecutableResolver,
  KiteServiceManagerHandshake,
} from './ports';

const READY_PATH = '/readyz';
const CONTROL_STOP_PATH = '/_kite/control/stop';
const CONTROL_AUTHORIZATION_SCHEME = 'Kite-Local-Control';
/**
 * Native manager/service identity proof. This is intentionally duplicated as a literal rather
 * than importing the app-owned carrier: kite-local-runtime must not depend on apps/kite-service.
 */
const INSTANCE_HANDSHAKE_PATH = '/_kite/instance';
const INSTANCE_HANDSHAKE_SCHEMA = 'kite.local-runtime.instance-handshake.v1';
const ACCESS_AUTHORIZATION_SCHEME = 'Kite-Local-Access';
const MAX_HANDSHAKE_BYTES = 4_096;
const MAX_HANDSHAKE_STRING = 512;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type NativeKiteServiceManagerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface NativeKiteServiceManagerCompositionOptions {
  /** Explicit validated identity; ambient KITE_CODE_HOME is never read here. */
  readonly home: KiteHomeIdentity;
  readonly environment: KiteServiceManagerEnvironmentPort;
  readonly executableResolver: KiteServiceManagerExecutableResolver;
  /** Fixed by source/release composition; never inferred from cwd. */
  readonly executableMode?: 'source' | 'installed';
  readonly expectedBuildId?: string;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly fetch?: NativeKiteServiceManagerFetch;
}

function isBoundedHandshakeString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_HANDSHAKE_STRING &&
    !/\p{Cc}/u.test(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function decodeInstanceHandshake(value: unknown): KiteServiceManagerHandshake {
  if (!isRecord(value)) throw new TypeError('Service instance handshake is not an object.');
  const keys = Object.keys(value).sort();
  const expected = [
    'buildId',
    'clientContractRevision',
    'instanceId',
    'protocolVersion',
    'schema',
    'serverVersion',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('Service instance handshake has unexpected fields.');
  }
  if (value.schema !== INSTANCE_HANDSHAKE_SCHEMA) {
    throw new TypeError('Service instance handshake schema is invalid.');
  }
  const protocolVersion = value.protocolVersion;
  if (
    !isBoundedHandshakeString(value.instanceId) ||
    !isBoundedHandshakeString(value.clientContractRevision) ||
    !isBoundedHandshakeString(value.serverVersion) ||
    !isBoundedHandshakeString(value.buildId) ||
    !isPositiveSafeInteger(protocolVersion)
  ) {
    throw new TypeError('Service instance handshake values are invalid.');
  }
  return Object.freeze({
    outcome: 'healthy' as const,
    instanceId: value.instanceId,
    protocolVersion,
    clientContractRevision: value.clientContractRevision,
    serverVersion: value.serverVersion,
    buildId: value.buildId,
  });
}

async function readInstanceHandshake(
  request: NativeKiteServiceManagerFetch,
  descriptor: LocalRuntimeServiceDescriptor,
  accessToken: string,
): Promise<KiteServiceManagerHandshake> {
  const response = await request(new URL(INSTANCE_HANDSHAKE_PATH, descriptor.endpoint.origin), {
    method: 'POST',
    credentials: 'omit',
    headers: {
      authorization: `${ACCESS_AUTHORIZATION_SCHEME} ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: '{}',
  });
  if (response.status !== 200) {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
  const contentType = response.headers.get('content-type');
  if (contentType === null || !/^application\/json(?:;|$)/iu.test(contentType.trim())) {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_HANDSHAKE_BYTES) {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
  try {
    return decodeInstanceHandshake(JSON.parse(body) as unknown);
  } catch {
    return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
  }
}

export interface NativeKiteServiceManagerComposition {
  readonly manager: KiteServiceManager;
  /** Access-only shape consumed by the Native connector; control remains manager-private. */
  readonly clientState: LocalRuntimeClientStatePort;
  /** Exact adapter accepted by createLocalKiteConnection. */
  readonly ensure: LocalRuntimeServiceEnsurePort;
}

/**
 * Compose the reusable Native lifecycle side of a local Service client. The caller still selects
 * an exact source/installed companion and a neutral child environment; this function owns every
 * process/state/auth detail so terminal code cannot grow a second manager implementation.
 */
export function createNativeKiteServiceManagerComposition(
  options: NativeKiteServiceManagerCompositionOptions,
): NativeKiteServiceManagerComposition {
  const request = options.fetch ?? fetch;
  const processPort = createKiteServiceManagerNativeProcessPort();
  const native = createKiteServiceManagerNativePorts({
    identity: options.home,
    process: processPort,
  });
  const manager = createKiteServiceManager({
    state: native.state,
    lifecycleLock: native.lifecycleLock,
    process: processPort,
    spawn: createKiteServiceManagerNativeSpawnPort(),
    environment: options.environment,
    executableResolver: options.executableResolver,
    probe: {
      async handshake(input): Promise<KiteServiceManagerHandshake> {
        try {
          const ready = await request(new URL(READY_PATH, input.descriptor.endpoint.origin), {
            method: 'GET',
            credentials: 'omit',
            headers: { accept: 'text/plain' },
          });
          if (ready.status !== 200 || (await ready.text()) !== 'ready') {
            return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
          }
          // Never reconstruct a healthy handshake from the descriptor read from disk. The
          // authenticated endpoint must return the process-owned identity independently; this
          // prevents a stale descriptor plus a PID-reused/unrelated listener from looking healthy.
          return await readInstanceHandshake(request, input.descriptor, input.accessToken);
        } catch {
          return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
        }
      },
    },
    control: {
      async stop(input) {
        try {
          const response = await request(
            new URL(CONTROL_STOP_PATH, input.descriptor.endpoint.origin),
            {
              method: 'POST',
              credentials: 'omit',
              headers: {
                authorization: `${CONTROL_AUTHORIZATION_SCHEME} ${input.controlToken}`,
                'content-type': 'application/json',
                accept: 'application/json',
              },
              body: '{}',
            },
          );
          if (response.status !== 200) {
            return { outcome: 'unavailable', diagnostic: 'service_unavailable' };
          }
          const value = (await response.json()) as unknown;
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value) ||
            !('outcome' in value) ||
            (value.outcome !== 'applied' &&
              value.outcome !== 'service_busy' &&
              value.outcome !== 'outcome_unknown' &&
              value.outcome !== 'unavailable')
          ) {
            return { outcome: 'unavailable', diagnostic: 'identity_uncertain' };
          }
          return value.outcome === 'service_busy'
            ? { outcome: 'service_busy', diagnostic: 'service_busy' }
            : value.outcome === 'unavailable'
              ? { outcome: 'unavailable', diagnostic: 'service_unavailable' }
              : { outcome: value.outcome };
        } catch {
          return { outcome: 'outcome_unknown' };
        }
      },
    },
    ...(options.expectedBuildId === undefined ? {} : { expectedBuildId: options.expectedBuildId }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.operationTimeoutMs }),
  });
  const ensure: LocalRuntimeServiceEnsurePort = Object.freeze({
    async ensure(input?: Parameters<LocalRuntimeServiceEnsurePort['ensure']>[0]) {
      return manager.ensure({
        ...(input?.clientContractRevision === undefined
          ? {}
          : { clientContractRevision: input.clientContractRevision }),
        ...(options.executableMode === undefined ? {} : { executableMode: options.executableMode }),
      });
    },
  });
  const clientState: LocalRuntimeClientStatePort = Object.freeze({
    readDescriptor: () => native.state.readDescriptor(),
    readToken: () => native.state.readToken('access'),
  });
  return Object.freeze({ manager, ensure, clientState });
}
