import { expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { callerTarget, type TuiCallerIntent } from '@kite-ai/ui/tui';
import { callerDigest, callerRequestDigest, parseCallerIntent } from '../host/caller-intents';
import { openCallerJournal } from '../host/caller-journal';

function fixture() {
  const root = mkdtempSync('/private/tmp/kite-caller-journal-'),
    access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  return {
    access,
    path: join(access.profilePath, 'ui/caller-intents.json'),
    open: () =>
      openCallerJournal({
        access,
        acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
      }),
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function intent(commandId = 'original', content = '原完整🙂e\u0301'): TuiCallerIntent {
  const scope = { storeId: 'store', sessionId: 's', workspaceId: 'w' },
    request = {
      kind: 'run.start' as const,
      expectedStoreId: 'store',
      commandId,
      content,
      extensionInputs: [
        { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
      ],
    };
  return {
    scope,
    request,
    target: callerTarget(scope, request),
    subjectId: 'local-user',
    bodyDigest: callerDigest(request),
    requestDigest: callerRequestDigest(request),
  };
}
test('durable original request and local SHA survive reopen; existing prepared record never grants another submit, old scope and unknown never cleared', () => {
  const f = fixture();
  try {
    const a = f.open();
    expect(a.prepare(intent())).toBe(true);
    a.close();
    const b = f.open();
    expect(b.list()).toEqual([{ intent: intent(), phase: 'submitting' }]);
    expect(b.prepare(intent())).toBe(false);
    expect(() => b.prepare(intent('original', 'different'))).toThrow('caller_intent_conflict');
    expect(() => b.clear(intent())).toThrow('caller_journal_unavailable');
    b.record(intent(), 'unknown');
    b.close();
    expect(f.open().list()).toEqual([{ intent: intent(), phase: 'unknown' }]);
    expect(() => parseCallerIntent({ ...intent(), requestDigest: 'wrong' })).toThrow();
  } finally {
    f.close();
  }
});
test('128 full records are retained and capacity rejects new intent without replacing unknown; only confirmed caller outcome can explicitly clear', () => {
  const f = fixture();
  try {
    const j = f.open();
    for (let i = 0; i < 128; i++) j.prepare(intent(`c-${i}`));
    expect(() => j.prepare(intent('overflow'))).toThrow('caller_intent_limit');
    expect(j.list()).toHaveLength(128);
    j.record(intent('c-0'), 'applied');
    j.clear(intent('c-0'));
    expect(j.prepare(intent('new'))).toBe(true);
    expect(j.list().find((r) => r.intent.request.commandId === 'c-1')?.phase).toBe('submitting');
  } finally {
    f.close();
  }
});
test('complete legal large UTF8 requests are not truncated; 16 MiB byte capacity leaves exact prior bytes; malformed/hardlinked journal is not empty', () => {
  const f = fixture();
  try {
    const j = f.open(),
      large = intent('large', '大正文'.repeat(87000));
    j.prepare(large);
    expect(j.list()[0]?.intent.request).toEqual(large.request);
    expect(readFileSync(f.path).byteLength).toBeGreaterThan(700000);
    let capacity = false;
    for (let i = 0; i < 128; i++) {
      const before = readFileSync(f.path);
      try {
        j.prepare(
          intent(`large-${i}`, large.request.kind === 'run.start' ? large.request.content : ''),
        );
      } catch (error) {
        expect((error as Error).message).toBe('caller_capacity_exceeded');
        expect(readFileSync(f.path).equals(before)).toBe(true);
        capacity = true;
        break;
      }
    }
    expect(capacity).toBe(true);
    expect(j.list()[0]?.intent.request).toEqual(large.request);
    linkSync(f.path, `${f.path}.hard`);
    expect(() => j.list()).toThrow('caller_journal_unavailable');
    rmSync(`${f.path}.hard`);
    writeFileSync(f.path, '{bad tail', { mode: 0o600 });
    expect(() => j.list()).toThrow('caller_journal_unavailable');
    expect(() => j.prepare(intent('new'))).toThrow('caller_journal_unavailable');
  } finally {
    f.close();
  }
});

test('authenticated subject and persistent draft proof retain exact finite public boundaries; changed target or body cannot relabel intent', () => {
  const original = {
    ...intent(),
    subjectId: '主'.repeat(256),
    draft: { id: 'a'.repeat(64), revision: '9223372036854775807', textDigest: 'b'.repeat(64) },
  };
  expect(parseCallerIntent(original)).toEqual(original);
  expect(() => parseCallerIntent({ ...original, subjectId: '主'.repeat(257) })).toThrow();
  for (const revision of ['01', '-1', '9223372036854775808', '1'.repeat(100)])
    expect(() =>
      parseCallerIntent({ ...original, draft: { ...original.draft, revision } }),
    ).toThrow();
  expect(() =>
    parseCallerIntent({ ...original, target: { kind: 'session', id: 'another' } }),
  ).toThrow();
  expect(() =>
    parseCallerIntent({ ...original, request: { ...original.request, content: 'changed' } }),
  ).toThrow();
  expect(() => parseCallerIntent({ ...original, ownerGeneration: '1' })).toThrow();
});
