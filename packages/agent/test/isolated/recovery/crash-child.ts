import { appendFileSync } from 'node:fs';
import { createArtifactStore } from '../../../src/artifacts';
import { UnifiedExecution } from '../../../src/execution';
import { ExecutionResources } from '../../../src/execution/resources';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

const store = await openSqliteStore({ dataRoot: process.env.TEST_DATA_ROOT!, profile: 'test' });
const expectedStoreId = (await store.getMetadata()).storeId;
await store.createWorkspace({
  expectedStoreId,
  id: 'w',
  rootUri: 'file:///disposable',
  name: 'fixture',
});
for (const sessionId of ['crashed', 'unrelated']) {
  await store.createSession({
    expectedStoreId,
    commandId: `create-${sessionId}`,
    sessionId,
    workspaceId: 'w',
    title: sessionId,
    subjectId: 'user',
  });
}
await store.acceptCommand({
  expectedStoreId,
  commandId: 'work',
  sessionId: 'crashed',
  subjectId: 'user',
  request: { kind: 'run.start', content: 'fixed harmless fixture' },
});
const owner = (await store.acquireSessionOwner('crashed', 'child'))!;
const run = await store.startRun({ expectedStoreId, owner, commandId: 'work', configuration: {} });
const execution = new UnifiedExecution({
  store,
  publishModelOutput: async (scope, executionId, value) => {
    const artifacts = createArtifactStore({
      profile: { dataRoot: process.env.TEST_DATA_ROOT!, profile: 'test' },
      store,
    });
    try {
      return await artifacts.publish({
        expectedStoreId: scope.run.originStoreId,
        sessionId: scope.run.sessionId,
        subjectId: 'user',
        scope: { kind: 'execution', id: executionId },
        refId: `output-${executionId}-${await semanticDigest(value)}`,
        mediaType: 'application/vnd.kite.model-output+json',
        content: Buffer.from(canonicalJson(value)),
      });
    } finally {
      await artifacts.close();
    }
  },
  permissions: {
    async authorize() {
      return { allowed: true, revision: '0' };
    },
  },
  resources: new ExecutionResources(),
});
const scope = { run, owner, workspaceId: 'w', signal: new AbortController().signal };
const hold = () =>
  new Promise<never>(() => {
    setInterval(() => {}, 1000);
  });
const ready = (phase: string) =>
  console.log(JSON.stringify({ phase, owner, storeId: expectedStoreId, runId: run.id }));
if (process.env.TEST_CRASH_MODE === 'model') {
  await execution.model(
    scope,
    {
      async *stream() {
        yield { type: 'text_delta' as const, text: 'fixed incomplete '.repeat(4096) };
        // The next generator read happens only after the partial transaction commits.
        ready('partial_committed');
        await hold();
      },
    },
    { requestId: 'model', modelId: 'fixed', messages: [], tools: [] },
    'step',
  );
} else {
  await execution.tool(
    scope,
    {
      id: 'ledger',
      version: '1',
      description: 'disposable external ledger',
      inputSchema: { type: 'object' },
      async execute() {
        appendFileSync(process.env.TEST_LEDGER!, 'effect\n', { mode: 0o600 });
        ready('effect_before_result_commit');
        await hold();
        return { outcome: 'succeeded', content: 'unreachable' };
      },
    },
    { id: 'call', name: 'ledger', arguments: '{}' },
    'step',
    'model-decision',
  );
}
