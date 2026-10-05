import { expect, test } from 'bun:test';
import type { AgentClient } from '@kite-ai/client';
import { NativeCaller } from '../electron/native-caller';

test('Native reset reloads original facts before a ready-only stream restores write qualification without acknowledging the snapshot', async () => {
  let reset!: () => void, endFirst!: () => void;
  let streams = 0,
    ready = false;
  const order: string[] = [];
  const acknowledged = { storeId: 'store', sequence: '0' };
  const client = {
    serverInfo: { storeId: 'store', capabilities: [] },
    lastAppliedCursor: acknowledged,
    connect: async () => {},
    disposeNetwork() {},
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      streams++;
      if (streams === 1) {
        reset = () => {
          options!.onReset!('server_reset');
          endFirst();
        };
        await new Promise<void>((resolve) => {
          endFirst = resolve;
          options!.signal!.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      expect(options!.startAfter).toEqual({ storeId: 'store', sequence: '10' });
      expect(options!.cursor).toBeUndefined();
      order.push('ready');
      await options!.onReady!({
        storeId: 'store',
        replayFloor: '10',
        highWaterCursor: '10',
      });
      ready = true;
      await new Promise<void>((resolve) =>
        options!.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async listWorkspaceDirectory() {
      order.push('baseline');
      return { snapshotCursor: '10' };
    },
    async listAllWorkspaces() {
      order.push('workspaces');
      return [];
    },
    async listAllSessions() {
      order.push('sessions');
      return [];
    },
    async listMessages() {
      order.push('history');
      return [];
    },
    async getView(id: string) {
      order.push('view');
      return {
        storeId: 'store',
        snapshotCursor: '10',
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
  } as unknown as AgentClient;
  const caller = new NativeCaller(client, () => {});
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw Error('native_reset_fixture_timeout');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    order.length = 0;
    reset();
    await until(() => order.includes('view'));
    expect(caller.state().selection?.permissionUnavailable).toBe(true);
    expect(streams).toBe(1);
    await caller.invoke({
      method: 'messages',
      generation: 1,
      sessionId: 's',
      expectedStoreId: 'store',
      readId: 'reset-history',
      afterSeq: '0',
      upperSeq: '0',
      limit: 200,
    });
    await until(() => ready);
    expect(order).toEqual(['baseline', 'workspaces', 'sessions', 'view', 'history', 'ready']);
    expect(caller.state().selection?.permissionUnavailable).toBe(false);
    expect(client.lastAppliedCursor).toEqual(acknowledged);
  } finally {
    endFirst?.();
    await caller.close();
  }
});

test('Native notification backlog keeps one view read, preserves same selection while loading, and removes write qualification', async () => {
  let notify!: () => void;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  const client = {
    serverInfo: { storeId: 'store', capabilities: [] },
    connect: async () => {},
    observe: async ({ signal, onChange }: { signal: AbortSignal; onChange: () => void }) => {
      notify = onChange;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    disposeNetwork() {},
    async getView(id: string) {
      reads++;
      if (reads === 2) {
        entered();
        await gate;
      }
      return {
        storeId: 'store',
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
  } as unknown as AgentClient;
  const caller = new NativeCaller(client, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    caller.state();
    notify();
    await waiting;
    for (let index = 0; index < 200; index++) notify();
    expect(caller.state().selection).toMatchObject({
      session: { id: 's' },
      permissionUnavailable: true,
    });
    expect(reads).toBe(2);
    release();
    const value = await caller.invoke({ method: 'state', generation: 1 });
    expect(value).toMatchObject({
      selection: { session: { id: 's' }, permissionUnavailable: false, viewLoading: false },
    });
    expect(reads).toBeLessThan(20);
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'other' });
    expect(caller.state().selection?.session.id).toBe('other');
  } finally {
    release();
    await caller.close();
  }
});

test('Native read-only grants keep original Workspace while a dirty successor temporarily clears the view', async () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  const first = gate(),
    entered = gate(),
    successor = gate(),
    successorEntered = gate(),
    grants = gate(),
    grantsEntered = gate();
  let notify!: () => void,
    reads = 0;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['permission_grants'] },
    connect: async () => {},
    observe: async ({ signal, onChange }: { signal: AbortSignal; onChange: () => void }) => {
      notify = onChange;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    disposeNetwork() {},
    async getView(id: string) {
      reads++;
      if (reads === 2) {
        entered.release();
        await first.promise;
      }
      if (reads === 3) {
        successorEntered.release();
        await successor.promise;
      }
      return {
        storeId: 'store',
        session: {
          id,
          workspaceId: 'original-workspace',
          rootSessionId: id,
          parentSessionId: null,
          title: id,
          nextSeq: '0',
          contextSelectionId: 'original-selection',
          controlRevision: '0',
          deletedAt: null,
        },
        runs: [],
        executions: [],
        messages: [],
      };
    },
    async listPermissionGrants() {
      grantsEntered.release();
      await grants.promise;
      return {
        storeId: 'store',
        sessionId: 's',
        workspaceId: 'original-workspace',
        revision: '0',
        upperSeq: '0',
        items: [],
        nextAfterSeq: null,
      };
    },
  } as unknown as AgentClient;
  const caller = new NativeCaller(client, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    notify();
    await entered.promise;
    notify();
    const reading = caller.invoke({ method: 'grants.read', generation: 1, sessionId: 's' });
    first.release();
    await grantsEntered.promise;
    await successorEntered.promise;
    expect(caller.state().selection).toMatchObject({
      session: { id: 's', workspaceId: 'original-workspace' },
      permissionUnavailable: true,
    });
    grants.release();
    expect(await reading).toMatchObject({
      page: { storeId: 'store', sessionId: 's', workspaceId: 'original-workspace', items: [] },
    });
  } finally {
    first.release();
    successor.release();
    grants.release();
    await caller.close();
  }
});
