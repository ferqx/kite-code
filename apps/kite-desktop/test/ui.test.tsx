import { afterAll, afterEach, expect, test } from 'bun:test';
import type { AppMcpServer } from '@kite-ai/kite-app-contract';
import type { RuntimeSessionProjection } from '@kite-ai/runtime-contract';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { CommandResultUnknown, DesktopClient, type DesktopView } from '../src/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(dom.window, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  FormData: dom.window.FormData,
  Node: dom.window.Node,
  Element: dom.window.Element,
  DOMRect: dom.window.DOMRect,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
}
// React DOM must observe a DOM when it initializes its input event support.
const { createRoot } = await import('react-dom/client');
const { App } = await import('../src/App');
const { Settings } = await import('../src/Settings');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  window.sessionStorage.clear();
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function session(id: string, name = id): RuntimeSessionProjection {
  return {
    schema: 'kite.runtime-projection.v2',
    sessionId: id,
    displayName: name,
    revision: 1,
    lifecycle: 'open',
    workspace: '/project',
    workspaceDigest: 'sha256:project',
    updatedAt: '2026-09-08T06:00:00Z',
    interactionQueue: { revision: 1, interactions: [] },
  };
}

class UiClient extends DesktopClient {
  startupPhase:
    | 'inspecting'
    | 'acquiring_maintenance'
    | 'waiting_for_store'
    | 'preparing'
    | 'publishing'
    | 'ready'
    | null = null;
  startupMessage: string | null = null;
  diagnosticAvailable = false;
  diagnosticSaves = 0;
  view: DesktopView;
  listeners = new Set<() => void>();
  selectedIds: string[] = [];
  sent: string[] = [];
  sentTargets: Array<string | undefined> = [];
  cancelled = 0;
  approvals = 0;
  selectedModels: string[] = [];
  createdModels: Array<{ readonly provider: string; readonly name: string } | undefined> = [];
  sentModels: Array<{ readonly provider: string; readonly name: string } | undefined> = [];
  selectedModes: Array<{ sessionId: string; mode: 'accept_edits' | 'auto' | 'full' }> = [];
  mcpActions: string[] = [];
  created = 0;
  override async refreshProjects() {}
  override async restoreWorkspace() {}
  override async readStartupStatus() {
    return {
      phase: this.startupPhase,
      message: this.startupMessage,
      diagnosticAvailable: this.diagnosticAvailable,
    };
  }
  override async saveStartupDiagnostic() {
    this.diagnosticSaves++;
    return true;
  }
  override async refreshDirectory() {}
  override async prepareNewConversation() {}
  override async checkProject() {}
  override async queryProjectBranch(workspace: string) {
    return { ...this.view.branch!, workspace, root: workspace };
  }
  override async activateProject(path: string) {
    this.update({
      workspace: path,
      connected: true,
      selected: undefined,
      projection: undefined,
      branch: { ...this.view.branch!, workspace: path, root: path, current: 'main' },
    });
  }
  override async switchBranch(name: string) {
    this.update({ branch: { ...this.view.branch!, current: name } });
  }
  override async newSession(model?: { readonly provider: string; readonly name: string }) {
    this.created++;
    this.createdModels.push(model);
    const created = session(`created-${this.created}`);
    this.update({
      sessions: [...this.view.sessions, created],
    });
    return created.sessionId;
  }
  override async refreshMcp() {}
  override async refreshSkills() {}
  override async runMcpAction(_server: AppMcpServer, type: 'login' | 'reconnect' | 'cancel_auth') {
    this.mcpActions.push(type);
  }
  openedFiles: string[] = [];
  override async openFile(path: string) {
    this.openedFiles.push(path);
  }

  sendResult: () => Promise<void> = async () => {};
  constructor(count = 2) {
    super();
    const sessions = Array.from({ length: count }, (_, i) => session(`s${i}`, `工作 ${i}`));
    this.view = {
      workspace: '/project',
      connected: true,
      selected: 's0',
      sessions,
      projection: sessions[0],
      interactionMode: 'auto',
      messages: [],
      ready: true,
      loadingSession: false,
      hasLoadedHistory: true,
      branch: {
        workspace: '/project',
        repository: true,
        root: '/project',
        current: 'main',
        head: 'abc',
        branches: ['main', 'feature'],
        dirty: false,
        canSwitch: true,
      },
      models: {
        schema: 'kite.app.provider-model.snapshot-response.v1',
        workspace: {
          canonicalPath: '/project',
          projectId: 'project',
          workspaceDigest: 'sha256:project',
        },
        revision: '1',
        selected: { provider: 'test', name: 'model' },
        providers: [
          {
            provider: 'test',
            type: 'openai-compatible',
            readiness: 'ready',
            models: [
              { provider: 'test', name: 'model', isDefault: true },
              { provider: 'test', name: 'model-fast', isDefault: false },
            ],
          },
        ],
      },
      trust: {
        schema: 'kite.app.workspace-trust.query-response.v1',
        status: 'trusted',
        revision: '1',
        canDecide: false,
        workspace: {
          canonicalPath: '/project',
          projectId: 'project',
          workspaceDigest: 'sha256:project',
        },
        externalReadScope: { roots: [], digest: 'sha256:scope' },
      },
    };
  }
  override getSnapshot = () => this.view;
  override subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(change: Partial<DesktopView>) {
    this.view = { ...this.view, ...change };
    for (const listener of this.listeners) listener();
  }
  override clearError() {
    this.update({
      error: undefined,
      commandError: undefined,
      projectError: undefined,
      branchError: undefined,
    });
  }
  override report(error: unknown) {
    this.update({ error: String(error) });
  }
  override async selectSession(id: string) {
    this.selectedIds.push(id);
    this.update({
      selected: id,
      projection: (this.view.directory ?? this.view.sessions).find(
        (item) => item.sessionId === id,
      ) as RuntimeSessionProjection | undefined,
      messages: [],
    });
  }
  override async send(
    input: string,
    targetSessionId?: string,
    model?: { readonly provider: string; readonly name: string },
  ) {
    this.sent.push(input);
    this.sentTargets.push(targetSessionId);
    this.sentModels.push(model);
    await this.sendResult();
  }
  override async cancel() {
    this.cancelled++;
  }
  override async selectModel(provider: string, name: string) {
    this.selectedModels.push(`${provider}/${name}`);
    this.update({ models: { ...this.view.models!, selected: { provider, name } } });
  }
  override async setInteractionMode(sessionId: string, mode: 'accept_edits' | 'auto' | 'full') {
    this.selectedModes.push({ sessionId, mode });
    if (this.view.projection?.sessionId === sessionId) this.update({ interactionMode: mode });
  }
  override async respondApproval() {
    this.approvals++;
  }
}

