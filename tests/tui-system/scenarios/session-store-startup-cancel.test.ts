import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import {
  activateSessionSearch,
  submitCommand,
  submitUserMessage,
  typeText,
} from '../harness/input-helpers';
import { type PtyProcess, spawnPreInkTui, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  screenHasSessionRow,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace, observePersistedUserMessageSession } from '../harness/test-workspace';

/**
 * D08 excludes old Store 11 conversion and its 512MiB copying fixture. Preserve
 * the original interrupted-startup user journey using the actual selected
 * Profile's maintenance exclusion: no history publication is needed or allowed.
 */
const holderFixture = join(import.meta.dir, '../fixtures/session-store-maintenance-holder.ts');

function digest(path: string): string {
  const fd = openSync(path, 'r'),
    hash = createHash('sha256'),
    bytes = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, bytes);
      if (!count) break;
      hash.update(bytes.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

describe('TUI PTY System — current Profile startup cancellation (original Store 11 journey)', () => {
  test('Ctrl+C in pre-Ink preparation settles safely and the original Session reopens', async () => {
    const workspace = createTestWorkspace();
    const server = createMockModelServer();
    const tuis: Array<PtyProcess | undefined> = [];
    let holder: ReturnType<typeof Bun.spawn> | undefined;
    try {
      server.setResponses([
        { message: { content: 'Historical answer survives startup cancellation.' } },
      ]);
      const first = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      tuis.push(first);
      await submitUserMessage(first, server, 'Question before startup cancellation');
      await waitForText(
        () => first.outputSinceLastAction(),
        'Historical answer survives startup cancellation.',
        15_000,
      );
      let originalId: string | undefined;
      await waitForCondition(
        () => {
          const observed = observePersistedUserMessageSession(
            workspace,
            'Question before startup cancellation',
          );
          if (observed.status !== 'ready' || !observed.value) return false;
          originalId = observed.value.threadId;
          return true;
        },
        'original user event persisted',
        10_000,
      );
      await submitCommand(first, '/session rename Question before startup cancellation');
      if (!originalId) throw new Error('Original Session ID was not persisted.');
      const sessionId = originalId;
      await submitCommand(first, '/exit');
      expect(await first.waitForExit()).toBe(0);

      const canonical = workspace.databasePath;
      const originalDigest = digest(canonical);
      let originalSessionIds: { id: string }[];
      {
        using db = new Database(canonical, { readonly: true });
        originalSessionIds = db
          .query<{ id: string }, []>('SELECT id FROM session ORDER BY id')
          .all();
      }
      expect(originalSessionIds).toContainEqual({ id: sessionId });
      const readyPath = join(workspace.home, 'startup-cancel-maintenance-ready');
      holder = Bun.spawn(
        [process.execPath, holderFixture, workspace.dataRoot, workspace.profile, readyPath],
        { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
      );
      await waitForCondition(
        () => existsSync(readyPath),
        'independent Profile maintenance owner',
        5_000,
      );
      server.setResponses([]);
      const preparing = await spawnPreInkTui(
        { cols: 120, rows: 40, mockServer: server, workspace },
        'waiting_for_store_start',
        10_000,
      );
      tuis.push(preparing);
      // Canonical-mode Ctrl+C cancels this startup, not the independent owner.
      preparing.write('\x03');
      await waitForCondition(
        () => preparing.exited,
        'TUI parent to exit after startup Ctrl+C',
        20_000,
      );
      expect([0, 1]).toContain(await preparing.waitForExit());
      expect(holder.exitCode).toBeNull();
      expect(() =>
        acquireProfileAccess({ dataRoot: workspace.dataRoot, profile: workspace.profile }),
      ).toThrow('busy');
      expect(digest(canonical)).toBe(originalDigest);
      {
        using db = new Database(canonical, { readonly: true });
        expect(
          db.query<{ format_major: number }, []>('SELECT format_major FROM storage_meta').get()
            ?.format_major,
        ).toBe(1);
        expect(db.query<{ id: string }, []>('SELECT id FROM session ORDER BY id').all()).toEqual(
          originalSessionIds,
        );
        expect(
          db
            .query<{ n: number }, [string]>('SELECT count(*) AS n FROM message WHERE session_id=?')
            .get(sessionId)?.n,
        ).toBe(2);
      }
      if (!holder.stdin || typeof holder.stdin === 'number')
        throw new Error('Missing owned holder input.');
      holder.stdin.write('release\n');
      await holder.stdin.flush();
      expect(await holder.exited).toBe(0);

      server.setResponses([]);
      const restarted = await spawnReadyTui({
        cols: 120,
        rows: 40,
        mockServer: server,
        workspace,
      });
      tuis.push(restarted);
      await submitCommand(restarted, '/resume');
      await waitForCondition(
        () =>
          screenHasSessionRow(restarted.viewport(), 'Question before startup cancellation', {
            active: false,
          }),
        'historical Session row after interrupted startup',
        15_000,
      );
      await activateSessionSearch(restarted);
      await typeText(restarted, 'Question before startup cancellation');
      restarted.write('\x1b[B');
      await waitForCondition(
        () =>
          screenHasSessionRow(restarted.viewport(), 'Question before startup cancellation', {
            selected: true,
            active: false,
          }),
        'historical Session selection',
        5_000,
      );
      restarted.write('\r');
      await waitForCondition(
        () =>
          screenContains(
            restarted.viewport(),
            'Historical answer survives startup cancellation.',
          ) && screenContains(restarted.viewport(), 'Question before startup cancellation'),
        'original conversation replay',
        15_000,
      );
      const db = new Database(canonical, { readonly: true });
      try {
        expect(db.query<{ id: string }, []>('SELECT id FROM session').all()).toContainEqual({
          id: sessionId,
        });
      } finally {
        db.close();
      }
    } catch (error) {
      console.error('Current Profile startup cancellation failed:', error);
      throw error;
    } finally {
      if (holder?.exitCode === null) holder.kill('SIGTERM');
      if (holder) await holder.exited;
      await cleanupTuiSystemFixtures({ tuis, mockServers: [server], workspaces: [workspace] });
    }
  }, 180_000);
});
