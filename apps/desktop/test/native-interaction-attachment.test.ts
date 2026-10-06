import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type AgentClient, type Interaction, interactionAttachment } from '@kite-ai/client';
import {
  type AttachmentView,
  NativeInteractionAttachmentReads,
} from '../electron/interaction-attachment-reads';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';
import type { NativeBridge } from '../src/native-bridge';
import { readNativeInteractionAttachment } from '../src/native-interaction-attachment';
import { memoryPrivateData } from './private-data.fixture';

const text = `${'完整原计划🙂e\u0301\n'.repeat(15000)}ORIGINAL_FULL_TAIL`;
const content = new TextEncoder().encode(text);
const hash = createHash('sha256').update(content).digest('hex');
const card = {
  id: 'original-card',
  originStoreId: 'store',
  sessionId: 'source',
  presentationSessionId: 'root',
  ancestry: ['root', 'source'],
  runId: 'run',
  executionId: 'execution',
  attempt: 1,
  kind: 'plan_review',
  definitionId: 'planning.review',
  definitionVersion: '1',
  inputDigest: 'original-input',
  policyRevision: 'original-policy',
  requiredRefs: [],
  answer: null,
  revision: '3',
  acceptedDecisionRevision: null,
  state: 'pending',
  request: {
    planId: 'plan',
    version: '1',
    digest: 'plan-digest',
    content: 'Full original attachment required',
    allowedModes: ['auto', 'accept_edits'],
    policy: {
      review: {
        kind: 'artifact',
        complete: true,
        reference: {
          id: 'artifact',
          mediaType: 'application/json',
          size: String(content.length),
          scope: { kind: 'execution', id: 'execution' },
        },
      },
    },
  },
} satisfies Interaction;
const attachment = interactionAttachment(card)!;
const loaded = { identity: attachment.key, reference: { ...attachment.reference, hash }, content };
const scope: AttachmentView = {
  generation: 1,
  selection: 1,
  storeId: 'store',
  sessionId: 'root',
  interactions: [card],
};
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}
function fixture() {
  let view: AttachmentView | undefined = scope;
  const main = new NativeInteractionAttachmentReads(
    async (original) => {
      expect(original).toEqual(attachment);
      return loaded;
    },
    () => view,
  );
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      decodeNativeRequest(input);
      if (input.method === 'interactionAttachment.open') return main.open(input);
      if (input.method === 'interactionAttachment.read') return main.read(input);
      if (input.method === 'interactionAttachment.close') {
        main.close(input.readId);
        return null;
      }
      throw Error('unexpected_command');
    },
  };
  return {
    main,
    bridge,
    switchView() {
      view = undefined;
      main.release();
    },
  };
}

