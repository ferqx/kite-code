import { join } from 'node:path';
import type { KiteHomeIdentity } from '../service';
import { ensurePrivateKiteHomeDirectory } from '../service';
import {
  COORDINATOR_ENDPOINT_SCHEMA_,
  type CoordinatorEndpointDescriptor,
  type CoordinatorIdentity,
  decodeCoordinatorEndpointDescriptor,
} from './codecs';

export interface CoordinatorUnixSocketEndpointOptions {
  readonly endpointId: string;
  readonly ownerUid: number;
  readonly coordinator: CoordinatorIdentity;
}

export interface CoordinatorNamedPipeEndpointOptions {
  readonly endpointId: string;
  readonly userSid: string;
  readonly coordinator: CoordinatorIdentity;
}

export interface CoordinatorStatePaths {
  readonly root: string;
  /** Server-owned process identity; it deliberately contains no endpoint path. */
  readonly processDescriptor: string;
  readonly endpointDescriptor: string;
  /** Durable pre-spawn fence. Its presence forbids automatic launch replay. */
  readonly launchIntent: string;
  readonly instanceLock: string;
  readonly lifecycleLock: string;
}

const COORDINATOR_STATE_SEGMENTS = Object.freeze(['coordinator', 'v1'] as const);

/**
 * Build the only descriptor a POSIX coordinator may publish.  The socket path
 * is intentionally absent: the carrier derives it from the already validated
 * Kite home and never trusts a path received over the wire.
 */
export function createCoordinatorUnixSocketEndpoint(
  options: CoordinatorUnixSocketEndpointOptions,
): CoordinatorEndpointDescriptor {
  return decodeCoordinatorEndpointDescriptor({
    schema: COORDINATOR_ENDPOINT_SCHEMA_,
    transport: 'unix_socket',
    protection: 'owner_only',
    endpointId: options.endpointId,
    owner: { kind: 'posix_uid', uid: options.ownerUid },
    coordinator: options.coordinator,
  });
}

/**
 * Build a Windows current-user endpoint identity without exposing a named
 * pipe path.  The carrier compares the SID with the authenticated peer.
 */
export function createCoordinatorNamedPipeEndpoint(
  options: CoordinatorNamedPipeEndpointOptions,
): CoordinatorEndpointDescriptor {
  return decodeCoordinatorEndpointDescriptor({
    schema: COORDINATOR_ENDPOINT_SCHEMA_,
    transport: 'named_pipe',
    protection: 'current_user',
    endpointId: options.endpointId,
    owner: { kind: 'windows_sid', sid: options.userSid },
    coordinator: options.coordinator,
  });
}

/**
 * Reuse the existing no-follow/owner-only state walk for coordinator startup.
 * Coordinator-specific endpoint code receives the returned validated home and
 * derives its private socket/pipe name locally; no new filesystem security
 * implementation is introduced here.
 */
export function ensureCoordinatorStateRoot(identity: KiteHomeIdentity): CoordinatorStatePaths {
  const root = ensurePrivateKiteHomeDirectory(identity, COORDINATOR_STATE_SEGMENTS);
  return coordinatorStatePaths(root);
}

/** Pure path derivation for callers that have already performed state validation. */
export function resolveCoordinatorStatePaths(identity: KiteHomeIdentity): CoordinatorStatePaths {
  return coordinatorStatePaths(join(identity.root, ...COORDINATOR_STATE_SEGMENTS));
}

function coordinatorStatePaths(root: string): CoordinatorStatePaths {
  return Object.freeze({
    root,
    processDescriptor: join(root, 'process.json'),
    endpointDescriptor: join(root, 'endpoint.json'),
    launchIntent: join(root, 'launch-intent.json'),
    instanceLock: join(root, 'instance.lock'),
    lifecycleLock: join(root, 'lifecycle.lock'),
  });
}

export function assertCoordinatorEndpointIdentity(
  endpoint: CoordinatorEndpointDescriptor,
  expected: CoordinatorIdentity,
): void {
  const decoded = decodeCoordinatorEndpointDescriptor(endpoint);
  if (
    decoded.coordinator.instanceId !== expected.instanceId ||
    decoded.coordinator.buildId !== expected.buildId ||
    decoded.coordinator.protocolVersion !== expected.protocolVersion ||
    decoded.coordinator.protocolRevision !== expected.protocolRevision ||
    decoded.coordinator.clientContractRevision !== expected.clientContractRevision
  ) {
    throw new TypeError('Coordinator endpoint identity does not match the expected instance');
  }
}
