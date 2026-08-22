import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertAgentStateInvariants } from '@kite/agent-kernel';
import { getActivePlanning } from '@kite/runtime-host';
import { restoreState25HostSessionHarnessV1 as restoreState25KernelCoordinatorV1 } from '../../scripts/support/runtime-host-state25';
import { openState25Store4ForTestV1 } from '../../scripts/support/runtime-storage';

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
    const root = mkdtempSync(join(process.cwd(), '.kite-runtime-sigkill-'));
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

      const recovered = restoreState25KernelCoordinatorV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'crash-recovery',
        userId: 'fault-soak',
        workspace: process.cwd(),
        store: openState25Store4ForTestV1(storePath),
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
      expect(() => assertAgentStateInvariants(state)).not.toThrow();
      recovered.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('storage fault waits through a real SQLite writer lock and commits exactly once', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-runtime-busy-'));
    const storePath = join(root, 'runtime.db');
    let blocker: Database | undefined;
    try {
      openState25Store4ForTestV1(storePath).close();
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

      const reopened = openState25Store4ForTestV1(storePath);
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
    const root = mkdtempSync(join(process.cwd(), '.kite-runtime-full-'));
    const storePath = join(root, 'runtime.db');
    try {
      openState25Store4ForTestV1(storePath, { options: { journalMode: 'delete' } }).close();
      const database = new Database(storePath);
      const pageCount = database.query<{ page_count: number }, []>('PRAGMA page_count').get();
      if (!pageCount) throw new Error('Expected SQLite page count');
      database.run(`PRAGMA max_page_count = ${pageCount.page_count}`);
      database.close();

      const store = openState25Store4ForTestV1(storePath, {
        options: {
          journalMode: 'delete',
          faultInjectionMaxPageCount: pageCount.page_count,
        },
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

      const reopened = openState25Store4ForTestV1(storePath, {
        options: { journalMode: 'delete' },
      });
      expect(reopened.loadEventsStrict('sqlite-full')).toEqual([]);
      reopened.close();
      const recovered = restoreState25KernelCoordinatorV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'sqlite-full',
        userId: 'fault-soak',
        workspace: process.cwd(),
        store: openState25Store4ForTestV1(storePath),
      });
      expect(recovered.getState().recoveryState).toEqual({ kind: 'normal' });
      recovered.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
