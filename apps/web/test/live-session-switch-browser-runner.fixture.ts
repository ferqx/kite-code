// Standalone Chrome acceptance with the ordinary Web bundle, Cookie gateway and a private SQLite Store.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';
import {
  exerciseLiveSessionSwitches,
  liveSwitchDelta,
  liveSwitchReply,
} from '../../desktop/test/live-session-switch.fixture';
import { createTrustedAssets } from '../src/assets';

const desktop = createRequire(resolve(import.meta.dir, '../../desktop/package.json'));
const { chromium } = desktop('playwright');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-web-live-switch-')));
const cache = resolve(import.meta.dir, '../../../.cache');
mkdirSync(cache, { recursive: true });
const evidence = mkdtempSync(join(cache, 'web-live-switch-'));
const selected = { dataRoot: join(directory, 'data'), profile: 'test' };
const store = await openSqliteStore(selected);
const storeId = (await store.getMetadata()).storeId;
const profile = {
  dataRoot: realpathSync(selected.dataRoot),
  name: selected.profile,
  accessKey: resolveProfile(selected).profileAccessKey,
};
const calls: number[] = [];
const emitted = new Map<number, number>();
const finished = new Set<number>();
const toolEffects: string[] = [];
const model: ModelAdapter = {
  async *stream(request, { signal }) {
    const input =
      request.messages
        .filter((m) => m.role === 'user')
        .at(-1)
        ?.content.replaceAll('\\', '') ?? '';
    const match = /ROOT_([012])/.exec(input);
    assert.ok(match, 'expected the original session input');
    const id = Number(match[1]),
      marker = `ROOT_${id}`;
    calls.push(id);
    if (id === 2) yield { type: 'text_delta', text: `${marker}_FINAL` };
    else if (!request.messages.some((message) => message.role === 'tool')) {
      yield { type: 'reasoning_delta', text: `${marker}_THOUGHT_INITIAL` };
      for (const result of ['OK', 'ERROR']) {
        const receipt = `${marker}_TOOL_${result}`;
        yield {
          type: 'tool_call',
          id: receipt,
          name: 'fixture.check',
          arguments: JSON.stringify({ receipt }),
        };
      }
      yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
      return;
    } else {
      assert.equal(request.messages.filter((message) => message.role === 'tool').length, 2);
      yield { type: 'reasoning_delta', text: `${marker}_THOUGHT_LIVE` };
      yield { type: 'text_delta', text: liveSwitchReply(marker) };
      for (let tick = 1; !finished.has(id); tick++) {
        await Bun.sleep(240);
        signal.throwIfAborted();
        emitted.set(id, tick);
        yield { type: 'text_delta', text: liveSwitchDelta(marker, tick) };
      }
      yield { type: 'text_delta', text: `\n\n${marker}_DONE` };
    }
    yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  },
};
const runtime = createRuntime({
  store,
  artifacts: createArtifactStore({ profile: selected, store }),
  model,
  modelId: 'fixture',
  extensions: [
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.check',
          version: '1',
          description: 'Read an isolated fixture record',
          inputSchema: {
            type: 'object',
            properties: { receipt: { type: 'string' } },
            required: ['receipt'],
          },
          async execute(input) {
            const { receipt } = input as { receipt: string };
            toolEffects.push(receipt);
            return {
              outcome: receipt.endsWith('_ERROR') ? 'failed' : 'succeeded',
              content: receipt,
            };
          },
        },
      ],
    },
  ],
  permissions: {
    async authorize() {
      return { allowed: true, revision: 'fixture' };
    },
  },
});
const service = await startService({
  runtime,
  profile,
  buildId: 'live-switch',
  subjectId: 'owner',
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  bootstrap: service.bootstrap,
  expected: { profile, apiMajor: 1, requiredCapabilities: ['history'] },
});
let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
let closeBrowser: (() => Promise<void>) | undefined;
const releaseHistory = Promise.withResolvers<void>();
try {
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'Streaming workspace',
    rootUri: pathToFileURL(directory).href,
  });
  for (const id of [2, 1, 0]) {
    const sessionId = `root-${id}`;
    await client.createSession({
      expectedStoreId: storeId,
      sessionId,
      workspaceId: 'w',
      commandId: `create-${id}`,
      title: `Live Root ${id}`,
    });
    await client.startRun(sessionId, {
      expectedStoreId: storeId,
      kind: 'run.start',
      commandId: `run-${id}`,
      content: `MULTI_ROOT_${id}`,
    });
    if (id === 2) await runtime.waitForCommand('run-2', { timeoutMs: 5000 });
  }
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, '../src/browser.tsx')],
    target: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!built.success) throw new AggregateError(built.logs);
  gateway = startDevelopmentWeb({
    admittedClient: client,
    assets: (await createTrustedAssets(await built.outputs[0]!.text())).assets,
  });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
  });
  closeBrowser = () => browser.close();
  const page: Parameters<typeof exerciseLiveSessionSwitches>[0] = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  const fullReads: string[] = [],
    changes: string[] = [],
    aborted: string[] = [];
  const historyRoute = /\/browser\/v1\/sessions\/[^/]+\/(messages|message-changes)\?/;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (historyRoute.test(url.pathname + url.search))
      (url.pathname.endsWith('/messages') ? fullReads : changes).push(url.pathname);
  });
  page.on('requestfailed', (request) => {
    if (historyRoute.test(request.url())) aborted.push(new URL(request.url()).pathname);
  });
  page.on('pageerror', (error: Error) => errors.push(error.message));
  const slow = process.argv.includes('--slow-history');
  let holdHistory = false,
    heldPath: string | undefined;
  if (slow) {
    await page.route(historyRoute, async (route) => {
      const response = await route.fetch();
      const path = new URL(route.request().url()).pathname;
      if (holdHistory && path === '/browser/v1/sessions/root-0/message-changes') {
        holdHistory = false;
        heldPath = path;
        await releaseHistory.promise;
      }
      await Bun.sleep(320);
      await route.fulfill({ response });
    });
  }
  await page.goto(`${gateway.endpoint}/sessions/root-0`);
  await page.getByRole('button', { name: 'Streaming workspace', exact: true }).click();
  const produced = async () => [...emitted].map(([id, tick]) => ({ marker: `ROOT_${id}`, tick }));
  const observation = await exerciseLiveSessionSwitches(
    page,
    {
      client: 'web',
      pendingRead: slow
        ? {
            async arm() {
              holdHistory = true;
            },
            async waitHeld() {
              const deadline = Date.now() + 10000;
              while (!heldPath) {
                assert.ok(Date.now() < deadline, 'waiting for the original A changes response');
                await Bun.sleep(20);
              }
            },
            async afterSwitch() {
              releaseHistory.resolve();
            },
          }
        : undefined,
    },
    evidence,
    produced,
    async (id) => {
      finished.add(id);
      assert.equal(
        (await runtime.waitForCommand(`run-${id}`, { timeoutMs: 5000 })).status,
        'applied',
      );
      return emitted.get(id)!;
    },
  );
  assert.deepEqual([...calls].sort(), [0, 0, 1, 1, 2]);
  assert.deepEqual([...toolEffects].sort(), [
    'ROOT_0_TOOL_ERROR',
    'ROOT_0_TOOL_OK',
    'ROOT_1_TOOL_ERROR',
    'ROOT_1_TOOL_OK',
  ]);
  assert.deepEqual(errors, []);
  assert.equal(fullReads.length, 3, 'the three admitted histories need one baseline each');
  assert.ok(changes.length > 0);
  writeFileSync(
    join(evidence, 'report.json'),
    JSON.stringify(
      { ...observation, calls, toolEffects, errors, fullReads, changes, aborted, heldPath },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ evidence, frames: observation.frames.length, visits: observation.visits }),
  );
} finally {
  releaseHistory.resolve();
  finished.add(0);
  finished.add(1);
  await closeBrowser?.();
  await gateway?.close();
  client.disposeNetwork();
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
