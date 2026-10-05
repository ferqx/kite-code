import { expect, test } from 'bun:test';
import type { AgentClient, Interaction, SessionView } from '@kite-ai/client';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';
import { createDesktopController } from '../src/controller';
import type { NativeState } from '../src/native-bridge';

const card = (id: string): Interaction => ({
  id,
  originStoreId: 'store',
  sessionId: 's',
  presentationSessionId: 's',
  ancestry: ['s'],
  runId: 'run',
  executionId: 'execution',
  attempt: 1,
  kind: 'approval',
  definitionId: 'fixture',
  definitionVersion: '1',
  inputDigest: 'digest',
  policyRevision: 'policy',
  requiredRefs: [],
  request: {},
  answer: null,
  revision: '0',
  acceptedDecisionRevision: null,
  state: 'pending',
});
const view = (id = 's'): SessionView =>
  ({
    storeId: 'store',
    snapshotCursor: '10',
    session: { id, workspaceId: 'w', contextSelectionId: 'selection' },
    runs: [],
    executions: [],
    messages: [],
  }) as unknown as SessionView;

function fixture(
  next: (
    signal?: AbortSignal,
  ) => Promise<{ interactions: Interaction[]; nextAfterId: string | null }>,
) {
  let posts = 0,
    cancels = 0;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['interactions'] },
    getView: async (id: string) => view(id),
    listInteractions: async (
      _id: string,
      input: { afterId?: string },
      options?: { signal?: AbortSignal },
    ) =>
      input.afterId
        ? next(options?.signal).then((page) => ({ ...page, snapshotCursor: '10' }))
        : {
            interactions: _id === 's' ? [card('a')] : [],
            nextAfterId: _id === 's' ? 'a' : null,
            snapshotCursor: '10',
          },
    answerInteraction: async () => {
      posts++;
      throw Error('lost');
    },
    cancelCommand: async () => {
      cancels++;
    },
    disposeNetwork() {},
  } as unknown as AgentClient;
  const controller = createDesktopController({ admittedClient: client, onSnapshot() {} });
  return { controller, client, posts: () => posts, cancels: () => cancels };
}

test('explicit pending page replaces window; closed IPC grants no answer/cancel authority', async () => {
  const f = fixture(async () => ({ interactions: [card('b')], nextAfterId: null }));
  await f.controller.selectSession('s');
  await f.controller.nextInteractionPage(1, 'a');
  expect(f.controller.snapshot?.interactions.map((c) => c.id)).toEqual(['b']);
  expect(f.controller.snapshot?.interactionsAfterId).toBeNull();
  expect(f.posts()).toBe(0);
  expect(f.cancels()).toBe(0);
  expect(
    decodeNativeRequest({
      method: 'interactions.next',
      generation: 1,
      viewGeneration: 1,
      afterId: 'a',
    }).method,
  ).toBe('interactions.next');
  expect(() =>
    decodeNativeRequest({
      method: 'interactions.next',
      generation: 1,
      viewGeneration: 1,
      afterId: 'a',
      cancelRun: 'run',
    }),
  ).toThrow();
  expect(() => decodeNativeRequest({ method: 'interactions.close', generation: 1 })).toThrow();
});

