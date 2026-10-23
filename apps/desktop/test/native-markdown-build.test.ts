import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseDesktopMarkdown } from '@kite-ai/ui/desktop/markdown';
import { build } from 'vite';
import { desktopMarkdownDecoderAlias } from '../scripts/markdown-worker-resolution';

test('the actual browser Worker bundle decodes full GFM without document, window or Node authority', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: [desktopMarkdownDecoderAlias()] },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve(import.meta.dir, '../src/native-markdown-worker.ts'),
        formats: ['iife'],
        name: 'NativeMarkdownWorker',
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const script = outputs
    .flatMap((output) => ('output' in output ? output.output : []))
    .find((output) => output.type === 'chunk');
  if (script?.type !== 'chunk') throw Error('worker_bundle_missing');
  const replies: unknown[] = [];
  const self = {
    onmessage: undefined as ((event: { data: { id: number; text: string } }) => void) | undefined,
    postMessage: (value: unknown) => replies.push(value),
  };
  runInNewContext(script.code, { self });
  const text =
    '# &copy; &NotEqualTilde; &notit;🙂\n\n$x^2$\n\n$$\n\\frac{a}{b}\n$$\n\n' +
    '中文🙂 '.repeat(10000) +
    '\n\n[link][late]\n\n[late]: https://example.com/?a=1&amp;b=2\n\n|a|\n|-|\n|~~b~~|';
  self.onmessage!({ data: { id: 7, text } });
  expect(replies).toEqual([{ id: 7, text, tree: parseDesktopMarkdown(text) }]);
  expect(script.code).not.toContain('document.createElement');
  expect(script.code).not.toContain('react-dom');
}, 15000);
