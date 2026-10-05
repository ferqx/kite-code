import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient, type SessionExportFrame } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startService } from '@kite-ai/service';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

async function fixture(large = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-public-session-export-'))),
    profile = { dataRoot: join(directory, 'data'), profile: 'owned' },
    host = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId,
    artifacts = createArtifactStore({ profile, store });
  const body = large ? `Original α\n${'x'.repeat(17 * 1024 * 1024)}\nORIGINAL_BODY_TAIL` : 'Answer';
  const final: ModelEvent[] = [];
  for (let at = 0; at < body.length; at += 32768)
    final.push({ type: 'text_delta', text: body.slice(at, at + 32768) });
  final.push(finish);
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'write', name: 'fixture.write', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    final,
  ]);
  let effects = 0;
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        records: [{ contentType: 'fixture.note', contentVersion: 1, schema: { type: 'object' } }],
        tools: [
          {
            id: 'fixture.write',
            version: '1',
            description: 'Write only the disposable fixture namespace',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              effects++;
              for (let at = 0; at < 210; at++)
                await context.records.write({
                  key: `note-${at}`,
                  expectedRevision: null,
                  contentType: 'fixture.note',
                  contentVersion: 1,
                  value: { actual: effects, ordinal: at },
                });
              return { outcome: 'succeeded', content: '210 actual committed records' };
            },
          },
        ],
      },
    ],
  });
  const service = await startService({
    runtime,
    profile: host,
    buildId: 'export',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile: host, apiMajor: 1, requiredCapabilities: ['session_exports'] },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${directory}`,
    name: 'Owned',
  });
  await client.createSession({
    expectedStoreId: storeId,
    sessionId: 'source',
    workspaceId: 'w',
    commandId: 'create',
    title: 'Owned',
  });
  await client.startRun('source', {
    expectedStoreId: storeId,
    commandId: 'work',
    kind: 'run.start',
    content: 'Write actual records',
  });
  await runtime.waitForCommand('work', { timeoutMs: 15000 });
  return {
    directory,
    profile,
    host,
    store,
    storeId,
    artifacts,
    runtime,
    service,
    client,
    model,
    body,
    counts: () => ({ model: model.requests.length, effects }),
    async close() {
      client.disposeNetwork();
      await service.close();
      await artifacts.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('actual HTTP and Cookie exports preserve >200 raw records, 9MiB future text, original 17MiB media scope and cold readonly facts; physical text reply loss has no completion footer', async () => {
  const f = await fixture(true),
    future = `{ "future": "${'z'.repeat(9 * 1024 * 1024)}", "tail": "EXACT_UNKNOWN_TAIL" }`;
  const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  try {
    const message = physical
      .query("SELECT id FROM message WHERE role='assistant' ORDER BY seq DESC LIMIT 1")
      .get() as { id: string };
    physical.run(
      'INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) VALUES(?,1,?,?,?,?)',
      [message.id, 'future.part', 901, 1, future],
    );
    physical.run(
      'INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) VALUES(?,2,?,?,?,?)',
      [message.id, 'future.invalid', 902, 1, '{ invalid original envelope'],
    );
    physical.run(
      "UPDATE extension_record SET rowid=9007199254740993,origin_store_id='original-store' WHERE key='note-209'",
    );
    physical.run('UPDATE run SET config_json=?', [
      '{"privateConfiguration":"EXCLUDED_PRIVATE_CONFIGURATION"}',
    ]);
  } finally {
    physical.close();
  }
  const gateway = startDevelopmentWeb({ admittedClient: f.client });
  const document = await fetch(gateway.endpoint);
  await document.body?.cancel();
  const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
  const browser = createBrowserClient({
    origin: gateway.endpoint,
    pageIdentity: gateway.pageIdentity,
    fetch: Object.assign(
      (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            cookie,
            origin: gateway.endpoint,
          },
        }),
      { preconnect: fetch.preconnect },
    ),
  });
  let relay: ReturnType<typeof createServer> | undefined,
    lostClient: ReturnType<typeof createClient> | undefined;
  try {
    await browser.connect();
    const before = f.counts(),
      water = (await f.store.getMetadata()).lastChangeCursor,
      output = (await f.client.listMessages('source')).find(
        (message) => message.outputBody && message.outputBody.contentBytes !== '0',
      )!.outputBody!;
    for (const stream of [
      f.client.exportSession('source', { storeId: f.storeId }),
      browser.exportSession('source'),
    ]) {
      const frames: SessionExportFrame[] = [];
      for await (const frame of stream) frames.push(frame);
      expect(frames[0]!.kind).toBe('manifest');
      expect(frames.at(-1)).toMatchObject({
        kind: 'complete',
        rawTextVerified: true,
        media: 'original-scope-references',
      });
      const records = frames.flatMap((frame) => (frame.kind === 'record' ? [frame.record] : [])),
        extension = records.filter((record) => record.section === 'extension_records');
      expect(extension).toHaveLength(210);
      expect(extension.at(-1)!.seq).toBe('9007199254740993');
      expect(extension.at(-1)!.record).toMatchObject({ origin_store_id: 'original-store' });
      expect(
        records.find(
          (record) =>
            record.section === 'message_parts' &&
            (record.record as { kind: string }).kind === 'future.invalid',
        )!.record,
      ).toMatchObject({ json: '{ invalid original envelope' });
      const futureRecord = records.find(
        (record) =>
          record.section === 'message_parts' &&
          (record.record as { kind: string }).kind === 'future.part',
      )!;
      const bytes = Buffer.concat(
        frames.flatMap((frame) =>
          frame.kind === 'text' &&
          frame.page.section === 'message_parts' &&
          frame.page.seq === futureRecord.seq
            ? [Buffer.from(frame.page.contentBase64, 'base64')]
            : [],
        ),
      );
      expect(bytes.toString()).toBe(future);
      expect(
        frames.find(
          (frame) =>
            frame.kind === 'text_complete' &&
            frame.seq === futureRecord.seq &&
            frame.section === 'message_parts',
        ),
      ).toMatchObject({
        byteLength: String(bytes.length),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      expect(records.filter((record) => record.section === 'artifact_refs').length).toBeGreaterThan(
        0,
      );
      expect(JSON.stringify(frames)).not.toContain('EXCLUDED_PRIVATE_CONFIGURATION');
      expect(JSON.stringify(frames)).not.toContain('owner_generation');
    }
    expect((await f.client.getModelOutput('source', output.executionId)).output.content).toBe(
      f.body,
    );
    expect((await browser.getModelOutput('source', output.executionId)).output.content).toBe(
      f.body,
    );
    expect(f.counts()).toEqual(before);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(water);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    let textGets = 0,
      posts = 0,
      verified = 0;
    relay = createServer(async (request, response) => {
      if (request.method !== 'GET') posts++;
      const upstream = await fetch(`${f.service.endpoint}${request.url}`, {
        headers: { authorization: `Bearer ${f.service.bootstrap.token}` },
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (request.url!.includes('/export/text?')) {
        textGets++;
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        response.write(bytes.subarray(0, 17));
        response.flushHeaders();
        setImmediate(() => response.destroy());
      } else {
        if (request.url!.includes('/export/verify?')) verified++;
        response.end(new Uint8Array(await upstream.arrayBuffer()));
      }
    });
    await new Promise<void>((resolve) => relay!.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    lostClient = createClient({
      endpoint,
      token: 'private',
      expected: { profile: f.host, apiMajor: 1, requiredCapabilities: ['session_exports'] },
    });
    await lostClient.connect();
    const partial: SessionExportFrame[] = [];
    let failed = false;
    try {
      for await (const frame of lostClient.exportSession('source', { storeId: f.storeId }))
        partial.push(frame);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(partial.some((frame) => frame.kind === 'complete')).toBe(false);
    expect(textGets).toBe(1);
    expect(posts).toBe(0);
    expect(verified).toBe(0);
    expect(f.counts()).toEqual(before);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(water);
    lostClient.disposeNetwork();
    lostClient = undefined;
    await new Promise<void>((resolve) => relay!.close(() => resolve()));
    relay = undefined;
    await gateway.close();
    await f.service.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' }),
      coldArtifacts = createArtifactStore({ profile: f.profile, store: cold }),
      coldRuntime = createRuntime({
        store: cold,
        artifacts: coldArtifacts,
        permissions: {
          async authorize() {
            throw Error('unexpected_cold_authorize');
          },
        },
      }),
      coldService = await startService({
        runtime: coldRuntime,
        profile: f.host,
        buildId: 'cold',
        subjectId: 'owner',
      }),
      coldClient = createClient({
        endpoint: coldService.endpoint,
        token: coldService.bootstrap.token,
        expected: { profile: f.host, apiMajor: 1, requiredCapabilities: ['session_exports'] },
      });
    try {
      await coldClient.connect();
      const coldWater = (await cold.getMetadata()).lastChangeCursor;
      let complete = false,
        unknown = false;
      for await (const frame of coldClient.exportSession('source', { storeId: f.storeId })) {
        if (
          frame.kind === 'record' &&
          frame.record.section === 'message_parts' &&
          (frame.record.record as { kind: string }).kind === 'future.invalid'
        )
          unknown = true;
        if (frame.kind === 'complete') complete = true;
      }
      expect(unknown).toBe(true);
      expect(complete).toBe(true);
      expect(f.counts()).toEqual(before);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(coldWater);
    } finally {
      coldClient.disposeNetwork();
      await coldService.close();
      await coldArtifacts.close();
      await cold.close();
    }
  } finally {
    lostClient?.disposeNetwork();
    if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
    browser.disposeNetwork();
    await gateway.close();
    await f.close();
  }
}, 40000);

test('public exports stop at the original frozen snapshot on business/external commit, cancellation and wrong Store instead of creating a completion footer', async () => {
  const f = await fixture();
  try {
    const before = f.counts();
    const stream = f.client.exportSession('source', { storeId: f.storeId });
    expect((await stream.next()).value.kind).toBe('manifest');
    const view = await f.client.getView('source');
    await f.client.renameSession('source', {
      expectedStoreId: f.storeId,
      commandId: 'rename',
      ifRevision: view.session.controlRevision,
      title: 'Changed',
    });
    expect(((await stream.next().catch((error: unknown) => error)) as { code: string }).code).toBe(
      'export_changed',
    );
    const external = f.client.exportSession('source', { storeId: f.storeId });
    expect((await external.next()).value.kind).toBe('manifest');
    const db = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      db.run("UPDATE message_part SET json='{  invalid changed original }' WHERE ordinal=0");
    } finally {
      db.close();
    }
    expect(
      ((await external.next().catch((error: unknown) => error)) as { code: string }).code,
    ).toBe('export_changed');
    const controller = new AbortController(),
      cancelled = f.client.exportSession(
        'source',
        { storeId: f.storeId },
        { signal: controller.signal },
      );
    expect((await cancelled.next()).value.kind).toBe('manifest');
    controller.abort();
    expect(((await cancelled.next().catch((error: unknown) => error)) as Error).name).toBe(
      'AbortError',
    );
    expect(() => f.client.exportSession('source', { storeId: 'foreign' })).toThrow(
      'store_identity_mismatch',
    );
    expect(f.counts()).toEqual(before);
    const manifest = await f.client.beginSessionExport('source', { storeId: f.storeId });
    const response = await fetch(
      `${f.service.endpoint}/v1/sessions/source/export/records?${new URLSearchParams({ storeId: f.storeId, manifest: JSON.stringify(manifest), section: 'commands', subjectId: 'self-claimed' })}`,
      { headers: { authorization: `Bearer ${f.service.bootstrap.token}` } },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(((await response.json()) as { code: string }).code).toBe('invalid_request');
    expect(f.counts()).toEqual(before);
  } finally {
    await f.close();
  }
}, 20000);
