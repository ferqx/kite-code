import { expect, test } from 'bun:test';
import type { SkillCataloguePage } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeSelection,
  NativeSkillsPage,
  NativeSkillsRequest,
} from '../src/native-bridge';
import { NativeSkillsSettings } from '../src/native-skills-settings';

const selected = (id = 'a', workspaceId = 'workspace', viewSelection = 2) =>
  ({
    storeId: 'store',
    session: { id, workspaceId },
    canReadSkills: true,
    viewSelection,
  }) as NativeSelection;
const entries: SkillCataloguePage['entries'] = Array.from({ length: 303 }, (_, index) => ({
  id: `skill-${String(index).padStart(3, '0')}`,
  name: `Skill ${index}`,
  description: `摘要 ${index} 保留全文\n尾部🙂`,
  source: { scope: 'project', origin: '.agents' },
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
  options: Partial<SkillCataloguePage> = {},
): NativeSkillsPage {
  return {
    kind: 'settings.skills.page',
    readId: request.readId,
    scope: {
      generation: request.generation,
      viewSelection: request.method === 'settings.skills.open' ? request.viewSelection : 2,
      historyEpoch: request.method === 'settings.skills.open' ? request.historyEpoch : 0,
      storeId: 'store',
      sessionId: 'a',
      workspaceId: 'workspace',
    },
    page: {
      version: 1,
      storeId: 'store',
      workspaceId: 'workspace',
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
    render: (
      bridge: NativeBridge,
      selection?: NativeSelection,
      historyEpoch?: number,
    ) => Promise<void>,
  ) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  try {
    await run(host, root, async (bridge, selection = selected(), historyEpoch = 0) => {
      await act(async () =>
        root.render(
          <NativeSkillsSettings
            bridge={bridge}
            generation={1}
            selection={selection}
            historyEpoch={historyEpoch}
          />,
        ),
      );
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
}
const bridgeOf = (request: (request: NativeSkillsRequest) => Promise<NativeSkillsPage | null>) =>
  ({ request, watch: () => () => undefined }) as NativeBridge;
const refresh = async (host: HTMLElement) =>
  act(async () =>
    [...host.querySelectorAll('button')]
      .find((value) => value.textContent === '刷新 Skills 目录')!
      .click(),
  );

test('Skills DOM publishes all fixed-revision pages with full descriptions, finite sources and local statuses', async () =>
  fixture(async (host, _root, render) => {
    const rows = structuredClone(entries);
    rows[300]!.source = { scope: 'project', origin: '.kite-code' };
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
    expect(host.textContent).toContain('已完整读取 303 项 Skill。');
    expect(host.querySelectorAll('li')).toHaveLength(303);
    expect(host.textContent).toContain('摘要 302 保留全文\n尾部🙂');
    expect(host.textContent).toContain('配置来源：项目 · .agents');
    expect(host.textContent).toContain('配置来源：项目 · .kite-code');
    expect(host.textContent).toContain('配置来源：用户 · Profile Skills');
    expect(host.textContent).toContain('来源无法确定');
    expect(host.textContent).toContain('缺少能力：files.write');
    expect([...host.querySelectorAll('summary')].at(-2)?.textContent).toContain('已禁用');
    expect(calls.filter((call) => call.method === 'settings.skills.next')).toHaveLength(8);
    expect(calls.at(-1)?.method).toBe('settings.skills.close');
    const count = calls.length;
    await render(bridge, { ...selected(), viewGeneration: 9 });
    expect(calls).toHaveLength(count);
  }));

test('same scope refresh failure retains the complete directory and never presents a partial new prefix', async () =>
  fixture(async (host, _root, render) => {
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
    expect(host.textContent).toContain('已完整读取 1 项 Skill。');
    await refresh(host);
    expect(host.textContent).toContain('保留上次完整目录，尚未确认最新状态');
    expect(host.querySelector('summary')?.textContent).toContain('Skill 0');
    expect(host.textContent).not.toContain('摘要 1 保留全文');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('skill_catalogue_changed');
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
    expect(host.textContent).toContain('当前工作区没有可发现的 Skill');
    expect(host.textContent).not.toContain('目录当前不可用');
    await render(bridge, { ...selected(), canReadSkills: false });
    expect(host.textContent).toContain('当前服务未提供 Skills 目录');
    expect(calls).toBe(2);
  }));

test('switching workspace closes the stalled old reader, ignores its late page and clears old facts immediately', async () =>
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
      if (request.method === 'settings.skills.open' && request.viewSelection === 2) {
        old = request;
        return held;
      }
      const value = result(request, [
        { ...entries[0]!, name: 'Other workspace', description: 'Other body' },
      ]);
      value.scope.sessionId = 'other';
      value.scope.workspaceId = 'other-workspace';
      value.page.workspaceId = 'other-workspace';
      return value;
    });
    await render(bridge);
    expect(host.querySelectorAll('li')).toHaveLength(0);
    await render(bridge, selected('other', 'other-workspace', 3));
    expect(
      calls.some((call) => call.method === 'settings.skills.close' && call.readId === old.readId),
    ).toBe(true);
    expect(host.querySelector('summary')?.textContent).toContain('Other workspace');
    await act(async () => resolve(result(old, entries)));
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.textContent).not.toContain('摘要 302');
    await act(async () => root.unmount());
    expect(calls.filter((call) => call.method === 'settings.skills.close')).toHaveLength(2);
  }));

test('observation reset cancels a stalled page and an unmounted page never publishes its late reply', async () =>
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
    await render(bridge, selected(), 1);
    expect(closed).toEqual([held[0]!.request.readId]);
    await act(async () => held[0]!.resolve(result(held[0]!.request, entries)));
    expect(host.querySelectorAll('li')).toHaveLength(0);
    await act(async () => root.unmount());
    expect(closed).toEqual(held.map((value) => value.request.readId));
    await act(async () => held[1]!.resolve(result(held[1]!.request, entries)));
    expect(host.textContent).toBe('');
  }));
