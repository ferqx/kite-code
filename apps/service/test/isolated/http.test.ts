import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { defineExtension, type Permissions, type ToolDefinition } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { startService } from '../../src';

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

async function fixture(
  options: {
    tool?: ToolDefinition;
    permissions?: Permissions;
    responses?: ModelEvent[][];
    sseMaxBufferedBytes?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-http-service-'));
  const dataRoot = join(root, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'disposable' });
  const paths = resolveProfile({ dataRoot, profile: 'disposable' });
  const model = createFixedModel(options.responses ?? [[finish]]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: options.permissions ?? {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: options.tool
      ? [defineExtension({ id: 'fixture.http', version: '1', apiMajor: 1, tools: [options.tool] })]
      : [],
  });
  const startup = await store.getMetadata();
  const service = await startService({
    runtime,
    profile: {
      dataRoot: realpathSync(dataRoot),
      name: 'disposable',
      accessKey: paths.profileAccessKey,
    },
    buildId: 'test-build',
    subjectId: 'owner',
    sseMaxBufferedBytes: options.sseMaxBufferedBytes,
  }).catch(async (error) => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  });
  const request = (path: string, init?: RequestInit) =>
    fetch(service.endpoint + path, {
      ...init,
      headers: { authorization: `Bearer ${service.bootstrap.token}`, ...(init?.headers ?? {}) },
    });
  const post = (path: string, body: unknown) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const create = async () => {
    expect(
      (
        await post('/v1/workspaces', {
          expectedStoreId: startup.storeId,
          id: 'workspace',
          rootUri: `file://${root}`,
          name: 'Disposable',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post('/v1/sessions', {
          expectedStoreId: startup.storeId,
          commandId: 'create',
          sessionId: 'session',
          workspaceId: 'workspace',
          title: 'HTTP',
        })
      ).status,
    ).toBe(201);
  };
  return {
    root,
    store,
    runtime,
    model,
    service,
    startup,
    paths,
    request,
    post,
    create,
    async close() {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => {
    void reader.cancel('test read deadline');
  }, 5000);
  try {
    while (!predicate(text)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`SSE ended before expected frame: ${text}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function rawHostStatus(endpoint: string, token: string): Promise<number> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let response = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Raw HTTP deadline')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('end', () => resolve(Number(response.split(' ')[1])));
    socket.on('connect', () =>
      socket.write(
        `GET /v1/server HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
      ),
    );
  });
}

