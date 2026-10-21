import { expect, test } from 'bun:test';
import type { Session } from '@kite-ai/client';
import { Sidebar } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeDirectory, NativeSelection } from '../src/native-bridge';
import { desktopDirectory } from '../src/native-presentation';
import { backgroundItem } from './background-item.fixture';
import { prepareDesktopDom } from './native-page-dom.fixture';

test('same-session permission refresh retains the observed running marker until a real observation failure', () => {
  const item = backgroundItem();
  const directory: NativeDirectory = {
    storeId: 'store',
    workspaces: [{ id: 'w', name: 'Workspace', rootUri: 'file:///workspace' }],
    sessions: [item.rootSession],
  };
  const selection: NativeSelection = {
    storeId: 'store',
    viewGeneration: 1,
    viewSelection: 1,
    session: item.rootSession,
    runs: [{ ...item.run!, status: 'running' }],
    executions: [],
    interactions: [],
    interactionsAfterId: null,
    canReadModelOutput: false,
  };
  for (const refreshing of [false, true]) {
    const workspaces = desktopDirectory(directory, {
      ...selection,
      viewLoading: refreshing,
      permissionUnavailable: refreshing,
    });
    expect(workspaces[0]!.sessions[0]!.status).toBe('running');
    expect(
      renderToStaticMarkup(
        <Sidebar workspaces={workspaces} actions={{}} connectionLabel="" onOpen={() => {}} />,
      ),
    ).toContain('aria-label="会话运行中"');
  }
  expect(
    desktopDirectory(directory, { ...selection, permissionUnavailable: true })[0]!.sessions[0]!
      .status,
  ).toBe('上次确认状态');
  expect(
    desktopDirectory({ ...directory, unavailable: true }, { ...selection, viewLoading: true })[0]!
      .sessions[0]!.status,
  ).toBe('上次确认状态');
  expect(
    desktopDirectory(directory, { ...selection, storeId: 'other' })[0]!.sessions[0]!.status,
  ).toBe('状态待读取');
});

