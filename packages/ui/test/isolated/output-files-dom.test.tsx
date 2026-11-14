import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { OutputFileSummary } from '../../src/desktop/OutputFiles';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { OutputFiles, OutputReferences } = await import('../../src/desktop/OutputFiles');
const { createRoot } = await import('react-dom/client');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});
afterAll(() => {
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.window.close();
});
const file = (name: string, id = name): OutputFileSummary => ({
  storeId: 'store',
  sessionId: 'session',
  fileId: id,
  locator: { kind: 'delivery', key: id },
  ownerRunId: 'run-hidden',
  name,
  mediaType: 'application/octet-stream',
  size: '5313',
  publishedAt: '2026-11-13T00:00:00Z',
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return host;
}
test('compact cards expose names, types and open; menu actions keep exact same-name identity', async () => {
  mount();
  const one = file('报告.docx', 'one'),
    two = file('报告.docx', 'two');
  const calls: [string, OutputFileSummary][] = [];
  await act(() =>
    root!.render(
      <OutputFiles
        items={[one, two]}
        onOpen={(f) => calls.push(['open', f])}
        onSave={(f) => calls.push(['save', f])}
        onEdit={(f) => calls.push(['edit', f])}
        turnLabel={() => '来源run-hidden'}
      />,
    ),
  );
  expect(document.querySelector('h4')).toBeNull();
  expect(document.body.textContent).not.toContain('已保存');
  expect(document.body.textContent).toContain('5313 字节');
  expect(document.body.textContent).not.toContain('run-hidden');
  expect(document.body.textContent).toContain('Word 文档');
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  const cards = document.querySelectorAll('.output-file-card');
  expect(cards).toHaveLength(2);
  expect(document.getElementById(cards[1]!.getAttribute('aria-labelledby')!)?.textContent).toBe(
    '报告.docx',
  );
  await act(() =>
    cards[1]!.querySelector<HTMLButtonElement>('[aria-label="打开 报告.docx"]')!.click(),
  );
  expect(calls).toEqual([['open', two]]);
  const more = cards[1]!.querySelector<HTMLButtonElement>('[aria-label="报告.docx 的更多操作"]')!;
  const openMenu = () =>
    act(() => {
      more.focus();
      more.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  for (const [label, operation] of [
    ['另存为', 'save'],
    ['继续修改', 'edit'],
  ] as const) {
    await openMenu();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === label,
    )!;
    expect(item).toBeDefined();
    await act(() => item.click());
    expect(calls.at(-1)).toEqual([operation, two]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  }
  await openMenu();
  await act(() =>
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(calls).toHaveLength(3);
});
test('all file formats retain open and fallback type without claiming export', async () => {
  mount();
  const files = ['a.xlsx', 'b.PPTX', 'c.pdf', 'd.txt', 'e.unknown'].map((name) => file(name));
  await act(() =>
    root!.render(
      <OutputFiles items={files} onOpen={() => {}} onSave={() => {}} onEdit={() => {}} />,
    ),
  );
  expect(
    [...document.querySelectorAll('.output-file-description small')].map(
      (node) => node.textContent,
    ),
  ).toEqual(['Excel 工作簿', '演示文稿', 'PDF 文档', '文本文件', '文件']);
  expect(document.querySelectorAll('.output-file-open')).toHaveLength(5);
});
test('empty output, failed collection retry, and reference expansion remain available', async () => {
  mount();
  const callbacks = { onOpen() {}, onSave() {}, onEdit() {} };
  await act(() => root!.render(<OutputFiles items={[]} {...callbacks} />));
  expect(document.querySelector('section')).toBeNull();
  let retried = '';
  await act(() =>
    root!.render(
      <OutputFiles
        items={[]}
        {...callbacks}
        collections={[
          {
            collectionId: 'c',
            ownerRunId: 'r',
            state: 'failed',
            expectedCount: 1,
            publishedCount: 0,
            retryUntil: '2999-01-01T00:00:00Z',
          },
        ]}
        onRetry={(id) => {
          retried = id;
        }}
      />,
    ),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('文件整理失败');
  await act(() => document.querySelector<HTMLButtonElement>('button')!.click());
  expect(retried).toBe('c');
  await act(() =>
    root!.render(
      <OutputReferences
        items={Array.from({ length: 6 }, (_, i) => file(String(i)))}
        {...callbacks}
      />,
    ),
  );
  expect(document.querySelectorAll('.output-reference-link')).toHaveLength(5);
  await act(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '展开更多')!
      .click(),
  );
  expect(document.querySelectorAll('.output-reference-link')).toHaveLength(6);
});

test('producer-only failures stay in execution history rather than output cards; unknown and collection failures remain', async () => {
  mount();
  const callbacks = { onOpen() {}, onSave() {}, onEdit() {} };
  for (const items of [[], [file('recovered.xlsx')]]) {
    await act(() =>
      root!.render(
        <OutputFiles
          items={items}
          {...callbacks}
          collections={[
            {
              collectionId: 'producer',
              ownerRunId: 'run-hidden',
              state: 'failed',
              expectedCount: null,
              publishedCount: 0,
              errorCode: 'producer_failed',
            },
            {
              collectionId: 'unknown',
              ownerRunId: 'run-hidden',
              state: 'failed',
              expectedCount: null,
              publishedCount: 0,
              errorCode: 'producer_stop_unknown',
            },
            {
              collectionId: 'collector',
              ownerRunId: 'run-hidden',
              state: 'failed',
              expectedCount: 1,
              publishedCount: 0,
              errorCode: 'output_collection_start_failed',
              retryUntil: '2999-01-01T00:00:00Z',
            },
          ]}
          onRetry={() => {}}
        />,
      ),
    );
    const alerts = [...document.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(2);
    expect(document.body.textContent).not.toContain('producer_failed');
    expect(alerts[0]?.textContent).toBe('生成结果未知，未收集该次输出 · producer_stop_unknown');
    expect(alerts[0]?.querySelector('button')).toBeNull();
    expect(alerts[1]?.textContent).toContain('文件整理失败');
    expect(alerts[1]?.querySelector('button')?.textContent).toBe('重试整理');
    expect(document.querySelectorAll('.output-file-card')).toHaveLength(items.length);
    expect(document.body.textContent).not.toContain('已恢复');
  }
});

test('producer failure alone renders no output panel; pending and expired collection still surface', async () => {
  mount();
  const actions = { onOpen() {}, onSave() {}, onEdit() {} };
  const producer = {
    collectionId: 'p',
    ownerRunId: 'r',
    state: 'failed' as const,
    expectedCount: null,
    publishedCount: 0,
    errorCode: 'producer_failed',
  };
  await act(() => root!.render(<OutputFiles items={[]} {...actions} collections={[producer]} />));
  expect(document.querySelector('.turn-output-files')).toBeNull();
  await act(() =>
    root!.render(
      <OutputFiles
        items={[]}
        {...actions}
        collections={[
          {
            ...producer,
            collectionId: 'pending',
            state: 'pending',
            expectedCount: 1,
            errorCode: undefined,
          },
          {
            ...producer,
            collectionId: 'expired',
            expectedCount: 1,
            errorCode: 'output_staging_expired',
          },
        ]}
      />,
    ),
  );
  expect(document.querySelector('[role="status"]')?.textContent).toContain('正在整理输出文件');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('暂存文件已过期');
  expect(document.body.textContent).not.toContain('生成步骤失败');
});

test('duplicate names show exact millisecond collection times and size, ordinary cards stay quiet', async () => {
  mount();
  const one = { ...file('报告.xlsx', 'one'), publishedAt: '2026-11-14T12:00:00.123Z' },
    two = { ...file('报告.xlsx', 'two'), publishedAt: '2026-11-14T12:00:00.146Z', size: '6000' },
    plain = file('另一份.xlsx', 'three');
  await act(() =>
    root!.render(
      <OutputFiles
        items={[one, two, plain]}
        onOpen={() => {}}
        onSave={() => {}}
        onEdit={() => {}}
      />,
    ),
  );
  const details = [...document.querySelectorAll('.output-file-distinction')];
  expect(details).toHaveLength(2);
  expect(details[0]!.textContent).toContain('.123');
  expect(details[1]!.textContent).toContain('.146');
  expect(details[1]!.textContent).toContain('6000 字节');
  expect(document.querySelectorAll('.output-file-card')).toHaveLength(3);
  expect(
    document.querySelectorAll('.output-file-card')[2]!.getAttribute('aria-describedby'),
  ).toBeNull();
  expect(document.body.textContent).not.toContain('最终');
  await act(() =>
    root!.render(
      <OutputFiles
        items={[{ ...one, publishedAt: 'invalid' }, two]}
        onOpen={() => {}}
        onSave={() => {}}
        onEdit={() => {}}
      />,
    ),
  );
  expect(document.querySelector('.output-file-distinction')!.textContent).toContain('收集时间未知');
  expect(document.body.textContent).not.toContain('Invalid Date');
});

test('environment reference section sits below Shell and agents with exact file actions and stale feedback', async () => {
  const { BackgroundExecutions } = await import('../../src/desktop/BackgroundExecutions');
  mount();
  const source = file('报告.xlsx', 'reference-source');
  const opened: OutputFileSummary[] = [];
  await act(() =>
    root!.render(
      <BackgroundExecutions
        currentOnly
        executions={[]}
        references={
          <OutputReferences
            items={[source]}
            onOpen={(f) => opened.push(f)}
            onSave={() => {}}
            onEdit={() => {}}
            error="read failed"
          />
        }
      />,
    ),
  );
  const environment = document.querySelector('[aria-label="环境信息"]')!;
  const references = environment.querySelector('[aria-label="参考"]')!;
  expect(references).not.toBeNull();
  expect(environment.textContent!.indexOf('子智能体')).toBeLessThan(
    environment.textContent!.indexOf('参考'),
  );
  expect(references.querySelector('h4')?.textContent).toBe('参考');
  expect(references.querySelector('[role="status"]')?.textContent).toContain('上次结果');
  await act(() =>
    references.querySelector<HTMLButtonElement>('[aria-label="打开 报告.xlsx"]')!.click(),
  );
  expect(opened).toEqual([source]);
  expect(references.querySelector('[aria-label="报告.xlsx 的更多操作"]')).toBeNull();
  expect(references.querySelector('.output-file-card')).toBeNull();
  const link = references.querySelector<HTMLButtonElement>('.output-reference-link')!;
  expect(link.textContent).toBe(source.name);
  expect(link.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
  expect(link.querySelector('span')?.textContent).toBe(source.name);
  expect(link.children[0]?.tagName.toLowerCase()).toBe('svg');
  expect(link.title).toBe(source.name);
  expect(link.type).toBe('button');
  link.focus();
  expect(document.activeElement).toBe(link);
});

test('reference links distinguish document formats and unknown fallback from heading', async () => {
  mount();
  const cases = ['a.DOCX', 'b.xlsx', 'c.pptx', 'd.pdf', 'e.png', 'f.txt', 'g.unknown'];
  const icons: string[] = [];
  for (const name of cases) {
    await act(() =>
      root!.render(
        <OutputReferences
          items={[{ ...file(name), mediaType: 'application/octet-stream' }]}
          onOpen={() => {}}
          onSave={() => {}}
          onEdit={() => {}}
        />,
      ),
    );
    const link = document.querySelector('.output-reference-link')!;
    const icon = link.querySelector('svg')!;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.innerHTML).not.toBe(document.querySelector('.output-references h4 svg')!.innerHTML);
    expect(link.textContent).toBe(name);
    icons.push(icon.innerHTML);
  }
  expect(new Set(icons).size).toBe(cases.length);
  for (const [mime, index] of [
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 0],
    ['application/vnd.ms-excel', 1],
    ['application/vnd.ms-powerpoint', 2],
    ['application/pdf', 3],
    ['image/png', 4],
    ['text/plain', 5],
  ] as const) {
    await act(() =>
      root!.render(
        <OutputReferences
          items={[{ ...file('no-extension'), mediaType: mime }]}
          onOpen={() => {}}
          onSave={() => {}}
          onEdit={() => {}}
        />,
      ),
    );
    expect(document.querySelector('.output-reference-link svg')!.innerHTML).toBe(icons[index]!);
  }
});
