import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function eventually(read: () => Promise<boolean>) {
  const until = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > until) throw Error('compression_progress_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(outcome: 'completed' | 'failed' | 'unpublished' = 'completed') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-compression-ui-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const preparing = gate(),
    summarizing = gate(),
    validating = gate();
  let compressionModel = false;
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      if (compressionModel) {
        yield { type: 'text_delta', text: 'original summary' };
        await Promise.race([
          summarizing.promise,
          new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        ]);
      }
      signal.throwIfAborted();
      if (compressionModel && outcome === 'failed') throw Error('owned summary failure');
      if (!compressionModel) yield { type: 'text_delta', text: 'original answer' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    compressor: {
      id: 'actual',
      version: '1',
      async prepare() {
        await preparing.promise;
        compressionModel = true;
        return { instructions: 'SUMMARIZE PRIVATE INPUT', snapshot: {} };
      },
      async validateSummary() {
        await validating.promise;
        return outcome !== 'unpublished';
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'temporary',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'progress',
  });
  await runtime.submitCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'private original request' },
  });
  await runtime.waitForCommand('work');
  const selection = (await runtime.getView('s')).session.contextSelectionId;
  return {
    runtime,
    store,
    storeId,
    base,
    selection,
    profile,
    preparing,
    summarizing,
    validating,
    async close() {
      preparing.release();
      summarizing.release();
      validating.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('actual compression phases are hot readonly facts and clear after normal publication', async () => {
  const f = await fixture();
  try {
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: f.selection,
    });
    await eventually(
      async () => (await f.runtime.getView('s')).compressionProgress?.phase === 'preparing',
    );
    const initial = (await f.runtime.getView('s')).compressionProgress!;
    expect(initial.originStoreId).toBe(f.storeId);
    expect(JSON.stringify(initial)).not.toContain('private');
    expect('compressionProgress' in (await f.store.getView('s'))).toBe(false);
    f.preparing.release();
    await eventually(
      async () => (await f.runtime.getView('s')).compressionProgress?.phase === 'summarizing',
    );
    f.summarizing.release();
    await eventually(
      async () => (await f.runtime.getView('s')).compressionProgress?.phase === 'validating',
    );
    expect((await f.runtime.getView('s')).compressionProgress?.runId).toBe(initial.runId);
    expect(
      (await f.runtime.listMessages('s')).find((message) => message.compression)?.compression
        ?.status,
    ).toBe('unpublished');
    f.validating.release();
    await f.runtime.waitForCommand('compact');
    expect((await f.runtime.getView('s')).compressionProgress).toBeUndefined();
    expect(
      (await f.runtime.listMessages('s')).find((message) => message.compression)?.compression
        ?.status,
    ).toBe('completed');
  } finally {
    await f.close();
  }
});
test('cancelling an actual summary clears its phase and does not retain input in hot observation', async () => {
  const f = await fixture();
  try {
    f.preparing.release();
    await f.runtime.compressContext({
      ...f.base,
      commandId: 'compact',
      expectedContextSelectionId: f.selection,
    });
    await eventually(
      async () => (await f.runtime.getView('s')).compressionProgress?.phase === 'summarizing',
    );
    await eventually(async () =>
      (await f.runtime.listMessages('s')).some(
        (message) => message.compression?.status === 'running',
      ),
    );
    await f.runtime.cancelCommand({ ...f.base, commandId: 'cancel', targetCommandId: 'compact' });
    await f.runtime.waitForCommand('compact');
    expect((await f.runtime.getView('s')).compressionProgress).toBeUndefined();
    expect(
      (await f.store.getView('s')).runs.find((run) => run.originCommandId === 'compact')?.status,
    ).toBe('cancelled');
    expect(
      (await f.runtime.listMessages('s')).find((message) => message.compression)?.compression
        ?.status,
    ).toBe('cancelled');
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(
        (await cold.listMessages('s')).find((message) => message.compression)?.compression?.status,
      ).toBe('cancelled');
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

for (const outcome of ['completed', 'failed', 'unpublished'] as const)
  test(`compression ${outcome} is SQL-proven and remains accurate through a cold readonly Store`, async () => {
    const f = await fixture(outcome);
    try {
      f.preparing.release();
      f.summarizing.release();
      f.validating.release();
      await f.runtime.compressContext({
        ...f.base,
        commandId: 'compact',
        expectedContextSelectionId: f.selection,
      });
      await f.runtime.waitForCommand('compact');
      const messages = await f.runtime.listMessages('s');
      const summary = messages.find((message) => message.compression)!;
      expect(summary.compression).toMatchObject({ trigger: 'manual', status: outcome });
      expect(messages.filter((message) => message.compression)).toHaveLength(1);
      expect(
        messages
          .filter((message) => message.role === 'user')
          .every((message) => !message.compression),
      ).toBe(true);
      const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
      try {
        expect(
          (await cold.listMessages('s')).find((message) => message.id === summary.id)?.compression,
        ).toEqual(summary.compression);
      } finally {
        await cold.close();
      }
    } finally {
      await f.close();
    }
  });
