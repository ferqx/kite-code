import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('HTTP pending inputs preserve mixed original result inclusion and follow-up without replaying the Tool', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-http-pending-inputs-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const ready = gate(),
    release = gate();
  const requests: ModelRequest[] = [];
  let effects = 0;
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const runtime = createRuntime({
    store: new Proxy(store, {
      get(target, key) {
        if (key === 'applyInput')
          return async (input: Parameters<typeof store.applyInput>[0]) => {
            if (input.kind === 'result_include') await release.promise;
            return target.applyInput(input);
          };
        return Reflect.get(target, key);
      },
    }),
    modelId: 'fixed',
    model: {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: 'tool_call', id: 'old-call', name: 'old', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (requests.length === 3) {
          ready.release();
          await release.promise;
        }
        yield { type: 'text_delta', text: 'actual response' };
        yield finish;
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixed' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'old',
            version: '1',
            description: 'original harmless result',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'EXACT OLD RESULT' };
            },
          },
        ],
      },
    ],
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: new URL(`file://${root}/`).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'mixed pending input',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'old-work',
      request: { kind: 'run.start', content: 'produce prior result' },
    });
    await runtime.waitForCommand('old-work', { timeoutMs: 5000 });
    const old = (await store.getView('s')).executions.find(
      (execution) => execution.kind === 'tool',
    )!;
    const selection = await runtime.selectContext({
      ...base,
      commandId: 'rewind',
      expectedContextSelectionId: (await store.getSession('s'))!.contextSelectionId,
      boundary: null,
    });
    service = await startService({
      runtime,
      subjectId: 'owner',
      profile: { dataRoot: join(root, 'data'), name: 'test', accessKey: 'owned' },
      buildId: 'fixed',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        apiMajor: 1,
        profile: service.bootstrap.profile,
        instanceId: service.bootstrap.instanceId,
        buildId: 'fixed',
        requiredCapabilities: ['commands', 'inputs'],
      },
    });
    await client.connect();
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'active-work',
      kind: 'run.start',
      content: 'new exact foreground',
    });
    await ready.promise;
    const run = (await store.getView('s')).runs.find((item) => item.isActive)!;
    const included = await client.includeResult('s', old.id, {
      expectedStoreId,
      commandId: 'include',
      expectedContextSelectionId: selection.selection.id,
      targetRunId: run.id,
      resultRevision: old.resultRevision,
    });
    const content = '完整后继🙂\r\nKeep the exact original result.';
    const followed = await client.followUp('s', {
      expectedStoreId,
      commandId: 'follow',
      kind: 'input.follow_up',
      afterRunId: run.id,
      contextSelectionId: selection.selection.id,
      content,
    });
    expect(included.command.status).toBe('accepted');
    expect(followed.status).toBe('accepted');
    const first = await client.listPendingInputs('s', {
      storeId: expectedStoreId,
      afterSeq: '0',
      limit: 1,
    });
    expect(first.commands).toHaveLength(1);
    expect(first.commands[0]!.id).toBe('include');
    expect(first.commands[0]!.request).toEqual({
      kind: 'result.include',
      expectedContextSelectionId: selection.selection.id,
      executionId: old.id,
      resultRevision: old.resultRevision,
      targetRunId: run.id,
    });
    expect(first.nextAfterSeq).toBe(first.commands[0]!.seq);
    const second = await client.listPendingInputs('s', {
      storeId: expectedStoreId,
      afterSeq: first.nextAfterSeq!,
      limit: 1,
    });
    expect(second.commands).toHaveLength(1);
    expect(second.commands[0]!.id).toBe('follow');
    expect(second.commands[0]!.request).toEqual({
      kind: 'input.follow_up',
      afterRunId: run.id,
      contextSelectionId: selection.selection.id,
      content,
    });
    expect(BigInt(second.commands[0]!.seq)).toBeGreaterThan(BigInt(first.commands[0]!.seq));
    expect(second.nextAfterSeq).toBeNull();
    expect(effects).toBe(1);
    expect(requests).toHaveLength(3);
    release.release();
    await runtime.waitForCommand('active-work', { timeoutMs: 5000 });
    await runtime.waitForCommand('follow', { timeoutMs: 5000 });
    expect(effects).toBe(1);
    expect((await store.getExecution(old.id))!.result).toEqual(old.result);
    expect((await store.getCommand('include'))!.status).toBe('applied');
    expect(
      (await client.listPendingInputs('s', { storeId: expectedStoreId, afterSeq: '0' })).commands,
    ).toHaveLength(0);
  } finally {
    release.release();
    client?.disposeNetwork();
    await service?.close();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
