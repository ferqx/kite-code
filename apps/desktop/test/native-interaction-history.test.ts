import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type Interaction, interactionAttachment } from '@kite-ai/client';
import { NativeInteractionAttachmentReads } from '../electron/interaction-attachment-reads';
import { NativeInteractionHistoryReads } from '../electron/interaction-history-reads';
import { decodeNativeRequest } from '../electron/native-ipc';
import type { NativeInteractionHistoryScope } from '../src/interaction-history-bridge';
import type { NativeBridge } from '../src/native-bridge';
import { readNativeInteractionAttachment } from '../src/native-interaction-attachment';

const scope: NativeInteractionHistoryScope = {
  generation: 1,
  viewSelection: 2,
  historyEpoch: 3,
  storeId: 'store',
  sessionId: 'root',
  workspaceId: 'workspace',
};
const card = (id: string): Interaction => ({
  id,
  originStoreId: 'store',
  sessionId: 'source',
  presentationSessionId: 'root',
  ancestry: ['source', 'root'],
  runId: 'run',
  executionId: 'execution',
  attempt: 1,
  kind: 'question',
  definitionId: 'custom.question',
  definitionVersion: '7',
  inputDigest: 'digest',
  policyRevision: 'original',
  requiredRefs: [],
  answer: { kind: 'question', answers: { value: ' 原回答\r\n雪🙂 ' } },
  revision: '2',
  acceptedDecisionRevision: '2',
  state: 'answered',
  request: {
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
});
const info = { storeId: 'store', capabilities: ['interactions'] };

test('original root history consumes every page and preserves generic child answers, cancellation and accepted revisions without writes', async () => {
  const rows = Array.from({ length: 43 }, (_, i) => card(`record-${String(i).padStart(3, '0')}`));
  rows[21] = { ...rows[21]!, state: 'cancelled', acceptedDecisionRevision: null };
  rows[42] = {
    ...rows[42]!,
    kind: 'plan_review',
    answer: { kind: 'plan_review', decision: 'revise', feedback: ' 原反馈\r\n雪 ' },
  };
  const calls: unknown[] = [];
  let closed: AbortSignal | undefined;
  const reader = new NativeInteractionHistoryReads(
    {
      serverInfo: info,
      listInteractions: async (sessionId, query, options) => {
        calls.push([sessionId, query]);
        closed = options?.signal;
        const after = query.afterId ? rows.findIndex((row) => row.id === query.afterId) + 1 : 0;
        const page = rows.slice(after, after + 20);
        return {
          interactions: page,
          nextAfterId: after + 20 < rows.length ? page.at(-1)!.id : null,
          snapshotCursor: '9007199254740993',
        };
      },
    } as ConstructorParameters<typeof NativeInteractionHistoryReads>[0],
    () => scope,
  );
  const all: Interaction[] = [];
  let page = await reader.open({ readId: 'history', viewSelection: 2, historyEpoch: 3 });
  for (;;) {
    all.push(...page.page.interactions);
    if (page.page.nextAfterId === null) break;
    page = await reader.next('history');
  }
  expect(all).toEqual(rows);
  expect(calls).toHaveLength(3);
  expect(calls[0]).toEqual(['root', { storeId: 'store', origin: 'all', limit: 20 }]);
  expect(all[21]!.answer).toEqual(rows[21]!.answer);
  reader.close('other-reader');
  expect(closed?.aborted).toBe(false);
  reader.close('history');
  expect(closed?.aborted).toBe(true);
  await expect(reader.next('history')).rejects.toMatchObject({
    code: 'interaction_history_read_missing',
  });
});

test('restored readonly history preserves original Store and requests explicit historical admission', async () => {
  const original = { ...card('restored'), originStoreId: 'original-store' };
  const reads: unknown[] = [];
  const reader = new NativeInteractionHistoryReads(
    {
      serverInfo: info,
      listInteractions: async (sessionId, query) => {
        reads.push([sessionId, query]);
        return { interactions: [original], nextAfterId: null, snapshotCursor: '10' };
      },
    } as ConstructorParameters<typeof NativeInteractionHistoryReads>[0],
    () => scope,
  );
  try {
    const page = await reader.open({ readId: 'restored', viewSelection: 2, historyEpoch: 3 });
    expect(page.scope.storeId).toBe('store');
    expect(page.page.interactions).toEqual([original]);
    expect(reads).toEqual([['root', { storeId: 'store', origin: 'all', limit: 20 }]]);
  } finally {
    reader.close('restored');
  }
});

test('a changing page and a late old selection cannot publish a complete history or release another reader', async () => {
  let current = { ...scope },
    resolve!: (value: {
      interactions: Interaction[];
      nextAfterId: null;
      snapshotCursor: string;
    }) => void;
  let late = false,
    changed = false;
  const reader = new NativeInteractionHistoryReads(
    {
      serverInfo: info,
      listInteractions: async (_id, query) => {
        if (late)
          return new Promise((done) => {
            resolve = done;
          });
        return {
          interactions: [card(query.afterId ? 'record-b' : 'record-a')],
          nextAfterId: query.afterId ? null : 'record-a',
          snapshotCursor: changed ? '11' : '10',
        };
      },
    } as ConstructorParameters<typeof NativeInteractionHistoryReads>[0],
    () => current,
  );
  await reader.open({ readId: 'old', viewSelection: 2, historyEpoch: 3 });
  changed = true;
  await expect(reader.next('old')).rejects.toThrow('interaction_history_changed');
  late = true;
  const pending = reader.open({ readId: 'late', viewSelection: 2, historyEpoch: 3 });
  await Promise.resolve();
  current = { ...scope, sessionId: 'next', viewSelection: 4 };
  resolve({ interactions: [], nextAfterId: null, snapshotCursor: '11' });
  await expect(pending).rejects.toMatchObject({ code: 'interaction_history_view_changed' });
  expect(() =>
    decodeNativeRequest({
      method: 'interactionHistory.open',
      generation: 1,
      readId: 'read',
      viewSelection: 2,
      historyEpoch: 3,
      sessionId: 'foreign',
    }),
  ).toThrow('invalid_native_request');
});

test('historical attachment reading keeps the original body proof isolated from the active approval reader', async () => {
  const text = JSON.stringify({
    definitionId: 'custom.question',
    definitionVersion: '7',
    input: { value: '原完整请求雪🙂\r\n'.repeat(6000) },
    grants: ['approve_once'],
  });
  const content = new TextEncoder().encode(text),
    hash = createHash('sha256').update(content).digest('hex');
  const original = {
    ...card('record'),
    kind: 'approval' as const,
    request: {
      policy: {
        review: {
          kind: 'artifact',
          complete: true,
          reference: {
            id: 'body',
            mediaType: 'application/json',
            size: String(content.length),
            scope: { kind: 'execution', id: 'execution' },
          },
        },
      },
    },
  };
  const attachment = interactionAttachment(original)!;
  let artifactReads = 0;
  const reader = new NativeInteractionHistoryReads(
    {
      serverInfo: info,
      listInteractions: async () => ({
        interactions: [original],
        nextAfterId: null,
        snapshotCursor: '10',
      }),
      getInteraction: async () => original,
      readInteractionAttachment: async (actual) => {
        expect(actual).toEqual(original);
        artifactReads++;
        return {
          identity: attachment.key,
          reference: { ...attachment.reference, hash, storeId: 'store' },
          content,
          text,
        };
      },
    } as ConstructorParameters<typeof NativeInteractionHistoryReads>[0],
    () => scope,
  );
  const active = new NativeInteractionAttachmentReads(
    async () => {
      throw Error('active reader must not run');
    },
    () => ({
      generation: 1,
      selection: 2,
      storeId: 'store',
      sessionId: 'root',
      interactions: [original],
    }),
  );
  await reader.open({ readId: 'history', viewSelection: 2, historyEpoch: 3 });
  const methods: string[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      methods.push(input.method);
      if (input.method === 'interactionHistory.attachment.open')
        return reader.attachments.open(input);
      if (input.method === 'interactionHistory.attachment.read')
        return reader.attachments.read(input);
      if (input.method === 'interactionHistory.attachment.close') {
        reader.attachments.close(input.readId);
        return null;
      }
      throw Error('unexpected authority');
    },
  };
  const loaded = await readNativeInteractionAttachment({
    bridge,
    generation: 1,
    viewSelection: 2,
    attachment,
    signal: new AbortController().signal,
    surface: 'history',
    isCurrent: () => true,
  });
  expect(new TextDecoder().decode(loaded.content)).toBe(text);
  expect(artifactReads).toBe(1);
  expect(methods.every((method) => method.startsWith('interactionHistory.attachment.'))).toBe(true);
  expect(active.hasLoaded(attachment.key)).toBe(false);
  reader.close('history');
  await expect(
    reader.attachments.open({ readId: 'late', key: attachment.key }),
  ).rejects.toMatchObject({ code: 'interaction_scope_mismatch' });
});
