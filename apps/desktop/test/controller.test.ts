import { expect, test } from 'bun:test';
import type { AgentClient, SessionView } from '@kite-ai/client';
import { createDesktopController } from '../src/controller';

function view(id: string): SessionView {
  return {
    storeId: 'store',
    snapshotCursor: '0',
    session: {
      id,
      workspaceId: 'w',
      parentSessionId: null,
      title: id,
      controlRevision: '1',
      contextSelectionId: 'ctx',
      nextSeq: '0',
      deletedAt: null,
    },
    runs: [],
    messages: [],
    executions: [],
  };
}

test('session activation reconciles before publishing history while ordinary refresh remains read-only', async () => {
  const calls: string[] = [];
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['session_reconciliation'] },
    async reconcileSessionState(id: string) {
      calls.push(`reconcile:${id}`);
      return view(id);
    },
    async getView(id: string) {
      calls.push(`read:${id}`);
      return view(id);
    },
  } as unknown as AgentClient;
  const controller = createDesktopController({
    admittedClient: client,
    onSnapshot(snapshot) {
      calls.push(`publish:${snapshot.sessionId}`);
    },
  });
  await controller.selectSession('root');
  expect(calls).toEqual(['reconcile:root', 'read:root', 'publish:root']);
  calls.length = 0;
  await controller.refreshSession('root');
  expect(calls).toEqual(['read:root', 'publish:root']);
});

test('failed reconciliation retains readable history and reports the failure', async () => {
  const errors: unknown[] = [];
  const failure = Error('session_reconciliation_unavailable');
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['session_reconciliation'] },
    async reconcileSessionState() {
      throw failure;
    },
    async getView(id: string) {
      return view(id);
    },
  } as unknown as AgentClient;
  const controller = createDesktopController({
    admittedClient: client,
    onSnapshot() {},
    onError(error) {
      errors.push(error);
    },
  });
  await expect(controller.selectSession('root')).rejects.toThrow(failure.message);
  expect(controller.snapshot?.sessionId).toBe('root');
  expect(errors).toEqual([failure]);
});

test('a retired activation cannot publish old history after its reconciliation returns late', async () => {
  let release!: () => void;
  const reads: string[] = [];
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['session_reconciliation'] },
    reconcileSessionState(id: string) {
      return id === 'old'
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    },
    async getView(id: string) {
      reads.push(id);
      return view(id);
    },
  } as unknown as AgentClient;
  const controller = createDesktopController({ admittedClient: client, onSnapshot() {} });
  const old = controller.selectSession('old');
  await controller.selectSession('new');
  release();
  await old;
  expect(reads).toEqual(['new']);
  expect(controller.snapshot?.sessionId).toBe('new');
});
test('retired old view cannot enter cache or overwrite new selection; disposal never stops service', async () => {
  let release!: (value: SessionView) => void;
  let stopped = 0;
  let disposed = 0;
  const client = {
    serverInfo: { storeId: 'store' },
    getView(id: string) {
      return id === 'old'
        ? new Promise<SessionView>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(view(id));
    },
    disposeNetwork() {
      disposed++;
    },
  } as unknown as AgentClient;
  const visible: string[] = [];
  const controller = createDesktopController({
    admittedClient: client,
    maxCachedObjects: 4,
    maxCacheBytes: 2048,
    onSnapshot(snapshot) {
      visible.push(snapshot.sessionId);
    },
    async stopPairedService() {
      stopped++;
    },
  });
  const old = controller.selectSession('old');
  await controller.selectSession('new');
  release(view('old'));
  await old;
  expect(controller.snapshot?.sessionId).toBe('new');
  expect(visible).toEqual(['new']);
  expect(controller.cachedObjectCount).toBe(1);
  expect(controller.cachedBytes).toBeLessThanOrEqual(2048);
  controller.disposeNetwork();
  expect(disposed).toBe(1);
  expect(stopped).toBe(0);
  await controller.stopPairedService();
  expect(stopped).toBe(1);
});

