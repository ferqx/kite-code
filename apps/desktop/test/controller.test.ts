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
test('late old view is cached within bounds but cannot overwrite new selection; disposal never stops service', async () => {
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
    maxCachedObjects: 1,
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
