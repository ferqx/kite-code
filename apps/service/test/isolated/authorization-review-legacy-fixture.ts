import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';

const root = process.env.KITE_REVIEW_FIXTURE_ROOT!;
const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
const store = await openSqliteStore(profile);
const artifacts = createArtifactStore({ profile, store });
const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
const request = {
  task: 'legacy public complete request',
  full: 'Original review 雪🙂'.repeat(8000),
};
const model = createFixedModel([
  [
    { type: 'tool_call', id: 'first', name: 'fixture.noop', arguments: '{}' },
    {
      ...finish,
      reason: 'tool_calls',
      continuation: { encrypted: `PRIVATE_LEGACY_COLD${'x'.repeat(80 * 1024)}` },
    },
  ],
  [
    { type: 'tool_call', id: 'second', name: 'fixture.effect', arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  ],
]);
const runtime = createRuntime({
  store,
  artifacts: {
    ...artifacts,
    publish: (input) =>
      artifacts.publish({
        ...input,
        refId: input.refId.replace(/^authorization-review-request-/, 'model-body-'),
      }),
  },
  model,
  modelId: 'original',
  authorizationReview: {
    id: 'reviewer',
    version: '1',
    modelId: 'reviewer',
    model: createFixedModel([
      [
        {
          type: 'text_delta',
          text: JSON.stringify({ decision: 'ask_user', reason: 'Human review needed' }),
        },
        { ...finish, continuation: { encrypted: 'PRIVATE_REVIEWER_COLD' } },
      ],
    ]),
  },
  permissions: {
    async authorize(input) {
      return input.definitionId === 'fixture.effect'
        ? { allowed: false, revision: 'p1', review: { request } }
        : { allowed: true, revision: 'p1' };
    },
  },
  extensions: [
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: ['fixture.noop', 'fixture.effect'].map((id) => ({
        id,
        version: '1',
        description: 'Harmless local fixture',
        inputSchema: { type: 'object' },
        async execute() {
          if (id === 'fixture.effect') throw new Error('Unapproved effect');
          return { outcome: 'succeeded' as const, content: 'done' };
        },
      })),
    },
  ],
});
const expectedStoreId = (await store.getMetadata()).storeId;
const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'owned',
  rootUri: pathToFileURL(root).href,
});
await runtime.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 'owned' });
await runtime.submitCommand({
  ...scope,
  commandId: 'work',
  request: { kind: 'run.start', content: 'Review exact harmless operation' },
});
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  const card = (await runtime.listInteractions({ ...scope, state: 'pending' })).interactions[0];
  if (card) {
    const carrier = (await store.listExecutions('s')).find((e) => e.childSessionId)!;
    const privateReferences = [];
    for (const sessionId of ['s', carrier.childSessionId!]) {
      for (const execution of await store.listExecutions(sessionId)) {
        if (execution.kind !== 'model') continue;
        const input = await store.getModelInputSnapshot({
          ...scope,
          sessionId,
          executionId: execution.id,
        });
        const body = (input.input as { body?: { reference: unknown } }).body;
        if (body) privateReferences.push(body.reference);
        const output = await store.getModelOutputSnapshot({
          ...scope,
          sessionId,
          executionId: execution.id,
        });
        if (output.output) privateReferences.push(output.output.head);
      }
    }
    writeFileSync(
      join(root, 'ready.json'),
      JSON.stringify({
        expectedStoreId,
        card,
        request,
        privateReferences,
        child: carrier.childSessionId,
      }),
    );
    await new Promise<never>(() => {
      setInterval(() => {}, 1000);
    });
  }
  await Bun.sleep(10);
}
throw new Error('Legacy pending card was not produced');
