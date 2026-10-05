import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
export async function largeInteractionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-large-human-')));
  const selected = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const store = await openSqliteStore({ dataRoot: selected.dataRoot, profile: selected.profile });
  const artifacts = createArtifactStore({ profile: selected, store });
  let corrupt = false,
    effects = 0;
  const body = `begin\n${'x'.repeat(17 * 1024 * 1024)}\nend`;
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'call', name: 'fixture.effect', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const reviewer = createFixedModel([
    [
      { type: 'text_delta', text: '{"decision":"ask_user","reason":"human complete review"}' },
      finish,
    ],
  ]);
  const runtime = createRuntime({
    store,
    artifacts: {
      ...artifacts,
      async read(input) {
        const bytes = await artifacts.read(input);
        if (corrupt && bytes.length > 17 * 1024 * 1024) {
          const changed = new Uint8Array(bytes);
          changed[0] = changed[0]! ^ 1;
          return changed;
        }
        return bytes;
      },
    },
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    authorizationReview: { id: 'review', version: '1', modelId: 'review-model', model: reviewer },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'private count',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'actual effect' };
            },
          },
        ],
      },
    ],
    permissions: {
      async authorize(request) {
        return request.kind === 'model'
          ? { allowed: true, revision: 'p1' }
          : {
              allowed: false,
              revision: 'p1',
              review: { request: { task: body, plan: { full: 'actual fixed plan' } } },
            };
      },
    },
  });
  const storeId = (await store.getMetadata()).storeId;
  const profile = {
    dataRoot: selected.dataRoot,
    name: selected.profile,
    accessKey: selected.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    subjectId: 'owner',
    buildId: 'large-human-fixture',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['commands', 'interactions'] },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  for (const sessionId of ['s', 'other'])
    await client.createSession({
      expectedStoreId: storeId,
      sessionId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: sessionId,
    });
  async function start() {
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'actual harmless request',
    });
    const end = Date.now() + 20000;
    for (;;) {
      const card = (await client.listInteractions('s', { storeId, state: 'pending' }))
        .interactions[0];
      if (card) return card;
      if (Date.now() > end) throw new Error('large_interaction_deadline');
      await Bun.sleep(5);
    }
  }
  return {
    root,
    store,
    runtime,
    client,
    storeId,
    body,
    start,
    model,
    reviewer,
    effects: () => effects,
    setCorrupt(value: boolean) {
      corrupt = value;
    },
    async close() {
      corrupt = false;
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
