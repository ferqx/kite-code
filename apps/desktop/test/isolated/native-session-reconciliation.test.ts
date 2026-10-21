import { expect, test } from 'bun:test';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDesktopController, type DesktopSnapshot } from '../../src/controller';

async function readyLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = '';
  try {
    while (!text.includes('\n')) {
      const next = await reader.read();
      if (next.done) throw Error('native_reconciliation_producer_no_ready');
      text += new TextDecoder().decode(next.value);
    }
    return JSON.parse(text.split('\n')[0]!) as { storeId: string; runId: string };
  } finally {
    reader.releaseLock();
  }
}

test('ordinary Native session selection reconciles actual model SIGKILL into public and cold durable facts without replay', async () => {
  const root = realpathSync(temporaryDirectory('kite-native-session-reconciliation-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const producer = Bun.spawn(
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
        TEST_LEDGER: join(root, 'effects'),
        TEST_CRASH_MODE: 'model',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let controller: ReturnType<typeof createDesktopController> | undefined;
  let models = 0,
    effects = 0;
  const snapshots: DesktopSnapshot[] = [],
    errors: unknown[] = [];
  try {
    const ready = await readyLine(producer.stdout);
    store = await openSqliteStore(profile);
    const runtime = createRuntime({
      store,
      model: {
        stream() {
          models++;
          throw Error('native_reconciliation_must_not_call_model');
        },
      },
      permissions: {
        async authorize() {
          effects++;
          throw Error('native_reconciliation_must_not_authorize_effect');
        },
      },
    });
    service = await startService({
      runtime,
      profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' },
      subjectId: 'user',
      buildId: 'native-reconciliation',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        apiMajor: 1,
        profile: service.bootstrap.profile,
        instanceId: service.bootstrap.instanceId,
        buildId: service.bootstrap.buildId,
        requiredCapabilities: ['commands', 'session_reconciliation'],
      },
    });
    await client.connect();
    controller = createDesktopController({
      admittedClient: client,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: (error) => errors.push(error),
      readContextOnSelect: false,
      readActiveCommandOnSelect: false,
    });
    const held = await controller.selectSession('crashed');
    expect(held?.view.runs.find((run) => run.id === ready.runId)?.isActive).toBe(true);
    expect(held?.view.executions.some((execution) => execution.status === 'dispatching')).toBe(
      true,
    );
    const before = await store.getView('crashed');
    const originalCursor = before.snapshotCursor;
    producer.kill('SIGKILL');
    expect(await producer.exited).toBe(137);
    expect(await new Response(producer.stderr).text()).toBe('');
    expect((await client.getView('crashed')).runs.some((run) => run.isActive)).toBe(true);
    expect((await store.getMetadata()).lastChangeCursor).toBe(originalCursor);
    const recovered = await controller.selectSession('crashed');
    expect(recovered?.view.storeId).toBe(ready.storeId);
    expect(recovered?.view.runs.find((run) => run.id === ready.runId)).toMatchObject({
      status: 'interrupted',
      isActive: false,
    });
    expect(
      recovered?.view.executions.find((execution) => execution.id === before.executions[0]!.id),
    ).toMatchObject({ kind: 'model', status: 'failed' });
    expect(
      recovered?.view.executions.filter((execution) =>
        ['dispatching', 'running'].includes(execution.status),
      ),
    ).toHaveLength(0);
    expect(recovered?.view.messages.map((message) => [message.id, message.content])).toEqual(
      before.messages.map((message) => [message.id, message.content]),
    );
    cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    const durable = await cold.getView('crashed');
    expect(durable.runs.find((run) => run.id === ready.runId)).toMatchObject({
      status: 'interrupted',
      isActive: false,
    });
    expect(
      durable.executions.find((execution) => execution.id === before.executions[0]!.id),
    ).toMatchObject({ kind: 'model', status: 'failed' });
    expect(durable.messages).toEqual(before.messages);
    expect(durable.runs.map((run) => run.id)).toEqual(before.runs.map((run) => run.id));
    expect(durable.executions.map((execution) => execution.id)).toEqual(
      before.executions.map((execution) => execution.id),
    );
    const reconciledCursor = durable.snapshotCursor;
    await controller.selectSession('crashed');
    expect((await cold.getMetadata()).lastChangeCursor).toBe(reconciledCursor);
    expect(snapshots).toHaveLength(3);
    expect(errors).toEqual([]);
    expect(models).toBe(0);
    expect(effects).toBe(0);
  } finally {
    if (producer.exitCode === null) {
      producer.kill('SIGKILL');
      await producer.exited;
    }
    await cold?.close();
    controller?.disposeNetwork();
    client?.disposeNetwork();
    await service?.close();
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
