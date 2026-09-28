import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeHostCurrentStateEventTypes } from '@kite-ai/runtime-host';
import {
  openKiteSessionStoreDatabase,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
} from '@kite-ai/runtime-storage-sqlite';
import { createKiteSessionAppServerStorageComposition } from '../../src/bootstrap';
import { createKiteRuntimeObserverHistoryClient } from '../../src/runtime-client/history-adapter';

const GROUP_COUNT = 100;
const EVENTS_PER_SESSION = 205; // Crosses the History adapter's 200-event read page.

test('100 parent and child Session pairs retain complete scoped History under queued reads', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-history-100-parent-child-'));
  const databasePath = join(home, 'kite-session.sqlite');
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  try {
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'history-100-host',
    });
    seedHistory(databasePath);
    const currentEventTypes = runtimeHostCurrentStateEventTypes();
    let sessionLookups = 0;
    let projectedEventPages = 0;
    const history = createKiteRuntimeObserverHistoryClient(
      () => {
        const reader = storage!.openHistoryLogs(currentEventTypes);
        return {
          ...reader,
          getSession(sessionId: string) {
            sessionLookups++;
            return reader.getSession?.(sessionId) ?? null;
          },
          listEvents(request: Parameters<typeof reader.listEvents>[0]) {
            projectedEventPages++;
            return reader.listEvents(request);
          },
        };
      },
      (parent, child) => {
        const reader = storage!.openChildSessionHistoryLogs(parent, child, currentEventTypes);
        return {
          ...reader,
          getSession(sessionId: string) {
            sessionLookups++;
            return reader.getSession?.(sessionId) ?? null;
          },
          listEvents(request: Parameters<typeof reader.listEvents>[0]) {
            projectedEventPages++;
            return reader.listEvents(request);
          },
        };
      },
    );

    const firstPageDurations: number[] = [];
    const warmFirstPageDurations: number[] = [];
    const continuationDurations: number[] = [];
    const scopedPageDurations: number[] = [];
    const sessionIds = Array.from({ length: GROUP_COUNT }, (_, index) => ({
      parent: `parent-${index}`,
      child: `child-${index}`,
    }));
    const startedAt = performance.now();
    for (const { parent, child } of sessionIds) {
      await verifyRead(parent, () => history.loadSession(parent));
      await verifyRead(child, () => history.loadChildSession!(parent, child));
    }
    const sequentialMs = performance.now() - startedAt;
    expect(projectedEventPages).toBe(GROUP_COUNT * 2 * 2);
    expect(sessionLookups).toBe(GROUP_COUNT * 2 * 3);
    const queuedStartedAt = performance.now();
    const queued = await Promise.all(
      sessionIds.flatMap(({ parent, child }) => [
        history.loadSession(parent),
        history.loadChildSession!(parent, child),
      ]),
    );
    const queuedMs = performance.now() - queuedStartedAt;
    expect(queued).toHaveLength(GROUP_COUNT * 2);
    expect(projectedEventPages).toBe(GROUP_COUNT * 2 * 2);
    expect(sessionLookups).toBe(GROUP_COUNT * 2 * 4);

    async function verifyRead(
      sessionId: string,
      firstRead: () => ReturnType<typeof history.loadSession>,
    ): Promise<void> {
      const pageStart = performance.now();
      const reader = sessionId.startsWith('parent-')
        ? storage!.openHistoryLogs(currentEventTypes)
        : storage!.openChildSessionHistoryLogs(
            `parent-${sessionId.slice('child-'.length)}`,
            sessionId,
            currentEventTypes,
          );
      try {
        const firstPage = reader.listEvents({
          sessionId,
          direction: 'forward',
          limit: 100,
        });
        expect(firstPage.entries).toHaveLength(100);
        expect(firstPage.hasMore).toBe(true);
        expect(firstPage.observedLastSequence).toBe(EVENTS_PER_SESSION);
        expect(firstPage.nextCursor).toBe(100);
        const continuation = reader.listEvents({
          sessionId,
          direction: 'forward',
          afterSequence: firstPage.nextCursor,
          beforeSequence: firstPage.observedLastSequence + 1,
          limit: 200,
        });
        expect(continuation.entries).toHaveLength(EVENTS_PER_SESSION - 100);
        expect(continuation.hasMore).toBe(false);
        for (const [index, entry] of [...firstPage.entries, ...continuation.entries].entries()) {
          expect(entry.sessionId).toBe(sessionId);
          expect(entry.sequence).toBe(index + 1);
          expect(entry.event).toMatchObject({
            type: 'user.message_appended',
            messageId: `${sessionId}-message-${index + 1}`,
            content: `${sessionId} message ${index + 1}`,
          });
        }
      } finally {
        reader.close();
      }
      scopedPageDurations.push(performance.now() - pageStart);
      const eventPagesBefore = projectedEventPages;
      const lookupsBefore = sessionLookups;
      const firstStart = performance.now();
      const first = await firstRead();
      firstPageDurations.push(performance.now() - firstStart);
      expect(projectedEventPages - eventPagesBefore).toBe(2);
      expect(sessionLookups - lookupsBefore).toBe(1);
      expect(first.session.sessionId).toBe(sessionId);
      expect(first.session.lastSequence).toBe(EVENTS_PER_SESSION);
      expect(first.records).toHaveLength(EVENTS_PER_SESSION);
      expect(first.records.map((record) => record.sequence)).toEqual(
        Array.from({ length: EVENTS_PER_SESSION }, (_, index) => index + 1),
      );
      expect(JSON.stringify(first.events)).toContain(sessionId);
      const continuationStart = performance.now();
      const pinned = sessionId.startsWith('parent-')
        ? await history.loadSession(sessionId, first.session.lastSequence)
        : await history.loadChildSession!(
            `parent-${sessionId.slice('child-'.length)}`,
            sessionId,
            first.session.lastSequence,
          );
      continuationDurations.push(performance.now() - continuationStart);
      expect(pinned.records).toEqual(first.records);
      expect(projectedEventPages - eventPagesBefore).toBe(2);
      expect(sessionLookups - lookupsBefore).toBe(2);
      const warmFirstStart = performance.now();
      const warmFirst = await firstRead();
      warmFirstPageDurations.push(performance.now() - warmFirstStart);
      expect(warmFirst.records).toEqual(first.records);
      expect(warmFirst.snapshotDigest).toBe(first.snapshotDigest);
      expect(projectedEventPages - eventPagesBefore).toBe(2);
      expect(sessionLookups - lookupsBefore).toBe(3);
    }

    expect(firstPageDurations).toHaveLength(GROUP_COUNT * 2);
    expect(warmFirstPageDurations).toHaveLength(GROUP_COUNT * 2);
    expect(continuationDurations).toHaveLength(GROUP_COUNT * 2);
    expect(scopedPageDurations).toHaveLength(GROUP_COUNT * 2);
    await expect(history.loadSession('child-0')).rejects.toMatchObject({
      code: 'session_not_found',
    });
    await expect(history.loadChildSession!('parent-1', 'child-0')).rejects.toMatchObject({
      code: 'session_not_found',
    });
    const originalChild = await history.loadChildSession!('parent-0', 'child-0');
    const pagesBeforeRewrite = projectedEventPages;
    const rewrite = openKiteSessionStoreDatabase(databasePath);
    try {
      rewrite
        .query('UPDATE runtime_events SET event_json = ? WHERE session_id = ? AND sequence = 1')
        .run(
          JSON.stringify({
            type: 'user.message_appended',
            messageId: 'child-0-message-1',
            content: 'child-0 revised message 1',
          }),
          'child-0',
        );
    } finally {
      rewrite.close(false);
    }
    const revisedChild = await history.loadChildSession!('parent-0', 'child-0');
    expect(projectedEventPages - pagesBeforeRewrite).toBe(2);
    expect(revisedChild.session.lastSequence).toBe(EVENTS_PER_SESSION);
    expect(revisedChild.snapshotDigest).not.toBe(originalChild.snapshotDigest);
    expect(revisedChild.events[0]).toMatchObject({
      type: 'user.message',
      text: 'child-0 revised message 1',
    });
    const unaffectedParent = await history.loadSession('parent-0');
    expect(unaffectedParent.snapshotDigest).toBe(queued[0]?.snapshotDigest);
    expect(projectedEventPages - pagesBeforeRewrite).toBe(2);
    const publicPage = await history.listSessions({ limit: GROUP_COUNT });
    expect(publicPage.entries).toHaveLength(GROUP_COUNT);
    expect(publicPage.entries.every((entry) => entry.sessionId.startsWith('parent-'))).toBe(true);

    // Single-load timings exclude Promise.all construction and microtask wait.
    // Queued requests still execute synchronous SQLite reads on this process.
    console.info(
      `[history-100-parent-child] sessions=${GROUP_COUNT * 2} events=${GROUP_COUNT * 2 * EVENTS_PER_SESSION} ` +
        `sequentialMs=${sequentialMs.toFixed(1)} queuedWarmMs=${queuedMs.toFixed(1)} ` +
        `pages=${formatDurations(scopedPageDurations)} ` +
        `first=${formatDurations(firstPageDurations)} ` +
        `warmFirst=${formatDurations(warmFirstPageDurations)} ` +
        `pinned=${formatDurations(continuationDurations)}`,
    );
  } finally {
    storage?.disposeStorage();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

function seedHistory(databasePath: string): void {
  const database = openKiteSessionStoreDatabase(databasePath);
  try {
    database.run('PRAGMA foreign_keys=ON');
    database
      .query(`INSERT INTO workspaces (
      workspace_id, canonical_path, workspace_identity_digest, project_id,
      workspace_digest, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`)
      .run(
        'history-workspace',
        '/history-workspace',
        `sha256:${'a'.repeat(64)}`,
        'history-project',
        `sha256:${'b'.repeat(64)}`,
        'History workspace',
      );
    const insertSession = database.query(`INSERT INTO runtime_sessions (
      session_id, workspace_id, project_id, workspace_digest, state_schema,
      format_epoch, revision, name, updated_at, run_index_from_revision, parent_session_id
    ) VALUES (?, 'history-workspace', 'history-project', ?, ?, 'history-fixture', 0, ?, 1, 0, ?)`);
    const insertEvent = database.query(`INSERT INTO runtime_events (
      session_id, event_id, sequence, schema_version, event_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`);
    database.run('BEGIN');
    try {
      for (let index = 0; index < GROUP_COUNT; index += 1) {
        const parent = `parent-${index}`;
        const child = `child-${index}`;
        insertSession.run(
          parent,
          `sha256:${'b'.repeat(64)}`,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          parent,
          null,
        );
        insertSession.run(
          child,
          `sha256:${'b'.repeat(64)}`,
          SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
          child,
          parent,
        );
        for (const sessionId of [parent, child]) {
          for (let sequence = 1; sequence <= EVENTS_PER_SESSION; sequence += 1) {
            insertEvent.run(
              sessionId,
              `${sessionId}-event-${sequence}`,
              sequence,
              SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
              JSON.stringify({
                type: 'user.message_appended',
                messageId: `${sessionId}-message-${sequence}`,
                content: `${sessionId} message ${sequence}`,
              }),
              sequence,
            );
          }
        }
      }
      database.run('COMMIT');
    } catch (error) {
      database.run('ROLLBACK');
      throw error;
    }
  } finally {
    database.close(false);
  }
}

function formatDurations(samples: readonly number[]): string {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
  return `p50=${percentile(0.5).toFixed(1)}ms,p95=${percentile(0.95).toFixed(1)}ms,max=${percentile(1).toFixed(1)}ms`;
}
