import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { bootstrapResponse, bootstrapSchema, type DaemonBootstrap } from './bootstrap';
import { readProcessStartIdentity } from './process-identity';
import {
  type DaemonEndpoint,
  DaemonEndpointCleanupError,
  type DaemonProfile,
  daemonError,
  endpointCleanupUnknown,
  readReservationDetails,
  reservationSchema,
  sameIdentity,
  sameRecord,
  windowsPipePattern,
} from './reservation';
import { createWindowsDaemonPipe } from './windows-pipe';
import { reserveWindowsDaemonRecord } from './windows-record';
import { windowsDaemonSecurity } from './windows-security';

/** OS token/known-folder observation only. No path or Store creation during selection. */
export function selectWindowsEndpoint(input: {
  profileAccessKey: string;
  explicitSocket?: string;
}): DaemonEndpoint {
  if (!/^[a-f0-9]{64}$/.test(input.profileAccessKey)) throw daemonError('daemon_invalid_selection');
  const security = windowsDaemonSecurity();
  const sidKey = createHash('sha256').update(security.sidText).digest('hex');
  const socket =
    input.explicitSocket ?? `\\\\.\\pipe\\kite-daemon-v1-${sidKey}-${input.profileAccessKey}`;
  if (socket.length > 256 || !windowsPipePattern.test(socket))
    throw daemonError('daemon_invalid_endpoint');
  const root = win32.join(security.recordBase, createHash('sha256').update(socket).digest('hex'));
  return Object.freeze({
    root,
    socket,
    record: win32.join(root, 'owner.json'),
    profileAccessKey: input.profileAccessKey,
    transport: 'windows-pipe' as const,
  });
}
export async function reserveWindowsEndpoint(
  endpoint: DaemonEndpoint,
  identity: { profile: DaemonProfile; instanceId: string; buildId: string; workspace: string },
) {
  const expected = selectWindowsEndpoint({
    profileAccessKey: endpoint.profileAccessKey,
    explicitSocket: endpoint.socket,
  });
  if (
    endpoint.transport !== expected.transport ||
    endpoint.root !== expected.root ||
    endpoint.record !== expected.record
  )
    throw daemonError('daemon_invalid_endpoint');
  const selected = selectProfile({
    dataRoot: identity.profile.dataRoot,
    profile: identity.profile.name,
  });
  if (
    selected.dataRoot !== identity.profile.dataRoot ||
    selected.profileAccessKey !== identity.profile.accessKey ||
    selected.profileAccessKey !== endpoint.profileAccessKey
  )
    throw daemonError('daemon_identity_mismatch');
  const workspace = realpathSync.native(identity.workspace);
  if (workspace !== identity.workspace || !lstatSync(workspace).isDirectory())
    throw daemonError('daemon_invalid_workspace');
  const start = readProcessStartIdentity(process.pid);
  if (!start) throw daemonError('daemon_identity_unavailable');
  let record = reservationSchema.parse({
    reservationVersion: 1,
    profile: structuredClone(identity.profile),
    instanceId: identity.instanceId,
    buildId: identity.buildId,
    workspace,
    pid: process.pid,
    processStartIdentity: start,
  });
  if (readReservationDetails(endpoint)) throw daemonError('daemon_endpoint_busy');
  const bytes = () => Buffer.from(`${JSON.stringify(record)}\n`);
  const file = reserveWindowsDaemonRecord(endpoint.record, bytes());
  let pipe: ReturnType<typeof createWindowsDaemonPipe> | undefined;
  let closed = false,
    listening = false,
    closeTask: Promise<void> | undefined;
  const resources = {
    file,
    get pipe() {
      return pipe;
    },
  };
  const close = () =>
    (closeTask ??= (async () => {
      closed = true;
      // Do not remove the owner record or close its pin while any original pipe I/O remains unknown.
      try {
        await pipe?.close();
      } catch (error) {
        throw new DaemonEndpointCleanupError(error, resources);
      }
      let removalError: unknown;
      try {
        file.remove(bytes());
      } catch (error) {
        if (endpointCleanupUnknown(error)) throw new DaemonEndpointCleanupError(error, resources);
        removalError = error;
      }
      try {
        file.close();
      } catch (error) {
        throw new DaemonEndpointCleanupError(
          removalError ? new AggregateError([removalError, error]) : error,
          resources,
        );
      }
      if (removalError) throw removalError;
    })());
  try {
    pipe = createWindowsDaemonPipe(endpoint.socket);
  } catch (error) {
    // A foreign pipe is preserved; only this newly acquired, unopened record can be removed.
    if (endpointCleanupUnknown(error)) throw new DaemonEndpointCleanupError(error, resources);
    try {
      file.remove(bytes());
      file.close();
    } catch (cleanup) {
      throw new DaemonEndpointCleanupError(new AggregateError([error, cleanup]), resources);
    }
    throw error;
  }
  return Object.freeze({
    get reservation() {
      return structuredClone(record);
    },
    close,
    async listen(input: Pick<DaemonBootstrap, 'httpEndpoint' | 'token' | 'webOrigin'>) {
      if (closed || listening) throw daemonError('daemon_endpoint_state');
      listening = true;
      const frame = bootstrapSchema.omit({ requestId: true }).parse({
        requestVersion: 1,
        operation: 'bootstrap',
        profile: record.profile,
        instanceId: record.instanceId,
        buildId: record.buildId,
        pid: record.pid,
        processStartIdentity: record.processStartIdentity,
        workspace: record.workspace,
        ...input,
      });
      try {
        const observed = readReservationDetails(endpoint);
        if (
          !observed ||
          !sameIdentity(observed.identity, file.identity) ||
          !sameRecord(observed.record, record)
        )
          throw daemonError('daemon_endpoint_drift');
        await pipe!.listen((request) => bootstrapResponse(request, frame));
        if (closed) throw daemonError('daemon_endpoint_state');
        record = { ...record, pipe: endpoint.socket };
        file.publish(bytes());
        return { close };
      } catch (error) {
        try {
          await close();
        } catch (cleanup) {
          throw new DaemonEndpointCleanupError(new AggregateError([error, cleanup]), resources);
        }
        throw error;
      }
    },
  });
}
