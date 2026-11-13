import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { expect, test } from '#kite-test';

test('diagram serialization retains completion only and recovers after canceled work', async () => {
  // Inspect the actual module-local queue without adding a production diagnostic export.
  // Only the lazy dependency and browser drawing primitives are replaced in this VM.
  const source = readFileSync(
    new URL('../src/desktop/markdown-diagram.ts', import.meta.url),
    'utf8',
  );
  const script = transformSync(
    source
      .replaceAll('export ', '')
      .replace("await import('mermaid')", '{ default: injectedMermaid }'),
    { loader: 'ts' },
  ).code;
  let removed = 0;
  let rendered = 0;
  let serializedBytes = 0;
  const visibility: (() => void)[] = [];
  const document = {
    hidden: false,
    createElement: () => ({
      style: {},
      setAttribute() {},
      remove() {
        removed++;
      },
    }),
    body: { append() {} },
    addEventListener(_type: string, listener: () => void) {
      visibility.push(listener);
    },
  };
  const events: string[] = [];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const api = runInNewContext(
    `${script}\n({ renderMarkdownDiagram, getMarkdownDiagramImage, queue: () => queue, budget: () => ({size: images.size, bytes: imageBytes}) })`,
    {
      injectedMermaid: {
        initialize() {
          events.push('initialize');
        },
        async render() {
          events.push('render');
          if (++rendered === 1) {
            firstStarted();
            await firstGate;
          }
          return { svg: '<svg />' };
        },
      },
      document,
      DOMParser: class {
        parseFromString() {
          return {
            documentElement: { getAttribute: () => '0 0 200 100', setAttribute() {} },
          };
        }
      },
      XMLSerializer: class {
        serializeToString() {
          return `<svg><text>diagram ${rendered}${'x'.repeat(serializedBytes)}</text></svg>`;
        }
      },
    },
  ) as {
    renderMarkdownDiagram: typeof import('../src/desktop/markdown-diagram').renderMarkdownDiagram;
    getMarkdownDiagramImage: typeof import('../src/desktop/markdown-diagram').getMarkdownDiagramImage;
    queue: () => Promise<unknown>;
    budget: () => { size: number; bytes: number };
  };
  const colors = { foreground: 'black', accent: 'blue', secondary: 'teal' };
  const controller = new AbortController();
  const first = api.renderMarkdownDiagram('graph TD\nA --> B', colors, controller.signal);
  const second = api.renderMarkdownDiagram('graph TD\nB --> C', colors, controller.signal);
  await started;
  expect(events).toEqual(['initialize', 'render']);
  expect(removed).toBe(0);
  releaseFirst();
  const [firstImage, secondImage] = await Promise.all([first, second]);
  expect(decodeURIComponent(firstImage)).toBe(
    'data:image/svg+xml;charset=utf-8,<svg><text>diagram 1</text></svg>',
  );
  expect(decodeURIComponent(secondImage)).toBe(
    'data:image/svg+xml;charset=utf-8,<svg><text>diagram 2</text></svg>',
  );
  expect(events).toEqual(['initialize', 'render', 'initialize', 'render']);
  expect(removed).toBe(2);
  expect(await api.queue()).toBeUndefined();

  controller.abort();
  await expect(
    api.renderMarkdownDiagram('graph TD\nA --> B', colors, controller.signal),
  ).rejects.toThrow('aborted');
  expect(await api.queue()).toBeUndefined();
  expect(
    await api.renderMarkdownDiagram('graph TD\nA --> B', colors, new AbortController().signal),
  ).toStartWith('data:image/svg+xml;');
  expect(removed).toBe(2);
  expect(await api.queue()).toBeUndefined();
  expect(api.getMarkdownDiagramImage('graph TD\nA --> B', colors)).toEqual({
    image: firstImage,
    width: 200,
    height: 100,
  });
  expect(
    api.getMarkdownDiagramImage('graph TD\nA --> B', { ...colors, accent: 'red' }),
  ).toBeUndefined();
  for (let i = 0; i < 20; i++)
    await api.renderMarkdownDiagram(`graph TD\nA --> B${i}`, colors, new AbortController().signal);
  expect(api.budget().size).toBe(16);
  expect(api.getMarkdownDiagramImage('graph TD\nA --> B', colors)).toBeUndefined();
  serializedBytes = 1_200_000;
  await api.renderMarkdownDiagram('graph TD\nA --> large1', colors, new AbortController().signal);
  await api.renderMarkdownDiagram('graph TD\nA --> large2', colors, new AbortController().signal);
  expect(api.budget().bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(api.getMarkdownDiagramImage('graph TD\nA --> large1', colors)).toBeUndefined();
  expect(api.getMarkdownDiagramImage('graph TD\nA --> large2', colors)).toBeDefined();
  document.hidden = true;
  visibility[0]!();
  expect(api.budget()).toEqual({ size: 0, bytes: 0 });
});
