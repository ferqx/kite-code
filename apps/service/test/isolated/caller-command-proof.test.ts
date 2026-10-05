import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import {
  type CallerCommandRequest,
  canonicalCallerCommandRequest,
  createClient,
} from '@kite-ai/client';
import { startService } from '../../src';

test('authenticated original Command proofs match the complete caller request for all five durable caller kinds and GET never redispatches', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-caller-proof-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      requests++;
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      signal.throwIfAborted();
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned-model' };
      },
    },
    resolveRunConfiguration: async () => ({ model, modelId: 'fixed', snapshot: { fixture: true } }),
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: storeId },
    buildId: 'caller-proof-fixture',
    subjectId: 'actual-authenticated-subject',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'inputs'],
    },
  });
  try {
    const connected = await client.connect();
    expect(connected.subjectId).toBe('actual-authenticated-subject');
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'owned',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'proof',
    });
    const content = '原正文 e\u0301\r\n"空格 \\ 路径"'.repeat(3000);
    const start: CallerCommandRequest = {
      commandId: 'original-work',
      expectedStoreId: storeId,
      kind: 'run.start',
      content,
    };
    const originals: CallerCommandRequest[] = [start];
    await client.startRun('s', start);
    const deadline = Date.now() + 5000;
    while (!requests) {
      if (Date.now() > deadline) throw Error('caller_proof_model_deadline');
      await Bun.sleep(5);
    }
    const view = await client.getView('s');
    const run = view.runs.find((candidate) => candidate.isActive)!;
    const modelExecution = view.executions.find((execution) => execution.kind === 'model')!;
    const steer: CallerCommandRequest = {
      expectedStoreId: storeId,
      commandId: 'original-steer',
      kind: 'input.steer',
      content: '精确原 Run \r\n',
      targetRunId: run.id,
      contextSelectionId: view.session.contextSelectionId,
    };
    originals.push(steer);
    await client.steer('s', steer);
    const follow: CallerCommandRequest = {
      expectedStoreId: storeId,
      commandId: 'original-follow',
      kind: 'input.follow_up',
      content: '完整排队正文 e\u0301',
      afterRunId: run.id,
      contextSelectionId: view.session.contextSelectionId,
    };
    originals.push(follow);
    await client.followUp('s', follow);
    const cancel: CallerCommandRequest = {
      expectedStoreId: storeId,
      commandId: 'cancel-original-follow',
      kind: 'command.cancel',
      targetCommandId: follow.commandId,
    };
    originals.push(cancel);
    await client.cancelCommand('s', cancel);
    const stop: CallerCommandRequest = {
      expectedStoreId: storeId,
      commandId: 'stop-original-execution',
      kind: 'execution.cancel',
      executionId: modelExecution.id,
    };
    originals.push(stop);
    await client.cancelExecution('s', stop);
    await runtime.waitForCommand(start.commandId, { timeoutMs: 5000 });
    await runtime.waitForCommand(steer.commandId, { timeoutMs: 5000 });
    const settledBy = Date.now() + 5000;
    while (
      runtime.getLifecycleState().busy ||
      (await store.getSession('s'))!.ownerInstanceId !== null
    ) {
      if (Date.now() > settledBy) throw Error('caller_proof_settlement_deadline');
      await Bun.sleep(5);
    }
    const cursor = (await store.getMetadata()).lastChangeCursor;
    for (const input of originals) {
      const original = (await store.getCommand(input.commandId))!;
      const publicCommand = await client.getCommand(input.commandId);
      const digest = createHash('sha256')
        .update(canonicalCallerCommandRequest(input))
        .digest('hex');
      expect(publicCommand.requestDigest).toBe(digest);
      expect(publicCommand.requestDigest).toBe(original.requestDigest);
      expect(publicCommand.subjectId).toBe(connected.subjectId);
      expect(publicCommand.originStoreId).toBe(storeId);
      expect(publicCommand.sessionId).toBe('s');
      expect(publicCommand.kind).toBe(input.kind);
      expect(publicCommand).not.toHaveProperty('request');
      expect(publicCommand).not.toHaveProperty('ownerGeneration');
      expect(await client.getCommand(input.commandId)).toEqual(publicCommand);
    }
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(requests).toBe(1);
    expect((await store.getView('s')).runs).toHaveLength(1);
    expect((await store.getCommand(start.commandId))!.request).toEqual({
      kind: 'run.start',
      content,
    });
    expect(() =>
      canonicalCallerCommandRequest({
        ...start,
        ownerGeneration: 'forged',
      } as CallerCommandRequest),
    ).toThrow();
  } finally {
    release();
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
