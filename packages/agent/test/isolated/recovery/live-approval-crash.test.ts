import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import type { Json } from '../../../src/storage/types';
import { approvalBinding, changeMode } from './live-approval-crash-fixture';

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('approval_crash_fixture_timeout')), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function firstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw Error('approval_crash_early_exit');
      text += new TextDecoder().decode(next.value);
      if (text.length > 16384) throw Error('approval_crash_invalid_output');
      if (text.includes('\n')) return text.split('\n')[0]!;
    }
  } finally {
    reader.releaseLock();
  }
}
test('SIGKILL pending approval preserves cold observation and explicit recovery dispatches once under the current root mode revision', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-live-approval-kill-')));
  writeFileSync(join(root, 'ledger'), '');
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./live-approval-crash-fixture.ts', import.meta.url)),
      root,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let store: Store | undefined, runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const ready = JSON.parse(await bounded(firstLine(child.stdout))) as {
      storeId: string;
      runId: string;
      executionId: string;
      interactionId: string;
      interactionRevision: string;
      expectedOwnerGeneration: string;
    };
    expect(child.exitCode).toBeNull();
    child.kill('SIGKILL');
    expect(await bounded(child.exited)).toBe(137);
    expect(child.signalCode).toBe('SIGKILL');
    expect(await new Response(child.stderr).text()).toBe('');
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const ledger = () =>
      readFileSync(join(root, 'ledger'), 'utf8').trim().split('\n').filter(Boolean);
    const before = ledger();
    expect(before).toHaveLength(1);
    expect(before[0]).toStartWith('model:');
    let savedRequest: Json | undefined, savedSource: Json | undefined;
    const observer = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      const cursor = (await observer.getMetadata()).lastChangeCursor;
      expect((await observer.getExecution(ready.executionId))!.status).toBe('planned');
      expect((await observer.getRun(ready.runId))!.isActive).toBe(true);
      const card = await observer.getInteraction({
        expectedStoreId: ready.storeId,
        sessionId: 's',
        interactionId: ready.interactionId,
      });
      savedRequest = structuredClone(card!.request);
      savedSource = structuredClone(card!.source);
      expect(card).toMatchObject({
        state: 'pending',
        revision: ready.interactionRevision,
        answer: null,
      });
      expect((await observer.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(ledger()).toEqual(before);
    } finally {
      await observer.close();
    }
    store = await openSqliteStore(profile);
    const current = await changeMode(store, ready.storeId, 'full');
    let resolves = 0;
    const acceptedReads: unknown[] = [];
    const actual = store;
    const wrapped = new Proxy(actual, {
      get(target, key) {
        if (key === 'markDispatching')
          return async (input: Parameters<Store['markDispatching']>[0]) => {
            const value = await target.markDispatching(input);
            if (input.executionId === ready.executionId) acceptedReads.push(input.authorization);
            return value;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const binding = approvalBinding(wrapped, ready.storeId, root);
    runtime = createRuntime({
      store: wrapped,
      permissions: binding.permissions!,
      artifacts: createArtifactStore({ profile, store: wrapped }),
      resolveRecoveryRunConfiguration: async () => {
        resolves++;
        return approvalBinding(wrapped, ready.storeId, root);
      },
    });
    const coldCursor = (await store.getMetadata()).lastChangeCursor;
    await runtime.getView('s');
    expect(resolves).toBe(0);
    expect(ledger()).toEqual(before);
    expect((await store.getMetadata()).lastChangeCursor).toBe(coldCursor);
    const input = {
      expectedStoreId: ready.storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'resume',
      runId: ready.runId,
      expectedOwnerGeneration: ready.expectedOwnerGeneration,
    };
    let denied: unknown;
    try {
      await runtime.resumeRun({ ...input, commandId: 'foreign-resume', subjectId: 'other' });
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeTruthy();
    expect(await store.getCommand('foreign-resume')).toBeNull();
    expect(resolves).toBe(0);
    expect(ledger()).toEqual(before);
    await runtime.resumeRun(input);
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect((await store.getExecution(ready.executionId))!.status).toBe('succeeded');
    expect((await store.getRun(ready.runId))!.status).toBe('completed');
    expect(acceptedReads).toHaveLength(1);
    expect(acceptedReads[0]).toMatchObject({
      allowed: true,
      controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: current.revision }],
    });
    const old = await store.getInteraction({
      expectedStoreId: ready.storeId,
      sessionId: 's',
      interactionId: ready.interactionId,
    });
    expect(old).toMatchObject({ state: 'cancelled', acceptedDecisionRevision: null });
    expect(old?.answer).toBeNull();
    expect(old?.request).toEqual(savedRequest);
    expect(old?.source).toEqual(savedSource);
    expect(resolves).toBe(1);
    await runtime.resumeRun(input);
    expect(ledger().filter((line) => line.startsWith('effect:'))).toEqual([
      `effect:${ready.executionId}:{"value":"exact"}`,
    ]);
    expect(ledger().filter((line) => line.startsWith('model:'))).toHaveLength(2);
    const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), { readonly: true });
    try {
      const invalidations = db
        .query("SELECT request_json,receipt_json FROM command WHERE kind='interaction.invalidate'")
        .all() as { request_json: string; receipt_json: string }[];
      expect(invalidations).toHaveLength(1);
      expect(JSON.parse(invalidations[0]!.receipt_json)).toMatchObject({
        interactionId: ready.interactionId,
        reason: 'permission_policy_changed',
      });
      expect(JSON.parse(invalidations[0]!.request_json)).toMatchObject({
        interactionId: ready.interactionId,
        previousRevision: ready.interactionRevision,
        controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: current.revision }],
      });
    } finally {
      db.close();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await runtime?.close();
    await store?.close();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});
