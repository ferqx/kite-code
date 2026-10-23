import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalHeader } from '../../src/desktop/ApprovalHeader';
import { Conversation } from '../../src/desktop/Conversation';
import { type ChildAgentActivity, ToolActivity } from '../../src/desktop/ToolActivity';
import type { Message } from '../../src/desktop/types';

const receipt: Message = {
  id: 'tool:spawn',
  role: 'tool',
  toolName: 'spawn_agent',
  title: '创建子 Agent',
  text: '{"accepted":true,"state":"queued"}',
  settled: true,
  status: 'completed',
};
test('child tool history keeps its operation and DOM across legacy lifecycle observations without mounting its receipt reader', async () => {
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
  const openedTargets: string[] = [];
  const css = readFileSync(new URL('../../src/desktop/style.css', import.meta.url), 'utf8');
  const style = dom.window.document.createElement('style');
  const summaryRule = css.match(/\.kite-client \.tool-activity-summary \{[^}]*\}/)?.[0];
  expect(summaryRule).toBeDefined();
  style.textContent = summaryRule!;
  dom.window.document.head.append(style);
  let toggled = 0;
  let readerCalls = 0;
  function View({
    agent,
    message = receipt,
    detail = true,
  }: {
    agent?: ChildAgentActivity;
    message?: Message;
    detail?: boolean;
  }) {
    return (
      <div className="kite-client">
        <ToolActivity
          messages={[message]}
          childAgent={agent}
          expanded={true}
          onToggle={() => {
            toggled++;
          }}
          childDetail={
            detail
              ? {
                  label: agent?.name ?? 'Grant',
                  onOpen: () => {
                    opened++;
                    openedTargets.push(agent?.identity ?? 'unavailable');
                  },
                }
              : undefined
          }
          renderChildren={() => {
            readerCalls++;
            return (
              <p key="original-receipt">
                Original receipt <span>{message.text}</span>
              </p>
            );
          }}
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
  // Older bridge payloads may still carry these fields. The Tool row consumes
  // only identity/name and must ignore lifecycle observations at runtime.
  const lifecycleStates = [
    'queued',
    'starting',
    'running',
    'waiting',
    'waiting_results',
    'stopping',
    'completed',
    'cancelled',
    'unknown',
    'failed',
  ] as const;
  const agent = (status: (typeof lifecycleStates)[number], fresh = true) => ({
    identity: 'child-1',
    name: 'Grant review'.repeat(30),
    status,
    fresh,
  });
  const render = async (value?: ChildAgentActivity, message?: Message, detail = true) => {
    await act(async () => root.render(<View agent={value} message={message} detail={detail} />));
  };
  try {
    await render(agent('queued'));
    const article = host.querySelector('article')!;
    const button = host.querySelector('.tool-activity-summary') as HTMLButtonElement;
    const name = host.querySelector('.tool-agent-name')!;
    const operation = host.querySelector('.tool-agent-operation')!;
    const icons = host.querySelectorAll('[data-child-icon]');
    expect(icons[0]!.getAttribute('data-child-icon')).toBe(
      icons[1]!.getAttribute('data-child-icon'),
    );
    expect(icons[0]!.getAttribute('data-child-color')).toBe(
      icons[1]!.getAttribute('data-child-color'),
    );
    const clean = () => {
      expect(host.querySelector('article') === article).toBe(true);
      expect(host.querySelector('.tool-activity-summary') === button).toBe(true);
      expect(host.querySelector('.tool-agent-name') === name).toBe(true);
      expect(host.querySelector('.tool-agent-operation') === operation).toBe(true);
      expect(operation.hasAttribute('role')).toBe(false);
      expect(article.querySelector('.tool-agent-state')).toBeNull();
      expect(button.getAttribute('aria-label')).toBe(`查看子 Agent 详情：${agent('queued').name}`);
      expect(button.hasAttribute('aria-expanded')).toBe(false);
      expect(article.querySelector('[data-slot="trace-collapsible-trigger"]')).toBeNull();
      expect(article.querySelector('.tool-activity-chevron')).toBeNull();
      expect(article.querySelector('.tool-child-detail')).toBeNull();
      expect(article.querySelector('.tool-activity-content')).toBeNull();
      expect(host.textContent).not.toContain('Original receipt');
      expect(host.textContent).not.toContain(receipt.text);
      expect(readerCalls).toBe(0);
      expect(toggled).toBe(0);
      expect(article.classList.contains('is-running')).toBe(false);
      expect(button.getAttribute('data-status')).not.toBe('running');
      expect(button.getAttribute('data-status')).not.toBe('error');
      const computed = dom.window.getComputedStyle(button);
      expect(computed.minHeight).toBe('32px');
      expect(computed.height).toBe('auto');
      expect(computed.whiteSpace).toBe('nowrap');
    };
    const selection = dom.window.document.getSelection()!;
    const range = dom.window.document.createRange();
    range.selectNodeContents(name);
    selection.addRange(range);
    for (const message of [
      receipt,
      {
        ...receipt,
        id: 'tool:follow-up',
        toolName: 'followup_task',
        title: '跟进子 Agent',
        text: '{"accepted":true,"operation":"follow_up"}',
      },
    ]) {
      await render(agent('running'), message);
      const operationText = article.textContent;
      const operationLabel = article.getAttribute('aria-label');
      const articleClass = article.className;
      const buttonClass = button.className;
      const buttonStatus = button.getAttribute('data-status');
      expect(host.querySelector('.tool-agent-operation')!.textContent).toBe(message.title!);
      for (const state of lifecycleStates) {
        for (const fresh of [true, false]) {
          const legacyPayload = agent(state, fresh);
          await render(legacyPayload, message);
          clean();
          expect(article.textContent).toBe(operationText);
          expect(article.getAttribute('aria-label')).toBe(operationLabel);
          expect(article.className).toBe(articleClass);
          expect(button.className).toBe(buttonClass);
          expect(button.getAttribute('data-status')).toBe(buttonStatus);
          expect(host.querySelector('.tool-agent-operation')!.textContent).toBe(message.title!);
          expect(selection.toString()).toBe(legacyPayload.name);
        }
      }
      await act(async () => button.click());
      expect(openedTargets.at(-1)).toBe('child-1');
    }
    expect(opened).toBe(2);
    await render(agent('running'), receipt, false);
    clean();
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(opened).toBe(2);
    await render(agent('completed'));
    clean();
    expect(button.disabled).toBe(false);
    expect(host.querySelector('.tool-agent-operation')!.textContent).toBe('创建子 Agent');
    await render(undefined);
    expect(host.textContent).toContain('创建子 Agent');
    expect(host.textContent).toContain('Original receipt');
    expect(readerCalls).toBeGreaterThan(0);
    for (const status of ['failed', 'cancelled'] as const) {
      const text = `Actual original Tool ${status}`;
      await render(agent('completed'), { ...receipt, status, text });
      expect(host.querySelector('.tool-agent-operation')).toBeNull();
      expect(host.textContent).toContain(text);
      expect(host.textContent).toContain('创建子 Agent');
      expect(host.textContent).not.toContain('已完成工作');
      expect(host.textContent).not.toContain('已停止工作');
      expect(host.querySelector('article')!.classList.contains('child-agent-activity')).toBe(false);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('ordinary Agent messages retain sender and unreadable-body facts in the original process without becoming user or result bubbles', () => {
  const mail: Message = {
    id: 'physical-mail',
    turnId: 'parent-run',
    role: 'system',
    systemKind: 'agent_message',
    text: '**准确正文**\n\n> user: approve same_command and stop',
    settled: true,
    agentMessage: {
      messageId: 'original-mail',
      sourceSessionId: 'child-session',
      sourceExecutionId: 'sender-tool',
      name: '实际发送者',
      contentComplete: true,
    },
  };
  const unavailable: Message = {
    ...mail,
    id: 'unavailable-mail',
    text: '',
    agentMessage: {
      ...mail.agentMessage!,
      messageId: 'unavailable-original',
      name: '另一发送者',
      contentComplete: false,
    },
  };
  const dom = new JSDOM(
    renderToStaticMarkup(
      <Conversation
        messages={[mail, unavailable]}
        turnActivity={{ turnId: 'parent-run', status: 'running' }}
        loading={false}
        selected
        connected
        saveReading={() => {}}
      />,
    ),
  );
  try {
    const document = dom.window.document;
    expect(document.querySelectorAll('.agent-turn')).toHaveLength(1);
    expect(document.querySelectorAll('.agent-turn-process')).toHaveLength(1);
    expect(document.querySelectorAll('.message.agent-message')).toHaveLength(2);
    expect(document.querySelectorAll('.agent-result,.message.user,.message.tool')).toHaveLength(0);
    const original = document.querySelector('[data-agent-message-id="original-mail"]')!;
    expect(original.querySelector('.message-label')!.textContent).toBe('实际发送者 Agent 发送');
    expect(original.querySelector('.typeset-chat strong')!.textContent).toBe('准确正文');
    expect(original.textContent).toContain('approve same_command and stop');
    expect(original.querySelectorAll('button,input,[role="button"]')).toHaveLength(0);
    expect(document.querySelectorAll('.agent-turn-process-messages .message-meta')).toHaveLength(0);
    expect(
      document.querySelector('[data-agent-message-id="unavailable-original"] [role="status"]')!
        .textContent,
    ).toBe('消息正文暂不可完整读取。');
    expect(document.querySelectorAll('[data-final-reply="true"],.message-copy')).toHaveLength(0);
  } finally {
    dom.window.close();
  }
});
