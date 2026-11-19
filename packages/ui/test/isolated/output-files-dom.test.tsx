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
test('compact cards keep exact same-name identity for opening, saving and revealing', async () => {
  mount();
  const one = file('报告.docx', 'one'),
    two = file('报告.docx', 'two');
  const calls: [string, OutputFileSummary][] = [];
  let finishReveal: (() => void) | undefined;
  await act(() =>
    root!.render(
      <OutputFiles
        items={[one, two]}
        onOpen={(f) => calls.push(['open', f])}
        onSave={(f) => calls.push(['save', f])}
        onReveal={(f) => {
          calls.push(['reveal', f]);
          return new Promise<void>((resolve) => {
            finishReveal = resolve;
          });
        }}
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
  await openMenu();
  const menu = document.querySelector('[role="menu"]')!;
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(['另存为', '在资源管理器中显示']);
  expect(menu.querySelector('[role="separator"]')).toBeNull();
  await act(() => items[0]!.click());
  expect(calls.at(-1)).toEqual(['save', two]);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await openMenu();
  await act(() => document.querySelectorAll<HTMLElement>('[role="menuitem"]')[1]!.click());
  expect(calls.at(-1)).toEqual(['reveal', two]);
  expect(more.getAttribute('aria-busy')).toBe('true');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await openMenu();
  expect(document.querySelectorAll('[role="menuitem"]')[1]?.getAttribute('aria-disabled')).toBe(
    'true',
  );
  await act(() =>
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () => {
    finishReveal!();
  });
  expect(more.hasAttribute('aria-busy')).toBe(false);
  expect(calls).toHaveLength(3);
});
test('all file formats retain open and fallback type without claiming export', async () => {
  mount();
  const files = ['a.xlsx', 'b.PPTX', 'c.pdf', 'd.txt', 'e.unknown'].map((name) => file(name));
  await act(() => root!.render(<OutputFiles items={files} onOpen={() => {}} onSave={() => {}} />));
  expect(
    [...document.querySelectorAll('.output-file-description small')].map(
      (node) => node.textContent,
    ),
  ).toEqual(['Excel 工作簿', '演示文稿', 'PDF 文档', '文本文件', '文件']);
  expect(document.querySelectorAll('.output-file-open')).toHaveLength(5);
});
test('empty file lists stay hidden and references expose the loaded files and their next page', async () => {
  mount();
  const callbacks = { onOpen() {}, onSave() {} };
  let pages = 0;
  await act(() =>
    root!.render(
      <>
        <OutputFiles items={[]} {...callbacks} />
        <OutputReferences items={[]} onOpen={callbacks.onOpen} />
      </>,
    ),
  );
  expect(document.querySelector('section')).toBeNull();
  await act(() =>
    root!.render(
      <OutputReferences
        items={Array.from({ length: 6 }, (_, i) => file(String(i)))}
        onOpen={callbacks.onOpen}
        onMore={() => pages++}
      />,
    ),
  );
  expect(document.querySelectorAll('.output-reference-link')).toHaveLength(6);
  expect(document.querySelector('.output-references > h3')?.textContent).toBe('输出');
  await act(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '加载更多')!
      .click(),
  );
  expect(pages).toBe(1);
  expect(document.querySelector('[role="status"], [role="alert"]')).toBeNull();
});

test('duplicate names show exact millisecond collection times and size, ordinary cards stay quiet', async () => {
  mount();
  const one = { ...file('报告.xlsx', 'one'), publishedAt: '2026-11-14T12:00:00.123Z' },
    two = { ...file('报告.xlsx', 'two'), publishedAt: '2026-11-14T12:00:00.146Z', size: '6000' },
    plain = file('另一份.xlsx', 'three');
  await act(() =>
    root!.render(<OutputFiles items={[one, two, plain]} onOpen={() => {}} onSave={() => {}} />),
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
      />,
    ),
  );
  expect(document.querySelector('.output-file-distinction')!.textContent).toContain('收集时间未知');
  expect(document.body.textContent).not.toContain('Invalid Date');
});

test('environment shows count-free headings and file links for populated groups', async () => {
  const { BackgroundExecutions } = await import('../../src/desktop/BackgroundExecutions');
  mount();
  const source = file('报告.xlsx', 'reference-source');
  const opened: OutputFileSummary[] = [];
  const render = (kinds: readonly ('shell' | 'subagent')[]) =>
    act(() =>
      root!.render(
        <BackgroundExecutions
          currentOnly
          executions={kinds.map((kind, index) => ({
            executionId: `${kind}-${index}`,
            kind,
            status: 'running',
            cleanupConfirmed: false,
          }))}
          references={<OutputReferences items={[source]} onOpen={(f) => opened.push(f)} />}
        />,
      ),
    );
  await render([]);
  const environment = document.querySelector('[aria-label="环境信息"]')!;
  const headings = () =>
    [...environment.querySelectorAll('h3')].map((section) => section.textContent);
  const references = environment.querySelector('[aria-label="输出"]')!;
  expect(references).not.toBeNull();
  expect(headings()).toEqual(['输出']);
  await render(['shell']);
  expect(headings()).toEqual(['Shell 列表', '输出']);
  await render(['shell', 'shell', 'subagent', 'subagent']);
  expect(headings()).toEqual(['Shell 列表', '子智能体', '输出']);
  await render(['subagent']);
  expect(headings()).toEqual(['子智能体', '输出']);
  expect(environment.querySelector('[aria-label="输出"]')).toBe(references);
  expect(references.querySelector('[role="status"], [role="alert"]')).toBeNull();
  await act(() =>
    references.querySelector<HTMLButtonElement>('[aria-label="打开 报告.xlsx"]')!.click(),
  );
  expect(opened).toEqual([source]);
  expect(references.querySelector('[aria-label="报告.xlsx 的更多操作"]')).toBeNull();
  expect(references.querySelector('.output-file-card')).toBeNull();
  const link = references.querySelector<HTMLButtonElement>('.output-reference-link')!;
  expect(link.textContent).toBe(source.name);
  expect(link.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
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
        />,
      ),
    );
    const link = document.querySelector('.output-reference-link')!;
    const icon = link.querySelector('svg')!;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.innerHTML).not.toBe(document.querySelector('.output-references h3 svg')!.innerHTML);
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
        />,
      ),
    );
    expect(document.querySelector('.output-reference-link svg')!.innerHTML).toBe(icons[index]!);
  }
});
