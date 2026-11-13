import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentClient,
  CallerCommandRequest,
  Command,
  Message,
  ModelOutputSnapshot,
  Run,
  ServerInfo,
} from '@kite-ai/client';
import { ClientError, canonicalCallerCommandRequest, createClient } from '@kite-ai/client';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { callerDigest, callerTextDigest, NativeCallerJournal } from '../electron/caller-journal';
import { createNativeCallerGenerationOwner, NativeCaller } from '../electron/native-caller';
import { assertNativeSender, decodeNativeRequest, registerNativeIpc } from '../electron/native-ipc';
import type {
  NativeBackgroundChildChunk,
  NativeBackgroundChildOpen,
  NativeBackgroundPage,
} from '../src/background-bridge';
import { composeBrowserDraft } from '../src/browser-annotation-content';
import {
  type NativeRequest,
  type NativeShellPreference,
  type NativeState,
  nativeChannel,
} from '../src/native-bridge';
import type { NativeBrowserRestoreScope } from '../src/native-browser-bridge';
import { backgroundItem } from './background-item.fixture';
import { sessionChange } from './native-change.fixture';
import { memoryPrivateData } from './private-data.fixture';

function client() {
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    serverInfo: { storeId: 'store', subjectId: 'local-user', capabilities: [] },
    connect: async () => ({}),
    verifyConnection: async () => ({ dataAvailability: 'available' }),
    async observe({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async getView(id: string) {
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
    listWorkspaces: async () => [],
    listAllWorkspaces: async () => [],
    listAllSessions: async () => [],
    listSessions: async () => [],
    disposeNetwork() {},
    startRun: async () => {
      writes++;
    },
  } as unknown as AgentClient & { writes: number };
}

test('execution observation progresses while an admission permission read is held', async () => {
  const connection = client();
  connection.serverInfo!.capabilities.push('permission_controls');
  let observe!: Parameters<AgentClient['observe']>[0];
  let cursor = '1',
    views = 0,
    hold = false;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = connection.getView.bind(connection);
  Object.assign(connection, {
    async getCommand() {
      return { id: 'work', originStoreId: 'store', sessionId: 's' };
    },
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      observe = options;
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async getView(id: string) {
      views++;
      return {
        ...(await original(id)),
        snapshotCursor: cursor,
        runs: [
          {
            id: 'r',
            sessionId: 's',
            originStoreId: 'store',
            originCommandId: 'work',
            isActive: cursor !== '3',
            status: cursor === '3' ? 'completed' : 'running',
          },
        ],
      };
    },
    async getPermissionMode() {
      if (hold) {
        entered();
        await held;
      }
      return { storeId: 'store', sessionId: 's', scopeSessionId: 's', mode: 'auto', revision: '1' };
    },
    async getWorkspaceTrust() {
      return { storeId: 'store', workspaceId: 'w', trusted: true, revision: '1', readScopes: [] };
    },
  });
  let terminalPublished = 0;
  let published!: () => void;
  const terminalReady = new Promise<void>((resolve) => {
    published = resolve;
  });
  const caller = new NativeCaller(connection, () => {
    if (caller.state().executionObservation?.observedCursor === '3') {
      terminalPublished ||= performance.now();
      published();
    }
  });
  try {
    const start = performance.now();
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    const activationMs = performance.now() - start;
    await Bun.sleep(120);
    hold = true;
    cursor = '2';
    await observe.onChange?.(sessionChange('s', cursor));
    await started;
    const before = views;
    cursor = '3';
    const event = { ...sessionChange('s', cursor), type: 'run.finished', objectId: 'r' };
    const terminal = performance.now();
    await observe.onChange?.(event);
    await terminalReady;
    expect(views).toBeGreaterThan(before);
    expect(caller.state().executionObservation).toMatchObject({
      observedCursor: '3',
      phase: 'fresh',
      sessionId: 's',
      viewSelection: caller.state().selection!.viewSelection,
      runs: [{ id: 'r', status: 'completed', isActive: false }],
    });
    expect(caller.state().selection?.viewLoading).toBe(true);
    expect(caller.state().selection?.permissions).toBeUndefined();
    expect(caller.state().selection?.runs[0]).toMatchObject({ id: 'r', status: 'running' });
    cursor = '4';
    await observe.onChange?.({ ...event, cursor, type: 'run.started' });
    await Bun.sleep(0);
    expect(caller.state().executionObservation).toMatchObject({
      observedCursor: '4',
      runs: [{ id: 'r', status: 'running', isActive: true }],
    });
    expect(caller.state().selection?.permissions).toBeUndefined();
    console.log(
      JSON.stringify({
        measurement: 'native-held-admission',
        activationMs,
        terminalPublishedMs: terminalPublished - terminal,
        viewReadsWhileHeld: views - before,
      }),
    );
  } finally {
    release();
    await caller.close();
  }
});

test('execution bursts share the in-flight View and ignore foreign cursor pressure', async () => {
  const connection = client();
  let observe!: Parameters<AgentClient['observe']>[0];
  let cursor = '1',
    hold = false,
    inFlight = 0,
    maximum = 0,
    views = 0;
  let release!: () => void, entered!: () => void, published!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    published = resolve;
  });
  const original = connection.getView.bind(connection);
  Object.assign(connection, {
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      observe = options;
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async getView(id: string) {
      views++;
      const snapshotCursor = cursor;
      maximum = Math.max(maximum, ++inFlight);
      try {
        if (hold) {
          hold = false;
          entered();
          await held;
        }
        return { ...(await original(id)), snapshotCursor };
      } finally {
        inFlight--;
      }
    },
  });
  const caller = new NativeCaller(connection, () => {
    if (
      caller.state().executionObservation?.observedCursor === '5' &&
      caller.state().executionObservation?.phase === 'fresh'
    )
      published();
  });
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    hold = true;
    cursor = '2';
    await observe.onChange?.({ ...sessionChange('s', cursor), type: 'execution.finished' });
    await started;
    cursor = '5';
    await observe.onChange?.({ ...sessionChange('s', cursor), type: 'run.finished' });
    await observe.onChange?.({ ...sessionChange('foreign', '999'), type: 'run.finished' });
    expect(inFlight).toBe(1);
    release();
    await finished;
    await Bun.sleep(0);
    expect(maximum).toBe(1);
    expect(views).toBe(3);
    expect(caller.state().executionObservation?.observedCursor).toBe('5');
  } finally {
    release();
    await caller.close();
  }
});

