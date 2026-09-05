import { KiteSessionExecutionAuthorityError, openKiteSessionRuntimeStorage } from '../../src';

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
const sessionId = process.argv[3];
const hostInstanceId = process.argv[4];
const name = process.argv[5];
const startAt = Number(process.argv[6]);
if (!databasePath || !sessionId || !hostInstanceId || !name || !Number.isSafeInteger(startAt)) {
  throw new Error('Expected database, Session, Host, name and synchronized start.');
}

const waitMs = startAt - Date.now();
if (waitMs > 0) await Bun.sleep(waitMs);
const owner = openKiteSessionRuntimeStorage<Event, State>({
  databasePath,
  stateSchemaVersion: 1,
  formatEpoch: 'test-session-state-v1',
  codec: {
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
    rebindForkState: (state: State) => state,
    isCurrentPendingInteractionRequest: () => false,
  },
});
try {
  const acquired = owner.authority.acquire({
    sessionId,
    expectedRevision: 0,
    hostInstanceId,
    clientId: `client-${hostInstanceId}`,
    connectionGeneration: 1,
    leaseUntilMs: Date.now() + 60_000,
  });
  if (acquired.status !== 'acquired') {
    console.log(JSON.stringify({ status: acquired.status }));
  } else {
    const handle = owner.bindExecution(acquired.authority);
    owner.runWithExecution(handle, () => owner.storage.sessions.setSessionName(sessionId, name));
    console.log(JSON.stringify({ status: 'written' }));
  }
} catch (error) {
  if (error instanceof KiteSessionExecutionAuthorityError) {
    console.log(JSON.stringify({ status: error.code }));
  } else {
    throw error;
  }
} finally {
  owner.close();
}
