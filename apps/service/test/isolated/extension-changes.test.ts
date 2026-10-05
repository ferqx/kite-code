import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { Extension } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { readSSE } from '@kite-ai/client/sse';
import { decodeResponse } from '../../../../packages/client/src/decode';
import { startService } from '../../src';
import { schemas } from '../../src/http/schema';

const extensionId = `fixture.${'e'.repeat(120)}`;
const keys = ['ordinary.dot/slash', 'k'.repeat(256), '原记录/🙂.完成'];

test('actual durable extension record changes reach generated Client SSE without reset or extra execution', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-extension-changes-')));
  const dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'owned' });
  let effects = 0;
  let models = 0;
  const extension: Extension = {
    id: extensionId,
    version: '1',
    apiMajor: 1,
    records: [{ contentType: 'application/json', contentVersion: 1, schema: { type: 'object' } }],
    actions: [
      {
        id: 'write',
        version: '1',
        description: 'Write three owned ordinary records',
        inputSchema: { type: 'object', additionalProperties: false },
        async prepare() {
          return {};
        },
        async execute(_input, context) {
          for (const key of keys) {
            await context.records.write({
              key,
              expectedRevision: null,
              contentType: 'application/json',
              contentVersion: 1,
              value: { original: key },
            });
            effects++;
          }
          return { outcome: 'succeeded', content: 'three original records' };
        },
      },
    ],
  };
  const runtime = createRuntime({
    store,
    extensions: [extension],
    modelId: 'unused',
    model: {
      async *stream() {
        models++;
        yield {
          type: 'finish' as const,
          reason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned-1' };
      },
    },
  });
  const profile = {
    dataRoot,
    name: 'owned',
    accessKey: resolveProfile({ dataRoot, profile: 'owned' }).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    subjectId: 'owner',
    buildId: 'extension-changes',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'events', 'extensions_actions'],
    },
  });
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect();
    const expectedStoreId = service.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'owned',
    });
    const before = (await store.getMetadata()).lastChangeCursor;
    await client.invokeExtension('s', {
      expectedStoreId,
      commandId: 'records',
      kind: 'extension.invoke',
      extensionId,
      actionId: 'write',
      definitionVersion: '1',
      input: {},
    });
    await runtime.waitForCommand('records', { timeoutMs: 5000 });
    const original = await store.getChanges({ after: before, sessionIds: ['s'], limit: 100 });
    const recordEvents = original.events.filter(
      (event) => event.type === 'extension.record_updated',
    );
    expect(recordEvents.map((event) => event.objectId)).toEqual(
      keys.map((key) => `${extensionId}/${key}`),
    );
    expect(recordEvents[1]!.objectId).toHaveLength(385);
    const executions = await store.listExecutions('s');
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe('succeeded');
    const command = await client.getCommand('records');
    const seen: typeof original.events = [];
    const resets: string[] = [];
    let ready = false;
    timer = setTimeout(() => abort.abort(new Error('owned observation deadline')), 5000);
    const wire = await fetch(
      `${service.endpoint}/v1/events?${new URLSearchParams({ storeId: expectedStoreId, after: before, sessionId: 's' })}`,
      { signal: abort.signal, headers: { authorization: `Bearer ${service.bootstrap.token}` } },
    );
    const resetFrames: unknown[] = [];
    const wireRead = (async () => {
      for await (const frame of readSSE(wire.body!, { signal: abort.signal })) {
        if (frame.event === 'reset') resetFrames.push(JSON.parse(frame.data));
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted || error !== abort.signal.reason) throw error;
    });
    const observation = client
      .observe({
        cursor: { storeId: expectedStoreId, sequence: before },
        sessionIds: ['s'],
        signal: abort.signal,
        reconnect: false,
        onReady(frame) {
          ready = true;
          expect(frame.storeId).toBe(expectedStoreId);
          expect(client.lastAppliedCursor).toEqual({ storeId: expectedStoreId, sequence: before });
        },
        onChange(event) {
          seen.push(event);
        },
        onReset(reason) {
          resets.push(reason);
        },
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted || error !== abort.signal.reason) throw error;
      });
    while (
      !abort.signal.aborted &&
      resets.length === 0 &&
      client.lastAppliedCursor?.sequence !== original.metadata.lastChangeCursor
    )
      await Bun.sleep(5);
    abort.abort();
    await observation;
    await wireRead;
    console.error(
      JSON.stringify({
        extensionChangeEvidence: {
          storeId: expectedStoreId,
          commandId: command.id,
          commandStatus: command.status,
          executionId: executions[0]!.id,
          before,
          highWaterCursor: original.metadata.lastChangeCursor,
          recordEvents,
          seenCursors: seen.map((event) => event.cursor),
          resets,
          resetFrames,
          applied: client.lastAppliedCursor,
        },
      }),
    );
    expect(ready).toBe(true);
    expect(resets).toEqual([]);
    expect(resetFrames).toEqual([]);
    expect(seen).toEqual(original.events);
    expect(client.lastAppliedCursor).toEqual({
      storeId: expectedStoreId,
      sequence: original.metadata.lastChangeCursor,
    });
    expect(await store.listExecutions('s')).toEqual(executions);
    expect(await client.getCommand('records')).toEqual(command);
    expect((await store.getMetadata()).lastChangeCursor).toBe(original.metadata.lastChangeCursor);
    expect((await store.getView('s')).runs).toHaveLength(0);
    expect(effects).toBe(3);
    expect(models).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('Change event identifier bounds do not widen ordinary Session identity or accept malformed identifiers', () => {
  const event = {
    cursor: '1',
    sessionId: 's',
    objectId: 'owned',
    type: 'extension.record_updated',
    revision: '0',
    payload: null,
  };
  for (const objectId of ['', 'x'.repeat(386), 1, null, {}]) {
    const invalid = { ...event, objectId };
    expect(schemas.Change.safeParse(invalid).success).toBe(false);
    expect(() => decodeResponse('Change', invalid)).toThrow();
  }
  for (const sessionId of ['s/foreign', 's.foreign', 's'.repeat(129)]) {
    const invalid = { ...event, sessionId };
    expect(schemas.Change.safeParse(invalid).success).toBe(false);
    expect(() => decodeResponse('Change', invalid)).toThrow();
  }
}, 15000);
