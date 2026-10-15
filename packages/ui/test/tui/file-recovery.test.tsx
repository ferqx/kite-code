import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import { planFileRecoveryIntent } from '@kite-ai/client/file-recovery-intent';
import { TuiController, type TuiPort, type TuiSnapshot } from '../../src/tui';

const snapshot = (id = 'a', active = false): TuiSnapshot => ({
  storeId: 'store',
  view: {
    storeId: 'store',
    snapshotCursor: '1',
    session: {
      id,
      rootSessionId: id,
      parentSessionId: null,
      workspaceId: 'w',
      title: id,
      controlRevision: '7',
      contextSelectionId: 'selected',
      nextSeq: '1',
      deletedAt: null,
    },
    runs: active
      ? [
          {
            id: 'actual-run',
            sessionId: id,
            isActive: true,
            status: 'waiting_execution',
            originCommandId: 'start',
            originStoreId: 'store',
          },
        ]
      : [],
    executions: [
      {
        id: 'result',
        sessionId: id,
        originStoreId: 'store',
        resultRevision: '3',
        status: 'succeeded',
      },
    ],
    messages: [],
  } as unknown as SessionView,
  messages: [
    {
      id: 'message',
      sessionId: id,
      runId: null,
      seq: '1',
      status: 'complete',
      role: 'user',
      content: 'original',
    },
  ],
  interactions: [],
});

async function fixture() {
  const checkpoint = {
    id: 'a'.repeat(64),
    boundary: {
      storeId: 'store',
      workspaceId: 'w',
      sessionId: 'a',
      runId: 'run',
      contextSelectionId: 'selected',
      messageId: null,
      messageSeq: '0',
      triggerMessageId: 'trigger',
      triggerSeq: '1',
    },
    workspace: { device: '1', inode: '2' },
  };
  const boundary = {
    storeId: 'store',
    workspaceId: 'w',
    sessionId: 'a',
    contextSelectionId: 'selected',
    checkpoint,
    boundary: null,
    trigger: { messageId: 'trigger', seq: '1' },
  };
  const intent = await planFileRecoveryIntent({
    scope: 'both',
    subjectId: 'user',
    observation: boundary,
    code: { commandId: 'code', restoreId: 'restore' },
    fork: { commandId: 'fork', newSessionId: 'new', title: 'new' },
  });
  let begins = 0,
    continues = 0,
    cancels = 0;
  let resolveBegin: ((value: typeof intent) => void) | undefined;
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => crypto.randomUUID(),
    listSessions: async () => [],
    readSession: async (id) => snapshot(id),
    submit: async () => {
      throw Error('noModel');
    },
    answer: async () => {
      throw Error('noAnswer');
    },
    cancel: async () => {
      cancels++;
      throw Error('noCancel');
    },
    getCommand: async () => {
      throw Error('noGet');
    },
    fileRecovery: {
      listPoints: async () => ({
        storeId: 'store',
        sessionId: 'a',
        workspaceId: 'w',
        payload: { items: [{ checkpoint, revision: '1' }], nextAfterKey: null },
      }),
      readPoint: async () => ({
        boundary,
        preview: {
          storeId: 'store',
          sessionId: 'a',
          workspaceId: 'w',
          payload: { checkpoint, files: [] },
        },
      }),
      begin: async () => {
        begins++;
        return new Promise((resolve) => {
          resolveBegin = resolve;
        });
      },
      continue: async (value) => {
        continues++;
        return value;
      },
      lookup: async (value) => value,
      listSaved: async () => [],
    },
  };
  const controller = new TuiController(port);
  await controller.select('a');
  await controller.openFileRecovery();
  await controller.readFileRecoveryPoint(checkpoint.id);
  controller.chooseFileRecoveryScope('both');
  return {
    controller,
    port,
    intent,
    resolve: () => resolveBegin!(intent),
    counts: () => ({ begins, continues, cancels }),
  };
}
test('double confirmation has one begin and hidden late intent cannot submit; close never cancels original work', async () => {
  const f = await fixture();
  const pending = f.controller.startFileRecovery('both');
  await f.controller.startFileRecovery('both');
  expect(f.counts().begins).toBe(1);
  f.controller.closePanel();
  f.resolve();
  await pending;
  expect(f.counts()).toEqual({ begins: 1, continues: 0, cancels: 0 });
  expect(f.controller.state.panel).toBeUndefined();
});
test('new scope clears old preview/intent and pending late reply cannot overwrite selected Session', async () => {
  const f = await fixture(),
    pending = f.controller.startFileRecovery('both');
  await f.controller.select('b');
  f.resolve();
  await pending;
  expect(f.controller.state.sessionId).toBe('b');
  expect(f.controller.state.fileRecovery).toBeUndefined();
  expect(f.counts().continues).toBe(0);
  expect(f.counts().cancels).toBe(0);
});