test('unknown action receipt retains its original intent for lookup and never rebinds it on selection', async () => {
  const action = {
    actionId: 'external.action',
    definitionVersion: '1',
    label: 'Act',
    input: { original: true },
  };
  const client = {
    serverInfo: { storeId: 'store' },
    async getView(id: string) {
      return view(id);
    },
    async queryExtension() {
      return [
        {
          extensionId: 'external',
          contentType: 'unknown',
          contentVersion: 99,
          summary: 'Result',
          payload: null,
          artifactRefs: [],
          actions: [action],
        },
      ];
    },
    async listExtensions() {
      return [
        {
          extensionId: 'external',
          actions: [{ id: action.actionId, version: '1', inputSchema: {} }],
        },
      ];
    },
    async invokeExtension() {
      throw new Error('receipt lost');
    },
  } as unknown as AgentClient;
  const controller = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await controller.selectSession('original', [
    { extensionId: 'external', queryId: 'read', input: {} },
  ]);
  await expect(controller.invokeAction(action)).rejects.toThrow('receipt lost');
  const saved = controller.lastActionIntent;
  await controller.selectSession('other');
  expect(controller.lastActionIntent).toEqual(saved);
  expect(saved).toMatchObject({
    sessionId: 'original',
    intent: { expectedStoreId: 'store', input: action.input },
  });
  expect(saved?.intent.commandId.length).toBeGreaterThan(0);
});

test('100 rapid selections cancel retired pure GET chains and disposal aborts the last pending refresh', async () => {
  const active = new Set<AbortSignal>(),
    signals: AbortSignal[] = [],
    followup: string[] = [],
    visible: string[] = [],
    errors: unknown[] = [];
  const held = new Map<string, (value: SessionView) => void>();
  const check = (id: string, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    followup.push(id);
  };
  let disposed = 0;
  const client = {
    serverInfo: {
      storeId: 'store',
      capabilities: ['interactions', 'context', 'permission_controls'],
    },
    getView(id: string, { signal }: { signal: AbortSignal }) {
      active.add(signal);
      signals.push(signal);
      return new Promise<SessionView>((resolve, reject) => {
        const abort = () => {
          active.delete(signal);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        held.set(id, (value) => {
          signal.removeEventListener('abort', abort);
          active.delete(signal);
          resolve(value);
        });
      });
    },
    async queryExtension(
      id: string,
      _extension: string,
      _query: string,
      _input: unknown,
      { signal }: { signal: AbortSignal },
    ) {
      check(id, signal);
      return [];
    },
    async listInteractions(id: string, _input: unknown, { signal }: { signal: AbortSignal }) {
      check(id, signal);
      return { interactions: [], nextAfterId: null };
    },
    async getContext(id: string, _input: unknown, { signal }: { signal: AbortSignal }) {
      check(id, signal);
      return { messages: [], resultSources: [] };
    },
    async getPermissionMode(id: string, { signal }: { signal: AbortSignal }) {
      check(id, signal);
      return { mode: 'auto' };
    },
    async getWorkspaceTrust(_id: string, { signal }: { signal: AbortSignal }) {
      check('s-99', signal);
      return { readScopes: [] };
    },
    async getCommand(_id: string, { signal }: { signal: AbortSignal }) {
      check('s-99', signal);
      return { id: 'command', sessionId: 's-99', originStoreId: 'store' };
    },
    disposeNetwork() {
      disposed++;
    },
  } as unknown as AgentClient;
  const controller = createDesktopController({
    admittedClient: client,
    readActiveCommandOnSelect: true,
    onSnapshot: (snapshot) => visible.push(snapshot.sessionId),
    onError: (error) => errors.push(error),
  });
  const reads = Array.from({ length: 100 }, (_, index) =>
    controller.selectSession(`s-${index}`, [
      { extensionId: 'fixture', queryId: 'read', input: {} },
    ]),
  );
  expect(active.size).toBe(1);
  expect(signals.filter((signal) => signal.aborted)).toHaveLength(99);
  const last = view('s-99');
  last.runs = [{ id: 'run', isActive: true, originCommandId: 'command' }] as SessionView['runs'];
  held.get('s-99')!(last);
  await Promise.all(reads);
  expect(followup).toEqual(Array(6).fill('s-99'));
  expect(visible).toEqual(['s-99']);
  expect(controller.cachedObjectCount).toBe(1);
  expect(errors).toEqual([]);
  const refresh = controller.refreshSession('s-99');
  expect(active.size).toBe(1);
  controller.disposeNetwork();
  await refresh;
  expect(active.size).toBe(0);
  expect(signals.at(-1)!.aborted).toBe(true);
  expect(disposed).toBe(1);
  expect(errors).toEqual([]);
  await expect(controller.refreshSession('s-99')).rejects.toThrow('controller_disposed');
  expect(signals).toHaveLength(101);
});

test('retired parallel permission reads share cancellation and cannot replace the newer proof', async () => {
  let release!: (value: unknown) => void;
  const trustReads: string[] = [],
    errors: unknown[] = [];
  const signals: AbortSignal[] = [];
  const trustSignals: AbortSignal[] = [];
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['permission_controls'] },
    async getView(id: string) {
      return { ...view(id), session: { ...view(id).session, workspaceId: `w-${id}` } };
    },
    getPermissionMode(id: string, { signal }: { signal: AbortSignal }) {
      signals.push(signal);
      return id === 'old'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ mode: 'auto', revision: 'new' });
    },
    async getWorkspaceTrust(id: string, { signal }: { signal: AbortSignal }) {
      trustReads.push(id);
      trustSignals.push(signal);
      return { readScopes: [] };
    },
  } as unknown as AgentClient;
  const controller = createDesktopController({
    admittedClient: client,
    onSnapshot() {},
    onError: (error) => errors.push(error),
  });
  const old = controller.selectSession('old');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await controller.selectSession('new');
  expect(signals[0]!.aborted).toBe(true);
  expect(trustSignals[0]).toBe(signals[0]);
  expect(trustSignals[0]!.aborted).toBe(true);
  const readsBeforeRelease = [...trustReads];
  release({ mode: 'full', revision: 'old' });
  await old;
  expect(trustReads).toEqual(['w-old', 'w-new']);
  expect(trustReads).toEqual(readsBeforeRelease);
  expect(controller.snapshot?.permissions?.mode.revision).toBe('new');
  expect(controller.cachedObjectCount).toBe(1);
  expect(errors).toEqual([]);
});

