import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter } from '@kite-ai/ai';
import { createClient, type Message, type Run, type Session } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { DesktopInput, inputMetadata } from '../../src/input';
import type {
  NativeBridge,
  NativeCallerMetadata,
  NativeConversationResult,
  NativeDraft,
  NativeRequest,
  NativeResult,
  NativeState,
} from '../../src/native-bridge';
import { desktopConversationMessages } from '../../src/native-presentation';
import { prepareDesktopDom, promptValue, setPromptText } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { NativeDesktop } = await import('../../src/native');
Object.assign(globalThis, originals);
bootstrap.window.close();

function fixture(
  withPermissions = false,
  trusted = true,
  initialMode: 'accept_edits' | 'auto' | 'full' = 'accept_edits',
  options: {
    withoutSelection?: boolean;
    messages?: Message[];
    workspaceIds?: readonly ('w' | 'empty')[];
    holdDirectory?: boolean;
    firstHumanInput?: boolean;
    runs?: Run[];
    storeId?: string;
    contextSelectionId?: string;
  } = {},
) {
  const fixtureStoreId = options.storeId ?? 'store';
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restore = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document,
    root = createRoot(host.getElementById('root')!);
  const calls: NativeRequest[] = [],
    messages: Message[] = [...(options.messages ?? [])],
    runs: Run[] = [...(options.runs ?? [])],
    drafts = new Map<string, string>([
      ['a', 'saved A'],
      ['b', 'saved B'],
    ]);
  const session = (id: string): Session => ({
    id,
    workspaceId: 'w',
    rootSessionId: id,
    parentSessionId: null,
    title: id === 'a' ? 'Original A' : id === 'b' ? 'Other B' : '新对话',
    nextSeq: messages.filter((message) => message.sessionId === id).at(-1)?.seq ?? '0',
    deletedAt: null,
    controlRevision: '0',
    contextSelectionId: options.contextSelectionId ?? 'context',
  });
  const sessions = [session('a'), session('b')];
  const modes = new Map<string, 'accept_edits' | 'auto' | 'full'>([
    ['a', initialMode],
    ['b', 'auto'],
  ]);
  const registeredWorkspaces = [
    { id: 'w', name: 'Workspace', rootUri: 'file:///workspace' },
    { id: 'empty', name: 'Ordinary directory', rootUri: 'file:///ordinary' },
  ];
  let workspaceIds = options.workspaceIds ?? ['w', 'empty'];
  const directoryFacts = () => ({
    storeId: fixtureStoreId,
    sessions,
    workspaces: workspaceIds.map(
      (id) => registeredWorkspaces.find((workspace) => workspace.id === id)!,
    ),
  });
  let publishDirectory = false,
    holdDirectory = options.holdDirectory,
    releaseDirectory: (() => void) | undefined,
    holdBranch = false,
    releaseBranch: (() => void) | undefined;
  let selectionPresent = !options.withoutSelection;
  let selected = 'a',
    release: ((value: NativeConversationResult) => void) | undefined;
  let rejectNext = false;
  let trustDescription = '只读关联目录 /host/reference';
  let trustRelease: (() => void) | undefined;
  let holdTrust = false;
  let unknownTrust = false;
  let holdSelection = false,
    holdHistory = false;
  let releaseSelection: (() => void) | undefined, releaseHistory: (() => void) | undefined;
  let heldSelectionSession: string | undefined;
  let holdModels = false,
    releaseModels: (() => void) | undefined;
  const permissionSubmissions: NativeState['permissionSubmissions'][number][] = [];
  let viewGeneration = 1;
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions,
    interactionSubmissions: [],
    ...(publishDirectory ? { directory: directoryFacts() } : {}),
    selection: selectionPresent
      ? {
          storeId: fixtureStoreId,
          canReadModelOutput: false,
          viewGeneration,
          viewSelection: 1,
          session: sessions.find((session) => session.id === selected)!,
          runs: runs.filter((run) => run.sessionId === selected),
          executions: [],
          interactions: [],
          interactionsAfterId: null,
          ...(withPermissions
            ? {
                permissions: {
                  observationId: selected === 'a' ? 1 : 2,
                  mode: {
                    storeId: fixtureStoreId,
                    sessionId: selected,
                    scopeSessionId: selected,
                    mode: modes.get(selected) ?? 'auto',
                    revision: '0',
                    defaultMode: 'auto' as const,
                    defaultRevision: '0',
                  },
                  trust: {
                    storeId: fixtureStoreId,
                    workspaceId: 'w',
                    status: trusted ? ('trusted' as const) : ('untrusted' as const),
                    trusted,
                    revision: '0',
                    canonicalIdentity: 'a'.repeat(64),
                    externalReadScopeDigest: 'b'.repeat(64),
                    readScopes: [
                      { kind: 'workspace' as const, description: 'Workspace' },
                      { kind: 'external_read', description: trustDescription },
                    ],
                  },
                },
              }
            : {}),
        }
      : undefined,
  });
  let watcher: Parameters<NativeBridge['watch']>[0] | undefined;
  const bridge: NativeBridge = {
    watch: (listener) => {
      watcher = listener;
      return () => {
        watcher = undefined;
      };
    },
    async request(input) {
      calls.push(input);
      if (input.method === 'attach' || input.method === 'state')
        return input.method === 'state' && releaseSelection && heldSelectionSession === selected
          ? { ...state(), selection: undefined }
          : state();
      if (input.method === 'directory') {
        const result = directoryFacts();
        if (holdDirectory) {
          holdDirectory = false;
          await new Promise<void>((resolve) => {
            releaseDirectory = resolve;
          });
        }
        return result;
      }
      if (input.method === 'select') {
        selectionPresent = true;
        selected = input.sessionId;
        const result = state();
        if (holdSelection) {
          holdSelection = false;
          heldSelectionSession = input.sessionId;
          await new Promise<void>((resolve) => {
            releaseSelection = () => {
              releaseSelection = undefined;
              heldSelectionSession = undefined;
              resolve();
            };
          });
        }
        return result;
      }
      if (input.method === 'permission.trust') {
        expect(input.trusted).toBe(true);
        expect(input.observationId).toBe(selected === 'a' ? 1 : 2);
        if (holdTrust)
          await new Promise<void>((resolve) => {
            trustRelease = resolve;
          });
        if (unknownTrust) {
          permissionSubmissions.push({
            sessionId: selected,
            rootSessionId: selected,
            workspaceId: 'w',
            kind: 'workspace.trust',
            phase: 'unknown',
            intent: {
              expectedStoreId: fixtureStoreId,
              commandId: 'original-trust',
              canonicalIdentity: 'a'.repeat(64),
              externalReadScopeDigest: 'b'.repeat(64),
              trusted: true,
              ifRevision: '0',
            },
          });
          return {
            commandId: 'original-trust',
            state: 'outcome_unknown',
            kind: 'workspace.trust',
            receipt: { status: 'outcome_unknown' },
          };
        }
        trusted = true;
        return {
          commandId: 'trust-command',
          state: 'applied',
          kind: 'workspace.trust',
          receipt: {
            status: 'applied',
            trusted: true,
            revision: '1',
            canonicalIdentity: 'a'.repeat(64),
            externalReadScopeDigest: 'b'.repeat(64),
          },
        };
      }
      if (input.method === 'permission.mode') {
        expect(input.observationId).toBe(selected === 'a' ? 1 : 2);
        expect(input.makeDefault).toBe(false);
        modes.set(selected, input.mode as 'accept_edits' | 'auto' | 'full');
        return {
          commandId: `mode-${calls.length}`,
          kind: 'permission.mode',
          state: 'applied',
          receipt: {
            status: 'applied',
            mode: input.mode,
            makeDefault: false,
            revision: '1',
            defaultRevision: '0',
          },
        };
      }
      if (input.method === 'messages') {
        if (holdHistory) {
          holdHistory = false;
          await new Promise<void>((resolve) => {
            releaseHistory = resolve;
          });
        }
        return {
          messages: messages.filter((message) => message.sessionId === input.sessionId),
          nextAfterSeq: null,
          highWaterSeq: sessions.find((session) => session.id === input.sessionId)?.nextSeq ?? '0',
        };
      }
      if (input.method === 'draft.read')
        return {
          id: input.sessionId,
          storeId: fixtureStoreId,
          workspaceId: 'w',
          rootSessionId: input.sessionId,
          revision: 1,
          content: drafts.get(input.sessionId) ?? '',
        };
      if (input.method === 'conversation.branch') {
        const result = {
          kind: 'conversation.branch' as const,
          storeId: fixtureStoreId,
          workspaceId: input.workspaceId,
          repository: input.workspaceId === 'w',
          current: input.workspaceId === 'w' ? 'main' : undefined,
          branches: input.workspaceId === 'w' ? ['main', 'dev'] : [],
          label: input.workspaceId === 'w' ? 'main' : '本地目录',
        };
        if (holdBranch) {
          holdBranch = false;
          await new Promise<void>((resolve) => {
            releaseBranch = resolve;
          });
        }
        return result;
      }
      if (
        input.method === 'conversation.models.read' ||
        input.method === 'input.models.read' ||
        input.method === 'settings.models.read'
      ) {
        if (holdModels) {
          holdModels = false;
          await new Promise<void>((resolve) => {
            releaseModels = () => {
              releaseModels = undefined;
              resolve();
            };
          });
        }
        return {
          kind: 'settings.models',
          observationId: 1,
          scope: input.method === 'settings.models.read' ? input.scope : 'user',
          storeId: fixtureStoreId,
          canWrite: false,
          errors: [],
          defaultModelId: 'model',
          models: [
            {
              id: 'model',
              provider: 'compatible',
              model: 'Model',
              enabled: true,
              configured: true,
              diagnostics: [],
              reasoningEffortChoices: [],
            },
          ],
        };
      }
      if (input.method === 'settings.providers.read')
        return {
          kind: 'settings.providers',
          observationId: 1,
          storeId: fixtureStoreId,
          canWrite: true,
          errors: [],
          providers: [
            {
              id: 'openai',
              label: 'OpenAI',
              defaultBaseURL: 'https://api.openai.com/v1',
              requiresCredential: true,
              connections: [],
            },
          ],
        };
      if (input.method === 'conversation.send') {
        drafts.set(input.creation.sessionId, input.intent.content);
        if (rejectNext) {
          rejectNext = false;
          throw Error('fixture_response_loss');
        }
        return await new Promise<NativeConversationResult>((resolve) => {
          release = resolve;
        });
      }
      if (input.method === 'conversation.lookup') {
        const send = calls.find(
          (call) =>
            call.method === 'conversation.send' && call.intent.commandId === input.commandId,
        ) as Extract<NativeRequest, { method: 'conversation.send' }>;
        if (!sessions.some((item) => item.id === send.creation.sessionId))
          sessions.push(session(send.creation.sessionId));
        return {
          kind: 'conversation',
          commandId: input.commandId,
          phase: 'failed',
          stage: 'create',
          creation: { input: send.creation, phase: 'created' },
          code: 'conversation_continue_explicit',
        };
      }
      return null;
    },
  };
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge });
  const find = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('button,[role="menuitemradio"]')].find(
      (item) => item.textContent === name || item.getAttribute('aria-label') === name,
    );
  const click = async (name: string) =>
    act(async () => {
      const button = find(name);
      expect(button).toBeDefined();
      button!.click();
    });
  const edit = async (value: string, label = '新对话草稿') =>
    act(async () => {
      const input = host.querySelector<HTMLElement>(`[role="textbox"][aria-label="${label}"]`)!;
      expect(input).not.toBeNull();
      await setPromptText(input, value);
    });
  const input = (label = '新对话草稿') =>
    host.querySelector<HTMLElement>(`[role="textbox"][aria-label="${label}"]`);
  return {
    dom,
    root,
    host,
    calls,
    until: async (ready: () => boolean) => {
      for (let i = 0; i < 1500 && !ready(); i++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        });
      expect(ready()).toBe(true);
    },
    click,
    edit,
    input,
    releaseDirectory: () => act(async () => releaseDirectory?.()),
    setWorkspaceOrder: (ids: readonly ('w' | 'empty')[]) => {
      workspaceIds = ids;
      publishDirectory = true;
    },
    holdBranch: () => {
      holdBranch = true;
    },
    releaseBranch: () => act(async () => releaseBranch?.()),
    holdModels: () => {
      holdModels = true;
    },
    modelsHeld: () => !!releaseModels,
    refreshWhileSelecting: () => act(async () => watcher?.({ kind: 'changed', generation: 1 })),
    releaseModels: () => act(async () => releaseModels?.()),
    selected: () => selected,
    holdSelection: () => {
      holdSelection = true;
    },
    releaseSelection: () => act(async () => releaseSelection?.()),
    holdHistory: () => {
      holdHistory = true;
    },
    releaseHistory: () => act(async () => releaseHistory?.()),
    trustWorkspace: () => {
      trusted = true;
    },
    unknownTrust: () => {
      unknownTrust = true;
    },
    holdTrust: () => {
      holdTrust = true;
    },
    releaseTrust: async () => {
      await act(async () => trustRelease?.());
    },
    refreshFacts: async () => {
      await act(async () => watcher?.({ kind: 'changed', generation: 1 }));
    },
    publishMessages: async (next: Message[], nextRuns: Run[]) => {
      messages.splice(0, messages.length, ...next);
      runs.splice(0, runs.length, ...nextRuns);
      for (const item of sessions)
        item.nextSeq =
          messages.filter((message) => message.sessionId === item.id).at(-1)?.seq ?? '0';
      viewGeneration++;
      await act(async () => watcher?.({ kind: 'changed', generation: 1 }));
    },
    snapshot: () => ({ messages: [...messages], runs: [...runs] }),
    lifecycle: (phase: 'active' | 'quitting') =>
      act(async () => watcher?.({ kind: 'lifecycle', phase })),
    changeTrustScope: (description: string) => {
      trustDescription = description;
    },
    loseNextResponse: () => {
      rejectNext = true;
    },
    async resolve(phase: 'failed' | 'unknown' | 'accepted', created = true, code?: string) {
      const send = [...calls]
        .reverse()
        .find((call) => call.method === 'conversation.send') as Extract<
        NativeRequest,
        { method: 'conversation.send' }
      >;
      if (created && !sessions.some((item) => item.id === send.creation.sessionId))
        sessions.push(session(send.creation.sessionId));
      if (phase === 'accepted') {
        const runId = `${options.firstHumanInput ? 'processing-run' : 'first-run'}-${send.intent.commandId}`;
        runs.push({
          id: runId,
          sessionId: send.creation.sessionId,
          originStoreId: fixtureStoreId,
          originCommandId: options.firstHumanInput
            ? `processing-${send.intent.commandId}`
            : send.intent.commandId,
          isActive: false,
          status: 'completed',
        } as Run);
        messages.push({
          id: `message-${send.intent.commandId}`,
          sessionId: send.creation.sessionId,
          runId,
          seq: '1',
          status: 'complete',
          role: 'user',
          content: send.intent.content,
          sourceIds: [
            options.firstHumanInput ? `processing-${send.intent.commandId}` : send.intent.commandId,
          ],
          ...(options.firstHumanInput
            ? {
                humanInput: {
                  inputCommandId: `raw-${send.intent.commandId}`,
                  publicCommandId: send.intent.commandId,
                },
              }
            : {}),
        });
        sessions.find((session) => session.id === send.creation.sessionId)!.nextSeq = '1';
      }
      await act(async () =>
        release?.({
          kind: 'conversation',
          commandId: send.intent.commandId,
          phase,
          stage: created ? 'input' : 'create',
          creation: { input: send.creation, phase: created ? 'created' : 'unknown' },
          code: code ?? (phase === 'failed' ? 'input_rejected' : undefined),
        }),
      );
      return send;
    },
    async close() {
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      restore();
      Object.assign(globalThis, prior);
      dom.window.close();
    },
  };
}

