import { expect, test } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import {
  type FileRecoveryIntent,
  planFileRecoveryIntent,
} from '@kite-ai/client/file-recovery-intent';
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
test('both complete original legs and identities survive fsync/reopen; unknown is retained and never an execution permit', async () => {
  const f = fixture();
  try {
    const original = await intent(),
      j = f.open();
    expect(await j.prepare(original)).toBe(true);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(f.path);
    j.close();
    const cold = f.open();
    expect(await cold.list()).toEqual([original]);
    expect(await cold.prepare(original)).toBe(false);
    expect(readFileSync(f.path)).toEqual(bytes);
    await cold.record(original, 'code', 'prepared');
    await cold.record(original, 'code', 'submitting');
    await cold.record(original, 'code', 'unknown');
    cold.close();
    const rows = await f.open().list();
    expect(rows[0]!.code!.phase).toBe('unknown');
    expect(rows[0]!.fork!.phase).toBe('not_started');
    expect(rows[0]!.checkpoint.boundary.sessionId).toBe('parent-original');
    expect(rows[0]!.checkpoint.boundary.storeId).toBe('original-store');
    expect(rows[0]!.fork!.request.newSessionId).toBe('new-one');
    expect(rows[0]!.fork!.request.title).toBe('完整原Fork🙂\r\ne\u0301');
  } finally {
    f.close();
  }
});
test('full SHA/closed shape/body drift and cross-leg global command collisions preserve original bytes', async () => {
  const f = fixture();
  try {
    const original = await intent(),
      j = f.open();
    await j.prepare(original);
    const before = readFileSync(f.path);
    const changed = structuredClone(original);
    changed.fork!.request.title = 'different';
    await expect(j.prepare(changed)).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(before);
    const collision = await intent('two');
    const forged = structuredClone(collision);
    forged.code!.request.commandId = original.fork!.request.commandId;
    // commandId is separately bound by full canonical intent; its request SHA excludes transport IDs.
    await expect(j.prepare(forged)).rejects.toThrow('file_recovery_intent_conflict');
    expect(readFileSync(f.path)).toEqual(before);
    await expect(
      j.prepare({ ...original, unexpected: true } as FileRecoveryIntent),
    ).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(before);
    await j.record(original, 'code', 'succeeded');
    await expect(j.record(original, 'code', 'unknown')).rejects.toThrow();
    expect((await j.list())[0]!.code!.phase).toBe('succeeded');
  } finally {
    f.close();
  }
});
test('torn UTF8/JSON, duplicate IDs, hardlink and symlink are never treated as empty journal', async () => {
  const f = fixture();
  try {
    const original = await intent(),
      j = f.open();
    await j.prepare(original);
    j.close();
    const before = readFileSync(f.path);
    writeFileSync(f.path, Buffer.from([0xff]), { mode: 0o600 });
    await expect(f.open().list()).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(Buffer.from([0xff]));
    writeFileSync(f.path, '{"version":1,"records":[', { mode: 0o600 });
    await expect(f.open().list()).rejects.toThrow();
    writeFileSync(f.path, JSON.stringify({ version: 1, records: [original, original] }), {
      mode: 0o600,
    });
    await expect(f.open().list()).rejects.toThrow();
    writeFileSync(f.path, before, { mode: 0o600 });
    const alias = `${f.path}.hardlink`;
    linkSync(f.path, alias);
    await expect(f.open().list()).rejects.toThrow();
    rmSync(alias);
    rmSync(f.path);
    symlinkSync(alias, f.path);
    await expect(f.open().list()).rejects.toThrow();
    rmSync(f.path);
    writeFileSync(f.path, before, { mode: 0o600 });
    expect(await f.open().list()).toEqual([original]);
  } finally {
    f.close();
  }
});
test('128 intent capacity retains unknown without eviction; oversize physical asset and closed owner refuse reads', async () => {
  const f = fixture();
  try {
    const j = f.open();
    const records = [];
    for (let n = 0; n < 128; n++) records.push(await intent(`c${n}`, 'code'));
    mkdirSync(join(f.path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(f.path, `${JSON.stringify({ version: 1, records })}\n`, { mode: 0o600 });
    const before = readFileSync(f.path);
    await expect(j.prepare(await intent('overflow'))).rejects.toThrow(
      'file_recovery_journal_limit',
    );
    expect(readFileSync(f.path)).toEqual(before);
    writeFileSync(f.path, Buffer.alloc(16 * 1024 * 1024 + 1, 32), { mode: 0o600 });
    await expect(j.list()).rejects.toThrow();
    j.close();
    await expect(j.list()).rejects.toThrow('file_recovery_journal_unavailable');
  } finally {
    f.close();
  }
});

test('shared actual private-data lock denies publication and released lock permits exact original save', async () => {
  const f = fixture();
  try {
    const original = await intent();
    // The original ProfileAccess is held by fixture; a real data lock is shared with other UI journals.
    const lock = acquireProfileDataLock(f.access, 'tui_private');
    try {
      await expect(f.open().prepare(original)).rejects.toThrow();
    } finally {
      lock.release();
    }
    expect(await f.open().prepare(original)).toBe(true);
  } finally {
    f.close();
  }
});
