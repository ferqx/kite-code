import { expect, test } from 'bun:test';
import type { UserSkillCataloguePage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeRequest,
  NativeResult,
  NativeSkillsPage,
  NativeSkillsRequest,
} from '../src/native-bridge';

type GlobalView = { storeId?: string; canRead?: boolean; generation?: number };
const entries: UserSkillCataloguePage['entries'] = Array.from({ length: 303 }, (_, index) => ({
  id: `skill-${String(index).padStart(3, '0')}`,
  name: `Skill ${index}`,
  description: `摘要 ${index} 保留全文\n尾部🙂`,
  source: { scope: 'user', origin: '.agents' },
  version: 'a'.repeat(64),
  enabled: true,
  state: 'available',
  reason: null,
  requiredCapabilities: [],
  missingCapabilities: [],
}));
function result(
  request: NativeSkillsRequest,
  rows = entries,
  options: Partial<UserSkillCataloguePage> = {},
): NativeSkillsPage {
  return {
    kind: 'settings.skills.page',
    readId: request.readId,
    scope: {
      generation: request.generation,
      storeId: 'store',
    },
    page: {
      version: 1,
      storeId: 'store',
      scope: 'user',
      revision: 'b'.repeat(64),
      availability: 'available',
      reason: null,
      entries: rows,
      nextAfterId: null,
      complete: true,
      ...options,
    },
  };
}
async function fixture(
  run: (
    host: HTMLElement,
    root: ReturnType<typeof createRoot>,
    render: (bridge: NativeBridge, view?: GlobalView) => Promise<void>,
    panelHost: HTMLElement,
    editorControl: RefObject<{ close: () => void } | null>,
  ) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><main id="root"></main><div id="panel"></div>');
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { NativeSkillsSettings } = await import('../src/native-skills-settings');
  const host = dom.window.document.getElementById('root')!,
    panelHost = dom.window.document.getElementById('panel')!,
    root = createRoot(host);
  const editorControl: RefObject<{ close: () => void } | null> = { current: null };
  try {
    await run(
      host,
      root,
      async (bridge, view = {}) => {
        await act(async () =>
          root.render(
            <NativeSkillsSettings
              bridge={bridge}
              generation={view.generation ?? 1}
              storeId={view.storeId ?? 'store'}
              canRead={view.canRead}
              panelHost={panelHost}
              editorControl={editorControl}
            />,
          ),
        );
      },
      panelHost,
      editorControl,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const bridgeOf = (request: (request: NativeSkillsRequest) => Promise<NativeSkillsPage | null>) =>
  ({
    request: (value: NativeSkillsRequest) => {
      if (value.method === 'settings.skills.document.close') return Promise.resolve(null);
      if (value.method === 'settings.skills.document')
        return Promise.reject(Error('capability_unavailable'));
      return request(value);
    },
    watch: () => () => undefined,
  }) as NativeBridge;
const refresh = async (host: HTMLElement) =>
  act(async () =>
    [...host.querySelectorAll('button')]
      .find((value) => value.textContent === '刷新 Skills 目录')!
      .click(),
  );

const openDetail = async (host: HTMLElement, name: string) =>
  act(async () =>
    host.querySelector<HTMLButtonElement>(`[aria-label="查看 ${name} 详情"]`)!.click(),
  );

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find(
    (value) => value.textContent === label || value.getAttribute('aria-label') === label,
  )!;

const enterKeyword = async (panel: HTMLElement, keyword: string) => {
  const input = panel.querySelector<HTMLInputElement>('input[type="search"]')!;
  const window = input.ownerDocument.defaultView!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      keyword,
    );
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};

test('Skills.sh search replaces the active detail, handles empty and failed results, and ignores superseded reads', async () =>
  fixture(async (host, _root, render, panel, editorControl) => {
    const calls: string[] = [];
    let finishOld!: (value: NativeResult) => void;
    let finishClosed!: (value: NativeResult) => void;
    const bridge: NativeBridge = {
      request: async (request: NativeRequest): Promise<NativeResult> => {
        if (request.method === 'settings.skills.open') return result(request, entries.slice(0, 1));
        if (request.method !== 'settings.skills.search') return null;
        calls.push(request.query);
        if (request.query === 'first')
          return new Promise((resolve) => {
            finishOld = resolve;
          });
        if (request.query === 'close')
          return new Promise((resolve) => {
            finishClosed = resolve;
          });
        if (request.query === 'react' && calls.length === 2)
          throw Error('skill_marketplace_rate_limited');
        if (request.query === 'claude')
          throw Object.assign(Error('invalid_native_request'), { code: 'invalid_native_request' });
        return { kind: 'settings.skills.search', results: [] };
      },
      watch: () => () => undefined,
    };
    await render(bridge);
    await openDetail(host, 'Skill 0');
    const opener = button(host, '搜索 Skills');
    await act(async () => opener.click());
    expect(panel.querySelectorAll('aside')).toHaveLength(1);
    expect(panel.querySelector('aside')?.getAttribute('aria-label')).toBe('搜索 Skills');
    expect(host.ownerDocument.activeElement).toBe(panel.querySelector('input'));
    expect(opener.getAttribute('aria-controls')).toBe(panel.querySelector('aside')!.id);
    expect(button(panel, '搜索').disabled).toBe(true);
    await enterKeyword(panel, ' first ');
    expect(calls).toEqual([]);
    await act(async () => button(panel, '搜索').click());
    expect(panel.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('true');
    expect(button(panel, '搜索中…').getAttribute('aria-disabled')).toBe('true');
    await enterKeyword(panel, 'react');
    await act(async () => button(panel, '搜索').click());
    expect(calls).toEqual(['first', 'react']);
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('请稍后重试');
    await act(async () => button(panel, '搜索').click());
    expect(calls).toEqual(['first', 'react', 'react']);
    expect(panel.textContent).toContain('未找到相关 Skills');
    await act(async () =>
      finishOld({
        kind: 'settings.skills.search',
        results: [{ source: 'owner/repo', skillId: 'first', name: 'Late result', installs: 1 }],
      }),
    );
    expect(panel.textContent).toContain('未找到相关 Skills');
    expect(panel.textContent).not.toContain('Late result');
    await enterKeyword(panel, 'claude');
    await act(async () => button(panel, '搜索').click());
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('完全退出并重新启动');
    expect(panel.querySelector('input')?.value).toBe('claude');
    await enterKeyword(panel, 'close');
    await act(async () => button(panel, '搜索').click());
    await act(async () => editorControl.current!.close());
    expect(host.ownerDocument.activeElement).toBe(opener);
    expect(panel.textContent).toBe('');
    await act(async () => opener.click());
    await act(async () => finishClosed({ kind: 'settings.skills.search', results: [] }));
    expect(panel.querySelector('input')?.value).toBe('');
    expect(panel.textContent).not.toContain('未找到相关 Skills');
  }));

test('Skills.sh installation retries an explicit failure, refreshes on success and after close, and distinguishes a name collision', async () =>
  fixture(async (host, _root, render, panel, editorControl) => {
    const rows = [
      { source: 'first/repo', skillId: 'react-skill', name: 'React Skill', installs: 21 },
      { source: 'other/repo', skillId: 'react-skill', name: 'React Skill', installs: 3 },
      { source: 'third/repo', skillId: 'second-skill', name: 'Second Skill', installs: 1 },
    ];
    const installed: UserSkillCataloguePage['entries'] = [];
    const installs: string[] = [];
    let refreshes = 0;
    let finishInstall!: () => void;
    const bridge: NativeBridge = {
      request: async (request) => {
        switch (request.method) {
          case 'settings.skills.open':
            refreshes++;
            return result(request, [...installed]);
          case 'settings.skills.search':
            return { kind: 'settings.skills.search', results: rows };
          case 'settings.skills.install': {
            const { source, skillId } = request.selection;
            installs.push(source);
            if (installs.length === 1) throw Error('skill_marketplace_snapshot_unavailable');
            if (source === 'other/repo')
              return {
                kind: 'settings.skills.install',
                result: { status: 'already-installed', name: skillId },
              };
            await new Promise<void>((resolve) => {
              finishInstall = resolve;
            });
            const name = rows.find((entry) => entry.source === source)!.name;
            installed.push({
              ...entries[0]!,
              id: skillId,
              name,
              source: { scope: 'user', origin: '.kite-code' },
            });
            return {
              kind: 'settings.skills.install',
              result: { status: 'installed', name: skillId },
            };
          }
          default:
            return null;
        }
      },
      watch: () => () => undefined,
    };
    await render(bridge);
    const opener = button(host, '搜索 Skills');
    await act(async () => opener.click());
    await enterKeyword(panel, 'react');
    await act(async () => button(panel, '搜索').click());
    expect(panel.querySelectorAll('li')).toHaveLength(3);
    await act(async () => button(panel, '安装 React Skill（first/repo）').click());
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('暂时无法下载此 Skill');
    expect(refreshes).toBe(1);
    const retry = button(panel, '重试安装 React Skill（first/repo）');
    await act(async () => {
      retry.focus();
      retry.click();
      retry.click();
    });
    expect(retry.textContent).toBe('安装中…');
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    const otherInstall = button(panel, '安装 Second Skill（third/repo）');
    expect(otherInstall.getAttribute('aria-disabled')).toBe('true');
    await act(async () => otherInstall.click());
    expect(installs).toEqual(['first/repo', 'first/repo']);
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(installs).toEqual(['first/repo', 'first/repo']);
    await act(async () => finishInstall());
    expect(refreshes).toBe(2);
    expect(retry.textContent).toBe('已安装');
    expect(panel.querySelector('input')?.value).toBe('react');
    expect(host.ownerDocument.activeElement).toBe(retry);
    expect(host.textContent).toContain('React Skill');
    await act(async () => button(panel, '安装 React Skill（other/repo）').click());
    expect(button(panel, '已有同名 Skill React Skill（other/repo）')).toBeTruthy();
    expect(refreshes).toBe(3);
    await act(async () => button(panel, '安装 Second Skill（third/repo）').click());
    await act(async () => editorControl.current!.close());
    expect(panel.textContent).toBe('');
    expect(host.ownerDocument.activeElement).toBe(opener);
    await act(async () => finishInstall());
    expect(refreshes).toBe(4);
    expect(host.textContent).toContain('Second Skill');
    expect(panel.textContent).toBe('');
    expect(host.ownerDocument.activeElement).toBe(opener);
  }));

test('only an installed Skill can be confirmed for uninstall, and closing its detail keeps removal and reinstall in sync', async () =>
  fixture(async (host, _root, render, panel, editorControl) => {
    const document = host.ownerDocument;
    const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
    const remote = { source: 'owner/repo', skillId: 'example', name: 'Example', installs: 1 };
    const managed: UserSkillCataloguePage['entries'][number] = {
      ...entries[0]!,
      id: 'user-skill.example',
      name: remote.name,
      source: { scope: 'user', origin: '.kite-code' },
    };
    const builtin = { ...entries[0]!, id: 'computer-use', name: 'computer-use', source: null };
    const configured = { ...entries[0]!, id: 'user-skill.custom', name: 'Custom' };
    const calls: Extract<NativeRequest, { method: 'settings.skills.uninstall' }>[] = [];
    let installed = false;
    let finishUninstall!: () => void;
    let refreshes = 0;
    const bridge: NativeBridge = {
      request: async (request) => {
        switch (request.method) {
          case 'settings.skills.open':
            refreshes++;
            return result(request, [builtin, configured, ...(installed ? [managed] : [])]);
          case 'settings.skills.search':
            return { kind: 'settings.skills.search', results: [remote] };
          case 'settings.skills.install':
            installed = true;
            return {
              kind: 'settings.skills.install',
              result: { status: 'installed', name: remote.skillId },
            };
          case 'settings.skills.uninstall':
            calls.push(request);
            if (calls.length === 1) {
              managed.version = 'c'.repeat(64);
              throw Error('skill_marketplace_version_changed');
            }
            await new Promise<void>((resolve) => {
              finishUninstall = resolve;
            });
            installed = false;
            return {
              kind: 'settings.skills.uninstall',
              result: { status: 'uninstalled', skillId: managed.id },
            };
          default:
            return null;
        }
      },
      watch: () => () => undefined,
    };
    await render(bridge);
    for (const name of ['computer-use', 'Custom']) {
      await openDetail(host, name);
      expect(button(panel, '卸载')).toBeUndefined();
    }

    const search = button(host, '搜索 Skills');
    await act(async () => search.click());
    await enterKeyword(panel, 'example');
    await act(async () => button(panel, '搜索').click());
    await act(async () => button(panel, '安装 Example（owner/repo）').click());
    expect(button(panel, '已安装 Example（owner/repo）')).toBeTruthy();
    await openDetail(host, 'Example');
    await act(async () => button(panel, '卸载').click());
    expect(dialog()?.textContent).toContain('卸载「Example」？');
    expect(dialog()?.textContent).toContain('该 Skill 及其配套文件将移到系统废纸篓。');
    expect(panel.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button(dialog()!, '取消'));
    await act(async () => button(dialog()!, '取消').click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(calls).toHaveLength(0);
    expect(document.activeElement === button(panel, '卸载')).toBe(true);

    await act(async () => button(panel, '卸载').click());
    await act(async () => {
      dialog()!.dispatchEvent(
        new document.defaultView!.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(dialog()).toBeNull();
    expect(calls).toHaveLength(0);
    expect(document.activeElement === button(panel, '卸载')).toBe(true);

    await act(async () => button(panel, '卸载').click());
    await act(async () => button(dialog()!, '确认卸载').click());
    expect(calls[0]).toEqual({
      method: 'settings.skills.uninstall',
      generation: 1,
      selection: { skillId: managed.id, skillVersion: 'a'.repeat(64) },
    });
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('请刷新目录');
    expect(dialog()).toBeNull();
    await act(async () => button(panel, '刷新目录').click());
    expect(refreshes).toBe(3);

    await act(async () => button(panel, '卸载').click());
    const confirm = button(dialog()!, '确认卸载');
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.selection.skillVersion).toBe('c'.repeat(64));
    expect(dialog()).toBeNull();
    expect(button(panel, '正在卸载…').disabled).toBe(true);
    await act(async () => editorControl.current!.close());
    await openDetail(host, 'computer-use');
    await act(async () => finishUninstall());
    expect(refreshes).toBe(4);
    expect(host.textContent).not.toContain('Example');
    expect(panel.querySelector('aside')?.getAttribute('aria-label')).toBe('computer-use 详情');

    await act(async () => search.click());
    await enterKeyword(panel, 'example');
    await act(async () => button(panel, '搜索').click());
    await act(async () => button(panel, '安装 Example（owner/repo）').click());
    await openDetail(host, 'Example');
    await act(async () => button(panel, '卸载').click());
    await act(async () => button(dialog()!, '确认卸载').click());
    await act(async () => finishUninstall());
    expect(panel.querySelector('aside')).toBeNull();
    expect(host.ownerDocument.activeElement).toBe(search);
    expect(host.textContent).not.toContain('Example');
  }));

test.each([
  'install',
  'uninstall',
] as const)('%s completion refreshes only the matching remounted Skills reader', async (operation) => {
  for (const replacement of [
    'same',
    'generation',
    'store',
    'bridge',
    'unavailable',
    'unmounted',
    'failure',
  ] as const) {
    await fixture(async (host, root, render, panel) => {
      const remote = { source: 'owner/repo', skillId: 'example', name: 'Example', installs: 1 };
      const managed: UserSkillCataloguePage['entries'][number] = {
        ...entries[0]!,
        id: 'user-skill.example',
        name: 'Example',
        source: { scope: 'user' as const, origin: '.kite-code' },
      };
      let installed = operation === 'uninstall';
      let storeId = 'store';
      let reads = 0;
      let mutations = 0;
      let finish!: () => void;
      const bridge: NativeBridge = {
        request: async (request) => {
          if (request.method === 'settings.skills.open') {
            reads++;
            const reply = result(request, installed ? [managed] : []);
            reply.scope.storeId = storeId;
            reply.page.storeId = storeId;
            return reply;
          }
          if (request.method === 'settings.skills.search')
            return { kind: 'settings.skills.search', results: [remote] };
          if (
            request.method === 'settings.skills.install' ||
            request.method === 'settings.skills.uninstall'
          ) {
            mutations++;
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            if (replacement === 'failure') throw Error('skill_marketplace_unavailable');
            installed = operation === 'install';
            return request.method === 'settings.skills.install'
              ? {
                  kind: 'settings.skills.install',
                  result: { status: 'installed', name: remote.skillId },
                }
              : {
                  kind: 'settings.skills.uninstall',
                  result: { status: 'uninstalled', skillId: managed.id },
                };
          }
          return null;
        },
        watch: () => () => undefined,
      };
      await render(bridge);
      if (operation === 'install') {
        await act(async () => button(host, '搜索 Skills').click());
        await enterKeyword(panel, 'example');
        await act(async () => button(panel, '搜索').click());
        await act(async () => button(panel, '安装 Example（owner/repo）').click());
      } else {
        await openDetail(host, 'Example');
        await act(async () => button(panel, '卸载').click());
        const dialog = host.ownerDocument.querySelector<HTMLElement>('[role="alertdialog"]')!;
        await act(async () => button(dialog, '确认卸载').click());
      }
      expect(mutations).toBe(1);
      // Settings-category navigation destroys the page, without cancelling the Main mutation.
      await act(async () => root.render(null));
      storeId = replacement === 'store' ? 'other-store' : 'store';
      const nextBridge = replacement === 'bridge' ? { ...bridge } : bridge;
      if (replacement !== 'unmounted')
        await render(nextBridge, {
          storeId,
          generation: replacement === 'generation' ? 2 : 1,
          canRead: replacement !== 'unavailable',
        });
      const before = reads;
      const focus = replacement === 'same' ? button(host, '搜索 Skills') : null;
      await act(async () => focus?.focus());
      await act(async () => finish());
      expect(mutations).toBe(1);
      expect(reads).toBe(before + (replacement === 'same' ? 1 : 0));
      if (replacement === 'same') {
        expect(host.querySelectorAll('li')).toHaveLength(operation === 'install' ? 1 : 0);
        expect(panel.textContent).toBe('');
        expect(host.ownerDocument.activeElement).toBe(focus);
      }
      if (replacement === 'unmounted') {
        await render(bridge);
        expect(reads).toBe(before + 1);
        expect(host.querySelectorAll('li')).toHaveLength(operation === 'install' ? 1 : 0);
      }
    });
  }
});

test('Skill mutation subscriptions are scoped, released and do not replay old completions', async () => {
  const { notifyNativeSkillMutation, watchNativeSkillMutations } = await import(
    '../src/native-skill-mutations'
  );
  const bridge = bridgeOf(async () => null);
  const scope = { generation: 1, storeId: 'store' };
  let calls = 0;
  const stop = watchNativeSkillMutations(bridge, scope, () => {
    calls++;
  });
  notifyNativeSkillMutation(bridge, { ...scope, generation: 2 });
  notifyNativeSkillMutation(bridge, { ...scope, storeId: 'other' });
  notifyNativeSkillMutation({ ...bridge }, scope);
  expect(calls).toBe(0);
  notifyNativeSkillMutation(bridge, scope);
  expect(calls).toBe(1);
  stop();
  notifyNativeSkillMutation(bridge, scope);
  expect(calls).toBe(1);
  const stopNext = watchNativeSkillMutations(bridge, scope, () => {
    calls++;
  });
  expect(calls).toBe(1);
  stop(); // A repeated cleanup cannot remove a newer subscription.
  notifyNativeSkillMutation(bridge, scope);
  expect(calls).toBe(2);
  stopNext();
  notifyNativeSkillMutation(bridge, scope);
  expect(calls).toBe(2);
});

test('Skills with empty or missing descriptions use the same fallback in the list and details', async () =>
  fixture(async (host, _root, render, panel) => {
    const rows = [null, '', '  \n  ', '第一行\n第二行'].map((description, index) => ({
      ...entries[index]!,
      description,
    }));
    await render(bridgeOf(async (request) => result(request, rows)));
    for (const row of rows) {
      const expected = row.description?.trim() || '无描述';
      expect(button(host, `查看 ${row.name} 详情`).textContent).toContain(expected);
      await openDetail(host, row.name!);
      expect(panel.querySelector('.skill-detail-description')?.textContent).toBe(expected);
    }
  }));

test('Skill details prioritize versioned Markdown, identify the builtin, and retire an old document without executing its content', async () =>
  fixture(async (host, _root, render, panelHost, editorControl) => {
    const calls: NativeSkillsRequest[] = [];
    let release!: () => void;
    let first = true;
    const rows: UserSkillCataloguePage['entries'] = [
      {
        ...entries[0]!,
        id: 'computer-use',
        name: 'computer-use',
        source: null,
        state: 'unavailable' as const,
        reason: 'skill_capability_missing' as const,
        requiredCapabilities: ['browser.execute'],
        missingCapabilities: ['browser.execute'],
      },
      entries[0]!,
    ];
    const bridge = {
      request: async (request: NativeSkillsRequest) => {
        calls.push(request);
        if (
          request.method === 'settings.skills.close' ||
          request.method === 'settings.skills.document.close'
        )
          return null;
        if (request.method !== 'settings.skills.document') return result(request, rows);
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return {
          kind: 'settings.skills.document',
          readId: request.readId,
          scope: { generation: 1, storeId: 'store' },
          document: {
            storeId: 'store',
            skillId: request.skillId,
            skillVersion: request.skillVersion,
            revision: request.revision,
            body: `---\nname: hidden frontmatter\n---\n# ${request.skillId}\n\n1. 保留正文🙂\n2. 使用说明\n\n<script>window.skillExecuted = true</script>\n`,
          },
        };
      },
    } as NativeBridge;
    await render(bridge);
    await openDetail(host, 'computer-use');
    expect(panelHost.textContent).toContain('来源：内置技能');
    expect(panelHost.querySelector('.skill-document')?.getAttribute('aria-busy')).toBe('true');
    expect(panelHost.textContent).not.toContain('所需功能');
    expect(host.querySelector('.provider-badge')).toBeNull();
    expect(panelHost.querySelector('.provider-badge')).toBeNull();
    expect(panelHost.textContent).not.toContain('当前环境未提供');
    expect(panelHost.textContent).not.toContain('skill_capability_missing');
    expect(panelHost.textContent).not.toContain('browser.execute');
    await openDetail(host, 'Skill 0');
    expect(panelHost.querySelector('.provider-badge')).toBeNull();
    expect(panelHost.querySelector('.skill-document h1')?.textContent).toBe('skill-000');
    expect(panelHost.querySelector('.skill-document ol')?.textContent).toContain('保留正文🙂');
    expect(panelHost.querySelector('.skill-document')?.textContent).not.toContain(
      'hidden frontmatter',
    );
    expect(panelHost.querySelector('script')).toBeNull();
    expect(Reflect.get(host.ownerDocument.defaultView!, 'skillExecuted')).toBeUndefined();
    await act(async () => release());
    expect(panelHost.querySelector('.skill-document h1')?.textContent).toBe('skill-000');
    await openDetail(host, 'computer-use');
    expect(panelHost.querySelector('.skill-document h1')?.textContent).toBe('computer-use');
    const document = panelHost.querySelector('.skill-document');
    rows[0] = { ...rows[0]!, state: 'available', reason: null, missingCapabilities: [] };
    await refresh(host);
    expect(host.querySelector('.provider-badge')).toBeNull();
    expect(panelHost.querySelector('.provider-badge')).toBeNull();
    expect(panelHost.textContent).not.toContain('所需功能');
    expect(panelHost.querySelector('.skill-document')).toBe(document);
    expect(panelHost.textContent).not.toContain('已提供');
    await act(async () => editorControl.current!.close());
    expect(panelHost.textContent).toBe('');
    expect(host.ownerDocument.activeElement?.getAttribute('aria-label')).toBe(
      '查看 computer-use 详情',
    );
    expect(calls.filter((call) => call.method === 'settings.skills.document')).toHaveLength(3);
    expect(calls.filter((call) => call.method === 'settings.skills.document.close')).toHaveLength(
      3,
    );
    expect(calls.every((call) => call.method.startsWith('settings.skills.'))).toBe(true);
  }));

test('Skills DOM publishes all fixed-revision pages with useful details and no internal identifiers', async () =>
  fixture(async (host, _root, render, panelHost) => {
    const rows = structuredClone(entries);
    rows[299]!.source = undefined;
    rows[300]!.source = { scope: 'user', origin: '.kite-code' };
    rows[300]!.state = 'unavailable';
    rows[300]!.reason = 'skill_path_denied';
    rows[301] = {
      ...rows[301]!,
      enabled: false,
      state: 'disabled',
      name: null,
      description: null,
      version: null,
      source: null,
    };
    rows[302] = {
      ...rows[302]!,
      state: 'unavailable',
      reason: 'skill_capability_missing',
      requiredCapabilities: ['files.read', 'files.write'],
      missingCapabilities: ['files.write'],
      source: { scope: 'user', origin: 'profile' },
    };
    let cursor = 0;
    const calls: NativeSkillsRequest[] = [];
    const bridge = bridgeOf(async (request) => {
      calls.push(request);
      if (request.method === 'settings.skills.close') return null;
      const items = rows.slice(cursor, cursor + 37);
      cursor += items.length;
      return result(request, items, {
        complete: cursor === rows.length,
        nextAfterId: cursor === rows.length ? null : items.at(-1)!.id,
      });
    });
    await render(bridge);
    expect(host.querySelector('.provider-directory-heading span:last-child')?.textContent).toBe(
      '303',
    );
    for (const hidden of ['已完整读取', '工作区：', '可信配置来源', '状态不授予执行权限'])
      expect(host.textContent).not.toContain(hidden);
    expect(host.querySelectorAll('li')).toHaveLength(303);
    expect(host.textContent).toContain('摘要 302 保留全文\n尾部🙂');
    expect(host.textContent).toContain('来源：个人 · .agents');
    expect(host.textContent).toContain('来源：个人 · .kite-code');
    expect(host.textContent).toContain('来源：个人 · Profile Skills');
    expect(host.textContent).toContain('未提供来源信息');
    expect(host.textContent).toContain('来源：未记录');
    expect(host.querySelectorAll('summary')).toHaveLength(0);
    expect(host.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(host.querySelector('[aria-label="查看 skill-301 详情"]')?.textContent).toContain(
      '已禁用',
    );
    expect(
      [...host.querySelectorAll('button')].some((value) =>
        /新增|添加|上传|安装|启用/.test(value.textContent ?? ''),
      ),
    ).toBe(false);
    expect(panelHost.textContent).toBe('');
    expect(host.textContent).not.toContain('缺少能力：files.write');
    await openDetail(host, 'Skill 302');
    expect(panelHost.querySelector('aside')?.getAttribute('aria-label')).toBe('Skill 302 详情');
    expect(panelHost.textContent).toContain('摘要 302 保留全文\n尾部🙂');
    expect(panelHost.textContent).not.toContain('所需功能');
    expect(panelHost.textContent).not.toContain('files.read');
    expect(panelHost.textContent).not.toContain('files.write');
    expect(panelHost.querySelector('.provider-badge')).toBeNull();
    expect(panelHost.textContent).not.toContain('当前环境未提供');
    expect(panelHost.textContent).not.toContain('已提供');
    expect(panelHost.textContent).not.toContain('skill_capability_missing');
    expect(panelHost.querySelector('details')).toBeNull();
    for (const hidden of [
      '技术详情',
      '配置 ID',
      'skill-302',
      '版本：',
      'a'.repeat(64),
      '只读目录信息',
    ])
      expect(panelHost.textContent).not.toContain(hidden);
    expect(panelHost.querySelectorAll('input, textarea, select')).toHaveLength(0);
    await openDetail(host, 'skill-301');
    expect(panelHost.textContent).toContain('无描述');
    expect(panelHost.textContent).not.toContain('版本：');
    expect(panelHost.textContent).toContain('未提供来源信息');
    expect(panelHost.querySelector('.provider-badge')?.textContent).toBe('已禁用');
    expect(host.querySelector('[aria-label="查看 Skill 300 详情"]')?.textContent).toContain(
      '需处理',
    );
    await openDetail(host, 'Skill 300');
    expect(panelHost.querySelector('.provider-badge')?.textContent).toBe('需处理');
    expect(panelHost.textContent).toContain('无法访问技能所在位置。');
    expect(calls.filter((call) => call.method === 'settings.skills.next')).toHaveLength(8);
    expect(calls.at(-1)?.method).toBe('settings.skills.close');
    expect(
      calls.every((call) =>
        ['settings.skills.open', 'settings.skills.next', 'settings.skills.close'].includes(
          call.method,
        ),
      ),
    ).toBe(true);
    const count = calls.length;
    await render(bridge, { storeId: 'store', generation: 1 });
    expect(calls).toHaveLength(count);
  }));

test('same scope refresh failure retains the complete directory and detail without a partial new prefix', async () =>
  fixture(async (host, _root, render, panelHost) => {
    let pass = 0;
    const bridge = bridgeOf(async (request) => {
      if (request.method === 'settings.skills.close') return null;
      if (request.method === 'settings.skills.open') {
        pass++;
        return pass === 1
          ? result(request, entries.slice(0, 1))
          : result(request, entries.slice(1, 2), { complete: false, nextAfterId: entries[1]!.id });
      }
      throw Error('skill_catalogue_changed');
    });
    await render(bridge);
    expect(host.querySelectorAll('li')).toHaveLength(1);
    await openDetail(host, 'Skill 0');
    await refresh(host);
    expect(host.textContent).toContain('保留上次完整目录，尚未确认最新状态');
    expect(host.querySelector('li button')?.textContent).toContain('Skill 0');
    expect(panelHost.textContent).toContain('详情尚未确认最新状态：skill_catalogue_changed');
    expect(panelHost.querySelector('h3')?.textContent).toBe('Skill 0');
    expect(host.textContent).not.toContain('摘要 1 保留全文');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('skill_catalogue_changed');
  }));

test('refresh retries a failed document at the same revision and does not reread a complete unchanged body', async () =>
  fixture(async (host, _root, render, panelHost) => {
    let reads = 0;
    const bridge = {
      request: async (request: NativeSkillsRequest) => {
        if (request.method.endsWith('.close')) return null;
        if (request.method !== 'settings.skills.document')
          return result(request, entries.slice(0, 1));
        if (++reads === 1) throw Error('temporary_read_failure');
        return {
          kind: 'settings.skills.document',
          readId: request.readId,
          scope: { generation: 1, storeId: 'store' },
          document: {
            storeId: 'store',
            skillId: request.skillId,
            skillVersion: request.skillVersion,
            revision: request.revision,
            body: '# 完整正文\n\n保留阅读',
          },
        };
      },
    } as NativeBridge;
    await render(bridge);
    await openDetail(host, 'Skill 0');
    expect(panelHost.textContent).toContain('暂时无法读取技能正文');
    await refresh(host);
    expect(panelHost.querySelector('.skill-document h1')?.textContent).toBe('完整正文');
    expect(reads).toBe(2);
    const document = panelHost.querySelector<HTMLElement>('.skill-document')!;
    document.scrollTop = 120;
    await refresh(host);
    expect(panelHost.querySelector('.skill-document')).toBe(document);
    expect(document.scrollTop).toBe(120);
    expect(reads).toBe(2);
  }));

test('malformed user configuration retains the complete directory and selected detail until correction', async () =>
  fixture(async (host, _root, render, panelHost) => {
    let pass = 0;
    const bridge = bridgeOf(async (request) => {
      if (request.method === 'settings.skills.close') return null;
      return ++pass === 1
        ? result(request, entries.slice(0, 1))
        : pass === 2
          ? result(request, [], {
              availability: 'unavailable',
              reason: 'configuration_unavailable',
            })
          : result(request, []);
    });
    await render(bridge);
    await openDetail(host, 'Skill 0');
    await refresh(host);
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.textContent).toContain('保留上次完整目录，尚未确认最新状态');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'configuration_unavailable',
    );
    expect(panelHost.querySelector('h3')?.textContent).toBe('Skill 0');
    expect(panelHost.textContent).toContain('详情尚未确认最新状态：configuration_unavailable');
    await refresh(host);
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(host.textContent).toContain('尚未配置用户 Skill。');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  }));

test('available empty, unavailable source and missing capability have distinct readonly states', async () =>
  fixture(async (host, _root, render) => {
    let unavailable = true,
      calls = 0;
    const bridge = bridgeOf(async (request) => {
      if (request.method === 'settings.skills.close') return null;
      calls++;
      return result(
        request,
        [],
        unavailable ? { availability: 'unavailable', reason: 'configuration_unavailable' } : {},
      );
    });
    await render(bridge);
    expect(host.textContent).toContain('Skills 目录当前不可用：configuration_unavailable');
    expect(host.textContent).not.toContain('没有可发现');
    unavailable = false;
    await refresh(host);
    expect(host.textContent).toContain('尚未配置用户 Skill。');
    expect(host.textContent).not.toContain('目录当前不可用');
    await render(bridge, { canRead: false });
    expect(host.textContent).toContain('当前服务未提供 Skills 目录');
    expect(calls).toBe(2);
  }));

test('switching global Store closes the stalled old reader, ignores its late page and clears old facts immediately', async () =>
  fixture(async (host, root, render) => {
    let resolve!: (value: NativeSkillsPage) => void;
    let old!: NativeSkillsRequest;
    const held = new Promise<NativeSkillsPage>((done) => {
      resolve = done;
    });
    const calls: NativeSkillsRequest[] = [];
    const bridge = bridgeOf(async (request) => {
      calls.push(request);
      if (request.method === 'settings.skills.close') return null;
      if (request.method === 'settings.skills.open' && !old) {
        old = request;
        return held;
      }
      const value = result(request, [
        { ...entries[0]!, name: 'Other store', description: 'Other body' },
      ]);
      value.scope.storeId = 'other-store';
      value.page.storeId = 'other-store';
      return value;
    });
    await render(bridge);
    expect(host.querySelectorAll('li')).toHaveLength(0);
    await render(bridge, { storeId: 'other-store' });
    expect(
      calls.some((call) => call.method === 'settings.skills.close' && call.readId === old.readId),
    ).toBe(true);
    expect(host.querySelector('li button')?.textContent).toContain('Other store');
    await act(async () => resolve(result(old, entries)));
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.textContent).not.toContain('摘要 302');
    await act(async () => root.unmount());
    expect(calls.filter((call) => call.method === 'settings.skills.close')).toHaveLength(2);
  }));

test('generation replacement cancels a stalled page and an unmounted page never publishes its late reply', async () =>
  fixture(async (host, root, render) => {
    const held: { request: NativeSkillsRequest; resolve: (value: NativeSkillsPage) => void }[] = [];
    const closed: string[] = [];
    const bridge = bridgeOf(async (request) => {
      if (request.method === 'settings.skills.close') {
        closed.push(request.readId);
        return null;
      }
      return new Promise<NativeSkillsPage>((resolve) => held.push({ request, resolve }));
    });
    await render(bridge);
    await render(bridge, { generation: 2 });
    expect(closed).toEqual([held[0]!.request.readId]);
    await act(async () => held[0]!.resolve(result(held[0]!.request, entries)));
    expect(host.querySelectorAll('li')).toHaveLength(0);
    await act(async () => root.unmount());
    expect(closed).toEqual(held.map((value) => value.request.readId));
    await act(async () => held[1]!.resolve(result(held[1]!.request, entries)));
    expect(host.textContent).toBe('');
  }));

test('Skill details live only in the far-right host and close controls restore the selected row focus', async () =>
  fixture(async (host, root, render, panelHost, editorControl) => {
    const calls: NativeSkillsRequest[] = [];
    const bridge = bridgeOf(async (request) => {
      calls.push(request);
      return request.method === 'settings.skills.close'
        ? null
        : result(request, entries.slice(0, 2));
    });
    await render(bridge);
    const first = host.querySelector<HTMLButtonElement>('[aria-label="查看 Skill 0 详情"]')!;
    const second = host.querySelector<HTMLButtonElement>('[aria-label="查看 Skill 1 详情"]')!;
    expect(editorControl.current).toBeNull();
    await openDetail(host, 'Skill 0');
    expect(host.querySelector('aside')).toBeNull();
    expect(panelHost.querySelector('aside')).not.toBeNull();
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(first.getAttribute('aria-controls')).toBe(panelHost.querySelector('aside')!.id);
    expect(host.ownerDocument.activeElement).toBe(panelHost.querySelector('h3'));
    const count = calls.length;
    await openDetail(host, 'Skill 1');
    expect(panelHost.querySelector('h3')?.textContent).toBe('Skill 1');
    expect(panelHost.textContent).not.toContain('摘要 0 保留全文');
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(second.getAttribute('aria-expanded')).toBe('true');
    await act(async () =>
      panelHost.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click(),
    );
    expect(panelHost.textContent).toBe('');
    expect(editorControl.current).toBeNull();
    expect(host.ownerDocument.activeElement).toBe(second);
    await openDetail(host, 'Skill 0');
    await act(async () =>
      [...panelHost.querySelectorAll('button')]
        .find((button) => button.textContent === '关闭')!
        .click(),
    );
    expect(host.ownerDocument.activeElement).toBe(first);
    await openDetail(host, 'Skill 1');
    // The settings Dialog routes its first Escape through this shared control.
    await act(async () => editorControl.current!.close());
    expect(panelHost.textContent).toBe('');
    expect(editorControl.current).toBeNull();
    expect(host.ownerDocument.activeElement).toBe(second);
    expect(calls).toHaveLength(count);
    await openDetail(host, 'Skill 0');
    await act(async () => root.unmount());
    expect(panelHost.textContent).toBe('');
    expect(editorControl.current).toBeNull();
  }));

test('refresh keeps selected details busy without loading text and removes missing entry metadata', async () =>
  fixture(async (host, _root, render, panelHost, editorControl) => {
    let pass = 0;
    let pending!: NativeSkillsRequest;
    let resolve!: (value: NativeSkillsPage) => void;
    const bridge = bridgeOf(async (request) => {
      if (request.method === 'settings.skills.close') return null;
      if (++pass === 1) return result(request, entries.slice(0, 1));
      pending = request;
      return new Promise<NativeSkillsPage>((done) => {
        resolve = done;
      });
    });
    await render(bridge);
    await openDetail(host, 'Skill 0');
    await refresh(host);
    expect(host.querySelector('[aria-label="Skills 目录"]')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(host.textContent).not.toContain('正在读取');
    expect(panelHost.textContent).not.toContain('正在刷新');
    expect(panelHost.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(panelHost.querySelector('h3')?.textContent).toBe('Skill 0');
    expect(host.querySelector<HTMLButtonElement>('.provider-refresh')!.disabled).toBe(true);
    await act(async () => resolve(result(pending, [])));
    expect(host.textContent).toContain('尚未配置用户 Skill。');
    expect(panelHost.textContent).not.toContain('摘要 0 保留全文');
    expect(panelHost.textContent).toContain('此 Skill 已不在最新目录中');
    await act(async () => editorControl.current!.close());
    expect(host.ownerDocument.activeElement).toBe(host.querySelector('.provider-refresh'));
  }));

test.each([
  'store',
  'generation',
  'capability',
] as const)('%s changes clear open Skill details and reject late refresh responses', async (change) =>
  fixture(async (host, _root, render, panelHost, editorControl) => {
    let pass = 0;
    const held: { request: NativeSkillsRequest; resolve: (value: NativeSkillsPage) => void }[] = [];
    const closed: string[] = [];
    const bridge = bridgeOf(async (request) => {
      if (request.method === 'settings.skills.close') {
        closed.push(request.readId);
        return null;
      }
      if (++pass === 1) return result(request, entries.slice(0, 1));
      return new Promise<NativeSkillsPage>((resolve) => held.push({ request, resolve }));
    });
    await render(bridge);
    await openDetail(host, 'Skill 0');
    await refresh(host);
    const old = held[0]!;
    expect(panelHost.querySelector('h3')?.textContent).toBe('Skill 0');
    await render(bridge, {
      storeId: change === 'store' ? 'other-store' : 'store',
      generation: change === 'generation' ? 2 : 1,
      canRead: change !== 'capability',
    });
    expect(closed).toContain(old.request.readId);
    expect(panelHost.textContent).toBe('');
    expect(editorControl.current).toBeNull();
    expect(host.querySelectorAll('li')).toHaveLength(0);
    await act(async () => old.resolve(result(old.request, entries)));
    expect(panelHost.textContent).toBe('');
    expect(host.querySelectorAll('li')).toHaveLength(0);
    if (change !== 'capability') {
      const next = held[1]!;
      const value = result(next.request, [{ ...entries[0]!, description: 'New scope details' }]);
      if (change === 'store') {
        value.scope.storeId = 'other-store';
        value.page.storeId = 'other-store';
      }
      await act(async () => next.resolve(value));
      expect(host.querySelectorAll('li')).toHaveLength(1);
      expect(panelHost.textContent).toBe('');
      expect(editorControl.current).toBeNull();
      await openDetail(host, 'Skill 0');
      expect(panelHost.textContent).toContain('New scope details');
      expect(panelHost.textContent).not.toContain('摘要 0 保留全文');
    }
  }));

test('global Skills loads without any selection and never shows a Session prerequisite', async () =>
  fixture(async (host, _root, render, panelHost) => {
    const calls: NativeSkillsRequest[] = [];
    const bridge = bridgeOf(async (request) => {
      calls.push(request);
      return request.method === 'settings.skills.close'
        ? null
        : result(request, entries.slice(0, 1));
    });
    await render(bridge);
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.textContent).toContain('Skill 0');
    expect(host.textContent).not.toMatch(/选择会话|工作区/);
    expect(host.querySelector<HTMLButtonElement>('.provider-refresh')!.disabled).toBe(false);
    expect(panelHost.textContent).toBe('');
    expect(calls.map((request) => request.method)).toEqual([
      'settings.skills.open',
      'settings.skills.close',
    ]);
    expect(calls[0]).toEqual({
      method: 'settings.skills.open',
      generation: 1,
      readId: expect.any(String),
    });
  }));

test('initial read failure is distinct from an empty catalogue and hides unsafe error text', async () =>
  fixture(async (host, _root, render, panelHost) => {
    let fail = true;
    const bridge = bridgeOf(async (request) => {
      if (request.method === 'settings.skills.close') return null;
      if (fail) throw Error('/private/unsafe/skill-source.md');
      return result(request, []);
    });
    await render(bridge);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'skill_catalogue_unavailable',
    );
    expect(host.textContent).toContain('尚未取得完整目录');
    expect(host.textContent).not.toContain('/private/unsafe');
    expect(host.textContent).not.toContain('没有可发现');
    expect(panelHost.textContent).toBe('');
    fail = false;
    await refresh(host);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('尚未配置用户 Skill。');
  }));