async function render(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
}
function button(text: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) =>
      item.textContent?.trim() === text || item.getAttribute('aria-label')?.startsWith(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function input() {
  return document.querySelector<HTMLTextAreaElement>('[aria-label="任务输入"]')!;
}
async function write(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype =
    element.tagName === 'TEXTAREA'
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  await act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}
async function key(element: Element, value: string, options: KeyboardEventInit = {}) {
  await act(async () => {
    element.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
  });
}
async function openDropdown(element: Element) {
  await key(element, 'ArrowDown');
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

test('startup hides the main page until preparation settles and does not return on disconnect', async () => {
  const client = new UiClient();
  let finish!: () => void;
  client.restoreWorkspace = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  await render(<App client={client} />);
  expect(document.querySelector('[aria-label="kite 启动页"]')).not.toBeNull();
  expect(document.querySelector('.session-row')).toBeNull();
  expect(input()).toBeNull();
  await act(() => {
    window.dispatchEvent(new dom.window.Event('focus'));
  });
  await act(async () => {
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.querySelector('[aria-label="kite 启动页"]')).toBeNull();
  expect(document.querySelectorAll('.session-row')).toHaveLength(2);
  await write(input(), '保留草稿');
  await act(() => client.update({ connected: false, ready: false }));
  expect(document.querySelector('[aria-label="kite 启动页"]')).toBeNull();
  expect(input().value).toBe('保留草稿');
});

test('startup displays the validated preparation phase without offering unsafe cancellation', async () => {
  const client = new UiClient();
  client.startupPhase = 'waiting_for_store';
  client.startupMessage =
    '会话存储正由现有客户端或其他整理进程使用，正在自动重试；可以请求退出，超时后请按提示重试。';
  client.restoreWorkspace = () => new Promise<void>(() => undefined);
  await render(<App client={client} />);
  await act(() => Bun.sleep(250));
  const startup = document.querySelector('[aria-label="kite 启动页"]');
  expect(startup?.textContent).toContain('正在自动重试');
  expect(startup?.textContent).toContain('超时后请按提示重试');
  client.startupPhase = 'publishing';
  client.startupMessage = '正在提交并复核会话数据，请等待完成后退出；意外中断会在下次启动时接续。';
  await act(() => Bun.sleep(250));
  expect(startup?.textContent).toContain('正在提交并复核会话数据');
  expect(startup?.textContent).toContain('意外中断会在下次启动时接续');
  expect(startup?.textContent).not.toContain('取消整理');
});

test('failed startup offers native diagnostic save only when a validated report exists', async () => {
  const client = new UiClient();
  client.diagnosticAvailable = true;
  client.restoreWorkspace = async () => {
    throw new Error('STORE_CORRUPT');
  };
  await render(<App client={client} />);
  await act(() => Bun.sleep(250));
  expect(document.body.textContent).toContain('保存诊断');
  await click(button('保存诊断'));
  expect(client.diagnosticSaves).toBe(1);
});

test('composer selects a configured model and changes the current session permission', async () => {
  const client = new UiClient();
  await render(<App client={client} />);

  const model = document.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!;
  expect([...model.options].map((option) => option.text)).toEqual(['model', 'model-fast']);
  await choose(model, 'test\0model-fast');
  expect(client.selectedModels).toEqual([]);
  await write(input(), '使用会话模型');
  await key(input(), 'Enter');
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(client.sentModels).toEqual([{ provider: 'test', name: 'model-fast' }]);

  const permission = document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')!;
  expect([...permission.options].map((option) => option.text)).toEqual(['Ask', 'Auto', 'Full']);
  await choose(permission, 'accept_edits');
  expect(client.selectedModes).toEqual([{ sessionId: 's0', mode: 'accept_edits' }]);
  expect(permission.value).toBe('accept_edits');
});

test('the desktop sidebar can be reopened after it is collapsed', async () => {
  const client = new UiClient();
  await render(<App client={client} />);

  await click(button('收起侧栏'));
  expect(document.querySelector('.client-sidebar-panel')).toBeNull();

  const reopen = button('展开侧栏');
  expect(reopen.closest('.session-header')).not.toBeNull();
  await click(reopen);

  expect(document.querySelector('.client-sidebar-panel')).not.toBeNull();
  expect(button('收起侧栏').getAttribute('aria-expanded')).toBe('true');
});

test('permission submission keeps disabled composer selectors visually steady', async () => {
  const client = new UiClient();
  let finish!: () => void;
  client.setInteractionMode = async (sessionId, mode) => {
    client.selectedModes.push({ sessionId, mode });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    client.update({ interactionMode: mode });
  };
  await render(<App client={client} />);

  await choose(
    document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')!,
    'accept_edits',
  );
  const composer = document.querySelector<HTMLFormElement>('.composer')!;
  expect(composer.dataset.permissionPending).toBe('true');
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!.disabled).toBe(
    true,
  );
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')!.disabled).toBe(
    true,
  );

  await act(() => finish());
  expect(composer.dataset.permissionPending).toBeUndefined();
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!.disabled).toBe(
    false,
  );
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')!.disabled).toBe(
    false,
  );
});

test('new conversation applies its selected permission before sending the first message', async () => {
  const client = new UiClient();
  await render(<App client={client} />);
  await click(button('新对话'));
  await choose(
    document.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!,
    'test\0model-fast',
  );
  await choose(document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')!, 'full');
  expect(client.selectedModes).toEqual([]);
  await write(input(), '使用所选权限');
  await key(input(), 'Enter');
  expect(client.selectedModes).toEqual([{ sessionId: 'created-1', mode: 'full' }]);
  expect(client.createdModels).toEqual([{ provider: 'test', name: 'model-fast' }]);
  expect(client.sent).toEqual(['使用所选权限']);
});

test('new conversation does not send when its selected permission cannot be applied', async () => {
  const client = new UiClient();
  let fail = true;
  client.setInteractionMode = async () => {
    if (fail) throw new Error('权限切换失败');
  };
  await render(<App client={client} />);
  await click(button('新对话'));
  await write(input(), '不能越过权限失败');
  await key(input(), 'Enter');
  expect(client.sent).toEqual([]);
  expect(input().value).toBe('不能越过权限失败');
  expect(client.created).toBe(1);
  expect(client.view.selected).toBe('created-1');
  fail = false;
  await click(button('发送'));
  expect(client.created).toBe(1);
  expect(client.sent).toEqual(['不能越过权限失败']);
});

test('an unknown permission receipt stays bound to the created conversation', async () => {
  const client = new UiClient();
  let unknown = true;
  let attempts = 0;
  client.setInteractionMode = async () => {
    attempts++;
    if (!unknown) return;
    unknown = false;
    throw new CommandResultUnknown('权限切换结果未知', 'set_interaction_mode');
  };
  await render(<App client={client} />);
  await click(button('新对话'));
  await choose(document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')!, 'full');
  await write(input(), '复用已创建会话');
  await key(input(), 'Enter');
  await act(() => Bun.sleep(0));

  expect(client.created).toBe(1);
  expect(client.view.selected).toBe('created-1');
  expect(input().value).toBe('复用已创建会话');
  expect(document.body.textContent).not.toContain('发送结果待确认');
  await act(() => Bun.sleep(20));
  await click(button('关闭通知'));
  await click(button('发送'));
  expect(client.created).toBe(1);
  expect(attempts).toBe(2);
  expect(client.sentTargets).toEqual(['created-1']);
});

test('startup failure offers a retry and accepts an empty directory without creating a session', async () => {
  const client = new UiClient();
  let attempts = 0;
  client.restoreWorkspace = async () => {
    if (++attempts === 1) throw new Error('本地服务暂不可用');
    client.update({ directory: [], sessions: [], selected: undefined, workspace: '' });
  };
  await render(<App client={client} />);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('本地服务暂不可用');
  expect(input()).toBeNull();
  await click(button('重新尝试'));
  expect(attempts).toBe(2);
  expect(document.querySelector('[aria-label="kite 启动页"]')).toBeNull();
  expect(input()).not.toBeNull();
  expect(client.created).toBe(0);
  expect(client.sent).toEqual([]);
});

test('operation failures use a typed non-modal toast without taking composer focus', async () => {
  const client = new UiClient();
  await render(<App client={client} />);
  input().focus();
  await write(input(), '未发送草稿');
  await act(() => client.update({ commandError: 'Git 仓库无法读取，请检查仓库后重试。' }));
  await act(() => Bun.sleep(0));
  expect(client.view.commandError).toBe('Git 仓库无法读取，请检查仓库后重试。');
  await act(() => Bun.sleep(20));
  const alert = document.querySelector('[data-sonner-toast]');
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(alert?.textContent).toContain('错误 · 操作未完成');
  expect(alert?.closest('main')).not.toBeNull();
  expect(document.activeElement).toBe(input());
  expect(input().value).toBe('未发送草稿');
  expect(alert?.textContent).toContain('Git 仓库无法读取，请检查仓库后重试。');
  expect(document.querySelector('.notice.error')).toBeNull();
  await act(() => Bun.sleep(20));
  await click(button('关闭通知'));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await act(() => Bun.sleep(250));
  expect(client.view.commandError).toBeUndefined();
  expect(document.body.textContent).not.toContain('Git 仓库无法读取');
});

test('after startup can focus and draft before a project exists; setup preserves it without sending', async () => {
  const client = new UiClient();
  const connected = client.view;
  client.view = {
    workspace: '',
    connected: false,
    ready: false,
    loadingSession: false,
    hasLoadedHistory: false,
    sessions: [],
    messages: [],
  };
  await render(<App client={client} />);
  input().focus();
  expect(document.activeElement).toBe(input());
  await write(input(), '先记下我的需求');
  await key(input(), 'Enter');
  expect(client.sent).toEqual([]);
  expect(button('发送').disabled).toBe(true);
  expect(document.body.textContent).not.toContain('未连接');
  expect(document.body.textContent).not.toContain('连接已断开');
  await act(() =>
    client.update({ ...connected, selected: undefined, projection: undefined, ready: false }),
  );
  expect(input().value).toBe('先记下我的需求');
  expect(button('发送').disabled).toBe(false);
  expect(client.created).toBe(0);
  await act(() => client.update(connected));
  expect(input().value).toBe('先记下我的需求');
  expect(button('发送').disabled).toBe(false);
  await act(() => client.update({ connected: false, ready: false }));
  input().focus();
  expect(document.activeElement).toBe(input());
  await write(input(), '断开后仍可编辑');
  await key(input(), 'Enter');
  expect(client.sent).toEqual([]);
  expect(document.body.textContent).not.toMatch(
    /重新连接|断开连接|连接中断|暂时无法发送|正在准备会话|正在准备项目/,
  );
  expect(button('发送').disabled).toBe(true);
  await act(() => client.update({ connected: true, ready: true }));
  expect(input().value).toBe('断开后仍可编辑');
});

test('global new conversation preserves existing drafts, appends suggestions and creates only on first send', async () => {
  const client = new UiClient();
  await render(<App client={client} />);
  await write(input(), '已有会话草稿');
  const primaryNavigation = button('新对话').closest('.primary-navigation');
  expect(primaryNavigation).not.toBeNull();
  expect(
    [...(primaryNavigation?.querySelectorAll('button') ?? [])].map((item) => item.textContent),
  ).toEqual(['新对话', '工作台', '安排任务']);
  await click(button('新对话'));
  expect(document.querySelector('[aria-label="新对话"]')).not.toBeNull();
  expect(document.querySelector('.breadcrumb')?.textContent).toBe('新对话');
  expect(document.querySelector('.session-row[aria-current]')).toBeNull();
  expect(client.created).toBe(0);
  await write(input(), '我的新需求');
  await click(button('研究与理解资料'));
  expect(input().value).toBe('我的新需求\n研究与理解资料：');
  expect(document.activeElement).toBe(input());
  await click(button('新对话'));
  expect(input().value).toBe('我的新需求\n研究与理解资料：');
  await click(document.querySelector<HTMLElement>('.session-row')!);
  expect(input().value).toBe('已有会话草稿');
  await click(button('新对话'));
  expect(input().value).toBe('我的新需求\n研究与理解资料：');
  let reject!: (error: Error) => void;
  client.sendResult = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  await key(input(), 'Enter');
  await key(input(), 'Enter');
  expect(client.created).toBe(1);
  expect(client.sent).toHaveLength(1);
  expect(document.querySelector('[aria-label="新对话"]')).toBeNull();
  expect(input().value).toBe('');
  expect(document.querySelectorAll('[aria-label="用户消息"]')).toHaveLength(1);
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain('正在发送');
  await write(input(), '发送期间写下的新草稿');
  await act(() => reject(new Error('首次发送失败')));
  expect(input().value).toBe('我的新需求\n研究与理解资料：\n发送期间写下的新草稿');
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain('发送失败');
  await write(input(), '改写后的新需求');
  client.sendResult = async () => {};
  await click(button('发送'));
  expect(client.created).toBe(1);
  expect(input().value).toBe('');
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain(
    '改写后的新需求',
  );
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).not.toContain(
    '我的新需求',
  );
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain('正在发送');
  await act(() =>
    client.update({
      messages: [
        {
          id: 'runtime-user',
          role: 'user',
          text: '改写后的新需求',
          settled: true,
        },
        { id: 'first-reply', role: 'assistant', text: '已经收到', settled: false },
      ],
    }),
  );
  expect(
    Array.from(document.querySelectorAll('.message')).map((message) => message.textContent),
  ).toEqual([expect.stringContaining('改写后的新需求'), expect.stringContaining('已经收到')]);
  await act(() => Bun.sleep(320));
  expect(document.querySelectorAll('[aria-label="用户消息"]')).toHaveLength(1);
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).not.toContain('正在发送');
});

