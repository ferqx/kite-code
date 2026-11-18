import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { binding } from './image-observer-crash-fixture';

async function until(fn: () => Promise<boolean>) {
  const end = Date.now() + 20000;
  while (!(await fn())) {
    if (Date.now() > end) throw Error('cold_frontier_timeout');
    await Bun.sleep(15);
  }
}
test('planned observer SIGKILL keeps original ID, cold read does not dispatch, explicit resume runs business', async () => {
  const dir = temporaryDirectory('kite-observer-cold-');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'image-observer-crash-fixture.ts'), dir],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    const stderr = new Response(child.stderr as ReadableStream).text();
    try {
      await until(async () => existsSync(join(dir, 'ready.json')));
    } catch (e) {
      child.kill('SIGKILL');
      await child.exited;
      throw Error(String(e) + ' ' + (await stderr));
    }
    const ready = JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8'));
    expect(ready.execution.status).toBe('planned');
    child.kill('SIGKILL');
    await child.exited;
    expect(await stderr).toBe('');
    const callsBefore = readFileSync(join(dir, 'calls'), 'utf8');
    const effects = readFileSync(join(dir, 'effects'), 'utf8');
    const profile = { dataRoot: join(dir, 'data'), profile: 'test' };
    reader = await openSqliteStore({ ...profile, mode: 'readonly' });
    await reader.getView('s');
    expect((await reader.getExecution(ready.execution.id))?.status).toBe('planned');
    await reader.close();
    reader = undefined;
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toBe(callsBefore);
    store = await openSqliteStore(profile);
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      permissions: binding(dir).permissions!,
      resolveRecoveryRunConfiguration: async () => binding(dir),
    });
    try {
      await runtime.resumeRun({
        expectedStoreId: ready.expectedStoreId,
        runId: ready.runId,
        expectedOwnerGeneration: ready.expectedOwnerGeneration,
        subjectId: 'owner',
        sessionId: 's',
        commandId: 'resume',
      });
      await until(async () => !(await store!.getRun(ready.runId))!.isActive);
      const run = await store.getRun(ready.runId);
      expect(run?.status).toBe('completed');
      const calls = readFileSync(join(dir, 'calls'), 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x));
      expect(calls.filter((x) => x.id === ready.execution.id)).toHaveLength(1);
      expect(calls.find((x) => x.id === ready.execution.id).tools).toEqual([]);
      expect(calls.at(-1).tools).toContain('view_images');
      expect(readFileSync(join(dir, 'effects'), 'utf8')).toBe(effects);
      const view = await store.getView('s');
      expect(view.messages.some((m) => m.content === 'private observer note')).toBe(false);
      expect(view.messages.some((m) => m.content === 'final business answer')).toBe(true);
    } finally {
      await runtime.close();
      runtime = undefined;
      store = undefined;
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    try {
      await reader?.close();
    } finally {
      try {
        if (runtime) await runtime.close();
        else await store?.close();
      } finally {
        removeTemporaryDirectory(dir);
      }
    }
    expect(existsSync(dir)).toBe(false);
  }
}, 30000);
