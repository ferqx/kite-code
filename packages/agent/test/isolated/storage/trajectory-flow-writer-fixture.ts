import { join } from 'node:path';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

// Isolated test executable: readiness follows the actual business transaction commit.
// No Reader or delivery consumer runs before the parent kills this original writer.
const [dataRoot, mode] = process.argv.slice(2);
if (!dataRoot || !['committed', 'dispatching'].includes(mode!)) throw Error('invalid fixture');
const store = await openSqliteStore({ dataRoot, profile: 'flow' });
const expectedStoreId = (await store.getMetadata()).storeId;
await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
await store.createSession({
  expectedStoreId,
  commandId: 'create',
  sessionId: 's',
  workspaceId: 'w',
  subjectId: 'user',
  title: 'flow',
});
await store.acceptCommand({
  expectedStoreId,
  commandId: 'work',
  sessionId: 's',
  subjectId: 'user',
  request: { kind: 'run.start', content: 'original intent' },
});
const owner = (await store.acquireSessionOwner('s', 'writer'))!;
const run = await store.startRun({ expectedStoreId, owner, commandId: 'work', configuration: {} });
const source = { kind: 'model_decision', modelExecutionId: 'decision' };
const input: Json =
  mode === 'committed' ? { modelId: 'fixed', requestId: 'original', messages: [], tools: [] } : {};
await store.planExecution({
  expectedStoreId,
  owner,
  executionId: 'original',
  sessionId: 's',
  runId: run.id,
  originCommandId: 'work',
  stepId: 'step',
  callId: 'call',
  kind: mode === 'committed' ? 'model' : 'tool',
  definitionId: 'fixed',
  definitionVersion: '1',
  input,
  decisionSource: source,
});
if (mode === 'dispatching')
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId: 'original',
    authorization: {
      allowed: true,
      revision: '0',
      definitionVersion: '1',
      inputDigest: await semanticDigest(input),
    },
    requirements: [],
    freshness: { checked: true, source },
  });
const db = new Database(join(dataRoot, 'flow', 'core.db'), { readonly: true });
const row = db
  .query<{ trajectory_fact_json: string }, []>(
    "SELECT trajectory_fact_json FROM change_event WHERE object_id='original' ORDER BY cursor DESC LIMIT 1",
  )
  .get()!;
const fact = JSON.parse(row.trajectory_fact_json);
db.close(true);
console.log(
  JSON.stringify({
    expectedStoreId,
    owner,
    runId: run.id,
    eventId: fact.event.eventId,
    cursor: fact.event.sequence,
    kind: fact.event.kind,
    phase: fact.event.phase,
  }),
);
setInterval(() => {}, 1000);
