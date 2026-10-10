import { expect, test } from 'bun:test';
import type { Command, SelectedContextPage, SessionView } from '@kite-ai/client';
import {
  parseTuiCommand,
  TuiController,
  type TuiManagementIntent,
  type TuiPort,
  type TuiSnapshot,
} from '../../src/tui';

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
const page = (id = 'a'): SelectedContextPage => ({
  selection: {
    id: 'selected',
    sessionId: id,
    previousSelectionId: null,
    boundaryMessageId: null,
    boundarySeq: '0',
    tailFromSeq: '1',
    ranges: [],
  },
  highWaterSeq: '1',
  messages: [],
  resultSources: [],
  nextAfterSeq: null,
  nextAfterSourceId: null,
  snapshotCursor: '1',
});
function fixture(active = false) {
  let serial = 0,
    writes: TuiManagementIntent[] = [],
    models = 0,
    lookups = 0,
    newSessions = 0,
    quits = 0;
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `id-${++serial}`,
    listSessions: async () => [],
    readSession: async (id) => snapshot(id, active),
    submit: async () => {
      models++;
      throw new Error('unexpectedModel');
    },
    answer: async () => {
      throw new Error('unexpectedAnswer');
    },
    cancel: async () => {
      throw new Error('unexpectedCancel');
    },
    getCommand: async () => {
      throw new Error('unexpected');
    },
    management: {
      readContext: async (id) => page(id),
      manage: async (intent) => {
        writes.push(structuredClone(intent));
        return { intent, status: 'accepted' };
      },
      lookup: async (intent) => {
        lookups++;
        return {
          intent,
          status: 'applied',
          command: { id: intent.request.commandId, sessionId: intent.sessionId } as Command,
        };
      },
      newSession: async () => {
        newSessions++;
        return 'new';
      },
      quit: () => {
        quits++;
      },
    },
  };
  return {
    controller: new TuiController(port),
    port,
    writes,
    get models() {
      return models;
    },
    get lookups() {
      return lookups;
    },
    get newSessions() {
      return newSessions;
    },
    get quits() {
      return quits;
    },
  };
}
test('slash vocabulary rejects unsupported/malformed commands rather than sending Model content', async () => {
  for (const text of [
    '/resume other',
    '/context x',
    '/session delete',
    '/model foo',
    '/unknown',
    '/auto-compact',
  ])
    expect(() => parseTuiCommand(text)).toThrow();
  expect(parseTuiCommand('/COMPACT reset')).toEqual({ kind: 'compact_reset' });
  expect(parseTuiCommand('/compact exact focus')).toEqual({
    kind: 'compact',
    focus: 'exact focus',
  });
  expect(parseTuiCommand('/Q')).toEqual({ kind: 'exit' });
  const f = fixture();
  await f.controller.select('a');
  f.controller.setDraft('/unknown');
  await f.controller.send();
  expect(f.models).toBe(0);
  expect(f.controller.state.error).toBe('tui_command_unavailable');
  await f.controller.routeCommand('/exit');
  expect(f.quits).toBe(1);
});
test('session and active include freeze actual revisions and target; queued is not completed', async () => {
  const f = fixture(true);
  await f.controller.select('a');
  await f.controller.routeCommand('/session rename Accurate name');
  expect(f.writes[0]).toMatchObject({
    kind: 'session.rename',
    sessionId: 'a',
    request: { expectedStoreId: 'store', ifRevision: '7', title: 'Accurate name' },
  });
  await f.controller.includeExecution('result');
  expect(f.writes[1]).toMatchObject({
    kind: 'result.include',
    request: {
      targetRunId: 'actual-run',
      expectedContextSelectionId: 'selected',
      resultRevision: '3',
    },
  });
  expect(f.controller.state.management?.status).toBe('accepted');
  await f.controller.rewindBoundary(null);
  expect(f.writes).toHaveLength(2);
  expect(f.controller.state.error).toBe('rewind_requires_idle_current_selection');
  await f.controller.lookupManagement();
  expect(f.lookups).toBe(1);
  expect(f.writes).toHaveLength(2);
});
test('late fork belongs to original scope; closed Context read is aborted and cannot publish', async () => {
  const f = fixture();
  let resolve!: (value: Awaited<ReturnType<NonNullable<TuiPort['management']>['manage']>>) => void;
  f.port.management!.manage = (intent) =>
    new Promise((r) => {
      resolve = r;
      f.writes.push(intent);
    });
  await f.controller.select('a');
  const work = f.controller.routeCommand('/session fork Separate');
  await Promise.resolve();
  const intent = f.writes[0]!;
  await f.controller.select('b');
  resolve({ intent, status: 'applied', omittedExtensionState: true });
  await work;
  expect(f.controller.state.sessionId).toBe('b');
  expect(f.controller.state.management?.intent.sessionId).toBe('a');
  let readSignal!: AbortSignal;
  let finish!: (value: SelectedContextPage) => void;
  f.port.management!.readContext = (_id, _selection, signal) => {
    readSignal = signal;
    return new Promise((r) => {
      finish = r;
    });
  };
  const read = f.controller.readContext();
  f.controller.closePanel();
  expect(readSignal.aborted).toBe(true);
  finish(page('b'));
  await read;
  expect(f.controller.state.context).toBeUndefined();
  expect(f.models).toBe(0);
});
test('128 retained intents fail closed without evicting unknown work; duplicate reads do not POST', async () => {
  const f = fixture();
  await f.controller.select('a');
  for (let i = 0; i < 128; i++)
    await f.controller.manage({
      kind: 'session.rename',
      sessionId: 'a',
      request: {
        expectedStoreId: 'store',
        commandId: `stable-${i}`,
        ifRevision: '7',
        title: 'same',
      },
    });
  await f.controller.manage({
    kind: 'session.rename',
    sessionId: 'a',
    request: { expectedStoreId: 'store', commandId: 'overflow', ifRevision: '7', title: 'other' },
  });
  expect(f.writes).toHaveLength(128);
  expect(f.controller.state.error).toBe('management_intent_limit');
  await f.controller.manage(f.writes[0]!);
  expect(f.lookups).toBe(1);
  expect(f.writes).toHaveLength(128);
});

