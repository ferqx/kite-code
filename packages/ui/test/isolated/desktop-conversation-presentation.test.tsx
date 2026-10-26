import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ConversationActivityContext,
  useConversationReadActive,
} from '../../src/conversation-activity';
import type { Conversation as ConversationType } from '../../src/desktop/Conversation';
import { ConversationCache } from '../../src/desktop/ConversationCache';
import type { Message } from '../../src/desktop/types';
import { controlCacheAccounting } from '../conversation-cache-accounting.fixture';

type Props = ComponentProps<typeof ConversationType>;
let Conversation: typeof ConversationType;
const smallHistory = (): Message[] =>
  Array.from({ length: 20 }, (_, index) => [
    { id: `user-${index}`, role: 'user' as const, text: `Question ${index}`, settled: true },
    {
      id: `reply-${index}`,
      role: 'assistant' as const,
      turnId: `run-${index}`,
      finalReply: true,
      text: `Reply ${index}`,
      settled: true,
    },
  ]).flat();

async function fixture(messages = smallHistory(), customBodies = true, cached = false) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'getComputedStyle',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const original = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number) => {
    frames.delete(id);
  };
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(dom.window, {
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Conversation ??= (await import('../../src/desktop/Conversation')).Conversation;
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const accounting = cached ? controlCacheAccounting(dom.window) : undefined;
  const calls: string[] = [];
  const clicks: string[] = [];
  function Gate({ message, prefix = '' }: { message: Message; prefix?: string }) {
    const readActive = useConversationReadActive();
    return (
      <button
        type="button"
        data-host-message={message.id}
        disabled={!readActive}
        onClick={() => {
          if (readActive) clicks.push(message.id);
        }}
      >
        {prefix}
        {message.text}
      </button>
    );
  }
  const renderMessage = (message: Message) => {
    calls.push(message.id);
    return <Gate message={message} />;
  };
  const props: Props = {
    messages,
    loading: false,
    selected: true,
    connected: true,
    saveReading() {},
    ...(customBodies ? { renderMessage } : {}),
  };
  let resume = 0;
  let readActive = false;
  let cacheId = 'a';
  let cacheLoading = false;
  return {
    host,
    dom,
    calls,
    clicks,
    Gate,
    async render(
      update: Partial<Props> & {
        resume?: number;
        readActive?: boolean;
        cacheId?: string;
        cacheLoading?: boolean;
      } = {},
    ) {
      const {
        resume: nextResume,
        readActive: nextReadActive,
        cacheId: nextCacheId,
        cacheLoading: nextCacheLoading,
        ...updates
      } = update;
      if (nextResume !== undefined) resume = nextResume;
      if (nextReadActive !== undefined) readActive = nextReadActive;
      if (nextCacheId !== undefined) cacheId = nextCacheId;
      if (nextCacheLoading !== undefined) cacheLoading = nextCacheLoading;
      Object.assign(props, updates);
      await act(async () =>
        root.render(
          cached ? (
            <ConversationCache
              identity={cacheId}
              loading={cacheLoading}
              visible
              cache={{ scope: 'presentation-test', revision: '1', readActive }}
            >
              <Conversation key={cacheId} {...props} />
            </ConversationCache>
          ) : (
            <ConversationActivityContext value={{ resume, readActive }}>
              <Conversation {...props} />
            </ConversationActivityContext>
          ),
        ),
      );
      if (accounting) await act(async () => accounting.flush());
    },
    async close() {
      await act(async () => root.unmount());
      accounting?.restore();
      dom.window.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('closed history resumes and updates leaf read admission without reprojecting its host messages', async () => {
  const f = await fixture();
  try {
    await f.render();
    expect(f.calls).toHaveLength(40);
    const viewport = f.host.querySelector<HTMLElement>('.conversation-viewport')!;
    const message = f.host.querySelector<HTMLButtonElement>('[data-host-message="reply-0"]')!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 100 },
    });
    viewport.scrollTop = 210;
    await act(async () =>
      viewport.dispatchEvent(new f.dom.window.Event('scroll', { bubbles: true })),
    );
    expect(f.calls).toHaveLength(40);
    viewport.scrollTop = 0;
    await f.render({ resume: 1 });
    expect(f.calls).toHaveLength(40);
    expect(viewport.scrollTop).toBe(210);
    expect(f.host.querySelector('[data-host-message="reply-0"]')).toBe(message);
    expect(message.disabled).toBe(true);
    await act(async () => message.click());
    expect(f.clicks).toEqual([]);
    await f.render({ readActive: true });
    expect(f.calls).toHaveLength(40);
    expect(message.disabled).toBe(false);
    await act(async () => message.click());
    expect(f.clicks).toEqual(['reply-0']);
    await f.render({ readActive: false, resume: 2 });
    expect(f.calls).toHaveLength(40);
    expect(message.disabled).toBe(true);
    expect(f.host.querySelector('.conversation-viewport')).toBe(viewport);
  } finally {
    await f.close();
  }
});

for (const [initiallyOpen, lazyHistory] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  test(`${initiallyOpen ? 'initial' : 'newly added'} default-open processes restore on the same cached DOM without reprojecting stable resumes (lazy history: ${lazyHistory})`, async () => {
    const initial: Message[] = [
      ...(lazyHistory
        ? Array.from(
            { length: 220 },
            (_, index): Message => ({
              id: `history-${index}`,
              role: 'user',
              text: `Earlier question ${index}`,
              settled: true,
            }),
          )
        : []),
      { id: 'user', role: 'user', text: 'Question', settled: true },
    ];
    const messages: Message[] = [
      ...initial,
      {
        id: 'tool:read',
        turnId: 'run',
        role: 'tool',
        toolName: 'files.read',
        text: 'Tool',
        settled: false,
      },
    ];
    const turnActivity: Props['turnActivity'] = { turnId: 'run', status: 'running' };
    let toolCalls = 0;
    const renderToolActivity: Props['renderToolActivity'] = () => {
      toolCalls++;
      return <div data-host-tools="">Live tool body</div>;
    };
    const f = await fixture(initiallyOpen ? messages : initial, false, true);
    const leave = () =>
      f.render({ cacheId: 'b', cacheLoading: false, messages: [], turnActivity: undefined });
    const resume = () => f.render({ cacheId: 'a', cacheLoading: true, readActive: false });
    const refresh = () =>
      f.render({ cacheLoading: false, readActive: true, messages, turnActivity });
    try {
      await f.render({
        lazyHistory,
        renderToolActivity,
        turnActivity: initiallyOpen ? turnActivity : undefined,
      });
      if (lazyHistory) {
        expect(f.host.querySelectorAll('[data-conversation-entry-key]').length).toBeLessThan(100);
        expect(f.host.textContent).not.toContain('Earlier question 0');
      }
      if (!initiallyOpen) await f.render({ messages, turnActivity });
      const process = f.host.querySelector('.agent-turn-process')!;
      const summary = process.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
      expect(summary.getAttribute('aria-expanded')).toBe('true');
      expect(process.hasAttribute('data-restored-expanded')).toBe(initiallyOpen);
      // The first render can add its own marker; settle that signature before
      // measuring whether an already-restored projection is reused.
      if (initiallyOpen) await f.render();
      await leave();
      expect(process.isConnected).toBe(false);
      const beforeResume = toolCalls;
      await resume();
      expect(f.host.querySelector('.agent-turn-process')).toBe(process);
      expect(process.getAttribute('data-restored-expanded')).toBe('true');
      expect(summary.getAttribute('aria-expanded')).toBe('true');
      expect(toolCalls).toBe(beforeResume + (initiallyOpen ? 0 : 1));
      const restoredCalls = toolCalls;
      for (let index = 0; index < 2; index++) {
        await leave();
        await resume();
        expect(f.host.querySelector('.agent-turn-process')).toBe(process);
        expect(process.getAttribute('data-restored-expanded')).toBe('true');
        expect(toolCalls).toBe(restoredCalls);
      }
      await refresh();
      await act(async () => summary.click());
      await f.render();
      expect(summary.getAttribute('aria-expanded')).toBe('false');
      expect(process.hasAttribute('data-restored-expanded')).toBe(false);
      const closedCalls = toolCalls;
      await leave();
      await resume();
      expect(summary.getAttribute('aria-expanded')).toBe('false');
      expect(process.hasAttribute('data-restored-expanded')).toBe(false);
      expect(toolCalls).toBe(closedCalls);
      await refresh();
      await act(async () => summary.click());
      await f.render();
      expect(summary.getAttribute('aria-expanded')).toBe('true');
      expect(process.hasAttribute('data-restored-expanded')).toBe(false);
      await leave();
      await resume();
      expect(f.host.querySelector('.agent-turn-process')).toBe(process);
      expect(process.getAttribute('data-restored-expanded')).toBe('true');
    } finally {
      await f.close();
    }
  });
}

test('changed message bytes, host renderers and current Turn facts replace the projected content', async () => {
  const messages = smallHistory();
  const f = await fixture(messages);
  try {
    await f.render();
    const original = f.host.querySelector('[data-host-message="reply-0"]');
    const changed = messages.map((message) =>
      message.id === 'reply-0' ? { ...message, text: 'Changed saved reply' } : message,
    );
    await f.render({ messages: changed });
    expect(f.calls).toHaveLength(80);
    expect(f.host.textContent).toContain('Changed saved reply');
    expect(f.host.querySelector('[data-host-message="reply-0"]')).toBe(original);
    const replacementCalls: string[] = [];
    const replacement: Props['renderMessage'] = (message) => {
      replacementCalls.push(message.id);
      return <f.Gate message={message} prefix="New renderer: " />;
    };
    await f.render({ renderMessage: replacement });
    expect(replacementCalls).toHaveLength(40);
    expect(f.host.textContent).toContain('New renderer: Changed saved reply');
    await f.render({ turnActivity: { turnId: 'run-0', status: 'failed' } });
    expect(replacementCalls).toHaveLength(80);
    expect(f.host.querySelector('.agent-turn-status-label')?.textContent).toContain('本轮失败');
  } finally {
    await f.close();
  }
});

test('explicit expansion and restoration markers invalidate projection while manual re-opening restores normal animation', async () => {
  const messages: Message[] = [
    { id: 'user', role: 'user', text: 'Question', settled: true },
    {
      id: 'tool:read',
      turnId: 'run',
      role: 'tool',
      toolName: 'files.read',
      text: 'Tool',
      settled: true,
    },
    {
      id: 'reply',
      turnId: 'run',
      role: 'assistant',
      text: 'Reply',
      settled: true,
      finalReply: true,
    },
  ];
  const f = await fixture(messages, false);
  let toolCalls = 0;
  const tools: Props['renderToolActivity'] = (_messages, state) => {
    toolCalls++;
    return (
      <div
        data-host-tools=""
        data-restored={state.restoredExpanded.has(state.activityId) || undefined}
      >
        Tool
      </div>
    );
  };
  try {
    await f.render({ renderToolActivity: tools });
    expect(toolCalls).toBe(0);
    expect(f.host.querySelector('[data-host-tools]')).toBeNull();
    const summary = () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    const process = () => f.host.querySelector('.agent-turn-process')!;
    await act(async () => summary().click());
    expect(toolCalls).toBe(1);
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(process().hasAttribute('data-restored-expanded')).toBe(false);
    await f.render({ resume: 1 });
    expect(toolCalls).toBe(2);
    expect(process().getAttribute('data-restored-expanded')).toBe('true');
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    await act(async () => summary().click());
    const beforeReopen = toolCalls;
    await act(async () => summary().click());
    expect(toolCalls).toBe(beforeReopen + 1);
    expect(process().hasAttribute('data-restored-expanded')).toBe(false);
    const beforeResume = toolCalls;
    await f.render({ resume: 2 });
    expect(toolCalls).toBe(beforeResume + 1);
    expect(process().getAttribute('data-restored-expanded')).toBe('true');
    expect(f.host.querySelector('[data-host-tools]')?.textContent).toBe('Tool');
  } finally {
    await f.close();
  }
});

test('a loading round trip restores an explicitly open process marker and manual scroll with unchanged messages', async () => {
  const messages: Message[] = [
    { id: 'user', role: 'user', text: 'Question', settled: true },
    {
      id: 'tool:read',
      turnId: 'run',
      role: 'tool',
      toolName: 'files.read',
      text: 'Tool',
      settled: true,
    },
    {
      id: 'reply',
      turnId: 'run',
      role: 'assistant',
      text: 'Reply',
      settled: true,
      finalReply: true,
    },
  ];
  const f = await fixture(messages, false);
  const tools: Props['renderToolActivity'] = () => <div data-host-tools="">Tool</div>;
  try {
    await f.render({ renderToolActivity: tools });
    const summary = () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    await act(async () => summary().click());
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(
      f.host.querySelector('.agent-turn-process')?.hasAttribute('data-restored-expanded'),
    ).toBe(false);
    const viewport = f.host.querySelector<HTMLElement>('.conversation-viewport')!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 100 },
    });
    viewport.scrollTop = 210;
    await act(async () =>
      viewport.dispatchEvent(new f.dom.window.Event('scroll', { bubbles: true })),
    );
    await f.render({ loading: true });
    expect(f.host.querySelector('.conversation-loading')).not.toBeNull();
    expect(f.host.querySelector('.agent-turn-process')).toBeNull();
    viewport.scrollTop = 0;
    await f.render({ loading: false });
    expect(f.host.querySelector('.conversation-viewport')).toBe(viewport);
    expect(viewport.scrollTop).toBe(210);
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(
      f.host.querySelector('.agent-turn-process')?.getAttribute('data-restored-expanded'),
    ).toBe('true');
    expect(f.host.querySelector('[data-host-tools]')?.textContent).toBe('Tool');
  } finally {
    await f.close();
  }
});