test('scheduled tasks opens below workbench and exposes an honest creation draft', async () => {
  const client = new UiClient();
  await render(<App client={client} />);
  await click(button('安排任务'));
  expect(document.querySelector('[aria-label="安排任务"]')).not.toBeNull();
  expect(document.querySelector('.breadcrumb')?.textContent).toBe('安排任务');
  expect(document.body.textContent).toContain('还没有安排任务');
  await click(button('创建第一个任务'));
  expect(document.querySelector('.right-sidebar[aria-label="新建安排任务"]')).not.toBeNull();
  expect(document.querySelectorAll('[data-panel]')).toHaveLength(3);
  expect(document.querySelectorAll('[role="separator"]')).toHaveLength(2);
  expect(document.querySelector('[aria-label="安排任务"]')).not.toBeNull();
  expect(document.querySelector<HTMLInputElement>('[aria-label="名称"]')).not.toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="任务说明"]')).not.toBeNull();
  expect(document.body.textContent).toContain('详情');
  expect(document.body.textContent).toContain('频率');
  expect(button('保存任务').disabled).toBe(true);
  expect(document.body.textContent).toContain('尚未接入任务保存与后台运行');
  await click(button('工作台'));
  expect(document.querySelector('[aria-label="工作台"]')).not.toBeNull();
});

test('first send keeps existing session navigation available and stays bound to the created session', async () => {
  const client = new UiClient();
  let finish!: () => void;
  client.sendResult = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  await render(<App client={client} />);
  await click(button('新对话'));
  await write(input(), '后台开始的新任务');
  await key(input(), 'Enter');

  const rows = [...document.querySelectorAll<HTMLButtonElement>('.session-row')];
  expect(rows.every((row) => !row.disabled)).toBe(true);
  expect(client.sentTargets).toEqual(['created-1']);
  expect(document.querySelector('[aria-label="新对话"]')).toBeNull();
  expect(document.querySelector('.session-row[aria-current="page"]')?.textContent).toContain(
    'created-1',
  );
  await click(button('工作 1'));
  expect(client.selectedIds.at(-1)).toBe('s1');
  expect(document.querySelector('.session-row[aria-current="page"]')?.textContent).toContain(
    '工作 1',
  );

  await act(() => finish());
  expect(client.sentTargets).toEqual(['created-1']);
});

test('first send keeps its draft stable before the created session reaches the directory', async () => {
  class DelayedDirectoryClient extends UiClient {
    letSelectionFinish?: () => void;

    override async newSession(): Promise<string> {
      this.created++;
      return `created-${this.created}`;
    }

    override async selectSession(id: string) {
      this.selectedIds.push(id);
      this.update({
        selected: id,
        projection: undefined,
        messages: [],
        hasLoadedHistory: false,
        loadingSession: true,
      });
      await new Promise<void>((resolve) => {
        this.letSelectionFinish = resolve;
      });
    }
  }

  const client = new DelayedDirectoryClient();
  await render(<App client={client} />);
  await click(button('新对话'));
  await write(input(), '目录刷新前也要保持稳定');
  await key(input(), 'Enter');

  expect(document.querySelector('[aria-label="新对话"]')).toBeNull();
  expect(input().value).toBe('');
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain(
    '目录刷新前也要保持稳定',
  );
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain('正在发送');
  expect(document.querySelector('.conversation')?.textContent).not.toContain('正在加载会话历史');

  await act(() => client.letSelectionFinish?.());
  expect(document.querySelector('.conversation')?.textContent).not.toContain('从一个想法开始');
  expect(document.querySelector('.conversation')?.textContent).not.toContain('描述你的目标');
});

test('first send stays out of another session while conversation preparation is pending', async () => {
  const client = new UiClient();
  let finishPreparation!: () => void;
  client.prepareNewConversation = () =>
    new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
  await render(<App client={client} />);
  await click(button('新对话'));
  await write(input(), '只属于新会话');
  await key(input(), 'Enter');
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain('只属于新会话');
  await click(button('工作 1'));
  expect(document.querySelector('[aria-label="用户消息"]')).toBeNull();
  expect(document.querySelector('.conversation')?.textContent).not.toContain('只属于新会话');
  await act(async () => {
    finishPreparation();
    await Bun.sleep(10);
  });
});

test('draft typed while the first conversation is being created migrates to that session', async () => {
  const client = new UiClient();
  let finishPreparation!: () => void;
  client.prepareNewConversation = () =>
    new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
  await render(<App client={client} />);
  await click(button('新对话'));
  await write(input(), '先发送这一条');
  await key(input(), 'Enter');
  await write(input(), '创建期间继续写的草稿');
  await act(async () => {
    finishPreparation();
    await Bun.sleep(10);
  });
  expect(input().value).toBe('创建期间继续写的草稿');
  expect(client.sent).toEqual(['先发送这一条']);
});

test('unknown create receipt binds recovery to the generated session without creating twice', async () => {
  class UnknownCreateClient extends UiClient {
    override async newSession(): Promise<string> {
      this.created++;
      const created = session(`created-${this.created}`);
      this.update({
        selected: created.sessionId,
        sessions: [...this.view.sessions, created],
        projection: undefined,
        messages: [],
        ready: false,
      });
      const error = new CommandResultUnknown('创建结果未知');
      error.sessionId = created.sessionId;
      throw error;
    }

    override async selectSession(id: string) {
      await super.selectSession(id);
      this.update({ ready: true, loadingSession: false });
    }
  }

  const client = new UnknownCreateClient();
  await render(<App client={client} />);
  await click(button('新对话'));
  await write(input(), '保持同一个会话');
  await key(input(), 'Enter');
  await act(() => Bun.sleep(0));
  expect(client.created).toBe(1);
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain(
    '发送结果待确认',
  );
  expect(input().value).toBe('保持同一个会话');
  expect(button('发送').disabled).toBe(true);
  await act(() => Bun.sleep(20));
  await click(button('关闭通知'));
  expect(client.selectedIds.at(-1)).toBe('created-1');
  expect(client.created).toBe(1);
  expect(button('发送').disabled).toBe(false);
  client.sendResult = async () => {
    throw new CommandResultUnknown('恢复结果未知', 'resume_session');
  };
  await click(button('发送'));
  expect(input().value).toBe('保持同一个会话');
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain('发送失败');
  expect(button('发送').disabled).toBe(false);
});

