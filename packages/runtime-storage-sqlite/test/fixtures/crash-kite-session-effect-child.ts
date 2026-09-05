import { openKiteSessionRuntimeStorage } from '../../src';

type Event = { readonly type: string };
type State = {
  readonly revision: number;
  readonly recoveryIdentity: string;
  readonly session: {
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const databasePath = process.argv[2];
if (!databasePath) throw new Error('Expected database path.');

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <Loaded>(json: string) => JSON.parse(json) as Loaded,
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 1 }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  recoveryIdentity: (state: State) => state.recoveryIdentity,
  rebindForkState: (state: State, _sessionId: string, recoveryIdentity: string) => ({
    ...state,
    recoveryIdentity,
  }),
  isCurrentPendingInteractionRequest: () => false,
};

const owner = openKiteSessionRuntimeStorage<Event, State>({
  databasePath,
  codec,
  stateSchemaVersion: 1,
  formatEpoch: 'test-session-state-v1',
});
const leaseUntilMs = Date.now() + 600;
const acquired = owner.authority.acquire({
  sessionId: 'session-1',
  expectedRevision: 0,
  hostInstanceId: `host-crash-${process.pid}`,
  clientId: `client-crash-${process.pid}`,
  connectionGeneration: 1,
  leaseUntilMs,
});
if (acquired.status !== 'acquired') throw new Error('Expected crash fixture authority.');
const handle = owner.bindExecution(acquired.authority);
owner.runWithExecution(handle, () => {
  if (
    !owner.storage.effects.tryAcquireEffectLease(
      'session-1',
      'effect-sigkill',
      'owner-sigkill',
      leaseUntilMs,
    )
  ) {
    throw new Error('Expected crash fixture effect lease.');
  }
});

process.stdout.write(`${JSON.stringify({ status: 'ready', leaseUntilMs })}\n`);
setInterval(() => undefined, 60_000);
