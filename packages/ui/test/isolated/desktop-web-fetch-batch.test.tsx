import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ComponentProps, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, WebFetchBatchPage } from '../../src/desktop/types';

// Radix decides whether to use layout effects at import time.
const browser = new JSDOM('<!doctype html>');
const globals = (['window', 'document'] as const).map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
for (const [key] of globals)
  Object.defineProperty(globalThis, key, { value: browser.window[key], configurable: true });
const { ConversationTrace } = await import('../../src/desktop/ConversationTrace');
const { completedToolActions, ToolActivity, toolTraceTitle } = await import(
  '../../src/desktop/ToolActivity'
);
for (const [key, descriptor] of globals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}
browser.window.close();

const privateBody = 'PRIVATE_PAGE_BODY https://example.test/secret';
function message(pages?: readonly WebFetchBatchPage[], patch?: Partial<Message>): Message {
  return {
    id: 'tool:batch',
    role: 'tool',
    toolName: 'web_fetch',
    text: privateBody,
    toolResult: { ok: patch?.status !== 'failed', stdout: privateBody },
    target: '请求 3 页',
    status: 'completed',
    settled: true,
    dispatchCommitted: true,
    webFetchBatch: pages ? { pages: [...pages] } : undefined,
    ...patch,
  };
}

const partial = [
  { index: 2, outcome: 'succeeded' },
  { index: 1, outcome: 'failed', reason: 'http', httpStatus: 404 },
  { index: 0, outcome: 'succeeded' },
] as const;

function markup(
  messages: readonly Message[],
  options?: Partial<ComponentProps<typeof ToolActivity>>,
) {
  return new JSDOM(
    renderToStaticMarkup(
      <ToolActivity
        messages={messages}
        onToggle={() => {}}
        renderChildren={() => null}
        {...options}
      />,
    ),
  );
}

function pageLines(root: ParentNode) {
  return [...root.querySelectorAll('.tool-web-fetch-pages li')].map((page) =>
    [...page.children].map((text) => text.textContent),
  );
}

