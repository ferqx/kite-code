import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import type { AgentClient } from '@kite-ai/client';
import {
  type FileRecoveryIntent,
  parseFileRecoveryIntent,
  planFileRecoveryIntent,
} from '@kite-ai/client/file-recovery-intent';
import { createFileRecoveryPort } from '../host/file-recovery';
import { openFileRecoveryJournal } from '../host/file-recovery-intents';

function fixture() {
  const root = mkdtempSync('/private/tmp/kite-file-recovery-journal-'),
    access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  return {
    access,
    path: join(access.profilePath, 'ui/file-recovery-intents.json'),
    open: () =>
      openFileRecoveryJournal({
        access,
        acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
      }),
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function intent(n = 'one', scope: FileRecoveryIntent['scope'] = 'both') {
  return planFileRecoveryIntent({
    scope,
    subjectId: 'original-subject',
    observation: {
      storeId: 'current-store',
      workspaceId: 'w',
      sessionId: 'fork-current',
      contextSelectionId: 'current-selector',
      boundary: null,
      trigger: { messageId: 'fork-trigger', seq: '1' },
      checkpoint: {
        id: 'a'.repeat(64),
        boundary: {
          storeId: 'original-store',
          workspaceId: 'w',
          sessionId: 'parent-original',
          runId: 'original-run',
          contextSelectionId: 'original-selector',
          messageId: null,
          messageSeq: '0',
          triggerMessageId: 'original-trigger',
          triggerSeq: '1',
        },
        workspace: { device: '1', inode: '2' },
      },
    },
    ...(scope !== 'session' ? { code: { commandId: `code-${n}`, restoreId: `restore-${n}` } } : {}),
    ...(scope !== 'code'
      ? {
          fork: {
            commandId: `fork-${n}`,
            newSessionId: `new-${n}`,
            title: '完整原Fork🙂\r\ne\u0301',
          },
        }
      : {}),
  });
}

test('after durable submitting acknowledgement real observer selector drift produces zero POST and durable unknown', async () => {
  const f = fixture();
  const journal = f.open();
  let selector = 'current-selector',
    posts = 0,
    reads = 0;
  const client = {
    serverInfo: { storeId: 'current-store', subjectId: 'original-subject' },
    async getView() {
      reads++;
      return {
        storeId: 'current-store',
        session: {
          id: 'fork-current',
          rootSessionId: 'fork-current',
          parentSessionId: null,
          deletedAt: null,
          workspaceId: 'w',
          contextSelectionId: selector,
        },
      };
    },
    async invokeExtension() {
      posts++;
      throw Error('must not POST');
    },
    async getCommand() {
      throw Error('original missing');
    },
    async getFileRestoreStatus() {
      throw Error('original missing');
    },
  } as unknown as AgentClient;
  const record = journal.record.bind(journal);
  const observedJournal = {
    ...journal,
    async record(...args: Parameters<typeof record>) {
      await record(...args);
      if (args[2] === 'submitting') selector = 'changed-selector';
      return undefined;
    },
  };
  try {
    const initial = await intent('drift', 'code');
    await journal.prepare(initial);
    const port = createFileRecoveryPort({ client, journal: observedJournal });
    const result = await port.continue(initial);
    expect(result.code!.phase).toBe('unknown');
    expect(posts).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).records[0].code.phase).toBe('unknown');
    await port.continue(result);
    expect(posts).toBe(0);
  } finally {
    journal.close();
    f.close();
  }
});
test('closed journal and foreign Store observer cannot issue a cold mutation', async () => {
  const f = fixture(),
    journal = f.open();
  try {
    const initial = await intent('foreign', 'session');
    await journal.prepare(initial);
    const client = {
      serverInfo: { storeId: 'foreign', subjectId: 'original-subject' },
      async getView() {
        return {
          storeId: 'foreign',
          session: {
            id: 'fork-current',
            rootSessionId: 'fork-current',
            parentSessionId: null,
            deletedAt: null,
            workspaceId: 'w',
            contextSelectionId: 'current-selector',
          },
        };
      },
    } as unknown as AgentClient;
    const port = createFileRecoveryPort({ client, journal });
    expect(await port.lookup(initial)).toEqual(initial);
    await expect(port.continue(initial)).rejects.toThrow('readonly');
    journal.close();
    await expect(port.lookup(initial)).rejects.toThrow();
  } finally {
    journal.close();
    f.close();
  }
});

test('saved completed phases never substitute for fresh original completion proof or change the journal', async () => {
  const f = fixture(),
    journal = f.open();
  try {
    const initial = await intent('completion');
    const completed = await parseFileRecoveryIntent({
      ...initial,
      code: { ...initial.code, phase: 'succeeded' },
      fork: { ...initial.fork, phase: 'succeeded' },
    });
    await journal.prepare(completed);
    const before = readFileSync(f.path);
    const client = {
      serverInfo: { storeId: completed.storeId, subjectId: completed.subjectId },
      getView: async () => ({
        storeId: completed.storeId,
        session: {
          id: completed.sessionId,
          rootSessionId: completed.sessionId,
          parentSessionId: null,
          deletedAt: null,
          workspaceId: completed.workspaceId,
          contextSelectionId: completed.contextSelectionId,
        },
      }),
      getCommand: async () => ({}),
      getFileRestoreStatus: async () => ({
        payload: {
          journal: { phase: 'restored', files: [{ operation: 'restore', state: 'restored' }] },
        },
      }),
    } as unknown as AgentClient;
    await expect(
      createFileRecoveryPort({ client, journal }).readCompletion(completed),
    ).rejects.toThrow('file_recovery_completion_unavailable');
    expect(readFileSync(f.path)).toEqual(before);
    expect((await journal.list())[0]!.code!.phase).toBe('succeeded');
    expect((await journal.list())[0]!.fork!.phase).toBe('succeeded');
  } finally {
    journal.close();
    f.close();
  }
});
