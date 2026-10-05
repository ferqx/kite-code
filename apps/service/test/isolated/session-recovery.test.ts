import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  createClient,
  decodeSessionRecoveryCommand,
  type RecoverSessionRequest,
} from '@kite-ai/client';
import { startService } from '../../src';

async function bounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('session_recovery_fixture_timeout')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function readyLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = '';
  try {
    while (!text.includes('\n')) {
      const next = await reader.read();
      if (next.done) throw new Error('session_recovery_child_no_ready');
      text += new TextDecoder().decode(next.value);
    }
    return text.split('\n')[0]!;
  } finally {
    reader.releaseLock();
  }
}

for (const mode of ['tool', 'model'] as const)
  test(`actual SIGKILL ${mode} public Session interruption preserves original facts; lost receipt only GETs original identity`, async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-http-session-recovery-'));
    const ledger = join(root, 'effects');
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('../../../../packages/agent/test/isolated/recovery/crash-child.ts', import.meta.url)
          .pathname,
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
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let other: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let relay: ReturnType<typeof createServer> | undefined;
    const sockets = new Set<Socket>();
    let posts = 0,
      gets = 0,
      models = 0;
    try {
      const ready = JSON.parse(await bounded(readyLine(child.stdout))) as {
        storeId: string;
        runId: string;
        owner: { generation: string };
      };
      store = await openSqliteStore(profile);
      runtime = createRuntime({
        store,
        permissions: {
          async authorize() {
            throw new Error('session_interruption_must_not_authorize_effect');
          },
        },
        model: {
          stream() {
            models++;
            throw new Error('session_interruption_must_not_call_model');
          },
        },
      });
      service = await startService({
        runtime,
        profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' },
        subjectId: 'user',
        buildId: 'session-recovery',
      });
      const actual = service;
      const input: RecoverSessionRequest = {
        kind: 'session.recover',
        expectedStoreId: ready.storeId,
        commandId: 'interrupt-original',
        decision: 'interrupt',
      };
      const post = (body: unknown, sessionId = 'crashed', selected = actual) =>
        fetch(`${selected.endpoint}/v1/sessions/${sessionId}/commands`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${selected.bootstrap.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      const frozen = await post(input);
      expect(frozen.status).toBe(409);
      expect(await frozen.json()).toMatchObject({ code: 'owner_busy' });
      expect(await store.getCommand(input.commandId)).toBeNull();
      child.kill('SIGKILL');
      expect(await bounded(child.exited)).toBe(137);
      expect(child.signalCode).toBe('SIGKILL');
      expect(await new Response(child.stderr).text()).toBe('');
      const original = await store.getView('crashed');
      const originalExecution = original.executions[0]!;
      const originalPartial = original.messages.find((message) => message.status === 'incomplete');
      const unrelated = await store.getView('unrelated');
      expect(original.runs.find((run) => run.id === ready.runId)?.isActive).toBe(true);
      expect(originalExecution.status).toBe('dispatching');
      if (mode === 'tool') expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
      else expect(originalPartial?.content).toBe('fixed incomplete '.repeat(4096).slice(0, 4096));
      const initialCursor = (await store.getMetadata()).lastChangeCursor;
      for (const [field, value] of [
        ['owner', 'forged'],
        ['expectedOwnerGeneration', ready.owner.generation],
        ['subjectId', 'forged'],
        ['decision', 'resume'],
      ] as const) {
        const invalid = await post({ ...input, commandId: `bad-${field}`, [field]: value });
        expect(invalid.status).toBe(400);
        expect(await store.getCommand(`bad-${field}`)).toBeNull();
      }
      const wrongStore = await post({
        ...input,
        commandId: 'wrong-store',
        expectedStoreId: 'other',
      });
      expect(wrongStore.status).toBe(409);
      expect(await wrongStore.json()).toMatchObject({ code: 'store_identity_mismatch' });
      other = await startService({
        runtime,
        profile: actual.bootstrap.profile,
        subjectId: 'other-user',
        buildId: 'session-recovery-other',
      });
      const denied = await post({ ...input, commandId: 'wrong-subject' }, 'crashed', other);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'permission_denied' });
      expect((await store.getMetadata()).lastChangeCursor).toBe(initialCursor);
      expect(models).toBe(0);

      relay = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const result = await fetch(`${actual.endpoint}${request.url}`, {
          method: request.method,
          headers: {
            authorization: `Bearer ${actual.bootstrap.token}`,
            'content-type': 'application/json',
          },
          ...(request.method === 'POST' ? { body } : {}),
        });
        const bytes = await result.arrayBuffer();
        if (request.method === 'POST') {
          posts++;
          if (result.status === 202) {
            request.socket.destroy();
            return;
          }
        }
        if (request.url?.startsWith('/v1/commands/')) gets++;
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(Buffer.from(bytes));
      });
      relay.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => relay!.listen(0, '127.0.0.1', resolve));
      client = createClient({
        endpoint: `http://127.0.0.1:${(relay.address() as { port: number }).port}`,
        token: actual.bootstrap.token,
        expected: {
          apiMajor: 1,
          profile: actual.bootstrap.profile,
          instanceId: actual.bootstrap.instanceId,
          buildId: actual.bootstrap.buildId,
          requiredCapabilities: ['commands', 'session_recovery'],
        },
      });
      await client.connect();
      expect(
        await client.recoverSession('crashed', input).catch((error: unknown) => error),
      ).toMatchObject({
        code: 'network_outcome_unknown',
      });
      expect(posts).toBe(1);
      expect(gets).toBe(0);
      const found = decodeSessionRecoveryCommand(await client.getCommand(input.commandId));
      expect(found).toMatchObject({
        id: input.commandId,
        kind: 'session.recover',
        originStoreId: ready.storeId,
        sessionId: 'crashed',
        status: 'applied',
        receipt: {
          kind: 'session_interrupted',
          sessionId: 'crashed',
          storeId: ready.storeId,
          interruptedRunIds: [ready.runId],
          unknownExecutionIds: mode === 'tool' ? [originalExecution.id] : [],
          settledExecutionIds: mode === 'model' ? [originalExecution.id] : [],
          partialMessageIds: mode === 'model' ? [originalPartial!.id] : [],
        },
      });
      expect(Object.keys(found.receipt).sort()).toEqual([
        'cancelledExecutionIds',
        'interruptedRunIds',
        'kind',
        'partialMessageIds',
        'sessionId',
        'settledExecutionIds',
        'snapshotCursor',
        'storeId',
        'unknownExecutionIds',
      ]);
      expect(JSON.stringify(found)).not.toContain('Generation');
      expect(gets).toBe(1);
      expect(posts).toBe(1);
      const persisted = await store.getCommand(input.commandId);
      const generation = (await store.getSession('crashed'))!.ownerGeneration;
      expect(generation).toBe(String(BigInt(ready.owner.generation) + 1n));
      const afterCursor = (await store.getMetadata()).lastChangeCursor;
      const duplicate = await post(input);
      expect(duplicate.status).toBe(202);
      expect(await duplicate.json()).toEqual(found);
      expect(await store.getCommand(input.commandId)).toEqual(persisted);
      expect((await store.getSession('crashed'))!.ownerGeneration).toBe(generation);
      expect((await store.getMetadata()).lastChangeCursor).toBe(afterCursor);
      const crossSession = await post(input, 'unrelated');
      expect(crossSession.status).toBe(409);
      expect(await crossSession.json()).toMatchObject({ code: 'command_conflict' });
      expect((await store.getView('unrelated')).runs).toEqual(unrelated.runs);
      expect((await store.getView('unrelated')).executions).toEqual(unrelated.executions);
      const recovered = await store.getView('crashed');
      expect(recovered.runs.find((run) => run.id === ready.runId)).toMatchObject({
        isActive: false,
        status: 'interrupted',
        reason: 'explicit_recovery_interrupt',
      });
      expect(recovered.executions).toHaveLength(original.executions.length);
      expect(recovered.executions[0]).toMatchObject({
        id: originalExecution.id,
        status: mode === 'tool' ? 'outcome_unknown' : 'failed',
      });
      if (mode === 'tool') expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
      else
        expect(recovered.messages.find((message) => message.id === originalPartial!.id)).toEqual(
          originalPartial,
        );
      expect(models).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      client?.disposeNetwork();
      for (const socket of sockets) socket.destroy();
      if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
      // Both Services share the same test-owned Runtime, whose close is idempotent.
      await other?.close();
      await service?.close();
      await runtime?.close();
      await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
