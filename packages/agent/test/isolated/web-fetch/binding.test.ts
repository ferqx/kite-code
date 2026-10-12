import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPassiveWebExtractor,
  createWebFetchBindingFactory,
  type WebExtractor,
  webExtractorAsset,
} from '@kite-ai/agent/web-fetch';

test('closing one bound default parser settles its active request while its sibling returns complete actual parser content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-web-parser-binding-'));
  let entered!: () => void;
  const responseEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = createServer((_request, response) => {
    // The actual Worker awaits the rest of this real response after parsing its input.
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('pending');
    entered();
  });
  let extractor: WebExtractor | undefined;
  let held: ReturnType<NonNullable<WebExtractor['bind']>> | undefined;
  let sibling: ReturnType<NonNullable<WebExtractor['bind']>> | undefined;
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const responseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/held`;
    const source = `
import ${JSON.stringify(pathToFileURL(webExtractorAsset()).href)};
const parse = self.onmessage;
const publish = self.postMessage.bind(self);
let held = false;
self.postMessage = async (value) => {
  if (held) await (await fetch(${JSON.stringify(responseUrl)})).text();
  publish(value);
};
self.onmessage = (event) => {
  held = new URL(event.data.url).pathname === '/held';
  parse(event);
};
`;
    const workerPath = join(root, 'actual-parser-response.ts');
    writeFileSync(workerPath, source);
    extractor = createPassiveWebExtractor({
      workerPath,
      expectedHash: createHash('sha256').update(source).digest('hex'),
    });
    held = extractor.bind!();
    sibling = extractor.bind!();
    pending = held.extractor
      .extract(
        {
          html: '<article><p>Held actual parser result.</p></article>',
          url: 'https://parser.invalid/held',
        },
        { signal: new AbortController().signal },
      )
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    await Promise.race([
      responseEntered,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('actual parser response not entered')), 3000);
      }),
    ]);
    clearTimeout(timer);
    await held.dispose();
    expect(await pending).toMatchObject({ error: { code: 'web_cancelled' } });
    const full = `BEGIN ${'Complete sibling paragraph. '.repeat(200)}END-OF-CONTENT`;
    const result = await sibling.extractor.extract(
      {
        html: `<article><h1>Sibling</h1><p>${full}</p></article>`,
        url: 'https://parser.invalid/free',
      },
      { signal: new AbortController().signal },
    );
    expect(result.content).toContain(full);
    expect(result.content.endsWith('END-OF-CONTENT')).toBe(true);
    // The seal also forbids a new request from recreating the disposed scope's Worker.
    await expect(
      held.extractor.extract(
        { html: '<p>closed</p>', url: 'https://parser.invalid/held' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'web_parser_unavailable' });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    clearTimeout(timer);
    const cleanup = await Promise.allSettled([
      held?.dispose(),
      sibling?.dispose(),
      extractor?.close?.(),
    ]);
    if (pending) await pending;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const result of cleanup)
      if (result.status === 'rejected') cleanupErrors.push(result.reason);
    if (!failed && !cleanupErrors.length) rmSync(root, { recursive: true, force: true });
  }
  if (cleanupErrors.length)
    throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors);
  if (failed) throw failure;
}, 10000);

test('Run bindings never close a shared custom extractor without bind', async () => {
  let closed = 0;
  const extractor: WebExtractor = {
    async close() {
      closed++;
    },
    async extract(input, { signal }) {
      signal.throwIfAborted();
      return { title: 'host-owned', content: input.html };
    },
  };
  const factory = createWebFetchBindingFactory({
    extractor,
    networkPort: {
      async request() {
        throw new Error('passive binding must not access transport');
      },
    },
  });
  const first = factory.bind();
  const second = factory.bind();
  try {
    await first.dispose();
    await second.dispose();
    expect(closed).toBe(0);
    expect(
      await extractor.extract(
        { html: 'Complete shared host content.', url: 'https://host.invalid/' },
        { signal: new AbortController().signal },
      ),
    ).toEqual({ title: 'host-owned', content: 'Complete shared host content.' });
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await extractor.close!();
  }
  expect(closed).toBe(1);
});
