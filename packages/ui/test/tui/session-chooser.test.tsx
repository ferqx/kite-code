import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiController, type TuiManagementIntent, type TuiPort, TuiSession } from '../../src/tui';

function fixture() {
  const sessions = new Map([
    ['a', { id: 'a', title: 'Original active session' }],
    ['b', { id: 'b', title: '另一会话🙂' }],
  ]);
  const session = (id: string) => ({
    id,
    title: sessions.get(id)?.title ?? id,
    workspaceId: 'w',
    parentSessionId: null,
    rootSessionId: id,
    controlRevision: '7',
    contextSelectionId: 'selection',
    nextSeq: '1',
    ownerInstanceId: null,
    ownerGeneration: '0',
    deletedAt: null,
  });
  let serial = 0,
    cancellations = 0,
    models = 0,
    created = 0;
  const writes: TuiManagementIntent[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `id-${++serial}`,
    listSessions: async () => [...sessions.values()],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        snapshotCursor: '1',
        session: session(id),
        runs: [],
        executions: [],
        messages: [],
      } as SessionView,
      messages: [],
      interactions: [],
    }),
    submit: async () => {
      models++;
      throw Error('unexpected_model');
    },
    answer: async () => {
      throw Error('unexpected_answer');
    },
    cancel: async () => {
      cancellations++;
      throw Error('unexpected_cancel');
    },
    getCommand: async () => {
      throw Error('unexpected_lookup');
    },
    management: {
      readSessionControl: async (id) => ({ storeId: 'store', session: session(id) }),
      readContext: async () => {
        throw Error('unexpected_context');
      },
      manage: async (intent) => {
        writes.push(structuredClone(intent));
        sessions.delete(intent.sessionId);
        return { intent, status: 'delete_requested' };
      },
      lookup: async (intent) => ({ intent, status: 'outcome_unknown' }),
      newSession: async () => {
        created++;
        sessions.set('new', { id: 'new', title: 'New empty session' });
        return 'new';
      },
      quit() {},
    },
  };
  return {
    controller: new TuiController(port),
    port,
    sessions,
    writes,
    get counts() {
      return { cancellations, models, created };
    },
  };
}
const settle = () => Bun.sleep(50);

test('resume deletes the confirmed original row; default Enter retains it without changing the active selection', async () => {
  const f = fixture();
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  try {
    await settle();
    app.stdin.write('\u0012');
    await settle();
    app.stdin.write('\u001b[B');
    await settle();
    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).toContain('Delete Session?');
    expect(app.lastFrame()).toContain('另一会话🙂');
    expect(app.lastFrame()).toContain('> Keep Session');
    expect(f.writes).toHaveLength(0);
    app.stdin.write('\r');
    await settle();
    expect(app.lastFrame()).not.toContain('Delete Session?');
    expect(f.writes).toHaveLength(0);
    app.stdin.write('d');
    await settle();
    app.stdin.write('\u001b[B');
    await settle();
    app.stdin.write('\r');
    await settle();
    expect(f.writes).toEqual([
      {
        kind: 'session.delete',
        sessionId: 'b',
        request: { expectedStoreId: 'store', commandId: 'id-1', ifRevision: '7' },
      },
    ]);
    expect(f.controller.state.sessionId).toBe('a');
    expect(f.controller.state.sessions.map((item) => item.id)).toEqual(['a']);
    expect(f.counts).toEqual({ cancellations: 0, models: 0, created: 0 });
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('Unicode search, staged Escape and chooser Ctrl+C preserve the original draft and make no business call', async () => {
  const f = fixture();
  await f.controller.select('a');
  f.controller.setDraft('原草稿🙂');
  const app = render(<TuiSession controller={f.controller} />);
  try {
    await settle();
    app.stdin.write('\u0012');
    await settle();
    app.stdin.write('\u001b[A');
    await settle();
    app.stdin.write('\u001b[200~另一会话🙂\u001b[201~');
    await settle();
    expect(app.lastFrame()).toContain('另一会话🙂 [b]');
    expect(app.lastFrame()).not.toContain('Original active session [a]');
    app.stdin.write('\u001b[B');
    await settle();
    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).not.toContain('Delete Session?');
    app.stdin.write('\u001b');
    await settle();
    expect(app.lastFrame()).toContain('Original active session [a]');
    app.stdin.write('\u001b[A');
    await settle();
    app.stdin.write('\u001b');
    await settle();
    expect(app.lastFrame()).toContain('Select Session');
    app.stdin.write('\u0003');
    await settle();
    expect(app.lastFrame()).not.toContain('Select Session');
    expect(f.controller.state.sessionId).toBe('a');
    expect(f.controller.state.draft).toBe('原草稿🙂');
    expect(f.writes).toHaveLength(0);
    expect(f.counts).toEqual({ cancellations: 0, models: 0, created: 0 });
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('lost deletion reply keeps its original ID; explicit GET completes current deletion and creates only one replacement', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.list();
  let lookups = 0;
  f.port.management!.manage = async (intent) => {
    f.writes.push(structuredClone(intent));
    throw Error('lost_reply');
  };
  f.port.management!.lookup = async (intent) => {
    lookups++;
    f.sessions.delete(intent.sessionId);
    return { intent, status: 'delete_requested' };
  };
  await f.controller.requestSessionDeletion('a');
  await f.controller.confirmSessionDeletion();
  const original = f.controller.state.sessionDeletion!.intent!;
  expect(f.controller.state.sessionDeletion!.phase).toBe('outcome_unknown');
  f.controller.closeSessionDeletion();
  await f.controller.requestSessionDeletion('a');
  await f.controller.confirmSessionDeletion();
  expect(f.controller.state.sessionDeletion!.intent).toEqual(original);
  expect(f.writes).toHaveLength(1);
  await f.controller.lookupSessionDeletion();
  expect(f.controller.state.sessionId).toBe('new');
  expect(f.counts.created).toBe(1);
  await f.controller.lookupManagement(original.request.commandId);
  expect(f.counts.created).toBe(1);
  expect(lookups).toBe(2);
  expect(f.writes).toHaveLength(1);
});

test('closing or switching while control metadata is pending invalidates the original confirmation; foreign roots never submit', async () => {
  for (const action of ['close', 'switch', 'foreign'] as const) {
    const f = fixture();
    await f.controller.select('a');
    await f.controller.list();
    const reader = f.port.management!.readSessionControl!;
    const original = await reader('b', new AbortController().signal);
    let resolve!: (value: typeof original) => void, signal!: AbortSignal;
    f.port.management!.readSessionControl = (_id, read) => {
      signal = read;
      return new Promise((done) => {
        resolve = done;
      });
    };
    const work = f.controller.requestSessionDeletion('b');
    if (action === 'close') f.controller.closeSessionDeletion();
    if (action === 'switch') await f.controller.select('b');
    resolve(
      action === 'foreign'
        ? { ...original, session: { ...original.session, workspaceId: 'foreign' } }
        : original,
    );
    await work;
    await f.controller.confirmSessionDeletion();
    expect(f.writes).toHaveLength(0);
    if (action === 'foreign') expect(f.controller.state.sessionDeletion?.phase).toBe('failed');
    else {
      expect(signal.aborted).toBe(true);
      expect(f.controller.state.sessionDeletion).toBeUndefined();
    }
    f.controller.dispose();
  }
});