test('Native original attachment transfers full UTF8 in 64KiB chunks, reaches EOF before proof and keeps only current-view proof after close', async () => {
  const f = fixture();
  let chunks = 0;
  const bridge: NativeBridge = {
    watch: f.bridge.watch,
    async request(input) {
      const result = await f.bridge.request(input);
      if (result && 'offset' in result && result.kind === 'interactionAttachment.chunk') {
        chunks++;
        expect(Buffer.from(result.data, 'base64').length).toBeLessThanOrEqual(65536);
        expect(f.main.hasLoaded(attachment.key)).toBe(result.eof);
      } else if (input.method === 'interactionAttachment.open')
        expect(f.main.hasLoaded(attachment.key)).toBe(false);
      return result;
    },
  };
  const value = await readNativeInteractionAttachment({
    bridge,
    generation: 1,
    attachment,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(content.length).toBeGreaterThan(300 * 1024);
  expect(new TextDecoder().decode(value.content)).toBe(text);
  expect(chunks).toBeGreaterThan(1);
  expect(f.main.hasLoaded(attachment.key)).toBe(true);
  expect(() => f.main.read({ readId: 'lost-handle', offset: 0, limit: 1 })).toThrow(
    'attachment_read_missing',
  );
  f.switchView();
  expect(f.main.hasLoaded(attachment.key)).toBe(false);
});

test('Native attachment refuses wrong offsets, corrupt hash, arbitrary identity and late view changes without starting work', async () => {
  const f = fixture();
  await f.main.open({ readId: 'original-read', key: attachment.key });
  expect(() => f.main.read({ readId: 'original-read', offset: 1, limit: 65536 })).toThrow(
    'attachment_offset_invalid',
  );
  expect(f.main.hasLoaded(attachment.key)).toBe(false);
  f.main.close('original-read');
  expect(await code(f.main.open({ readId: 'foreign', key: 'arbitrary-artifact' }))).toBe(
    'interaction_scope_mismatch',
  );
  const bridge: NativeBridge = {
    watch: f.bridge.watch,
    async request(input) {
      const result = await f.bridge.request(input);
      return result && 'reference' in result && result.kind === 'interactionAttachment.opened'
        ? { ...result, reference: { ...result.reference, hash: '0'.repeat(64) } }
        : result;
    },
  };
  expect(
    await code(
      readNativeInteractionAttachment({
        bridge,
        generation: 1,
        attachment,
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    ),
  ).toBe('attachment_content_mismatch');
  const changed = fixture();
  expect(
    await code(
      readNativeInteractionAttachment({
        bridge: changed.bridge,
        generation: 1,
        viewSelection: 99,
        attachment,
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    ),
  ).toBe('attachment_metadata_invalid');
  expect(changed.main.hasLoaded(attachment.key)).toBe(false);
  let release!: (value: typeof loaded) => void, signal: AbortSignal | undefined;
  const main = new NativeInteractionAttachmentReads(
    async (_, options) => {
      signal = options.signal;
      return new Promise<typeof loaded>((resolve) => {
        release = resolve;
      });
    },
    () => scope,
  );
  const waiting = main.open({ readId: 'late', key: attachment.key });
  main.release();
  release(loaded);
  expect(await code(waiting)).toBe('attachment_view_changed');
  expect(signal?.aborted).toBe(true);
  expect(() =>
    decodeNativeRequest({
      method: 'interactionAttachment.open',
      generation: 1,
      readId: 'read',
      key: attachment.key,
      path: '/private/file',
    }),
  ).toThrow('invalid_native_request');
});

test.each([
  'ordinary refresh',
  'network reset',
] as const)('actual Native main requires full EOF and keeps the original attachment proof scoped through %s', async (change) => {
  let writes = 0;
  let failNextView = false;
  let observer: { onChange: () => void; onReset: () => void } | undefined;
  const privateData = memoryPrivateData();
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'local-user', capabilities: ['interactions'] },
    connect: async () => ({}),
    async observe(options: { signal: AbortSignal; onChange: () => void; onReset: () => void }) {
      observer = options;
      const { signal } = options;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async getView(id: string) {
      if (failNextView) throw Error('original_view_read_unavailable');
      return {
        storeId: 'store',
        snapshotCursor: '0',
        session: {
          id,
          workspaceId: 'w',
          rootSessionId: id,
          parentSessionId: null,
          title: id,
          nextSeq: '0',
          contextSelectionId: 'selection',
          controlRevision: '0',
          deletedAt: null,
        },
        runs: [],
        executions: [],
        messages: [],
      };
    },
    async listInteractions() {
      return { interactions: [card], nextAfterId: null };
    },
    async readInteractionAttachment() {
      return loaded;
    },
    async answerInteraction(_session: string, _id: string, input: { commandId: string }) {
      writes++;
      return {
        id: input.commandId,
        sessionId: 'root',
        originStoreId: 'store',
        subjectId: 'local-user',
        requestDigest: privateData.answers()[0]!.intent.requestDigest,
        kind: 'interaction.answer',
        status: 'applied',
        cancelRequestedAt: null,
        receipt: {
          outcome: 'answer_saved',
          interactionId: card.id,
          decisionRevision: '4',
          cancelled: false,
        },
      };
    },
    listAllWorkspaces: async () => [],
    listAllSessions: async () => [],
    disposeNetwork() {},
  } as unknown as AgentClient;
  const main = new NativeCaller(client, () => {}, privateData);
  const answer = {
    method: 'interaction.answer',
    generation: 1,
    interactionId: card.id,
    revision: card.revision,
    answer: { kind: 'plan_review', decision: 'approve', mode: 'auto' },
  } as const;
  try {
    await main.invoke({ method: 'attach' });
    await main.invoke({ method: 'select', generation: 1, sessionId: 'root' });
    expect(await code(main.invoke(answer))).toBe('attachment_not_loaded');
    await main.invoke({
      method: 'interactionAttachment.open',
      generation: 1,
      readId: 'read',
      key: attachment.key,
    });
    expect(await code(main.invoke(answer))).toBe('attachment_not_loaded');
    let offset = 0;
    for (;;) {
      const chunk = await main.invoke({
        method: 'interactionAttachment.read',
        generation: 1,
        readId: 'read',
        offset,
        limit: 65536,
      });
      expect(chunk && 'offset' in chunk && chunk.kind === 'interactionAttachment.chunk').toBe(true);
      if (!chunk || !('offset' in chunk) || chunk.kind !== 'interactionAttachment.chunk')
        throw Error('chunk_missing');
      offset = chunk.nextOffset;
      if (chunk.eof) break;
      expect(await code(main.invoke(answer))).toBe('attachment_not_loaded');
    }
    await main.invoke({ method: 'interactionAttachment.close', generation: 1, readId: 'read' });
    if (change === 'network reset') {
      await main.invoke({
        method: 'interactionAttachment.open',
        generation: 1,
        readId: 'reset-read',
        key: attachment.key,
      });
      observer!.onReset();
      expect(
        await code(
          main.invoke({
            method: 'interactionAttachment.read',
            generation: 1,
            readId: 'reset-read',
            offset: 0,
            limit: 65536,
          }),
        ),
      ).toBe('attachment_read_missing');
      expect(await code(main.invoke(answer))).not.toBe('success');
      expect(writes).toBe(0);
      return;
    }
    observer!.onChange();
    await main.invoke({ method: 'state', generation: 1 });
    failNextView = true;
    observer!.onChange();
    await main.invoke({ method: 'state', generation: 1 });
    expect(await code(main.invoke(answer))).not.toBe('success');
    expect(writes).toBe(0);
    failNextView = false;
    observer!.onChange();
    await main.invoke({ method: 'state', generation: 1 });
    expect(await code(main.invoke(answer))).toBe('success');
    expect(writes).toBe(1);
  } finally {
    await main.close();
  }
});
