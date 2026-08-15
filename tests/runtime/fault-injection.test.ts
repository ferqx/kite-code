import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRuntimeStateInvariants } from '@/core/runtime/invariants';
import { createAgentKernel } from '@/core/runtime/kernel';
import { getActivePlanning } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

const childFixture = join(import.meta.dir, '..', 'fixtures', 'runtime-fault-soak-child.ts');

async function waitForMarker(
  stream: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs = 5000,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}`)), timeoutMs);
  });
  const read = (async () => {
    while (!output.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Child exited before ${marker}: ${output}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
  })();
  try {
    await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

async function waitForExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 7000): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([proc.exited, timeout]);
  if (timer) clearTimeout(timer);
  if (result === 'timeout') {
    proc.kill('SIGKILL');
    await proc.exited.catch(() => {});
    throw new Error(`Child did not exit within ${timeoutMs}ms`);
  }
  return result;
}

describe('Runtime production fault injection', () => {
  test('abrupt process termination preserves intent, Plan, Verification, and unknown dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-runtime-sigkill-'));
    const storePath = join(root, 'runtime.db');
    try {
      const proc = Bun.spawn([process.execPath, childFixture, 'crash-state', storePath], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'inherit',
      });
      await waitForMarker(proc.stdout, 'READY_TO_KILL');
      proc.kill('SIGKILL');
      await proc.exited;

      const recovered = createAgentKernel({
        threadId: 'crash-recovery',
        userId: 'fault-soak',
        workspace: process.cwd(),
        storePath,
      });
      const state = recovered.getState();
      expect(state.resourceBudget).toMatchObject({
        status: 'active',
        reservations: { 'fault-reservation': { state: 'unknown' } },
      });
      expect(getActivePlanning(state).kind).toBe('awaiting_review');
      expect(state.verification.records['crash-verification']).toMatchObject({
        mode: 'required',
        status: 'pending',
      });
      expect(() => assertRuntimeStateInvariants(state)).not.toThrow();
      recovered.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('storage fault waits through a real SQLite writer lock and commits exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-runtime-busy-'));
    const storePath = join(root, 'runtime.db');
    let blocker: Database | undefined;
    try {
      createRuntimeStore(storePath).close();
      blocker = new Database(storePath);
      blocker.run('BEGIN IMMEDIATE');
      const proc = Bun.spawn([process.execPath, childFixture, 'append-event', storePath], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'inherit',
      });
      await waitForMarker(proc.stdout, 'ATTEMPTING');
      const prematureExit = await Promise.race([
        proc.exited.then((code) => ({ exited: true as const, code })),
        Bun.sleep(150).then(() => ({ exited: false as const })),
      ]);
      expect(prematureExit).toEqual({ exited: false });
      blocker.run('COMMIT');
      blocker.close();
      blocker = undefined;
      expect(await waitForExit(proc)).toBe(0);

      const reopened = createRuntimeStore(storePath);
      expect(reopened.loadEventsStrict('sqlite-busy')).toHaveLength(1);
      reopened.close();
    } finally {
      try {
        blocker?.run('ROLLBACK');
      } catch {
        // The transaction may already be closed.
      }
      blocker?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('storage fault rolls back an injected SQLite full write without corrupting recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-runtime-full-'));
    const storePath = join(root, 'runtime.db');
    try {
      createRuntimeStore(storePath, { journalMode: 'delete' }).close();
      const database = new Database(storePath);
      const pageCount = database.query<{ page_count: number }, []>('PRAGMA page_count').get();
      if (!pageCount) throw new Error('Expected SQLite page count');
      database.run(`PRAGMA max_page_count = ${pageCount.page_count}`);
      database.close();

      const store = createRuntimeStore(storePath, {
        journalMode: 'delete',
        faultInjectionMaxPageCount: pageCount.page_count,
      });
      expect(() =>
        store.appendEvents('sqlite-full', [
          {
            type: 'user.message_appended',
            messageId: 'too-large',
            content: 'x'.repeat(1024 * 1024),
          },
        ]),
      ).toThrow(/database or disk is full/i);
      store.close();

      const reopened = createRuntimeStore(storePath, { journalMode: 'delete' });
      expect(reopened.loadEventsStrict('sqlite-full')).toEqual([]);
      reopened.close();
      const recovered = createAgentKernel({
        threadId: 'sqlite-full',
        userId: 'fault-soak',
        workspace: process.cwd(),
        storePath,
      });
      expect(recovered.getState().recoveryState).toEqual({ kind: 'normal' });
      recovered.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
