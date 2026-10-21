import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';

test('real HTTP pending queue reorders original commands and withdraws without cancelling the active Run', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-http-input-queue-')));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: 'file:///fixture' });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 's' });
  const contextSelectionId = (await store.getSession('s'))!.contextSelectionId;
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'original' },
  });
  const owner = (await store.acquireSessionOwner('s', 'fixture'))!;
  const run = await store.startRun({
    expectedStoreId,
    owner,
    commandId: 'work',
    configuration: { modelId: 'fixed' },
  });
  const original = await store.acceptCommand({
    ...base,
    commandId: 'steer',
    request: {
      kind: 'input.steer',
      content: '**完整**\ntext',
      targetRunId: run.id,
      contextSelectionId,
    },
  });
  const follow = await store.acceptCommand({
    ...base,
    commandId: 'follow',
    request: { kind: 'input.follow_up', content: 'later', afterRunId: run.id, contextSelectionId },
  });
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        throw new Error('No Tool authorization permitted');
      },
    },
    model: {
      stream() {
        throw new Error('No Model dispatch permitted');
      },
    },
  });
  const service = await startService({
    runtime,
    buildId: 'queue-fixture',
    subjectId: 'owner',
    profile: { dataRoot: root, name: 'test', accessKey: 'key' },
  });
  const client = createClient({
    ...service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['pending_input_queue'],
    },
  });
  try {
    await client.connect();
    const first = await client.getPendingInputQueue('s', { storeId: expectedStoreId });
    expect(first.commands.map((command) => command.id)).toEqual(['steer', 'follow']);
    const reordered = await client.reorderPendingInputs('s', {
      kind: 'input.reorder',
      expectedStoreId,
      commandId: 'reorder',
      expectedRevision: first.revision,
      commandIds: ['follow', 'steer'],
    });
    expect(reordered.status).toBe('applied');
    const stale = await fetch(`${service.bootstrap.endpoint}/v1/sessions/s/input-queue/reorder`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${service.bootstrap.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'input.reorder',
        expectedStoreId,
        commandId: 'stale-order',
        expectedRevision: first.revision,
        commandIds: ['steer', 'follow'],
      }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('input_queue_changed');
    const page = await client.getPendingInputQueue('s', { storeId: expectedStoreId, limit: 1 });
    expect(page.commands.map((command) => command.id)).toEqual(['follow']);
    const tail = await client.getPendingInputQueue('s', {
      storeId: expectedStoreId,
      afterOrder: page.nextAfterOrder!,
      expectedRevision: page.revision,
    });
    expect(tail.commands.map((command) => command.id)).toEqual(['steer']);
    const withdrawn = await client.withdrawPendingInput('s', {
      kind: 'input.withdraw',
      expectedStoreId,
      commandId: 'withdraw',
      targetCommandId: 'steer',
      expectedRevision: page.revision,
    });
    expect(withdrawn.status).toBe('applied');
    expect((await client.getCommand('withdraw')).id).toBe('withdraw');
    expect(
      (await client.getPendingInputQueue('s', { storeId: expectedStoreId })).commands.map(
        (command) => command.id,
      ),
    ).toEqual(['follow']);
    expect((await store.getRun(run.id))!.isActive).toBe(true);
    expect((await store.getCommand('steer'))!.seq).toBe(original.seq);
    expect((await store.getCommand('follow'))!.seq).toBe(follow.seq);
    for (const query of ['limit=01', 'limit=1e2', 'limit=1&limit=2', 'extra=1']) {
      const response = await fetch(
        `${service.bootstrap.endpoint}/v1/sessions/s/input-queue?storeId=${expectedStoreId}&${query}`,
        { headers: { Authorization: `Bearer ${service.bootstrap.token}` } },
      );
      expect(response.status).toBe(400);
    }
  } finally {
    client.disposeNetwork();
    await service.close();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
