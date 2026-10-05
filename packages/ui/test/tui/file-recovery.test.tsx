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
