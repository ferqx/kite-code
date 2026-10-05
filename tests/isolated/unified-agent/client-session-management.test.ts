import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function rejected(work: Promise<unknown>, code: string) {
  const error = await work.catch((failure: unknown) => failure);
  expect((error as { code?: string }).code).toBe(code);
}

test('actual HTTP Fork/rename/delete commit once across lost physical replies; original receipt, CAS, tombstone and cold history remain truthful', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-public-session-management-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const model = createFixedModel([
    [{ type: 'text_delta', text: 'Recorded original answer' }, finish],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    artifacts: createArtifactStore({ profile, store }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  const host = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' };
  const service = await startService({
    runtime,
    profile: host,
    buildId: 'session-management',
    subjectId: 'owner',
  });
  const sockets = new Set<Socket>(),
    posts = new Map<string, number>();
  const lost = new Set(['fork-original', 'delete-original']);
  const relay = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const commandId = body.length
      ? (JSON.parse(body.toString()) as { commandId?: string }).commandId
      : undefined;
    if (commandId) posts.set(commandId, (posts.get(commandId) ?? 0) + 1);
    const upstream = await fetch(`${service.endpoint}${request.url}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      ...(body.length ? { body } : {}),
    });
    let bytes = Buffer.from(await upstream.arrayBuffer());
    if (commandId && lost.delete(commandId)) {
      expect(upstream.status).toBe(200);
      request.socket.destroy();
      return;
    }
    if (commandId === 'rename-invalid-reply') {
      const value = JSON.parse(bytes.toString());
      value.command.receipt.session.id = 'forged-other-session';
      bytes = Buffer.from(JSON.stringify(value));
    }
    response.writeHead(upstream.status, { 'content-type': 'application/json' });
    response.end(bytes);
  });
  relay.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const client = createClient({
    endpoint: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    token: service.bootstrap.token,
    expected: { profile: host, apiMajor: 1, requiredCapabilities: ['sessions', 'context'] },
  });
  let closed = false;
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned',
      rootUri: `file://${root}`,
    });
    for (const sessionId of ['source', 'other'])
      await client.createSession({
        expectedStoreId,
        sessionId,
        workspaceId: 'w',
        commandId: `create-${sessionId}`,
        title: sessionId,
      });
    await client.startRun('source', {
      expectedStoreId,
      commandId: 'original',
      kind: 'run.start',
      content: 'Local original work',
    });
    await runtime.waitForCommand('original', { timeoutMs: 5000 });
    const source = await client.getView('source');
    expect(source.runs[0]!.status).toBe('completed');
    expect(source.messages).toHaveLength(2);
    const forkIntent = {
      expectedStoreId,
      commandId: 'fork-original',
      expectedContextSelectionId: source.session.contextSelectionId,
      newSessionId: 'branch',
      title: 'Original branch',
    };
    await rejected(client.forkSession('source', forkIntent), 'network_outcome_unknown');
    const originalFork = await client.getCommand(forkIntent.commandId);
    expect(originalFork).toMatchObject({
      id: forkIntent.commandId,
      sessionId: 'branch',
      originStoreId: expectedStoreId,
      kind: 'session.create',
      status: 'applied',
    });
    expect(originalFork.receipt).toMatchObject({
      sourceSessionId: 'source',
      sourceSelectionId: source.session.contextSelectionId,
      omittedExtensionState: true,
    });
    expect(posts.get(forkIntent.commandId)).toBe(1);
    const branch = await client.getView('branch');
    expect(branch.runs).toHaveLength(0);
    expect(branch.executions).toHaveLength(0);
    expect(branch.messages.map((message) => message.content)).toEqual(
      source.messages.map((message) => message.content),
    );
    expect(model.requests).toHaveLength(1);
    const rename = {
      expectedStoreId,
      commandId: 'rename-original',
      ifRevision: branch.session.controlRevision,
      title: 'Renamed branch',
    };
    const pending = client.renameSession('branch', rename);
    rename.title = 'Changed caller alias';
    const renamed = await pending;
    expect(renamed.session.title).toBe('Renamed branch');
    expect(renamed.session.controlRevision).toBe('1');
    await rejected(
      client.renameSession('branch', {
        expectedStoreId,
        commandId: 'rename-invalid-reply',
        ifRevision: '1',
        title: 'Committed original intent',
      }),
      'network_outcome_unknown',
    );
    expect(posts.get('rename-invalid-reply')).toBe(1);
    expect((await client.getCommand('rename-invalid-reply')).receipt).toMatchObject({
      outcome: 'renamed',
      session: { id: 'branch', title: 'Committed original intent', controlRevision: '2' },
    });
    const renamedAgain = await client.renameSession('branch', {
      expectedStoreId,
      commandId: 'rename-later',
      ifRevision: '2',
      title: 'Later title',
    });
    expect(renamedAgain.session.controlRevision).toBe('3');
    expect(await client.renameSession('branch', { ...rename, title: 'Renamed branch' })).toEqual(
      renamed,
    );
    expect((await client.getCommand(rename.commandId)).receipt).toEqual(renamed.command.receipt);
    await rejected(
      client.renameSession('branch', { ...rename, commandId: 'stale', title: 'stale' }),
      'session_revision_changed',
    );
    await rejected(
      client.renameSession('branch', { ...rename, title: 'changed intent' }),
      'command_conflict',
    );
    await rejected(
      client.deleteSession('branch', {
        expectedStoreId: 'foreign',
        commandId: 'foreign',
        ifRevision: '3',
      }),
      'store_identity_mismatch',
    );
    expect(posts.has('foreign')).toBe(false);
    const invalid = await fetch(`${service.endpoint}/v1/sessions/branch/delete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expectedStoreId,
        commandId: 'forged-subject',
        ifRevision: '3',
        subjectId: 'owner',
      }),
    });
    expect(invalid.status).toBe(400);
    const deletion = { expectedStoreId, commandId: 'delete-original', ifRevision: '3' };
    await rejected(client.deleteSession('branch', deletion), 'network_outcome_unknown');
    const deletedCommand = await client.getCommand(deletion.commandId);
    expect(deletedCommand).toMatchObject({
      id: deletion.commandId,
      sessionId: 'branch',
      kind: 'session.delete',
      status: 'applied',
    });
    expect(deletedCommand.receipt).toMatchObject({
      outcome: 'delete_requested',
      stopConfirmed: false,
      session: { id: 'branch', title: 'Later title', controlRevision: '4' },
    });
    expect(posts.get(deletion.commandId)).toBe(1);
    const deleted = await client.getView('branch');
    expect(deleted.session.deletedAt).toBeGreaterThan(0);
    expect(deleted.messages).toEqual(branch.messages);
    expect((await client.listSessions()).map((session) => session.id).sort()).toEqual([
      'other',
      'source',
    ]);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    expect((await client.getCommand(deletion.commandId)).receipt).toEqual(deletedCommand.receipt);
    expect((await client.getView('source')).messages).toEqual(source.messages);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(model.requests).toHaveLength(1);
    await client.startRun('other', {
      expectedStoreId,
      commandId: 'other-work',
      kind: 'run.start',
      content: 'Unaffected other Session',
    });
    await runtime.waitForCommand('other-work', { timeoutMs: 5000 });
    expect((await client.getView('other')).runs[0]!.status).toBe('completed');
    expect(model.requests).toHaveLength(2);
    await service.close();
    closed = true;
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      const coldCursor = (await cold.getMetadata()).lastChangeCursor;
      expect((await cold.getView('branch')).session.deletedAt).toBe(deleted.session.deletedAt);
      expect((await cold.getCommand(deletion.commandId))!.receipt).toEqual(deletedCommand.receipt);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(coldCursor);
      expect(model.requests).toHaveLength(2);
    } finally {
      await cold.close();
    }
  } finally {
    client.disposeNetwork();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    if (!closed) await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