test('ordinary input during observed compression queues exact follow-up instead of steering maintenance', async () => {
  const f = fixture(true);
  const observed: TuiSnapshot = {
    ...snapshot('a', true),
    activeCommand: {
      id: 'start',
      sessionId: 'a',
      originStoreId: 'store',
      kind: 'context.compress',
      status: 'applied',
      receipt: {},
      cancelRequestedAt: null,
    },
  };
  f.port.readSession = async () => observed;
  let sent: unknown;
  f.port.submit = async (_id, intent) => {
    sent = intent;
    return {
      id: intent.commandId,
      sessionId: 'a',
      expectedStoreId: 'store',
      kind: intent.kind,
      status: 'accepted',
      receipt: {},
      originStoreId: 'store',
      cancelRequestedAt: null,
    } as Command;
  };
  await f.controller.select('a');
  f.controller.setDraft('Explicit later task');
  await f.controller.send();
  expect(sent).toMatchObject({
    kind: 'input.follow_up',
    afterRunId: 'actual-run',
    contextSelectionId: 'selected',
    expectedStoreId: 'store',
    content: 'Explicit later task',
  });
  expect(f.writes).toHaveLength(0);
});

test('restored Include keeps the original result provenance and writes only the current admission and exact target', async () => {
  for (const active of [false, true]) {
    const f = fixture(active);
    f.port.readSession = async (id) => {
      const current = snapshot(id, active);
      return {
        ...current,
        view: {
          ...current.view,
          executions: current.view.executions.map((execution) => ({
            ...execution,
            originStoreId: 'original-store',
          })),
        },
      };
    };
    await f.controller.select('a');
    await f.controller.includeExecution('result');
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toEqual({
      kind: 'result.include',
      sessionId: 'a',
      executionId: 'result',
      request: {
        expectedStoreId: 'store',
        commandId: 'id-1',
        expectedContextSelectionId: 'selected',
        resultRevision: '3',
        ...(active ? { targetRunId: 'actual-run' } : {}),
      },
    });
    expect(f.controller.state.snapshot!.view.executions[0]!.originStoreId).toBe('original-store');
    expect(f.models).toBe(0);
    expect(f.lookups).toBe(0);
    f.controller.dispose();
  }
});

test('Include refuses a changed current admission or mismatched result Session without a write', async () => {
  for (const wrongAdmission of [false, true]) {
    const f = fixture();
    f.port.readSession = async (id) => {
      const current = snapshot(id);
      return {
        ...current,
        view: {
          ...current.view,
          executions: current.view.executions.map((execution) => ({
            ...execution,
            originStoreId: 'original-store',
            sessionId: wrongAdmission ? id : 'foreign-session',
          })),
        },
      };
    };
    await f.controller.select('a');
    if (wrongAdmission) Object.assign(f.port, { storeId: 'different-current-store' });
    await f.controller.includeExecution('result');
    expect(f.writes).toHaveLength(0);
    expect(f.controller.state.error).toBe('result_identity_unavailable');
    expect(f.models).toBe(0);
    expect(f.lookups).toBe(0);
    f.controller.dispose();
  }
});