test('PC directory groups original IDs, keeps navigation available during creation, and folds without a business call', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayoutGlobals = prepareDesktopDom(dom);
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const element = dom.window.document.getElementById('root')!;
  const root = createRoot(element);
  const selected: string[] = [],
    created: string[] = [];
  const session = (id: string, workspaceId: string): Session => ({
    id,
    workspaceId,
    parentSessionId: null,
    rootSessionId: id,
    title: '同名会话🙂',
    controlRevision: '0',
    contextSelectionId: 'selection',
    nextSeq: '0',
    deletedAt: null,
  });
  const workspaces = ['a', 'b', 'empty'].map((id) => ({
    id,
    name: `项目 ${id}`,
    rootUri: `file:///${id}`,
  }));
  const render = (creating: boolean) =>
    root.render(
      <Sidebar
        workspaces={desktopDirectory({
          storeId: 'store',
          workspaces,
          sessions: [session('first', 'a'), session('second', 'b'), session('late', 'later')],
        })}
        selected="first"
        mutationBusy={creating}
        connectionLabel="本地 Agent"
        defaultExpanded
        actions={{ newWorkspaceSession: (id) => created.push(id) }}
        onOpen={(id) => selected.push(id)}
      />,
    );
  const group = (id: string) =>
    [...element.querySelectorAll<HTMLElement>('section.workspace-group')].find(
      (group) => group.querySelector('.space-row strong')?.textContent === `项目 ${id}`,
    )!;
  try {
    await act(async () => render(true));
    expect(group('a').querySelector('button[aria-current=page]')?.textContent).toBe('同名会话🙂');
    expect(group('b').querySelector('button[aria-current]')).toBeNull();
    expect(group('empty').textContent).toContain('暂无聊天');
    expect(
      [...element.querySelectorAll('section.workspace-group')].find(
        (group) => group.querySelector('.space-row strong')?.textContent === '项目待读取的会话',
      )?.textContent,
    ).toContain('同名会话🙂');
    const a = group('a').querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => a.click());
    expect(a.getAttribute('aria-expanded')).toBe('false');
    expect(group('a').querySelector<HTMLDivElement>('.sidebar-sessions')!.hidden).toBe(true);
    expect(group('b').querySelector<HTMLDivElement>('.sidebar-sessions')!.hidden).toBe(false);
    expect(selected).toEqual([]);
    expect(created).toEqual([]);
    await act(async () => a.click());
    const original = group('a').querySelector<HTMLButtonElement>('button.session-row')!;
    await act(async () => original.focus());
    await act(async () =>
      original.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(dom.window.document.activeElement).toBe(original);
    expect(selected).toEqual([]);
    const other = group('b').querySelector<HTMLButtonElement>('button.session-row')!;
    expect(other.disabled).toBe(false);
    await act(async () => other.click());
    expect(selected).toEqual(['second']);
    expect(group('b').querySelector<HTMLButtonElement>('button.space-new-session')!.disabled).toBe(
      true,
    );
    await act(async () => render(false));
    await act(async () =>
      group('b').querySelector<HTMLButtonElement>('button.space-new-session')!.click(),
    );
    expect(created).toEqual(['b']);
    expect(selected).toEqual(['second']);
    const unnamed = session('unnamed', 'a');
    unnamed.title = '';
    expect(
      desktopDirectory({ storeId: 'store', workspaces, sessions: [unnamed] })[0]!.sessions[0]!
        .displayName,
    ).toBe('新对话');
  } finally {
    await act(async () => root.unmount());
    restoreLayoutGlobals();
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

test('retained Sidebar sorts real global activity, pages 5 then 10, distinguishes required waiting from user input and preserves stale history', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayoutGlobals = prepareDesktopDom(dom);
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const element = dom.window.document.getElementById('root')!,
    root = createRoot(element);
  const opened: string[] = [];
  const base = Date.parse('2026-10-08T02:00:00Z');
  const directory: NativeDirectory = {
    storeId: 'store',
    workspaces: [{ id: 'w', name: '原项目', rootUri: 'file:///w' }],
    sessions: Array.from({ length: 17 }, (_, index) => ({
      id: `s-${index}`,
      workspaceId: 'w',
      rootSessionId: `s-${index}`,
      parentSessionId: null,
      title: `会话 ${index}`,
      controlRevision: '0',
      contextSelectionId: 'selection',
      nextSeq: '0',
      deletedAt: null,
      activity: {
        updatedAt: base + index * 1000,
        queued: index === 13,
        pendingInteractions: index === 16 ? 1 : 0,
        run:
          index === 15
            ? {
                id: 'required-parent',
                status: 'waiting_execution',
                isActive: true,
                waitingForResults: true,
              }
            : index === 16
              ? {
                  id: 'human-wait',
                  status: 'waiting_interaction',
                  isActive: true,
                  waitingForResults: false,
                }
              : index === 14
                ? { id: 'running', status: 'running', isActive: true, waitingForResults: false }
                : null,
      },
    })),
  };
  const render = () =>
    root.render(
      <Sidebar
        actions={{}}
        connectionLabel="本地 Agent"
        workspaces={desktopDirectory(directory)}
        selected="s-0"
        defaultExpanded
        onOpen={(id) => opened.push(id)}
      />,
    );
  const rows = () => [
    ...element.querySelectorAll<HTMLButtonElement>('button.session-row[aria-label]'),
  ];
  const row = (index: number) =>
    rows().find((value) => value.getAttribute('aria-label') === `会话 ${index}`)!;
  try {
    await act(async () => render());
    expect(rows().map((value) => value.getAttribute('aria-label'))).toEqual([
      '会话 16',
      '会话 15',
      '会话 14',
      '会话 13',
      '会话 12',
    ]);
    expect(row(16).getAttribute('aria-description')).toBe('待用户输入');
    expect(row(16).textContent).toContain('待用户输入');
    expect(row(15).getAttribute('aria-description')).toBe('任务进行中');
    expect(row(15).querySelector('[aria-label="任务进行中"]')).not.toBeNull();
    expect(row(15).textContent).not.toContain('待用户输入');
    expect(row(14).querySelector('[aria-label="会话运行中"]')).not.toBeNull();
    expect(row(13).getAttribute('aria-description')).toBe('排队中');
    const more = () =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '展开更多',
      )!;
    await act(async () => more().click());
    expect(rows()).toHaveLength(15);
    await act(async () => more().click());
    expect(rows()).toHaveLength(17);
    const originalTime = desktopDirectory(directory)[0]!.sessions[0]!.updatedAt;
    expect(originalTime).toBe(new Date(base).toISOString());
    directory.sessions[0]!.activity!.updatedAt = base + 100000;
    await act(async () => render());
    expect(rows()[0]!.getAttribute('aria-label')).toBe('会话 0');
    expect(row(0).getAttribute('aria-current')).toBe('page');
    expect(opened).toEqual([]);
    directory.unavailable = true;
    await act(async () => render());
    expect(row(16).getAttribute('aria-description')).toBe('上次确认状态');
    expect(row(16).textContent).not.toContain('待用户输入');
    expect(row(15).querySelector('[aria-label="任务进行中"]')).toBeNull();
    expect(desktopDirectory(directory)[0]!.sessions[0]!.updatedAt).toBe(
      new Date(base + 100000).toISOString(),
    );
    await act(async () => row(15).click());
    expect(opened).toEqual(['s-15']);
    const fold = element.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => fold.click());
    await act(async () => fold.click());
    expect(rows()).toHaveLength(5);
  } finally {
    await act(async () => root.unmount());
    restoreLayoutGlobals();
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

test('directory owner observation keeps exited work unverified without a running spinner or input badge', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayoutGlobals = prepareDesktopDom(dom);
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const element = dom.window.document.getElementById('root')!;
  const root = createRoot(element);
  const directory: NativeDirectory = {
    storeId: 'store',
    workspaces: [{ id: 'workspace', name: '项目', rootUri: 'file:///workspace' }],
    sessions: [
      {
        id: 'session',
        workspaceId: 'workspace',
        rootSessionId: 'session',
        parentSessionId: null,
        title: '原会话',
        controlRevision: '0',
        contextSelectionId: 'selection',
        nextSeq: '0',
        deletedAt: null,
        activity: {
          updatedAt: null,
          queued: false,
          pendingInteractions: 0,
          executionOwner: 'unheld',
          run: { id: 'run', status: 'running', isActive: true, waitingForResults: false },
        },
      },
    ],
  };
  const activity = directory.sessions[0]!.activity!;
  const render = async () => {
    const summary = desktopDirectory(directory)[0]!.sessions[0]!;
    await act(async () =>
      root.render(
        <Sidebar
          actions={{}}
          connectionLabel="本地 Agent"
          workspaces={desktopDirectory(directory)}
          selected="session"
          defaultExpanded
          onOpen={() => {}}
        />,
      ),
    );
    return summary;
  };
  const row = () => element.querySelector<HTMLButtonElement>('button.session-row')!;
  const expectUnverified = async () => {
    const summary = await render();
    expect(summary.status).toBe('执行状态待核实');
    expect(summary.waitingReason).toBeUndefined();
    expect(Boolean(summary.pendingInteractions)).toBe(false);
    expect(row().getAttribute('aria-description')).toBe('执行状态待核实');
    expect(row().querySelector('[aria-label="会话运行中"]')).toBeNull();
    expect(row().querySelector('[aria-label="任务进行中"]')).toBeNull();
    expect(row().textContent).not.toContain('待用户输入');
  };
  try {
    await expectUnverified();
    activity.run = {
      id: 'run',
      status: 'waiting_execution',
      isActive: true,
      waitingForResults: true,
    };
    await expectUnverified();
    activity.run = {
      id: 'run',
      status: 'waiting_interaction',
      isActive: true,
      waitingForResults: false,
    };
    activity.pendingInteractions = 1;
    await expectUnverified();

    for (const executionOwner of ['held', undefined] as const) {
      if (executionOwner === undefined) delete activity.executionOwner;
      else activity.executionOwner = executionOwner;
      activity.pendingInteractions = 0;
      activity.run = {
        id: 'run',
        status: 'running',
        isActive: true,
        waitingForResults: false,
      };
      expect((await render()).status).toBe('running');
      expect(row().querySelector('[aria-label="会话运行中"]')).not.toBeNull();
      activity.run = {
        id: 'run',
        status: 'waiting_execution',
        isActive: true,
        waitingForResults: true,
      };
      const waiting = await render();
      expect(waiting.status).toBe('waiting');
      expect(waiting.waitingReason).toBe('required_background');
      expect(row().querySelector('[aria-label="任务进行中"]')).not.toBeNull();
    }

    activity.executionOwner = 'unheld';
    activity.pendingInteractions = 1;
    directory.unavailable = true;
    const stale = await render();
    expect(stale.status).toBe('上次确认状态');
    expect(stale.waitingReason).toBeUndefined();
    expect(Boolean(stale.pendingInteractions)).toBe(false);
    expect(row().getAttribute('aria-description')).toBe('上次确认状态');
    expect(row().querySelector('[aria-label="任务进行中"]')).toBeNull();
    expect(row().textContent).not.toContain('待用户输入');
  } finally {
    await act(async () => root.unmount());
    restoreLayoutGlobals();
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