test('event refresh re-reads the current later window with fresh revision; explicit select and scope drift reset it', async () => {
  let revision = '0';
  const f = fixture(async () => ({
    interactions: [{ ...card('b'), revision }],
    nextAfterId: null,
  }));
  await f.controller.selectSession('s');
  await f.controller.nextInteractionPage(1, 'a');
  const old = f.controller.snapshot!.interactions[0]!;
  revision = '1';
  const refreshed = await f.controller.refreshSession('s');
  expect(refreshed!.generation).toBe(2);
  expect(refreshed!.interactions.map((card) => card.id)).toEqual(['b']);
  expect(refreshed!.interactions[0]!.revision).toBe('1');
  await expect(
    f.controller.answerInteraction(old, { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('interaction_scope_mismatch');
  expect(f.posts()).toBe(0);
  f.client.getView = async () => ({
    ...view(),
    session: { ...view().session, contextSelectionId: 'different' },
  });
  const changed = await f.controller.refreshSession('s');
  expect(changed!.interactions.map((card) => card.id)).toEqual(['a']);
  await f.controller.selectSession('s');
  expect(f.controller.snapshot!.interactions.map((card) => card.id)).toEqual(['a']);
  expect(f.cancels()).toBe(0);
});

test('Native Main automatic change refresh re-reads the visible later page rather than sending it back to the first page', async () => {
  let trigger!: () => void,
    revision = '0',
    tailReads = 0;
  const f = fixture(async () => {
    tailReads++;
    return { interactions: [{ ...card('b'), revision }], nextAfterId: null };
  });
  f.client.connect = async () => f.client.serverInfo!;
  f.client.observe = async (options) => {
    trigger = () => {
      void options.onChange({} as Parameters<typeof options.onChange>[0]);
    };
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  const caller = new NativeCaller(f.client, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    const first = (await caller.invoke({
      method: 'select',
      generation: 1,
      sessionId: 's',
    })) as NativeState;
    await caller.invoke({
      method: 'interactions.next',
      generation: 1,
      viewGeneration: first.selection!.viewGeneration,
      afterId: 'a',
    });
    revision = '1';
    trigger();
    const refreshed = (await caller.invoke({ method: 'state', generation: 1 })) as NativeState;
    expect(refreshed.selection!.interactions.map((card) => card.id)).toEqual(['b']);
    expect(refreshed.selection!.interactions[0]!.revision).toBe('1');
    expect(tailReads).toBe(2);
    expect(f.posts()).toBe(0);
    expect(f.cancels()).toBe(0);
  } finally {
    await caller.close();
  }
});

test('duplicate/no-progress/foreign pending pages fail locally and retain prior page', async () => {
  for (const page of [
    { interactions: [card('a')], nextAfterId: 'a' },
    { interactions: [card('b'), card('b')], nextAfterId: null },
    { interactions: [], nextAfterId: 'b' },
    { interactions: [{ ...card('b'), originStoreId: 'foreign' }], nextAfterId: null },
    { interactions: [{ ...card('b'), presentationSessionId: 'other' }], nextAfterId: null },
  ]) {
    const f = fixture(async () => page);
    await f.controller.selectSession('s');
    await expect(f.controller.nextInteractionPage(1, 'a')).rejects.toThrow();
    expect(f.controller.snapshot?.interactions[0]?.id).toBe('a');
    expect(f.posts()).toBe(0);
  }
});

test('switch/close abort original pending read; late success cannot publish or cancel execution', async () => {
  for (const switchScope of [false, true]) {
    let release!: () => void, signal: AbortSignal | undefined;
    const f = fixture(async (input) => {
      signal = input;
      await new Promise<void>((r) => {
        release = r;
      });
      return { interactions: [card('b')], nextAfterId: null };
    });
    await f.controller.selectSession('s');
    const reading = f.controller.nextInteractionPage(1, 'a');
    if (switchScope) await f.controller.selectSession('other');
    else f.controller.cancelInteractionRead(1);
    expect(signal?.aborted).toBe(true);
    release();
    await reading;
    expect(f.controller.snapshot?.sessionId).toBe(switchScope ? 'other' : 's');
    expect(f.controller.snapshot?.interactions.some((c) => c.id === 'b')).toBe(false);
    expect(f.posts()).toBe(0);
    expect(f.cancels()).toBe(0);
  }
});

test('changed observation refuses the old cursor and refreshes without writes; stale generation cannot read', async () => {
  const f = fixture(async () => ({ interactions: [card('b')], nextAfterId: null }));
  await f.controller.selectSession('s');
  let reads = 0;
  f.client.getView = async (id: string) => {
    reads++;
    return { ...view(id), snapshotCursor: '11' };
  };
  await expect(f.controller.nextInteractionPage(1, 'a')).rejects.toThrow(
    'interaction_page_observation_changed',
  );
  expect(f.controller.snapshot?.interactions[0]?.id).toBe('a');
  expect(f.controller.snapshot?.view.snapshotCursor).toBe('11');
  expect(reads).toBe(2);
  await expect(f.controller.nextInteractionPage(0, 'a')).rejects.toThrow(
    'interaction_page_observation_changed',
  );
  expect(f.posts()).toBe(0);
  expect(f.cancels()).toBe(0);
});

test('unread complete attachment on a later page sends zero answers; unknown later answer retains original intent across switch', async () => {
  const attachment = {
    ...card('b'),
    request: {
      policy: {
        review: {
          kind: 'artifact',
          complete: true,
          reference: {
            id: 'original-body',
            mediaType: 'text/plain',
            size: '1200',
            scope: { kind: 'execution', id: 'execution' },
          },
        },
      },
    },
  } as Interaction;
  const f = fixture(async () => ({ interactions: [attachment], nextAfterId: null }));
  await f.controller.selectSession('s');
  await f.controller.nextInteractionPage(1, 'a');
  await expect(
    f.controller.answerInteraction(attachment, { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('attachment_not_loaded');
  expect(f.posts()).toBe(0);
  const g = fixture(async () => ({ interactions: [card('b')], nextAfterId: null }));
  await g.controller.selectSession('s');
  await g.controller.nextInteractionPage(1, 'a');
  await expect(
    g.controller.answerInteraction(card('b'), { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('lost');
  const original = g.controller.interactionSubmission(card('b'))!;
  await g.controller.selectSession('other');
  g.controller.cancelInteractionRead();
  expect(g.controller.interactionSubmission(card('b'))?.intent).toEqual(original.intent);
  expect(g.controller.interactionSubmission(card('b'))?.phase).toBe('unknown');
  expect(original.intent.expectedStoreId).toBe('store');
  expect(g.posts()).toBe(1);
  expect(g.cancels()).toBe(0);
});
