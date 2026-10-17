import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '../../../src/sqlite';

for (const busy of [true, false]) {
  test(`statement cleanup failure ${busy ? 'before a BUSY write' : 'after a committed write'} rejects the original request without replay or queue loss`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-writer-cleanup-')));
    const NativeWorker = globalThis.Worker;
    const sent: { id: number; method: string; args: unknown[] }[] = [];
    const received: {
      id: number;
      error?: { code: string };
      fixtureFaults?: number;
      fixtureFinalizations?: number;
    }[] = [];
    class FaultWorker extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof NativeWorker>) {
        super(new URL('./writer-cleanup-worker-fixture.ts', import.meta.url).href, args[1]);
        this.addEventListener('message', (event: MessageEvent) => received.push(event.data));
      }
      override postMessage(message: unknown): void {
        sent.push(message as (typeof sent)[number]);
        super.postMessage(message);
      }
    }
    globalThis.Worker = FaultWorker;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let peer: Database | undefined;
    let held = false;
    try {
      store = await openSqliteStore({ dataRoot: root, profile: 'test' });
      const expectedStoreId = (await store.getMetadata()).storeId;
      await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///w', name: 'w' });
      peer = new Database(join(root, 'test', 'core.db'));
      if (busy) {
        peer.run('BEGIN IMMEDIATE');
        held = true;
      }
      const input = {
        expectedStoreId,
        commandId: 'cleanup-fault',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'user',
        title: 'one real effect',
      };
      const error = await store.createSession(input).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ code: 'fixture_finalize_failed' });
      const request = sent.find(
        (item) =>
          item.method === 'createSession' &&
          (item.args[0] as typeof input).commandId === input.commandId,
      );
      expect(request).toBeDefined();
      expect(received.filter((item) => item.id === request!.id)).toEqual([
        expect.objectContaining({
          id: request!.id,
          error: { code: 'fixture_finalize_failed', message: 'actual statement cleanup fixture' },
          fixtureFaults: 1,
        }),
      ]);
      if (held) {
        peer.run('ROLLBACK');
        held = false;
      }
      expect((await store.getWorkspace('w'))?.id).toBe('w');
      expect((await store.getCommand(input.commandId))?.status ?? null).toBe(
        busy ? null : 'applied',
      );
      expect((await store.getSession('s'))?.id ?? null).toBe(busy ? null : 's');
      const row = peer
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM change_event WHERE type='session.created' AND scope_session_id='s'",
        )
        .get();
      expect(row?.count).toBe(busy ? 0 : 1);
      const sessions = await store.listSessions({});
      expect(sessions.filter((item) => item.id === 's')).toHaveLength(busy ? 0 : 1);
      expect(sent.filter((item) => item.id === request!.id)).toHaveLength(1);
      await store.close();
      store = undefined;
      const close = sent.find((item) => item.method === 'close');
      expect(close).toBeDefined();
      expect(received.find((item) => item.id === close!.id)?.error).toBeUndefined();
      expect(received.at(-1)?.fixtureFaults).toBe(1);
    } finally {
      globalThis.Worker = NativeWorker;
      if (held) peer?.run('ROLLBACK');
      peer?.close(true);
      await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 5000);
}
