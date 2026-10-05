import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { TuiController, type TuiPort } from '../../../src/tui';

test('actual invalid SSE with healthy HTTP cannot restore observation via snapshot; original validated ready can', async () => {
  const root = mkdtempSync('/private/tmp/kite-tui-observation-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'fixture' });
  const store = await openSqliteStore(profile);
  const runtime = createRuntime({
    store,
    instanceId: 'original',
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'fixture' };
      },
    },
  });
  const service = await startService({
    runtime,
    instanceId: 'original',
    buildId: 'fixture',
    token: 't'.repeat(64),
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  let broken = true,
    streams = 0,
    reads = 0,
    writes = 0;
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/events') {
        streams++;
        if (broken)
          return new Response('event: ready\ndata: {invalid\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
      } else if (request.method === 'GET') reads++;
      const headers = new Headers(request.headers);
      headers.delete('host');
      return fetch(`${service.endpoint}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        ...(request.method === 'GET' ? {} : { body: await request.arrayBuffer() }),
        signal: request.signal,
      });
    },
  });
  const client = createClient({
    endpoint: proxy.url.origin,
    token: 't'.repeat(64),
    expected: {
      profile: service.bootstrap.profile,
      instanceId: 'original',
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'events'],
    },
  });
  let controller: TuiController | undefined;
  const observing = new AbortController();
  let resumed: Promise<void> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await client.connect(),
      storeId = info.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'Fixture',
    });
    for (const id of ['a', 'b'])
      await client.createSession({
        expectedStoreId: storeId,
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'w',
        title: id,
      });
    const noWrite = async (): Promise<never> => {
      writes++;
      throw Error('unexpected_write');
    };
    const port: TuiPort = {
      storeId,
      nextCommandId: () => 'must-not-submit',
      listSessions: () => client.listAllSessions({ workspaceId: 'w' }),
      async readSession(id) {
        const view = await client.getView(id);
        return { storeId, view, messages: view.messages, interactions: [] };
      },
      submit: noWrite,
      answer: noWrite,
      cancel: noWrite,
      getCommand: noWrite,
    };
    controller = new TuiController(port);
    await controller.select('a');
    controller.setDraft('retained draft');
    await client
      .observe({
        reconnect: false,
        onChange: async () => {
          await controller!.select('a');
        },
        onReady: (ready) => controller!.observationReady(ready.storeId),
      })
      .catch((error) => {
        controller!.observationUnavailable(error.code);
      });
    expect(controller.state.observationError).toBe('observation_unavailable:invalid_sse_response');
    const readsBefore = reads;
    await controller.select('a');
    await controller.select('b');
    expect(reads).toBeGreaterThan(readsBefore);
    expect(controller.state.snapshot?.view.session.id).toBe('b');
    expect(controller.state).toMatchObject({
      stale: true,
      snapshotStale: false,
      observationError: 'observation_unavailable:invalid_sse_response',
    });
    await controller.select('a');
    await controller.send();
    expect(writes).toBe(0);
    expect(controller.state.draft).toBe('retained draft');
    expect(streams).toBe(1);
    // Explicitly reopen the same admitted target using its observed read baseline.
    broken = false;
    controller.observationUnavailable('server_reset');
    const page = await client.listSessionDirectory({ storeId, limit: 1 });
    await controller.select('a');
    expect(controller.state.snapshotStale).toBe(false);
    expect(controller.state.stale).toBe(true);
    let ready!: () => void;
    const confirmed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    resumed = client.observe({
      signal: observing.signal,
      reconnect: false,
      onChange: async () => {
        await controller!.select('a');
      },
      startAfter: { storeId, sequence: page.snapshotCursor },
      onReady: (frame) => {
        controller!.observationReady(frame.storeId);
        ready();
      },
    });
    await Promise.race([
      confirmed,
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(Error('ready_deadline')), 5000);
      }),
    ]);
    clearTimeout(readyTimer);
    expect(controller.state.stale).toBe(false);
    expect(controller.state.observationError).toBeUndefined();
    expect(controller.state.draft).toBe('retained draft');
    expect(streams).toBe(2);
    expect((await client.getView('a')).runs).toHaveLength(0);
    expect((await client.getView('b')).runs).toHaveLength(0);
    observing.abort();
    await resumed.catch(() => {});
  } finally {
    clearTimeout(readyTimer);
    observing.abort();
    client.disposeNetwork();
    await resumed?.catch(() => {});
    controller?.dispose();
    proxy.stop(true);
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
