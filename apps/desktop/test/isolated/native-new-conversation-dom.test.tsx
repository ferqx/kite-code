import { expect, test } from 'bun:test';
import type { Message, Run, Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeConversationResult,
  NativeRequest,
  NativeState,
} from '../../src/native-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

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
) {
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
    messages: Message[] = [],
    runs: Run[] = [],
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
    nextSeq: '0',
    deletedAt: null,
    controlRevision: '0',
    contextSelectionId: 'context',
  });
  const sessions = [session('a'), session('b')];
  const modes = new Map<string, 'accept_edits' | 'auto' | 'full'>([
    ['a', initialMode],
    ['b', 'auto'],
  ]);
  let selected = 'a',
    release: ((value: NativeConversationResult) => void) | undefined;
  let rejectNext = false;
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      storeId: 'store',
      canReadModelOutput: false,
      viewGeneration: 1,
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
                storeId: 'store',
                sessionId: selected,
                scopeSessionId: selected,
                mode: modes.get(selected) ?? 'auto',
                revision: '0',
                defaultMode: 'auto' as const,
                defaultRevision: '0',
              },
              trust: {
                storeId: 'store',
                workspaceId: 'w',
                status: trusted ? ('trusted' as const) : ('untrusted' as const),
                trusted,
                revision: '0',
                canonicalIdentity: 'a'.repeat(64),
                externalReadScopeDigest: 'b'.repeat(64),
                readScopes: [{ kind: 'workspace' as const, description: 'Workspace' }],
              },
            },
          }
        : {}),
    },
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      calls.push(input);
      if (input.method === 'attach' || input.method === 'state') return state();
      if (input.method === 'directory')
        return {
          storeId: 'store',
          sessions,
          workspaces: [
            { id: 'w', name: 'Workspace', rootUri: 'file:///workspace' },
            { id: 'empty', name: 'Ordinary directory', rootUri: 'file:///ordinary' },
          ],
        };
      if (input.method === 'select') {
        selected = input.sessionId;
        return state();
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
      if (input.method === 'messages')
        return {
          messages: messages.filter((message) => message.sessionId === input.sessionId),
          nextAfterSeq: null,
          highWaterSeq: sessions.find((session) => session.id === input.sessionId)?.nextSeq ?? '0',
        };
      if (input.method === 'draft.read')
        return {
          id: input.sessionId,
          storeId: 'store',
          workspaceId: 'w',
          rootSessionId: input.sessionId,
          revision: 1,
          content: drafts.get(input.sessionId) ?? '',
        };
      if (input.method === 'conversation.branch')
        return {
          kind: 'conversation.branch',
          storeId: 'store',
          workspaceId: input.workspaceId,
          repository: input.workspaceId === 'w',
          current: input.workspaceId === 'w' ? 'main' : undefined,
          branches: input.workspaceId === 'w' ? ['main', 'dev'] : [],
          label: input.workspaceId === 'w' ? 'main' : '本地目录',
        };
      if (input.method === 'conversation.models.read' || input.method === 'input.models.read')
        return {
          kind: 'settings.models',
          observationId: 1,
          scope: 'user',
          storeId: 'store',
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
      const input = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
      expect(input).not.toBeNull();
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  const input = (label = '新对话草稿') =>
    host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  return {
    dom,
    root,
    host,
    calls,
    click,
    edit,
    input,
    selected: () => selected,
    trustWorkspace: () => {
      trusted = true;
    },
    loseNextResponse: () => {
      rejectNext = true;
    },
    async resolve(phase: 'failed' | 'unknown' | 'accepted', created = true) {
      const send = [...calls]
        .reverse()
        .find((call) => call.method === 'conversation.send') as Extract<
        NativeRequest,
        { method: 'conversation.send' }
      >;
      if (created && !sessions.some((item) => item.id === send.creation.sessionId))
        sessions.push(session(send.creation.sessionId));
      if (phase === 'accepted') {
        const runId = `first-run-${send.intent.commandId}`;
        runs.push({
          id: runId,
          sessionId: send.creation.sessionId,
          originStoreId: 'store',
          originCommandId: send.intent.commandId,
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
          sourceIds: [send.intent.commandId],
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
          code: phase === 'failed' ? 'input_rejected' : undefined,
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
    expect(input.value).toBe('unsent settings draft 雪🙂');
    await f.click('返回应用');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(f.host.querySelector('.desktop-settings-dialog')).toBeNull();
    expect(f.host.querySelector('.client-panels')).toBe(page);
    expect(page.style.opacity).toBe('');
    expect(page.style.pointerEvents).toBe('');
    expect(page.hasAttribute('inert')).toBe(false);
    expect(page.hasAttribute('aria-hidden')).toBe(false);
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(input.value).toBe('unsent settings draft 雪🙂');
    expect(f.selected()).toBe('a');
    expect(conversationReads()).toEqual(reads);
    await openSettings();
    await act(async () => {
      f.host.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(f.host.querySelector('.desktop-settings-dialog')).toBeNull();
    expect(f.input('当前会话私有草稿')).toBe(input);
    expect(input.value).toBe('unsent settings draft 雪🙂');
    expect(conversationReads()).toEqual(reads);
    expect(f.calls.some((call) => call.method === 'conversation.send')).toBe(false);
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
    expect(permission().disabled).toBe(true);
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
    expect(f.input('当前会话私有草稿')?.value).toBe('retained current draft 雪🙂');
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
    expect(f.input('当前会话私有草稿')?.value).toBe('retained current draft 雪🙂');
    expect(
      f.calls.filter((call) =>
        ['submit', 'conversation.send', 'caller.submit'].includes(call.method),
      ),
    ).toHaveLength(0);
  } finally {
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
    expect(f.input()?.value).toBe('prepare draft\n研究与理解资料：');
    expect(f.host.activeElement).toBe(f.input());
    expect(f.input()?.selectionStart).toBe(f.input()?.value.length);
    await f.click('新对话');
    expect(f.input()?.value).toBe('prepare draft\n研究与理解资料：');
    await f.click('在 Workspace 中新建对话');
    expect(f.host.querySelector('[aria-label="分支"]')?.textContent).toContain('main');
    expect(f.calls.filter((call) => call.method === 'conversation.models.read')).toHaveLength(1);
    await f.click('在 Ordinary directory 中新建对话');
    expect(f.host.querySelector('[aria-label="分支"]')).toBeNull();
    expect(f.calls.filter((call) => call.method === 'conversation.models.read')).toHaveLength(1);
    await f.click('安排任务');
    await f.click('返回新对话');
    expect(f.input()?.value).toBe('prepare draft\n研究与理解资料：');
    await f.click('Original A');
    expect(f.input('当前会话私有草稿')?.value).toBe('unsaved A\n雪🙂');
    await f.click('Other B');
    expect(f.input('当前会话私有草稿')?.value).toBe('saved B');
    await f.click('Original A');
    expect(f.input('当前会话私有草稿')?.value).toBe('unsaved A\n雪🙂');
    await f.click('新对话');
    expect(f.input()?.value).toBe('prepare draft\n研究与理解资料：');
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
    expect(f.input()?.value).toBe('');
    expect(f.host.body.textContent).toContain('正在发送');
    expect(f.host.body.textContent).toContain('first raw');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    await f.click('Other B');
    expect(f.input('当前会话私有草稿')?.value).toBe('saved B');
    const send = await f.resolve('failed');
    expect(f.selected()).toBe('b');
    expect(f.input('当前会话私有草稿')?.value).toBe('saved B');
    await f.click('确定');
    await act(async () => {
      const item = [...f.host.querySelectorAll<HTMLButtonElement>('.session-row')].find((item) =>
        item.textContent?.includes('新对话'),
      )!;
      item.click();
    });
    expect(f.input('当前会话私有草稿')?.value).toBe('first raw\n雪🙂');
    expect(f.calls.filter((call) => call.method === 'createSession')).toHaveLength(0);
    expect(send.creation.workspaceId).toBe('w');
    expect(send.intent.modelId).toBe('model');
    await f.click('发送明确的新轮次');
    const retry = [...f.calls]
      .reverse()
      .find((call) => call.method === 'conversation.send') as Extract<
      NativeRequest,
      { method: 'conversation.send' }
    >;
    expect(retry.creation).toEqual(send.creation);
    expect(retry.intent.commandId).not.toBe(send.intent.commandId);
    await f.resolve('accepted');
    expect(f.input('当前会话私有草稿')?.value).toBe('');
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

test('a completed first send preserves the scheduled page and opens its original Session only on request', async () => {
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
    expect(f.host.body.textContent).toContain('已提交');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    await f.click('打开本次会话');
    expect(f.selected()).toBe(send.creation.sessionId);
    expect(f.host.querySelector('.new-conversation-welcome')).toBeNull();
    expect(f.input('当前会话私有草稿')?.value).toBe('');
    expect(f.host.querySelectorAll('.delivery-status')).toHaveLength(0);
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
  } finally {
    await f.close();
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
    expect(f.input()?.value).toBe('unknown raw');
    expect(
      (f.host.querySelector('[aria-label="发送首条消息"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    await f.click('查询原首次提交');
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'conversation.lookup')).toEqual([
      { method: 'conversation.lookup', generation: 1, commandId: send.intent.commandId },
    ]);
    expect(f.selected()).toBe(send.creation.sessionId);
    expect(f.input('当前会话私有草稿')?.value).toBe('unknown raw');
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
    expect(f.input('当前会话私有草稿')?.value).toBe('');
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
    await f.click('确定');
    f.loseNextResponse();
    await f.click('发送明确的新轮次');
    expect(f.input('当前会话私有草稿')?.value).toBe('retry original raw');
    expect(
      (f.host.querySelector('[aria-label="发送明确的新轮次"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(f.calls.filter((call) => call.method === 'conversation.send')).toHaveLength(2);
    await f.click('确定');
    await f.click('查询原首次提交');
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
    expect(f.input('当前会话私有草稿')?.value).toBe('');
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
