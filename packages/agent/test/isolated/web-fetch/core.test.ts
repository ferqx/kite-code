import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  createPassiveWebExtractor,
  createPinnedWebNetworkPort,
  createWebFetchExtension,
  type WebExtractor,
  webExtractorAsset,
} from '@kite-ai/agent/web-fetch';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function setup(
  handler: RequestListener,
  options: { deny?: boolean; extractor?: WebExtractor; denyHop?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-web-fetch-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  let requests = 0,
    dns = 0;
  const admissions: string[] = [];
  const server = createServer((req, res) => {
    requests++;
    handler!(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://fixture.test:${(server.address() as { port: number }).port}`;
  const network = createPinnedWebNetworkPort({
    policy: { mode: 'public' },
    allowLoopbackForTests: true,
    resolveAddresses: async () => {
      dns++;
      return [{ address: '127.0.0.1', family: 4 }];
    },
    admitHop: async (hop) => {
      admissions.push(hop.url);
      return {
        allowed: !options.denyHop || !hop.url.includes(options.denyHop),
        revision: 'host-policy-1',
      };
    },
  });
  const extension = createWebFetchExtension({
    networkPort: network,
    ...(options.extractor ? { extractor: options.extractor } : {}),
  });
  const model = createFixedModel([]);
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      authorize: async (request) => ({
        allowed: !(options.deny && request.kind === 'tool'),
        revision: 'tool-policy-1',
      }),
    },
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'test',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'test',
  });
  let command = 0;
  const run = async (input: unknown) => {
    const fixed = createFixedModel([
      [
        {
          type: 'tool_call',
          id: `call${++command}`,
          name: 'web_fetch',
          arguments: JSON.stringify(input),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    // The registered model is stable; response sequence is supplied through its public adapter below.
    queue.push(fixed);
    await runtime.submitCommand({
      expectedStoreId,
      commandId: `work${command}`,
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'fetch' },
    });
    const result = await runtime.waitForCommand(`work${command}`, { timeoutMs: 8000 });
    return {
      result,
      model: fixed,
      execution: (await store.listExecutions('s', 100)).find(
        (e) => e.kind === 'tool' && e.originCommandId === `work${command}`,
      ),
    };
  };
  const queue: ReturnType<typeof createFixedModel>[] = [];
  // Install the delegating stream before submitting any command; Core freezes this adapter per Run.
  model.stream = async function* (request, options) {
    const fixed = queue[0]!;
    yield* fixed.stream(request, options);
    if (fixed.requests.length >= 2) queue.shift();
  };
  return {
    url,
    root,
    expectedStoreId,
    store,
    runtime,
    run,
    counts: () => ({ requests, dns }),
    admissions,
    close: async () => {
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('real Core full HTML parser body flows through original Artifact scope; legal five redirects and explicit max_chars exceed old caps', async () => {
  const body = `BEGIN ${'complete paragraph. '.repeat(10000)} END-OF-FULL-PAGE`;
  let subresources = 0;
  const wireAudited: boolean[] = [];
  let observe = async () => false;
  const f = await setup(async (req, res) => {
    wireAudited.push(await observe());
    if (req.url === '/robots.txt') {
      res.end('User-agent: *\nDisallow: /forbidden');
      return;
    }
    if (req.url?.startsWith('/r')) {
      const n = Number(new URL(req.url, 'http://fixture.test').pathname.slice(2));
      if (n < 5) {
        res.writeHead(302, { location: `/r${n + 1}` }).end();
        return;
      }
    }
    if (req.url === '/subresource') subresources++;
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<html><title>Complete</title><script>fetch('/subresource')</script><img src='/subresource'><article><p>${body}</p></article></html>`,
      );
  });
  observe = async () =>
    (await f.store.listExtensionRecords({ extensionId: 'builtin.web', sessionId: 's', limit: 100 }))
      .length >= f.counts().requests;
  try {
    expect(f.counts()).toEqual({ requests: 0, dns: 0 });
    const first = await f.run({ url: `${f.url}/r0?private-query=not-an-audit-field` });
    // The query-bearing first redirect fixture still reaches the complete page.
    expect(first.execution?.status).toBe('succeeded');
    expect(wireAudited).toEqual(Array(7).fill(true));
    const audit = await f.store.listExtensionRecords({
      extensionId: 'builtin.web',
      sessionId: 's',
      limit: 100,
    });
    expect(audit.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(audit)).not.toContain('private-query');
    expect(
      audit.every(
        (record) => typeof (record.value as { urlDigest: string }).urlDigest === 'string',
      ),
    ).toBe(true);

    const message = first.model.requests[1]?.messages
      .slice()
      .reverse()
      .find((m) => m.role === 'tool');
    expect(message?.content).toContain('END-OF-FULL-PAGE');
    expect(message!.content.length).toBeGreaterThan(100000);
    expect(subresources).toBe(0);
    expect((first.execution?.result as { artifactRefs?: unknown[] })?.artifactRefs?.length).toBe(1);
    const selected = await f.run({ url: `${f.url}/r0`, max_chars: 20000 });
    expect(
      selected.model.requests[1]?.messages
        .slice()
        .reverse()
        .find((m) => m.role === 'tool')?.content.length,
    ).toBe(20000);
    expect(f.admissions.filter((value) => value.includes('/r')).length).toBeGreaterThanOrEqual(7);
  } finally {
    await f.close();
  }
}, 20000);
test('robots full rules, true redirect loop, per-hop denial and malformed input fail locally without success body', async () => {
  const f = await setup(
    (req, res) => {
      if (req.url === '/robots.txt') {
        res.end(
          `User-agent: *\n${Array.from({ length: 120 }, (_, i) => `Disallow: /irrelevant${i}\n`).join('')}Disallow: /forbidden`,
        );
        return;
      }
      if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop#same' }).end();
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/blocked' }).end();
        return;
      }
      res.end('unexpected');
    },
    { denyHop: '/blocked' },
  );
  try {
    const robots = await f.run({ url: `${f.url}/forbidden` });
    expect(
      robots.execution?.result && (robots.execution.result as { content: string }).content,
    ).toBe('web_robots_denied');
    expect(f.counts().requests).toBe(1);
    const loop = await f.run({ url: `${f.url}/loop` });
    expect((loop.execution?.result as { content?: string } | null)?.content).toBe(
      'web_redirect_loop',
    );
    const denied = await f.run({ url: `${f.url}/redirect` });
    expect((denied.execution?.result as { content?: string } | null)?.content).toBe(
      'web_network_denied',
    );
    expect(f.admissions.some((x) => x.endsWith('/blocked'))).toBe(true);
    const before = f.counts();
    await f.run({ url: `${f.url}/valid`, max_chars: 0 });
    expect(f.counts()).toEqual(before);
  } finally {
    await f.close();
  }
}, 20000);
test('ordinary Tool denial and corrupt built parser asset produce zero DNS/socket; no raw source fallback', async () => {
  const f = await setup((_req, res) => res.end('never'), { deny: true });
  try {
    const denied = await f.run({ url: f.url });
    expect(denied.model.requests.length).toBeGreaterThan(0);
    expect(denied.execution?.status).toBe('failed');
    expect(f.counts()).toEqual({ requests: 0, dns: 0 });
  } finally {
    await f.close();
  }
  const root = mkdtempSync(join(tmpdir(), 'kite-parser-corrupt-'));
  const path = join(root, 'parser.js');
  writeFileSync(path, readFileSync(webExtractorAsset()));
  writeFileSync(path.replace('.js', '.sha256'), '0'.repeat(64));
  const bad = await setup((_req, res) => res.end('never'), {
    extractor: createPassiveWebExtractor({ workerPath: path }),
  });
  try {
    const result = await bad.run({ url: bad.url });
    expect((result.execution?.result as { content?: string } | null)?.content).toBe(
      'web_parser_unavailable',
    );
    expect(bad.counts()).toEqual({ requests: 0, dns: 0 });
  } finally {
    await bad.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
test('Tool timeout covers domain queue and live page transfer; cancelled request never becomes a successful body', async () => {
  let pageStarted!: () => void, pageClosed!: () => void;
  const started = new Promise<void>((resolve) => {
    pageStarted = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    pageClosed = resolve;
  });
  const f = await setup((req, res) => {
    if (req.url === '/robots.txt') {
      res.end('User-agent: *');
      return;
    }
    req.socket.once('close', pageClosed);
    pageStarted();
    res.write('partial-not-a-success');
  });
  try {
    const queued = await f.run({ url: f.url, timeout_ms: 10 });
    expect((queued.execution?.result as { content?: string })?.content).toBe('web_timeout');
    expect(f.counts()).toEqual({ requests: 0, dns: 0 });
    const pending = f.run({ url: f.url, timeout_ms: 1200 });
    await started;
    const completed = await pending;
    expect((completed.execution?.result as { content?: string })?.content).toBe('web_timeout');
    expect(completed.execution?.status).toBe('failed');
    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout_socket_not_closed')), 2000),
      ),
    ]);
    expect(
      completed.model.requests
        .slice()
        .reverse()
        .find((request) => request.messages.some((m) => m.role === 'tool'))
        ?.messages.slice()
        .reverse()
        .find((m) => m.role === 'tool')?.content,
    ).not.toContain('partial-not-a-success');
  } finally {
    await f.close();
  }
}, 15000);
test('precise original command cancellation closes dispatched Web socket without a partial success or next Model', async () => {
  let start!: () => void, stop!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const f = await setup((req, res) => {
    if (req.url === '/robots.txt') {
      res.end('User-agent: *');
      return;
    }
    req.socket.once('close', stop);
    res.write('uncommitted partial');
    start();
  });
  try {
    const pending = f.run({ url: f.url });
    await started;
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-web',
      sessionId: 's',
      subjectId: 'owner',
      targetCommandId: 'work1',
    });
    const result = await pending;
    expect(result.execution?.status).toBe('cancelled');
    expect(result.model.requests.length).toBe(1);
    await Promise.race([
      stopped,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cancel_socket_not_closed')), 2000),
      ),
    ]);
    expect((result.execution?.result as { content?: string })?.content).not.toContain(
      'uncommitted partial',
    );
  } finally {
    await f.close();
  }
}, 12000);
