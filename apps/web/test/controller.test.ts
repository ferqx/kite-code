import { expect, test } from 'bun:test';
import { type BrowserView, ClientError, type Message } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { WebController, type WebUpdate } from '../src/controller';

function view(sessionId = 'a', active = false, nextSeq = '1'): BrowserView {
  return {
    storeId: 'original',
    snapshotCursor: '9007199254740993',
    session: {
      id: sessionId,
      workspaceId: 'w',
      parentSessionId: null,
      title: sessionId,
      controlRevision: '1',
      contextSelectionId: 'selection',
      nextSeq,
      deletedAt: null,
    },
    executions: [],
    runs: [
      {
        id: `run-${sessionId}`,
        sessionId,
        originCommandId: 'work',
        originStoreId: 'original',
        status: 'running',
        isActive: active,
        createdAt: 1,
        finishedAt: null,
        reason: null,
      },
    ],
  };
}
function message(seq: number, sessionId = 'a'): Message {
  return {
    id: `message-${seq}`,
    seq: String(seq),
    sessionId,
    runId: `run-${sessionId}`,
    status: 'complete',
    role: 'assistant',
    content: `body-${seq}`,
  };
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('web_test_deadline');
    await Bun.sleep(1);
  }
}
function port(
  options: {
    getView?: BrowserClient['getView'];
    listMessages?: BrowserClient['listMessages'];
  } = {},
) {
  const counters = { views: 0, pages: 0, close: 0, dispose: 0, cancel: 0 };
  const signals: AbortSignal[] = [];
  const client = {
    serverInfo: { storeId: 'original' },
    getView: async (id: string, input: { signal?: AbortSignal } = {}) => {
      counters.views++;
      if (input.signal) signals.push(input.signal);
      return options.getView ? options.getView(id, input) : view(id);
    },
    listMessages: async (id: string, input: Parameters<BrowserClient['listMessages']>[1] = {}) => {
      counters.pages++;
      return options.listMessages ? options.listMessages(id, input) : [message(1, id)];
    },
    async closeBrowserSession() {
      counters.close++;
    },
    disposeNetwork() {
      counters.dispose++;
    },
    async cancelCommand() {
      counters.cancel++;
    },
  } as unknown as BrowserClient;
  return { client, counters, signals };
}

test('only selected visible actual activity polls; status text alone never starts polling', async () => {
  let active = true;
  const p = port({ getView: async (id) => view(id, active) });
  const controller = new WebController({
    admittedClient: p.client,
    onUpdate() {},
    initiallyVisible: false,
    pollIntervalMs: 10,
  });
  try {
    await controller.selectSession('a');
    const initial = p.counters.views;
    await Bun.sleep(35);
    expect(p.counters.views).toBe(initial);
    controller.setVisible(true);
    await until(() => p.counters.views >= initial + 4);
    controller.setVisible(false);
    const hidden = p.counters.views;
    await Bun.sleep(35);
    expect(p.counters.views).toBe(hidden);
    active = false;
    controller.setVisible(true);
    await until(() => p.counters.views >= hidden + 2);
    const idle = p.counters.views;
    await Bun.sleep(35);
    expect(p.counters.views).toBe(idle);
    expect(controller.snapshot?.view.runs[0]?.status).toBe('running');
    expect(controller.snapshot?.view.runs[0]?.isActive).toBe(false);
  } finally {
    controller.disposeObserver();
  }
});

test('refresh shares one read while page work is pending; switching session ignores old success and failure', async () => {
  for (const reject of [false, true]) {
    const held = gate();
    let waiting = false;
    const p = port({
      listMessages: async (id) => {
        if (id === 'a') {
          waiting = true;
          await held.wait;
          if (reject) throw new Error('late_a_failure');
        }
        return [message(1, id)];
      },
    });
    const updates: WebUpdate[] = [];
    const controller = new WebController({
      admittedClient: p.client,
      onUpdate: (update) => updates.push(update),
    });
    try {
      const old = controller.selectSession('a');
      await until(() => waiting);
      expect(controller.refresh()).toBe(controller.refresh());
      expect(p.counters.pages).toBe(1);
      await controller.selectSession('b');
      const selected = updates.length;
      held.release();
      expect(await old).toBeUndefined();
      expect(updates).toHaveLength(selected);
      expect(controller.snapshot?.sessionId).toBe('b');
      expect(controller.snapshot?.messages[0]?.sessionId).toBe('b');
    } finally {
      held.release();
      controller.disposeObserver();
    }
  }
});

