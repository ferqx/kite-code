import { expect, test } from 'bun:test';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';

async function readyLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = '';
  try {
    while (!text.includes('\n')) {
      const next = await reader.read();
      if (next.done) throw Error('reconciliation_child_no_ready');
      text += new TextDecoder().decode(next.value);
    }
    return JSON.parse(text.split('\n')[0]!);
  } finally {
    reader.releaseLock();
  }
}

for (const mode of ['tool', 'model'] as const)
  test(`explicit SDK reconciliation after actual ${mode} SIGKILL persists original facts without replay`, async () => {
    const root = realpathSync(temporaryDirectory('kite-session-reconciliation-'));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' },
      ledger = join(root, 'effects');
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL(
            '../../../../packages/agent/test/isolated/recovery/crash-child.ts',
            import.meta.url,
          ),
        ),
      ],
      {
        env: {
          ...process.env,
          TEST_DATA_ROOT: profile.dataRoot,
          TEST_LEDGER: ledger,
          TEST_CRASH_MODE: mode,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let other: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let relay: ReturnType<typeof createServer> | undefined;
    const sockets = new Set<Socket>();
    let posts = 0,
      models = 0;
    try {
      const ready = await readyLine(child.stdout);
      store = await openSqliteStore(profile);
      const runtime = createRuntime({
        store,
        permissions: {
          async authorize() {
            throw Error('reconciliation_must_not_authorize');
          },
        },
        model: {
          stream() {
            models++;
            throw Error('reconciliation_must_not_call_model');
          },
        },
      });
      service = await startService({
        runtime,
        profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' },
        subjectId: 'user',
        buildId: 'reconciliation',
      });
      const actual = service;
      const makeClient = (endpoint: string) =>
        createClient({
          endpoint,
          token: actual.bootstrap.token,
          expected: {
            apiMajor: 1,
            profile: actual.bootstrap.profile,
            instanceId: actual.bootstrap.instanceId,
            buildId: actual.bootstrap.buildId,
            requiredCapabilities: ['commands', 'session_reconciliation'],
          },
        });
      client = makeClient(actual.endpoint);
      await client.connect();
      const input = {
        expectedStoreId: ready.storeId as string,
        commandId: 'reconcile-original',
        expectedOwnerGeneration: ready.owner.generation as string,
      };
      const initial = await client.getView('crashed');
      expect(initial.runs.some((run) => run.isActive)).toBe(true);
      const initialCursor = (await store.getMetadata()).lastChangeCursor;
      expect(await client.reconcileSession('crashed', input)).toEqual({
        storeId: ready.storeId,
        sessionId: 'crashed',
        outcome: 'owner_held',
        commandId: null,
        report: null,
      });
      expect(await store.getCommand(input.commandId)).toBeNull();
      expect((await store.getMetadata()).lastChangeCursor).toBe(initialCursor);
      expect((await client.reconcileSessionState('crashed')).runs.some((run) => run.isActive)).toBe(
        true,
      );
      const post = (body: unknown, selected = actual) =>
        fetch(`${selected.endpoint}/v1/sessions/crashed/reconcile`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${selected.bootstrap.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      expect((await post({ ...input, subjectId: 'forged' })).status).toBe(400);
      expect((await post({ ...input, expectedStoreId: 'wrong' })).status).toBe(409);
      expect(
        (
          await post({
            ...input,
            expectedOwnerGeneration: String(BigInt(input.expectedOwnerGeneration) + 1n),
          })
        ).status,
      ).toBe(409);
      other = await startService({
        runtime,
        profile: actual.bootstrap.profile,
        subjectId: 'other-user',
        buildId: 'reconciliation-other',
      });
      expect((await post(input, other)).status).toBe(403);
      child.kill('SIGKILL');
      expect(await child.exited).toBe(137);
      expect(await new Response(child.stderr).text()).toBe('');
      const before = await store.getView('crashed');
      const cursor = (await store.getMetadata()).lastChangeCursor;
      await client.getView('crashed');
      await client.listSessions();
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect((await store.getView('crashed')).runs.some((run) => run.isActive)).toBe(true);
      const unrelated = await store.getView('unrelated');
      const noWork = await client.reconcileSessionState('unrelated');
      expect(noWork.session.id).toBe('unrelated');
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      if (mode === 'model') {
        relay = createServer(async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const forwarded = await fetch(`${actual.endpoint}${request.url}`, {
            method: request.method,
            headers: {
              authorization: `Bearer ${actual.bootstrap.token}`,
              'content-type': 'application/json',
            },
            ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
          });
          const bytes = await forwarded.arrayBuffer();
          if (request.method === 'POST') {
            posts++;
            if (forwarded.ok && posts === 1) {
              request.socket.destroy();
              return;
            }
          }
          response.writeHead(forwarded.status, { 'content-type': 'application/json' });
          response.end(Buffer.from(bytes));
        });
        relay.on('connection', (socket) => {
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) => relay!.listen(0, '127.0.0.1', resolve));
        client.disposeNetwork();
        client = makeClient(`http://127.0.0.1:${(relay.address() as { port: number }).port}`);
        await client.connect();
        const error = await client
          .reconcileSession('crashed', input)
          .catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: 'network_outcome_unknown',
          commandId: input.commandId,
        });
        expect(posts).toBe(1);
        const command = await client.getCommand(input.commandId);
        expect(command.kind).toBe('session.reconcile');
        expect(command.receipt).toMatchObject({
          kind: 'session_reconciled',
          sessionId: 'crashed',
          storeId: ready.storeId,
        });
        expect(command.receipt).not.toHaveProperty('previousGeneration');
        expect(command.receipt).not.toHaveProperty('generation');
        expect(posts).toBe(1);
      } else {
        const updated = await client.reconcileSessionState('crashed');
        expect(updated.runs.find((run) => run.id === ready.runId)?.status).toBe('interrupted');
        expect(updated.runs.some((run) => run.isActive)).toBe(false);
      }
      const after = await store.getView('crashed');
      expect(after.runs.find((run) => run.id === ready.runId)?.status).toBe('interrupted');
      expect(after.runs.some((run) => run.isActive)).toBe(false);
      expect(
        after.executions.filter((item) => ['dispatching', 'running'].includes(item.status)),
      ).toHaveLength(0);
      expect(after.messages).toEqual(before.messages);
      const afterUnrelated = await store.getView('unrelated');
      expect({ ...afterUnrelated, snapshotCursor: unrelated.snapshotCursor }).toEqual(unrelated);
      expect(models).toBe(0);
      if (mode === 'tool') expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
      const doneCursor = (await store.getMetadata()).lastChangeCursor;
      const noOpId = 'reconcile-noop';
      const unchanged = await client.reconcileSession('crashed', {
        expectedStoreId: ready.storeId,
        commandId: noOpId,
        expectedOwnerGeneration: after.session.ownerGeneration,
      });
      expect(unchanged).toEqual({
        storeId: ready.storeId,
        sessionId: 'crashed',
        outcome: 'unchanged',
        commandId: null,
        report: null,
      });
      expect(await store.getCommand(noOpId)).toBeNull();
      await client.reconcileSessionState('crashed');
      expect((await store.getMetadata()).lastChangeCursor).toBe(doneCursor);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      client?.disposeNetwork();
      for (const socket of sockets) socket.destroy();
      if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
      await other?.close();
      await service?.close();
      await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