test('unknown turn receipt cannot be retried until runtime state reconciles it', async () => {
  const client = new UiClient();
  client.sendResult = async () => {
    throw new CommandResultUnknown('发送结果未知');
  };
  await render(<App client={client} />);
  await click(button('新对话'));
  await write(input(), '不要重复执行');
  await key(input(), 'Enter');
  expect(input().value).toBe('');
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain(
    '发送结果待确认',
  );
  expect(button('发送').disabled).toBe(true);
  await act(() =>
    client.update({
      messages: [
        { id: 'accepted', role: 'user', text: '不要重复执行', settled: true },
        { id: 'reply', role: 'assistant', text: '已经开始', settled: false },
      ],
    }),
  );
  await act(() => Bun.sleep(10));
  expect(document.querySelectorAll('[aria-label="用户消息"]')).toHaveLength(1);
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).not.toContain(
    '发送结果待确认',
  );
});

test('an older identical user message cannot clear an unknown turn receipt', async () => {
  const client = new UiClient();
  client.view = {
    ...client.view,
    messages: [{ id: 'old-user', role: 'user', text: '相同要求', settled: true }],
  };
  client.sendResult = async () => {
    throw new CommandResultUnknown('发送结果未知');
  };
  await render(<App client={client} />);
  await write(input(), '相同要求');
  await key(input(), 'Enter');
  expect(document.querySelectorAll('[aria-label="用户消息"]')[1]?.textContent).toContain(
    '发送结果待确认',
  );
  expect(button('发送').disabled).toBe(true);
  await click(document.querySelector<HTMLButtonElement>('.session-row[aria-current="page"]')!);
  expect(button('发送').disabled).toBe(true);
  expect(document.querySelector('[aria-label="用户消息"]')?.textContent).toContain(
    '发送结果待确认',
  );
  await act(() =>
    client.update({
      messages: [
        { id: 'old-user', role: 'user', text: '相同要求', settled: true },
        { id: 'new-user', role: 'user', text: '相同要求', settled: true },
      ],
    }),
  );
  await act(() => Bun.sleep(10));
  await write(input(), '下一条不同要求');
  expect(button('发送').disabled).toBe(false);
});

test('unknown resume receipt keeps the draft and does not claim that a turn was sent', async () => {
  const client = new UiClient();
  client.sendResult = async () => {
    throw new CommandResultUnknown('恢复结果未知', 'resume_session');
  };
  await render(<App client={client} />);
  await write(input(), '恢复后再发送');
  await key(input(), 'Enter');
  expect(input().value).toBe('恢复后再发送');
  expect(document.querySelector('[aria-label="用户消息"]')).toBeNull();
  expect(document.body.textContent).not.toContain('发送结果待确认');
  expect(button('发送').disabled).toBe(false);
});

test('retyping identical text during a successful send preserves it as the next draft', async () => {
  const client = new UiClient();
  let finish!: () => void;
  client.sendResult = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  await render(<App client={client} />);
  await write(input(), '相同草稿');
  await key(input(), 'Enter');
  expect(input().value).toBe('');
  await write(input(), '相同草稿');
  await act(() => finish());
  expect(input().value).toBe('相同草稿');
});

test('project and branch menus stage choices, keep the new draft and restore keyboard focus', async () => {
  const client = new UiClient();
  client.view = {
    ...client.view,
    connected: false,
    ready: false,
    selected: undefined,
    projects: [
      { path: '/project', lastOpenedAt: 2 },
      { path: '/another', lastOpenedAt: 1 },
    ],
  };
  await render(<App client={client} />);
  await write(input(), '跨项目保留需求');
  const projectTrigger = document.querySelector<HTMLButtonElement>('[aria-label="项目空间"]')!;
  await openDropdown(projectTrigger);
  expect(document.querySelector('[role="menu"]')?.getAttribute('class')).toContain('context-menu');
  expect(document.querySelectorAll('.context-menu svg')).toHaveLength(1);
  expect(document.querySelector('[aria-checked="true"] > span.absolute')?.className).toContain(
    'right-2',
  );
  expect(document.querySelector('[aria-checked="true"]')?.className).not.toContain(
    'data-[state=checked]',
  );
  expect(document.querySelectorAll('.context-menu-action svg')).toHaveLength(0);
  await key(document.activeElement!, 'Escape');
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(projectTrigger);
  await openDropdown(projectTrigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent?.includes('/another'),
  )!;
  await click(option);
  expect(client.view.workspace).toBe('/project');
  expect(document.querySelector('[aria-label="项目空间"]')?.textContent).toContain('another');
  expect(input().value).toBe('跨项目保留需求');
  expect(client.created).toBe(0);
  await openDropdown(document.querySelector<HTMLButtonElement>('[aria-label="分支"]')!);
  await key(document.activeElement!, 'ArrowDown');
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.activeElement?.textContent).toBe('feature');
  await click(document.activeElement as HTMLElement);
  expect(client.view.branch?.current).toBe('main');
  expect(document.querySelector('[aria-label="分支"]')?.textContent).toContain('feature');
  expect(input().value).toBe('跨项目保留需求');
  expect(client.created).toBe(0);
  expect(client.sent).toEqual([]);
});

test('a preselected workspace stages its session model without mutating active workspace trust', async () => {
  const client = new UiClient();
  let finishBranchRead: (() => void) | undefined;
  client.view = {
    ...client.view,
    projects: [
      { path: '/project', lastOpenedAt: 2 },
      { path: '/another', lastOpenedAt: 1 },
    ],
    trust: {
      ...client.view.trust!,
      status: 'unknown',
      canDecide: true,
      externalReadScope: { roots: ['/outside'], digest: 'sha256:outside' },
    },
  };
  client.queryProjectBranch = (workspace) =>
    new Promise((resolve) => {
      finishBranchRead = () => resolve({ ...client.view.branch!, workspace, root: workspace });
    });
  await render(<App client={client} />);
  await click(button('新对话'));
  await choose(
    document.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!,
    'test\0model-fast',
  );
  await choose(document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')!, 'full');
  expect(document.querySelector('.trust-notice')).not.toBeNull();
  await openDropdown(document.querySelector<HTMLElement>('[aria-label="项目空间"]')!);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('/another'),
    )!,
  );

  await act(() => Promise.resolve());
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="模型"]')?.disabled).toBe(
    false,
  );
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')?.disabled).toBe(
    false,
  );
  await act(async () => {
    finishBranchRead?.();
    await Promise.resolve();
  });

  expect(document.querySelector('.trust-notice')).toBeNull();
  const model = document.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!;
  expect(model.value).toBe('test\0model-fast');
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="权限"]')?.value).toBe(
    'full',
  );
  expect(client.selectedModels).toEqual([]);
});

test('sending to another workspace does not ask to stop existing tasks', async () => {
  const client = new UiClient();
  client.view.projects = [
    { path: '/project', lastOpenedAt: 2 },
    { path: '/another', lastOpenedAt: 1 },
  ];
  client.confirm = async () => {
    throw new Error('Workspace selection must not stop tasks');
  };
  await render(<App client={client} />);
  await click(button('新对话'));
  await openDropdown(document.querySelector<HTMLElement>('[aria-label="项目空间"]')!);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('/another'),
    )!,
  );
  await write(input(), '不要丢失这条需求');
  await key(input(), 'Enter');
  await act(() => Bun.sleep(0));

  expect(client.created).toBe(1);
  expect(client.sent).toEqual(['不要丢失这条需求']);
});

test('a non-Git workspace omits the branch selector', async () => {
  const client = new UiClient();
  client.view = {
    ...client.view,
    selected: undefined,
    branch: {
      ...client.view.branch!,
      repository: false,
      current: null,
      branches: [],
      canSwitch: false,
    },
  };
  await render(<App client={client} />);
  expect(document.querySelector('[aria-label="项目空间"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="分支"]')).toBeNull();
});