test('real HTTP exposes projected facts, distinguishes initialization writes and rejects invalid business requests locally', async () => {
  const data = await fixture();
  try {
    const db = new Database(data.paths.databasePath, { readonly: true });
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({
        count: 1,
      });
      expect(db.query('SELECT COUNT(*) AS count FROM command').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    expect((await fetch(`${data.service.endpoint}/v1/server`)).status).toBe(401);
    expect(
      (await data.request('/v1/server', { headers: { origin: 'https://evil.example' } })).status,
    ).toBe(403);
    expect(await rawHostStatus(data.service.endpoint, data.service.bootstrap.token)).toBe(403);
    const oversized = await data.request('/v1/workspaces', {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(
      (
        await data.post('/v1/sessions', {
          commandId: 'missing',
          sessionId: 'session',
          workspaceId: 'workspace',
          title: 'Missing identity',
        })
      ).status,
    ).toBe(400);
    expect((await data.store.getMetadata()).lastChangeCursor).toBe(data.startup.lastChangeCursor);
    expect(await data.store.listSessions()).toHaveLength(0);
    expect(data.model.requests).toHaveLength(0);
    await data.create();
    const before = await data.store.getMetadata();
    for (const path of [
      '/v1/server',
      '/v1/workspaces',
      '/v1/workspaces/workspace',
      '/v1/sessions',
      '/v1/sessions/session/view',
      '/v1/sessions/session/messages',
    ])
      expect((await data.request(path)).status).toBe(200);
    expect((await data.store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
    expect(data.model.requests).toHaveLength(0);
    const view = await (await data.request('/v1/sessions/session/view')).json();
    expect(view.session.ownerGeneration).toBeUndefined();
    expect(view.session.rootSessionId).toBe('session');
    const forged = await data.post('/v1/sessions/session/commands', {
      expectedStoreId: data.startup.storeId,
      commandId: 'forged',
      kind: 'run.start',
      content: 'Hello',
      subjectId: 'intruder',
      status: 'completed',
    });
    expect(forged.status).toBe(400);
    expect(await data.store.getCommand('forged')).toBeNull();
    expect((await data.request('/rpc')).status).toBe(404);
    expect((await data.request('/health/live')).status).toBe(200);
  } finally {
    await data.close();
  }
}, 15_000);

test('SSE rejects future/invalid cursors before ready and replays durable global facts with exact decimal IDs', async () => {
  const data = await fixture();
  try {
    await data.create();
    const metadata = await data.store.getMetadata();
    const base = `/v1/events?storeId=${metadata.storeId}`;
    const future = await data.request(`${base}&after=${BigInt(metadata.lastChangeCursor) + 1n}`);
    expect(future.status).toBe(409);
    expect((await future.json()).code).toBe('cursor_ahead');
    for (const cursor of ['-1', '9223372036854775808', '1.1'])
      expect((await data.request(`${base}&after=${cursor}`)).status).toBe(400);
    expect((await data.request('/v1/events?storeId=wrong&after=0')).status).toBe(410);
    const replay = await data.request(`${base}&after=0`);
    const reader = replay.body!.getReader();
    try {
      const text = await readUntil(reader, (text) =>
        text.includes(`id: ${metadata.lastChangeCursor}\n`),
      );
      const frames = text.split('\n\n');
      expect(frames[0]).toContain('event: ready');
      expect(frames[0]).not.toContain('id:');
      expect(frames[0]).toContain(`"highWaterCursor":"${metadata.lastChangeCursor}"`);
      expect(frames.some((frame) => frame.includes('event: change'))).toBe(true);
      expect(
        frames
          .filter((frame) => frame.startsWith('id:'))
          .every((frame) => /^id: [0-9]+\n/.test(frame)),
      ).toBe(true);
    } finally {
      await reader.cancel();
    }
    const scoped = await data.request(`${base}&after=0&sessionId=unrelated`);
    const scopeReader = scoped.body!.getReader();
    try {
      const text = await readUntil(scopeReader, (text) => text.includes('event: checkpoint'));
      expect(text).not.toContain('event: change');
      expect(text).toContain(`"cursor":"${metadata.lastChangeCursor}"`);
    } finally {
      await scopeReader.cancel();
    }
    expect(data.model.requests).toHaveLength(0);
  } finally {
    await data.close();
  }
}, 15_000);

test('202 acceptance and disconnected SSE stay separate from actual execution; Service shutdown closes long streams', async () => {
  const entered = barrier();
  const proceed = barrier();
  const effectRoot = mkdtempSync(join(tmpdir(), 'kite-http-effect-'));
  const ledger = join(effectRoot, 'ledger');
  const tool: ToolDefinition = {
    id: 'fixture.effect',
    version: '1',
    description: 'Gated effect',
    inputSchema: { type: 'object' },
    async execute() {
      entered.release();
      await proceed.waiting;
      writeFileSync(ledger, 'effect');
      return { outcome: 'succeeded', content: 'done' };
    },
  };
  const data = await fixture({
    tool,
    responses: [
      [
        { type: 'tool_call', id: 'call', name: tool.id, arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ],
  });
  try {
    await data.create();
    const response = await data.post('/v1/sessions/session/commands', {
      expectedStoreId: data.startup.storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Execute',
    });
    expect(response.status).toBe(202);
    const command = await response.json();
    expect(command.id).toBe('work');
    expect(command.status).toBe('accepted');
    await entered.waiting;
    expect(existsSync(ledger)).toBe(false);
    const cursor = (await data.store.getMetadata()).lastChangeCursor;
    const subscription = await data.request(
      `/v1/events?storeId=${data.startup.storeId}&after=${cursor}`,
    );
    const reader = subscription.body!.getReader();
    await readUntil(reader, (text) => text.includes('event: ready'));
    await reader.cancel();
    expect((await data.runtime.getView('session')).runs[0]!.isActive).toBe(true);
    proceed.release();
    await data.runtime.waitForCommand('work');
    expect(readFileSync(ledger, 'utf8')).toBe('effect');
    const view = await (await data.request('/v1/sessions/session/view')).json();
    expect(view.runs[0].status).toBe('completed');
    const run = await (await data.request(`/v1/runs/${view.runs[0].id}`)).json();
    expect(run.status).toBe('completed');
    const execution = view.executions.find((item: { kind: string }) => item.kind === 'tool');
    expect((await data.request(`/v1/executions/${execution.id}`)).status).toBe(200);
    const secondSubscription = await data.request(
      `/v1/events?storeId=${data.startup.storeId}&after=${view.snapshotCursor}`,
    );
    const secondReader = secondSubscription.body!.getReader();
    await readUntil(secondReader, (text) => text.includes('event: ready'));
    await data.service.close();
    expect((await secondReader.read()).done).toBe(true);
  } finally {
    proceed.release();
    await data.close();
    rmSync(effectRoot, { recursive: true, force: true });
  }
}, 15_000);

test('HTTP command.cancel targets the original command and rejects a stale Store without mutation', async () => {
  const entered = barrier();
  const proceed = barrier();
  let calls = 0;
  const tool: ToolDefinition = {
    id: 'fixture.cancel',
    version: '1',
    description: 'Cancellation fixture',
    inputSchema: { type: 'object' },
    async execute() {
      calls++;
      return { outcome: 'succeeded', content: 'should not execute' };
    },
  };
  const data = await fixture({
    tool,
    permissions: {
      async authorize(request) {
        if (request.definitionId === tool.id) {
          entered.release();
          await proceed.waiting;
        }
        return { allowed: true, revision: '1' };
      },
    },
    responses: [
      [
        { type: 'tool_call', id: 'call', name: tool.id, arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ],
  });
  try {
    await data.create();
    expect(
      (
        await data.post('/v1/sessions/session/commands', {
          expectedStoreId: data.startup.storeId,
          commandId: 'original',
          kind: 'run.start',
          content: 'Original work',
        })
      ).status,
    ).toBe(202);
    await entered.waiting;
    const before = (await data.store.getMetadata()).lastChangeCursor;
    const cancel = {
      expectedStoreId: data.startup.storeId,
      commandId: 'cancel-original',
      kind: 'command.cancel',
      targetCommandId: 'original',
    };
    const stale = await data.post('/v1/sessions/session/commands', {
      ...cancel,
      expectedStoreId: 'stale-store',
      commandId: 'stale-cancel',
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('store_identity_mismatch');
    expect(await data.runtime.getCommand('stale-cancel')).toBeNull();
    expect((await data.store.getMetadata()).lastChangeCursor).toBe(before);
    expect((await data.post('/v1/sessions/session/commands', cancel)).status).toBe(202);
    proceed.release();
    await data.runtime.waitForCommand('original');
    expect(calls).toBe(0);
    expect((await data.runtime.getView('session')).runs[0]!.status).toBe('cancelled');
    expect(
      (
        await data.post('/v1/sessions/session/commands', {
          expectedStoreId: data.startup.storeId,
          commandId: 'later',
          kind: 'run.start',
          content: 'Later work',
        })
      ).status,
    ).toBe(202);
    await data.runtime.waitForCommand('later');
    expect((await data.post('/v1/sessions/session/commands', cancel)).status).toBe(202);
    expect(
      (await data.runtime.getView('session')).runs.find((run) => run.originCommandId === 'later')!
        .status,
    ).toBe('completed');
  } finally {
    proceed.release();
    await data.close();
  }
}, 15_000);

test('an SSE subscription over its own buffer limit closes locally without affecting commands', async () => {
  const data = await fixture({ sseMaxBufferedBytes: 8 });
  try {
    await data.create();
    const response = await data.request(`/v1/events?storeId=${data.startup.storeId}&after=0`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    const accepted = await data.post('/v1/sessions/session/commands', {
      expectedStoreId: data.startup.storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Hello',
    });
    expect(accepted.status).toBe(202);
    await data.runtime.waitForCommand('work');
    expect((await data.runtime.getView('session')).runs[0]!.status).toBe('completed');
  } finally {
    await data.close();
  }
}, 15_000);
