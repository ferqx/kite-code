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
import {
  compressContext,
  deleteSession,
  forkSession,
  getCompleteContext,
  lookupManagementOutcome,
  renameSession,
  resetCompressionContext,
  rewindContext,
} from '../../src';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test('CLI public management commits once after physical lost response; original CAS/Fork/Context and delete request remain exact', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-management-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const model = createFixedModel(
    Array.from(
      { length: 102 },
      () => [{ type: 'text_delta', text: 'Original full body' }, finish] as ModelEvent[],
    ),
  );
  const runtime = createRuntime({
    store,
    model,
    artifacts: createArtifactStore({ profile, store }),
    compressor: {
      id: 'owned-summary',
      version: '1',
      async prepare() {
        return {
          instructions: 'Summarize the exact original range without Tool calls',
          snapshot: { algorithm: 'test' },
        };
      },
      async validateSummary(input) {
        return input.summary === 'Original full body';
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  const target = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'test' };
  const service = await startService({
    runtime,
    profile: target,
    buildId: 'cli-management',
    subjectId: 'owner',
  });
  const sockets = new Set<Socket>(),
    posts = new Map<string, number>();
  let lost = true;
  const relay = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks),
      commandId = body.length
        ? (JSON.parse(body.toString()) as { commandId?: string }).commandId
        : undefined;
    if (commandId) posts.set(commandId, (posts.get(commandId) ?? 0) + 1);
    const result = await fetch(service.endpoint + request.url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      ...(body.length ? { body } : {}),
    });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (commandId === 'rename-lost' && lost) {
      lost = false;
      request.socket.destroy();
      return;
    }
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(bytes);
  });
  relay.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  const client = createClient({
    endpoint: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    token: service.bootstrap.token,
    expected: {
      profile: target,
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'context', 'commands'],
    },
  });
  const options = { client, write(_line: string) {}, pollIntervalMs: 1 };
  async function until(commandId: string) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const fact = await client.getCommand(commandId);
      if (fact.status === 'applied' || fact.status === 'rejected') return fact;
      await Bun.sleep(2);
    }
    throw Error('fixture_wait');
  }
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'owned',
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'old',
    });
    const rename = {
      expectedStoreId,
      commandId: 'rename-lost',
      ifRevision: '0',
      title: 'actual title',
    };
    const renamed = await renameSession('s', rename, options);
    expect(renamed.status).toBe('applied');
    expect(posts.get('rename-lost')).toBe(1);
    expect((await lookupManagementOutcome(renamed.intent, options)).status).toBe('applied');
    expect((await renameSession('s', rename, options)).status).toBe('applied');
    expect(posts.get('rename-lost')).toBe(1);
    expect(
      (await renameSession('s', { ...rename, commandId: 'stale', title: 'overwrite' }, options))
        .status,
    ).toBe('failed');
    expect((await client.getView('s')).session.title).toBe('actual title');
    // Real public Run commands create >200 actual messages; reads must not invoke another Model.
    for (let i = 0; i < 101; i++) {
      await client.startRun('s', {
        expectedStoreId,
        commandId: `run-${i}`,
        kind: 'run.start',
        content: `user ${i}`,
      });
      expect((await until(`run-${i}`)).status).toBe('applied');
    }
    const finishDeadline = Date.now() + 5000;
    while ((await client.getView('s')).runs.some((run) => run.isActive)) {
      if (Date.now() > finishDeadline) throw Error('original_model_not_terminal');
      await Bun.sleep(2);
    }
    const view = await client.getView('s'),
      selection = view.session.contextSelectionId;
    const context = await getCompleteContext(
      's',
      { storeId: expectedStoreId, contextSelectionId: selection },
      options,
    );
    expect(context.messages).toHaveLength(202);
    expect(context.messages.at(-1)?.seq).toBe(view.session.nextSeq);
    expect(context.nextAfterSeq).toBeNull();
    const fork = await forkSession(
      's',
      {
        expectedStoreId,
        commandId: 'fork',
        expectedContextSelectionId: selection,
        newSessionId: 'fork',
        title: 'branch',
      },
      options,
    );
    expect(fork.status).toBe('applied');
    expect(fork.omittedExtensionState).toBe(true);
    const forkMessages = await client.listMessages('fork', { limit: 200 });
    expect(forkMessages[0]?.originMessage?.sessionId).toBe('s');
    const rewind = await rewindContext(
      's',
      {
        expectedStoreId,
        commandId: 'rewind',
        expectedContextSelectionId: selection,
        boundary: null,
      },
      options,
    );
    expect(rewind.status).toBe('applied');
    expect(
      (await getCompleteContext('s', { storeId: expectedStoreId }, options)).messages,
    ).toHaveLength(0);
    expect(await client.listMessages('s', { limit: 200 })).toHaveLength(200);
    const originalFork = await client.getView('fork');
    const compact = await compressContext(
      'fork',
      {
        expectedStoreId,
        commandId: 'compact',
        expectedContextSelectionId: originalFork.session.contextSelectionId,
      },
      options,
    );
    expect(['accepted', 'failed']).toContain(compact.status);
    await runtime.waitForCommand('compact', { timeoutMs: 5000 });
    const compactFact = await lookupManagementOutcome(compact.intent, options);
    expect(compactFact.status).toBe('applied');
    const compressed = await client.getContext('fork', { storeId: expectedStoreId });
    expect(compressed.compression?.runId).toBe(
      (compactFact.command?.receipt as { runId: string }).runId,
    );
    const reset = await resetCompressionContext(
      'fork',
      {
        expectedStoreId,
        commandId: 'reset',
        expectedContextSelectionId: originalFork.session.contextSelectionId,
        expectedCompressionId: compressed.compression!.id,
      },
      options,
    );
    expect(['accepted', 'failed']).toContain(reset.status);
    await runtime.waitForCommand('reset', { timeoutMs: 5000 });
    expect((await lookupManagementOutcome(reset.intent, options)).status).toBe('failed');
    expect((await client.getView('fork')).session.contextSelectionId).toBe(
      originalFork.session.contextSelectionId,
    );
    expect((await client.getContext('fork', { storeId: expectedStoreId })).compression?.id).toBe(
      compressed.compression!.id,
    );
    const deleted = await deleteSession(
      'fork',
      { expectedStoreId, commandId: 'delete', ifRevision: originalFork.session.controlRevision },
      options,
    );
    expect(deleted.status).toBe('delete_requested');
    expect((deleted.command?.receipt as { stopConfirmed: boolean }).stopConfirmed).toBe(false);
    expect(posts.get('delete')).toBe(1);
    expect(
      (await client.getView('s')).runs.filter((run) => run.status === 'completed'),
    ).toHaveLength(101);
    const branchExecutions = await store.listExecutions('fork');
    expect(branchExecutions.filter((execution) => execution.kind !== 'model')).toHaveLength(0);
    expect(branchExecutions.filter((execution) => execution.kind === 'model')).toHaveLength(1);
  } finally {
    client.disposeNetwork();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => relay.close(() => r()));
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
