import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { PermissionMode } from '@kite-ai/agent/permissions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const reviewReason = 'Exact requested destination rejected by the safety reviewer';
async function fixture(mode: PermissionMode, decision = 'approve_once', guard?: 'off' | 'ssrf') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-web-permission-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  privateDirectory(profile.profilePath);
  let dns = 0,
    sockets = 0,
    normal = 0;
  const reviews: Record<string, unknown>[] = [];
  const web = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      sockets++;
      return new Response(
        new URL(request.url).pathname === '/robots.txt'
          ? 'User-agent: *'
          : 'complete approved body',
        { headers: { 'content-type': 'text/plain' } },
      );
    },
  });
  const url = `http://fixture.test:${web.port}/page`;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; content: string }[];
        tools?: unknown[];
      };
      let payload: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(
          body.messages
            .slice()
            .reverse()
            .find((message) => message.role === 'user')?.content ?? '',
        );
        if (parsed.purpose === 'authorization_check') payload = parsed;
      } catch {}
      let delta: unknown, finish: string;
      if (payload) {
        reviews.push({ body, payload, beforeNetwork: { dns, sockets } });
        delta = { content: JSON.stringify({ decision, reason: reviewReason }) };
        finish = 'stop';
      } else if (normal++ === 0) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: 'original-fetch',
              type: 'function',
              function: { name: 'web_fetch', arguments: JSON.stringify({ url }) },
            },
          ],
        };
        finish = 'tool_calls';
      } else {
        delta = { content: 'finished original fetch' };
        finish = 'stop';
      }
      const chunk = (value: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, finish)}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'local',
      models: [
        {
          id: 'local',
          provider: 'compatible',
          model: 'local',
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
        },
      ],
      tools: [{ id: 'web_fetch', definitionVersion: '1' }],
    }),
  );
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    profile,
    permissionPolicy: {
      readPolicy: () => ({
        mode,
        workspaceTrust: true,
        revision: 'actual-web-policy',
        allowed: [
          { kind: 'model', definitionId: 'local', definitionVersion: '1' },
          { kind: 'tool', definitionId: 'web_fetch', definitionVersion: '1' },
        ],
      }),
    },
    webFetch: {
      network: {
        policy: guard === 'off' ? { mode: 'off' } : { mode: 'allowlist', hosts: ['fixture.test'] },
        allowLoopbackForTests: guard !== 'ssrf',
        admitHop: async () => ({ allowed: true, revision: 'actual-test-resource-admission' }),
        resolveAddresses: async () => {
          dns++;
          return [{ address: '127.0.0.1', family: 4 }];
        },
      },
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    ...host,
    permissions: host.permissions!,
    store,
    artifacts: createArtifactStore({ profile, store }),
  });
  host.permissionManagement?.(runtime);
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: serverProfile,
    subjectId: 'owner',
    buildId: 'web-permission',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: serverProfile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'interactions'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(workspace).href,
    name: 'temporary',
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'web permission',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    workspaceId: 'w',
    mode,
    trusted: true,
  });
  return {
    runtime,
    store,
    client,
    expectedStoreId,
    reviews,
    url,
    counts: () => ({ dns, sockets, normal }),
    run: () =>
      client.startRun('s', {
        expectedStoreId,
        commandId: 'work',
        kind: 'run.start',
        content: 'fetch exact destination',
      }),
    done: () => runtime.waitForCommand('work', { timeoutMs: 8000 }),
    cards: () => client.listInteractions('s', { storeId: expectedStoreId }),
    tool: async () =>
      (await store.listExecutions('s', 200)).find((row) => row.definitionId === 'web_fetch'),
    async pending() {
      const deadline = Date.now() + 8000;
      while (Date.now() <= deadline) {
        const card = (
          await client.listInteractions('s', { storeId: expectedStoreId, state: 'pending' })
        ).interactions[0];
        if (card) return card;
        await Bun.sleep(10);
      }
      throw new Error('web_permission_card_deadline');
    },
    async close() {
      client.disposeNetwork();
      try {
        await service.close();
      } finally {
        await provider.stop(true);
        await web.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('Request Approval web_fetch waits before DNS/socket; original public approval performs the fetch and exits normally', async () => {
  const f = await fixture('accept_edits');
  try {
    expect(f.counts()).toEqual({ dns: 0, sockets: 0, normal: 0 });
    await f.run();
    const card = await f.pending();
    expect(card.request).toMatchObject({
      definitionId: 'web_fetch',
      input: { url: f.url },
      policy: { mode: 'accept_edits', effects: ['network', 'unknown'] },
    });
    expect(f.counts()).toEqual({ dns: 0, sockets: 0, normal: 1 });
    expect(f.reviews).toHaveLength(0);
    await f.client.answerInteraction('s', card.id, {
      expectedStoreId: f.expectedStoreId,
      commandId: 'approve-fetch',
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    await f.done();
    expect(await f.tool()).toMatchObject({ status: 'succeeded' });
    expect(f.counts().dns).toBeGreaterThan(0);
    expect(f.counts().sockets).toBeGreaterThan(0);
    expect((await f.runtime.getView('s')).runs[0]!.status).toBe('completed');
    expect((await f.cards()).interactions).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('Auto web_fetch actual reviewer approves or rejects with the original reason and no human approval bypass', async () => {
  for (const decision of ['approve_once', 'reject']) {
    const f = await fixture('auto', decision);
    try {
      await f.run();
      await f.done();
      expect(f.reviews).toHaveLength(1);
      expect(f.reviews[0]!.beforeNetwork).toEqual({ dns: 0, sockets: 0 });
      expect((f.reviews[0]!.body as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
      expect(JSON.stringify(f.reviews[0]!.payload)).toContain(f.url);
      expect((await f.cards()).interactions).toHaveLength(0);
      if (decision === 'approve_once') {
        expect(await f.tool()).toMatchObject({ status: 'succeeded' });
        expect(f.counts().sockets).toBeGreaterThan(0);
        expect((await f.runtime.getView('s')).runs[0]!.status).toBe('completed');
      } else {
        expect(f.counts()).toEqual({ dns: 0, sockets: 0, normal: 2 });
        expect(await f.tool()).toMatchObject({
          status: 'failed',
          result: { outcome: 'failed', details: { code: 'permission_denied' } },
        });
        expect((await f.runtime.getView('s')).runs[0]!.status).toBe('completed');
        const executions = await f.store.listExecutions('s', 200);
        expect(JSON.stringify(executions)).toContain(reviewReason);
      }
    } finally {
      await f.close();
    }
  }
}, 20000);

test('Full web_fetch skips routine approval while explicit network-off and SSRF guards remain effective', async () => {
  for (const guard of [undefined, 'off', 'ssrf'] as const) {
    const f = await fixture('full', 'approve_once', guard);
    try {
      await f.run();
      await f.done();
      expect(f.reviews).toHaveLength(0);
      expect((await f.cards()).interactions).toHaveLength(0);
      if (!guard) {
        expect(await f.tool()).toMatchObject({ status: 'succeeded' });
        expect(f.counts().sockets).toBeGreaterThan(0);
        expect((await f.runtime.getView('s')).runs[0]!.status).toBe('completed');
      } else {
        expect(f.counts().sockets).toBe(0);
        expect((await f.tool())?.status).toBe('failed');
        if (guard === 'off') expect(f.counts().dns).toBe(0);
        else expect((await f.tool())?.result).toMatchObject({ content: 'web_destination_denied' });
      }
    } finally {
      await f.close();
    }
  }
}, 20000);