test('a missing workspace remains readable on cold selection while writes are refused until fresh identity and trust return', async () => {
  const port = client();
  port.serverInfo!.capabilities.push('permission_controls');
  let missing = true;
  Object.assign(port, {
    getPermissionMode: async () => ({ storeId: 'store', sessionId: 'root', revision: '1' }),
    getWorkspaceTrust: async () => {
      if (missing) throw new ClientError('workspace_identity_unavailable');
      return {
        storeId: 'store',
        workspaceId: 'w',
        trusted: false,
        revision: 'new',
        readScopes: [],
      };
    },
    verifyConnection: async () => port.serverInfo!,
    listMessages: async () => [],
  });
  const caller = new NativeCaller(
    port,
    () => {},
    memoryPrivateData(),
    [],
    undefined,
    undefined,
    undefined,
    { storeId: 'store', sessionId: 'root' },
  );
  try {
    const attached = (await caller.invoke({ method: 'attach' })) as NativeState;
    expect(attached.selection).toMatchObject({
      session: { id: 'root' },
      workspaceUnavailable: true,
    });
    const state = (await caller.invoke({
      method: 'select',
      generation: 1,
      sessionId: 'root',
    })) as NativeState;
    expect(state.selection).toMatchObject({
      workspaceUnavailable: true,
      permissionUnavailable: false,
    });
    expect(state.selection?.permissions).toBeUndefined();
    const history = {
      method: 'messages' as const,
      generation: 1,
      sessionId: 'root',
      expectedStoreId: 'store',
      readId: 'missing-root',
      afterSeq: '0',
      upperSeq: '0',
      limit: 20,
    };
    expect(await caller.invoke(history)).toMatchObject({ messages: [], highWaterSeq: '0' });
    for (const request of [
      {
        method: 'submit',
        generation: 1,
        sessionId: 'root',
        intent: {
          expectedStoreId: 'store',
          commandId: 'new',
          kind: 'run.start',
          content: 'must not start',
        },
      },
      {
        method: 'permission.mode',
        generation: 1,
        observationId: 1,
        mode: 'full',
        makeDefault: false,
      },
      { method: 'context.rewind', generation: 1, observationId: 1, boundary: null },
      {
        method: 'fileRecovery.begin',
        generation: 1,
        observationId: 1,
        scope: 'workspace',
        title: 'must not modify',
        inputRevision: 1,
      },
    ])
      await expect(caller.invoke(request as NativeRequest)).rejects.toMatchObject({
        code: 'workspace_identity_unavailable',
      });
    expect(port.writes).toBe(0);
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'other' });
    await expect(caller.invoke({ ...history, readId: 'retired-root' })).rejects.toMatchObject({
      code: 'native_selection_changed',
    });
    missing = false;
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
    expect(caller.state().selection?.workspaceUnavailable).toBeUndefined();
    expect(caller.state().selection?.permissions?.trust).toMatchObject({
      trusted: false,
      revision: 'new',
    });
    await caller.invoke({
      method: 'caller.prepare',
      generation: 1,
      sessionId: 'root',
      intent: {
        expectedStoreId: 'store',
        commandId: 'prepared-before-missing',
        kind: 'run.start',
        content: 'must remain unsent',
      },
    });
    missing = true;
    await caller.invoke({ method: 'permission.refresh', generation: 1 });
    await expect(
      caller.invoke({
        method: 'caller.submit',
        generation: 1,
        commandId: 'prepared-before-missing',
      }),
    ).rejects.toMatchObject({ code: 'workspace_identity_unavailable' });
    expect(
      await caller.invoke({
        method: 'caller.lookup',
        generation: 1,
        commandId: 'prepared-before-missing',
      }),
    ).toMatchObject({ phase: 'unknown' });
    const reattached = (await caller.invoke({ method: 'attach' })) as NativeState;
    expect(reattached.generation).toBeGreaterThan(1);
    expect(reattached.selection).toMatchObject({
      session: { id: 'root' },
      workspaceUnavailable: true,
    });
    expect(port.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('a missing workspace preserves local draft CAS and exact Command cancellation without granting new execution', async () => {
  const port = client(),
    data = memoryPrivateData();
  const cancelled: string[] = [],
    withdrawn: string[] = [];
  port.serverInfo!.capabilities.push('permission_controls', 'pending_input_queue');
  Object.assign(port, {
    getPermissionMode: async () => ({}),
    getWorkspaceTrust: async () => {
      throw new ClientError('workspace_identity_unavailable');
    },
    getCommand: async (id: string) => ({
      id,
      sessionId: 'root',
      originStoreId: 'store',
      kind: 'run.start',
      status: 'accepted',
    }),
    getExecution: async (id: string) => ({
      id,
      sessionId: 'root',
      originStoreId: 'store',
      kind: 'job',
      status: 'running',
    }),
    getPendingInputQueue: async () => ({
      commands: [
        {
          id: 'queued-input',
          sessionId: 'root',
          originStoreId: 'store',
          kind: 'run.start',
          status: 'accepted',
          request: { kind: 'run.start', content: '原排队内容' },
        },
      ],
      orders: ['1'],
      revision: 'a'.repeat(64),
      snapshotCursor: '0',
      nextAfterOrder: null,
    }),
    withdrawPendingInput: async (
      _session: string,
      request: import('@kite-ai/client').WithdrawPendingInputRequest,
    ) => {
      withdrawn.push(request.targetCommandId);
      const { expectedStoreId: _store, commandId: _command, ...body } = request;
      return {
        id: request.commandId,
        sessionId: 'root',
        originStoreId: 'store',
        subjectId: 'local-user',
        kind: request.kind,
        status: 'applied',
        requestDigest: callerDigest(body),
        receipt: { outcome: 'input_withdrawn', targetCommandId: request.targetCommandId },
      };
    },
    cancelCommand: async (
      _session: string,
      request: { commandId: string; targetCommandId: string },
    ) => {
      cancelled.push(request.targetCommandId);
      return {
        id: request.commandId,
        sessionId: 'root',
        originStoreId: 'store',
        kind: 'command.cancel',
        status: 'applied',
        subjectId: 'local-user',
        requestDigest: callerTextDigest(
          canonicalCallerCommandRequest(request as CallerCommandRequest),
        ),
        receipt: {
          kind: 'command.cancel',
          targetCommandId: request.targetCommandId,
          outcome: 'cancel_requested',
        },
      };
    },
    cancelExecution: async (
      _session: string,
      request: import('@kite-ai/client').CancelExecutionRequest,
    ) => {
      cancelled.push(request.executionId);
      return {
        id: request.commandId,
        sessionId: 'root',
        originStoreId: 'store',
        kind: 'execution.cancel',
        status: 'applied',
        subjectId: 'local-user',
        requestDigest: callerTextDigest(canonicalCallerCommandRequest(request)),
        receipt: {
          kind: 'execution.cancel',
          executionId: request.executionId,
          outcome: 'cancel_requested',
        },
      };
    },
  });
  const caller = new NativeCaller(port, () => {}, data);
  try {
    await caller.invoke({ method: 'attach' });
    const selected = (await caller.invoke({
      method: 'select',
      generation: 1,
      sessionId: 'root',
    })) as NativeState;
    const draft = (await caller.invoke({
      method: 'draft.read',
      generation: 1,
      sessionId: 'root',
    })) as import('../src/native-bridge').NativeDraft;
    expect(
      await caller.invoke({
        method: 'draft.write',
        generation: 1,
        sessionId: 'root',
        revision: draft.revision,
        content: '保留本地草稿',
      }),
    ).toMatchObject({ content: '保留本地草稿' });
    await expect(
      caller.invoke({
        method: 'draft.write',
        generation: 1,
        sessionId: 'root',
        revision: draft.revision,
        content: 'stale',
      }),
    ).rejects.toThrow('draft_revision_conflict');
    await caller.invoke({
      method: 'caller.prepare',
      generation: 1,
      sessionId: 'root',
      intent: {
        expectedStoreId: 'store',
        commandId: 'cancel-original',
        kind: 'command.cancel',
        targetCommandId: 'original-input',
      },
    });
    expect(
      await caller.invoke({ method: 'caller.submit', generation: 1, commandId: 'cancel-original' }),
    ).toMatchObject({ phase: 'applied' });
    expect(cancelled).toEqual(['original-input']);
    await caller.invoke({
      method: 'caller.prepare',
      generation: 1,
      sessionId: 'root',
      intent: {
        expectedStoreId: 'store',
        commandId: 'cancel-job',
        kind: 'execution.cancel',
        executionId: 'original-job',
      },
    });
    expect(
      await caller.invoke({ method: 'caller.submit', generation: 1, commandId: 'cancel-job' }),
    ).toMatchObject({ phase: 'applied' });
    expect(cancelled).toEqual(['original-input', 'original-job']);
    const observed = (await caller.invoke({
      method: 'input.queue.read',
      generation: 1,
      viewSelection: selected.selection!.viewSelection!,
      historyEpoch: selected.historyEpoch!,
      readId: 'missing-queue',
    })) as import('../src/input-queue-bridge').NativeInputQueueObservation;
    expect(
      await caller.invoke({
        method: 'input.queue.withdraw',
        generation: 1,
        observationId: observed.observationId,
        targetCommandId: 'queued-input',
        purpose: 'delete',
      }),
    ).toMatchObject({ phase: 'applied' });
    expect(withdrawn).toEqual(['queued-input']);
    await expect(
      caller.invoke({
        method: 'caller.prepare',
        generation: 1,
        sessionId: 'root',
        intent: {
          expectedStoreId: 'store',
          commandId: 'new-input',
          kind: 'run.start',
          content: 'must not start',
        },
      }),
    ).rejects.toMatchObject({ code: 'workspace_identity_unavailable' });
    expect(port.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('read receipts bind the selected terminal Run and Store, persist locally, and reject guessed or active facts', async () => {
  const port = client(),
    data = memoryPrivateData();
  const item = backgroundItem();
  let run: Run = {
    ...item.run!,
    id: 'terminal-run',
    sessionId: 'root',
    status: 'completed',
    isActive: false,
  };
  const original = port.getView.bind(port);
  port.serverInfo!.capabilities.push('session_directory_activity');
  Object.assign(port, {
    getView: async (id: string) => ({ ...(await original(id)), runs: [run] }),
    getCommand: async () => ({ id: 'start', sessionId: 'root', originStoreId: 'store' }),
    listAllSessionDirectory: async () => [
      {
        seq: '1',
        session: { ...item.rootSession, id: 'root', workspaceId: 'w' },
        activity: {
          updatedAt: null,
          queued: false,
          pendingInteractions: 0,
          run: { id: run.id, status: run.status, isActive: run.isActive },
        },
      },
    ],
  });
  const caller = new NativeCaller(port, () => {}, data);
  const mark: Extract<NativeRequest, { method: 'session.markRead' }> = {
    method: 'session.markRead',
    generation: 1,
    expectedStoreId: 'store',
    sessionId: 'root',
    runId: run.id,
    status: 'completed',
  };
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'directory', generation: 1 });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
    expect(caller.state().directory?.readTurns).toEqual([]);
    for (const change of [
      { expectedStoreId: 'foreign' },
      { runId: 'guessed' },
      { status: 'failed' as const },
    ])
      await expect(caller.invoke({ ...mark, ...change })).rejects.toMatchObject({
        code: 'turn_read_observation_changed',
      });
    await caller.invoke(mark);
    expect(data.readTurns('store')).toEqual([['root', '["terminal-run","completed"]']]);
    expect(caller.state().directory?.readTurns).toEqual(data.readTurns('store'));
    run = { ...run, status: 'running', isActive: true };
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
    await caller.invoke({ method: 'directory', generation: 1 });
    await expect(caller.invoke(mark)).rejects.toMatchObject({
      code: 'turn_read_observation_changed',
    });
    expect(port.writes).toBe(0);
    expect(decodeNativeRequest(mark)).toEqual(mark);
    for (const change of [{ runId: '../bad' }, { status: 'running' }, { extra: true }])
      expect(() => decodeNativeRequest({ ...mark, ...change })).toThrow('invalid_native_request');
  } finally {
    await caller.close();
  }
});
async function waitForCallerState(
  caller: NativeCaller,
  predicate: (state: NativeState) => boolean,
) {
  const deadline = Date.now() + 1000;
  while (!predicate(caller.state())) {
    if (Date.now() >= deadline) throw Error('native_state_observation_deadline');
    await Bun.sleep(1);
  }
}
// The original Main predicates are the authority baseline for the narrow accessor.
function legacyBrowserScope(
  state: NativeState,
  kind: 'presentation' | 'input',
): NativeBrowserRestoreScope | undefined {
  const view = state.selection;
  if (
    !view ||
    view.session.parentSessionId ||
    (kind === 'presentation'
      ? state.backgroundUnavailable ||
        view.session.deletedAt !== null ||
        (view.permissionUnavailable && view.viewLoading !== true)
      : view.permissionUnavailable || view.viewLoading)
  )
    return undefined;
  return {
    storeId: view.storeId,
    sessionId: view.session.id,
    generation: state.generation,
    viewSelection: view.viewSelection ?? view.viewGeneration,
  };
}
function expectLegacyBrowserScope(caller: NativeCaller) {
  const state = caller.state();
  for (const kind of ['presentation', 'input'] as const)
    expect(caller.browserScope(kind)).toEqual(legacyBrowserScope(state, kind));
}
for (const boundary of [
  'refresh',
  'permission-failure',
  'observation-loss',
  'selection-ABA',
] as const)
  test(`browser scope preserves original admission across ${boundary}`, async () => {
    const connection = client();
    const getView = connection.getView.bind(connection);
    let observer!: Parameters<AgentClient['observe']>[0];
    connection.observe = async (options) => {
      observer = options;
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    let hold = false,
      entered!: () => void,
      release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    connection.getView = async (id) => {
      if (hold && id === 'root') {
        entered();
        await gate;
        if (boundary === 'permission-failure') throw Error('browser_scope_permission_failed');
      }
      return getView(id);
    };
    const caller = new NativeCaller(connection, () => {});
    try {
      expectLegacyBrowserScope(caller); // no selection before or after attach
      await caller.invoke({ method: 'attach' });
      expectLegacyBrowserScope(caller);
      await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
      const original = caller.browserScope('presentation')!;
      expect(original).toEqual({
        storeId: 'store',
        sessionId: 'root',
        generation: 1,
        viewSelection: 2,
      });
      expect(caller.browserScope('input')).toEqual(original);
      expectLegacyBrowserScope(caller);
      hold = true;
      await observer.onChange?.(sessionChange('root'));
      await started;
      expect(caller.browserScope('presentation')).toEqual(original);
      expect(caller.browserScope('input')).toBeUndefined();
      expectLegacyBrowserScope(caller);
      if (boundary === 'observation-loss') {
        await observer.onReset?.({} as never);
        expect(caller.state().backgroundUnavailable).toBe(true);
        expect(caller.browserScope('presentation')).toBeUndefined();
        expect(caller.browserScope('input')).toBeUndefined();
      } else if (boundary === 'selection-ABA') {
        hold = false;
        await caller.invoke({ method: 'select', generation: 1, sessionId: 'other' });
        const other = caller.browserScope('input')!;
        expect(other.sessionId).toBe('other');
        await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
        const returned = caller.browserScope('input')!;
        expect(returned.sessionId).toBe(original.sessionId);
        expect(returned.viewSelection).toBeGreaterThan(other.viewSelection);
        release();
        await Bun.sleep(0);
        expect(caller.browserScope('presentation')).toEqual(returned);
      } else {
        release();
        await waitForCallerState(caller, (state) => state.selection?.viewLoading === false);
        if (boundary === 'permission-failure') {
          expect(caller.browserScope('presentation')).toBeUndefined();
          expect(caller.browserScope('input')).toBeUndefined();
        } else expect(caller.browserScope('input')).toEqual(original);
      }
      expectLegacyBrowserScope(caller);
      caller.detach();
      expect(caller.browserScope('presentation')).toBeUndefined();
      expect(caller.browserScope('input')).toBeUndefined();
      expectLegacyBrowserScope(caller);
      expect(connection.writes).toBe(0);
    } finally {
      release();
      await caller.close();
    }
  });
for (const boundary of ['deleted', 'child'] as const)
  test(`browser scope preserves the original presentation/input distinction for ${boundary}`, async () => {
    const connection = client(),
      getView = connection.getView.bind(connection);
    connection.getView = async (id) => {
      const view = await getView(id);
      return {
        ...view,
        session: {
          ...view.session,
          parentSessionId: boundary === 'child' ? 'parent' : null,
          deletedAt: boundary === 'deleted' ? 1793452800000 : null,
        },
      };
    };
    const caller = new NativeCaller(connection, () => {});
    try {
      await caller.invoke({ method: 'attach' });
      await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
      expect(caller.browserScope('presentation')).toBeUndefined();
      if (boundary === 'child') expect(caller.browserScope('input')).toBeUndefined();
      else expect(caller.browserScope('input')).toMatchObject({ sessionId: 'root' });
      expectLegacyBrowserScope(caller);
    } finally {
      await caller.close();
    }
  });
test('browser scope records fresh observed facts without full state and retains them during the next refresh', async () => {
  const connection = client(),
    getView = connection.getView.bind(connection);
  let observer!: Parameters<AgentClient['observe']>[0],
    deleted = false,
    hold = false,
    entered!: () => void,
    release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connection.observe = async (options) => {
    observer = options;
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  connection.getView = async (id) => {
    if (hold) {
      entered();
      await gate;
    }
    const view = await getView(id);
    return {
      ...view,
      session: { ...view.session, deletedAt: deleted ? 1793452800000 : null },
    };
  };
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
    expect(caller.browserScope('presentation')).toBeDefined();
    deleted = true;
    await observer.onChange?.(sessionChange('root'));
    const deadline = Date.now() + 1000;
    while (!caller.browserScope('input')) {
      if (Date.now() >= deadline) throw Error('browser_scope_refresh_deadline');
      await Bun.sleep(1);
    }
    expect(caller.browserScope('presentation')).toBeUndefined();
    hold = true;
    await observer.onChange?.(sessionChange('root'));
    await started;
    // No full state read observed the deleted fresh View before this refresh.
    expect(caller.browserScope('presentation')).toBeUndefined();
    expect(caller.browserScope('input')).toBeUndefined();
  } finally {
    release();
    await caller.close();
  }
});
test('browser scope denies a mismatched fresh snapshot rather than treating it as a loading retained View', async () => {
  const caller = new NativeCaller(client(), () => {});
  const controller = Reflect.get(caller, 'controller') as { readonly snapshot: unknown };
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
    const fresh = controller.snapshot as { sessionId: string };
    Object.defineProperty(controller, 'snapshot', {
      configurable: true,
      get: () => ({ ...fresh, sessionId: 'foreign' }),
    });
    expect(caller.browserScope('presentation')).toBeUndefined();
    expect(caller.browserScope('input')).toBeUndefined();
    expectLegacyBrowserScope(caller);
  } finally {
    Reflect.deleteProperty(controller, 'snapshot');
    await caller.close();
  }
});
test('browser scope never reads full state, journals or unrelated submission getters', async () => {
  const connection = client(),
    data = memoryPrivateData(),
    reads: string[] = [];
  const caller = new NativeCaller(connection, () => {}, data);
  const state = caller.state.bind(caller);
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
    const expected = legacyBrowserScope(state(), 'presentation');
    for (const key of ['callers', 'answers', 'workspaceRemovals'] as const)
      data[key] = () => {
        reads.push(key);
        throw Error('unexpected_browser_journal_read');
      };
    expect(state()).toMatchObject({
      callerUnavailable: true,
      answerUnavailable: true,
      workspaceRemovalUnavailable: true,
    });
    expect(reads).toEqual(['workspaceRemovals', 'callers', 'answers']);
    reads.length = 0;
    const grants = Reflect.get(caller, 'grants') as object;
    Object.defineProperty(grants, 'submissions', {
      get() {
        reads.push('submissions');
        throw Error('unexpected_browser_submissions');
      },
    });
    expect(() => state()).toThrow('unexpected_browser_submissions');
    reads.length = 0;
    caller.state = () => {
      reads.push('state');
      throw Error('unexpected_browser_full_state');
    };
    for (let index = 0; index < 8; index++) {
      expect(caller.browserScope('presentation')).toEqual(expected);
      expect(caller.browserScope('input')).toEqual(expected);
    }
    expect(reads).toEqual([]);
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});
for (const outcome of ['ready', 'read_failure', 'regressed', 'selection_changed'] as const) {
  test(`Native ready joins one pending activation and preserves ${outcome}`, async () => {
    function gate() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }
    const first = gate(),
      firstEntered = gate();
    const connection = client();
    connection.serverInfo!.capabilities.push('session_reconciliation');
    let observe!: Parameters<AgentClient['observe']>[0],
      reconciliations = 0,
      settled = false;
    const failure = new ClientError('ready_read_failed');
    const getView = connection.getView.bind(connection);
    connection.getView = async (sessionId) => {
      if (outcome === 'read_failure') throw failure;
      return getView(sessionId);
    };
    connection.observe = async (options) => {
      observe = options;
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    connection.reconcileSessionState = async (sessionId) => {
      reconciliations++;
      if (reconciliations === 1) {
        firstEntered.release();
        await first.promise;
      }
      return getView(sessionId);
    };
    const caller = new NativeCaller(connection, () => {});
    try {
      await caller.invoke({ method: 'attach' });
      const selected = caller.invoke({ method: 'select', generation: 1, sessionId: 's' }).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await firstEntered.promise;
      const ready = observe.onReady!({
        storeId: 'store',
        replayFloor: '0',
        highWaterCursor: outcome === 'read_failure' || outcome === 'regressed' ? '1' : '0',
      });
      expect(reconciliations).toBe(1);
      expect(settled).toBe(false);
      expect(caller.state().environmentReadUnavailable).toBe(true);
      if (outcome === 'selection_changed')
        await caller.invoke({ method: 'select', generation: 1, sessionId: 'other' });
      first.release();
      await ready;
      const result = await selected;
      if (outcome === 'read_failure') expect(result).toBe(failure);
      else if (outcome === 'regressed') {
        expect(result).toMatchObject({ code: 'observation_cursor_unavailable' });
        expect(caller.state().selection?.permissionUnavailable).toBe(true);
        expect(caller.state().executionObservation?.phase).toBe('unavailable');
      } else if (outcome === 'selection_changed') {
        expect(result).toMatchObject({ code: 'native_selection_changed' });
        expect(caller.state().selection?.session.id).toBe('other');
        expect(caller.state().selection?.permissionUnavailable).toBe(false);
      } else {
        expect(result).toMatchObject({ selection: { session: { id: 's' } } });
        expect(caller.state().selection?.permissionUnavailable).toBe(false);
      }
      expect(reconciliations).toBe(outcome === 'selection_changed' ? 2 : 1);
      expect(connection.writes).toBe(0);
    } finally {
      first.release();
      await caller.close();
    }
  });
}

test('initial ready reuses completed activation while a replacement epoch reconciles again', async () => {
  const connection = client();
  connection.serverInfo!.capabilities.push('session_reconciliation');
  let observer!: Parameters<AgentClient['observe']>[0],
    reconciliations = 0;
  connection.observe = async (options) => {
    observer = options;
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  connection.reconcileSessionState = async (sessionId) => {
    reconciliations++;
    return connection.getView(sessionId);
  };
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    const ready = { storeId: 'store', replayFloor: '0', highWaterCursor: '0' };
    await observer.onReady!(ready);
    expect(reconciliations).toBe(1);
    expect(caller.state().selection?.permissionUnavailable).toBe(false);
    const epoch = caller.state().historyEpoch!;
    await observer.onReady!(ready);
    expect(reconciliations).toBe(2);
    expect(caller.state().historyEpoch).toBe(epoch + 1);
    expect(caller.state().selection?.permissionUnavailable).toBe(false);
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});
test.each([
  'hidden',
  'failed',
])('ordinary reconnect consumes changes without a %s history reader reaching EOF', async (history) => {
  const connection = client();
  connection.serverInfo!.capabilities.push('message_changes');
  let disconnect!: () => void;
  let observer!: Parameters<AgentClient['observe']>[0];
  let observations = 0,
    readyReturns = 0,
    cursor = '1';
  const original = connection.getView.bind(connection);
  Object.assign(connection, {
    getView: async (id: string) => ({ ...(await original(id)), snapshotCursor: cursor }),
    listWorkspaceDirectory: async () => ({ snapshotCursor: cursor }),
    listMessages: async () => {
      throw new ClientError('history_unavailable');
    },
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      observer = options;
      observations++;
      await options.onReady?.({ storeId: 'store', replayFloor: '0', highWaterCursor: cursor });
      readyReturns++;
      await new Promise<void>((resolve) => {
        disconnect = resolve;
        options.signal!.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    const epoch = caller.state().historyEpoch!;
    cursor = '2';
    disconnect();
    for (let i = 0; i < 150 && readyReturns < 2; i++) await Bun.sleep(5);
    expect(observations).toBe(2);
    expect(readyReturns).toBe(2);
    expect(caller.state().historyEpoch).toBe(epoch + 1);
    if (history === 'failed') {
      await expect(
        caller.invoke({
          method: 'messages',
          generation: 1,
          sessionId: 's',
          expectedStoreId: 'store',
          readId: 'failed-history',
          afterSeq: '0',
        }),
      ).rejects.toThrow('history_unavailable');
    }
    // This is delivered only after onReady returns, as in the SDK SSE reader.
    await observer.onChange({ ...sessionChange('s', '3'), type: 'message.updated' });
    expect(caller.state().selection!.historyTargetCursor).toBe('3');
    expect(caller.state().backgroundUnavailable).toBe(false);
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('Native selected message events wake durable changes directly without View refresh and reconnect revokes the baseline', async () => {
  const connection = client();
  connection.serverInfo!.capabilities.push('message_changes');
  let observe!: Parameters<AgentClient['observe']>[0],
    views = 0,
    snapshotCursor = '5';
  const getView = connection.getView.bind(connection);
  connection.getView = async (id) => {
    views++;
    const view = await getView(id);
    return { ...view, snapshotCursor, session: { ...view.session, nextSeq: '2' } };
  };
  const changeRequests: unknown[] = [];
  const changeSignals: AbortSignal[] = [];
  Object.assign(connection, {
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      observe = options;
      await options.onReady?.({ storeId: 'store', replayFloor: '0', highWaterCursor: '5' });
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async listMessageChanges(
      sessionId: string,
      query: { upperSeq?: string; afterSeq?: string; afterCursor: string; upperCursor: string },
      options: { signal: AbortSignal },
    ) {
      changeRequests.push(query);
      changeSignals.push(options.signal);
      return {
        storeId: 'store',
        sessionId,
        ...query,
        highWaterSeq: '4',
        nextCursor: query.upperCursor,
        nextAfterSeq: query.afterSeq === '0' ? '3' : null,
        messages:
          query.afterSeq === '0'
            ? [{ id: 'new', sessionId, seq: '3', content: 'new partial' }]
            : [],
        removedIds: [],
      };
    },
  });
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    await Bun.sleep(120);
    const before = caller.state(),
      reads = views;
    for (let index = 6; index <= 10; index++)
      await observe.onChange?.({
        cursor: String(index),
        sessionId: 's',
        objectId: 'new',
        revision: '0',
        type: 'message.updated',
        payload: null,
      });
    await Bun.sleep(120);
    const state = caller.state();
    expect(views).toBe(reads);
    expect(state.selection!.viewGeneration).toBe(before.selection!.viewGeneration);
    expect(state.selection!.historyCursor).toBe('5');
    expect(state.selection!.historyTargetCursor).toBe('10');
    const request = {
      method: 'messages' as const,
      generation: 1,
      sessionId: 's',
      expectedStoreId: 'store',
      readId: 'incremental',
      afterSeq: '0',
      changes: { afterCursor: '5', upperCursor: '10' },
    };
    const first = await caller.invoke(request);
    expect(first).toMatchObject({
      highWaterSeq: '4',
      nextAfterSeq: '3',
      changes: { nextCursor: '10' },
    });
    expect(await caller.invoke({ ...request, afterSeq: '3', upperSeq: '4' })).toMatchObject({
      highWaterSeq: '4',
      nextAfterSeq: null,
    });
    expect(changeRequests).toMatchObject([{ upperSeq: undefined }, { upperSeq: '4' }]);
    expect(changeSignals[0]).toBe(changeSignals[1]);
    const epoch = caller.state().historyEpoch!;
    snapshotCursor = '10';
    await observe.onReady?.({ storeId: 'store', replayFloor: '0', highWaterCursor: '10' });
    expect(caller.state().historyEpoch).toBe(epoch + 1);
    expect(caller.state().selection!.historyTargetCursor).toBeUndefined();
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('Native View hands over compression metadata without exporting summary bytes or body readers', async () => {
  const connection = client();
  const getView = connection.getView.bind(connection);
  const summary: Message = {
    id: 'summary',
    sessionId: 's',
    runId: 'r',
    seq: '2',
    role: 'assistant',
    status: 'complete',
    content: 'PRIVATE COMPRESSION SUMMARY',
    sourceIds: ['summary-execution'],
    compression: { id: 'compression', trigger: 'automatic', status: 'completed' },
    outputBody: {
      kind: 'model_output',
      executionId: 'PRIVATE BODY READER',
      complete: true,
      contentBytes: '27',
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  };
  connection.getView = async (id) => {
    const view = await getView(id);
    return {
      ...view,
      session: { ...view.session, nextSeq: '4' },
      messages: [
        { ...summary, id: 'ordinary', compression: undefined },
        summary,
        {
          ...summary,
          id: 'fork',
          originMessage: { storeId: 'old', sessionId: 's', messageId: 'old', runId: 'r' },
        },
      ],
    };
  };
  const caller = new NativeCaller(connection, () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    await waitForCallerState(caller, (state) => !!state.selection?.compressionMessages?.length);
    const facts = caller.state().selection!.compressionMessages!;
    expect(facts).toEqual([
      {
        id: summary.id,
        sessionId: summary.sessionId,
        runId: summary.runId,
        seq: summary.seq,
        role: 'assistant',
        status: summary.status,
        content: '',
        sourceIds: summary.sourceIds,
        compression: summary.compression,
      },
    ]);
    expect(JSON.stringify(caller.state())).not.toContain('PRIVATE');
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

function authority() {
  const frame = { url: pathToFileURL(join(tmpdir(), 'native', 'index.html')).href };
  const contents = { mainFrame: frame };
  return {
    window: { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow,
    event: { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    frame,
  };
}

async function ordinaryJournal(
  kind: 'run.start' | 'input.steer' | 'input.follow_up' = 'run.start',
) {
  const port = client();
  const common = {
    kind,
    commandId: 'public-input',
    expectedStoreId: 'store',
    content: 'New task: 完整🙂e\r\n原输入',
  };
  const request: CallerCommandRequest =
    kind === 'input.steer'
      ? { ...common, kind, targetRunId: 'original-run', contextSelectionId: 'selection' }
      : kind === 'input.follow_up'
        ? { ...common, kind, afterRunId: 'original-run', contextSelectionId: 'selection' }
        : { ...common, kind };
  const command = {
    id: request.commandId,
    kind,
    sessionId: 's',
    originStoreId: 'store',
    subjectId: 'local-user',
    requestDigest: callerTextDigest(canonicalCallerCommandRequest(request)),
    status: 'applied',
    cancelRequestedAt: null,
    receipt: {
      outcome: 'human_input_applied',
      businessCommandId: 'business',
      sourceCommandId: 'business',
      runId: 'business-run',
    },
  } as Command;
  const business = {
    ...command,
    id: 'business',
    kind: 'input.follow_up',
    receipt: { runId: 'business-run' },
  } as Command;
  const run = {
    id: 'business-run',
    sessionId: 's',
    originStoreId: 'store',
    originCommandId: 'business',
    rootWorkCommandId: 'business',
    status: 'completed',
    isActive: false,
  } as Run;
  const reads: string[] = [];
  port.getCommand = async (id) => {
    reads.push(`command:${id}`);
    if (id === request.commandId) return structuredClone(command);
    if (id === business.id) return structuredClone(business);
    throw Error('unexpected_command_read');
  };
  port.getRun = async (id) => {
    reads.push(`run:${id}`);
    if (id === 'original-run') return { ...run, id, originCommandId: 'earlier-business' };
    if (id === run.id) return structuredClone(run);
    throw Error('unexpected_run_read');
  };
  port.getExecution = async (id) => {
    reads.push(`execution:${id}`);
    if (id !== 'processing-model') throw Error('unexpected_execution_read');
    return {
      id,
      kind: 'model',
      status: 'succeeded',
      sessionId: 's',
      originStoreId: 'store',
      runId: run.id,
    } as Awaited<ReturnType<AgentClient['getExecution']>>;
  };
  let writes = 0;
  for (const method of ['startRun', 'steer', 'followUp', 'cancelCommand', 'cancelExecution'])
    Object.assign(port, {
      [method]: async () => {
        writes++;
        throw Error('lookup_must_not_write');
      },
    });
  const data = memoryPrivateData();
  const prepared = await new NativeCallerJournal(port, data).prepare('s', request);
  reads.length = 0;
  return {
    port,
    request,
    command,
    business,
    run,
    reads,
    data,
    prepared,
    // Reopen the journal: the saved original request grants no first POST authority.
    journal: new NativeCallerJournal(port, data),
    writes: () => writes,
  };
}

test('Native ordinary journal cold lookup confirms the exact derived business Run for every original input kind', async () => {
  for (const kind of ['run.start', 'input.follow_up', 'input.steer'] as const) {
    const f = await ordinaryJournal(kind);
    try {
      for (let lookup = 0; lookup < 2; lookup++) {
        expect(await f.journal.lookup(f.request.commandId)).toEqual(f.command);
        expect(f.data.callers()[0]).toEqual({ ...f.prepared, phase: 'applied' });
      }
      expect(f.reads).toEqual(
        Array.from({ length: 2 }, () => [
          'command:public-input',
          'run:business-run',
          'command:business',
        ]).flat(),
      );
      expect(f.writes()).toBe(0);
    } finally {
      f.data.close();
    }
  }
});

test('Native ordinary journal accepts applied same-Run human supplements with the original Run origin', async () => {
  const f = await ordinaryJournal('input.steer');
  try {
    f.business.kind = 'input.steer';
    f.business.receipt = { runId: 'original-run' };
    f.command.receipt = {
      outcome: 'human_input_applied',
      businessCommandId: 'business',
      sourceCommandId: 'business',
      runId: 'original-run',
    };
    expect(await f.journal.lookup(f.request.commandId)).toEqual(f.command);
    expect(f.data.callers()[0]!.phase).toBe('applied');
    expect(f.writes()).toBe(0);
  } finally {
    f.data.close();
  }
});

test('Native ordinary journal preserves null business Run observations and accepted unresolved inputs', async () => {
  for (const outcome of ['human_input_observed', 'human_input_unresolved', 'control'] as const) {
    const f = await ordinaryJournal('input.steer');
    try {
      f.run.originCommandId = 'processing-command';
      f.command.status = outcome === 'human_input_unresolved' ? 'accepted' : 'applied';
      f.command.receipt = {
        outcome: outcome === 'control' ? 'human_input_observed' : outcome,
        runId: null,
        businessCommandId: null,
        humanInputCommandId: 'raw-input',
        decisionCommandId: 'decision',
        ...(outcome === 'control'
          ? {}
          : {
              observation: {
                runId: f.run.id,
                executionId: 'processing-model',
                messageId: 'processing-message',
                answer: outcome === 'human_input_observed' ? '真实观察' : null,
                clarification: outcome === 'human_input_unresolved' ? '请澄清原输入' : null,
              },
            }),
      };
      expect(await f.journal.lookup(f.request.commandId)).toEqual(f.command);
      expect(f.data.callers()[0]!.phase).toBe(f.command.status);
      expect(f.reads.includes('command:business')).toBe(false);
      expect(f.reads.includes('execution:processing-model')).toBe(
        outcome === 'human_input_observed',
      );
      expect(f.writes()).toBe(0);
    } finally {
      f.data.close();
    }
  }
});

test('Native ordinary journal rejects foreign, unapplied, or forged public and business bindings without replay', async () => {
  const changes: ((f: Awaited<ReturnType<typeof ordinaryJournal>>) => void)[] = [
    (f) => {
      f.command.id = 'foreign';
    },
    (f) => {
      f.command.requestDigest = 'foreign';
    },
    (f) => {
      f.command.subjectId = 'foreign';
    },
    (f) => {
      f.business.originStoreId = 'foreign';
    },
    (f) => {
      f.business.sessionId = 'foreign';
    },
    (f) => {
      f.business.subjectId = 'foreign';
    },
    (f) => {
      f.business.status = 'accepted';
    },
    (f) => {
      f.business.receipt = { runId: 'foreign' };
    },
    (f) => {
      f.run.originCommandId = 'foreign';
    },
    (f) => {
      f.run.sessionId = 'foreign';
    },
    (f) => {
      f.command.receipt = { ...(f.command.receipt as object), sourceCommandId: 'foreign' };
    },
    (f) => {
      const getView = f.port.getView.bind(f.port);
      f.port.getView = async (id) => {
        const view = await getView(id);
        return { ...view, session: { ...view.session, workspaceId: 'foreign' } };
      };
    },
  ];
  for (const change of changes) {
    const f = await ordinaryJournal();
    try {
      change(f);
      await expect(f.journal.lookup(f.request.commandId)).rejects.toThrow();
      expect(f.data.callers()[0]).toEqual({ ...f.prepared, phase: 'unknown' });
      expect(f.writes()).toBe(0);
    } finally {
      f.data.close();
    }
  }
});

test('Native ordinary journal retains original target and context selection checks for legacy technical steer', async () => {
  for (const invalid of ['target', 'selection'] as const) {
    const f = await ordinaryJournal('input.steer');
    try {
      f.command.receipt = {
        runId: invalid === 'target' ? 'business-run' : 'original-run',
        contextSelectionId: invalid === 'selection' ? 'foreign' : 'selection',
      };
      await expect(f.journal.lookup(f.request.commandId)).rejects.toThrow();
      expect(f.data.callers()[0]!.phase).toBe('unknown');
      expect(f.writes()).toBe(0);
    } finally {
      f.data.close();
    }
  }
});

test('environment child and directory reads survive a held same-selection refresh, but selection, reset, and refresh failure revoke them', async () => {
  for (const invalidation of ['select', 'reset', 'failure'] as const) {
    const connection = client();
    const cancellations: string[] = [];
    for (const method of ['cancelCommand', 'cancelRun', 'cancelExecution', 'cancelSession'])
      Object.assign(connection, {
        [method]: async () => {
          cancellations.push(method);
          throw Error('reading_must_not_cancel_execution');
        },
      });
    const item = backgroundItem(1, true);
    connection.serverInfo!.capabilities.push('sessions');
    connection.verifyConnection = async () => connection.serverInfo!;
    connection.listAllBackgroundExecutions = async () => [structuredClone(item)];
    connection.listBackgroundExecutions = async () =>
      ({ items: [structuredClone(item)] }) as Awaited<
        ReturnType<AgentClient['listBackgroundExecutions']>
      >;
    connection.getExecution = async (id) =>
      ({ id, sessionId: 'root', originStoreId: 'store', parentExecutionId: null }) as Awaited<
        ReturnType<AgentClient['getExecution']>
      >;
    let notify!: () => void;
    let reset!: () => void;
    connection.observe = async (options) => {
      notify = () => void options.onChange?.(sessionChange('root'));
      reset = () => void options.onReset?.({} as never);
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    const originalView = connection.getView.bind(connection);
    let holdParent = false;
    let parentEntered!: () => void;
    let releaseParent!: () => void;
    const parentStarted = new Promise<void>((resolve) => {
      parentEntered = resolve;
    });
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    connection.getView = async (id) => {
      if (id === 'root' && holdParent) {
        parentEntered();
        await parentGate;
        if (invalidation === 'failure') throw Error('parent_refresh_failed');
      }
      const view = await originalView(id);
      return id === 'child' ? { ...view, session: { ...item.childSession!, nextSeq: '1' } } : view;
    };
    const message = {
      id: 'child-message',
      sessionId: 'child',
      runId: null,
      seq: '1',
      role: 'user',
      status: 'complete',
      content: 'retained child reading',
    } as Message;
    let holdChild = false;
    let childEntered!: () => void;
    let releaseChild!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      childEntered = resolve;
    });
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    connection.listMessages = async (_id, options) => {
      if (holdChild) {
        childEntered();
        // Deliberately ignore cancellation until released, to exercise late-result rejection.
        await childGate;
      }
      return options?.afterSeq === '0' ? [message] : [];
    };
    const caller = new NativeCaller(connection, () => {});
    const surface = { generation: 1, surface: 'environment' as const };
    const beforeParent = async <T>(promise: Promise<T>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('environment_waited_for_parent_refresh')), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await caller.invoke({ method: 'attach' });
      await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
      const directory = (await caller.invoke({
        ...surface,
        method: 'background.open',
        readId: 'initial-environment',
      })) as NativeBackgroundPage;
      await caller.invoke({ ...surface, method: 'background.close', readId: directory.readId });
      const opened = (await caller.invoke({
        ...surface,
        method: 'background.child.open',
        observationId: directory.observationId,
        executionId: item.execution.id,
        readId: 'fixed-child',
      })) as NativeBackgroundChildOpen;
      expect(opened.childSessionId).toBe('child');
      holdParent = true;
      notify();
      await beforeParent(parentStarted);
      const firstChunk = await beforeParent(
        caller.invoke({
          ...surface,
          method: 'background.child.read',
          readId: opened.readId,
          offset: 0,
          limit: 1,
        }),
      );
      expect(firstChunk).toMatchObject({ kind: 'background.child.chunk', nextOffset: 1 });
      const duringRefresh = (await beforeParent(
        caller.invoke({ ...surface, method: 'background.open', readId: 'during-refresh' }),
      )) as NativeBackgroundPage;
      expect(duringRefresh).toMatchObject({
        rootSessionId: 'root',
        entries: [{ execution: { id: 'job-1' } }],
      });
      await caller.invoke({ ...surface, method: 'background.close', readId: duringRefresh.readId });
      holdChild = true;
      const late = caller.invoke({
        ...surface,
        method: 'background.child.open',
        observationId: duringRefresh.observationId,
        executionId: item.execution.id,
        readId: 'late-child',
      });
      const lateResult = late.then(
        () => undefined,
        (error: unknown) => error,
      );
      await beforeParent(childStarted);
      if (invalidation === 'select')
        await caller.invoke({ method: 'select', generation: 1, sessionId: 'other-root' });
      else if (invalidation === 'reset') reset();
      else {
        releaseParent();
        await caller.invoke({ method: 'state', generation: 1 });
        await waitForCallerState(caller, (state) => state.environmentReadUnavailable === true);
        expect(caller.state().selection?.permissionUnavailable).toBe(true);
      }
      await expect(
        caller.invoke({
          ...surface,
          method: 'background.child.read',
          readId: opened.readId,
          offset: 1,
          limit: 1,
        }),
      ).rejects.toThrow();
      releaseChild();
      expect(await lateResult).toBeInstanceOf(Error);
      expect(caller.state().selection?.session.id).toBe(
        invalidation === 'select' ? 'other-root' : 'root',
      );
      expect(connection.writes).toBe(0);
      expect(cancellations).toEqual([]);
    } finally {
      releaseParent();
      releaseChild();
      await caller.close();
    }
  }
});
for (const refresh of ['automatic', 'permission'] as const)
  test(
    refresh +
      ' refresh failure releases environment reads without Renderer close and requires a new observation after recovery',
    async () => {
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      const childStarted = deferred(),
        childGate = deferred(),
        directoryStarted = deferred(),
        directoryGate = deferred();
      const connection = client(),
        item = backgroundItem(1, true),
        cancellations: string[] = [];
      for (const method of ['cancelCommand', 'cancelRun', 'cancelExecution', 'cancelSession'])
        Object.assign(connection, {
          [method]: async () => {
            cancellations.push(method);
            throw Error('reading_must_not_cancel_execution');
          },
        });
      connection.serverInfo!.capabilities.push('sessions');
      connection.verifyConnection = async () => connection.serverInfo!;
      connection.listBackgroundExecutions = async () =>
        ({ items: [structuredClone(item)] }) as Awaited<
          ReturnType<AgentClient['listBackgroundExecutions']>
        >;
      connection.getExecution = async (id) =>
        ({ id, sessionId: 'root', originStoreId: 'store', parentExecutionId: null }) as Awaited<
          ReturnType<AgentClient['getExecution']>
        >;
      let notify!: () => void;
      connection.observe = async (options) => {
        notify = () => void options.onChange?.(sessionChange('root'));
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
      };
      const messages = [
        {
          id: 'child-message',
          sessionId: 'child',
          runId: null,
          seq: '1',
          role: 'user',
          status: 'complete',
          content: 'retained child reading',
        } as Message,
      ];
      const originalView = connection.getView.bind(connection);
      let failParent = false,
        holdChild = false,
        holdDirectory = false;
      let childSignal: AbortSignal | undefined, directorySignal: AbortSignal | undefined;
      connection.getView = async (id) => {
        if (id === 'root' && failParent) throw Error('parent_refresh_failed');
        const view = await originalView(id);
        return id === 'child'
          ? { ...view, session: { ...item.childSession!, nextSeq: String(messages.length) } }
          : view;
      };
      connection.listMessages = async (_id, options) => {
        if (holdChild) {
          childSignal = options?.signal;
          childStarted.resolve();
          // Keep the request alive even after abort, including through recovery.
          await childGate.promise;
        }
        return messages.filter((message) => BigInt(message.seq) > BigInt(options?.afterSeq ?? '0'));
      };
      connection.listAllBackgroundExecutions = async (options) => {
        if (holdDirectory) {
          directorySignal = options?.signal;
          directoryStarted.resolve();
          await directoryGate.promise;
        }
        return [structuredClone(item)];
      };
      const caller = new NativeCaller(connection, () => {}),
        surface = { generation: 1, surface: 'environment' as const };
      try {
        await caller.invoke({ method: 'attach' });
        await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
        const directory = (await caller.invoke({
          ...surface,
          method: 'background.open',
          readId: 'initial-directory',
        })) as NativeBackgroundPage;
        await caller.invoke({ ...surface, method: 'background.close', readId: directory.readId });
        const childRequest = {
          ...surface,
          method: 'background.child.open' as const,
          observationId: directory.observationId,
          executionId: item.execution.id,
        };
        await caller.invoke({ ...childRequest, readId: 'ready-child' });
        holdChild = true;
        const lateChild = caller
          .invoke({ ...childRequest, readId: 'held-child' })
          .catch((error) => error);
        await childStarted.promise;
        holdDirectory = true;
        const lateDirectory = caller
          .invoke({ ...surface, method: 'background.open', readId: 'held-directory' })
          .catch((error) => error);
        await directoryStarted.promise;
        expect(childSignal?.aborted).toBe(false);
        expect(directorySignal?.aborted).toBe(false);
        failParent = true;
        if (refresh === 'automatic') {
          notify();
          await caller.invoke({ method: 'state', generation: 1 });
          await waitForCallerState(caller, (state) => state.environmentReadUnavailable === true);
        } else
          await expect(
            caller.invoke({ method: 'permission.refresh', generation: 1 }),
          ).rejects.toThrow('parent_refresh_failed');
        expect(caller.state().environmentReadUnavailable).toBe(true);
        expect(childSignal?.aborted).toBe(true);
        expect(directorySignal?.aborted).toBe(true);
        holdDirectory = false;
        await expect(
          caller.invoke({ ...surface, method: 'background.open', readId: 'unavailable-directory' }),
        ).rejects.toThrow('background_unavailable');
        failParent = holdChild = holdDirectory = false;
        messages.push({
          ...messages[0]!,
          id: 'new-child-message',
          seq: '2',
          content: 'fresh child reading',
        });
        await caller.invoke({ method: 'permission.refresh', generation: 1 });
        expect(caller.state().environmentReadUnavailable).toBe(false);
        // Recovery alone cannot revive a completed wire body or the previous observation.
        await expect(
          caller.invoke({
            ...surface,
            method: 'background.child.read',
            readId: 'ready-child',
            offset: 0,
            limit: 1,
          }),
        ).rejects.toThrow('background_read_missing');
        await expect(
          caller.invoke({ ...childRequest, readId: 'unverified-recovery' }),
        ).rejects.toThrow('background_observation_changed');
        const recovered = (await caller.invoke({
          ...surface,
          method: 'background.open',
          readId: 'recovered-directory',
        })) as NativeBackgroundPage;
        expect(recovered.observationId).toBeGreaterThan(directory.observationId);
        const opened = (await caller.invoke({
          ...childRequest,
          observationId: recovered.observationId,
          readId: 'recovered-child',
        })) as NativeBackgroundChildOpen;
        childGate.resolve();
        directoryGate.resolve();
        expect(await lateChild).toBeInstanceOf(Error);
        expect(await lateDirectory).toBeInstanceOf(Error);
        await expect(
          caller.invoke({
            ...surface,
            method: 'background.child.read',
            readId: 'held-child',
            offset: 0,
            limit: 1,
          }),
        ).rejects.toThrow('background_read_missing');
        const chunk = (await caller.invoke({
          ...surface,
          method: 'background.child.read',
          readId: opened.readId,
          offset: 0,
          limit: 65536,
        })) as NativeBackgroundChildChunk;
        expect(chunk.eof).toBe(true);
        expect(JSON.parse(Buffer.from(chunk.data, 'base64').toString()).messages).toEqual(messages);
        expect(connection.writes).toBe(0);
        expect(cancellations).toEqual([]);
      } finally {
        childGate.resolve();
        directoryGate.resolve();
        await caller.close();
      }
    },
  );
test('paired first admission is consumed once; standalone cached identity and reconnect still require real admission', async () => {
  const identity: ServerInfo = {
    profile: { dataRoot: '/chosen/data', name: 'native', accessKey: 'native-profile' },
    instanceId: 'native-instance',
    buildId: 'native-build',
    apiMajor: 1,
    capabilities: ['events', 'sessions'],
    dataAvailability: 'available',
    storeId: 'native-store',
  };
  let current = identity,
    admissions = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer native-token');
      const path = new URL(request.url).pathname;
      if (path === '/v1/server') {
        admissions++;
        return Response.json(current);
      }
      if (path === '/v1/events')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: ready\ndata: ${JSON.stringify({ storeId: identity.storeId, replayFloor: '0', highWaterCursor: '0' })}\n\n`,
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return new Response(null, { status: 404 });
    },
  });
  const connection = createClient({
    endpoint: server.url.href,
    token: 'native-token',
    bootstrap: identity,
    expected: {
      profile: identity.profile,
      instanceId: identity.instanceId,
      buildId: identity.buildId,
      apiMajor: identity.apiMajor,
      requiredCapabilities: ['events', 'sessions'],
    },
  });
  const callers: NativeCaller[] = [];
  try {
    await connection.connect();
    let consumed = 0;
    const paired = new NativeCaller(connection, () => {}, undefined, [], {
      client: connection,
      consume: () => ++consumed === 1,
    });
    callers.push(paired);
    await paired.invoke({ method: 'attach' });
    expect(admissions).toBe(1);
    expect(consumed).toBe(1);
    await paired.disposeNetwork();
    await paired.invoke({ method: 'attach' });
    expect(admissions).toBe(2);
    expect(consumed).toBe(1);
    await paired.close();

    // A retained serverInfo after disposal is not a new admission.
    expect(connection.serverInfo?.storeId).toBe(identity.storeId);
    const standalone = new NativeCaller(connection, () => {});
    callers.push(standalone);
    await standalone.invoke({ method: 'attach' });
    expect(admissions).toBe(3);
    current = { ...identity, storeId: 'replacement-store' };
    await expect(connection.verifyConnection()).rejects.toMatchObject({
      code: 'store_identity_mismatch',
    });
    current = { ...identity, profile: { ...identity.profile, accessKey: 'wrong-profile' } };
    await standalone.disposeNetwork();
    await expect(standalone.invoke({ method: 'attach' })).rejects.toMatchObject({
      code: 'profile_identity_mismatch',
    });
    expect(admissions).toBe(5);
    expect(consumed).toBe(1);

    current = identity;
    await connection.connect();
    const revoked = new NativeCaller(connection, () => {}, undefined, [], {
      client: connection,
      consume: () => {
        throw Error('revoked admission must not be consumed');
      },
    });
    callers.push(revoked);
    revoked.detach();
    await revoked.invoke({ method: 'attach' });
    expect(admissions).toBe(7);
    await revoked.close();

    await connection.connect();
    let failedConsumptions = 0;
    const failed = new NativeCaller(connection, () => {}, undefined, [], {
      client: connection,
      consume: () => {
        failedConsumptions++;
        throw Error('handoff_unavailable');
      },
    });
    callers.push(failed);
    await expect(failed.invoke({ method: 'attach' })).rejects.toThrow('handoff_unavailable');
    await failed.invoke({ method: 'attach' });
    expect(failedConsumptions).toBe(1);
    expect(admissions).toBe(9);
  } finally {
    for (const caller of callers) await caller.close();
    connection.disposeNetwork();
    server.stop(true);
  }
});
test('formal Native reads an observed restored Fork with a missing workspace through original Model provenance, without rebinding or writes', async () => {
  const connection = client(),
    content = 'original 雪🙂\r\ncomplete tail',
    output = { content, reasoning: '', toolCalls: [], complete: true },
    body = JSON.stringify(output),
    message: Message = {
      id: 'sealed-message',
      sessionId: 'fork',
      runId: null,
      seq: '1',
      status: 'complete',
      role: 'assistant',
      content: 'preview',
      originMessage: {
        storeId: 'original-store',
        sessionId: 's',
        messageId: 'original-message',
        runId: 'r',
      },
      outputBody: {
        kind: 'model_output',
        executionId: 'e',
        complete: true,
        contentBytes: String(Buffer.byteLength(content)),
        reasoningBytes: '0',
        toolCallCount: 0,
      },
    },
    snapshot: ModelOutputSnapshot = {
      storeId: 'store',
      sessionId: 's',
      rootSessionId: 's',
      runId: 'r',
      executionId: 'e',
      originCommandId: 'cmd',
      rootWorkCommandId: 'cmd',
      rootWorkSeq: '1',
      attempt: 1,
      status: 'succeeded',
      bodyHash: createHash('sha256').update(body).digest('hex'),
      bodyBytes: String(Buffer.byteLength(body)),
      contentBytes: message.outputBody!.contentBytes,
      reasoningBytes: '0',
      snapshotCursor: '1',
      output,
    };
  Object.assign(connection.serverInfo!, { capabilities: ['model_outputs', 'permission_controls'] });
  Object.assign(connection, {
    getPermissionMode: async () => ({ storeId: 'store', sessionId: 'fork', revision: '1' }),
    getWorkspaceTrust: async () => {
      throw new ClientError('workspace_identity_unavailable');
    },
  });
  const originalView = connection.getView.bind(connection);
  connection.getView = async (id) => {
    const view = await originalView(id);
    return { ...view, session: { ...view.session, nextSeq: '1' } };
  };
  connection.verifyConnection = async () => connection.serverInfo!;
  connection.listMessages = async () => [message];
  const reads: string[] = [],
    signals: AbortSignal[] = [];
  let originStoreId = 'original-store';
  connection.getExecution = async (id, options) => {
    reads.push(`execution:${id}`);
    signals.push(options!.signal!);
    return {
      id,
      originStoreId,
      sessionId: 's',
      runId: 'r',
      kind: 'model',
      definitionId: 'model',
      definitionVersion: '1',
      status: 'succeeded',
      result: null,
      resultRevision: '1',
      cancelRequestedAt: null,
    };
  };
  connection.getModelOutput = async (sessionId, executionId, options) => {
    reads.push(`output:${sessionId}:${executionId}:${options!.expectedStoreId}`);
    signals.push(options!.signal!);
    return snapshot;
  };
  const caller = new NativeCaller(connection, () => {}, memoryPrivateData()),
    request = {
      method: 'modelOutput.open' as const,
      generation: 1,
      readId: 'full',
      expectedStoreId: 'store',
      sessionId: 'fork',
      messageId: message.id,
      executionId: 'e',
    };
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'fork' });
    expect(caller.state().selection).toMatchObject({ workspaceUnavailable: true });
    await expect(caller.invoke(request)).rejects.toMatchObject({
      code: 'model_output_message_unavailable',
    });
    expect(reads).toEqual([]);
    await caller.invoke({
      method: 'messages',
      generation: 1,
      sessionId: 'fork',
      expectedStoreId: 'store',
      readId: 'history',
      afterSeq: '0',
      upperSeq: '1',
      limit: 32,
    });
    expect(await caller.invoke(request)).toMatchObject({
      kind: 'modelOutput.opened',
      storeId: 'store',
      sessionId: 's',
      executionId: 'e',
      bodyHash: snapshot.bodyHash,
    });
    const chunk = await caller.invoke({
      method: 'modelOutput.read',
      generation: 1,
      readId: 'full',
      offset: 0,
      limit: 65536,
    });
    if (!chunk || !('data' in chunk) || !('eof' in chunk) || chunk.kind !== 'modelOutput.chunk')
      throw Error('missing_full_body');
    expect(chunk.eof).toBe(true);
    expect(JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8'))).toEqual(snapshot);
    expect(reads).toEqual(['execution:e', 'output:s:e:store']);
    expect(signals[0]).toBe(signals[1]);
    await caller.invoke({ method: 'modelOutput.close', generation: 1, readId: 'full' });
    expect(signals[0]!.aborted).toBe(true);
    originStoreId = 'wrong-origin';
    await expect(caller.invoke({ ...request, readId: 'wrong' })).rejects.toMatchObject({
      code: 'model_output_identity_mismatch',
    });
    expect(reads).toEqual(['execution:e', 'output:s:e:store', 'execution:e']);
    expect(message.originMessage!.storeId).toBe('original-store');
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});
test('formal Native metadata port reads only messages observed through the current original history', async () => {
  const connection = client();
  const message: Message = {
    id: 'tool-message',
    sessionId: 's',
    runId: 'run',
    seq: '1',
    status: 'complete',
    role: 'tool',
    content: 'real_failure',
    sourceIds: ['execution'],
  };
  const originalView = connection.getView.bind(connection);
  connection.getView = async (id) => {
    const view = await originalView(id);
    return { ...view, session: { ...view.session, nextSeq: '1' } };
  };
  connection.verifyConnection = async () => connection.serverInfo!;
  connection.listMessages = async () => [message];
  const reads: string[] = [];
  let notify!: Parameters<AgentClient['observe']>[0]['onChange'];
  connection.observe = async (options) => {
    notify = options.onChange;
    await new Promise<void>((resolve) =>
      options.signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  let refreshStarted!: () => void, releaseRefresh: (() => void) | undefined;
  const refreshing = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  connection.getExecution = async (id) => {
    reads.push(id);
    return {
      id,
      originStoreId: 'store',
      sessionId: 's',
      runId: 'run',
      kind: 'tool',
      definitionId: 'custom.tool',
      definitionVersion: '1',
      status: 'failed',
      result: { outcome: 'failed', content: message.content },
      resultRevision: '1',
      cancelRequestedAt: null,
    };
  };
  connection.getRun = async (id) => ({
    id,
    originStoreId: 'store',
    originCommandId: 'command',
    sessionId: 's',
    status: 'failed',
    isActive: false,
    createdAt: 1000,
    finishedAt: 3000,
    reason: 'actual reason',
  });
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    const selected = (await caller.invoke({
      method: 'select',
      generation: 1,
      sessionId: 's',
    })) as NativeState;
    const request = {
      method: 'toolMessages.list' as const,
      generation: 1,
      viewSelection: selected.selection!.viewSelection!,
      historyEpoch: selected.historyEpoch!,
      readId: 'tools',
      messageIds: [message.id],
    };
    await expect(caller.invoke(request)).rejects.toMatchObject({
      code: 'tool_message_unavailable',
    });
    expect(reads).toEqual([]);
    await caller.invoke({
      method: 'messages',
      generation: 1,
      sessionId: 's',
      expectedStoreId: 'store',
      readId: 'history',
      afterSeq: '0',
      upperSeq: '1',
      limit: 32,
    });
    expect(await caller.invoke(request)).toMatchObject({
      kind: 'toolMessages.page',
      scope: {
        sessionId: 's',
        storeId: 'store',
        viewSelection: selected.selection!.viewSelection!,
      },
      entries: [{ messageId: message.id, executionId: 'execution', status: 'failed' }],
    });
    expect(reads).toEqual(['execution']);
    expect(
      await caller.invoke({ ...request, method: 'toolMessages.runs', readId: 'run-metadata' }),
    ).toMatchObject({
      kind: 'toolMessages.runs',
      runs: [{ id: 'run', status: 'failed', reason: 'actual reason' }],
    });
    connection.getView = async (id) => {
      refreshStarted();
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const view = await originalView(id);
      return { ...view, session: { ...view.session, nextSeq: '1' } };
    };
    await notify?.({
      cursor: '1',
      objectId: 'execution',
      sessionId: 's',
      type: 'execution.completed',
      revision: '1',
      payload: null,
    });
    await refreshing;
    // Metadata can finish against the retained same-identity view during an ordinary refresh.
    expect(await caller.invoke({ ...request, readId: 'during-refresh' })).toMatchObject({
      kind: 'toolMessages.page',
      entries: [{ executionId: 'execution', status: 'failed' }],
    });
    expect(
      await caller.invoke({
        ...request,
        method: 'toolMessages.runs',
        readId: 'run-during-refresh',
      }),
    ).toMatchObject({ kind: 'toolMessages.runs', runs: [{ id: 'run', status: 'failed' }] });
    releaseRefresh!();
    await caller.invoke({ method: 'state', generation: 1 });
    expect(
      await caller.invoke({ method: 'toolMessages.close', generation: 1, readId: 'tools' }),
    ).toBeNull();
    expect(connection.writes).toBe(0);
  } finally {
    releaseRefresh?.();
    await caller.close();
  }
});
test('parent history and loading state do not wait for a held same-selection metadata refresh', async () => {
  const connection = client();
  const message: Message = {
    id: 'retained-parent-message',
    sessionId: 'parent',
    runId: null,
    seq: '1',
    status: 'complete',
    role: 'user',
    content: 'Original parent history before opening a child',
  };
  const originalView = connection.getView.bind(connection);
  let holding = false;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  connection.getView = async (id) => {
    if (id === 'parent' && holding) {
      entered();
      await gate;
    }
    const view = await originalView(id);
    return {
      ...view,
      session: { ...view.session, nextSeq: '1' },
      compressionProgress: {
        runId: 'compressing-run',
        originStoreId: 'store',
        executionId: 'compression-model',
        phase: 'summarizing',
      },
    };
  };
  connection.listMessages = async (id) => (id === 'parent' ? [structuredClone(message)] : []);
  connection.verifyConnection = async () => connection.serverInfo!;
  let notify!: Parameters<AgentClient['observe']>[0]['onChange'];
  connection.observe = async (options) => {
    notify = options.onChange;
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  const caller = new NativeCaller(connection, () => {});
  const history = {
    method: 'messages' as const,
    generation: 1,
    sessionId: 'parent',
    expectedStoreId: 'store',
    afterSeq: '0',
    upperSeq: '1',
    limit: 32,
  };
  const bounded = async <T>(promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then((value) => ({ completed: true as const, value })),
        new Promise<{ completed: false }>((resolve) => {
          timer = setTimeout(() => resolve({ completed: false }), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'parent' });
    expect(await caller.invoke({ ...history, readId: 'before-child' })).toMatchObject({
      messages: [message],
      highWaterSeq: '1',
      nextAfterSeq: null,
    });
    await caller.invoke({ method: 'messages.close', generation: 1, readId: 'before-child' });
    holding = true;
    await notify?.(sessionChange('parent'));
    expect((await bounded(started)).completed).toBe(true);
    const pendingHistory = caller.invoke({ ...history, readId: 'return-from-child' });
    const pendingState = caller.invoke({ method: 'state', generation: 1 });
    const pendingPermission = caller
      .invoke({
        method: 'permission.mode',
        generation: 1,
        observationId: 1,
        mode: 'full',
        makeDefault: false,
      })
      .catch((cause: unknown) => cause);
    const [readBeforeRelease, stateBeforeRelease, permissionBeforeRelease] = await Promise.all([
      bounded(pendingHistory),
      bounded(pendingState),
      bounded(pendingPermission),
    ]);
    // Release regardless of the assertions below: a red regression must not leave Main hung.
    holding = false;
    release();
    await Promise.all([pendingHistory, pendingState, pendingPermission]);
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'other' });
    await expect(caller.invoke({ ...history, readId: 'late-parent' })).rejects.toMatchObject({
      code: 'native_selection_changed',
    });
    await expect(
      caller.invoke({
        ...history,
        sessionId: 'other',
        expectedStoreId: 'foreign-store',
        readId: 'foreign',
      }),
    ).rejects.toMatchObject({ code: 'store_identity_mismatch' });
    await expect(
      caller.invoke({ ...history, generation: 0, readId: 'old-generation' }),
    ).rejects.toMatchObject({ code: 'native_generation_changed' });
    expect(() => decodeNativeRequest({ method: 'unknown.write', generation: 1 })).toThrow();
    expect(connection.writes).toBe(0);
    expect(permissionBeforeRelease.completed).toBe(false);
    expect({
      historyCompleted: readBeforeRelease.completed,
      stateCompleted: stateBeforeRelease.completed,
    }).toEqual({ historyCompleted: true, stateCompleted: true });
    if (readBeforeRelease.completed)
      expect(readBeforeRelease.value).toMatchObject({
        messages: [message],
        highWaterSeq: '1',
        nextAfterSeq: null,
      });
    expect(stateBeforeRelease.completed).toBe(true);
    if (stateBeforeRelease.completed)
      expect(stateBeforeRelease.value).toMatchObject({
        selection: {
          session: { id: 'parent' },
          viewLoading: true,
          permissionUnavailable: true,
          permissions: undefined,
          compressionProgress: {
            runId: 'compressing-run',
            originStoreId: 'store',
            executionId: 'compression-model',
            phase: 'summarizing',
          },
        },
      });
  } finally {
    release();
    await caller.close();
  }
});
test('Native history shrinks public response and IPC pages with the original cursor and high water; closing aborts only that read', async () => {
  const connection = client();
  const queries: { afterSeq?: string; upperSeq?: string; limit?: number }[] = [];
  let readSignal: AbortSignal | undefined;
  connection.listMessages = (async (id, options) => {
    queries.push({
      afterSeq: options?.afterSeq,
      upperSeq: options?.upperSeq,
      limit: options?.limit,
    });
    readSignal = options?.signal;
    if (options!.limit! > 50)
      throw Object.assign(Error('oversized public response'), { code: 'response_too_large' });
    const after = Number(options!.afterSeq ?? '0');
    return Array.from(
      { length: Math.min(options!.limit!, Number(options!.upperSeq) - after) },
      (_, index) => ({
        id: `large-${after + index + 1}`,
        sessionId: id,
        seq: String(after + index + 1),
        content: 'x'.repeat(100000),
      }),
    );
  }) as AgentClient['listMessages'];
  const originalView = connection.getView.bind(connection);
  connection.getView = (async (id) => {
    const view = await originalView(id);
    return { ...view, session: { ...view.session, nextSeq: '100' } };
  }) as AgentClient['getView'];
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    const page = await caller.invoke({
      method: 'messages',
      generation: 1,
      sessionId: 's',
      expectedStoreId: 'store',
      readId: 'large-history',
      afterSeq: '0',
      upperSeq: '100',
      limit: 200,
    });
    expect(queries).toEqual(
      [200, 100, 50, 25].map((limit) => ({ afterSeq: '0', upperSeq: '100', limit })),
    );
    expect(page).toMatchObject({ highWaterSeq: '100', nextAfterSeq: '25' });
    expect(page && 'messages' in page ? page.messages.length : -1).toBe(25);
    const request = {
      method: 'messages' as const,
      generation: 1,
      sessionId: 's',
      expectedStoreId: 'store',
      readId: 'large-history',
      upperSeq: '100',
      limit: 200,
    };
    const complete = page && 'messages' in page ? [...page.messages] : [];
    let afterSeq = page && 'nextAfterSeq' in page ? page.nextAfterSeq : null;
    while (afterSeq !== null) {
      const next = await caller.invoke({ ...request, afterSeq });
      if (!next || !('messages' in next)) throw Error('expected history page');
      expect(next.highWaterSeq).toBe('100');
      complete.push(...next.messages);
      afterSeq = next.nextAfterSeq;
    }
    expect(complete.map((message) => message.seq)).toEqual(
      Array.from({ length: 100 }, (_, index) => String(index + 1)),
    );
    expect(complete.every((message) => message.content === 'x'.repeat(100000))).toBe(true);
    expect(queries.slice(4)).toEqual(
      [25, 50, 75].map((after) => ({ afterSeq: String(after), upperSeq: '100', limit: 25 })),
    );
    queries.length = 0;
    await caller.invoke({ ...request, readId: 'new-history', afterSeq: '0' });
    expect(queries.map((query) => query.limit)).toEqual([200, 100, 50, 25]);
    queries.length = 0;
    await caller.invoke({ ...request, readId: 'new-history', afterSeq: '25', limit: 10 });
    await caller.invoke({ ...request, readId: 'new-history', afterSeq: '35' });
    expect(queries.map((query) => query.limit)).toEqual([10, 10]);
    queries.length = 0;
    await caller.invoke({ ...request, readId: 'new-history', afterSeq: '0', upperSeq: '80' });
    expect(queries.map((query) => query.limit)).toEqual([200, 100, 50, 25]);
    queries.length = 0;
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'other' });
    await caller.invoke({
      ...request,
      readId: 'new-history',
      sessionId: 'other',
      afterSeq: '0',
      upperSeq: '80',
    });
    expect(queries.map((query) => query.limit)).toEqual([200, 100, 50, 25]);
    await caller.invoke({
      ...request,
      sessionId: 'other',
      afterSeq: '0',
      upperSeq: '80',
      limit: 10,
    });
    expect(readSignal?.aborted).toBe(false);
    await caller.invoke({ method: 'messages.close', generation: 1, readId: 'large-history' });
    expect(readSignal?.aborted).toBe(true);
    queries.length = 0;
    await caller.invoke({ ...request, sessionId: 'other', afterSeq: '0', upperSeq: '80' });
    expect(queries.map((query) => query.limit)).toEqual([200, 100, 50, 25]);
    await caller.invoke({ method: 'messages.close', generation: 1, readId: 'large-history' });
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}
test('main IPC denies foreign/subframe senders and closed or oversized requests before client/startup; oversize reply stays local', async () => {
  const auth = authority();
  expect(() => assertNativeSender(auth.event, auth.window, auth.frame.url)).not.toThrow();
  expect(() =>
    assertNativeSender(
      { ...auth.event, senderFrame: { url: auth.frame.url } } as IpcMainInvokeEvent,
      auth.window,
      auth.frame.url,
    ),
  ).toThrow('native_sender_denied');
  expect(() =>
    assertNativeSender(auth.event, auth.window, pathToFileURL(join(tmpdir(), 'foreign.html')).href),
  ).toThrow('native_sender_denied');
  expect(() => decodeNativeRequest({ method: 'attach', token: 'hidden' })).toThrow(
    'invalid_native_request',
  );
  expect(() =>
    decodeNativeRequest({ method: 'messages', generation: 1, sessionId: 's', limit: 201 }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'submit',
      generation: 1,
      sessionId: 's',
      intent: { kind: 'run.start', subjectId: 'intruder' },
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'draft.write',
      generation: 1,
      sessionId: 's',
      revision: 0,
      content: 'x'.repeat(1048576),
    }),
  ).toThrow('native_request_too_large');
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>,
    calls = 0;
  const ipcMain = {
    handle(channel: string, value: typeof handler) {
      expect(channel).toBe(nativeChannel);
      handler = value;
    },
    removeHandler() {},
  } as unknown as IpcMain;
  const host = {
    invoke: async () => ({ content: 'x'.repeat(4 * 1048576), revision: 0 }),
  } as unknown as NativeCaller;
  registerNativeIpc({
    ipcMain,
    window: () => auth.window,
    rendererUrl: auth.frame.url,
    caller: async () => {
      calls++;
      return host;
    },
  });
  expect(await handler(auth.event, { method: 'attach', token: 'bad' })).toEqual({
    ok: false,
    code: 'invalid_native_request',
  });
  expect(calls).toBe(0);
  expect(await handler(auth.event, { method: 'attach' })).toEqual({
    ok: false,
    code: 'native_response_too_large',
  });
  expect(calls).toBe(1);
});

test('Shell settings IPC checks sender and generation without projecting conversation state', async () => {
  const auth = authority();
  const caller = new NativeCaller(client(), () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    const state = spyOn(caller, 'state');
    let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>;
    let window: BrowserWindow | undefined = auth.window;
    let replaceOnAdmission = false;
    const requests: (NativeShellPreference | undefined)[] = [];
    const unregister = registerNativeIpc({
      ipcMain: {
        handle(_channel: string, value: typeof handler) {
          handler = value;
        },
        removeHandler() {},
      } as unknown as IpcMain,
      window: () => window,
      rendererUrl: auth.frame.url,
      async caller() {
        if (replaceOnAdmission) window = authority().window;
        return caller;
      },
      async desktopShell(host, preference) {
        expect(host).toBe(caller);
        requests.push(preference);
        return {
          kind: 'settings.general.shell',
          storeId: 'store',
          preference: preference ?? 'auto',
          automatic: 'git-bash',
          gitBashAvailable: true,
          powerShellAvailable: true,
        };
      },
    });
    try {
      const read = { method: 'settings.general.shell.read', generation };
      const save = { method: 'settings.general.shell.save', generation, preference: 'powershell' };
      expect(await handler(auth.event, read)).toMatchObject({
        ok: true,
        value: { storeId: 'store', preference: 'auto' },
      });
      expect(await handler(auth.event, save)).toMatchObject({
        ok: true,
        value: { storeId: 'store', preference: 'powershell' },
      });
      expect(await handler(auth.event, { ...save, generation: generation + 1 })).toEqual({
        ok: false,
        code: 'native_generation_changed',
      });
      replaceOnAdmission = true;
      expect(await handler(auth.event, save)).toEqual({ ok: false, code: 'native_sender_denied' });
      expect(requests).toEqual([undefined, 'powershell']);
      expect(state).not.toHaveBeenCalled();
    } finally {
      unregister();
      state.mockRestore();
    }
  } finally {
    await caller.close();
  }
});

test('main-private drafts require exact selection/revision; detached or late generations cannot rebind; network disposal is not owned shutdown', async () => {
  const port = client(),
    events: number[] = [],
    caller = new NativeCaller(
      port,
      (event) => {
        if (event.kind === 'changed') events.push(event.generation);
      },
      memoryPrivateData(),
    );
  try {
    const first = await caller.invoke({ method: 'attach' });
    const generation = (first as { generation: number }).generation;
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    expect(
      await caller.invoke({
        method: 'draft.write',
        generation,
        sessionId: 's',
        content: 'private body',
        revision: 0,
      }),
    ).toMatchObject({ content: 'private body', revision: 1 });
    expect(
      await code(
        caller.invoke({
          method: 'draft.write',
          generation,
          sessionId: 's',
          content: 'overwrite',
          revision: 0,
        }),
      ),
    ).toBe('draft_revision_conflict');
    await caller.invoke({ method: 'select', generation, sessionId: 'other' });
    expect(await code(caller.invoke({ method: 'draft.read', generation, sessionId: 's' }))).toBe(
      'native_selection_changed',
    );
    expect(JSON.stringify(caller.state())).not.toContain('private body');
    caller.detach();
    expect(await code(caller.invoke({ method: 'state', generation }))).toBe(
      'native_generation_changed',
    );
    const next = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation: next.generation, sessionId: 's' });
    expect(
      await caller.invoke({ method: 'draft.read', generation: next.generation, sessionId: 's' }),
    ).toMatchObject({ content: 'private body', revision: 1 });
    await caller.disposeNetwork();
    expect(port.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

for (const detach of [false, true])
  test(`Renderer reattachment rebuilds the original selection with fresh reads (${detach ? 'document reload' : 'effect restart'})`, async () => {
    const port = client(),
      caller = new NativeCaller(port, () => {}),
      originalRead = port.getView.bind(port);
    let reads = 0,
      release!: () => void,
      entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
    port.getView = async (...args) => {
      reads++;
      if (reads === 2) {
        entered();
        await gate;
      }
      return originalRead(...args);
    };
    try {
      const first = (await caller.invoke({ method: 'attach' })) as NativeState;
      await caller.invoke({ method: 'select', generation: first.generation, sessionId: 's' });
      expect(reads).toBe(1);
      if (detach) caller.detach();
      const attaching = caller.invoke({ method: 'attach' });
      await reading;
      expect(caller.state().generation).toBeGreaterThan(first.generation);
      expect(caller.state().selection).toBeUndefined();
      expect(await code(caller.invoke({ method: 'state', generation: first.generation }))).toBe(
        'native_generation_changed',
      );
      release();
      const next = (await attaching) as NativeState;
      expect(next.selection?.session.id).toBe('s');
      expect(next.selection?.permissionUnavailable).toBe(false);
      expect(reads).toBe(2);
      expect(port.writes).toBe(0);
    } finally {
      release();
      await caller.close();
    }
  });

test('replacement Callers sharing one Main cannot reuse an old Renderer generation', async () => {
  const nextGeneration = createNativeCallerGenerationOwner(),
    first = new NativeCaller(
      client(),
      () => {},
      undefined,
      [],
      undefined,
      undefined,
      nextGeneration,
    ),
    second = new NativeCaller(
      client(),
      () => {},
      undefined,
      [],
      undefined,
      undefined,
      nextGeneration,
    );
  try {
    const old = (await first.invoke({ method: 'attach' })) as NativeState;
    first.detach();
    const fresh = (await second.invoke({ method: 'attach' })) as NativeState;
    expect(fresh.generation).toBeGreaterThan(first.state().generation);
    expect(fresh.generation).toBeGreaterThan(old.generation);
    expect(await code(second.invoke({ method: 'state', generation: old.generation }))).toBe(
      'native_generation_changed',
    );
    expect(await code(second.invoke({ method: 'detach', generation: old.generation }))).toBe(
      'native_generation_changed',
    );
    expect(second.state().generation).toBe(fresh.generation);
    expect(await second.invoke({ method: 'state', generation: fresh.generation })).toMatchObject({
      generation: fresh.generation,
    });
  } finally {
    await first.close();
    await second.close();
  }
});

test('reattachment drops a confirmed missing conversation and keeps other fresh-read failures unavailable', async () => {
  for (const failure of ['session_not_found', 'controlled_view_unavailable']) {
    const port = client(),
      caller = new NativeCaller(port, () => {});
    try {
      const first = (await caller.invoke({ method: 'attach' })) as NativeState;
      await caller.invoke({ method: 'select', generation: first.generation, sessionId: 's' });
      caller.detach();
      port.getView = async () => {
        throw new ClientError(failure);
      };
      if (failure === 'session_not_found') {
        const next = (await caller.invoke({ method: 'attach' })) as NativeState;
        expect(next.selection).toBeUndefined();
        // The absent candidate is not retried indefinitely on later attachments.
        expect((await caller.invoke({ method: 'attach' })) as NativeState).toMatchObject({
          selection: undefined,
        });
      } else {
        expect(await code(caller.invoke({ method: 'attach' }))).toBe(failure);
        expect(caller.state().selection).toBeUndefined();
      }
      expect(port.writes).toBe(0);
    } finally {
      await caller.close();
    }
  }
});

test('a replacement Caller accepts a display hint only after matching the fresh Store identity', async () => {
  for (const storeId of ['store', 'foreign-store']) {
    const port = client();
    let reads = 0;
    const getView = port.getView.bind(port);
    port.getView = async (...args) => {
      reads++;
      return getView(...args);
    };
    const caller = new NativeCaller(
      port,
      () => {},
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      { storeId, sessionId: 's' },
    );
    try {
      const attached = (await caller.invoke({ method: 'attach' })) as NativeState;
      expect(attached.selection?.session.id).toBe(storeId === 'store' ? 's' : undefined);
      expect(reads).toBe(storeId === 'store' ? 1 : 0);
      expect(port.writes).toBe(0);
    } finally {
      await caller.close();
    }
  }
});

test('a detached selection cannot bind to the same session ID after the Store changes', async () => {
  const port = client(),
    caller = new NativeCaller(port, () => {});
  try {
    const first = (await caller.invoke({ method: 'attach' })) as NativeState;
    await caller.invoke({ method: 'select', generation: first.generation, sessionId: 's' });
    caller.detach();
    await caller.disposeNetwork();
    port.connect = async () => {
      port.serverInfo!.storeId = 'replacement-store';
      return port.serverInfo!;
    };
    let reads = 0;
    port.getView = async () => {
      reads++;
      throw Error('old_selection_must_not_be_read_in_replacement_store');
    };
    expect((await caller.invoke({ method: 'attach' })) as NativeState).toMatchObject({
      selection: undefined,
    });
    expect(reads).toBe(0);
    expect(port.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('an unknown original input survives a view switch; lookup and same-ID retry cannot rebind or issue a second mutation', async () => {
  const port = client();
  let dispatched = 0;
  const queried: string[] = [];
  port.startRun = async () => {
    dispatched++;
    throw new Error('controlled_response_lost');
  };
  port.getCommand = async (commandId) => {
    queried.push(commandId);
    return {
      id: commandId,
      sessionId: 's',
      originStoreId: 'store',
      kind: 'run.start',
      subjectId: 'local-user',
      requestDigest: callerTextDigest(
        canonicalCallerCommandRequest({
          kind: 'run.start',
          expectedStoreId: 'store',
          commandId: 'original',
          content: 'exact body',
        }),
      ),
      status: 'accepted',
      receipt: null,
    } as Awaited<ReturnType<AgentClient['getCommand']>>;
  };
  const data = memoryPrivateData();
  const caller = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    const intent = {
      kind: 'run.start' as const,
      expectedStoreId: 'store',
      commandId: 'original',
      content: 'exact body',
    };
    const first = await caller.invoke({ method: 'submit', generation, sessionId: 's', intent });
    expect(first).toMatchObject({
      phase: 'unknown',
      sessionId: 's',
      intent: {
        kind: intent.kind,
        expectedStoreId: intent.expectedStoreId,
        commandId: intent.commandId,
      },
    });
    expect(data.callers()[0]!.intent.request).toEqual(intent);
    expect(JSON.stringify(caller.state())).not.toContain('exact body');
    await caller.invoke({ method: 'select', generation, sessionId: 'other' });
    const reconciled = await caller.invoke({
      method: 'lookupInput',
      generation,
      commandId: 'original',
    });
    expect(reconciled).toMatchObject({
      phase: 'accepted',
      sessionId: 's',
      intent: {
        kind: intent.kind,
        expectedStoreId: intent.expectedStoreId,
        commandId: intent.commandId,
      },
    });
    expect(queried).toEqual(['original']);
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    expect(
      await caller.invoke({ method: 'submit', generation, sessionId: 's', intent }),
    ).toMatchObject({ phase: 'accepted' });
    expect(dispatched).toBe(1);
    expect(
      await code(caller.invoke({ method: 'lookupInput', generation, commandId: 'another' })),
    ).toBe('input_intent_missing');
  } finally {
    await caller.close();
  }
});

test('Session creation freezes a durable original intent; unknown and wrong receipts never cause a second POST or overwrite drafts', async () => {
  const port = client(),
    data = memoryPrivateData();
  let posts = 0,
    lookups = 0,
    wrong = false;
  Object.assign(port, {
    async createSession() {
      posts++;
      throw Error('physical response lost');
    },
    async getCommand(id: string) {
      lookups++;
      return {
        id,
        sessionId: wrong ? 'wrong' : 'new',
        kind: 'session.create',
        receipt: { sessionId: 'new' },
        status: 'applied',
        originStoreId: 'store',
      };
    },
  });
  const caller = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    await caller.invoke({
      method: 'draft.write',
      generation,
      sessionId: 's',
      revision: 0,
      content: 'retained',
    });
    const intent = {
      method: 'createSession' as const,
      generation,
      workspaceId: 'w',
      expectedStoreId: 'store',
      commandId: 'original-create',
      sessionId: 'new',
      title: 'new',
    };
    expect(await caller.invoke(intent)).toMatchObject({ phase: 'unknown' });
    await caller.invoke({ method: 'select', generation, sessionId: 'other' });
    expect(await caller.invoke(intent)).toMatchObject({ phase: 'unknown' });
    expect(posts).toBe(1);
    expect(await code(caller.invoke({ ...intent, sessionId: 'wrong' }))).toBe(
      'creation_intent_conflict',
    );
    wrong = true;
    expect(
      await code(
        caller.invoke({ method: 'lookupCreation', generation, commandId: intent.commandId }),
      ),
    ).toBe('creation_identity_mismatch');
    expect(caller.state().creationSubmissions[0]!.phase).toBe('unknown');
    wrong = false;
    expect(
      await caller.invoke({ method: 'lookupCreation', generation, commandId: intent.commandId }),
    ).toMatchObject({ phase: 'created' });
    expect(posts).toBe(1);
    expect(lookups).toBe(2);
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    expect(await caller.invoke({ method: 'draft.read', generation, sessionId: 's' })).toMatchObject(
      { content: 'retained', revision: 1 },
    );
  } finally {
    await caller.close();
  }
});

test('old Store and deleted Session draft associations preserve original text without rebinding; missing private storage is local', async () => {
  const port = client(),
    data = memoryPrivateData();
  const old = data.save(
    { storeId: 'older-store', workspaceId: 'old-workspace', rootSessionId: 'old-session' },
    0,
    'old original',
  );
  const deleted = data.save(
    { storeId: 'store', workspaceId: 'w', rootSessionId: 'gone' },
    0,
    'deleted original',
  );
  const readView = port.getView.bind(port);
  Object.assign(port, {
    async getView(id: string) {
      if (id === 'gone') throw Error('session missing');
      return readView(id);
    },
  });
  const caller = new NativeCaller(port, () => {}, data),
    unavailable = new NativeCaller(client(), () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    expect(
      await caller.invoke({ method: 'draft.original', generation, draftId: old.id }),
    ).toMatchObject({
      association: 'unavailable',
      content: 'old original',
      storeId: 'older-store',
    });
    expect(
      await caller.invoke({ method: 'draft.original', generation, draftId: deleted.id }),
    ).toMatchObject({
      association: 'unavailable',
      content: 'deleted original',
      rootSessionId: 'gone',
    });
    expect(await caller.invoke({ method: 'draft.read', generation, sessionId: 's' })).toMatchObject(
      { content: '', revision: 0 },
    );
    const attached = (await unavailable.invoke({ method: 'attach' })) as { generation: number };
    await unavailable.invoke({ method: 'select', generation: attached.generation, sessionId: 's' });
    expect(
      await code(
        unavailable.invoke({
          method: 'draft.read',
          generation: attached.generation,
          sessionId: 's',
        }),
      ),
    ).toBe('draft_storage_unavailable');
    expect(
      (
        (await unavailable.invoke({ method: 'state', generation: attached.generation })) as {
          selection: unknown;
        }
      ).selection,
    ).toBeDefined();
  } finally {
    await caller.close();
    await unavailable.close();
  }
});

test('main shutdown and directory exhaust admitted SDK pages: activity beyond 200 is observed, query failure is not idle', async () => {
  const port = client();
  let reads = 0;
  const view = port.getView.bind(port);
  Object.assign(port, {
    async listAllSessions() {
      return Array.from({ length: 205 }, (_, i) => ({ id: `session-${i}` }));
    },
    async listAllWorkspaces() {
      return Array.from({ length: 205 }, (_, i) => ({ id: `workspace-${i}` }));
    },
    async getView(id: string) {
      reads++;
      const value = await view(id);
      return { ...value, runs: id === 'session-204' ? [{ isActive: true }] : [] };
    },
    async listSessions() {
      throw Error('legacy first page forbidden');
    },
    async listWorkspaces() {
      throw Error('legacy first page forbidden');
    },
  });
  const caller = new NativeCaller(port, () => {}, memoryPrivateData());
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    const directory = (await caller.invoke({ method: 'directory', generation })) as {
      sessions: unknown[];
      workspaces: unknown[];
    };
    expect(directory.sessions.length).toBe(205);
    expect(directory.workspaces.length).toBe(205);
    expect(await caller.hasActiveWork()).toBe(true);
    expect(reads).toBe(205);
    Object.assign(port, {
      async listAllSessions() {
        throw Error('query unavailable');
      },
    });
    expect(await code(caller.hasActiveWork())).toBe('query unavailable');
  } finally {
    await caller.close();
  }
});

test('global activity refresh follows non-selected changes, retains failed observations, and never blocks selected reading or revives a detached read', async () => {
  const port = client();
  port.serverInfo!.capabilities.push('session_directory_activity');
  let change!: () => void,
    mode = 'ok',
    timestamp = 1000,
    pending = 1;
  let heldSignal: AbortSignal | undefined;
  let release!: (value: unknown) => void;
  const views: string[] = [];
  const original = port.getView.bind(port);
  Object.assign(port, {
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      change = () => {
        void options.onChange?.(sessionChange('other-session'));
      };
      await options.onReady?.({ storeId: 'store', replayFloor: '0', highWaterCursor: '0' });
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async listAllWorkspaces() {
      return [{ id: 'w', name: 'w', rootUri: 'file:///w' }];
    },
    async listAllSessionDirectory(options: { signal: AbortSignal }) {
      if (mode === 'fail') throw Error('activity unavailable');
      const entries = Array.from({ length: 205 }, (_, index) => ({
        seq: String(index + 1),
        session: {
          id: `s-${index}`,
          workspaceId: 'w',
          rootSessionId: `s-${index}`,
          parentSessionId: null,
          title: 'same name',
          controlRevision: '0',
          contextSelectionId: 'selection',
          nextSeq: '0',
          deletedAt: null,
        },
        activity: {
          updatedAt: timestamp,
          queued: false,
          pendingInteractions: index === 204 ? pending : 0,
          run:
            index === 204
              ? {
                  id: 'actual-run',
                  status: pending ? 'waiting_interaction' : 'completed',
                  isActive: !!pending,
                }
              : null,
        },
      }));
      if (mode === 'hold') {
        heldSignal = options.signal;
        return await new Promise((resolve) => {
          release = resolve;
        });
      }
      return entries;
    },
    async getView(id: string) {
      views.push(id);
      return original(id);
    },
    async listAllSessions() {
      throw Error('identity-only directory forbidden');
    },
  });
  const caller = new NativeCaller(port, () => {}, memoryPrivateData());
  const wait = async (accept: (value: NativeState) => boolean) => {
    for (let i = 0; i < 100 && !accept(caller.state()); i++) await Bun.sleep(1);
    expect(accept(caller.state())).toBe(true);
  };
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await wait((state) => state.directory?.sessions.length === 205);
    await caller.invoke({ method: 'select', generation, sessionId: 's-0' });
    expect(caller.state().directory!.sessions[204]!.activity).toMatchObject({
      pendingInteractions: 1,
      run: { id: 'actual-run', status: 'waiting_interaction' },
    });
    timestamp = 2000;
    pending = 0;
    change();
    await wait((state) => state.directory?.sessions[204]?.activity?.updatedAt === 2000);
    expect(caller.state().selection?.session.id).toBe('s-0');
    expect(caller.state().directory!.sessions[204]!.activity?.pendingInteractions).toBe(0);
    expect(views.every((id) => id === 's-0')).toBe(true);
    mode = 'fail';
    change();
    await wait((state) => state.directory?.unavailable === true);
    expect(caller.state().directory!.sessions).toHaveLength(205);
    expect(caller.state().directory!.sessions[204]!.activity?.updatedAt).toBe(2000);
    mode = 'hold';
    change();
    for (let i = 0; i < 100 && !heldSignal; i++) await Bun.sleep(1);
    expect(heldSignal).toBeDefined();
    await caller.invoke({ method: 'select', generation, sessionId: 's-1' });
    expect(
      ((await caller.invoke({ method: 'state', generation })) as NativeState).selection?.session.id,
    ).toBe('s-1');
    await caller.invoke({ method: 'detach', generation });
    expect(heldSignal!.aborted).toBe(true);
    release([]);
    await Bun.sleep(2);
    expect(caller.state().directory).toBeUndefined();
    expect(port.writes).toBe(0);
  } finally {
    release?.([]);
    await caller.close();
  }
});

test('cold observer reset invalidates the old directory read explicitly and publishes the new observation without effects', async () => {
  const port = client();
  let reset!: () => void,
    reads = 0,
    held: AbortSignal | undefined;
  Object.assign(port, {
    async observe(options: Parameters<AgentClient['observe']>[0]) {
      await options.onReady?.({ storeId: 'store', replayFloor: '0', highWaterCursor: '0' });
      await new Promise<void>((resolve) => {
        reset = () => {
          void options.onReset?.({} as never);
          resolve();
        };
        options.signal!.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    async listWorkspaceDirectory() {
      return { snapshotCursor: '10' };
    },
    async listAllWorkspaces(options: { signal: AbortSignal }) {
      if (++reads === 1) {
        held = options.signal;
        await new Promise<void>((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          }),
        );
      }
      return [{ id: 'w', name: 'Restored project', rootUri: 'file:///w' }];
    },
  });
  const caller = new NativeCaller(port, () => {}, memoryPrivateData());
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    const reading = code(caller.invoke({ method: 'directory', generation }));
    for (let i = 0; i < 100 && !held; i++) await Bun.sleep(1);
    expect(held).toBeDefined();
    // invoke first drains Main refresh; allow it to join the existing held GET before reset.
    await Bun.sleep(1);
    reset();
    expect(await reading).toBe('directory_observation_changed');
    expect(held!.aborted).toBe(true);
    for (let i = 0; i < 100 && caller.state().directory?.unavailable !== false; i++)
      await Bun.sleep(5);
    expect(caller.state().directory).toMatchObject({
      unavailable: false,
      workspaces: [{ id: 'w', name: 'Restored project' }],
    });
    expect(port.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('same creation command shares one in-flight POST across view switches; cold pending intent only queries', async () => {
  const port = client(),
    data = memoryPrivateData();
  let posts = 0,
    release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  Object.assign(port, {
    async createSession() {
      posts++;
      await barrier;
      throw Error('lost response');
    },
  });
  const caller = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as { generation: number };
    const intent = {
      method: 'createSession' as const,
      generation,
      workspaceId: 'w',
      expectedStoreId: 'store',
      commandId: 'single',
      sessionId: 'new',
      title: 'new',
    };
    const first = caller.invoke(intent),
      second = caller.invoke(intent);
    await caller.invoke({ method: 'select', generation, sessionId: 'other' });
    expect(posts).toBe(1);
    release();
    expect(await first).toMatchObject({ phase: 'unknown' });
    expect(await second).toMatchObject({ phase: 'unknown' });
    expect(posts).toBe(1);
  } finally {
    release();
    await caller.close();
  }
  data.begin({
    expectedStoreId: 'store',
    workspaceId: 'w',
    commandId: 'cold',
    sessionId: 'cold-session',
    title: 'new',
  });
  const cold = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await cold.invoke({ method: 'attach' })) as { generation: number };
    expect(
      cold.state().creationSubmissions.find((value) => value.input.commandId === 'cold')!.phase,
    ).toBe('unknown');
    expect(
      await cold.invoke({
        method: 'createSession',
        generation,
        expectedStoreId: 'store',
        workspaceId: 'w',
        commandId: 'cold',
        sessionId: 'cold-session',
        title: 'new',
      }),
    ).toMatchObject({ phase: 'unknown' });
    expect(posts).toBe(1);
  } finally {
    await cold.close();
  }
});

test('Native caller serializes a waiting scheduled save before provider removal and rechecks the new reference', async () => {
  const { ScheduledTaskRunner } = await import('../electron/scheduled-task-runner');
  const data = memoryPrivateData();
  const connectionId = 'e'.repeat(64);
  let release!: () => void,
    entered!: () => void,
    writes = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const port = client();
  Object.assign(port, {
    listAllWorkspaces: async () => [{ id: 'w' }],
    getProviderSettings: async () => ({
      storeId: 'store',
      errors: [],
      readSet: {
        userEtag: 'a'.repeat(64),
        workspaceEtag: null,
        explicitDigest: 'b'.repeat(64),
        effectiveDigest: 'c'.repeat(64),
      },
      providers: [
        {
          id: 'ollama',
          label: 'Ollama',
          defaultBaseURL: 'http://localhost:11434/v1',
          requiresCredential: false,
          connections: [
            {
              id: connectionId,
              name: 'Local',
              baseURL: 'http://localhost:11434/v1',
              protocol: 'chat-completions',
              hasCredential: false,
              modelNames: ['local'],
              modelIds: ['local-model'],
              defaultModelIds: [],
              canWrite: true,
            },
          ],
        },
      ],
    }),
    getModelSettings: async () => {
      entered();
      await gate;
      return { models: [{ id: 'local-model', enabled: true, configured: true }] };
    },
    updateProviderSettings: async () => {
      writes++;
      throw Error('unexpected_delete');
    },
  });
  const caller = new NativeCaller(port, () => {}, data);
  caller.setScheduledTasks(new ScheduledTaskRunner(port, data));
  try {
    const state = (await caller.invoke({ method: 'attach' })) as NativeState;
    const facts = await caller.invoke({
      method: 'settings.providers.read',
      generation: state.generation,
    });
    if (!facts || !('observationId' in facts)) throw Error('missing_provider_facts');
    const save = caller.invoke({
      method: 'scheduled.save',
      operation: 'create',
      generation: state.generation,
      input: {
        name: 'Race task',
        storeId: 'store',
        workspaceId: 'w',
        modelId: 'local-model',
        prompt: 'test-only',
        enabled: false,
        schedule: { frequency: 'daily', time: '09:00' },
      },
    });
    await ready;
    const remove = caller.invoke({
      method: 'settings.providers.save',
      generation: state.generation,
      observationId: facts.observationId,
      operation: {
        kind: 'remove',
        provider: 'ollama',
        connectionId,
        baseURL: 'http://localhost:11434/v1',
        modelNames: [],
        credential: 'none',
      },
    });
    const checked = remove.then(
      () => null,
      (error: unknown) => error,
    );
    expect(writes).toBe(0);
    release();
    await save;
    expect(await checked).toMatchObject({ code: 'provider_scheduled_model_in_use' });
    expect(data.scheduledTasks()).toHaveLength(1);
    expect(writes).toBe(0);
  } finally {
    release();
    await caller.close();
  }
});

test('Native caller orders confirmed deletion after earlier scheduled save or enable validation', async () => {
  const { ScheduledTaskRunner } = await import('../electron/scheduled-task-runner');
  for (const operation of ['save', 'enable'] as const) {
    const data = memoryPrivateData(),
      port = client();
    const task = data.saveScheduledTask({
      name: 'Original',
      storeId: 'store',
      workspaceId: 'w',
      modelId: 'fixed',
      prompt: 'Instructions',
      enabled: operation === 'save',
      schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
    });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    Object.assign(port, {
      listAllWorkspaces: async () => [{ id: 'w' }],
      getModelSettings: async () => {
        entered();
        await gate;
        return { models: [{ id: 'fixed', enabled: true, configured: true }] };
      },
    });
    const caller = new NativeCaller(port, () => {}, data);
    caller.setScheduledTasks(new ScheduledTaskRunner(port, data));
    try {
      const state = (await caller.invoke({ method: 'attach' })) as NativeState;
      const {
        nextRunAt: _next,
        createdAt: _created,
        updatedAt: _updated,
        schedule,
        ...fields
      } = task;
      const { timeZone: _zone, ...wallClock } = schedule;
      const input = { ...fields, schedule: wallClock };
      const saving = caller.invoke(
        operation === 'save'
          ? {
              method: 'scheduled.save',
              operation: 'update',
              generation: state.generation,
              input: { ...input, prompt: 'Earlier edit' },
            }
          : {
              method: 'scheduled.toggle',
              generation: state.generation,
              id: task.id,
              enabled: true,
            },
      );
      await ready;
      let deleted = false;
      const removing = caller
        .invoke({ method: 'scheduled.delete', generation: state.generation, id: task.id })
        .then((value) => {
          deleted = true;
          return value;
        });
      await Promise.resolve();
      expect(deleted).toBe(false);
      release();
      await saving;
      await removing;
      expect(data.scheduledTasks()).toHaveLength(0);
      await expect(
        caller.invoke({
          method: 'scheduled.save',
          operation: 'update',
          generation: state.generation,
          input,
        }),
      ).rejects.toThrow('scheduled_task_not_found');
      expect(data.scheduledTasks()).toHaveLength(0);
    } finally {
      release();
      await caller.close();
    }
  }
});

test('global observation routes foreign metadata away from the selected View while retaining directory, descendant environment and read admission', async () => {
  const connection = client();
  connection.serverInfo!.capabilities.push('sessions');
  connection.verifyConnection = async () => connection.serverInfo!;
  const item = backgroundItem(1, true);
  item.rootSession = { ...item.rootSession, id: 's1', rootSessionId: 's1' };
  item.session = item.rootSession;
  item.execution = { ...item.execution, sessionId: 's1', rootSessionId: 's1' };
  item.childSession = { ...item.childSession!, parentSessionId: 's1', rootSessionId: 's1' };
  connection.listAllBackgroundExecutions = async () => [structuredClone(item)];
  let emit!: (sessionId: string) => Promise<void>, reset!: () => void;
  let acknowledged = 0,
    directories = 0,
    selectedReads = 0,
    hold = false;
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // This SDK fixture acknowledges after the Main callback returns, matching the
  // actual Client contract without asserting HTTP/SSE decoder behavior here.
  Object.defineProperty(connection, 'lastAppliedCursor', {
    get: () => (acknowledged ? { storeId: 'store', sequence: String(acknowledged) } : undefined),
  });
  connection.observe = async (options) => {
    emit = async (sessionId) => {
      await options.onChange({
        cursor: String(acknowledged + 1),
        sessionId,
        objectId: 'message',
        type: 'message.updated',
        revision: '1',
        payload: null,
      } as never);
      acknowledged++;
    };
    reset = () => {
      void options.onReset?.({} as never);
    };
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  connection.listAllWorkspaces = async () => {
    directories++;
    return [];
  };
  const getView = connection.getView.bind(connection);
  connection.getView = async (id) => {
    if (id === 's1') {
      selectedReads++;
      if (hold) {
        entered();
        await gate;
        throw Error('selected_metadata_unavailable');
      }
    }
    return getView(id);
  };
  const caller = new NativeCaller(connection, () => {});
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's1' });
    await caller.invoke({ method: 'directory', generation: 1 });
    const observed = (await caller.invoke({
      method: 'background.open',
      generation: 1,
      surface: 'environment',
      readId: 'known-descendant',
    })) as NativeBackgroundPage;
    await caller.invoke({
      method: 'background.close',
      generation: 1,
      surface: 'environment',
      readId: observed.readId,
    });
    const readsBefore = selectedReads,
      directoryBefore = directories;
    const before = caller.state();
    for (let index = 0; index < 100; index++) await emit(index % 2 ? 'other-root' : 'other-child');
    await Bun.sleep(150);
    expect(selectedReads).toBe(readsBefore);
    expect(caller.state().selection!.viewGeneration).toBe(before.selection!.viewGeneration);
    expect(caller.state().environmentRevision).toBe(before.environmentRevision! + 100);
    expect(caller.state().selectedEnvironmentRevision).toBe(before.selectedEnvironmentRevision);
    expect(directories).toBeGreaterThan(directoryBefore);
    expect(connection.lastAppliedCursor).toEqual({ storeId: 'store', sequence: '100' });
    await emit('child');
    expect(caller.state().selectedEnvironmentRevision).toBe(
      before.selectedEnvironmentRevision! + 1,
    );
    expect(selectedReads).toBe(readsBefore);
    hold = true;
    await emit('s1');
    await held;
    const during = caller.state();
    expect(during.selectedEnvironmentRevision).toBe(before.selectedEnvironmentRevision! + 2);
    expect(during.selection!.permissionUnavailable).toBe(true);
    expect(during.environmentReadUnavailable).toBe(false);
    release();
    await caller.invoke({ method: 'state', generation: 1 });
    await waitForCallerState(caller, (state) => state.environmentReadUnavailable === true);
    expect(caller.state().environmentReadUnavailable).toBe(true);
    expect(caller.state().selection!.permissionUnavailable).toBe(true);
    reset();
    expect(caller.state().environmentReadUnavailable).toBe(true);
    expect(caller.state().historyEpoch).toBe(before.historyEpoch! + 1);
    expect(connection.lastAppliedCursor).toEqual({ storeId: 'store', sequence: '102' });
    expect(connection.writes).toBe(0);
  } finally {
    release();
    await caller.close();
  }
});

test('Native close drains an in-flight scheduled save before releasing private data ownership', async () => {
  const { ScheduledTaskRunner } = await import('../electron/scheduled-task-runner');
  const data = memoryPrivateData(),
    port = client();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  Object.assign(port, {
    listAllWorkspaces: async () => [{ id: 'w' }],
    getModelSettings: async () => {
      entered();
      await gate;
      return { models: [{ id: 'fixed', enabled: true, configured: true }] };
    },
  });
  const caller = new NativeCaller(port, () => {}, data);
  caller.setScheduledTasks(new ScheduledTaskRunner(port, data));
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    const saving = caller
      .invoke({
        method: 'scheduled.save',
        operation: 'create',
        generation,
        input: {
          id: 'new-task',
          name: 'New',
          storeId: 'store',
          workspaceId: 'w',
          modelId: 'fixed',
          prompt: 'Test',
          enabled: false,
          schedule: { frequency: 'daily', time: '09:00' },
        },
      })
      .catch((cause: unknown) => cause);
    await ready;
    let closed = false;
    const closing = caller.close().then(() => {
      closed = true;
    });
    await Bun.sleep(0);
    expect(closed).toBe(false);
    expect(data.scheduledTasks()).toHaveLength(0);
    release();
    await saving;
    await closing;
    expect(closed).toBe(true);
    expect(data.scheduledTasks()).toHaveLength(1);
    const settled = JSON.stringify(data.scheduledTasks());
    await Bun.sleep(0);
    expect(JSON.stringify(data.scheduledTasks())).toBe(settled);
  } finally {
    release();
    await caller.close();
  }
});

test('Native state forwards current compression progress from the public View and never persists a missing progress as completion', async () => {
  const connection = client();
  const getView = connection.getView.bind(connection);
  connection.getView = async (id) => ({
    ...(await getView(id)),
    compressionProgress: { runId: 'compressing-run', originStoreId: 'store', phase: 'summarizing' },
  });
  const caller = new NativeCaller(connection, () => {}, memoryPrivateData());
  try {
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'compression-session' });
    expect(caller.state().selection?.compressionProgress).toEqual({
      runId: 'compressing-run',
      originStoreId: 'store',
      phase: 'summarizing',
    });
    connection.getView = async () => {
      throw Error('compression_view_unavailable');
    };
    await expect(caller.invoke({ method: 'permission.refresh', generation: 1 })).rejects.toThrow(
      'compression_view_unavailable',
    );
    expect(caller.state().selection?.compressionProgress).toBeUndefined();
    connection.getView = getView;
    await caller.invoke({ method: 'select', generation: 1, sessionId: 'cold-session' });
    expect(caller.state().selection?.compressionProgress).toBeUndefined();
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('retrying an original Native activation after a lost reconciliation response reads without another POST', async () => {
  expect(
    decodeNativeRequest({ method: 'select', generation: 1, sessionId: 's', activationId: 1 }),
  ).toMatchObject({ activationId: 1 });
  expect(() =>
    decodeNativeRequest({ method: 'select', generation: 1, sessionId: 's', activationId: -1 }),
  ).toThrow('invalid_native_request');
  const identity: ServerInfo = {
    profile: { dataRoot: '/chosen/data', name: 'native', accessKey: 'native-profile' },
    instanceId: 'native-instance',
    buildId: 'native-build',
    apiMajor: 1,
    capabilities: ['events', 'sessions', 'commands', 'session_reconciliation'],
    dataAvailability: 'available',
    storeId: 'store',
  };
  let posts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/server') return Response.json(identity);
      if (request.method === 'POST' && path.endsWith('/reconcile')) {
        posts++;
        return Response.json(
          { code: 'service_unavailable', message: 'lost original response' },
          { status: 503 },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const connection = createClient({
    endpoint: server.url.href,
    token: 'native-token',
    bootstrap: identity,
    expected: {
      profile: identity.profile,
      instanceId: identity.instanceId,
      buildId: identity.buildId,
      apiMajor: 1,
      requiredCapabilities: ['sessions'],
    },
  });
  const original = client();
  connection.getView = async (id) => {
    const view = await original.getView(id);
    return { ...view, session: { ...view.session, ownerGeneration: '0' } };
  };
  connection.observe = original.observe;
  await connection.connect();
  const caller = new NativeCaller(connection, () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await expect(
      caller.invoke({ method: 'select', generation, sessionId: 's', activationId: 1 }),
    ).rejects.toThrow();
    expect(posts).toBe(1);
    const before = caller.state().selection?.viewSelection;
    const refreshed = (await caller.invoke({
      method: 'select',
      generation,
      sessionId: 's',
      activationId: 1,
    })) as NativeState;
    expect(refreshed.selection?.session.id).toBe('s');
    expect(refreshed.selection?.viewSelection).toBe(before);
    expect(posts).toBe(1);
    await expect(
      caller.invoke({ method: 'select', generation, sessionId: 'other', activationId: 1 }),
    ).rejects.toMatchObject({ code: 'native_selection_changed' });
    expect(posts).toBe(1);
  } finally {
    await caller.close();
    server.stop(true);
  }
});

test('a held original activation read cannot clear a later Session permission failure', async () => {
  const port = client();
  port.serverInfo!.capabilities.push('session_reconciliation');
  const getView = port.getView.bind(port);
  let hold = false,
    entered!: () => void,
    release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  port.reconcileSessionState = async (id) => {
    if (id === 'later') throw Error('later_reconciliation_unavailable');
    return getView(id);
  };
  port.getView = async (id) => {
    if (id === 'original' && hold) {
      entered();
      await gate;
    }
    return getView(id);
  };
  const caller = new NativeCaller(port, () => {});
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await caller.invoke({ method: 'select', generation, sessionId: 'original', activationId: 1 });
    hold = true;
    const pending = caller.invoke({
      method: 'select',
      generation,
      sessionId: 'original',
      activationId: 1,
    });
    const rejected = pending.then(
      () => undefined,
      (cause) => cause,
    );
    await started;
    await expect(
      caller.invoke({ method: 'select', generation, sessionId: 'later', activationId: 2 }),
    ).rejects.toThrow('later_reconciliation_unavailable');
    expect(caller.state().selection?.permissionUnavailable).toBe(true);
    release();
    expect(await rejected).toMatchObject({ code: 'native_selection_changed' });
    expect(caller.state().selection?.session.id).toBe('later');
    expect(caller.state().selection?.permissionUnavailable).toBe(true);
  } finally {
    release();
    await caller.close();
  }
});

test('only a first steer POST explicitly refusing a stopped target rejects its durable caller identity', async () => {
  const cases = [
    {
      kind: 'input.steer',
      code: 'input_target_stopped',
      status: 409,
      cold: false,
      expected: 'rejected',
    },
    {
      kind: 'input.steer',
      code: 'input_target_stopped',
      status: 500,
      cold: false,
      expected: 'unknown',
    },
    {
      kind: 'input.steer',
      code: 'input_target_stopped',
      status: undefined,
      cold: false,
      expected: 'unknown',
    },
    { kind: 'input.steer', code: 'another_failure', status: 409, cold: false, expected: 'unknown' },
    {
      kind: 'input.follow_up',
      code: 'input_target_stopped',
      status: 409,
      cold: false,
      expected: 'unknown',
    },
    {
      kind: 'input.steer',
      code: 'input_target_stopped',
      status: 404,
      cold: true,
      expected: 'unknown',
    },
  ] as const;
  for (const item of cases) {
    const port = client(),
      data = memoryPrivateData();
    const failure = new ClientError(item.code, item.code, item.status);
    port.getRun = async (id) => ({ id, sessionId: 's', originStoreId: 'store' }) as Run;
    let writes = 0,
      gets = 0;
    port.steer = port.followUp = async () => {
      writes++;
      throw failure;
    };
    port.getCommand = async () => {
      gets++;
      throw failure;
    };
    const journal = new NativeCallerJournal(port, data);
    const intent = {
      kind: item.kind,
      commandId: 'original',
      expectedStoreId: 'store',
      content: 'keep exact body',
      contextSelectionId: 'selection',
      ...(item.kind === 'input.steer' ? { targetRunId: 'run' } : { afterRunId: 'run' }),
    } as CallerCommandRequest;
    await journal.prepare('s', intent);
    const owner = item.cold ? new NativeCallerJournal(port, data) : journal;
    expect(await owner.submit('original').catch((error) => error)).toBe(failure);
    expect(data.callers()[0]!.phase).toBe(item.expected);
    expect(writes).toBe(item.cold ? 0 : 1);
    expect(gets).toBe(item.cold ? 1 : 0);
    expect(data.callers()[0]!.intent.request).toEqual(intent);
  }
});

test('Native stopped-target refusal retains failed input and draft without an unknown caller or invented Command', async () => {
  const port = client(),
    data = memoryPrivateData();
  const readDraft = data.read.bind(data);
  data.read = (scope) => ({ ...readDraft(scope), id: callerTextDigest(JSON.stringify(scope)) });
  const scope = { storeId: 'store', workspaceId: 'w', rootSessionId: 's' };
  const readId = data.readId.bind(data);
  data.readId = (id) =>
    id === callerTextDigest(JSON.stringify(scope)) ? data.read(scope) : readId(id);
  port.getRun = async (id) => ({ id, sessionId: 's', originStoreId: 'store' }) as Run;
  let writes = 0,
    gets = 0;
  port.steer = async () => {
    writes++;
    throw new ClientError('input_target_stopped', 'input_target_stopped', 409);
  };
  port.getCommand = async () => {
    gets++;
    throw new ClientError('command_missing', 'command_missing', 404);
  };
  const caller = new NativeCaller(port, () => {}, data);
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    await caller.invoke({
      method: 'draft.write',
      generation,
      sessionId: 's',
      revision: 0,
      content: 'keep exact body 雪🙂\r\n\n',
    });
    const result = await caller.invoke({
      method: 'submit',
      generation,
      sessionId: 's',
      intent: {
        kind: 'input.steer',
        commandId: 'original',
        expectedStoreId: 'store',
        content: 'keep exact body 雪🙂',
        targetRunId: 'run',
        contextSelectionId: 'selection',
      },
    });
    expect(result).toMatchObject({ phase: 'failed', error: 'input_target_stopped' });
    expect(result && 'command' in result).toBe(false);
    expect(caller.state().callerSubmissions).toEqual([
      expect.objectContaining({
        phase: 'rejected',
        request: expect.objectContaining({ commandId: 'original' }),
      }),
    ]);
    expect(await caller.invoke({ method: 'draft.read', generation, sessionId: 's' })).toMatchObject(
      { content: 'keep exact body 雪🙂\r\n\n', revision: 1 },
    );
    expect(data.callers()[0]?.intent.draft).toMatchObject({
      revision: '1',
      textDigest: callerTextDigest('keep exact body 雪🙂\r\n\n'),
    });
    expect(writes).toBe(1);
    expect(gets).toBe(0);
  } finally {
    await caller.close();
  }
});

test('a stopped-target code during receipt verification GET does not reject an already returned steer', async () => {
  const port = client(),
    data = memoryPrivateData();
  port.getRun = async (id) => ({ id, sessionId: 's', originStoreId: 'store' }) as Run;
  const journal = new NativeCallerJournal(port, data);
  const intent = {
    kind: 'input.steer' as const,
    commandId: 'original',
    expectedStoreId: 'store',
    content: 'keep original',
    targetRunId: 'run',
    contextSelectionId: 'selection',
  };
  await journal.prepare('s', intent);
  const failure = new ClientError('input_target_stopped', 'input_target_stopped', 409);
  port.steer = async () => ({
    id: 'original',
    sessionId: 's',
    originStoreId: 'store',
    kind: 'input.steer',
    subjectId: 'local-user',
    requestDigest: callerTextDigest(canonicalCallerCommandRequest(intent)),
    status: 'accepted',
    cancelRequestedAt: null,
    receipt: null,
  });
  port.getView = async () => {
    throw failure;
  };
  expect(await journal.submit('original').catch((error) => error)).toBe(failure);
  expect(data.callers()[0]!.phase).toBe('unknown');
});

test('Native settings rejects legacy Session/project MCP management before reading a Session or dispatching effects', async () => {
  const connection = client(),
    caller = new NativeCaller(connection, () => {}, memoryPrivateData());
  let reads = 0;
  connection.getView = async () => {
    reads++;
    throw new ClientError('unexpected_session_read');
  };
  try {
    const { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    const requests: NativeRequest[] = [
      { method: 'settings.mcp.read', generation },
      {
        method: 'settings.mcp.submit',
        generation,
        observationId: 1,
        operation: { kind: 'select', serverId: 'project', enabled: true, scope: 'workspace' },
      },
      { method: 'settings.mcp.cancel', generation, commandId: 'old-operation' },
      { method: 'settings.mcp.auth', generation, observationId: 1, serverId: 'project' },
      {
        method: 'settings.mcp.removePreview',
        generation,
        observationId: 1,
        serverId: 'project',
        scope: 'workspace',
      },
    ];
    for (const request of requests) {
      let actual: unknown;
      try {
        await caller.invoke(request);
      } catch (error) {
        actual = error;
      }
      expect((actual as ClientError).code).toBe('mcp_user_scope_required');
    }
    expect(reads).toBe(0);
    expect(connection.writes).toBe(0);
  } finally {
    await caller.close();
  }
});

test('isolated Office submit rejects forged metadata, preserves composer and journals unknown across caller reopen', async () => {
  const port = client(),
    data = memoryPrivateData();
  const target = {
    storeId: 'store',
    sessionId: 's',
    fileId: 'output',
    locator: { kind: 'delivery' as const, key: 'delivery/output' },
  };
  const context = {
    sourceHash: 'a'.repeat(64),
    selection: { kind: 'powerpoint' as const, slide: 1, objectPath: '/shape/1', text: 'Original' },
  };
  const output = {
    id: 'office-input',
    name: 'deck.pptx',
    ownerRunId: 'source-run',
    target,
    context,
  };
  const document = { content: 'Change only this title', outputFiles: [output] };
  const reference = {
    id: 'input-file-office',
    storeId: 'store',
    sessionId: 's',
    subjectId: 'local-user',
    scope: { kind: 'session', id: 's' },
    hash: context.sourceHash,
    size: '8',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  let sends = 0;
  Object.assign(port, {
    resolveOutputFile: async () => ({
      summary: { name: output.name, ownerRunId: output.ownerRunId },
      reference,
    }),
    prepareInputFromOutput: async () => ({
      name: output.name,
      uri: 'file:///original.pptx',
      reference,
    }),
    prepareWorkingInputs: async () => ({}),
    startRun: async () => {
      sends++;
      throw new ClientError('network_error');
    },
    getCommand: async () => {
      throw new ClientError('network_error');
    },
  });
  let caller = new NativeCaller(port, () => {}, data);
  try {
    let { generation } = (await caller.invoke({ method: 'attach' })) as NativeState;
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    await caller.invoke({
      method: 'draft.write',
      generation,
      sessionId: 's',
      revision: 0,
      content: 'Unrelated composer text',
      outputFiles: [{ ...output, id: 'unrelated-composer-attachment' }],
    });
    const before = await caller.invoke({ method: 'draft.read', generation, sessionId: 's' });
    const originalResolve = port.resolveOutputFile;
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let enteredPreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      enteredPreparation = resolve;
    });
    port.resolveOutputFile = async (...args) => {
      enteredPreparation();
      await preparationGate;
      return originalResolve(...args);
    };
    const pendingPreparation = caller.invoke({
      method: 'input.files.fromOutput',
      generation,
      id: 'released-while-pending',
      target,
      context,
    });
    await preparationStarted;
    await caller.invoke({
      method: 'input.files.release',
      generation,
      id: 'released-while-pending',
    });
    releasePreparation();
    await expect(pendingPreparation).rejects.toMatchObject({ code: 'native_file_missing' });
    port.resolveOutputFile = originalResolve;
    // A composer attachment remains live while transient inline staging exceeds
    // the total concurrent budget over its lifetime without exhausting it.
    for (let index = 0; index < 140; index++) {
      const id = `temporary-office-${index}`;
      await caller.invoke({ method: 'input.files.fromOutput', generation, id, target, context });
      await caller.invoke({ method: 'input.files.release', generation, id });
    }
    await caller.invoke({
      method: 'input.files.fromOutput',
      generation,
      id: output.id,
      target,
      context,
    });
    const submit = (officeDocument: typeof document, commandId = 'inline-command') =>
      caller.invoke({
        method: 'submit',
        generation,
        sessionId: 's',
        fileIds: [output.id],
        officeDocument,
        intent: {
          kind: 'run.start',
          commandId,
          expectedStoreId: 'store',
          content: composeBrowserDraft(officeDocument),
        },
      });
    for (const file of [
      { ...output, name: 'forged.pptx' },
      { ...output, context: { ...context, sourceHash: 'b'.repeat(64) } },
      {
        ...output,
        context: { ...context, selection: { ...context.selection, text: 'Forged selection' } },
      },
    ])
      await expect(submit({ ...document, outputFiles: [file] })).rejects.toMatchObject({
        code: 'output_draft_mismatch',
      });
    await expect(
      caller.invoke({
        method: 'submit',
        generation,
        sessionId: 's',
        fileIds: [output.id],
        officeDocument: document,
        intent: {
          kind: 'run.start',
          commandId: 'forged-extra-file',
          expectedStoreId: 'store',
          content: composeBrowserDraft(document),
          files: [
            { name: 'injected.pptx', uri: 'file:///other.pptx', reference: reference as never },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'output_draft_mismatch' });
    expect(sends).toBe(0);
    await submit(document);
    await caller.invoke({ method: 'input.files.release', generation, id: output.id });
    expect(sends).toBe(1);
    expect(data.callers()[0]?.phase).toBe('unknown');
    expect(data.callers()[0]?.intent.draft).toBeUndefined();
    expect(data.callers()[0]?.intent.request).toMatchObject({
      content: composeBrowserDraft(document),
    });
    expect(await caller.invoke({ method: 'draft.read', generation, sessionId: 's' })).toEqual(
      before,
    );
    await caller.close();
    caller = new NativeCaller(port, () => {}, data);
    ({ generation } = (await caller.invoke({ method: 'attach' })) as NativeState);
    await caller.invoke({ method: 'select', generation, sessionId: 's' });
    await expect(submit(document, 'second-command')).rejects.toMatchObject({
      code: 'caller_clear_unconfirmed',
    });
    expect(sends).toBe(1);
    expect(await caller.invoke({ method: 'draft.read', generation, sessionId: 's' })).toEqual(
      before,
    );
  } finally {
    await caller.close();
  }
});