test('a typed mixed batch counts successes, keeps request order and never opens the raw receipt', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const old = Object.keys(values).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const host = dom.window.document.querySelector('#root')!;
  const root = createRoot(host);
  let originalReadCount = 0;
  let receiptDetailCount = 0;
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <ToolActivity
        messages={[message(partial)]}
        inTrace
        traceSummaryTitle="读取了网页"
        expanded={open}
        onToggle={setOpen}
        renderChildren={() => {
          originalReadCount++;
          return privateBody;
        }}
        receiptDetails={() => {
          receiptDetailCount++;
          return () => privateBody;
        }}
      />
    );
  }
  try {
    await act(async () => root.render(<Harness key="first" />));
    const findToggle = () => host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    const toggle = findToggle();
    expect(toggle.textContent).toBe('读取 2/3 页');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(pageLines(host)).toEqual([]);
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(pageLines(host)).toEqual([
      ['第 1 页', '读取成功'],
      ['第 2 页', '读取失败（HTTP 404）'],
      ['第 3 页', '读取成功'],
    ]);
    expect(host.textContent).not.toContain('请求 3 页');
    expect(host.textContent).not.toContain('PRIVATE_PAGE_BODY');
    expect(host.querySelector('a')).toBeNull();
    await act(async () => root.render(<Harness key="reopened" />));
    expect(findToggle().textContent).toBe('读取 2/3 页');
    expect(findToggle().getAttribute('aria-expanded')).toBe('false');
    await act(async () => findToggle().click());
    expect(pageLines(host)[1]).toEqual(['第 2 页', '读取失败（HTTP 404）']);
    expect(originalReadCount).toBe(0);
    expect(receiptDetailCount).toBe(0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test('all-success batches show the exact count; all failures retain a failure label and safe detail', () => {
  const succeeded = message(partial.map((page) => ({ index: page.index, outcome: 'succeeded' })));
  const failed = message(
    [
      { index: 0, outcome: 'failed', reason: 'unknown <script>' } as unknown as WebFetchBatchPage,
      { index: 1, outcome: 'failed', reason: 'timeout' },
      { index: 2, outcome: 'failed', reason: 'http', httpStatus: 200 },
    ],
    { status: 'failed' },
  );
  const success = markup([succeeded], { expanded: true });
  const failure = markup([failed], {
    expanded: true,
    inTrace: true,
    directTraceDetails: true,
    traceSummaryTitle: '工具执行',
  });
  try {
    expect(toolTraceTitle(succeeded)).toBe('读取 3/3 页');
    expect(success.window.document.querySelector('.tool-activity-title')?.textContent).toBe(
      '读取 3/3 页',
    );
    expect(pageLines(success.window.document)).toHaveLength(3);
    expect(toolTraceTitle(failed)).toBe('读取网页失败');
    expect(failure.window.document.querySelector('.tool-activity-title')?.textContent).toBe(
      '读取网页失败',
    );
    expect(pageLines(failure.window.document)).toEqual([
      ['第 1 页', '未读到正文'],
      ['第 2 页', '读取超时'],
      ['第 3 页', '网页未返回可读取的内容'],
    ]);
    expect(failure.window.document.body.textContent).not.toContain('PRIVATE_PAGE_BODY');
    expect(failure.window.document.body.textContent).not.toContain('unknown');
    expect(completedToolActions([succeeded, failed])).toBe('读取了网页');
  } finally {
    success.window.close();
    failure.window.close();
  }
});

test('legacy, unconfirmed and malformed batches cannot synthesize a success count', () => {
  for (const invalid of [
    message(undefined, { target: 'example.test/one' }),
    message(partial, { executionUnconfirmed: true }),
    message(partial, { dispatchCommitted: false }),
    message(partial, { settled: false }),
    message([partial[1], partial[1], partial[0]]),
    message(partial.map((page) => ({ ...page, outcome: 'failed' }))),
  ]) {
    const dom = markup([invalid], { expanded: true });
    try {
      expect(toolTraceTitle(invalid)).not.toMatch(/读取 \d+\/\d+ 页/);
      expect(pageLines(dom.window.document)).toEqual([]);
      expect(dom.window.document.querySelector('button.tool-activity-summary')).toBeNull();
      expect(dom.window.document.body.textContent).not.toContain('PRIVATE_PAGE_BODY');
    } finally {
      dom.window.close();
    }
  }
});

test('a grouped trace preserves the aggregate wording and the original batch card owns its result', () => {
  const batch = message(partial);
  const other = message(undefined, { id: 'tool:other', target: 'example.test/one' });
  const dom = markup([batch, other], { expanded: true, expandedItems: { [batch.id]: true } });
  try {
    const section = dom.window.document.querySelector('.tool-activity-aggregate')!;
    expect(section.querySelector('.tool-activity-title')?.textContent).toBe('读取网页');
    expect(section.querySelectorAll('.tool-web-fetch-pages')).toHaveLength(1);
    expect(
      [...section.querySelectorAll('.tool-activity-title')].map((title) => title.textContent),
    ).toContain('读取 2/3 页');
    expect(pageLines(section)[1]).toEqual(['第 2 页', '读取失败（HTTP 404）']);
  } finally {
    dom.window.close();
  }
});

test('a failed singleton trace names the trusted failure while preserving its original disclosure', () => {
  const failed = message([{ index: 0, outcome: 'failed', reason: 'denied' }], { status: 'failed' });
  for (const open of [false, true]) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <ConversationTrace
          steps={[failed]}
          id="trace"
          label="工具执行"
          running={false}
          summarizeTools
          processOpen
          expanded={{ trace: open }}
          restoredExpanded={new Set()}
          onToggle={() => {}}
          renderTool={(record, parentDisclosureOpen, traceSummaryTitle, directTraceDetails) => (
            <ToolActivity
              messages={[record]}
              inTrace
              expanded={open}
              traceSummaryTitle={traceSummaryTitle}
              directTraceDetails={directTraceDetails}
              parentDisclosureOpen={parentDisclosureOpen}
              onToggle={() => {}}
              renderChildren={() => privateBody}
            />
          )}
        />,
      ),
    );
    try {
      const host = dom.window.document.body;
      expect(host.querySelector('.conversation-trace-trigger')?.textContent).toBe('读取网页失败');
      expect(host.querySelectorAll('.tool-activity-title')).toHaveLength(0);
      expect(pageLines(host)).toEqual(open ? [['第 1 页', '不允许读取此页']] : []);
      expect(host.textContent).not.toContain(privateBody);
    } finally {
      dom.window.close();
    }
  }
});
