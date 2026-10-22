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

test('selection reconciles before history while ordinary refresh can skip reconciliation', async () => {
  const f = fixture();
  const calls: string[] = [];
  const originalRead = f.port.readSession;
  f.port.reconcileSession = async (id) => {
    calls.push(`reconcile:${id}`);
  };
  f.port.readSession = async (id, signal) => {
    calls.push(`read:${id}`);
    return originalRead(id, signal);
  };
  try {
    await f.controller.select('a');
    expect(calls).toEqual(['reconcile:a', 'read:a']);
    calls.length = 0;
    await f.controller.select('a', { preserveReconnectionReview: true, reconcile: false });
    expect(calls).toEqual(['read:a']);
    calls.length = 0;
    await f.controller.select('a', { preserveReconnectionReview: true });
    expect(calls).toEqual(['reconcile:a', 'read:a']);
    expect(f.counts).toEqual({ cancellations: 0, models: 0, created: 0 });
  } finally {
    f.controller.dispose();
  }
});

test('ordinary event refresh waits for the same Session activation without aborting reconciliation', async () => {
  const f = fixture();
  let release!: () => void;
  let activationSignal!: AbortSignal;
  const calls: string[] = [];
  const originalRead = f.port.readSession;
  f.port.reconcileSession = async (_id, signal) => {
    activationSignal = signal;
    calls.push('reconcile');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    signal.throwIfAborted();
    calls.push('reconciled');
  };
  f.port.readSession = async (id, signal) => {
    calls.push('read');
    return originalRead(id, signal);
  };
  try {
    const activation = f.controller.select('a');
    const refresh = f.controller.select('a', {
      preserveReconnectionReview: true,
      reconcile: false,
    });
    await Promise.resolve();
    expect(activationSignal.aborted).toBe(false);
    expect(calls).toEqual(['reconcile']);
    release();
    await Promise.all([activation, refresh]);
    expect(calls).toEqual(['reconcile', 'reconciled', 'read', 'read']);
    expect(f.controller.state.snapshot?.view.session.id).toBe('a');
    expect(f.controller.state.loading).toBe(false);
    expect(f.controller.state.error).toBeUndefined();
  } finally {
    f.controller.dispose();
  }
});

test('new navigation still aborts activation and its waiting refresh cannot return to the old Session', async () => {
  const f = fixture();
  let release!: () => void;
  let activationSignal!: AbortSignal;
  const reads: string[] = [];
  const originalRead = f.port.readSession;
  f.port.reconcileSession = async (id, signal) => {
    if (id !== 'a') return;
    activationSignal = signal;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    signal.throwIfAborted();
  };
  f.port.readSession = async (id, signal) => {
    reads.push(id);
    return originalRead(id, signal);
  };
  try {
    const activation = f.controller.select('a');
    const refresh = f.controller.select('a', { reconcile: false });
    await f.controller.select('b');
    expect(activationSignal.aborted).toBe(true);
    release();
    await Promise.all([activation, refresh]);
    expect(reads).toEqual(['b']);
    expect(f.controller.state.sessionId).toBe('b');
    expect(f.controller.state.snapshot?.view.session.id).toBe('b');
  } finally {
    f.controller.dispose();
  }
});

test('a waiting event refresh retains the activation failure and readable history', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.port.reconcileSession = () =>
    new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
  try {
    const activation = f.controller.select('a');
    const refresh = f.controller.select('a', { reconcile: false });
    reject(Error('owner_observation_unknown'));
    await Promise.all([activation, refresh]);
    expect(f.controller.state.snapshot?.view.session.id).toBe('a');
    expect(f.controller.state.error).toContain('owner_observation_unknown');
    expect(f.controller.state.loading).toBe(false);
  } finally {
    f.controller.dispose();
  }
});

test('failed session reconciliation keeps history readable with a visible error', async () => {
  const f = fixture();
  f.port.reconcileSession = async () => {
    throw Error('owner_observation_unknown');
  };
  try {
    await f.controller.select('a');
    expect(f.controller.state.snapshot?.view.session.id).toBe('a');
    expect(f.controller.state.loading).toBe(false);
    expect(f.controller.state.error).toContain('会话执行状态核对失败');
    expect(f.controller.state.error).toContain('owner_observation_unknown');
    expect(f.counts).toEqual({ cancellations: 0, models: 0, created: 0 });
  } finally {
    f.controller.dispose();
  }
});