test('a non-Git workspace can create a conversation without an active Git project', async () => {
  const client = new UiClient(0);
  client.view = {
    ...client.view,
    workspace: '',
    selected: undefined,
    sessions: [],
    projection: undefined,
    ready: false,
    models: undefined,
    trust: undefined,
    projects: [{ path: '/notes', lastOpenedAt: 1 }],
    branch: {
      workspace: '/notes',
      repository: false,
      root: null,
      current: null,
      head: null,
      branches: [],
      dirty: false,
      canSwitch: false,
    },
  };
  await render(<App client={client} />);
  await openDropdown(document.querySelector<HTMLElement>('[aria-label="项目空间"]')!);
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('notes'),
    )!,
  );
  expect(document.querySelector('[aria-label="分支"]')).toBeNull();

  await write(input(), '整理这些资料');
  expect(button('发送').disabled).toBe(false);
  await key(input(), 'Enter');

  expect(client.view.workspace).toBe('/notes');
  expect(client.created).toBe(1);
  expect(client.sent).toEqual(['整理这些资料']);
  expect(client.sentTargets).toEqual(['created-1']);
});

test('adding a project survives WebKit mouse focus loss and opens the picker once', async () => {
  const client = new UiClient();
  client.view = { ...client.view, connected: false, selected: undefined };
  let picked = 0;
  client.pickProject = async () => {
    picked += 1;
    return null;
  };
  await render(<App client={client} />);
  await write(input(), '保留输入');
  await openDropdown(document.querySelector<HTMLElement>('[aria-label="项目空间"]')!);
  const add = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('添加项目…'),
  )!;
  await act(() => {
    const down = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    add.dispatchEvent(down);
    // Safari's button click otherwise blurs the focused menu item to the body.
    if (!down.defaultPrevented) (document.activeElement as HTMLElement).blur();
  });
  expect(add.isConnected).toBe(true);
  await click(add);
  expect(picked).toBe(1);
  expect(input().value).toBe('保留输入');
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

test('saved spaces show their directories expanded without switching the active project', async () => {
  const client = new UiClient();
  client.view.projects = [
    { path: '/project', lastOpenedAt: 2 },
    { path: '/saved-project', lastOpenedAt: 1 },
  ];
  client.view.directory = [
    ...client.view.sessions,
    { ...session('other', '其他空间的会话'), workspace: '/saved-project' },
  ];
  await render(<App client={client} />);
  const spaces = [...document.querySelectorAll<HTMLButtonElement>('.space-row')];
  expect(spaces).toHaveLength(2);
  expect(spaces.every((space) => space.getAttribute('aria-expanded') === 'true')).toBe(true);
  expect(document.querySelectorAll('.session-row')).toHaveLength(3);
  expect(button('其他空间的会话').closest('.sidebar-sessions')?.hasAttribute('hidden')).toBe(false);
  await click(spaces[1]!);
  await click(spaces[1]!);
  await click(button('其他空间的会话'));
  expect(client.selectedIds).toEqual(['other']);
  expect(client.view.workspace).toBe('/project');
  expect(client.created).toBe(0);
  expect(document.body.textContent).not.toContain('断开项目');
});

test('window focus preserves history and never drives service recovery', async () => {
  const client = new UiClient();
  let refreshed = 0;
  let restored = 0;
  client.refreshSessions = async () => {
    refreshed++;
  };
  client.restoreWorkspace = async () => {
    restored++;
  };
  await render(<App client={client} />);
  const startupRestores = restored;
  await act(() => window.dispatchEvent(new dom.window.Event('focus')));
  await act(() => document.dispatchEvent(new dom.window.Event('visibilitychange')));
  expect(refreshed).toBe(0);
  expect(restored).toBe(startupRestores);
  await act(() => client.update({ connected: false }));
  await act(() => window.dispatchEvent(new dom.window.Event('focus')));
  expect(refreshed).toBe(0);
  expect(restored).toBe(startupRestores);
});

test('space new conversation icon targets that project without toggling its list or creating a session', async () => {
  const client = new UiClient();
  client.view.projects = [
    { path: '/project', lastOpenedAt: 2 },
    { path: '/another', lastOpenedAt: 1 },
  ];
  await render(<App client={client} />);
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="在 another 中新建对话"]',
  )!;
  expect(trigger.querySelector('svg')).not.toBeNull();
  expect(trigger.dataset.slot).toBe('button');
  expect(
    trigger.closest('.space-heading')?.querySelector('.space-row')?.getAttribute('aria-expanded'),
  ).toBe('true');
  await click(trigger);
  expect(client.view.workspace).toBe('/project');
  expect(document.querySelector('[aria-label="项目空间"]')?.textContent).toContain('another');
  expect(document.querySelector('[aria-label="新对话"]')).not.toBeNull();
  expect(
    trigger.closest('.space-heading')?.querySelector('.space-row')?.getAttribute('aria-expanded'),
  ).toBe('true');
  expect(client.created).toBe(0);
  expect(client.sent).toEqual([]);
});

test('workspace switching keeps the existing session list mounted and visually enabled', async () => {
  const client = new UiClient();
  client.view.projects = [
    { path: '/project', lastOpenedAt: 2 },
    { path: '/another', lastOpenedAt: 1 },
  ];
  let activations = 0;
  let branchReads = 0;
  client.activateProject = async () => {
    activations++;
  };
  client.queryProjectBranch = async (workspace) => {
    branchReads++;
    return { ...client.view.branch!, workspace, root: workspace };
  };
  await render(<App client={client} />);
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.session-row')];
  const disabledMutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) => {
    disabledMutations.push(
      ...records.filter(
        (record) =>
          record.type === 'attributes' &&
          record.attributeName === 'disabled' &&
          (record.target as Element).matches('.session-row'),
      ),
    );
  });
  for (const row of rows) observer.observe(row, { attributes: true });
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="在 another 中新建对话"]',
  )!;
  await click(trigger);
  const switchingRows = [...document.querySelectorAll<HTMLButtonElement>('.session-row')];
  expect(switchingRows).toEqual(rows);
  expect(switchingRows.every((row) => !row.disabled)).toBe(true);
  expect(trigger.disabled).toBe(false);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  observer.disconnect();
  expect(disabledMutations).toHaveLength(0);
  expect(activations).toBe(0);
  expect(branchReads).toBe(1);
  expect(client.view.connected).toBe(true);
  expect(client.view.workspace).toBe('/project');
});

test('missing local directories mute the space name without blocking an already prepared conversation', async () => {
  const client = new UiClient();
  client.view.projects = [{ path: '/project', lastOpenedAt: 1, directoryMissing: true }];
  client.view.directory = client.view.sessions;
  client.view.directoryErrors = { '/project': '项目目录已不存在或无法访问' };
  client.checkProject = async () => {
    throw new Error('directory missing');
  };
  client.activateProject = async () => {
    throw new Error('must not prepare the current project again');
  };
  await render(<App client={client} />);
  expect(document.querySelector('.space-name-muted')?.textContent).toBe('project');
  expect(document.body.textContent).not.toContain('此会话尚未关联本地目录');
  expect(document.body.textContent).not.toContain('项目目录已不存在或无法访问');
  expect(document.body.textContent).toContain('会话暂不可用 · 重试');
  await write(input(), '继续讨论');
  await click(button('发送'));
  expect(client.sent).toEqual(['继续讨论']);
});

test('historical conversation sends without a registered or existing local workspace', async () => {
  const client = new UiClient();
  const originalSession = client.view.selected;
  client.view.projects = [];
  client.view.workspace = '/another-project';
  client.view.trust = undefined;
  client.view.directory = client.view.sessions.map((entry) => ({
    ...entry,
    workspace: undefined,
  }));
  client.checkProject = async () => {
    throw new Error('conversation must not inspect the deleted directory');
  };
  client.activateProject = async () => {
    throw new Error('conversation must not activate another execution workspace');
  };
  await render(<App client={client} />);
  await write(input(), '继续原会话，目录已经删除');
  expect(button('发送').disabled).toBe(false);
  await key(input(), 'Enter');
  expect(client.sent).toEqual(['继续原会话，目录已经删除']);
  expect(client.sentTargets).toEqual([originalSession]);
  expect(client.created).toBe(0);
  expect(client.view.workspace).toBe('/another-project');
});

test('a historical draft survives local project registration changes', async () => {
  const client = new UiClient();
  client.view.directory = client.view.sessions.map((entry) => ({ ...entry, workspace: undefined }));
  client.view.projects = [];
  client.view.workspace = '/another';
  client.view.trust = undefined;
  await render(<App client={client} />);
  await write(input(), '保留原会话草稿');
  await act(() =>
    client.update({
      projects: [{ path: '/project', lastOpenedAt: 1 }],
      directory: client.view.sessions.map((entry) => ({ ...entry, workspace: '/project' })),
    }),
  );
  expect(input().value).toBe('保留原会话草稿');
  await act(() =>
    client.update({
      projects: [],
      directory: client.view.sessions.map((entry) => ({ ...entry, workspace: undefined })),
    }),
  );
  expect(input().value).toBe('保留原会话草稿');
});

