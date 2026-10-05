import { expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { openRecoveryJournal } from '../host/recovery-journal';
import type { RecoveryIntent } from '../src/recovery';

function fixture() {
  const root = mkdtempSync('/private/tmp/kite-recovery-journal-'),
    access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  const open = () =>
    openRecoveryJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
  return {
    root,
    access,
    open,
    path: join(access.profilePath, 'ui/recovery.json'),
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const intent = (id = 'original'): Extract<RecoveryIntent, { kind: 'run' }> => ({
  kind: 'run',
  sessionId: 's',
  request: {
    kind: 'run.resume',
    expectedStoreId: 'original-store',
    commandId: id,
    runId: 'original-run',
  },
});
test('durable caller journal reopens exact original scope, keeps pending, rejects conflict and shared data lock', () => {
  const f = fixture();
  try {
    const a = f.open();
    expect(a.prepare(intent())).toBe(true);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).records).toEqual([
      { intent: intent(), phase: 'submitting' },
    ]);
    a.close();
    const b = f.open();
    expect(b.list()).toEqual([{ intent: intent(), phase: 'submitting' }]);
    expect(b.prepare(intent())).toBe(false);
    expect(() => b.prepare({ ...intent(), sessionId: 'other' })).toThrow(
      'recovery_intent_conflict',
    );
    expect(() =>
      b.prepare({ ...intent(), request: { ...intent().request, expectedStoreId: 'new-store' } }),
    ).toThrow('recovery_intent_conflict');
    b.record(intent(), 'outcome_unknown');
    const held = acquireProfileDataLock(f.access, 'tui_private');
    try {
      expect(() => b.prepare(intent('new'))).toThrow('recovery_journal_unavailable');
    } finally {
      held.release();
    }
    expect(b.list()).toEqual([{ intent: intent(), phase: 'outcome_unknown' }]);
    b.close();
  } finally {
    f.close();
  }
});
test('128 original pending slots never evict unknown and full journal refuses new publication', () => {
  const f = fixture();
  try {
    const file = f.open();
    for (let i = 0; i < 128; i++) file.prepare(intent(`id-${i}`));
    const bytes = readFileSync(f.path);
    expect(() => file.prepare(intent('overflow'))).toThrow('recovery_intent_limit');
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(file.list()).toHaveLength(128);
    file.close();
  } finally {
    f.close();
  }
});
for (const scenario of ['corrupt', 'unknownVersion', 'hardlink', 'privateField'] as const)
  test(`journal ${scenario} stays unavailable and preserves original bytes`, () => {
    const f = fixture();
    try {
      const file = f.open();
      file.prepare(intent());
      if (scenario === 'corrupt') writeFileSync(f.path, '{broken');
      if (scenario === 'unknownVersion')
        writeFileSync(f.path, JSON.stringify({ version: 9, records: [] }));
      if (scenario === 'hardlink') linkSync(f.path, join(f.root, 'linked'));
      if (scenario === 'privateField')
        writeFileSync(
          f.path,
          JSON.stringify({
            version: 1,
            records: [{ intent: { ...intent(), generation: 5 }, phase: 'submitting' }],
          }),
        );
      const bytes = readFileSync(f.path);
      expect(() => file.list()).toThrow();
      expect(() => file.prepare(intent('new'))).toThrow();
      expect(readFileSync(f.path)).toEqual(bytes);
      file.close();
    } finally {
      f.close();
    }
  });
