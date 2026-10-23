import { expect, test } from 'bun:test';
import type { BackgroundExecutionItem, Message } from '@kite-ai/client';
import { ToolActivity } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { nativeAgentActivityForTool } from '../../src/native-agent-activity';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import { environmentDisplay, useNativeEnvironment } from '../../src/native-environment';
import { desktopToolMessage } from '../../src/native-tool-messages';
import type { NativeToolMessageFact } from '../../src/tool-messages-bridge';
import { backgroundItem } from '../background-item.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('Native environment activity preserves a receipt-free detail row and exact child identity through refresh beyond the display cache budget', async () => {
  const dom = new JSDOM('<div id="root"/>', { pretendToBeVisual: true });
  const restoreDom = prepareDesktopDom(dom);
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const item = backgroundItem(1, true);
  item.sourceTool = { id: 'spawn', definitionId: 'task.spawn', definitionVersion: '1' };
  item.execution.parentExecutionId = 'spawn';
  item.childSession!.title = 'Grant review';
  let items: BackgroundExecutionItem[] = [];
  let observation = 0;
  let holdNext = false;
  let release: (() => void) | undefined;
  const requests: NativeRequest[] = [];
  const reads = new Map<string, number>();
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      requests.push(request);
      if (request.method === 'background.open' || request.method === 'background.next') {
        if (request.method === 'background.open') {
          observation++;
          reads.set(request.readId, 0);
        }
        const offset = reads.get(request.readId)!;
        // Keep each authenticated page within the wire budget while the complete display exceeds its cache budget.
        const entries = items.slice(offset, offset + 1);
        const page = {
          kind: 'background.page' as const,
          viewGeneration: 1,
          viewSelection: 1,
          rootSessionId: 'root',
          storeId: 'store',
          readId: request.readId,
          observationId: observation,
          startIndex: offset,
          nextIndex: offset + entries.length,
          total: items.length,
          complete: offset + entries.length === items.length,
          entries,
        };
        reads.set(request.readId, page.nextIndex);
        if (request.method === 'background.open' && holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return page;
      }
      if (request.method === 'background.child.open') throw Error('fixture_child_request_observed');
      return null;
    },
  };
  const selection = {
    viewGeneration: 1,
    viewSelection: 1,
    storeId: 'store',
    session: item.rootSession,
    runs: [],
    executions: [],
    interactions: [],
    interactionsAfterId: null,
  } as unknown as NativeSelection;
  const saved: Message = {
    id: 'receipt',
    role: 'tool',
    sessionId: 'root',
    runId: 'parent-run',
    seq: '2',
    content: '{"accepted":true,"state":"queued"}',
    sourceIds: ['spawn'],
    status: 'complete',
  };
  const fact: NativeToolMessageFact = {
    messageId: saved.id,
    executionId: 'spawn',
    definitionId: 'task.spawn',
    definitionVersion: '1',
    status: 'succeeded',
    resultRevision: '1',
  };
  const guidance: Message = { ...saved, id: 'guidance', sourceIds: ['guidance'] };
  const guidanceFact = {
    ...fact,
    messageId: guidance.id,
    executionId: 'guidance',
    definitionId: 'task.follow_up',
  };
  let environment!: ReturnType<typeof useNativeEnvironment>;
  let readerCalls = 0;
  let detailTarget: { sessionId: string; executionId: string } | undefined;
  function Harness({ revision }: { revision: number }) {
    const [expanded, setExpanded] = useState(true);
    environment = useNativeEnvironment({
      bridge,
      generation: 1,
      selection,
      revision,
      unavailable: false,
      onChanged: async () => {},
    });
    const activity = nativeAgentActivityForTool(environment.agentActivities, saved, fact);
    const guidanceActivity = nativeAgentActivityForTool(
      environment.agentActivities,
      guidance,
      guidanceFact,
    );
    return (
      <div className="kite-client">
        <ToolActivity
          messages={[desktopToolMessage(fact, saved.id, saved.content)]}
          expanded={expanded}
          onToggle={setExpanded}
          childAgent={activity?.childAgent}
          childDetail={
            activity
              ? {
                  label: activity.childAgent.name,
                  onOpen: () => {
                    detailTarget = {
                      sessionId: activity.sessionId,
                      executionId: activity.executionId,
                    };
                    environment.openChild(activity.sessionId, activity.executionId);
                  },
                }
              : undefined
          }
          renderChildren={() => {
            readerCalls++;
            return <p key="receipt">Original admission receipt</p>;
          }}
        />
        <ToolActivity
          messages={[desktopToolMessage(guidanceFact, guidance.id, guidance.content)]}
          childAgent={guidanceActivity?.childAgent}
          onToggle={() => {}}
          renderChildren={() => null}
        />
      </div>
    );
  }
  let revision = 0;
  const render = async () => {
    await act(async () => root.render(<Harness revision={++revision} />));
  };
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 200 && !ready(); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(ready()).toBe(true);
  };
  const operation = () => host.querySelector('article')?.textContent ?? '';
  const staticOperation = () => {
    expect(operation()).toContain('创建子 Agent');
    expect(host.querySelector('.tool-agent-operation')?.textContent).toBe('创建子 Agent');
    expect(host.querySelector('.tool-agent-operation')?.getAttribute('role')).not.toBe('status');
    expect(operation()).toContain('Grant review');
    expect(host.querySelector('article')!.classList.contains('is-running')).toBe(false);
    expect(host.querySelector('article')!.querySelector('[class*="shimmer"]')).toBeNull();
    for (const label of [
      '排队中',
      '开始工作',
      '已完成工作',
      '已停止工作',
      '结果未知',
      '状态待核对',
    ])
      expect(operation()).not.toContain(label);
  };
  try {
    await render();
    await until(() => observation > 0);
    expect(host.textContent).toContain('创建子 Agent');
    expect(host.querySelector('.child-agent-activity')).toBeNull();
    const article = host.querySelector('article')!;
    let disclosure = host.querySelector('.tool-activity-summary') as HTMLElement;
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(readerCalls).toBeGreaterThan(0);
    item.execution.status = 'planned';
    item.childRun = null;
    items = [item];
    await render();
    await until(() => environment.agentActivities.length === 1);
    staticOperation();
    expect(host.querySelector('article') === article).toBe(true);
    disclosure = host.querySelector('.tool-activity-summary') as HTMLElement;
    expect(disclosure.hasAttribute('aria-expanded')).toBe(false);
    expect(host.textContent).not.toContain('Original admission receipt');
    expect(host.querySelector('article')!.textContent).not.toContain(saved.content);
    const readersBefore = readerCalls;
    const selectionText = dom.window.document.getSelection()!;
    const range = dom.window.document.createRange();
    range.selectNodeContents(host.querySelector('.tool-agent-name')!);
    selectionText.addRange(range);
    item.execution.status = 'running';
    item.childRun = backgroundItem(1, true).childRun;
    await render();
    await until(() => observation >= 3);
    staticOperation();
    expect(selectionText.toString()).toBe('Grant review');
    expect(host.querySelector('.tool-activity-summary') === disclosure).toBe(true);
    expect(host.querySelectorAll('.child-agent-activity').length).toBe(1);
    expect(host.querySelectorAll('article')[1]!.textContent).toContain('继续子 Agent');
    // Inflate the complete display beyond 524288 bytes without violating any per-page bound.
    items = [
      item,
      ...Array.from({ length: 6 }, (_, index) => {
        const extra = backgroundItem(index + 2, true);
        extra.sourceTool = {
          id: `extra-${index}`,
          definitionId: 'task.spawn',
          definitionVersion: '1',
        };
        extra.execution.parentExecutionId = extra.sourceTool.id;
        extra.childSession!.title = 'x'.repeat(60000);
        return extra;
      }),
    ];
    await render();
    await until(() => environment.agentActivities.length === 7);
    expect(
      new TextEncoder().encode(JSON.stringify(environment.agentActivities)).byteLength,
    ).toBeGreaterThan(350000);
    expect(
      new TextEncoder().encode(JSON.stringify(environmentDisplay(items, 'store'))).byteLength,
    ).toBeGreaterThan(524288);
    holdNext = true;
    release = undefined;
    await render();
    await until(() => !!release);
    staticOperation();
    expect(host.querySelector('article') === article).toBe(true);
    expect(host.querySelector('.tool-agent-name')!.textContent).toBe('Grant review');
    expect(disclosure.getAttribute('aria-label')).toBe('查看子 Agent 详情：Grant review');
    expect(host.textContent).not.toContain('状态待核对');
    expect(host.textContent).not.toContain('执行状态待核实');
    expect(article.classList.contains('is-running')).toBe(false);
    expect(disclosure.hasAttribute('aria-expanded')).toBe(false);
    expect(host.querySelector('.tool-child-detail')).toBeNull();
    expect(host.querySelector('article')!.querySelector('.tool-activity-content')).toBeNull();
    expect(readerCalls).toBe(readersBefore);
    await act(async () => release?.());
    await until(() => environment.agentActivities.length === 7);
    staticOperation();
    item.execution.status = 'succeeded';
    item.childRun!.status = 'completed';
    item.childRun!.isActive = false;
    await render();
    staticOperation();
    expect(host.querySelector('article') === article).toBe(true);
    expect(disclosure.hasAttribute('aria-expanded')).toBe(false);
    expect(host.querySelector('.tool-activity-summary') === disclosure).toBe(true);
    expect(readerCalls).toBe(readersBefore);
    expect(host.textContent).not.toContain('Original admission receipt');
    expect(host.querySelector('article')!.textContent).not.toContain(saved.content);
    item.execution.status = 'outcome_unknown';
    await render();
    staticOperation();
    expect(host.querySelector('article') === article).toBe(true);
    expect(host.querySelector('.tool-activity-summary') === disclosure).toBe(true);
    expect(readerCalls).toBe(readersBefore);
    for (const status of [
      'running',
      'waiting_interaction',
      'waiting_execution',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      item.childRun!.status = status;
      item.childRun!.isActive = !['completed', 'failed', 'cancelled', 'interrupted'].includes(
        status,
      );
      await render();
      staticOperation();
      expect(host.querySelector('article')).toBe(article);
      expect(host.querySelector('.tool-activity-summary')).toBe(disclosure);
      expect(readerCalls).toBe(readersBefore);
    }
    const later = backgroundItem(9, true);
    later.sourceTool = { id: 'guidance', definitionId: 'task.follow_up', definitionVersion: '1' };
    later.execution.parentExecutionId = 'guidance';
    later.childSession!.title = 'Grant review';
    items = [...items, later];
    await render();
    await until(() => environment.agentActivities.length === 8);
    staticOperation();
    expect(host.querySelector('article')).toBe(article);
    expect(host.querySelector('.tool-activity-summary')).toBe(disclosure);
    const guidanceRow = host.querySelectorAll('article')[1]!;
    expect(guidanceRow.querySelector('.tool-agent-operation')?.textContent).toBe('继续子 Agent');
    expect(guidanceRow.classList.contains('is-running')).toBe(false);
    await act(async () => disclosure.click());
    await until(() => requests.some((request) => request.method === 'background.child.open'));
    expect(detailTarget).toEqual({ sessionId: 'child', executionId: item.execution.id });
    expect(requests.find((request) => request.method === 'background.child.open')).toMatchObject({
      executionId: item.execution.id,
      surface: 'environment',
    });
    await until(() => !!environment.child?.error);
    staticOperation();
    expect(host.querySelector('article')).toBe(article);
    expect(host.querySelector('.tool-activity-summary')).toBe(disclosure);
    expect(readerCalls).toBe(readersBefore);
    expect(detailTarget).toEqual({ sessionId: 'child', executionId: item.execution.id });
  } finally {
    release?.();
    await act(async () => root.unmount());
    dom.window.close();
    restoreDom();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