function savedPromptFixture(
  options: { unknown?: boolean; holdSubmit?: boolean; callerOnly?: boolean } = {},
) {
  const f = fixture(true);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  const saved = new Map<string, NativeDraft>(
    ['a', 'b'].map((id) => [
      id,
      {
        id,
        storeId: 'store',
        workspaceId: 'w',
        rootSessionId: id,
        revision: 1,
        content: id === 'a' ? 'saved A' : 'saved B',
      },
    ]),
  );
  let submission: NativeState['inputSubmissions'][number] | undefined;
  let caller: NativeCallerMetadata | undefined;
  let readOverride: ((value: NativeDraft) => Promise<NativeDraft> | NativeDraft) | undefined;
  let releaseSubmit: (() => void) | undefined;
  const consume = () => {
    if (!caller?.draft || !submission) return;
    const previous = saved.get(submission.sessionId)!;
    if (caller.draft.revision === String(previous.revision))
      saved.set(submission.sessionId, {
        ...previous,
        content: '',
        revision: previous.revision + 1,
        consumedFrom: {
          commandId: caller.request.commandId,
          revision: previous.revision,
        },
      });
  };
  bridge.request = async (input) => {
    if (input.method === 'draft.read') {
      f.calls.push(input);
      const value = { ...saved.get(input.sessionId)! };
      return readOverride ? readOverride(value) : value;
    }
    if (input.method === 'draft.write') {
      f.calls.push(input);
      const previous = saved.get(input.sessionId)!;
      if (input.revision !== previous.revision) throw Error('draft_revision_conflict');
      const value = { ...previous, content: input.content, revision: previous.revision + 1 };
      delete value.consumedFrom;
      saved.set(input.sessionId, value);
      return value;
    }
    if (input.method === 'submit') {
      f.calls.push(input);
      const previous = saved.get(input.sessionId)!;
      const proof =
        previous.content === input.intent.content
          ? { id: previous.id, revision: String(previous.revision), textDigest: '0'.repeat(64) }
          : undefined;
      submission = {
        sessionId: input.sessionId,
        intent: {
          kind: input.intent.kind,
          expectedStoreId: input.intent.expectedStoreId,
          commandId: input.intent.commandId,
        },
        phase: options.unknown ? 'unknown' : 'accepted',
      };
      caller = {
        scope: { storeId: 'store', workspaceId: 'w', sessionId: input.sessionId },
        subjectId: 'local-user',
        target: { kind: 'session', id: input.sessionId },
        bodyDigest: '0'.repeat(64),
        requestDigest: '0'.repeat(64),
        request: submission.intent,
        phase: options.unknown ? 'unknown' : 'accepted',
        draft: proof,
      };
      if (options.holdSubmit)
        await new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        });
      if (!options.unknown) consume();
      return { ...submission, draft: proof };
    }
    const result = await request(input);
    if (!options.unknown || !result || !('generation' in result) || !submission || !caller)
      return result;
    return {
      ...result,
      inputSubmissions: options.callerOnly ? [] : [submission],
      callerSubmissions: [caller],
    };
  };
  return {
    ...f,
    saved,
    setReadOverride: (override?: typeof readOverride) => {
      readOverride = override;
    },
    releaseSubmit: () => act(async () => releaseSubmit?.()),
    confirm: async () => {
      submission = { ...submission!, phase: 'accepted' };
      caller = { ...caller!, phase: 'applied' };
      consume();
      await f.refreshFacts();
    },
    writes: () => f.calls.filter((input) => input.method === 'draft.write'),
  };
}

test('saving after accepted saved input uses the consumed draft revision in the same Session', async () => {
  const f = savedPromptFixture();
  try {
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    await f.click('Original A');
    await f.edit('saved and submitted A', '当前会话私有草稿');
    await f.click('保留草稿');
    const plan = f.host.querySelector<HTMLInputElement>('[aria-label="先审核计划"]')!;
    await act(async () => plan.click());
    expect(plan.checked).toBe(true);
    await f.click('发送计划任务');
    expect(f.saved.get('a')?.revision).toBe(3);
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
    expect(plan.checked).toBe(false);
    await f.edit('new draft B', '当前会话私有草稿');
    await f.click('保留草稿');
    expect(f.writes().map((input) => input.revision)).toEqual([1, 3]);
    expect(f.saved.get('a')?.content).toBe('new draft B');
    expect(f.host.querySelector('[role="alertdialog"]')).toBeNull();
  } finally {
    await f.close();
  }
});

test('saved draft reconciliation preserves edits queued during acceptance and during its awaited read', async () => {
  const f = savedPromptFixture({ holdSubmit: true });
  let releaseRead: (() => void) | undefined;
  try {
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    await f.click('Original A');
    await f.click('发送明确的新轮次');
    await f.edit('B typed before acceptance', '当前会话私有草稿');
    await f.releaseSubmit();
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('B typed before acceptance');
    f.setReadOverride(
      (value) =>
        new Promise((resolve) => {
          releaseRead = () => resolve(value);
        }),
    );
    await f.click('保留草稿');
    expect(releaseRead).toBeDefined();
    expect(f.writes()).toHaveLength(0);
    await f.edit('C typed while checking revision', '当前会话私有草稿');
    f.setReadOverride();
    await act(async () => releaseRead?.());
    expect(f.writes().map((input) => [input.revision, input.content])).toEqual([
      [2, 'B typed before acceptance'],
    ]);
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('C typed while checking revision');
    await f.click('保留草稿');
    expect(f.saved.get('a')?.content).toBe('C typed while checking revision');
    expect(f.writes().map((input) => input.revision)).toEqual([2, 3]);
  } finally {
    await f.releaseSubmit();
    await act(async () => releaseRead?.());
    await f.close();
  }
});

