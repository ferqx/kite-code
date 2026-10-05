import { expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import type { TuiMcpIntent } from '@kite-ai/ui/tui';
import { createMcpSelectionRecord, parseMcpSelectionRecord } from '../host/mcp-selection-intents';
import { openMcpSelectionJournal } from '../host/mcp-selection-journal';

const intent = (commandId = 'original'): TuiMcpIntent => ({
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: 'original-native-workspace',
  request: {
    expectedStoreId: 'store',
    commandId,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.management',
    actionId: 'mcp.server.select',
    definitionVersion: '1',
    input: {
      serverId: 'one',
      enabled: true,
      scope: 'user',
      expectedReadSet: {
        userEtag: 'a'.repeat(64),
        workspaceEtag: null,
        explicitDigest: 'b'.repeat(64),
        registryDigest: 'c'.repeat(64),
        scopeDigest: 'd'.repeat(64),
        registryRevision: '原完整🙂\r\nrevision',
      },
    },
  },
});
function fixture() {
  const root = mkdtempSync('/private/tmp/kite-mcp-journal-'),
    access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  const path = join(access.profilePath, 'ui/mcp-selection-intents.json');
  const open = () =>
    openMcpSelectionJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
  return {
    root,
    access,
    path,
    open,
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('closed complete original selection and subject survive reopen; prepared ID never grants another POST and terminal cannot regress', () => {
  const f = fixture();
  try {
    const record = createMcpSelectionRecord(intent(), 'original-user'),
      a = f.open();
    expect(a.prepare(record)).toBe(true);
    a.close();
    const b = f.open();
    expect(b.list()).toEqual([record]);
    expect(b.prepare(record)).toBe(false);
    expect(() =>
      b.prepare(createMcpSelectionRecord(intent('conflicting-new'), 'original-user')),
    ).toThrow('mcp_original_outcome_required');
    expect(() =>
      b.prepare(
        createMcpSelectionRecord({ ...intent(), workspaceIdentity: 'new-root' }, 'original-user'),
      ),
    ).toThrow('mcp_selection_intent_conflict');
    b.record(record, 'outcome_unknown');
    expect(b.list()[0]!.phase).toBe('outcome_unknown');
    b.record(record, 'pending');
    b.record(record, 'applied');
    expect(() => b.record(record, 'pending')).toThrow();
    expect(readFileSync(f.path, 'utf8')).toContain('原完整🙂');
    b.close();
    expect(() => b.list()).toThrow();
  } finally {
    f.close();
  }
});
test('strict decoder rejects aliases, enum arrays, forged SHA, subject/body changes and forbidden authority fields', () => {
  const original = createMcpSelectionRecord(intent(), 'original-user');
  const bad: unknown[] = [
    { ...original, token: 'secret' },
    { ...original, intent: { ...original.intent, attachmentProof: 'read' } },
    {
      ...original,
      intent: {
        ...original.intent,
        request: {
          ...original.intent.request,
          input: { ...original.intent.request.input, scope: ['user'] },
        },
      },
    },
    {
      ...original,
      intent: {
        ...original.intent,
        request: {
          ...original.intent.request,
          input: { ...original.intent.request.input, enabled: 1 },
        },
      },
    },
    { ...original, subjectId: ['original-user'] },
    { ...original, bodySha256: '0'.repeat(64) },
    {
      ...original,
      intent: {
        ...original.intent,
        request: {
          ...original.intent.request,
          input: {
            ...original.intent.request.input,
            expectedReadSet: {
              ...original.intent.request.input.expectedReadSet,
              registryRevision: 'changed',
            },
          },
        },
      },
    },
  ];
  for (const row of bad) expect(() => parseMcpSelectionRecord(row)).toThrow();
});
test('128 records retain unknown; private corrupted, linked, oversized files and released/copied lease refuse prepare', () => {
  const f = fixture();
  try {
    const a = f.open();
    for (let i = 0; i < 128; i++) {
      const independent = intent(`original-${i}`);
      independent.workspaceId = `w-${i}`;
      independent.request.input.scope = 'workspace';
      independent.request.input.expectedReadSet.workspaceEtag = 'a'.repeat(64);
      a.prepare(createMcpSelectionRecord(independent, 'user'));
    }
    const bytes = readFileSync(f.path);
    expect(() => a.prepare(createMcpSelectionRecord(intent('overflow'), 'user'))).toThrow(
      'mcp_selection_intent_limit',
    );
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(a.list()).toHaveLength(128);
    linkSync(f.path, join(f.root, 'hardlink'));
    expect(() => a.list()).toThrow();
    rmSync(join(f.root, 'hardlink'));
    writeFileSync(f.path, 'broken', { mode: 0o600 });
    expect(() => a.prepare(createMcpSelectionRecord(intent(), 'user'))).toThrow();
    expect(readFileSync(f.path, 'utf8')).toBe('broken');
    writeFileSync(f.path, ' '.repeat(16 * 1024 * 1024 + 1));
    expect(() => a.list()).toThrow();
    const copied = openMcpSelectionJournal({
      access: { ...f.access },
      acquireWriteLock: () => acquireProfileDataLock(f.access, 'tui_private'),
    });
    expect(() => copied.list()).toThrow();
    f.access.lock.release();
    expect(() => a.list()).toThrow();
  } finally {
    f.close();
  }
});