test('selection starts independent metadata reads together and waits for all before publishing', async () => {
  const started: string[] = [],
    published: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = async <T>(name: string, value: T) => {
    started.push(name);
    await held;
    return value;
  };
  const client = {
    serverInfo: {
      storeId: 'store',
      capabilities: ['interactions', 'context', 'permission_controls'],
    },
    async getView(id: string) {
      return view(id);
    },
    queryExtension: () => read('extension', []),
    listInteractions: () => read('interactions', { interactions: [], nextAfterId: null }),
    getContext: () => read('context', { messages: [], resultSources: [] }),
    getPermissionMode: () => read('mode', { mode: 'auto' }),
    getWorkspaceTrust: () => read('trust', { readScopes: [] }),
    disposeNetwork() {},
  } as unknown as AgentClient;
  const controller = createDesktopController({
    admittedClient: client,
    onSnapshot: (snapshot) => published.push(snapshot.sessionId),
  });
  const selection = controller.selectSession('s', [
    { extensionId: 'fixture', queryId: 'read', input: {} },
  ]);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['extension', 'interactions', 'context', 'mode', 'trust']);
    expect(published).toEqual([]);
    expect(controller.snapshot).toBeUndefined();
  } finally {
    release();
  }
  await selection;
  expect(published).toEqual(['s']);
  controller.disposeNetwork();
});