for (const callerOnly of [false, true])
  test(`an accepted-after-unknown saved draft reconciles without clearing later input (${callerOnly ? 'caller' : 'input then caller'})`, async () => {
    const f = savedPromptFixture({ unknown: true, callerOnly });
    try {
      await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
      await f.click('Original A');
      await f.click('发送明确的新轮次');
      await f.edit('later input after unknown', '当前会话私有草稿');
      await f.confirm();
      expect(promptValue(f.input('当前会话私有草稿'))).toBe('later input after unknown');
      await f.click('保留草稿');
      expect(f.writes().map((input) => input.revision)).toEqual([2]);
      expect(f.saved.get('a')?.content).toBe('later input after unknown');
      const reads = f.calls.filter((input) => input.method === 'draft.read').length;
      await f.refreshFacts();
      await f.refreshFacts();
      await f.edit('another edit', '当前会话私有草稿');
      await f.click('保留草稿');
      expect(f.writes().map((input) => input.revision)).toEqual([2, 3]);
      expect(f.calls.filter((input) => input.method === 'draft.read')).toHaveLength(reads);
      expect(f.calls.filter((input) => input.method === 'submit')).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test('accepting unsaved input without saved-draft proof does not read or increment its CAS baseline', async () => {
  const f = savedPromptFixture();
  try {
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    await f.click('Original A');
    await f.edit('not the saved input', '当前会话私有草稿');
    await f.click('发送明确的新轮次');
    const reads = f.calls.filter((input) => input.method === 'draft.read').length;
    await f.edit('next unsent edit', '当前会话私有草稿');
    await f.click('保留草稿');
    expect(f.writes().map((input) => input.revision)).toEqual([1]);
    expect(f.calls.filter((input) => input.method === 'draft.read')).toHaveLength(reads);
    expect(f.saved.get('a')?.content).toBe('next unsent edit');
  } finally {
    await f.close();
  }
});

test('an accepted original proof cannot silently rebase over newer nonempty persisted text', async () => {
  const f = savedPromptFixture({ unknown: true });
  try {
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    await f.click('Original A');
    await f.click('发送明确的新轮次');
    f.saved.set('a', { ...f.saved.get('a')!, revision: 2, content: 'another writer saved this' });
    await f.confirm();
    await f.edit('my later edit', '当前会话私有草稿');
    await f.click('保留草稿');
    expect(f.writes().map((input) => input.revision)).toEqual([1]);
    expect(f.saved.get('a')?.content).toBe('another writer saved this');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('my later edit');
    expect(f.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'draft_revision_conflict',
    );
  } finally {
    await f.close();
  }
});

test('an independent empty saved draft is not mistaken for committed receipt consumption', async () => {
  const f = savedPromptFixture({ unknown: true });
  try {
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    await f.click('Original A');
    await f.click('发送明确的新轮次');
    f.saved.set('a', { ...f.saved.get('a')!, revision: 2, content: '' });
    await f.confirm();
    await f.edit('my later edit', '当前会话私有草稿');
    await f.click('保留草稿');
    expect(f.writes().map((input) => input.revision)).toEqual([1]);
    expect(f.saved.get('a')?.content).toBe('');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('my later edit');
    expect(f.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'draft_revision_conflict',
    );
  } finally {
    await f.close();
  }
});

for (const mismatch of [
  { id: 'different-draft' },
  { storeId: 'different-store' },
  { workspaceId: 'different-workspace' },
  { rootSessionId: 'different-session' },
  { revision: 3 },
  { consumedFrom: { commandId: 'different-command', revision: 1 } },
  { consumedFrom: undefined },
])
  test(`saved draft reconciliation rejects a nonmatching consumed read ${JSON.stringify(mismatch)}`, async () => {
    const f = savedPromptFixture();
    try {
      await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
      await f.click('Original A');
      await f.click('发送明确的新轮次');
      f.setReadOverride((value) => ({ ...value, ...mismatch }));
      await f.edit('newer editor text', '当前会话私有草稿');
      await f.click('保留草稿');
      expect(f.writes().map((input) => input.revision)).toEqual([1]);
      expect(f.saved.get('a')?.revision).toBe(2);
      expect(promptValue(f.input('当前会话私有草稿'))).toBe('newer editor text');
      expect(f.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
        'draft_revision_conflict',
      );
    } finally {
      await f.close();
    }
  });

test('saved draft reconciliation requires the original consumed-from revision', async () => {
  const f = savedPromptFixture();
  try {
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    await f.click('Original A');
    await f.click('发送明确的新轮次');
    f.setReadOverride((value) => ({
      ...value,
      consumedFrom: { ...value.consumedFrom!, revision: 0 },
    }));
    await f.edit('newer editor text', '当前会话私有草稿');
    await f.click('保留草稿');
    expect(f.writes().map((input) => input.revision)).toEqual([1]);
    expect(f.saved.get('a')?.revision).toBe(2);
    expect(f.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'draft_revision_conflict',
    );
  } finally {
    await f.close();
  }
});

for (const returnToOriginal of [false, true])
  test(`a late consumed-draft read cannot save into a newer ${returnToOriginal ? 'same-Session view' : 'Session'}`, async () => {
    const f = savedPromptFixture();
    let releaseRead: (() => void) | undefined;
    try {
      await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
      await f.click('Original A');
      await f.click('发送明确的新轮次');
      await f.edit('A stays unsaved', '当前会话私有草稿');
      f.setReadOverride(
        (value) =>
          new Promise((resolve) => {
            releaseRead = () => resolve(value);
          }),
      );
      await f.click('保留草稿');
      expect(releaseRead).toBeDefined();
      f.setReadOverride();
      await f.click('Other B');
      if (returnToOriginal) await f.click('Original A');
      await act(async () => releaseRead?.());
      expect(f.writes()).toHaveLength(0);
      expect(promptValue(f.input('当前会话私有草稿'))).toBe(
        returnToOriginal ? 'A stays unsaved' : 'saved B',
      );
      await f.click('保留草稿');
      expect(f.writes().map((input) => [input.sessionId, input.revision])).toEqual([
        [returnToOriginal ? 'a' : 'b', returnToOriginal ? 2 : 1],
      ]);
      expect(f.host.querySelector('[role="alertdialog"]')).toBeNull();
    } finally {
      await act(async () => releaseRead?.());
      await f.close();
    }
  });

for (const next of ['other', 'return', 'quitting', 'cancelled-quit'] as const)
  test(`a superseded consumed-draft read rejection stays out of the ${next} view`, async () => {
    const f = savedPromptFixture();
    let rejectRead: (() => void) | undefined;
    try {
      await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
      await f.click('Original A');
      await f.click('发送明确的新轮次');
      await f.edit('unsaved A survives the read', '当前会话私有草稿');
      f.setReadOverride(
        () =>
          new Promise((_resolve, reject) => {
            rejectRead = () => reject(Error('draft_storage_unavailable'));
          }),
      );
      await f.click('保留草稿');
      expect(rejectRead).toBeDefined();
      f.setReadOverride();
      if (next === 'other' || next === 'return') {
        await f.click('Other B');
        if (next === 'return') await f.click('Original A');
      } else {
        await f.lifecycle('quitting');
        if (next === 'cancelled-quit') await f.lifecycle('active');
      }
      await act(async () => rejectRead?.());
      expect(f.writes()).toHaveLength(0);
      expect(f.host.querySelector('[role="alertdialog"]') === null).toBe(true);
      expect(promptValue(f.input('当前会话私有草稿'))).toBe(
        next === 'other' ? 'saved B' : 'unsaved A survives the read',
      );
    } finally {
      await act(async () => rejectRead?.());
      await f.close();
    }
  });

test('a current consumed-draft read rejection reports its error and an explicit retry still reconciles', async () => {
  const f = savedPromptFixture();
  try {
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    await f.click('Original A');
    await f.click('发送明确的新轮次');
    await f.edit('unsaved draft after accepted input', '当前会话私有草稿');
    f.setReadOverride(() => {
      throw Error('draft_storage_unavailable');
    });
    await f.click('保留草稿');
    expect(f.writes()).toHaveLength(0);
    expect(f.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'draft_storage_unavailable',
    );
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('unsaved draft after accepted input');
    f.setReadOverride();
    await f.click('确定');
    await f.click('保留草稿');
    expect(f.writes().map((input) => input.revision)).toEqual([2]);
    expect(f.saved.get('a')?.content).toBe('unsaved draft after accepted input');
  } finally {
    await f.close();
  }
});

test('a late draft write rejection remains a mutation error after reconciliation and navigation', async () => {
  const f = savedPromptFixture();
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  let rejectWrite: (() => void) | undefined;
  bridge.request = async (input) => {
    if (input.method !== 'draft.write') return request(input);
    f.calls.push(input);
    return new Promise((_resolve, reject) => {
      rejectWrite = () => reject(Error('draft_storage_unavailable'));
    });
  };
  try {
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    await f.click('Original A');
    await f.click('发送明确的新轮次');
    await f.edit('original explicit save', '当前会话私有草稿');
    await f.click('保留草稿');
    expect(f.writes().map((input) => input.revision)).toEqual([2]);
    await f.click('Other B');
    await act(async () => rejectWrite?.());
    expect(f.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'draft_storage_unavailable',
    );
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
  } finally {
    await act(async () => rejectWrite?.());
    await f.close();
  }
});

test('late saved prompt reads preserve newer input, including an explicitly empty draft', async () => {
  for (const text of ['new prompt 雪🙂', '']) {
    const f = fixture(true);
    const bridge = f.dom.window.kiteNative! as NativeBridge;
    const request = bridge.request;
    let release: (() => void) | undefined;
    bridge.request = async (input) => {
      const result = await request(input);
      if (input.method === 'draft.read' && input.sessionId === 'b')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return result;
    };
    try {
      await act(async () => f.root.render(<NativeDesktop />));
      await f.click('Original A');
      await f.click('Other B');
      expect(release).toBeDefined();
      expect(f.input('当前会话私有草稿')?.getAttribute('contenteditable')).toBe('true');
      await f.edit('an intermediate edit', '当前会话私有草稿');
      await f.edit(text, '当前会话私有草稿');
      await act(async () => release?.());
      expect(promptValue(f.input('当前会话私有草稿'))).toBe(text);
      bridge.request = request;
      await f.click('Original A');
      await f.click('Other B');
      expect(promptValue(f.input('当前会话私有草稿'))).toBe(text);
      expect(f.calls.some((call) => call.method === 'submit')).toBe(false);
    } finally {
      await act(async () => release?.());
      await f.close();
    }
  }
});

test('an accepted prompt is removed from its own cache after leaving, while unknown and rejected submissions retain it', async () => {
  for (const phase of [
    'accepted',
    'applied',
    'terminal',
    'submitting',
    'unknown',
    'failed',
    'rejected',
  ] as const) {
    const f = fixture(true);
    const bridge = f.dom.window.kiteNative! as NativeBridge;
    const request = bridge.request;
    let release: (() => void) | undefined;
    bridge.request = async (input) => {
      const result = await request(input);
      if (input.method !== 'submit') return result;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        sessionId: input.sessionId,
        intent: {
          kind: input.intent.kind,
          expectedStoreId: input.intent.expectedStoreId,
          commandId: input.intent.commandId,
        },
        phase,
      };
    };
    try {
      await act(async () => f.root.render(<NativeDesktop />));
      await f.click('Original A');
      await f.edit('original submitted prompt 雪🙂', '当前会话私有草稿');
      await f.click('发送明确的新轮次');
      expect(release).toBeDefined();
      await f.click('Other B');
      expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
      // One successful receipt also arrives after A has already become visible again.
      if (phase === 'applied') await f.click('Original A');
      await act(async () => release?.());
      if (phase !== 'applied') expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
      else expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
      await f.click('Original A');
      expect(promptValue(f.input('当前会话私有草稿'))).toBe(
        ['accepted', 'applied', 'terminal'].includes(phase) ? '' : 'original submitted prompt 雪🙂',
      );
      if (phase === 'unknown' || phase === 'failed' || phase === 'rejected') {
        const delivery = f.host.querySelector('.message.user .delivery-status');
        expect(delivery?.textContent).toBe(
          phase === 'unknown' ? '发送结果尚未确认。' : '发送失败，原文已保留。',
        );
        expect(delivery?.closest('.message.user')?.textContent).toContain(
          'original submitted prompt 雪🙂',
        );
        expect(f.host.querySelector('[role="alertdialog"]')).toBeNull();
      }
      expect(f.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
    } finally {
      await act(async () => release?.());
      await f.close();
    }
  }
});

test('ordinary saved input takes over its local user message only with matching Store Session and Run provenance', async () => {
  const f = fixture(true);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  let submitted: Extract<NativeRequest, { method: 'submit' }> | undefined;
  bridge.request = async (input) => {
    const result = await request(input);
    if (input.method !== 'submit') return result;
    submitted = input;
    return {
      sessionId: input.sessionId,
      intent: input.intent,
      phase: 'accepted',
    };
  };
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('ordinary original input 雪🙂', '当前会话私有草稿');
    await f.click('发送明确的新轮次');
    expect(submitted?.intent.kind).toBe('run.start');
    const commandId = submitted!.intent.commandId;
    const message: Message = {
      id: 'ordinary-saved-input',
      role: 'user',
      status: 'complete',
      sessionId: 'a',
      runId: 'ordinary-input-run',
      seq: '1',
      // Deliberately different text: takeover must follow identity, never text equality.
      content: 'durable original input 雪🙂',
      sourceIds: [commandId],
    };
    const run = {
      id: message.runId,
      sessionId: 'a',
      originStoreId: 'store',
      originCommandId: commandId,
      status: 'completed',
      isActive: false,
    } as Run;
    // Source IDs on a foreign Session cannot consume A's local projection.
    await f.publishMessages([{ ...message, sessionId: 'b' }], [{ ...run, sessionId: 'b' }]);
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelector('.message.user')!.textContent).toContain('ordinary original input');
    for (const unrelated of [
      { ...run, originStoreId: 'another-store' },
      { ...run, sessionId: 'b' },
      { ...run, id: 'another-run' },
      { ...run, originCommandId: 'another-command' },
    ]) {
      await f.publishMessages([message], [unrelated]);
      expect(f.host.querySelectorAll('.message.user')).toHaveLength(2);
      expect(f.host.body.textContent).toContain('ordinary original input');
      expect(f.host.body.textContent).toContain('durable original input');
    }
    await f.publishMessages([message], [run]);
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelector('.message.user')!.textContent).toContain('durable original input');
    expect(f.host.body.textContent).not.toContain('ordinary original input');
    expect(f.host.querySelector('.delivery-status')).toBeNull();
    expect(f.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
    await f.click('Other B');
    await f.click('Original A');
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelector('.message.user')!.textContent).toContain('durable original input');
    expect(f.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('an original pending input precedes its Run status and reply while saved user history is delayed', async () => {
  const f = fixture(true);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  let submitted: Extract<NativeRequest, { method: 'submit' }> | undefined;
  let release: (() => void) | undefined;
  bridge.request = async (input) => {
    const result = await request(input);
    if (input.method !== 'submit') return result;
    submitted = input;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { sessionId: input.sessionId, intent: input.intent, phase: 'accepted' };
  };
  const assertUserFirst = () => {
    const user = f.host.querySelector('.message.user');
    const turn = f.host.querySelector('.agent-turn');
    expect(user).not.toBeNull();
    expect(turn).not.toBeNull();
    expect(
      user!.compareDocumentPosition(turn!) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
  };
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('original before its reply', '当前会话私有草稿');
    await f.click('发送明确的新轮次');
    const commandId = submitted!.intent.commandId;
    const active = {
      id: 'early-observed-run',
      sessionId: 'a',
      originStoreId: 'store',
      originCommandId: commandId,
      status: 'running',
      isActive: true,
      createdAt: Date.now(),
      finishedAt: null,
    } as Run;
    // Main can observe a Run before either the submit response or user history arrives.
    await f.publishMessages([], [active]);
    assertUserFirst();
    await act(async () => release?.());
    assertUserFirst();
    const reply: Message = {
      id: 'early-observed-reply',
      role: 'assistant',
      status: 'complete',
      sessionId: 'a',
      runId: active.id,
      seq: '2',
      content: 'actual original reply',
    };
    await f.publishMessages([reply], [active]);
    assertUserFirst();
    expect(f.host.querySelector('.message.assistant')?.textContent).toContain(
      'actual original reply',
    );
    await f.publishMessages(
      [
        {
          id: 'late-saved-user',
          role: 'user',
          status: 'complete',
          sessionId: 'a',
          runId: active.id,
          seq: '1',
          content: submitted!.intent.content,
          sourceIds: [commandId],
        },
        reply,
      ],
      [{ ...active, status: 'completed', isActive: false, finishedAt: Date.now() }],
    );
    assertUserFirst();
    expect(f.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
  } finally {
    await act(async () => release?.());
    await f.close();
  }
});

for (const persistBetween of [false, true])
  test(`explicit steers keep delivery order through delayed history (${persistBetween ? 'prior steer saved' : 'both local'})`, async () => {
    const run = {
      id: 'original-steer-run',
      sessionId: 'a',
      originStoreId: 'store',
      originCommandId: 'original-work',
      status: 'running',
      isActive: true,
      createdAt: Date.now(),
      finishedAt: null,
    } as Run;
    const original: Message[] = [
      {
        id: 'original-work-user',
        role: 'user',
        status: 'complete',
        sessionId: 'a',
        runId: run.id,
        seq: '1',
        content: 'original work',
        sourceIds: [run.originCommandId],
      },
      {
        id: 'original-work-reply',
        role: 'assistant',
        status: 'complete',
        sessionId: 'a',
        runId: run.id,
        seq: '2',
        content: 'reply before explicit steers',
      },
    ];
    const f = fixture(true, true, 'accept_edits', { messages: original, runs: [run] });
    const bridge = f.dom.window.kiteNative! as NativeBridge;
    const request = bridge.request;
    const submitted: Extract<NativeRequest, { method: 'submit' }>[] = [];
    bridge.request = async (input) => {
      const result = await request(input);
      if (input.method === 'submit') {
        submitted.push(input);
        return { sessionId: input.sessionId, intent: input.intent, phase: 'accepted' };
      }
      if (result && 'selection' in result && result.selection)
        return {
          ...result,
          selection: {
            ...result.selection,
            activeCommand: {
              id: run.originCommandId,
              sessionId: 'a',
              originStoreId: 'store',
              kind: 'run.start',
              status: 'applied',
              receipt: { runId: run.id },
              cancelRequestedAt: null,
            },
          },
        };
      return result;
    };
    const savedSteer = (index: number): Message => ({
      id: `saved-steer-${index}`,
      role: 'user',
      status: 'complete',
      sessionId: 'a',
      runId: run.id,
      seq: String(index + 3),
      content: submitted[index]!.intent.content,
      sourceIds: [submitted[index]!.intent.commandId],
      originCommandId: submitted[index]!.intent.commandId,
    });
    const assertOrder = () => {
      expect(
        [...f.host.querySelectorAll('.message.user')].map((message) => message.textContent),
      ).toEqual(['original work', 'first explicit steer', 'second explicit steer']);
      const reply = f.host.querySelector('.message.assistant')!;
      const firstSteer = f.host.querySelectorAll('.message.user')[1]!;
      expect(
        reply.compareDocumentPosition(firstSteer) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    };
    try {
      await act(async () => f.root.render(<NativeDesktop />));
      await f.click('Original A');
      await f.edit('first explicit steer', '当前会话私有草稿');
      await f.click('引导当前轮次');
      expect(submitted[0]?.intent.kind).toBe('input.steer');
      if (persistBetween) await f.publishMessages([...original, savedSteer(0)], [run]);
      await f.edit('second explicit steer', '当前会话私有草稿');
      await f.click('引导当前轮次');
      expect(submitted[1]?.intent.kind).toBe('input.steer');
      assertOrder();
      await f.publishMessages([...original, savedSteer(0)], [run]);
      assertOrder();
      await f.publishMessages([...original, savedSteer(0), savedSteer(1)], [run]);
      assertOrder();
      expect(submitted).toHaveLength(2);
      expect(new Set(submitted.map((item) => item.intent.commandId)).size).toBe(2);
      for (const item of submitted)
        expect(
          f.calls.filter(
            (call) => call.method === 'submit' && call.intent.commandId === item.intent.commandId,
          ),
        ).toHaveLength(1);
      expect(f.host.querySelector('.delivery-status')).toBeNull();
    } finally {
      await f.close();
    }
  });

for (const admission of ['accepted', 'rejected'] as const)
  test(`Composer steer frozen to its original Run stays ${admission} when completion races admission, without implicit follow-up`, async () => {
    const run = {
      id: 'racing-run',
      sessionId: 'a',
      originStoreId: 'store',
      originCommandId: 'original-work',
      status: 'running',
      isActive: true,
      createdAt: 1,
      finishedAt: null,
    } as Run;
    const initial: Message = {
      id: 'original',
      sessionId: 'a',
      runId: run.id,
      seq: '1',
      role: 'user',
      status: 'complete',
      content: 'original work',
      sourceIds: ['original-work'],
    };
    const f = fixture(true, true, 'accept_edits', { runs: [run], messages: [initial] });
    const bridge = f.dom.window.kiteNative! as NativeBridge,
      request = bridge.request;
    let submitted: Extract<NativeRequest, { method: 'submit' }> | undefined;
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    bridge.request = async (input) => {
      if (input.method === 'submit') {
        f.calls.push(input);
        submitted = input;
        await held;
        return {
          sessionId: input.sessionId,
          intent: input.intent,
          phase: admission,
          ...(admission === 'rejected' ? { error: 'input_target_stopped' } : {}),
        };
      }
      const value = await request(input);
      if (value && 'selection' in value && value.selection)
        return {
          ...value,
          selection: {
            ...value.selection,
            activeCommand: {
              id: run.originCommandId,
              kind: 'run.start',
              sessionId: 'a',
              originStoreId: 'store',
              status: 'applied',
              receipt: { runId: run.id },
              cancelRequestedAt: null,
            },
          },
        };
      return value;
    };
    try {
      await act(async () => f.root.render(<NativeDesktop />));
      await f.click('Original A');
      const text = '原轮引导全文，结束竞态不能改投新轮。';
      await f.edit(text, '当前会话私有草稿');
      // Let the actual Composer dispatch while its own response is still held.
      const click = f.click('引导当前轮次');
      await click;
      expect(submitted?.intent).toMatchObject({
        kind: 'input.steer',
        targetRunId: run.id,
        content: text,
      });
      const terminal = { ...run, status: 'completed' as const, isActive: false, finishedAt: 2 };
      await f.publishMessages([initial], [terminal]);
      await act(async () => answer());
      if (admission === 'accepted') {
        await f.publishMessages(
          [
            initial,
            {
              id: 'persisted-guide',
              sessionId: 'a',
              runId: run.id,
              seq: '2',
              role: 'user',
              status: 'complete',
              content: text,
              inputKind: 'input.steer',
              originCommandId: submitted!.intent.commandId,
              sourceIds: [submitted!.intent.commandId],
            },
          ],
          [terminal],
        );
        expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
        const summary = f.host.querySelector<HTMLButtonElement>(
          '.agent-turn-summary[aria-expanded="false"]',
        );
        if (summary) await act(async () => summary.click());
        expect(f.host.querySelectorAll('article[data-input-kind="input.steer"]')).toHaveLength(1);
      } else {
        expect(promptValue(f.input('当前会话私有草稿'))).toBe(text);
        expect(f.host.querySelector('article[data-input-kind="input.steer"]')).toBeNull();
      }
      await f.refreshFacts();
      expect(f.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
      expect(
        f.calls.some((call) => call.method === 'submit' && call.intent.kind === 'input.follow_up'),
      ).toBe(false);
    } finally {
      answer();
      await f.close();
    }
  });

test('Composer steer lost after HTTP commit survives Session switch, original GET recovery and real Adapter handoff without duplicate POST', async () => {
  // The renderer/selection bridge is controlled; the input owner, HTTP, SQLite,
  // checkpoint and Model Adapter are real. This is not an Electron/Main claim.
  const rootPath = temporaryDirectory('kite-steering-handoff-');
  const store = await openSqliteStore({ dataRoot: rootPath, profile: 'controlled' });
  const storeId = (await store.getMetadata()).storeId;
  let releaseModel!: () => void, releaseLookup!: () => void, enterModel!: () => void;
  const modelEntered = new Promise<void>((resolve) => {
    enterModel = resolve;
  });
  const modelHeld = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const lookupHeld = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const fixed = createFixedModel([
    [
      { type: 'text_delta', text: '原请求已经派发' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [
      { type: 'text_delta', text: '后续请求已收到原引导全文' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const model: ModelAdapter = {
    async *stream(request, options) {
      const iterator = fixed.stream(request, options)[Symbol.asyncIterator]();
      const first = await iterator.next();
      enterModel();
      if (!first.done) yield first.value;
      if (fixed.requests.length === 1) await modelHeld;
      for (;;) {
        const event = await iterator.next();
        if (event.done) break;
        yield event.value;
      }
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: { authorize: async () => ({ allowed: true, revision: '1' }) },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'controlled',
    rootUri: pathToFileURL(rootPath).href,
  });
  for (const id of ['a', 'b'])
    await runtime.createSession({
      expectedStoreId: storeId,
      subjectId: 'owner',
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'w',
      title: id,
    });
  const service = await startService({
    runtime,
    profile: { dataRoot: rootPath, name: 'controlled', accessKey: 'owned' },
    subjectId: 'owner',
    buildId: 'steering-handoff',
  });
  let originalId = '',
    posts = 0,
    gets = 0;
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.text() : undefined;
      const intent = body ? JSON.parse(body) : undefined;
      if (intent?.kind === 'input.steer') {
        originalId = intent.commandId;
        posts++;
      }
      if (
        originalId &&
        request.method === 'GET' &&
        url.pathname.endsWith(`/commands/${originalId}`)
      ) {
        gets++;
        await lookupHeld;
      }
      const result = await fetch(`${service.endpoint}${url.pathname}${url.search}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${service.bootstrap.token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
      });
      if (intent?.kind === 'input.steer') {
        await result.arrayBuffer();
        expect((await store.getCommand(originalId))?.kind).toBe('input.steer');
        return new Response('owned lost receipt after durable commit', { status: 502 });
      }
      return result;
    },
  });
  const expected = {
    profile: service.bootstrap.profile,
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'commands', 'history'],
    instanceId: service.bootstrap.instanceId,
    buildId: service.bootstrap.buildId,
  };
  const control = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected,
  });
  const client = createClient({
    endpoint: `http://127.0.0.1:${relay.port}`,
    token: service.bootstrap.token,
    expected,
  });
  let dispose = () => {};
  let f: ReturnType<typeof fixture> | undefined;
  try {
    await control.connect();
    await client.connect();
    const inputs = new DesktopInput({ admittedClient: client });
    dispose = () => inputs.disposeObserver();
    await control.startRun('a', {
      expectedStoreId: storeId,
      commandId: 'original-work',
      kind: 'run.start',
      content: '原任务',
    });
    await Promise.race([
      modelEntered,
      Bun.sleep(3000).then(() => {
        throw Error('controlled_model_not_entered');
      }),
    ]);
    const view = await control.getView('a'),
      run = view.runs.find((item) => item.isActive)!;
    expect(run).toBeDefined();
    const work = await control.getCommand('original-work');
    f = fixture(true, true, 'accept_edits', {
      storeId,
      contextSelectionId: view.session.contextSelectionId!,
      runs: [run],
      messages: [...view.messages],
    });
    const bridge = f.dom.window.kiteNative! as NativeBridge,
      request = bridge.request;
    bridge.request = async (input) => {
      if (input.method === 'submit') {
        f!.calls.push(input);
        expect(input.intent.kind).toBe('input.steer');
        return inputMetadata(
          await inputs.steer(input.sessionId, input.intent as Parameters<DesktopInput['steer']>[1]),
        );
      }
      if (input.method === 'lookupInput') {
        f!.calls.push(input);
        return inputMetadata(await inputs.lookup(input.commandId));
      }
      const result = await request(input);
      if (result && 'generation' in result)
        return {
          ...result,
          inputSubmissions: inputs.submissions.map(inputMetadata),
          ...(result.selection
            ? {
                selection: {
                  ...result.selection,
                  activeCommand: result.selection.session.id === 'a' ? work : undefined,
                },
              }
            : {}),
        };
      return result;
    };
    await act(async () => f!.root.render(<NativeDesktop />));
    await f.until(() =>
      [...f!.host.querySelectorAll('button')].some((button) => button.textContent === 'Original A'),
    );
    await f.click('Original A');
    const body = '只补充原轮要求：完整雪🙂é\n第二段保留，不能重发。';
    await f.until(() => !!f!.host.querySelector('[aria-label="引导当前轮次"]'));
    await f.edit(body, '当前会话私有草稿');
    await f.click('引导当前轮次');
    await f.until(() => inputs.submissions[0]?.phase === 'unknown');
    expect(posts).toBe(1);
    expect((await store.getCommand(originalId))?.request).toMatchObject({
      content: body,
      targetRunId: run.id,
    });
    await f.click('Other B');
    await f.until(() => promptValue(f!.input('当前会话私有草稿')) === 'saved B');
    await f.edit('B 新草稿不得被 A 的回执清空', '当前会话私有草稿');
    await f.refreshFacts();
    await client.connect();
    const recovery = bridge.request({
      method: 'lookupInput',
      generation: 1,
      commandId: originalId,
    });
    await f.until(() => gets > 0);
    await act(async () => {
      releaseLookup();
      await recovery;
    });
    await f.until(() => inputs.submissions[0]?.phase === 'accepted');
    await f.refreshFacts();
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('B 新草稿不得被 A 的回执清空');
    releaseModel();
    await runtime.waitForCommand('original-work', { timeoutMs: 5000 });
    await runtime.waitForCommand(originalId, { timeoutMs: 5000 });
    const settled = await control.getView('a');
    const physical = settled.messages.filter((message) => message.originCommandId === originalId);
    expect(physical).toHaveLength(1);
    expect(physical[0]).toMatchObject({
      content: body,
      runId: run.id,
      sourceIds: [originalId],
      inputKind: 'input.steer',
    });
    expect(fixed.requests).toHaveLength(2);
    expect(
      fixed.requests[0]!.messages.filter((message) => message.sourceIds?.includes(originalId)),
    ).toHaveLength(0);
    expect(
      fixed.requests[1]!.messages.filter(
        (message) =>
          message.content === body &&
          JSON.stringify(message.sourceIds) === JSON.stringify([originalId]),
      ),
    ).toHaveLength(1);
    await f.publishMessages([...settled.messages], [...settled.runs]);
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('B 新草稿不得被 A 的回执清空');
    await f.click('Original A');
    const summary = f.host.querySelector<HTMLButtonElement>(
      '.agent-turn-summary[aria-expanded="false"]',
    );
    if (summary) await act(async () => summary.click());
    expect(
      [...f.host.querySelectorAll('article[data-input-kind="input.steer"]')].map((node) =>
        node.getAttribute('data-message-id'),
      ),
    ).toEqual([physical[0]!.id]);
    expect(posts).toBe(1);
    expect(f.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
  } finally {
    releaseLookup();
    releaseModel();
    dispose();
    await f?.close();
    relay.stop(true);
    await service.close();
    await runtime.close();
    rmSync(rootPath, { recursive: true, force: true });
  }
});

test('a later confirmed original receipt consumes only its submitted draft when another Session is visible', async () => {
  for (const source of ['input', 'caller'] as const) {
    for (const later of [undefined, '', 'newer draft after submission']) {
      const f = fixture(true);
      const bridge = f.dom.window.kiteNative! as NativeBridge;
      const request = bridge.request;
      let confirmed = false;
      let submission: NativeState['inputSubmissions'][number] | undefined;
      bridge.request = async (input) => {
        if (input.method === 'submit') {
          f.calls.push(input);
          submission = {
            sessionId: input.sessionId,
            intent: {
              kind: input.intent.kind,
              expectedStoreId: input.intent.expectedStoreId,
              commandId: input.intent.commandId,
            },
            phase: 'unknown',
          };
          return submission;
        }
        const value = await request(input);
        if (!value || !('generation' in value) || !submission) return value;
        return {
          ...value,
          inputSubmissions:
            source === 'input'
              ? [{ ...submission, phase: confirmed ? 'accepted' : 'unknown' }]
              : [],
          callerSubmissions:
            source === 'caller'
              ? [
                  {
                    scope: { storeId: 'store', workspaceId: 'w', sessionId: 'a' },
                    subjectId: 'local-user',
                    target: { kind: 'session', id: 'a' },
                    bodyDigest: '0'.repeat(64),
                    requestDigest: '0'.repeat(64),
                    request: submission.intent,
                    phase: confirmed ? 'applied' : 'unknown',
                  } as NonNullable<NativeState['callerSubmissions']>[number],
                ]
              : [],
        };
      };
      try {
        await act(async () => f.root.render(<NativeDesktop />));
        await f.click('Original A');
        await f.edit('original unknown input', '当前会话私有草稿');
        await f.click('发送明确的新轮次');
        expect(promptValue(f.input('当前会话私有草稿'))).toBe('original unknown input');
        if (later !== undefined) await f.edit(later, '当前会话私有草稿');
        await f.click('Other B');
        confirmed = true;
        await f.refreshFacts();
        expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
        await f.click('Original A');
        expect(promptValue(f.input('当前会话私有草稿'))).toBe(later ?? '');
        expect(f.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
      } finally {
        await f.close();
      }
    }
  }
});

test('looking up an original first submission cannot overwrite a later prompt in its created Session', async () => {
  for (const text of ['later prompt 雪🙂', '', 'original unknown first prompt']) {
    const f = fixture(true);
    const bridge = f.dom.window.kiteNative! as NativeBridge;
    const request = bridge.request;
    bridge.request = async (input) => {
      const result = await request(input);
      if (
        input.method === 'conversation.lookup' &&
        result &&
        'kind' in result &&
        result.kind === 'conversation'
      )
        return { ...result, phase: 'accepted', code: undefined };
      return result;
    };
    try {
      await act(async () => f.root.render(<NativeDesktop />));
      await f.click('在 Workspace 中新建对话');
      await f.edit('original unknown first prompt');
      await f.click('发送首条消息');
      await f.resolve('unknown');
      await f.edit('an intermediate later prompt', '当前会话私有草稿');
      await f.edit(text, '当前会话私有草稿');
      await f.until(() => f.calls.some((call) => call.method === 'conversation.lookup'));
      expect(f.host.body.textContent).not.toContain('查询原首次提交');
      expect(promptValue(f.input('当前会话私有草稿'))).toBe(text);
      expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
      expect(f.calls.filter((call) => call.method === 'conversation.lookup')).toHaveLength(1);
    } finally {
      await f.close();
    }
  }
});

for (const receiptSource of ['lookup', 'submit'] as const)
  for (const failedRead of ['directory', 'select'] as const)
    test(`a first accepted ${receiptSource} receipt completes its handoff after a lost ${failedRead} read without another submission`, async () => {
      const f = fixture(true);
      const bridge = f.dom.window.kiteNative! as NativeBridge;
      const request = bridge.request;
      let lookedUp = false,
        failNext = true,
        recovered = false;
      bridge.request = async (input) => {
        const result = await request(input);
        if (
          input.method === 'conversation.lookup' &&
          result &&
          'kind' in result &&
          result.kind === 'conversation'
        ) {
          lookedUp = true;
          return { ...result, phase: 'accepted', code: undefined };
        }
        if (
          input.method === 'conversation.send' &&
          result &&
          'kind' in result &&
          result.kind === 'conversation' &&
          'stage' in result &&
          result.phase === 'accepted'
        )
          lookedUp = true;
        if (lookedUp && input.method === failedRead) {
          if (failNext) {
            failNext = false;
            throw Error('fixture_first_handoff_read_lost');
          }
          recovered = true;
        }
        return result;
      };
      try {
        await act(async () => f.root.render(<NativeDesktop />));
        await f.click('在 Workspace 中新建对话');
        await f.edit('accepted original with a lost handoff read');
        await f.click('发送首条消息');
        const original = await f.resolve(
          receiptSource === 'lookup' ? 'unknown' : 'accepted',
          receiptSource === 'submit',
        );
        await f.until(() => recovered && !!f.input('当前会话私有草稿') && !f.input('新对话草稿'));
        expect(f.selected()).toBe(original.creation.sessionId);
        expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
        expect(f.host.querySelector('[role="alertdialog"]')).toBeNull();
        expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
        expect(f.calls.filter((call) => call.method === 'conversation.lookup')).toHaveLength(
          receiptSource === 'lookup' ? 1 : 0,
        );
        if (failedRead === 'select') {
          const reads = f.calls.filter((call) => call.method === 'select');
          expect(reads).toHaveLength(2);
          expect(reads[1]).toEqual(reads[0]);
        }
        await f.edit('a later editable prompt', '当前会话私有草稿');
        await f.until(() => {
          const send = f.host.querySelector<HTMLButtonElement>('[aria-label="发送明确的新轮次"]');
          return !!send && !send.disabled;
        });
      } finally {
        await f.close();
      }
    });

test('a held directory observation cannot block the accepted first Session handoff', async () => {
  const f = fixture(true);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  let lookedUp = false,
    directoryHeld = false,
    releaseDirectory!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseDirectory = resolve;
  });
  bridge.request = async (input) => {
    if (lookedUp && input.method === 'directory') {
      directoryHeld = true;
      await held;
    }
    const result = await request(input);
    if (
      input.method === 'conversation.lookup' &&
      result &&
      'kind' in result &&
      result.kind === 'conversation'
    ) {
      lookedUp = true;
      return { ...result, phase: 'accepted', code: undefined };
    }
    return result;
  };
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Workspace 中新建对话');
    await f.edit('original accepted message');
    await f.click('发送首条消息');
    const original = await f.resolve('unknown', false);
    await f.until(() => directoryHeld && !!f.input('当前会话私有草稿') && !f.input('新对话草稿'));
    expect(f.selected()).toBe(original.creation.sessionId);
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'conversation.lookup')).toHaveLength(1);
    await act(async () => releaseDirectory());
    expect(f.selected()).toBe(original.creation.sessionId);
  } finally {
    releaseDirectory();
    await f.close();
  }
});

test('querying a still unknown first creation cannot restore a preparation draft the user has cleared', async () => {
  const f = fixture(true);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  bridge.request = async (input) => {
    const result = await request(input);
    if (
      input.method === 'conversation.lookup' &&
      result &&
      'kind' in result &&
      result.kind === 'conversation'
    )
      return { ...result, phase: 'unknown', creation: undefined, code: undefined };
    return result;
  };
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Workspace 中新建对话');
    await f.edit('unknown first creation prompt');
    await f.click('发送首条消息');
    await f.resolve('unknown', false);
    expect(promptValue(f.input())).toBe('unknown first creation prompt');
    await f.edit('');
    await f.until(() => f.calls.some((call) => call.method === 'conversation.lookup'));
    expect(f.host.body.textContent).not.toContain('查询原首次提交');
    expect(promptValue(f.input())).toBe('');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'conversation.lookup')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('switching before React commits the latest edit preserves the actual prompt event', async () => {
  const f = fixture(true);
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('earlier prompt', '当前会话私有草稿');
    await act(async () => {
      await setPromptText(f.input('当前会话私有草稿')!, 'latest prompt 雪🙂');
      [...f.host.querySelectorAll<HTMLButtonElement>('.session-row')]
        .find((button) => button.textContent?.includes('Other B'))!
        .click();
    });
    await f.click('Original A');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('latest prompt 雪🙂');
    expect(f.calls.some((call) => call.method === 'submit')).toBe(false);
  } finally {
    await f.close();
  }
});

test('switching from a Session to global or project preparation retains the input and never inserts a model loading paragraph', async () => {
  const f = fixture(true);
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('会话中尚未发送的草稿', '当前会话私有草稿');
    const input = f.input('当前会话私有草稿')!,
      composer = input.closest('.composer');
    for (const entry of ['在 Workspace 中新建对话', '新对话', '在 Workspace 中新建对话']) {
      f.holdModels();
      await f.click(entry);
      expect(f.modelsHeld()).toBe(true);
      expect(f.input()).toBe(input);
      expect(input.closest('.composer')).toBe(composer);
      expect(input.getAttribute('contenteditable')).toBe('true');
      const picker = f.host.querySelector('[aria-label="下一轮模型选择"]')!;
      expect(picker.getAttribute('aria-busy')).toBe('true');
      expect(picker.querySelector('[role="status"]')).toBeNull();
      expect(f.host.body.textContent).not.toContain('正在读取可选模型');
      expect(picker.querySelector<HTMLButtonElement>('[data-model-trigger]')!.disabled).toBe(true);
      await f.edit('准备页独立草稿');
      expect(
        f.host.querySelector<HTMLButtonElement>('button[aria-label="发送首条消息"]')!.disabled,
      ).toBe(true);
      await f.releaseModels();
      expect(f.input()).toBe(input);
      expect(promptValue(input)).toBe('准备页独立草稿');
      expect(picker.hasAttribute('aria-busy')).toBe(false);
      expect(picker.querySelector<HTMLButtonElement>('[data-model-trigger]')!.disabled).toBe(false);
      await f.click('Original A');
      expect(f.input('当前会话私有草稿')).toBe(input);
      expect(promptValue(input)).toBe('会话中尚未发送的草稿');
    }
    expect(
      f.calls.some((call) =>
        ['conversation.send', 'submit', 'permission.mode'].includes(call.method),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('Session switches never revive the retired row highlight while the chosen conversation is loading', async () => {
  const f = fixture(true);
  const activeRows = () =>
    [...f.host.querySelectorAll('.session-row[aria-current="page"]')].map((row) =>
      row.getAttribute('aria-label'),
    );
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    expect(activeRows()).toEqual(['Original A']);
    for (const entry of [undefined, '新对话', '在 Workspace 中新建对话']) {
      await f.click('Original A');
      expect(activeRows()).toEqual(['Original A']);
      if (entry) {
        await f.click(entry);
        expect(activeRows()).toEqual([]);
      }
      f.holdSelection();
      await f.click('Other B');
      expect(activeRows()).toEqual([]);
      expect(f.host.querySelector('.session-row.selected')).toBeNull();
      await f.refreshWhileSelecting();
      expect(activeRows()).toEqual([]);
      await f.releaseSelection();
      expect(activeRows()).toEqual(['Other B']);
      expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
    }
    await f.click('Original A');
    f.holdSelection();
    await f.click('Other B');
    await f.click('Original A');
    expect(activeRows()).toEqual(['Original A']);
    await f.releaseSelection();
    expect(activeRows()).toEqual(['Original A']);
    expect(
      f.calls.some((call) =>
        ['submit', 'conversation.send', 'permission.mode'].includes(call.method),
      ),
    ).toBe(false);
  } finally {
    await f.releaseSelection();
    await f.close();
  }
});

for (const withHistory of [true, false]) {
  test(`a first Session selection waits for confirmed ${withHistory ? 'history' : 'empty history'} before showing content or an empty state`, async () => {
    const f = fixture(true, true, 'accept_edits', {
      withoutSelection: true,
      messages: withHistory
        ? [
            {
              id: 'saved-user-message',
              sessionId: 'a',
              runId: 'saved-run',
              seq: '1',
              role: 'user',
              status: 'complete',
              content: 'The original saved conversation',
            },
          ]
        : [],
    });
    const expectLoading = () => {
      expect(f.host.querySelector('.new-conversation-welcome') === null).toBe(true);
      expect(f.host.querySelector('.welcome') === null).toBe(true);
      expect(f.host.querySelector('.conversation-loading') !== null).toBe(true);
      expect(f.host.querySelector('.conversation-viewport')?.getAttribute('aria-busy')).toBe(
        'true',
      );
      expect(f.host.querySelector('.message.user') === null).toBe(true);
    };
    try {
      await act(async () => f.root.render(<NativeDesktop />));
      expect(f.host.querySelector('.new-conversation-welcome')).not.toBeNull();
      f.holdSelection();
      f.holdModels();
      f.holdHistory();
      await f.click('Original A');
      expectLoading();
      await f.refreshWhileSelecting();
      expectLoading();
      await f.releaseSelection();
      expect(f.modelsHeld()).toBe(true);
      expectLoading();
      await f.releaseModels();
      expectLoading();
      await f.releaseHistory();
      expect(f.host.querySelector('.conversation-loading')).toBeNull();
      expect(f.host.querySelector('.new-conversation-welcome')).toBeNull();
      if (withHistory) {
        expect(f.host.querySelector('.welcome')).toBeNull();
        expect(f.host.querySelector('.message.user')?.textContent).toContain(
          'The original saved conversation',
        );
      } else {
        expect(f.host.querySelector('.message.user')).toBeNull();
        expect(f.host.querySelector('.welcome')).not.toBeNull();
      }
      expect(f.calls.filter((call) => call.method === 'select')).toHaveLength(1);
      expect(
        f.calls.some((call) =>
          ['submit', 'conversation.send', 'permission.mode'].includes(call.method),
        ),
      ).toBe(false);
    } finally {
      await f.releaseSelection();
      await f.releaseModels();
      await f.releaseHistory();
      await f.close();
    }
  });
}

test('a held Session switch retains the current draft and controls until Main confirms the target, with writes gated', async () => {
  const f = fixture(true);
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('A own draft', '当前会话私有草稿');
    await f.click('Other B');
    await f.edit('B own draft', '当前会话私有草稿');
    await f.click('Original A');
    const input = f.input('当前会话私有草稿'),
      model = f.host.querySelector('[data-model-trigger]');
    f.holdSelection();
    await f.click('Other B');
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(promptValue(input)).toBe('A own draft');
    expect(input?.getAttribute('contenteditable')).toBe('false');
    expect(f.host.querySelector('.breadcrumb strong')?.textContent).toBe('Original A');
    expect(f.host.querySelector('[data-model-trigger]')).toBe(model);
    expect((model as HTMLButtonElement).disabled).toBe(true);
    await f.refreshWhileSelecting();
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(promptValue(input)).toBe('A own draft');
    expect(f.host.querySelector('[data-model-trigger]')).toBe(model);
    const send = f.host.querySelector<HTMLButtonElement>('button[aria-label="发送明确的新轮次"]')!;
    expect(send.disabled).toBe(true);
    await act(async () => send.click());
    await f.releaseSelection();
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(promptValue(input)).toBe('B own draft');
    expect(f.host.querySelector('[data-model-trigger]')).toBe(model);
    expect(
      f.calls.some((call) =>
        ['submit', 'conversation.send', 'permission.mode'].includes(call.method),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('settings replace the painted page without remounting its draft or re-reading the selected conversation', async () => {
  const f = fixture();
  async function openSettings() {
    await act(async () => {
      const trigger = f.host.querySelector<HTMLButtonElement>('button[aria-label="用户菜单"]')!;
      trigger.focus();
      trigger.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () => {
      const item = [...f.host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent === '设置',
      )!;
      expect(item).toBeDefined();
      item.click();
    });
  }
  const conversationReads = () =>
    f.calls.filter((call) => ['attach', 'select', 'messages', 'draft.read'].includes(call.method));
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('unsent settings draft 雪🙂', '当前会话私有草稿');
    const input = f.input('当前会话私有草稿')!;
    const page = f.host.querySelector<HTMLElement>('.client-panels')!;
    const reads = [...conversationReads()];
    await openSettings();
    expect(f.host.querySelector('.desktop-settings-dialog')).not.toBeNull();
    expect(page.style.opacity).toBe('0');
    expect(page.style.pointerEvents).toBe('none');
    expect(page.hasAttribute('inert')).toBe(true);
    expect(page.getAttribute('aria-hidden')).toBe('true');
    expect(f.host.querySelector('.fixed.inset-0')).toBeNull();
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(promptValue(input)).toBe('unsent settings draft 雪🙂');
    const modelReads = f.calls.filter((call) => call.method === 'settings.models.read').length;
    await f.click('模型');
    expect(f.calls.filter((call) => call.method === 'settings.models.read')).toHaveLength(
      modelReads + 1,
    );
    expect(f.host.querySelector('.settings-models .settings-model-provider')).not.toBeNull();
    expect(
      f.host.querySelector<HTMLInputElement>('[role="switch"][aria-label="启用模型 model"]')
        ?.checked,
    ).toBe(true);
    expect(f.host.querySelector('[aria-label="默认模型"]')?.textContent).toContain(
      'compatible · Model',
    );
    await f.click('返回应用');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(f.host.querySelector('.desktop-settings-dialog')).toBeNull();
    expect(f.host.querySelector('.client-panels')).toBe(page);
    expect(page.style.opacity).toBe('');
    expect(page.style.pointerEvents).toBe('');
    expect(page.hasAttribute('inert')).toBe(false);
    expect(page.hasAttribute('aria-hidden')).toBe(false);
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(promptValue(input)).toBe('unsent settings draft 雪🙂');
    expect(f.selected()).toBe('a');
    expect(conversationReads()).toEqual(reads);
    await openSettings();
    expect(f.calls.filter((call) => call.method === 'settings.models.read')).toHaveLength(
      modelReads + 2,
    );
    expect(f.host.querySelector('.settings-models .settings-model-provider')).not.toBeNull();
    await act(async () => {
      f.host.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(f.host.querySelector('.desktop-settings-dialog')).toBeNull();
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(promptValue(input)).toBe('unsent settings draft 雪🙂');
    expect(conversationReads()).toEqual(reads);
    expect(f.calls.some((call) => call.method === 'conversation.send')).toBe(false);
  } finally {
    await f.close();
  }
});

test('provider configuration uses the rightmost settings rail and Escape dismisses editor before settings', async () => {
  const f = fixture();
  const pressEscape = async () => {
    await act(async () => {
      f.host.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('provider settings draft', '当前会话私有草稿');
    const input = f.input('当前会话私有草稿');
    await act(async () => {
      const trigger = f.host.querySelector<HTMLButtonElement>('button[aria-label="用户菜单"]')!;
      trigger.focus();
      trigger.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () =>
      [...f.host.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === '设置')!
        .click(),
    );
    await f.click('提供商');
    await f.click('新增提供商');
    const shell = f.host.querySelector('.desktop-settings')!;
    const main = shell.querySelector('.settings-content')!;
    const rail = shell.querySelector('.settings-editor-panel')!;
    expect(rail.parentElement).toBe(main.parentElement);
    expect(rail).toBe(shell.lastElementChild!);
    expect(rail.querySelector('.right-sidebar form')).not.toBeNull();
    expect(main.querySelector('form')).toBeNull();
    expect(main.querySelectorAll('.provider-instance')).toHaveLength(0);
    expect(f.host.activeElement?.getAttribute('aria-label')).toBe('服务商预设');
    const preset = rail.querySelector<HTMLSelectElement>('[aria-label="服务商预设"]')!;
    expect(preset.tagName).toBe('SELECT');
    expect(preset.value).toBe('openai');
    expect(rail.querySelectorAll('.provider-preset')).toHaveLength(0);
    expect(rail.textContent).not.toContain('更换预设');
    expect(rail.textContent).not.toContain('提供商提交结果');
    const origin = [...main.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '新增提供商',
    )!;
    await pressEscape();
    expect(rail.querySelector('form')).toBeNull();
    expect(f.host.querySelector('.desktop-settings-dialog')).not.toBeNull();
    expect(f.host.activeElement).toBe(origin);
    await f.click('新增提供商');
    await f.click('模型');
    expect(rail.querySelector('form')).toBeNull();
    await f.click('提供商');
    expect(rail.querySelector('form')).toBeNull();
    await f.click('新增提供商');
    await f.click('返回应用');
    expect(f.host.querySelector('.settings-editor-panel')).toBeNull();
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(promptValue(input)).toBe('provider settings draft');
    expect(
      f.calls.some(
        (call) => call.method === 'settings.providers.save' || call.method === 'conversation.send',
      ),
    ).toBe(false);
    expect(
      f.calls.filter((call) => call.method === 'settings.providers.close').length,
    ).toBeGreaterThanOrEqual(3);
  } finally {
    await f.close();
  }
});

test('original current-Session permission menu uses the observed command, preserves drafts and scopes Full confirmation', async () => {
  const f = fixture(true, false);
  const permission = () => f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!;
  const mutations = () => f.calls.filter((call) => call.method === 'permission.mode');
  async function choose(index: number) {
    await act(async () => {
      permission().focus();
      permission().dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () => {
      const item = f.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[index]!;
      expect(item).toBeDefined();
      const mouseDown = new f.dom.window.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      item.dispatchEvent(mouseDown);
      expect(mouseDown.defaultPrevented).toBe(false);
      item.click();
    });
  }
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    expect(f.host.querySelector('.connection')).toBeNull();
    expect(f.host.querySelector('input[aria-label="先审核计划"]')).toBeNull();
    expect(f.host.body.textContent).not.toContain('会话工具');
    const ordinaryCalls = [...f.calls];
    await act(async () => f.root.render(<NativeDesktop testDiagnostics />));
    expect(f.host.querySelector('input[aria-label="先审核计划"]')).not.toBeNull();
    expect(f.calls).toEqual(ordinaryCalls);
    await f.edit('retained current draft 雪🙂', '当前会话私有草稿');
    expect(permission().getAttribute('aria-label')).toBe('Permission: Request Approval');
    expect(permission().disabled).toBe(false);
    expect(mutations()).toHaveLength(0);
    const tools = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '会话工具',
    )!;
    if (tools.getAttribute('aria-expanded') !== 'true') await f.click('会话工具');
    expect(f.host.querySelectorAll('input[name="permission-mode"]')).toHaveLength(0);
    expect(f.host.body.textContent).toContain('模式只读。');
    expect(
      [...f.host.querySelectorAll('button')].some(
        (button) => button.textContent === '信任所显示的范围',
      ),
    ).toBe(true);
    expect(mutations()).toHaveLength(0);
    f.trustWorkspace();
    await f.click('Other B');
    await f.click('Original A');
    expect(permission().disabled).toBe(false);
    expect(f.host.querySelectorAll('input[name="permission-mode"]')).toHaveLength(3);
    await choose(1);
    expect(permission().getAttribute('aria-label')).toBe('Permission: Auto');
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]).toMatchObject({
      generation: 1,
      observationId: 1,
      mode: 'auto',
      makeDefault: false,
    });
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('retained current draft 雪🙂');
    await choose(2);
    await f.click('Cancel');
    expect(mutations()).toHaveLength(1);
    await choose(2);
    await f.click('Other B');
    const staleConfirm = [...f.host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Enable Full',
    );
    if (staleConfirm) await act(async () => staleConfirm.click());
    expect(mutations()).toHaveLength(1);
    expect(permission().getAttribute('aria-label')).toBe('Permission: Auto');
    await choose(2);
    await f.click('Enable Full');
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1]).toMatchObject({ observationId: 2, mode: 'full', makeDefault: false });
    expect(permission().getAttribute('aria-label')).toBe('Permission: Full');
    await f.click('Original A');
    expect(permission().getAttribute('aria-label')).toBe('Permission: Auto');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('retained current draft 雪🙂');
    expect(
      f.calls.filter((call) =>
        ['submit', 'conversation.send', 'caller.submit'].includes(call.method),
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a held permission change preserves the send icon while genuine input submission shows sending', async () => {
  const f = fixture(true);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  let releasePermission!: () => void, releaseInput!: () => void;
  const permissionWait = new Promise<void>((resolve) => {
    releasePermission = resolve;
  });
  const inputWait = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  bridge.request = async (input) => {
    const value = await request(input);
    if (input.method === 'permission.mode') await permissionWait;
    if (input.method === 'submit') await inputWait;
    return value;
  };
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('stable send icon 雪🙂', '当前会话私有草稿');
    const input = f.input('当前会话私有草稿');
    const send = f.host.querySelector<HTMLButtonElement>('.composer-action[type="submit"]')!;
    const icon = () => [...send.querySelectorAll('path')].map((path) => path.getAttribute('d'));
    const initialIcon = icon();
    const edit = f.host.querySelector<HTMLButtonElement>('.space-new-session')!;
    const remove = f.host.querySelector<HTMLButtonElement>('.space-remove')!;
    expect(send.disabled).toBe(false);
    await act(async () => {
      const trigger = f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!;
      trigger.focus();
      trigger.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () =>
      f.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[1]!.click(),
    );
    expect(f.calls.filter((call) => call.method === 'permission.mode')).toHaveLength(1);
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('aria-busy')).toBeNull();
    expect(icon()).toEqual(initialIcon);
    expect(f.host.querySelector('.space-new-session')).toBe(edit);
    expect(f.host.querySelector('.space-remove')).toBe(remove);
    expect(edit.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    await act(async () => {
      send.click();
      edit.click();
      remove.click();
    });
    expect(f.selected()).toBe('a');
    expect(f.calls.some((call) => call.method === 'submit')).toBe(false);
    expect(f.calls.some((call) => call.method === 'workspace.remove')).toBe(false);
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(promptValue(input)).toBe('stable send icon 雪🙂');
    await act(async () => releasePermission());
    expect(send.disabled).toBe(false);
    expect(icon()).toEqual(initialIcon);
    expect(edit.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    await act(async () => send.click());
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('aria-busy')).toBe('true');
    expect(icon()).not.toEqual(initialIcon);
    await act(async () => send.click());
    expect(f.calls.filter((call) => call.method === 'submit')).toHaveLength(1);
    await act(async () => releaseInput());
    expect(send.hasAttribute('aria-busy')).toBe(false);
    expect(icon()).toEqual(initialIcon);
  } finally {
    await act(async () => {
      releasePermission();
      releaseInput();
    });
    await f.close();
  }
});

test('ordinary permission mode progress stays in its trigger while unknown and failed results retain recovery', async () => {
  const f = fixture(true);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  let rows: NativeState['permissionSubmissions'] = [];
  bridge.request = async (input) => {
    const value = await request(input);
    return input.method === 'state' && value && 'permissionSubmissions' in value
      ? { ...value, permissionSubmissions: rows }
      : value;
  };
  const mode: NativeState['permissionSubmissions'][number] = {
    sessionId: 'a',
    rootSessionId: 'a',
    workspaceId: 'w',
    kind: 'permission.mode',
    phase: 'saved',
    intent: {
      expectedStoreId: 'store',
      commandId: 'original-mode',
      mode: 'auto',
      makeDefault: false,
      ifRevision: '0',
      ifDefaultRevision: '0',
    },
  };
  const notice = () => f.host.querySelector<HTMLElement>('[aria-label="项目授权结果"]');
  const trigger = () => f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!;
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('stable permission draft 雪🙂', '当前会话私有草稿');
    const input = f.input('当前会话私有草稿');
    const conversation = f.host.querySelector('.conversation-viewport');
    for (const phase of ['saved', 'submitting', 'applied', 'unknown', 'failed'] as const) {
      rows = [
        { ...mode, phase, ...(phase === 'failed' ? { error: 'permission_fixture_failure' } : {}) },
      ];
      await f.refreshFacts();
      expect(notice()).toBeNull();
      const pending = ['saved', 'submitting', 'unknown'].includes(phase);
      expect(trigger().disabled).toBe(pending);
      expect(trigger().getAttribute('aria-busy')).toBe(pending ? 'true' : null);
      expect(f.input('当前会话私有草稿')).toBe(input);
      expect(promptValue(input)).toBe('stable permission draft 雪🙂');
      expect(f.host.querySelector('.conversation-viewport')).toBe(conversation);
      if (phase === 'unknown') {
        await f.until(() => f.calls.some((call) => call.method === 'lookupPermission'));
        expect(f.host.body.textContent).not.toContain('查询原权限选择');
        expect(f.calls.filter((call) => call.method === 'lookupPermission')).toEqual([
          { method: 'lookupPermission', generation: 1, commandId: 'original-mode' },
        ]);
      }
      if (phase === 'failed') expect(notice()).toBeNull();
    }
    for (const phase of ['saved', 'submitting'] as const) {
      rows = [
        {
          ...mode,
          kind: 'workspace.trust',
          phase,
          intent: {
            expectedStoreId: 'store',
            commandId: 'original-trust',
            trusted: true,
            ifRevision: '0',
            canonicalIdentity: 'a'.repeat(64),
            externalReadScopeDigest: 'b'.repeat(64),
          },
        },
      ];
      await f.refreshFacts();
      expect(notice()).toBeNull();
    }
    for (const foreign of [
      { sessionId: 'b' },
      { intent: { ...mode.intent, expectedStoreId: 'other' } },
    ]) {
      rows = [{ ...mode, phase: 'unknown', ...foreign }];
      await f.refreshFacts();
      expect(notice()).toBeNull();
    }
    expect(
      f.calls.filter((call) =>
        ['permission.mode', 'permission.trust', 'submit', 'conversation.send'].includes(
          call.method,
        ),
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('global preparation selects the default first space while project entries, manual choices and refresh keep their scope', async () => {
  const f = fixture();
  const project = () => f.host.querySelector<HTMLButtonElement>('[aria-label="项目空间"]')!;
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('新对话');
    expect(project().textContent).toBe('Workspace');
    expect(f.host.querySelector('[aria-label="分支"]')?.textContent).toBe('main');
    await f.edit('keep this preparation');
    await f.click('在 Ordinary directory 中新建对话');
    expect(project().textContent).toBe('Ordinary directory');
    await act(async () => {
      project().focus();
      project().dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () => {
      const item = [...f.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (element) => element.textContent === 'Workspace',
      );
      expect(item).toBeDefined();
      item!.click();
    });
    expect(project().textContent).toBe('Workspace');
    f.setWorkspaceOrder(['empty', 'w']);
    await f.refreshFacts();
    expect(project().textContent).toBe('Workspace');
    await f.click('Original A');
    await f.click('新对话');
    expect(project().textContent).toBe('Ordinary directory');
    expect(f.host.querySelector('[aria-label="分支"]')).toBeNull();
    expect(promptValue(f.input())).toBe('keep this preparation');
    expect(
      f.calls.filter((call) =>
        ['createSession', 'conversation.send', 'submit'].includes(call.method),
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('startup preparation selects the default first space after directory loading and leaves an empty directory unselected', async () => {
  for (const workspaceIds of [['empty', 'w'], []] as const) {
    const f = fixture(false, true, 'accept_edits', {
      withoutSelection: true,
      workspaceIds,
      holdDirectory: true,
    });
    try {
      await act(async () => f.root.render(<NativeDesktop />));
      expect(f.input()).toBeNull();
      expect(f.calls.some((call) => call.method === 'conversation.branch')).toBe(false);
      await f.releaseDirectory();
      expect(f.host.querySelector('[aria-label="项目空间"]')?.textContent).toBe(
        workspaceIds.length ? 'Ordinary directory' : '选择项目',
      );
      await f.edit('new preparation draft');
      expect(promptValue(f.input())).toBe('new preparation draft');
      expect(
        f.calls
          .filter((call) => call.method === 'conversation.branch')
          .map((call) => call.workspaceId),
      ).toEqual(workspaceIds.length ? ['empty'] : []);
      if (!workspaceIds.length)
        expect(
          f.host.querySelector<HTMLButtonElement>('[aria-label="发送首条消息"]')?.disabled,
        ).toBe(true);
      expect(
        f.calls.filter((call) =>
          ['createSession', 'conversation.send', 'submit'].includes(call.method),
        ),
      ).toHaveLength(0);
    } finally {
      await f.releaseDirectory();
      await f.close();
    }
  }
});

test('a pending default first space cannot override a later project entry and the default owns the first send', async () => {
  const f = fixture();
  const project = () => f.host.querySelector('[aria-label="项目空间"]')?.textContent;
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Ordinary directory 中新建对话');
    await f.edit('the original draft');
    f.holdBranch();
    await f.click('新对话');
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="发送首条消息"]')?.disabled).toBe(
      true,
    );
    await f.click('在 Ordinary directory 中新建对话');
    expect(project()).toBe('Ordinary directory');
    await f.releaseBranch();
    expect(project()).toBe('Ordinary directory');
    expect(promptValue(f.input())).toBe('the original draft');
    await f.click('新对话');
    expect(project()).toBe('Workspace');
    await f.click('发送首条消息');
    const send = f.calls.find((call) => call.method === 'conversation.send');
    expect(send?.creation.workspaceId).toBe('w');
    expect(send?.intent.content).toBe('the original draft');
    await f.resolve('accepted');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
  } finally {
    await f.releaseBranch();
    await f.close();
  }
});

test('original global/project preparation, suggestions and page navigation retain independent drafts with no empty creation', async () => {
  const f = fixture();
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('unsaved A\n雪🙂', '当前会话私有草稿');
    await f.click('新对话');
    expect(f.host.querySelector('.new-conversation-welcome')).not.toBeNull();
    await f.edit('prepare draft');
    await f.click('研究与理解资料');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(promptValue(f.input())).toBe('prepare draft\n研究与理解资料：');
    expect(f.host.activeElement).toBe(f.input());
    expect(f.dom.window.getSelection()?.isCollapsed).toBe(true);
    await f.click('新对话');
    expect(promptValue(f.input())).toBe('prepare draft\n研究与理解资料：');
    await f.click('在 Workspace 中新建对话');
    expect(f.host.querySelector('[aria-label="分支"]')?.textContent).toContain('main');
    expect(f.calls.filter((call) => call.method === 'conversation.models.read')).toHaveLength(1);
    await f.click('在 Ordinary directory 中新建对话');
    expect(f.host.querySelector('[aria-label="分支"]')).toBeNull();
    expect(f.calls.filter((call) => call.method === 'conversation.models.read')).toHaveLength(1);
    await f.click('安排任务');
    await f.click('返回新对话');
    expect(promptValue(f.input())).toBe('prepare draft\n研究与理解资料：');
    await f.click('Original A');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('unsaved A\n雪🙂');
    await f.click('Other B');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
    await f.click('Original A');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('unsaved A\n雪🙂');
    await f.click('新对话');
    expect(promptValue(f.input())).toBe('prepare draft\n研究与理解资料：');
    const permission = () => f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!;
    const chooseFull = async () => {
      await act(async () => {
        permission().focus();
        permission().dispatchEvent(
          new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      await act(async () => {
        const full = [...f.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
          (item) => item.textContent?.includes('Full permission'),
        )!;
        expect(full).toBeDefined();
        full.click();
      });
    };
    await chooseFull();
    expect(f.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Enable Full permission?',
    );
    await f.click('Cancel');
    expect(permission().getAttribute('aria-label')).toBe('Permission: Auto');
    await chooseFull();
    await f.click('Enable Full');
    expect(permission().getAttribute('aria-label')).toBe('Permission: Full');
    expect(
      f.calls.filter((call) =>
        ['createSession', 'conversation.send', 'submit'].includes(call.method),
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('first send clears and renders original text; late failure cannot steal another page, and retry keeps its created Session', async () => {
  const f = fixture();
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.click('在 Workspace 中新建对话');
    await f.edit('first raw\n雪🙂');
    await act(async () => {
      const send = f.host.querySelector<HTMLButtonElement>('[aria-label="发送首条消息"]')!;
      expect(send).not.toBeNull();
      send.click();
      send.click();
    });
    expect(promptValue(f.input())).toBe('');
    expect(f.host.querySelector('.delivery-status')).toBeNull();
    expect(f.host.body.textContent).toContain('first raw');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    expect(f.host.querySelector('.composer-action')!.getAttribute('aria-busy')).toBe('true');
    await f.click('Other B');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
    const send = await f.resolve('failed');
    expect(f.selected()).toBe('b');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
    expect(f.host.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => {
      const item = [...f.host.querySelectorAll<HTMLButtonElement>('.session-row')].find((item) =>
        item.textContent?.includes('新对话'),
      )!;
      item.click();
    });
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('first raw\n雪🙂');
    expect(f.calls.filter((call) => call.method === 'createSession')).toHaveLength(0);
    expect(send.creation.workspaceId).toBe('w');
    expect(send.creation.title).toBe('');
    expect(send.intent.modelId).toBe('model');
    await f.click('发送明确的新轮次');
    expect(f.host.querySelector('.composer-action')!.getAttribute('aria-busy')).toBe('true');
    const retry = [...f.calls]
      .reverse()
      .find((call) => call.method === 'conversation.send') as Extract<
      NativeRequest,
      { method: 'conversation.send' }
    >;
    expect(retry.creation).toEqual(send.creation);
    expect(retry.intent.commandId).not.toBe(send.intent.commandId);
    await f.resolve('accepted');
    expect(f.host.querySelector('.composer-action')!.hasAttribute('aria-busy')).toBe(false);
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
    expect(f.host.querySelector('.delivery-status')).toBeNull();
    expect(
      [...f.host.querySelectorAll('.message.user')].filter((message) =>
        message.textContent?.includes('first raw'),
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a completed first send preserves the scheduled page and returning enters its original Session directly', async () => {
  const f = fixture();
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Workspace 中新建对话');
    await f.edit('late accepted original');
    await f.click('发送首条消息');
    await f.click('安排任务');
    const send = await f.resolve('accepted');
    expect(f.selected()).toBe('a');
    expect(f.host.querySelector('.scheduled-page')).not.toBeNull();
    await f.click('返回新对话');
    expect(f.host.body.textContent).not.toContain('正在发送');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    expect(f.selected()).toBe(send.creation.sessionId);
    expect(f.host.body.textContent).not.toContain('已提交');
    expect(f.host.body.textContent).not.toContain('打开本次会话');
    expect(f.host.querySelector('.new-conversation-welcome')).toBeNull();
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
    expect(f.host.querySelectorAll('.delivery-status')).toHaveLength(0);
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('first submission keeps one readable pending message through delayed selection and history, then hands off without a loading or welcome flash', async () => {
  const f = fixture(true);
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.click('在 Workspace 中新建对话');
    expect(f.host.querySelector('.new-conversation-welcome')).not.toBeNull();
    await f.edit('original first message 雪🙂');
    await f.click('发送首条消息');
    const viewport = f.host.querySelector('.conversation-viewport'),
      pending = f.host.querySelector('.message.user');
    expect(pending?.textContent).toContain('original first message 雪🙂');
    expect(f.host.querySelector('.delivery-status')).toBeNull();
    f.holdSelection();
    f.holdHistory();
    await f.resolve('accepted');
    const expectPending = () => {
      expect(f.host.querySelector('.conversation-viewport') === viewport).toBe(true);
      expect(f.host.querySelector('.message.user') === pending).toBe(true);
      expect(pending!.isConnected).toBe(true);
      expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
      expect(f.host.querySelector('.new-conversation-welcome')).toBeNull();
      expect(f.host.querySelector('.conversation-loading')).toBeNull();
      expect(f.host.querySelector('.welcome')).toBeNull();
      expect(f.host.querySelector('.delivery-status')).toBeNull();
      expect(f.host.body.textContent).not.toContain('打开本次会话');
    };
    expectPending();
    await f.releaseSelection();
    expectPending();
    await f.releaseHistory();
    expect(f.host.querySelector('.conversation-viewport') === viewport).toBe(true);
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelector('.message.user')!.textContent).toContain(
      'original first message 雪🙂',
    );
    expect(f.host.querySelector('.delivery-status')).toBeNull();
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a saved first-created conversation waits for fresh grouping when its inactive caches are invalidated', async () => {
  const f = fixture(true);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  let historyEpoch = 0;
  let coldReturn = false;
  const metadata: { reader: 'runs' | 'tools'; release: () => void }[] = [];
  bridge.request = async (input) => {
    if (input.method === 'toolMessages.runs' || input.method === 'toolMessages.list') {
      f.calls.push(input);
      const scope = {
        generation: input.generation,
        storeId: 'store',
        sessionId: f.selected(),
        workspaceId: 'w',
        viewSelection: input.viewSelection,
        historyEpoch: input.historyEpoch,
      };
      const result =
        input.method === 'toolMessages.runs'
          ? {
              kind: 'toolMessages.runs' as const,
              readId: input.readId,
              scope,
              runs: f
                .snapshot()
                .runs.filter((run) => run.sessionId === scope.sessionId)
                .map((run) => ({
                  id: run.id,
                  originStoreId: 'store',
                  sessionId: run.sessionId,
                  status: 'completed' as const,
                  isActive: false,
                  createdAt: 1000,
                  finishedAt: 2000,
                  reason: null,
                })),
            }
          : {
              kind: 'toolMessages.page' as const,
              readId: input.readId,
              scope,
              entries: input.messageIds.map((messageId) => ({
                messageId,
                executionId: 'created-tool-execution',
                definitionId: 'task.spawn',
                definitionVersion: '1',
                status: 'succeeded' as const,
                resultRevision: '1',
              })),
            };
      if (!coldReturn) return result;
      return new Promise<NativeResult>((resolve) =>
        metadata.push({
          reader: input.method === 'toolMessages.runs' ? 'runs' : 'tools',
          release: () => resolve(result),
        }),
      );
    }
    const result = await request(input);
    if (
      (input.method === 'attach' || input.method === 'state' || input.method === 'select') &&
      result &&
      'generation' in result
    )
      return {
        ...result,
        historyEpoch,
        ...(result.selection
          ? { selection: { ...result.selection, runs: coldReturn ? [] : result.selection.runs } }
          : {}),
      };
    return result;
  };
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Workspace 中新建对话');
    await f.edit('Created first input remains immediate');
    await f.click('发送首条消息');
    expect(f.host.querySelector('.message.user')?.textContent).toContain(
      'Created first input remains immediate',
    );
    const send = await f.resolve('accepted');
    const saved = f.snapshot();
    const original = saved.messages[0]!;
    await f.publishMessages(
      [
        original,
        {
          ...original,
          id: 'created-tool',
          seq: '2',
          role: 'tool',
          sourceIds: ['created-tool-execution'],
          content: 'Saved child tool receipt',
        },
        {
          ...original,
          id: 'created-final',
          seq: '3',
          role: 'assistant',
          sourceIds: [],
          content: 'Saved final reply after creation',
        },
      ],
      saved.runs,
    );
    await f.until(() => !!f.host.querySelector('.agent-turn-final'));
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    await f.click('Other B');
    coldReturn = true;
    historyEpoch++;
    await f.refreshFacts();
    expect(f.selected()).toBe('b');
    f.holdHistory();
    await act(async () => {
      const row = f.host.querySelector<HTMLButtonElement>('.session-row[aria-label="新对话"]');
      expect(row).not.toBeNull();
      row!.click();
    });
    expect(f.selected()).toBe(send.creation.sessionId);
    // A saved first input must never return as an optimistic placeholder while
    // its uncached persisted history is still being read.
    expect(f.host.querySelector('.message') === null).toBe(true);
    expect(f.host.querySelector('.conversation-loading')).not.toBeNull();
    await f.releaseHistory();
    await f.until(
      () =>
        metadata.some((entry) => entry.reader === 'runs') &&
        metadata.some((entry) => entry.reader === 'tools'),
    );
    expect(f.selected()).toBe(send.creation.sessionId);
    expect(f.host.querySelector('.conversation-loading')).not.toBeNull();
    expect(f.host.querySelector('.message') === null).toBe(true);
    expect(f.host.querySelector('.agent-turn')).toBeNull();
    await act(async () =>
      metadata
        .filter((entry) => entry.reader === 'runs')
        .forEach((entry) => {
          entry.release();
        }),
    );
    expect(f.host.querySelector('.message') === null).toBe(true);
    expect(f.host.querySelector('.conversation-loading')).not.toBeNull();
    await act(async () =>
      metadata
        .filter((entry) => entry.reader === 'tools')
        .forEach((entry) => {
          entry.release();
        }),
    );
    await f.until(() => !!f.host.querySelector('.agent-turn-final'));
    expect(f.host.querySelector('.conversation-loading')).toBeNull();
    expect(f.host.querySelector('.agent-turn-final')?.textContent).toContain(
      'Saved final reply after creation',
    );
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'conversation.send')).toHaveLength(1);
  } finally {
    await f.close();
    await f.releaseHistory();
    for (const entry of metadata) entry.release();
  }
});

test('a public first input hands its optimistic bubble to processing then business history without duplicating it, including a cold mount', async () => {
  const text = 'One actual first input 雪🙂';
  const f = fixture(true, true, 'accept_edits', { firstHumanInput: true });
  let snapshot: ReturnType<typeof f.snapshot> | undefined;
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.click('在 Workspace 中新建对话');
    await f.edit(text);
    await f.click('发送首条消息');
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelector('.message.user')?.textContent).toContain(text);
    const send = await f.resolve('accepted');
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelector('.message.user')?.textContent).toContain(text);
    expect(f.host.querySelector('.message.user.sending')).toBeNull();

    const processing = f.snapshot();
    const businessId = `business-message-${send.intent.commandId}`;
    const businessRun = {
      ...processing.runs[0]!,
      id: `business-run-${send.intent.commandId}`,
      originCommandId: `business-${send.intent.commandId}`,
    };
    await f.publishMessages(
      [
        {
          ...processing.messages[0]!,
          humanInput: { ...processing.messages[0]!.humanInput!, duplicateOfMessageId: businessId },
        },
        {
          ...processing.messages[0]!,
          id: businessId,
          runId: businessRun.id,
          seq: '2',
          sourceIds: [businessRun.originCommandId],
          originCommandId: businessRun.originCommandId,
          inputKind: 'input.follow_up',
        },
      ],
      [...processing.runs, businessRun],
    );
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelector('.message.user')?.textContent).toContain(text);
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    snapshot = f.snapshot();
  } finally {
    await f.close();
  }

  const cold = fixture(true, true, 'accept_edits', {
    messages: snapshot!.messages.map((message) => ({ ...message, sessionId: 'a' })),
    runs: snapshot!.runs.map((run) => ({ ...run, sessionId: 'a' })),
  });
  try {
    await act(async () => cold.root.render(<NativeDesktop />));
    await cold.click('Original A');
    expect(cold.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(cold.host.querySelector('.message.user')?.textContent).toContain(text);
    expect(cold.calls.some((call) => ['conversation.send', 'submit'].includes(call.method))).toBe(
      false,
    );
  } finally {
    await cold.close();
  }
});

test('one human input keeps its original position before interpretation and business replies, including identical independent inputs and a cold mount', async () => {
  const text = 'Identical original input with complete attachment';
  const rows: Message[] = [];
  const expected: Message[] = [];
  for (const [index, tag] of ['first', 'second'].entries()) {
    const base = index * 4;
    const humanInput = { inputCommandId: `raw-${tag}`, publicCommandId: `public-${tag}` };
    const processing: Message = {
      id: `processing-${tag}`,
      seq: String(base + 1),
      sessionId: 'a',
      runId: null,
      role: 'user',
      status: 'complete',
      content: text,
      humanInput: { ...humanInput, duplicateOfMessageId: `business-${tag}` },
    };
    const interpretation: Message = {
      id: `interpretation-${tag}`,
      seq: String(base + 2),
      sessionId: 'a',
      runId: null,
      role: 'assistant',
      status: 'complete',
      content: `Interpretation reply for ${tag} input`,
    };
    const business: Message = {
      ...processing,
      id: `business-${tag}`,
      seq: String(base + 3),
      humanInput,
      sourceIds: [`business-command-${tag}`],
      originCommandId: `business-command-${tag}`,
      inputKind: 'input.follow_up',
      files: [{ name: `${tag}-complete.txt`, uri: `file:///workspace/${tag}-complete.txt` }],
    };
    const response: Message = {
      ...interpretation,
      id: `reply-${tag}`,
      seq: String(base + 4),
      content: `Business reply for ${tag} input`,
    };
    rows.push(processing, interpretation, business, response);
    expected.push(business, interpretation, response);
  }
  const projected = desktopConversationMessages(rows);
  // The complete actual business Message occupies the earlier display position;
  // its immutable identity, sequence, provenance and attachment references survive.
  expect(projected).toEqual(expected);
  expect(projected[0]).toBe(rows[2]);
  expect(projected[0]?.files).toEqual([
    { name: 'first-complete.txt', uri: 'file:///workspace/first-complete.txt' },
  ]);
  expect(projected[3]).toBe(rows[6]);
  const expectOrder = (host: Document) => {
    const visible = [...host.querySelectorAll('.message.user, .message.assistant')];
    expect(visible).toHaveLength(6);
    expect(
      visible.map((message) => (message.classList.contains('user') ? 'user' : 'assistant')),
    ).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant', 'assistant']);
    for (const [index, tag] of ['first', 'second'].entries()) {
      const start = index * 3;
      expect(visible[start]?.textContent).toContain(text);
      expect(visible[start + 1]?.textContent).toContain(`Interpretation reply for ${tag} input`);
      expect(visible[start + 2]?.textContent).toContain(`Business reply for ${tag} input`);
    }
  };
  const f = fixture(true, true, 'accept_edits');
  let snapshot: ReturnType<typeof f.snapshot> | undefined;
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.publishMessages(rows.slice(0, 2), []);
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelectorAll('.message.user, .message.assistant')[0]?.textContent).toContain(
      text,
    );
    await f.publishMessages(rows, []);
    expectOrder(f.host);
    snapshot = f.snapshot();
    expect(snapshot.messages).toEqual(rows);
  } finally {
    await f.close();
  }
  const cold = fixture(true, true, 'accept_edits', { messages: snapshot!.messages });
  try {
    await act(async () => cold.root.render(<NativeDesktop />));
    await cold.click('Original A');
    expectOrder(cold.host);
    expect(cold.calls.some((call) => ['conversation.send', 'submit'].includes(call.method))).toBe(
      false,
    );
    expect(cold.snapshot().messages).toEqual(rows);
  } finally {
    await cold.close();
  }
});

test('ordinary history preserves independent identical inputs and processing with clarification but no business message', async () => {
  const user = (id: string, seq: string, inputCommandId: string, content: string): Message => ({
    id,
    seq,
    sessionId: 'a',
    runId: null,
    role: 'user',
    status: 'complete',
    content,
    humanInput: { inputCommandId, publicCommandId: `public-${inputCommandId}` },
  });
  const f = fixture(true, true, 'accept_edits', {
    messages: [
      {
        ...user('processing-one', '1', 'raw-one', 'Identical actual input'),
        humanInput: {
          inputCommandId: 'raw-one',
          publicCommandId: 'public-raw-one',
          duplicateOfMessageId: 'business-one',
        },
      },
      user('business-one', '2', 'raw-one', 'Identical actual input'),
      user('business-two', '3', 'raw-two', 'Identical actual input'),
      user('processing-unresolved', '4', 'raw-three', 'Please clarify which work'),
      {
        id: 'clarification',
        seq: '5',
        sessionId: 'a',
        runId: null,
        role: 'assistant',
        status: 'complete',
        content: 'Which original work should receive this input?',
      },
      {
        ...user(
          'processing-with-unread-replacement',
          '6',
          'raw-four',
          'Retained while replacement is unavailable',
        ),
        humanInput: {
          inputCommandId: 'raw-four',
          publicCommandId: 'public-raw-four',
          duplicateOfMessageId: 'business-not-in-reading',
        },
      },
    ],
  });
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    const users = [...f.host.querySelectorAll('.message.user')];
    expect(users).toHaveLength(4);
    expect(
      users.filter((message) => message.textContent?.includes('Identical actual input')),
    ).toHaveLength(2);
    expect(
      users.filter((message) => message.textContent?.includes('Please clarify which work')),
    ).toHaveLength(1);
    expect(
      users.filter((message) =>
        message.textContent?.includes('Retained while replacement is unavailable'),
      ),
    ).toHaveLength(1);
    expect(f.host.querySelector('.message.assistant')?.textContent).toContain(
      'Which original work should receive this input?',
    );
    expect(f.calls.some((call) => ['conversation.send', 'submit'].includes(call.method))).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test('sealed Fork history combines only its own proven processing and business copies', async () => {
  const processing: Message = {
    id: 'fork-processing',
    sessionId: 'a',
    runId: null,
    seq: '1',
    role: 'user',
    status: 'complete',
    content: 'One original input in sealed history',
    originMessage: {
      storeId: 'source-store',
      sessionId: 'source-session',
      messageId: 'source-processing',
      runId: 'source-processing-run',
    },
    humanInput: {
      inputCommandId: 'source-input',
      publicCommandId: 'source-public',
      duplicateOfMessageId: 'fork-business',
    },
  };
  const business: Message = {
    ...processing,
    id: 'fork-business',
    seq: '2',
    originMessage: {
      ...processing.originMessage!,
      messageId: 'source-business',
      runId: 'source-business-run',
    },
    humanInput: { inputCommandId: 'source-input', publicCommandId: 'source-public' },
  };
  const f = fixture(true, true, 'accept_edits', { messages: [processing, business] });
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(1);
    expect(f.host.querySelector('.message.user')?.textContent).toContain(processing.content);
    await f.publishMessages(
      [
        processing,
        { ...business, originMessage: { ...business.originMessage!, storeId: 'foreign-store' } },
      ],
      [],
    );
    expect(f.host.querySelectorAll('.message.user')).toHaveLength(2);
    expect(f.calls.some((call) => ['conversation.send', 'submit'].includes(call.method))).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test('returning to a still-pending first submission enters the created Session when its original receipt arrives', async () => {
  const f = fixture();
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Workspace 中新建对话');
    await f.edit('original pending return');
    await f.click('发送首条消息');
    await f.click('安排任务');
    await f.click('返回新对话');
    expect(f.host.querySelector('.message.user')!.textContent).toContain('original pending return');
    const send = await f.resolve('accepted');
    expect(f.selected()).toBe(send.creation.sessionId);
    expect(f.host.querySelector('.new-conversation-welcome')).toBeNull();
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
    expect(f.host.querySelector('.delivery-status')).toBeNull();
    expect(f.host.body.textContent).not.toContain('打开本次会话');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('leaving a delayed first selection or history read preserves the newer Session and draft without replaying input', async () => {
  for (const delay of ['selection', 'history'] as const) {
    const f = fixture(true);
    try {
      await act(async () => f.root.render(<NativeDesktop />));
      await f.click('在 Workspace 中新建对话');
      await f.edit('original delayed first input');
      await f.click('发送首条消息');
      if (delay === 'selection') f.holdSelection();
      else f.holdHistory();
      await f.resolve('accepted');
      await f.click('Other B');
      expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
      if (delay === 'selection') await f.releaseSelection();
      else await f.releaseHistory();
      expect(f.selected()).toBe('b');
      expect(promptValue(f.input('当前会话私有草稿'))).toBe('saved B');
      expect(f.host.querySelector('.new-conversation-welcome')).toBeNull();
      expect(f.host.querySelector('.message.user')?.textContent ?? '').not.toContain(
        'original delayed first input',
      );
      expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    } finally {
      await f.close();
    }
  }
});

test('unknown first creation blocks resend and only queries original before an explicit same-Session retry', async () => {
  const f = fixture();
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Workspace 中新建对话');
    await f.edit('unknown raw');
    await f.click('发送首条消息');
    const send = await f.resolve('unknown', false);
    expect(promptValue(f.input())).toBe('unknown raw');
    expect(
      (f.host.querySelector('[aria-label="发送首条消息"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    await f.until(() => f.calls.some((call) => call.method === 'conversation.lookup'));
    expect(f.host.body.textContent).not.toContain('查询原首次提交');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'conversation.lookup')).toEqual([
      { method: 'conversation.lookup', generation: 1, commandId: send.intent.commandId },
    ]);
    expect(f.selected()).toBe(send.creation.sessionId);
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('unknown raw');
    await f.click('发送明确的新轮次');
    const retry = [...f.calls]
      .reverse()
      .find((call) => call.method === 'conversation.send') as Extract<
      NativeRequest,
      { method: 'conversation.send' }
    >;
    expect(retry.creation).toEqual(send.creation);
    expect(retry.intent.commandId).not.toBe(send.intent.commandId);
    expect(retry.intent.content).toBe('unknown raw');
    await f.resolve('accepted');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('a lost retry response restores original text and prevents a second input POST until its original is checked', async () => {
  const f = fixture();
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Workspace 中新建对话');
    await f.edit('retry original raw');
    await f.click('发送首条消息');
    const original = await f.resolve('failed');
    expect(f.host.querySelector('[role="alertdialog"]')).toBeNull();
    f.loseNextResponse();
    await f.click('发送明确的新轮次');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('retry original raw');
    expect(
      (f.host.querySelector('[aria-label="发送明确的新轮次"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(2);
    expect(f.host.querySelector('[role="alertdialog"]')).toBeNull();
    await f.until(() => f.calls.some((call) => call.method === 'conversation.lookup'));
    expect(f.host.body.textContent).not.toContain('查询原首次提交');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(2);
    expect(f.selected()).toBe(original.creation.sessionId);
    await f.click('发送明确的新轮次');
    const retry = [...f.calls]
      .reverse()
      .find((call) => call.method === 'conversation.send') as Extract<
      NativeRequest,
      { method: 'conversation.send' }
    >;
    expect(retry.creation).toEqual(original.creation);
    await f.resolve('accepted');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
  } finally {
    await f.close();
  }
});

test('Auto changes to Request Approval only through an explicit current Session choice', async () => {
  const f = fixture(true, true, 'auto');
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    const permission = f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!;
    expect(permission.getAttribute('aria-label')).toBe('Permission: Auto');
    expect(f.calls.filter((call) => call.method === 'permission.mode')).toHaveLength(0);
    await act(async () => {
      permission.focus();
      permission.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () => {
      const choices = f.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
      expect(choices).toHaveLength(3);
      choices[0]!.click();
    });
    expect(f.calls.filter((call) => call.method === 'permission.mode')).toEqual([
      expect.objectContaining({
        mode: 'accept_edits',
        makeDefault: false,
        generation: 1,
        observationId: 1,
      }),
    ]);
    expect(permission.getAttribute('aria-label')).toBe('Permission: Request Approval');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 20000);

test('first Session input stays in its created Session without a separate project scope confirmation or implicit retry', async () => {
  const f = fixture(true, false);
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('在 Workspace 中新建对话');
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    expect(f.calls.filter((call) => call.method === 'permission.trust')).toHaveLength(0);
    await f.edit('first input stays in its created Session');
    await f.click('发送首条消息');
    const original = await f.resolve('failed', true, 'workspace_trust_stale');
    expect(f.host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(f.selected()).toBe(original.creation.sessionId);
    expect(promptValue(f.input('当前会话私有草稿'))).toBe(original.intent.content);
    expect(f.host.querySelector('[aria-label="项目读取授权"]')).toBeNull();
    expect(f.host.body.textContent).not.toContain('确认项目读取范围');
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    expect(
      f.calls.filter(
        (call) => call.method === 'permission.trust' || call.method === 'permission.mode',
      ),
    ).toHaveLength(0);
    await f.click('发送明确的新轮次');
    const retry = f.calls.filter((call) => call.method === 'conversation.send').at(-1)!;
    expect(retry.creation).toEqual(original.creation);
    expect(retry.intent.content).toBe(original.intent.content);
    await f.resolve('accepted');
    expect(f.selected()).toBe(original.creation.sessionId);
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(2);
    expect(f.calls.filter((call) => call.method === 'permission.trust')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('opening an untrusted Session permits explicit mode selection without a scope dialog and preserves drafts across reopening', async () => {
  const f = fixture(true, false);
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('private A', '当前会话私有草稿');
    const permission = f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!;
    expect(permission.disabled).toBe(false);
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    expect(f.host.body.textContent).not.toContain('确认项目读取范围');
    expect(
      f.calls.filter((call) =>
        ['permission.trust', 'permission.mode', 'submit', 'conversation.send'].includes(
          call.method,
        ),
      ),
    ).toHaveLength(0);
    await act(async () => {
      permission.focus();
      permission.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () =>
      f.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[1]!.click(),
    );
    expect(f.calls.filter((call) => call.method === 'permission.mode')).toEqual([
      {
        method: 'permission.mode',
        generation: 1,
        observationId: 1,
        mode: 'auto',
        makeDefault: false,
      },
    ]);
    f.changeTrustScope('new exact external scope /host/changed');
    await f.refreshFacts();
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    await f.click('Other B');
    await f.edit('private B', '当前会话私有草稿');
    await f.click('Original A');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('private A');
    expect(f.host.querySelector('[data-permission-trigger]')?.getAttribute('aria-label')).toBe(
      'Permission: Auto',
    );
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    expect(f.host.body.textContent).not.toContain('确认项目读取范围');
    await f.click('Other B');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('private B');
    expect(
      f.calls.filter((call) =>
        ['permission.trust', 'submit', 'conversation.send'].includes(call.method),
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('persisted unknown or failed project access retains the original permission lookup without a scope dialog or implicit submission', async () => {
  const f = fixture(true, false);
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const request = bridge.request;
  let phase: 'unknown' | 'failed' = 'unknown';
  bridge.request = async (input) => {
    const result = await request(input);
    if (input.method !== 'state') return result;
    return {
      ...(result as NativeState),
      permissionSubmissions: [
        {
          sessionId: 'a',
          rootSessionId: 'a',
          workspaceId: 'w',
          kind: 'workspace.trust',
          phase,
          ...(phase === 'failed' ? { error: 'workspace_trust_stale' } : {}),
          intent: {
            expectedStoreId: 'store',
            commandId: 'original-trust',
            trusted: true,
            ifRevision: '0',
            canonicalIdentity: 'a'.repeat(64),
            externalReadScopeDigest: 'b'.repeat(64),
          },
        },
      ],
    } satisfies NativeState;
  };
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('unsent exact draft', '当前会话私有草稿');
    await f.refreshFacts();
    const notice = () => f.host.querySelector<HTMLElement>('[aria-label="项目授权结果"]');
    expect(notice()).toBeNull();
    expect(f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!.disabled).toBe(
      true,
    );
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    await f.until(() => f.calls.some((call) => call.method === 'lookupPermission'));
    expect(f.host.body.textContent).not.toContain('查询原权限选择');
    expect(f.calls.filter((call) => call.method === 'lookupPermission')).toEqual([
      { method: 'lookupPermission', generation: 1, commandId: 'original-trust' },
    ]);
    phase = 'failed';
    await f.refreshFacts();
    expect(notice()).toBeNull();
    expect(f.host.querySelector<HTMLButtonElement>('[data-permission-trigger]')!.disabled).toBe(
      false,
    );
    expect(f.host.body.textContent).not.toContain('original-trust');
    expect(f.host.body.textContent).not.toContain('确认项目读取范围');
    expect(promptValue(f.input('当前会话私有草稿'))).toBe('unsent exact draft');
    expect(
      f.calls.filter((call) =>
        ['permission.trust', 'permission.mode', 'submit', 'conversation.send'].includes(
          call.method,
        ),
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('MCP and Skills share the far-right settings rail, Escape closes details first, and tab changes preserve the conversation draft', async () => {
  const f = fixture();
  const bridge = f.dom.window.kiteNative! as NativeBridge;
  const originalRequest = bridge.request;
  bridge.request = async (input) => {
    const result = await originalRequest(input);
    if (input.method === 'attach' || input.method === 'state' || input.method === 'select') {
      const state = result as NativeState;
      return { ...state, selection: { ...state.selection!, canReadSkills: true } };
    }
    if (input.method === 'settings.mcp.read')
      return {
        kind: 'settings.mcp',
        observationId: 1,
        storeId: 'store',
        sessionId: f.selected(),
        workspaceId: 'w',
        canWrite: true,
        errors: [],
        servers: [
          {
            id: 'server',
            configDigest: 'a'.repeat(64),
            transport: 'http',
            source: { kind: 'programmatic', id: 'fixture', revision: '1' },
            admitted: true,
            selected: true,
            available: true,
            reason: null,
          },
        ],
        sources: [],
        nextAfterId: null,
        snapshots: [],
        nextAfterKey: null,
      };
    if (input.method === 'settings.skills.open')
      return {
        kind: 'settings.skills.page',
        readId: input.readId,
        scope: {
          generation: input.generation,
          viewSelection: input.viewSelection,
          historyEpoch: input.historyEpoch,
          storeId: 'store',
          sessionId: f.selected(),
          workspaceId: 'w',
        },
        page: {
          version: 1,
          storeId: 'store',
          workspaceId: 'w',
          revision: 'b'.repeat(64),
          availability: 'available',
          reason: null,
          entries: [
            {
              id: 'shell-skill',
              name: 'Shell Skill',
              description: 'Complete skill summary',
              version: 'c'.repeat(64),
              source: { scope: 'project', origin: '.agents' },
              enabled: true,
              state: 'available',
              reason: null,
              requiredCapabilities: [],
              missingCapabilities: [],
            },
          ],
          nextAfterId: null,
          complete: true,
        },
      };
    return result;
  };
  const pressEscape = async () => {
    await act(async () =>
      f.host.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  const openSettings = async () => {
    await act(async () => {
      const trigger = f.host.querySelector<HTMLButtonElement>('button[aria-label="用户菜单"]')!;
      trigger.focus();
      trigger.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await act(async () =>
      [...f.host.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === '设置')!
        .click(),
    );
  };
  const conversationReads = () =>
    f.calls.filter((input) =>
      ['attach', 'select', 'messages', 'draft.read'].includes(input.method),
    );
  try {
    await act(async () => f.root.render(<NativeDesktop />));
    await f.click('Original A');
    await f.edit('unchanged extension-settings draft 雪🙂', '当前会话私有草稿');
    const draft = f.input('当前会话私有草稿');
    const reads = [...conversationReads()];
    await openSettings();
    await f.click('MCP');
    const shell = () => f.host.querySelector('.desktop-settings')!;
    const main = () => shell().querySelector('.settings-content')!;
    const rail = () => shell().querySelector('.settings-editor-panel')!;
    expect(rail() === shell().lastElementChild).toBe(true);
    expect(rail().parentElement === main().parentElement).toBe(true);
    expect(main().querySelector('form, .right-sidebar')).toBeNull();
    expect(rail().childElementCount).toBe(0);
    await f.click('新增 MCP');
    expect(rail().querySelector('.right-sidebar form[aria-label="Add MCP source"]')).not.toBeNull();
    expect(main().querySelector('form')).toBeNull();
    expect(f.host.activeElement?.getAttribute('aria-label')).toBe('Name');
    await pressEscape();
    expect(rail().childElementCount).toBe(0);
    expect(f.host.activeElement?.textContent).toBe('新增 MCP');
    expect(f.host.querySelector('.desktop-settings-dialog')).not.toBeNull();
    await pressEscape();
    expect(f.host.querySelector('.desktop-settings-dialog')).toBeNull();
    await openSettings();
    await f.click('MCP');
    await f.click('新增 MCP');
    await f.click('Skills');
    expect(rail().childElementCount).toBe(0);
    expect(main().querySelector('[aria-label="Skills 目录"]')).not.toBeNull();
    await f.click('查看 Shell Skill 详情');
    expect(rail().querySelector('.right-sidebar h3')?.textContent).toBe('Shell Skill');
    expect(rail().textContent).toContain('Complete skill summary');
    expect(main().querySelector('.right-sidebar')).toBeNull();
    expect(rail().querySelector('form, input, textarea')).toBeNull();
    expect(f.host.activeElement?.tagName).toBe('H3');
    await pressEscape();
    expect(rail().childElementCount).toBe(0);
    expect(f.host.querySelector('.desktop-settings-dialog')).not.toBeNull();
    expect(f.host.activeElement?.getAttribute('aria-label')).toBe('查看 Shell Skill 详情');
    await f.click('查看 Shell Skill 详情');
    await f.click('MCP');
    expect(rail().childElementCount).toBe(0);
    await f.click('管理连接 server');
    expect(rail().querySelector('.right-sidebar[aria-label="MCP 连接详情"]')).not.toBeNull();
    await f.click('返回应用');
    expect(f.host.querySelector('.settings-editor-panel')).toBeNull();
    expect(f.input('当前会话私有草稿') === draft).toBe(true);
    expect(promptValue(draft)).toBe('unchanged extension-settings draft 雪🙂');
    expect(conversationReads()).toEqual(reads);
    expect(f.selected()).toBe('a');
    expect(
      f.calls.some((input) =>
        ['settings.mcp.submit', 'settings.mcp.cancel', 'conversation.send'].includes(input.method),
      ),
    ).toBe(false);
    expect(f.calls.some((input) => input.method === 'settings.mcp.close')).toBe(true);
    expect(f.calls.filter((input) => input.method === 'settings.skills.open')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.skills.close')).toHaveLength(1);
  } finally {
    await f.close();
  }
});