test('resume deletes the confirmed original row; default Enter retains it without changing the active selection', async () => {
  const f = fixture();
  await f.controller.select('a');
  const app = render(<TuiSession testDiagnostics controller={f.controller} />);
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
    expect(app.lastFrame()).toContain('❯ Keep Session');
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
    expect(app.lastFrame()).not.toContain('Delete Session?');
    expect(f.controller.state.sessionDeletion).toBeUndefined();
    expect(app.lastFrame()).not.toContain('Select Session (arrows/Enter, Esc)');
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
  const app = render(<TuiSession testDiagnostics controller={f.controller} />);
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

test('ordinary session chooser retains original navigation and safe deletion labels with the new CAS intent', async () => {
  const f = fixture();
  f.port.preferences = {
    read: async () => ({
      revision: 'a'.repeat(64),
      language: 'zh-CN',
      resolvedLanguage: 'zh-CN',
      colorPreset: 'teal',
      theme: 'dark',
    }),
    save: async () => {
      throw Error('unexpected_preference_save');
    },
  };
  await f.controller.refreshPreferences();
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  try {
    app.stdin.write('\u0012');
    await settle();
    expect(app.lastFrame()).toContain('会话列表');
    expect(app.lastFrame()).toContain('导航');
    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).toContain('删除确认');
    expect(app.lastFrame()).toContain('❯ 保留会话');
    expect(app.lastFrame()).toContain('永久删除');
    expect(f.writes).toHaveLength(0);
    app.stdin.write('\r');
    await settle();
    expect(app.lastFrame()).not.toContain('删除确认');
    expect(f.writes).toHaveLength(0);
    expect(f.counts).toEqual({ cancellations: 0, models: 0, created: 0 });
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('directory failure is unknown history, preserves saved rows, and R retries only the read', async () => {
  const f = fixture();
  await f.controller.list();
  f.port.listSessions = async () => {
    throw Error('service_unavailable');
  };
  await f.controller.list();
  const app = render(<TuiSession testDiagnostics controller={f.controller} />);
  try {
    await settle();
    app.stdin.write('\u0012');
    await settle();
    expect(app.lastFrame()).toContain('Could not load session history; please retry.');
    expect(app.lastFrame()).not.toContain('No session history');
    expect(f.controller.state.sessions.map((session) => session.id)).toEqual(['a', 'b']);
    expect(f.controller.state.sessionDirectoryLoading).toBe(false);
    f.port.listSessions = async () => [...f.sessions.values()];
    app.stdin.write('r');
    await settle();
    expect(f.controller.state.sessionDirectoryError).toBeUndefined();
    expect(app.lastFrame()).not.toContain('Could not load session history; please retry.');
    expect(f.counts).toEqual({ cancellations: 0, models: 0, created: 0 });
    expect(f.writes).toHaveLength(0);
  } finally {
    app.unmount();
    app.cleanup();
    await f.controller.dispose();
  }
});

test('a late failed directory read cannot replace a newer successful read', async () => {
  const f = fixture();
  let reject!: (reason: Error) => void;
  f.port.listSessions = async () =>
    new Promise((_resolve, failure) => {
      reject = failure;
    });
  const old = f.controller.list();
  f.port.listSessions = async () => [...f.sessions.values()];
  await f.controller.list();
  reject(new Error('old failed read'));
  await old;
  expect(f.controller.state.sessions.map((session) => session.id)).toEqual(['a', 'b']);
  expect(f.controller.state.sessionDirectoryError).toBeUndefined();
  expect(f.controller.state.sessionDirectoryLoading).toBe(false);
  await f.controller.dispose();
});

test('directory reorder preserves selected Session identity through default retention and exact CAS deletion', async () => {
  const f = fixture();
  await f.controller.select('a');
  const app = render(<TuiSession testDiagnostics controller={f.controller} />);
  try {
    await settle();
    app.stdin.write('\u0012');
    await settle();
    app.stdin.write('\u001b[B');
    await settle();
    expect(app.lastFrame()).toContain('❯ 另一会话🙂 [b]');
    f.port.listSessions = async () => [...f.sessions.values()].reverse();
    await f.controller.list();
    await settle();
    expect(app.lastFrame()).toContain('❯ 另一会话🙂 [b]');
    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).toContain('Original Session [b]');
    expect(app.lastFrame()).toContain('❯ Keep Session');
    app.stdin.write('\r');
    await settle();
    expect(f.writes).toEqual([]);
    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).toContain('Original Session [b]');
    app.stdin.write('\u001b[B');
    await settle();
    expect(app.lastFrame()).toContain('❯ Delete Session');
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
    expect(f.counts).toEqual({ cancellations: 0, models: 0, created: 0 });
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('normal conversation has no anomaly chrome and recovers a lost submission by original receipt only', async () => {
  const f = fixture();
  let posts = 0;
  const reads: string[] = [];
  f.controller.port.submit = async () => {
    posts++;
    throw Error('lost_response');
  };
  f.controller.port.getCommand = async (commandId) => {
    reads.push(commandId);
    return {
      id: commandId,
      sessionId: 'a',
      kind: 'run.start',
      status: 'applied',
      originStoreId: 'store',
      receipt: {},
    } as never;
  };
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  try {
    f.controller.setDraft('one task');
    await f.controller.send();
    expect(f.controller.state.intent?.phase).toBe('unknown');
    const original = f.controller.state.intent!.commandId;
    f.controller.observationUnavailable('network');
    await Bun.sleep(30);
    expect(app.lastFrame()).not.toContain('Observation unknown');
    expect(app.lastFrame()).not.toContain('Outcome unknown');
    expect(app.lastFrame()).not.toContain('Ctrl+L');
    expect(app.lastFrame()).not.toContain('Error:');
    const deadline = Date.now() + 2000;
    while (f.controller.state.intent?.phase === 'unknown') {
      if (Date.now() > deadline) throw Error('automatic_receipt_lookup_deadline');
      await Bun.sleep(10);
    }
    expect(reads).toEqual([original]);
    expect(posts).toBe(1);
    // Receipt recovery does not grant health to a failed observation stream.
    expect(f.controller.state.stale).toBe(true);
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('a rejected original input stays in its message item and keeps the draft editable', async () => {
  const f = fixture();
  f.controller.port.submit = async (_sessionId, request) =>
    ({
      id: request.commandId,
      sessionId: 'a',
      kind: request.kind,
      originStoreId: 'store',
      status: 'rejected',
      receipt: { reason: 'original authorization denied' },
    }) as never;
  await f.controller.select('a');
  f.controller.setDraft('original input');
  const app = render(<TuiSession controller={f.controller} />);
  try {
    await f.controller.send();
    await Bun.sleep(30);
    expect(f.controller.state.localMessages).toHaveLength(1);
    expect(f.controller.state.localMessages[0]?.content).toBe('original input');
    expect(f.controller.state.localMessages[0]?.submissionFailure?.reason).toBe(
      'original authorization denied',
    );
    expect(app.lastFrame()).toContain('Input rejected: original authorization denied');
    expect(app.lastFrame()).not.toContain('Submission:');
    expect(f.controller.state.draft).toBe('original input');
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('unknown original submission survives repeated GET failures and stops after the receipt is confirmed', async () => {
  const f = fixture();
  let posts = 0;
  const reads: string[] = [];
  f.controller.port.submit = async () => {
    posts++;
    throw Error('lost_response');
  };
  f.controller.port.getCommand = async (commandId) => {
    reads.push(commandId);
    if (reads.length <= 3) throw Error('temporary_read_failure');
    return {
      id: commandId,
      sessionId: 'a',
      kind: 'run.start',
      status: 'applied',
      originStoreId: 'store',
      receipt: {},
    } as never;
  };
  try {
    await f.controller.select('a');
    f.controller.setDraft('once only');
    await f.controller.send();
    const original = f.controller.state.intent!.commandId;
    const deadline = Date.now() + 11000;
    while (f.controller.state.intent?.phase === 'unknown') {
      if (Date.now() > deadline) throw Error('automatic_receipt_lookup_deadline');
      await Bun.sleep(20);
    }
    expect(reads).toEqual([original, original, original, original]);
    expect(posts).toBe(1);
    await Bun.sleep(550);
    expect(reads).toHaveLength(4);
  } finally {
    f.controller.dispose();
  }
}, 12000);

test('switching Session before the automatic receipt read retires the old scope without a new POST', async () => {
  const f = fixture();
  let posts = 0,
    reads = 0;
  f.controller.port.submit = async () => {
    posts++;
    throw Error('lost_response');
  };
  f.controller.port.getCommand = async () => {
    reads++;
    throw Error('old_scope_read');
  };
  try {
    await f.controller.select('a');
    f.controller.setDraft('original scope');
    await f.controller.send();
    await f.controller.select('b');
    await Bun.sleep(600);
    expect(reads).toBe(0);
    expect(posts).toBe(1);
    expect(f.controller.state.sessionId).toBe('b');
  } finally {
    f.controller.dispose();
  }
});
