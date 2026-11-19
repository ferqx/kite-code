import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createFixedModel } from '@kite-ai/ai';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import {
  type WebSearchEvidenceBlock,
  webSearchCitationAnchor,
} from '../../../src/web-search-evidence';

test('citations use exact stored text, UTF-16 boundaries and per-block offsets', () => {
  const text = '甲😀乙';
  expect(webSearchCitationAnchor('model', 1, text, 1, 3, 9)).toEqual({
    executionId: 'model',
    blockIndex: 1,
    textSha256: createHash('sha256').update(text).digest('hex'),
    blockLengthUtf16: 4,
    blockStartUtf16: 9,
    startUtf16: 1,
    endUtf16: 3,
  });
  expect(webSearchCitationAnchor('model', 1, text, 2, 3)).toBeUndefined();
  expect(webSearchCitationAnchor('model', 1, text, 1, 2)).toBeUndefined();
  expect(webSearchCitationAnchor('model', 1, text, 0, 6)).toBeUndefined();
});

test('search evidence is an immutable scoped Artifact history with bounded disk and read projections', async () => {
  const root = temporaryDirectory('kite-web-search-evidence-');
  const profile = { dataRoot: root, profile: 'owned' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ store, profile });
  const model = createFixedModel([
    [
      { type: 'text_delta', text: '甲😀乙' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [
      { type: 'text_delta', text: '第二个会话' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    const owner = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...owner,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Search',
    });
    await runtime.submitCommand({
      ...owner,
      commandId: 'start',
      request: { kind: 'run.start', content: 'Owned diagnostic' },
    });
    await runtime.waitForCommand('start', { timeoutMs: 10000 });
    const executionId = (await runtime.listModelInputs(owner)).items[0]!.executionId;
    const scope = { ...owner, executionId };
    const original = await runtime.readModelOutput(scope);
    expect(
      original.output.content,
      JSON.stringify((await store.getExecution(executionId))?.result),
    ).toBe('甲😀乙');
    expect(await runtime.readWebSearchEvidence(scope)).toMatchObject({ revision: 0, blocks: [] });
    const block: WebSearchEvidenceBlock = {
      callId: 'call-1',
      provider: 'owned',
      route: 'native',
      status: 'searching',
      query: 'example',
      sources: [],
      citations: [],
      truncated: false,
    };
    const ref = await runtime.publishWebSearchEvidence(scope, block);
    expect(ref).toMatchObject({
      storeId: expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'execution', id: executionId },
      mediaType: 'application/vnd.kite.web-search+json',
    });
    expect(await runtime.publishWebSearchEvidence(scope, block)).toEqual(ref);
    const large: WebSearchEvidenceBlock = {
      ...block,
      status: 'completed',
      sources: [
        { url: 'javascript:bad' },
        { url: 'https://@example.test/' },
        { url: 'https://synthetic:secret@example.test' },
        ...Array.from({ length: 64 }, (_, n) => ({
          url: `https://example.test/${n}`,
          snippet: '字'.repeat(2100),
        })),
      ],
      citations: [
        {
          url: 'https://example.test',
          anchor: webSearchCitationAnchor(executionId, 0, '甲😀乙', 1, 3),
        },
        {
          url: 'https://fallback.test',
          anchor: webSearchCitationAnchor('another-execution', 0, 'x', 0, 1),
        },
      ],
    };
    await Promise.all([
      runtime.publishWebSearchEvidence(scope, large),
      runtime.publishWebSearchEvidence(scope, { ...block, callId: 'call-2', status: 'incomplete' }),
    ]);
    const snapshot = await runtime.readWebSearchEvidence(scope);
    expect(snapshot.revision).toBe(3);
    const first = snapshot.blocks.find((b) => b.callId === 'call-1')!;
    expect(first.truncated).toBe(true);
    expect(first.sources.length).toBeGreaterThan(0);
    expect(first.sources.every((s) => s.url.startsWith('https://example.test/'))).toBe(true);
    expect(first.citations[0]!.anchor).toEqual(
      webSearchCitationAnchor(executionId, 0, '甲😀乙', 1, 3),
    );
    expect(first.citations[1]).toEqual({ url: 'https://fallback.test' });
    expect(await runtime.publishWebSearchEvidence(scope, large)).toMatchObject({
      mediaType: ref.mediaType,
    });
    expect((await runtime.readWebSearchEvidence(scope)).revision).toBe(3);
    // A Bun rejects matcher can block the SQLite Worker's acknowledgement on this thread.
    const errorOf = (task: Promise<unknown>) => task.catch((error: unknown) => error);
    expect(await errorOf(runtime.publishWebSearchEvidence(scope, block))).toMatchObject({
      code: 'web_search_evidence_transition_invalid',
    });
    expect(
      await errorOf(runtime.publishWebSearchEvidence(scope, { ...block, route: 'provider' })),
    ).toMatchObject({
      code: 'web_search_evidence_unavailable',
    });
    await runtime.publishWebSearchEvidence(scope, {
      ...block,
      sourceScope: 'response',
      status: 'incomplete',
    });
    const grouped = await runtime.readWebSearchEvidence(scope);
    expect(
      grouped.blocks.filter((row) => row.callId === 'call-1').map((row) => row.status),
    ).toEqual(['completed', 'incomplete']);
    const sibling = { ...owner, sessionId: 'sibling' };
    await runtime.createSession({
      ...sibling,
      commandId: 'create-sibling',
      workspaceId: 'w',
      title: 'Other',
    });
    await runtime.submitCommand({
      ...sibling,
      commandId: 'start-sibling',
      request: { kind: 'run.start', content: 'Independent' },
    });
    await runtime.waitForCommand('start-sibling', { timeoutMs: 10000 });
    const siblingId = (await runtime.listModelInputs(sibling)).items[0]!.executionId;
    expect(
      await runtime.readWebSearchEvidence({ ...sibling, executionId: siblingId }),
    ).toMatchObject({ revision: 0, blocks: [] });
    for (const wrong of [
      { subjectId: 'different' },
      { sessionId: 'different' },
      { executionId: 'missing' },
      { sessionId: sibling.sessionId },
      { executionId: siblingId },
    ]) {
      expect(await errorOf(runtime.readWebSearchEvidence({ ...scope, ...wrong }))).toMatchObject({
        code: 'web_search_evidence_unavailable',
      });
    }
    expect(
      await errorOf(runtime.readWebSearchEvidence({ ...scope, expectedStoreId: 'other' })),
    ).toMatchObject({
      code: 'store_identity_mismatch',
    });
    for (let n = 0; n < 22; n++) {
      try {
        await runtime.publishWebSearchEvidence(scope, { ...large, callId: `large-${n}` });
      } catch (e) {
        expect(e).toMatchObject({ code: 'web_search_evidence_limit' });
        break;
      }
    }
    const refs = await store.listWebSearchEvidenceReferences(scope);
    const total = refs.reduce((sum, reference) => sum + Number(reference.size), 0);
    expect(total).toBeGreaterThan(900000);
    expect(total).toBeLessThanOrEqual(1024 * 1024);
    expect(refs.every((reference) => Number(reference.size) <= 64 * 1024)).toBe(true);
    expect((await runtime.readModelOutput(scope)).output).toEqual(original.output);
    expect(model.requests).toHaveLength(2);
    const final = await runtime.readWebSearchEvidence(scope);
    expect(Buffer.byteLength(JSON.stringify(final))).toBeLessThanOrEqual(1024 * 1024);
    await runtime.close();
    const coldStore = await openSqliteStore({ ...profile, mode: 'readonly' });
    const coldModel = createFixedModel([]);
    const cold = createRuntime({
      store: coldStore,
      artifacts: createArtifactStore({ store: coldStore, profile }),
      model: coldModel,
      permissions: {
        async authorize() {
          throw Error('unexpected_cold_authorization');
        },
      },
    });
    try {
      expect(await cold.readWebSearchEvidence(scope)).toEqual(final);
      expect((await cold.readModelOutput(scope)).output).toEqual(original.output);
      expect(coldModel.requests).toHaveLength(0);
    } finally {
      await cold.close();
    }
  } finally {
    await runtime.close();
    removeTemporaryDirectory(root);
  }
}, 30000);
