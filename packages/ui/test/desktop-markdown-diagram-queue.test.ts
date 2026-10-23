import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('diagram serialization retains completion only and recovers after canceled work', async () => {
  // Inspect the actual module-local queue without adding a production diagnostic export.
  // Only the lazy dependency and browser drawing primitives are replaced in this VM.
  const source = readFileSync(
    new URL('../src/desktop/markdown-diagram.ts', import.meta.url),
    'utf8',
  );
  const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source
      .replaceAll('export ', '')
      .replace("await import('mermaid')", '{ default: injectedMermaid }'),
  );
  let removed = 0;
  let rendered = 0;
  const events: string[] = [];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const api = runInNewContext(`${script}\n({ renderMarkdownDiagram, queue: () => queue })`, {
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
    document: {
      createElement: () => ({
        style: {},
        setAttribute() {},
        remove() {
          removed++;
        },
      }),
      body: { append() {} },
    },
    DOMParser: class {
      parseFromString() {
        return {
          documentElement: { getAttribute: () => '0 0 200 100', setAttribute() {} },
        };
      }
    },
    XMLSerializer: class {
      serializeToString() {
        return `<svg><text>diagram ${rendered}</text></svg>`;
      }
    },
  }) as {
    renderMarkdownDiagram: typeof import('../src/desktop/markdown-diagram').renderMarkdownDiagram;
    queue: () => Promise<unknown>;
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
  expect(removed).toBe(3);
  expect(await api.queue()).toBeUndefined();
});