test('an old session without a saved model does not inherit another project model on send', async () => {
  const client = new UiClient();
  client.view.projection = { ...client.view.projection!, model: undefined };
  client.view.workspace = '/another';
  client.view.trust = undefined;
  await render(<App client={client} />);
  await write(input(), '由原会话选择模型');
  await key(input(), 'Enter');
  expect(client.sentModels).toEqual([undefined]);
  expect(client.created).toBe(0);
});

test('a reloaded page automatically restores its selected conversation without cleanup or sending', async () => {
  const first = new UiClient();
  await render(<App client={first} />);
  await click(document.querySelectorAll<HTMLButtonElement>('.session-row')[1]!);
  await act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  const restored = new UiClient();
  restored.view = {
    ...restored.view,
    connected: false,
    selected: undefined,
    projection: undefined,
    ready: false,
    messages: [],
  };
  restored.restoreWorkspace = async () => {
    restored.update({ connected: true });
  };
  await render(<App client={restored} />);
  expect(restored.selectedIds).toEqual(['s1']);
  expect(document.querySelector('[aria-label="新对话"]')).toBeNull();
  expect(document.body.textContent).not.toContain('清理旧连接');
  expect(restored.created).toBe(0);
  expect(restored.sent).toEqual([]);
});

test('clicking switches sessions immediately and restores each draft', async () => {
  const client = new UiClient();
  await render(<App client={client} />);
  await write(input(), '第一条草稿');
  const second = document.querySelectorAll<HTMLButtonElement>('.session-row')[1]!;
  await click(second);
  expect(client.selectedIds).toEqual(['s1']);
  expect(input().value).toBe('');
  await write(input(), '第二条草稿');
  await click(document.querySelector<HTMLElement>('.session-row')!);
  expect(input().value).toBe('第一条草稿');
  expect(client.sent).toEqual([]);
});

test('loading a live projection preserves the title already shown by the directory', async () => {
  const client = new UiClient(1);
  const directorySession = { ...client.view.sessions[0]!, displayName: '目录中的会话标题' };
  client.view.directory = [directorySession];
  client.view.sessions = [directorySession];
  client.selectSession = async (id: string) => {
    client.selectedIds.push(id);
    const projection = {
      ...directorySession,
      displayName: '实时投影中的不同标题',
      revision: 2,
    } as RuntimeSessionProjection;
    client.update({ selected: id, sessions: [projection], projection, messages: [] });
  };
  await render(<App client={client} />);
  expect(document.querySelector('.session-row strong')?.textContent).toBe('目录中的会话标题');
  await click(document.querySelector<HTMLButtonElement>('.session-row')!);
  expect(document.querySelector('.session-row strong')?.textContent).toBe('目录中的会话标题');
});

test('200 rows support keyboard navigation without search or a background reorder', async () => {
  const client = new UiClient(200);
  await render(<App client={client} />);
  expect(document.querySelector('input[type=search]')).toBeNull();
  const first = document.querySelector<HTMLButtonElement>('.session-row')!;
  await act(() => first.focus());
  await key(first, 'End');
  expect(document.activeElement?.textContent).toBe('展开更多');
  await key(document.activeElement!, 'ArrowUp');
  expect(document.activeElement?.textContent).toContain('工作 4');
  expect(document.querySelectorAll('.session-row:not(.session-load-more)')).toHaveLength(5);
  for (let page = 0; page < 20; page++) await click(button('展开更多'));
  await act(() => first.focus());
  await key(first, 'End');
  expect(document.activeElement?.textContent).toContain('工作 199');
  expect(client.selectedIds).toEqual([]);
  await key(document.activeElement!, 'Enter');
  expect(client.selectedIds).toEqual(['s199']);
  expect(document.querySelectorAll('.session-row')).toHaveLength(200);
  const rows = Array.from(document.querySelectorAll('.session-row')).map(
    (item) => item.textContent,
  );
  await act(() =>
    client.update({ messages: [{ id: 'm', role: 'assistant', text: '新的进展', settled: false }] }),
  );
  expect(
    Array.from(document.querySelectorAll('.session-row')).map((item) => item.textContent),
  ).toEqual(rows);
});

test('empty, IME, Shift+Enter and repeated submit cannot issue unintended turns; failure preserves draft', async () => {
  const client = new UiClient();
  await render(<App client={client} />);
  expect(button('发送').disabled).toBe(true);
  await write(input(), '中文输入');
  await key(input(), 'Enter', { isComposing: true });
  await key(input(), 'Enter', { shiftKey: true });
  expect(client.sent).toEqual([]);
  let reject!: (error: Error) => void;
  client.sendResult = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  await key(input(), 'Enter');
  await key(input(), 'Enter');
  await click(button('发送'));
  expect(client.sent).toEqual(['中文输入']);
  expect(button('发送').disabled).toBe(true);
  await act(() => reject(new Error('发送失败')));
  await act(() => Bun.sleep(0));
  expect(input().value).toBe('中文输入');
  await act(() => Bun.sleep(20));
  expect(document.querySelector('[data-sonner-toast]')?.textContent).toContain('发送失败');
  await act(() => Bun.sleep(20));
  await click(button('关闭通知'));
  client.sendResult = async () => {};
  await click(button('发送'));
  expect(input().value).toBe('');
});

test('waiting approval hides the prompt input and stop control while preserving its draft', async () => {
  const client = new UiClient();
  const approval = {
    kind: 'approval',
    interactionId: 'approval',
    sessionRevision: 1,
    generation: 1,
    grants: ['approve_once'],
    owner: { kind: 'root_tool', toolCallId: 'tool' },
    command: 'echo approved',
  } as const;
  const running = {
    ...session('s0'),
    currentRun: { runId: 'r', initialTurnId: 't', status: 'running', revision: 1 },
  } as RuntimeSessionProjection;
  client.view = { ...client.view, projection: running };
  await render(<App client={client} />);
  await write(input(), '稍后的要求');
  await act(() =>
    client.update({
      projection: {
        ...running,
        currentRun: { runId: 'r', initialTurnId: 't', status: 'waiting', revision: 2 },
        interactionQueue: {
          revision: 1,
          activeInteractionId: 'approval',
          interactions: [approval],
        },
      },
    }),
  );
  expect(document.querySelector('[aria-label="任务输入"]')).toBeNull();
  expect(document.querySelector('form.composer')).toBeNull();
  expect(document.querySelector('[aria-label="停止任务"]')).toBeNull();
  expect(client.sent).toEqual([]);
  await click(button('仅批准这一次'));
  expect(client.approvals).toBe(1);
  expect(client.cancelled).toBe(0);
  await act(() => client.update({ connected: false, ready: false }));
  expect(document.querySelector('[aria-label="停止任务"]')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('.session-row')?.disabled).toBe(true);
  expect(button('仅批准这一次').disabled).toBe(true);
  await act(() =>
    client.update({
      projection: { ...running, interactionQueue: { revision: 2, interactions: [] } },
    }),
  );
  expect(input().value).toBe('稍后的要求');
});

test('cached history stays readable while calibrating, including cached empty history', async () => {
  const client = new UiClient();
  client.view = {
    ...client.view,
    ready: false,
    loadingSession: true,
    hasLoadedHistory: true,
    messages: [{ id: 'saved', role: 'assistant', text: '已经读取的正文', settled: true }],
  };
  await render(<App client={client} />);
  expect(document.querySelector('.conversation')?.textContent).toContain('已经读取的正文');
  expect(document.querySelector('.conversation')?.textContent).not.toContain('正在加载会话历史');
  await write(input(), '继续写草稿');
  expect(button('发送').disabled).toBe(true);
  await act(() => client.update({ messages: [] }));
  expect(document.querySelector('.conversation')?.textContent).not.toContain('正在加载会话历史');
  await act(() => client.update({ hasLoadedHistory: false }));
  expect(document.querySelector('.conversation')?.textContent).not.toContain('正在加载会话历史');
  expect(document.querySelector('[aria-label="正在加载聊天"] svg')).not.toBeNull();
  expect(input().value).toBe('继续写草稿');
});

test('history loading cannot submit even if subscription readiness has arrived first', async () => {
  const client = new UiClient();
  client.view = { ...client.view, loadingSession: true, ready: true };
  await render(<App client={client} />);
  await write(input(), '等待历史');
  await key(input(), 'Enter');
  expect(button('发送').disabled).toBe(true);
  expect(client.sent).toEqual([]);
  await act(() => client.update({ loadingSession: false }));
  expect(button('发送').disabled).toBe(false);
});

