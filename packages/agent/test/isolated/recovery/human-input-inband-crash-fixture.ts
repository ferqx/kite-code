import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

// Historical in-band interpretation used an ordinary Run, not a processing
// configuration. Current admission cannot dispatch that removed capability, so
// seal its old source with the audit writer after creating the execution facts.
const root = process.argv[2]!;
const boundary = process.argv[3]!;
const profile = { dataRoot: join(root, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
await store.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'legacy in-band',
  rootUri: pathToFileURL(root).href,
});
await store.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 'legacy' });
await store.acceptCommand({
  ...scope,
  commandId: 'work',
  request: { kind: 'run.start', content: 'Original ordinary work' },
});
const owner = (await store.acquireSessionOwner('s', 'legacy-host'))!;
const run = await store.startRun({
  expectedStoreId,
  owner,
  commandId: 'work',
  configuration: {
    modelId: 'ordinary',
    extensions: [],
    tools: [],
    maxConcurrentSubagents: 3,
    snapshot: { authorizationReview: null, value: null },
  },
});
await store.beginRunRequirementsInitialization({ expectedStoreId, owner, runId: run.id });
await store.registerRunRequirements({
  expectedStoreId,
  owner,
  runId: run.id,
  requirements: [],
  initialize: true,
});
const raw = await store.registerHumanInput({
  ...scope,
  commandId: 'legacy-raw',
  content: 'Old pending progress question',
  contextSelectionId: run.contextSelectionId,
  observedRunId: run.id,
  candidateWorkCommandIds: ['work'],
});
async function model(executionId: string, succeeded: boolean) {
  const input = { modelId: 'ordinary', requestId: executionId, messages: [], tools: [] };
  await store.planExecution({
    expectedStoreId,
    owner,
    sessionId: 's',
    runId: run.id,
    executionId,
    originCommandId: 'work',
    stepId: executionId,
    callId: 'model',
    kind: 'model',
    definitionId: 'ordinary',
    definitionVersion: '1',
    input,
    decisionSource: {
      kind: 'model_request',
      requestId: executionId,
      toolBindings: [],
      continuation: {
        version: 2,
        runId: run.id,
        contextSelectionId: run.contextSelectionId,
        sourceRequests: [],
        toolFailureStreak: { signature: null, count: 0 },
      },
    },
  });
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId,
    authorization: {
      allowed: true,
      revision: 'legacy',
      definitionVersion: '1',
      inputDigest: await semanticDigest(input),
    },
    requirements: [],
    freshness: { checked: true, source: (await store.getExecution(executionId))!.decisionSource },
  });
  if (succeeded)
    await store.finishExecution({
      expectedStoreId,
      owner,
      executionId,
      status: 'succeeded',
      result: { content: 'Historical interpretation', finishReason: 'stop', toolCalls: [] },
      message: {
        role: 'assistant',
        content: 'Historical interpretation',
        toolCalls: [],
        sourceIds: [executionId],
      },
    });
}
await model('legacy-model', boundary !== 'running');
if (boundary === 'prior') await model('ordinary-model', false);
const legacy = (await store.getExecution('legacy-model'))!;
const native = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
const ops = new SqliteOperations(native, false);
try {
  ops.tx(() => {
    ops.run(
      "UPDATE execution SET decision_source_json=? WHERE id='legacy-model'",
      JSON.stringify({
        ...(legacy.decisionSource as object),
        humanInputInterpretation: { inputCommandId: raw.id, inputDigest: raw.requestDigest },
      }),
    );
  });
} finally {
  ops.releaseStatements();
  native.close(true);
}
console.log(
  JSON.stringify({
    expectedStoreId,
    rawId: raw.id,
    processingId: 'work',
    runId: run.id,
    generation: (await store.getSession('s'))!.ownerGeneration,
  }),
);
await new Promise(() => {});