test('lost answer response retains exact pending child source and reconciles original command without replay', async () => {
  const card: import('@kite-ai/client').Interaction = {
    id: 'i',
    originStoreId: 'store',
    sessionId: 'child',
    presentationSessionId: 'root',
    ancestry: ['root', 'child'],
    runId: 'r',
    executionId: 'e',
    attempt: 1,
    kind: 'approval',
    definitionId: 'file.write',
    definitionVersion: '1',
    inputDigest: 'digest',
    policyRevision: 'policy',
    requiredRefs: [],
    request: { path: 'actual.txt' },
    answer: null,
    revision: '7',
    acceptedDecisionRevision: null,
    state: 'pending',
  };
  let mutations = 0;
  let queried = '';
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['interactions'] },
    async getView(id: string) {
      return view(id);
    },
    async listInteractions(id: string) {
      return { interactions: id === 'root' ? [card] : [], nextAfterId: null };
    },
    async answerInteraction() {
      mutations++;
      throw new Error('lost');
    },
    async getCommand(id: string) {
      queried = id;
      return {
        id,
        originStoreId: 'store',
        sessionId: 'root',
        status: 'applied',
        kind: 'interaction.answer',
        receipt: {
          outcome: 'answer_saved',
          interactionId: card.id,
          decisionRevision: (BigInt(card.revision) + 1n).toString(),
          cancelled: false,
        },
        cancelRequestedAt: null,
      };
    },
  } as unknown as AgentClient;
  const controller = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await controller.selectSession('root');
  await expect(
    controller.answerInteraction(card, { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('lost');
  const frozen = controller.interactionSubmission(card)!;
  expect(frozen.phase).toBe('unknown');
  expect(frozen.interaction.sessionId).toBe('child');
  await controller.selectSession('different');
  await expect(
    controller.answerInteraction(card, { kind: 'approval', decision: 'deny' }),
  ).rejects.toThrow('interaction_answer_already_saved');
  expect(mutations).toBe(1);
  await controller.lookupInteractionAnswer(card);
  expect(queried).toBe(frozen.intent.commandId);
  expect(controller.interactionSubmissions[0]?.intent).toEqual(frozen.intent);
  expect(controller.interactionSubmission(card)?.phase).toBe('accepted');
});

test('plan answer requires actual request metadata and explicit offered mode before saving any intent', async () => {
  const card: import('@kite-ai/client').Interaction = {
    id: 'plan',
    originStoreId: 'store',
    sessionId: 's',
    presentationSessionId: 's',
    ancestry: ['s'],
    runId: 'r',
    executionId: 'e',
    attempt: 1,
    kind: 'plan_review',
    definitionId: 'fixture.plan',
    definitionVersion: '1',
    inputDigest: 'digest',
    policyRevision: 'policy',
    requiredRefs: [],
    request: {
      planId: 'actual',
      version: 'v2',
      digest: 'actual-digest',
      content: 'Exact plan',
      allowedModes: ['accept_edits'],
    },
    answer: null,
    revision: '1',
    acceptedDecisionRevision: null,
    state: 'pending',
  };
  let mutations = 0;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['interactions'] },
    async getView() {
      return view('s');
    },
    async listInteractions() {
      return { interactions: [card], nextAfterId: null };
    },
    async answerInteraction(_root: string, _id: string, input: { commandId: string }) {
      mutations++;
      return {
        id: input.commandId,
        sessionId: 's',
        originStoreId: 'store',
        status: 'applied',
        kind: 'interaction.answer',
        receipt: {
          outcome: 'answer_saved',
          interactionId: card.id,
          decisionRevision: (BigInt(card.revision) + 1n).toString(),
          cancelled: false,
        },
        cancelRequestedAt: null,
      };
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('s');
  await expect(
    desktop.answerInteraction(card, { kind: 'plan_review', decision: 'approve' }),
  ).rejects.toThrow('interaction_answer_invalid');
  await expect(
    desktop.answerInteraction(card, { kind: 'plan_review', decision: 'approve', mode: 'auto' }),
  ).rejects.toThrow('interaction_answer_invalid');
  await expect(
    desktop.answerInteraction(card, { kind: 'plan_review', decision: 'approve', mode: 'full' }),
  ).rejects.toThrow('interaction_answer_invalid');
  expect(mutations).toBe(0);
  expect(desktop.interactionSubmissions).toEqual([]);
  await desktop.answerInteraction(card, {
    kind: 'plan_review',
    decision: 'approve',
    mode: 'accept_edits',
  });
  expect(mutations).toBe(1);
  expect(desktop.interactionSubmission(card)?.intent.answer).toEqual({
    kind: 'plan_review',
    decision: 'approve',
    mode: 'accept_edits',
  });
});