test('question and truncated plan stay above the composer without enabling invalid approval', async () => {
  const client = new UiClient();
  const projection = {
    ...session('s0'),
    currentRun: { runId: 'r', initialTurnId: 't', status: 'running', revision: 1 },
  } as const;
  client.view = { ...client.view, projection };
  await render(<App client={client} />);
  await write(input(), '保留会话草稿');
  await act(() =>
    client.update({
      projection: {
        ...projection,
        currentRun: { runId: 'r', initialTurnId: 't', status: 'waiting', revision: 2 },
        interactionQueue: {
          revision: 1,
          activeInteractionId: 'question',
          interactions: [
            {
              kind: 'input',
              interactionId: 'question',
              sessionRevision: 1,
              question: '使用哪个方案？',
              allowFreeText: true,
              options: [{ id: 'a', label: '方案 A' }],
            },
          ],
        },
      },
    }),
  );
  expect(document.querySelector('.interaction-area [aria-label="补充问题"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="回答问题"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="任务输入"]')).toBeNull();
  expect(document.querySelector('.tool-activity-summary')?.textContent).toContain('使用哪个方案？');
  await act(() =>
    client.update({
      projection: {
        ...projection,
        interactionQueue: {
          revision: 2,
          activeInteractionId: 'plan',
          interactions: [
            {
              kind: 'plan_review',
              interactionId: 'plan',
              sessionRevision: 2,
              plan: { planId: 'p', version: 1, structuralDigest: 'digest' },
              review: { text: '不完整计划', truncated: true },
            },
          ],
        },
      },
    }),
  );
  expect(document.querySelector('.interaction-area [aria-label="计划审核"]')).not.toBeNull();
  expect(button('批准 · Auto').disabled).toBe(true);
  expect(button('批准 · Accept Edits').disabled).toBe(true);
  expect(document.querySelector('[aria-label="停止任务"]')).toBeNull();
  expect(document.querySelector('[aria-label="任务输入"]')).toBeNull();
});

test('ask questionnaire submits a selected option through the input interaction', async () => {
  const client = new UiClient();
  const submissions: Array<{
    value: string | undefined;
    answers: Readonly<Record<string, string>> | undefined;
  }> = [];
  const projection = {
    ...session('s0'),
    currentRun: { runId: 'r', initialTurnId: 't', status: 'waiting', revision: 1 },
    interactionQueue: {
      revision: 1,
      activeInteractionId: 'question',
      interactions: [
        {
          kind: 'input',
          interactionId: 'question',
          sessionRevision: 1,
          title: '需要确认',
          summary: '选择最符合预期的处理方式。',
          question: '使用哪个方案？',
          allowFreeText: true,
          options: [
            { id: 'a', label: '方案 A', description: '保持当前范围' },
            { id: 'b', label: '方案 B', description: '扩大处理范围' },
          ],
          questions: [
            {
              id: 'q1',
              question: '使用哪个方案？',
              allowFreeText: true,
              options: [
                { id: 'q1-o1', label: '方案 A', description: '保持当前范围' },
                { id: 'q1-o2', label: '方案 B', description: '扩大处理范围' },
              ],
            },
          ],
        },
      ],
    },
  } as RuntimeSessionProjection;
  client.view = { ...client.view, projection };
  client.respondInput = async (_sessionId, _interaction, value, answers) => {
    submissions.push({ value, answers });
  };

  await render(<App client={client} />);
  expect(document.querySelector('.ask-questionnaire')).not.toBeNull();
  expect(document.querySelector('fieldset legend')?.textContent).toBe('使用哪个方案？');
  expect(document.querySelector('.ask-questionnaire-description')?.textContent).toBe(
    '选择最符合预期的处理方式。',
  );
  expect(document.querySelector('.ask-questionnaire-shortcut')).toBeNull();
  expect(document.querySelector('.ask-questionnaire')?.textContent).not.toContain('保持当前范围');
  const optionInfo = document.querySelector<HTMLButtonElement>(
    '[aria-label="查看 方案 A 的详细信息"]',
  );
  expect(optionInfo).not.toBeNull();
  expect(button('提交回答').disabled).toBe(true);
  expect(submissions).toEqual([]);
  await click(document.querySelectorAll<HTMLInputElement>('[name="q1"]')[1]!);
  await click(button('提交回答'));
  expect(submissions).toEqual([{ value: '方案 B', answers: { q1: 'q1-o2' } }]);
});

test('ask questionnaire preserves a single free-text answer as semantic input', async () => {
  const client = new UiClient();
  const answers: Array<string | undefined> = [];
  const projection = {
    ...session('s0'),
    currentRun: { runId: 'r', initialTurnId: 't', status: 'waiting', revision: 1 },
    interactionQueue: {
      revision: 1,
      activeInteractionId: 'question',
      interactions: [
        {
          kind: 'input',
          interactionId: 'question',
          sessionRevision: 1,
          question: '还有什么要求？',
          allowFreeText: true,
          options: [{ id: 'q1-o1', label: '没有其他要求' }],
        },
      ],
    },
  } as RuntimeSessionProjection;
  client.view = { ...client.view, projection };
  client.respondInput = async (_sessionId, _interaction, value) => {
    answers.push(value);
  };

  await render(<App client={client} />);
  await write(document.querySelector<HTMLInputElement>('[aria-label="回答问题"]')!, '保留现有接口');
  await click(button('提交回答'));
  expect(answers).toEqual(['保留现有接口']);
});

test('legacy single-choice input submits its label when free text is disabled', async () => {
  const client = new UiClient();
  const answers: Array<string | undefined> = [];
  const projection = {
    ...session('s0'),
    currentRun: { runId: 'r', initialTurnId: 't', status: 'waiting', revision: 1 },
    interactionQueue: {
      revision: 1,
      activeInteractionId: 'question',
      interactions: [
        {
          kind: 'input',
          interactionId: 'question',
          sessionRevision: 1,
          question: '继续吗？',
          allowFreeText: false,
          options: [{ id: 'continue', label: '继续' }],
        },
      ],
    },
  } as RuntimeSessionProjection;
  client.view = { ...client.view, projection };
  client.respondInput = async (_sessionId, _interaction, value) => {
    answers.push(value);
  };

  await render(<App client={client} />);
  await click(document.querySelector<HTMLInputElement>('[name="answer"]')!);
  await click(button('提交回答'));
  expect(answers).toEqual(['继续']);
});

test('ask questionnaire submits every answer under its stable question id', async () => {
  const client = new UiClient();
  const submissions: Array<{
    value: string | undefined;
    answers: Readonly<Record<string, string>> | undefined;
  }> = [];
  const projection = {
    ...session('s0'),
    currentRun: { runId: 'r', initialTurnId: 't', status: 'waiting', revision: 1 },
    interactionQueue: {
      revision: 1,
      activeInteractionId: 'batch-question',
      interactions: [
        {
          kind: 'input',
          interactionId: 'batch-question',
          sessionRevision: 1,
          question: '第一题？',
          allowFreeText: true,
          questions: [
            {
              id: 'q1',
              question: '第一题？',
              allowFreeText: true,
              options: [{ id: 'q1-o1', label: '答案一' }],
            },
            {
              id: 'q2',
              question: '第二题？',
              allowFreeText: false,
              options: [{ id: 'q2-o1', label: '答案二' }],
            },
          ],
        },
      ],
    },
  } as RuntimeSessionProjection;
  client.view = { ...client.view, projection };
  client.respondInput = async (_sessionId, _interaction, value, answers) => {
    submissions.push({ value, answers });
  };

  await render(<App client={client} />);
  expect(document.querySelector('.ask-questionnaire-progress')?.textContent).toBe('问题 1 / 2');
  expect(document.querySelector('button[type="submit"]')).toBeNull();
  await click(button('下一题'));
  expect(document.querySelector('.ask-questionnaire-progress')?.textContent).toBe('问题 2 / 2');
  expect(button('提交回答').disabled).toBe(true);
  await click(button('上一题'));
  expect(document.querySelector('.ask-questionnaire-progress')?.textContent).toBe('问题 1 / 2');
  await click(document.querySelector<HTMLInputElement>('[name="q1"]')!);
  expect(document.querySelector<HTMLInputElement>('[aria-label="回答：第一题？"]')?.value).toBe('');
  await click(button('下一题'));
  expect(document.querySelector('.ask-questionnaire-progress')?.textContent).toBe('问题 2 / 2');
  expect(button('提交回答').disabled).toBe(true);
  await click(document.querySelector<HTMLInputElement>('[name="q2"]')!);
  expect(button('提交回答').disabled).toBe(false);
  await click(button('提交回答'));
  expect(submissions).toEqual([
    {
      value: '第一题？: 答案一\n第二题？: 答案二',
      answers: { q1: 'q1-o1', q2: 'q2-o1' },
    },
  ]);
});

