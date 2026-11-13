import type { Interaction, PermissionModeState, Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from '#kite-test';
import type { NativeBridge, NativeState, NativeWindowBridge } from '../../src/native-bridge';
import { nextDesktopPresentation, prepareDesktopDom } from '../native-page-dom.fixture';

test('ordinary pending business cards retain scoped permission controls and cancel without answering or exposing the prompt', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayout = prepareDesktopDom(dom);
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const session = {
    id: 'session',
    workspaceId: 'workspace',
    rootSessionId: 'session',
    parentSessionId: null,
    title: 'Pending plan',
    nextSeq: '0',
    deletedAt: null,
    controlRevision: '0',
    contextSelectionId: 'context',
  } satisfies Session;
  let kind: 'plan_review' | 'question' = 'plan_review';
  let permissionUnavailable = false;
  let mode: PermissionModeState['mode'] = 'accept_edits',
    revision = 1;
  const card = (): Interaction => ({
    id: 'original-business-card',
    originStoreId: 'store',
    sessionId: session.id,
    presentationSessionId: session.id,
    ancestry: [session.id],
    runId: 'run',
    executionId: 'review',
    attempt: 1,
    kind,
    definitionId: 'planning.review',
    definitionVersion: '1',
    inputDigest: 'input',
    policyRevision: 'information-1',
    requiredRefs: [],
    answer: null,
    revision: '1',
    acceptedDecisionRevision: null,
    state: 'pending',
    request:
      kind === 'plan_review'
        ? { planId: 'p', version: '1', digest: 'digest', content: 'Exact original plan' }
        : { schema: { type: 'string', enum: ['original-choice'] } },
  });
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      viewGeneration: 1,
      viewSelection: 1,
      canReadModelOutput: false,
      session,
      permissionUnavailable,
      permissions: {
        observationId: revision,
        mode: {
          storeId: 'store',
          sessionId: session.id,
          scopeSessionId: session.id,
          revision: String(revision),
          defaultRevision: '0',
          mode,
          defaultMode: 'accept_edits',
        },
        trust: {
          storeId: 'store',
          workspaceId: session.workspaceId,
          revision: '1',
          trusted: true,
          status: 'trusted',
          canonicalIdentity: 'workspace-identity',
          externalReadScopeDigest: 'read-scope',
          readScopes: [],
        },
      },
      runs: [
        {
          id: 'run',
          sessionId: session.id,
          originStoreId: 'store',
          originCommandId: 'original-work',
          status: 'waiting_interaction',
          isActive: true,
          createdAt: 1,
          finishedAt: null,
          reason: null,
        },
      ],
      executions: [
        {
          id: 'review',
          originStoreId: 'store',
          sessionId: session.id,
          runId: 'run',
          kind: 'tool',
          definitionId: 'planning.review',
          definitionVersion: '1',
          status: 'dispatching',
          result: null,
          resultRevision: '0',
          cancelRequestedAt: null,
        },
      ],
      interactions: [card()],
      interactionsAfterId: null,
    },
  });
  const mutations: { mode: PermissionModeState['mode']; observationId: number }[] = [],
    cancellations: string[] = [];
  let answers = 0,
    confirmations = 0,
    watcher: (() => void) | undefined;
  let confirm!: (accepted: boolean) => void;
  const bridge: NativeBridge & Partial<NativeWindowBridge> = {
    watch(callback) {
      watcher = () => callback({ generation: 1, kind: 'changed' });
      return () => {
        watcher = undefined;
      };
    },
    async request(input) {
      if (input.method === 'attach' || input.method === 'state' || input.method === 'select')
        return state();
      if (input.method === 'directory')
        return {
          storeId: 'store',
          workspaces: [{ id: 'workspace', name: 'Owned', rootUri: 'file:///workspace' }],
          sessions: [session],
        };
      if (input.method === 'messages')
        return { messages: [], nextAfterSeq: null, highWaterSeq: '0' };
      if (input.method === 'draft.read')
        return {
          id: session.id,
          storeId: 'store',
          workspaceId: session.workspaceId,
          rootSessionId: session.id,
          revision: 1,
          content: 'Original unsent draft',
        };
      if (input.method === 'permission.mode') {
        expect(input.observationId).toBe(revision);
        mutations.push({ mode: input.mode, observationId: input.observationId });
        mode = input.mode;
        revision++;
        return null;
      }
      if (input.method === 'interaction.answer') {
        answers++;
        return null;
      }
      if (input.method === 'caller.prepare') {
        expect(input.intent.kind).toBe('command.cancel');
        if (input.intent.kind === 'command.cancel')
          expect(input.intent.targetCommandId).toBe('original-work');
        cancellations.push(input.intent.commandId);
        return null;
      }
      return null;
    },
    confirmFullPermission() {
      confirmations++;
      return new Promise<boolean>((resolve) => {
        confirm = resolve;
      });
    },
    cancelFullPermissionConfirmation() {},
  };
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge });
  const { NativeDesktop } = await import('../../src/native');
  const root = createRoot(document.getElementById('root')!);
  const settle = () =>
    act(async () => {
      await nextDesktopPresentation(dom);
    });
  const choose = async (label: string) => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-permission-trigger]');
    expect(trigger).not.toBeNull();
    await act(async () =>
      trigger!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    );
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (node) => node.textContent?.includes(label),
    );
    expect(item).toBeDefined();
    await act(async () => item!.click());
  };
  try {
    await act(async () => root.render(<NativeDesktop testDiagnostics={false} />));
    const sessionButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.classList.contains('session-row') && node.textContent?.includes(session.title),
    )!;
    await act(async () => sessionButton.click());
    await settle();
    const initialCard = JSON.stringify(card());
    for (const [next, label] of [
      ['auto', 'Automatic check'],
      ['full', 'Full permission'],
      ['auto', 'Automatic check'],
      ['accept_edits', 'Request Approval'],
      ['full', 'Full permission'],
      ['accept_edits', 'Request Approval'],
    ] as const) {
      expect(document.querySelector('[aria-label="当前会话私有草稿"]')).toBeNull();
      const before = mutations.length;
      await choose(label);
      if (next === 'full') {
        expect(mutations).toHaveLength(before);
        await act(async () => confirm(true));
      }
      await settle();
      expect(state().selection!.permissions!.mode.mode).toBe(next);
      expect(mutations).toHaveLength(before + 1);
      expect(JSON.stringify(card())).toBe(initialCard);
      expect(answers).toBe(0);
    }
    expect(confirmations).toBe(2);
    const unchanged = mutations.length;
    await choose('Full permission');
    permissionUnavailable = true;
    await act(async () => watcher?.());
    await settle();
    const blockedTrigger = document.querySelector<HTMLButtonElement>('[data-permission-trigger]');
    expect(!blockedTrigger || blockedTrigger.disabled).toBe(true);
    await act(async () => confirm(true));
    await settle();
    expect(mutations).toHaveLength(unchanged);
    expect(JSON.stringify(card())).toBe(initialCard);
    permissionUnavailable = false;
    await act(async () => watcher?.());
    await settle();

    kind = 'question';
    await act(async () => watcher?.());
    await settle();
    expect(document.querySelector('[aria-label="当前会话私有草稿"]')).toBeNull();
    expect(document.querySelector('[data-permission-trigger]')).not.toBeNull();
    await choose('Automatic check');
    await settle();
    expect(state().selection!.permissions!.mode.mode).toBe('auto');
    expect(answers).toBe(0);
    const stop = document.querySelector<HTMLButtonElement>('[aria-label="停止任务"]');
    expect(stop).not.toBeNull();
    expect(stop!.disabled).toBe(false);
    await act(async () => stop!.click());
    await settle();
    expect(cancellations).toHaveLength(1);
    expect(answers).toBe(0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    restoreLayout();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