test('failed refresh preserves the last known snapshot as stale; no half history is published', async () => {
  let fail = false;
  const p = port({
    listMessages: async () => {
      if (fail) throw new ClientError('browser_read_unavailable');
      return [message(1)];
    },
  });
  const updates: WebUpdate[] = [];
  const controller = new WebController({
    admittedClient: p.client,
    onUpdate: (update) => updates.push(update),
  });
  try {
    const original = await controller.selectSession('a');
    fail = true;
    await expect(controller.refresh()).rejects.toThrow('browser_read_unavailable');
    expect(updates.at(-1)?.phase).toBe('stale');
    expect(updates.at(-1)?.snapshot).toEqual(original);
    expect(controller.snapshot).toEqual(original);
    const copy = controller.snapshot!;
    copy.view.session.title = 'caller';
    expect(controller.snapshot?.view.session.title).toBe('a');
  } finally {
    controller.disposeObserver();
  }
});

test('200 plus 1 history pages use exact allocated nextSeq including the final message and Decimal64 snapshot', async () => {
  const reads: Parameters<BrowserClient['listMessages']>[1][] = [];
  const p = port({
    getView: async (id) => view(id, false, '201'),
    listMessages: async (_id, input) => {
      reads.push(input);
      return input?.afterSeq === undefined
        ? Array.from({ length: 200 }, (_, i) => message(i + 1))
        : [message(201)];
    },
  });
  const controller = new WebController({ admittedClient: p.client, onUpdate() {} });
  try {
    const snapshot = await controller.selectSession('a');
    expect(snapshot?.messages).toHaveLength(201);
    expect(snapshot?.messages.at(-1)?.seq).toBe('201');
    expect(reads.map((read) => [read?.afterSeq, read?.upperSeq, read?.limit])).toEqual([
      [undefined, '201', 200],
      ['200', '201', 200],
    ]);
    expect(snapshot?.view.snapshotCursor).toBe('9007199254740993');
  } finally {
    controller.disposeObserver();
  }
});

test('identity failure, changed snapshots, duplicate cursors and foreign pages reject without a ready partial snapshot', async () => {
  for (const mode of ['identity', 'snapshot', 'duplicate', 'foreign', 'beyond'] as const) {
    let views = 0;
    const p = port({
      getView: async (id) => {
        if (mode === 'identity') throw new ClientError('browser_identity_mismatch');
        const value = view(id, false, '201');
        if (mode === 'snapshot' && views++ > 0) value.snapshotCursor = '9007199254740994';
        return value;
      },
      listMessages: async (_id, input) =>
        mode === 'duplicate'
          ? input?.afterSeq === undefined
            ? Array.from({ length: 200 }, (_, i) => message(i + 1))
            : [message(200)]
          : [message(mode === 'beyond' ? 202 : 1, mode === 'foreign' ? 'b' : 'a')],
    });
    const updates: WebUpdate[] = [];
    const controller = new WebController({
      admittedClient: p.client,
      onUpdate: (update) => updates.push(update),
    });
    try {
      await expect(controller.selectSession('a')).rejects.toThrow();
      expect(updates.some((update) => update.phase === 'ready')).toBe(false);
      expect(updates.at(-1)?.phase).toBe('error');
      expect(controller.snapshot).toBeUndefined();
    } finally {
      controller.disposeObserver();
    }
  }
});

test('dispose aborts only this controller read, publishes nothing late and never closes or cancels shared Client work', async () => {
  const held = gate();
  let waiting = false;
  const p = port({
    getView: async (id) => {
      waiting = true;
      await held.wait;
      return view(id, true);
    },
  });
  const updates: WebUpdate[] = [];
  const controller = new WebController({
    admittedClient: p.client,
    onUpdate: (update) => updates.push(update),
    pollIntervalMs: 10,
  });
  const pending = controller.selectSession('a');
  await until(() => waiting);
  controller.disposeObserver();
  expect(p.signals[0]?.aborted).toBe(true);
  held.release();
  expect(await pending).toBeUndefined();
  await Bun.sleep(25);
  expect(updates.map((update) => update.phase)).toEqual(['loading']);
  expect(p.counters).toMatchObject({ close: 0, dispose: 0, cancel: 0, pages: 0 });
  await expect(controller.refresh()).rejects.toThrow('controller_disposed');
});