test('reading an original recovery updates its saved row without replacing another request or submitting work', async () => {
  const f = await fixture();
  const other = structuredClone(f.intent);
  other.code!.request.commandId = 'other-code';
  const done = structuredClone(f.intent);
  done.code!.phase = 'succeeded';
  f.port.fileRecovery!.listSaved = async () => [f.intent, other];
  f.port.fileRecovery!.lookup = async (original) => {
    expect(original).toEqual(f.intent);
    return done;
  };
  await f.controller.openFileRecovery();
  f.controller.selectSavedFileRecovery(0);
  await f.controller.observeFileRecovery();
  expect(f.controller.state.fileRecovery?.intent).toEqual(done);
  expect(f.controller.state.fileRecovery?.saved).toEqual([done, other]);
  f.controller.selectSavedFileRecovery(0);
  expect(f.controller.state.fileRecovery?.intent?.code?.phase).toBe('succeeded');
  expect(f.counts()).toEqual({ begins: 0, continues: 0, cancels: 0 });
  expect(f.controller.state.sessionId).toBe('a');
  f.controller.dispose();
});

test('confirmed both completion reads original effect count before switching, closing and reporting once', async () => {
  const f = await fixture();
  const done = structuredClone(f.intent);
  done.code!.phase = 'succeeded';
  done.fork!.phase = 'succeeded';
  let summaries = 0;
  f.port.fileRecovery!.continue = async () => done;
  f.port.fileRecovery!.readCompletion = async (original) => {
    summaries++;
    expect(original).toEqual(done);
    expect(f.controller.state.sessionId).toBe('a');
    expect(f.controller.state.localMessages).toEqual([]);
    return { intent: done, restoredFiles: 1 };
  };
  const pending = f.controller.startFileRecovery('both');
  f.resolve();
  await pending;
  expect(summaries).toBe(1);
  expect(f.controller.state.sessionId).toBe('new');
  expect(f.controller.state.panel).toBeUndefined();
  expect(f.controller.state.localMessages).toHaveLength(1);
  expect(f.controller.state.localMessages[0]).toMatchObject({
    sessionId: 'new',
    content: 'Created a new Session from the checkpoint and restored 1 files.',
  });
  await f.controller.observeFileRecovery();
  expect(summaries).toBe(1);
  expect(f.controller.state.localMessages).toHaveLength(1);
  f.controller.dispose();
});

test('late completion cannot replace a newly selected Session or publish its effect count there', async () => {
  const f = await fixture();
  const done = structuredClone(f.intent);
  done.code!.phase = 'succeeded';
  done.fork!.phase = 'succeeded';
  f.port.fileRecovery!.continue = async () => done;
  let reply: (() => void) | undefined;
  f.port.fileRecovery!.readCompletion = async () =>
    new Promise((resolve) => {
      reply = () => resolve({ intent: done, restoredFiles: 1 });
    });
  const pending = f.controller.startFileRecovery('both');
  f.resolve();
  while (!reply) await new Promise((resolve) => setTimeout(resolve, 1));
  await f.controller.select('b');
  reply();
  await pending;
  expect(f.controller.state.sessionId).toBe('b');
  expect(f.controller.state.localMessages).toEqual([]);
  f.controller.dispose();
});
