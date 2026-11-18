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
    listMessageChanges?: BrowserClient['listMessageChanges'];
  } = {},
) {
  const counters = { views: 0, pages: 0, close: 0, dispose: 0, cancel: 0 };
  const signals: AbortSignal[] = [];
  const client = {
    serverInfo: {
      storeId: 'original',
      capabilities: options.listMessageChanges ? ['message_changes'] : [],
    },
    listMessageChanges: options.listMessageChanges,
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

test('a busy Store covers all scoped change pages, reuses A on return and discards a late older A generation', async () => {
  const baselines: string[] = [];
  const pending = gate(),
    entered = gate();
  let cursor = 10,
    hold = false,
    expired = false,
    oldSignal: AbortSignal | undefined;
  const p = port({
    async getView(id) {
      return { ...view(id, id !== 'static', '4'), snapshotCursor: String(cursor) };
    },
    async listMessages(id) {
      baselines.push(id);
      if (cursor === 10) cursor = 11;
      return [message(1, id), message(2, id)];
    },
    async listMessageChanges(id, input, options) {
      const page = {
        storeId: 'original',
        sessionId: id,
        afterCursor: input.afterCursor,
        upperCursor: input.upperCursor,
        nextCursor: input.upperCursor,
        highWaterSeq: '4',
        nextAfterSeq: null,
        messages: [] as Message[],
        removedIds: [] as string[],
      };
      if (expired) {
        expired = false;
        throw new ClientError('cursor_expired');
      }
      if (hold) {
        hold = false;
        oldSignal = options?.signal;
        entered.release();
        await pending.wait;
        return { ...page, messages: [{ ...message(1, id), content: 'late stale A' }] };
      }
      if (input.afterCursor === '10' && !input.afterSeq)
        return {
          ...page,
          nextAfterSeq: '2',
          messages: [message(1, id)],
          removedIds: ['message-2'],
        };
      return {
        ...page,
        messages: [{ ...message(4, id), content: `covered ${input.upperCursor}` }],
      };
    },
  });
  const controller = new WebController({
    admittedClient: p.client,
    onUpdate() {},
    initiallyVisible: false,
  });
  try {
    const first = await controller.selectSession('a');
    expect(first?.messages.map((m) => m.content)).toEqual(['body-1', 'covered 11']);
    await controller.selectSession('static');
    cursor++;
    hold = true;
    const old = controller.selectSession('a');
    await entered.wait;
    await controller.selectSession('b');
    cursor++;
    const fresh = await controller.selectSession('a');
    expect(oldSignal?.aborted).toBe(true);
    pending.release();
    expect(await old).toBeUndefined();
    expect(controller.snapshot).toEqual(fresh);
    expect(fresh?.messages.map((m) => m.content)).toEqual(['body-1', 'covered 13']);
    expect(baselines).toEqual(['a', 'static', 'b']);
    cursor++;
    expired = true;
    expect((await controller.refresh())?.messages.map((m) => m.id)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(baselines).toEqual(['a', 'static', 'b', 'a']);
  } finally {
    pending.release();
    controller.disposeObserver();
  }
});

test('oversized history pages shrink at the same cursor and publish only after all candidates are covered', async () => {
  const rows = Array.from({ length: 202 }, (_, index) => message(index + 1));
  const fullReads: [string | undefined, number][] = [];
  const changes: [string | undefined, number][] = [];
  const phases: string[] = [];
  let cursor = '10';
  let unreadable = false;
  const p = port({
    getView: async (id) => ({ ...view(id, false, '202'), snapshotCursor: cursor }),
    async listMessages(_id, { afterSeq, limit = 200 } = {}) {
      fullReads.push([afterSeq, limit]);
      if (limit > 100) throw new ClientError('response_too_large');
      const start = Number(afterSeq ?? 0);
      return rows.slice(start, start + limit);
    },
    async listMessageChanges(id, { afterCursor, upperCursor, upperSeq, afterSeq, limit = 200 }) {
      expect(upperSeq).toBe('202');
      expect(upperCursor).toBe(cursor);
      expect(afterCursor).toBe(cursor === '11' ? '10' : '11');
      changes.push([afterSeq, limit]);
      const start = Number(afterSeq ?? 0);
      if (limit > 100 || (start === 100 && (limit > 50 || unreadable)))
        throw new ClientError('response_too_large');
      const candidates = rows.slice(start, start + limit);
      return {
        storeId: 'original',
        sessionId: id,
        afterCursor,
        upperCursor,
        nextCursor: upperCursor,
        highWaterSeq: '202',
        nextAfterSeq: candidates.length === limit ? candidates.at(-1)!.seq : null,
        messages: candidates
          .filter((row) => row.seq !== '150')
          .map((row) => ({ ...row, content: `updated ${cursor}/${row.seq}` })),
        removedIds: candidates.filter((row) => row.seq === '150').map((row) => row.id),
      };
    },
  });
  const controller = new WebController({
    admittedClient: p.client,
    initiallyVisible: false,
    onUpdate: (update) => phases.push(update.phase),
  });
  try {
    await controller.selectSession('a');
    expect(fullReads).toEqual([
      [undefined, 200],
      [undefined, 100],
      ['100', 100],
      ['200', 100],
    ]);
    cursor = '11';
    const complete = await controller.refresh();
    expect(changes).toEqual([
      [undefined, 200],
      [undefined, 100],
      ['100', 100],
      ['100', 50],
      ['150', 50],
      ['200', 50],
    ]);
    expect(complete?.messages.map((row) => row.content)).toEqual(
      rows.filter((row) => row.seq !== '150').map((row) => `updated 11/${row.seq}`),
    );
    expect(phases).toEqual(['loading', 'ready', 'ready']);

    cursor = '12';
    unreadable = true;
    changes.length = 0;
    await expect(controller.refresh()).rejects.toThrow('response_too_large');
    expect(changes.at(-1)).toEqual(['100', 1]);
    expect(controller.snapshot).toEqual(complete);
    expect(phases.at(-1)).toBe('stale');
  } finally {
    controller.disposeObserver();
  }
});

test('returning to a short history rebases a large global cursor gap and covers new changes during that scan', async () => {
  let cursor = 9007199254740993n;
  const afterGap = cursor + 20000n;
  const baselines: string[] = [];
  const changes: string[] = [];
  const p = port({
    getView: async (id) => ({ ...view(id), snapshotCursor: String(cursor) }),
    async listMessages(id) {
      baselines.push(id);
      if (cursor === afterGap) cursor++;
      return [message(1, id)];
    },
    async listMessageChanges(id, { afterCursor, upperCursor }) {
      changes.push(afterCursor);
      return {
        storeId: 'original',
        sessionId: id,
        afterCursor,
        upperCursor,
        nextCursor: upperCursor,
        highWaterSeq: '1',
        nextAfterSeq: null,
        messages: [{ ...message(1, id), content: 'caught up' }],
        removedIds: [],
      };
    },
  });
  const controller = new WebController({
    admittedClient: p.client,
    initiallyVisible: false,
    onUpdate() {},
  });
  try {
    await controller.selectSession('a');
    await controller.selectSession('b');
    cursor = afterGap;
    const result = await controller.selectSession('a');
    expect(baselines).toEqual(['a', 'b', 'a']);
    expect(changes).toEqual([String(afterGap)]);
    expect(result?.view.snapshotCursor).toBe(String(afterGap + 1n));
    expect(result?.messages[0]?.content).toBe('caught up');
  } finally {
    controller.disposeObserver();
  }
});

test('returning only reuses a bounded history under the same fresh selection and control revision', async () => {
  const reads: string[] = [];
  let revision = '1';
  const p = port({
    async getView(id) {
      const result = view(id);
      result.session.controlRevision = revision;
      return result;
    },
    async listMessages(id) {
      reads.push(id);
      return [{ ...message(1, id), content: id === 'large' ? 'x'.repeat(2 * 1024 * 1024) : id }];
    },
    async listMessageChanges() {
      throw Error('the view cursor is unchanged');
    },
  });
  const controller = new WebController({
    admittedClient: p.client,
    initiallyVisible: false,
    onUpdate() {},
  });
  try {
    for (const id of ['a', 'b', 'a', 'large', 'b', 'large', 'a'])
      await controller.selectSession(id);
    expect(reads).toEqual(['a', 'b', 'large', 'large']);
    revision = '2';
    await controller.selectSession('b');
    expect(reads.at(-1)).toBe('b');
    for (const id of ['c', 'd', 'e', 'f', 'b']) await controller.selectSession(id);
    expect(reads.slice(-5)).toEqual(['c', 'd', 'e', 'f', 'b']);
    controller.clearSelection();
    await controller.selectSession('f');
    expect(reads.at(-1)).toBe('f');
  } finally {
    controller.disposeObserver();
  }
});

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

test('a failed initial read retries without an active Run and stops on hide or dispose', async () => {
  let failing = true;
  const p = port({
    getView: async (id) => {
      if (failing) throw new ClientError('browser_read_unavailable');
      return view(id, false);
    },
  });
  const updates: WebUpdate[] = [];
  const controller = new WebController({
    admittedClient: p.client,
    pollIntervalMs: 10,
    onUpdate: (update) => updates.push(update),
  });
  try {
    await expect(controller.selectSession('a')).rejects.toThrow();
    await until(() => p.counters.views >= 2);
    controller.setVisible(false);
    const hidden = p.counters.views;
    await Bun.sleep(45);
    expect(p.counters.views).toBe(hidden);
    failing = false;
    controller.setVisible(true);
    await until(() => updates.at(-1)?.phase === 'ready');
    const recovered = p.counters.views;
    await Bun.sleep(35);
    expect(p.counters.views).toBe(recovered);
    expect(controller.snapshot?.sessionId).toBe('a');
    expect(p.counters.cancel).toBe(0);
  } finally {
    controller.disposeObserver();
  }
});

test('failed idle history keeps recovering after more than three failed reads, then stops', async () => {
  let remaining = 4;
  const p = port({
    getView: async (id) => {
      if (remaining-- > 0) throw new ClientError('browser_read_unavailable');
      return view(id, false);
    },
  });
  const updates: WebUpdate[] = [];
  const controller = new WebController({
    admittedClient: p.client,
    pollIntervalMs: 5,
    onUpdate: (update) => updates.push(update),
  });
  try {
    await expect(controller.selectSession('a')).rejects.toThrow();
    await until(() => updates.at(-1)?.phase === 'ready');
    expect(p.counters.views).toBe(6);
    const settled = p.counters.views;
    await Bun.sleep(50);
    expect(p.counters.views).toBe(settled);
  } finally {
    controller.disposeObserver();
  }
});
