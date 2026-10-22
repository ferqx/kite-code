import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalHeader } from '../../src/desktop/ApprovalHeader';
import { type ChildAgentActivity, ToolActivity } from '../../src/desktop/ToolActivity';
import type { Message } from '../../src/desktop/types';

const receipt: Message = {
  id: 'tool:spawn',
  role: 'tool',
  toolName: 'spawn_agent',
  title: '创建子 Agent',
  text: 'accepted: queued',
  settled: true,
  status: 'completed',
};
test('child activity keeps the original disclosure, identity and independent detail target across observations', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
  ] as const;
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  let opened = 0;
  function View({ agent, message = receipt }: { agent?: ChildAgentActivity; message?: Message }) {
    const [expanded, setExpanded] = useState(false);
    return (
      <div className="kite-client">
        <ToolActivity
          messages={[message]}
          childAgent={agent}
          expanded={expanded}
          onToggle={setExpanded}
          childDetail={{
            label: 'Grant',
            onOpen: () => {
              opened++;
            },
          }}
          renderChildren={() => <p key="original-receipt">Original receipt</p>}
        />
        <ApprovalHeader
          child={{ identity: 'child-1', name: 'Grant' }}
          index={0}
          count={1}
          onPrevious={() => {}}
          onNext={() => {}}
        />
      </div>
    );
  }
  const agent = (status: ChildAgentActivity['status'], fresh = true) => ({
    identity: 'child-1',
    name: 'Grant review'.repeat(30),
    status,
    fresh,
  });
  const render = async (value?: ChildAgentActivity, message?: Message) => {
    await act(async () => root.render(<View agent={value} message={message} />));
  };
  try {
    await render(agent('queued'));
    const article = host.querySelector('article')!;
    const disclosure = host.querySelector('.tool-activity-summary')!;
    const firstIcon = host.querySelector('.tool-activity-marker-icon [data-child-icon]')!;
    const approvalIcon = host.querySelector('.approval-child-icon')!;
    const icons = host.querySelectorAll('[data-child-icon]');
    expect(icons[0]!.getAttribute('data-child-icon')).toBe(
      icons[1]!.getAttribute('data-child-icon'),
    );
    expect(icons[0]!.getAttribute('data-child-color')).toBe(
      icons[1]!.getAttribute('data-child-color'),
    );
    expect(firstIcon).toBe(approvalIcon);
    expect(host.querySelector('.tool-agent-state')!.textContent).toBe('排队中');
    await act(async () => (disclosure as HTMLElement).click());
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    const selection = dom.window.document.getSelection()!;
    const range = dom.window.document.createRange();
    range.selectNodeContents(host.querySelector('.tool-agent-name')!);
    selection.addRange(range);
    await render(agent('running'));
    expect(host.querySelector('article')).toBe(article);
    expect(host.querySelector('.tool-activity-summary')).toBe(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(selection.toString()).toBe(agent('running').name);
    expect(article.classList.contains('is-running')).toBe(true);
    expect(host.querySelector('.tool-agent-state')!.textContent).toBe('开始工作');
    await render(agent('running', false));
    expect(article.classList.contains('is-running')).toBe(false);
    expect(disclosure.getAttribute('data-status')).not.toBe('running');
    expect(host.querySelector('.tool-agent-state')!.textContent).toBe('开始工作');
    await act(async () => (host.querySelector('.tool-child-detail') as HTMLElement).click());
    expect(opened).toBe(1);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('button button')).toBeNull();
    await render(agent('completed'));
    expect(host.querySelector('article')).toBe(article);
    expect(host.querySelector('.tool-agent-state')!.textContent).toBe('已完成工作');
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Original receipt');
    await render(agent('unknown'));
    expect(host.querySelector('.tool-agent-state')!.textContent).toBe('结果未知');
    expect(disclosure.getAttribute('data-status')).not.toBe('error');
    await render(undefined);
    expect(host.textContent).toContain('创建子 Agent');
    expect(host.textContent).not.toContain('开始工作');
    await render(agent('running'), { ...receipt, status: 'failed', text: 'Actual tool failure' });
    expect(host.querySelector('.tool-agent-state')).toBeNull();
    expect(host.textContent).toContain('Actual tool failure');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
