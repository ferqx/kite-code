import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { openSqliteStore } from '../../../src/sqlite';

test('real Worker finalizes native query and Drizzle statements before success/error ACK and remains usable', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-statement-lifecycle-');
  chmodSync(dataRoot, 0o700);
  const NativeWorker = globalThis.Worker;
  const audits: { observed: number; finalized: boolean; failed: boolean }[] = [];
  class AuditedWorker extends NativeWorker {
    constructor(...args: ConstructorParameters<typeof NativeWorker>) {
      super(new URL('./statement-worker-fixture.ts', import.meta.url).href, args[1]);
      this.addEventListener('message', (event: MessageEvent) => {
        const response = event.data as {
          error?: unknown;
          statementScope?: { observed: number; finalized: boolean };
        };
        if (response.statementScope)
          audits.push({ ...response.statementScope, failed: !!response.error });
      });
    }
  }
  globalThis.Worker = AuditedWorker;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    store = await openSqliteStore({ dataRoot, profile: 'owned' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///owned', name: 'w' });
    await store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'native statement lifecycle',
      subjectId: 'owned',
    });
    const initial = await store.getView('s');
    for (let i = 0; i < 32; i++) {
      expect((await store.getMetadata()).storeId).toBe(expectedStoreId);
      expect((await store.getView('s')).snapshotCursor).toBe(initial.snapshotCursor);
    }
    let rejected: unknown;
    try {
      await store.getView('absent');
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: 'session_not_found' });
    expect((await store.getView('s')).snapshotCursor).toBe(initial.snapshotCursor);
    await store.close();
    store = await openSqliteStore({ dataRoot, profile: 'owned', mode: 'readonly' });
    expect((await store.getView('s')).session.id).toBe('s');
    expect((await store.getMetadata()).storeId).toBe(expectedStoreId);
    await store.close();
    store = undefined;
    expect(audits.length).toBeGreaterThan(64);
    expect(audits.every((audit) => audit.finalized)).toBe(true);
    expect(audits.filter((audit) => audit.observed > 0).length).toBeGreaterThan(64);
    expect(audits.some((audit) => audit.failed && audit.observed > 0)).toBe(true);
  } finally {
    globalThis.Worker = NativeWorker;
    await store?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 10_000);