test.each([
  'input',
  'plan_review',
] as const)('%s drafts survive navigation and failures without leaking to another interaction', async (kind) => {
  const client = new UiClient();
  const interaction =
    kind === 'input'
      ? {
          kind,
          interactionId: 'draft-question',
          sessionRevision: 1,
          question: '请补充要求',
          allowFreeText: true,
        }
      : {
          kind,
          interactionId: 'draft-plan',
          sessionRevision: 1,
          plan: { planId: 'p', version: 1, structuralDigest: 'digest' },
          review: { text: '完整计划', truncated: false },
        };
  const first = {
    ...session('s0'),
    currentRun: { runId: 'r', initialTurnId: 't', status: 'waiting', revision: 1 },
    interactionQueue: {
      revision: 1,
      activeInteractionId: interaction.interactionId,
      interactions: [interaction],
    },
  } as RuntimeSessionProjection;
  client.view = {
    ...client.view,
    projection: {
      ...first,
      currentRun: { ...first.currentRun!, status: 'running' },
      interactionQueue: { revision: 0, interactions: [] },
    },
    sessions: [first, { ...first, sessionId: 's1', displayName: '另一个问题' }],
  };
  client.respondInput = async () => {
    throw new Error('回答提交失败');
  };
  client.respondPlan = async () => {
    throw new Error('计划提交失败');
  };
  await render(<App client={client} />);
  await write(input(), '主输入框草稿');
  await act(() => client.update({ projection: first }));
  const label = kind === 'input' ? '回答问题' : '计划修改要求';
  const answer = () => document.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await write(answer(), '先核对现有文档，再提供完整的复现步骤。');
  expect(document.querySelector('[aria-label="任务输入"]')).toBeNull();
  await click(document.querySelectorAll<HTMLButtonElement>('.session-row')[1]!);
  expect(answer().value).toBe('');
  await write(answer(), '另一会话的回答');
  await click(document.querySelectorAll<HTMLButtonElement>('.session-row')[0]!);
  expect(answer().value).toBe('先核对现有文档，再提供完整的复现步骤。');
  expect(document.querySelector('[aria-label="任务输入"]')).toBeNull();
  await click(button(kind === 'input' ? '提交回答' : '提交修改要求'));
  expect(answer().value).toBe('先核对现有文档，再提供完整的复现步骤。');
  await click(button('工作台'));
  await click(document.querySelectorAll<HTMLButtonElement>('.session-row')[0]!);
  expect(answer().value).toBe('先核对现有文档，再提供完整的复现步骤。');
  const next = { ...interaction, interactionId: 'next-interaction' };
  await act(() =>
    client.update({
      projection: {
        ...first,
        interactionQueue: {
          revision: 2,
          activeInteractionId: next.interactionId,
          interactions: [next],
        },
      },
    }),
  );
  expect(answer().value).toBe('');
  await act(() => client.update({ projection: first }));
  expect(answer().value).toBe('先核对现有文档，再提供完整的复现步骤。');
  client.respondInput = async () => {};
  client.respondPlan = async () => {};
  await click(button(kind === 'input' ? '提交回答' : '提交修改要求'));
  expect(answer().value).toBe('');
  expect(document.querySelector('[aria-label="任务输入"]')).toBeNull();
  await click(document.querySelectorAll<HTMLButtonElement>('.session-row')[1]!);
  expect(answer().value).toBe('另一会话的回答');
  await act(() =>
    client.update({
      projection: {
        ...first,
        sessionId: 's1',
        currentRun: { ...first.currentRun!, status: 'running' },
        interactionQueue: { revision: 3, interactions: [] },
      },
    }),
  );
  expect(input().value).toBe('');
  await click(document.querySelectorAll<HTMLButtonElement>('.session-row')[0]!);
  await act(() =>
    client.update({
      projection: {
        ...first,
        currentRun: { ...first.currentRun!, status: 'running' },
        interactionQueue: { revision: 3, interactions: [] },
      },
    }),
  );
  expect(input().value).toBe('主输入框草稿');
});

test('file changes open beside the conversation, keep drafts and close before switching sessions', async () => {
  const client = new UiClient();
  client.view.messages = [
    {
      id: 'tool:write',
      role: 'tool',
      text: 'diff',
      settled: true,
      status: 'completed',
      changeConfirmed: true,
      changedFile: 'notes.md',
      toolResult: { ok: true, stdout: '1 + new' },
    },
  ];
  await render(<App client={client} />);
  await write(input(), '保留我的草稿');
  await click(button('文件变更'));
  expect(document.querySelector('[aria-label="文件变更"]')).not.toBeNull();
  expect(document.querySelector('[role="tab"]')?.textContent).toBe('文件变更');
  expect(document.querySelector('.right-sidebar')).not.toBeNull();
  expect(document.querySelectorAll('[data-panel]')).toHaveLength(3);
  expect(document.querySelectorAll('[role="separator"]')).toHaveLength(2);
  expect(input().value).toBe('保留我的草稿');
  expect(document.querySelector('dialog')).toBeNull();
  await click(document.querySelector<HTMLButtonElement>('.results .file-link')!);
  expect(client.openedFiles).toEqual(['notes.md']);
  await click(document.querySelector<HTMLButtonElement>('.right-sidebar-close')!);
  expect(document.activeElement).toBe(button('文件变更'));
  await click(button('文件变更'));
  await click(document.querySelectorAll<HTMLButtonElement>('.session-row')[1]!);
  expect(document.querySelector('[aria-label="文件变更"]')).toBeNull();
  expect(input().value).toBe('');
});

test('settings consumes MCP and Skill facts and issues only an explicit MCP action', async () => {
  const client = new UiClient();
  const workspace = client.view.trust!.workspace;
  client.view.mcp = {
    schema: 'kite.app.mcp.snapshot-response.v1',
    workspace,
    revision: '1',
    sourceRevisions: { project: '1', user: '1' },
    servers: [
      {
        key: { name: 'design', source: 'user' },
        effective: true,
        sourcePath: '/fixture/mcp.json',
        transport: 'http',
        enabled: true,
        required: false,
        configStatus: 'ready',
        health: 'disconnected',
        authStatus: 'login_required',
        configuration: { endpoint: 'https://example.com' },
        revision: '1',
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        tools: [],
        prompts: [],
      },
    ],
  };
  client.view.skills = {
    schema: 'kite.app.skill-catalog.response.v1',
    workspace,
    revision: '1',
    skills: [
      {
        name: 'review',
        description: '检查已有实现',
        source: 'project',
        origin: '.agents',
        status: 'available',
      },
    ],
  };
  await render(
    <Settings
      client={client}
      view={client.view}
      busy={false}
      act={async (action) => {
        await action();
      }}
      editor="vscode"
      onEditorChange={() => {}}
    />,
  );
  await click(button('MCP'));
  expect(client.mcpActions).toEqual([]);
  expect(document.querySelector('.extension-card')?.textContent).toContain('需要认证');
  await click(button('开始认证'));
  expect(client.mcpActions).toEqual(['login']);
  await click(button('Skills'));
  expect(document.querySelector('.extension-card')?.textContent).toContain('检查已有实现');
  expect(document.body.textContent).not.toContain('安装 Skill');
});

test('opening a projection without updatedAt preserves the directory time and sorted position', async () => {
  const client = new UiClient(2);
  const latest = { ...client.view.sessions[0]!, updatedAt: '2026-09-12T10:00:00Z' };
  const older = { ...client.view.sessions[1]!, updatedAt: '2026-09-11T10:00:00Z' };
  client.view.directory = [older, latest];
  client.view.sessions = [older, latest];
  client.selectSession = async (id: string) => {
    const { updatedAt: _, ...projection } = { ...latest, revision: 2 };
    client.update({
      selected: id,
      sessions: [older, projection],
      projection: projection as RuntimeSessionProjection,
      messages: [],
    });
  };
  await render(<App client={client} />);
  const titles = () =>
    Array.from(document.querySelectorAll('.session-row strong')).map((row) => row.textContent);
  expect(titles()).toEqual(['工作 0', '工作 1']);
  await click(button('工作 0'));
  expect(titles()).toEqual(['工作 0', '工作 1']);
  expect(client.view.directory[1]?.updatedAt).toBe('2026-09-12T10:00:00Z');
});

test('explicit recovery inspection preserves draft and does not submit a task', async () => {
  const client = new UiClient();
  let checks = 0;
  client.checkSessionRecovery = async () => {
    checks++;
    client.clearError();
  };
  await render(<App client={client} />);
  await write(input(), '等待恢复后的草稿');
  await act(() => client.update({ error: '旧执行清理尚未确认', recoverySessionId: 'session-a' }));
  await act(() => Bun.sleep(20));
  expect(document.querySelector('[data-sonner-toast]')?.textContent).toContain(
    '警告 · 会话需要处理',
  );
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  const recovery = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === '检查恢复',
  );
  expect(recovery).toBeDefined();
  await click(recovery!);
  expect(checks).toBe(1);
  expect(client.sent).toEqual([]);
  expect(input().value).toBe('等待恢复后的草稿');
});
