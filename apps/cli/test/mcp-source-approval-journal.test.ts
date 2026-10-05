import { expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import type { TuiMcpSourceApprovalIntent } from '@kite-ai/ui/tui';
import { mcpSha } from '../host/mcp-selection-intents';
import {
  createMcpSourceApprovalRecord,
  parseMcpSourceApprovalRecord,
} from '../host/mcp-source-approval-intents';
import { openMcpSourceApprovalJournal } from '../host/mcp-source-approval-journal';

const sha = 'a'.repeat(64);
const intent = (commandId = 'original'): TuiMcpSourceApprovalIntent => ({
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: 'canonical-workspace-🙂',
  request: {
    expectedStoreId: 'store',
    commandId,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId: 'mcp.source.approve',
    definitionVersion: '1',
    input: {
      serverId: `mcp-${sha}`,
      expectedReadSet: {
        scopeDigest: sha,
        user: {
          identity: { kind: 'user', pathDigest: sha, rootIdentity: sha },
          etag: null,
          error: null,
        },
        workspace: {
          identity: { kind: 'workspace', pathDigest: sha, rootIdentity: sha },
          etag: sha,
          error: null,
        },
        approvalEtag: null,
        bindingEtag: null,
        variablesDigest: sha,
      },
    },
  },
});
function fixture() {
  const root = mkdtempSync('/private/tmp/kite-source-approval-journal-');
  const access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  const path = join(access.profilePath, 'ui/mcp-source-approval-intents.json');
  const open = () =>
    openMcpSourceApprovalJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
  return {
    path,
    open,
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('cold Source intent preserves complete request bytes and terminal decisions cannot regress', () => {
  const f = fixture();
  try {
    const record = createMcpSourceApprovalRecord(intent(), 'subject'),
      a = f.open();
    expect(a.prepare(record)).toBe(true);
    const bytes = readFileSync(f.path);
    a.close();
    const b = f.open();
    expect(b.list()).toEqual([record]);
    expect(b.prepare(record)).toBe(false);
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(() =>
      b.prepare(
        createMcpSourceApprovalRecord({ ...intent(), workspaceIdentity: 'other' }, 'subject'),
      ),
    ).toThrow('mcp_source_approval_intent_conflict');
    b.record(record, 'outcome_unknown');
    b.record(record, 'pending');
    b.record(record, 'saved');
    expect(() => b.record(record, 'outcome_unknown')).toThrow();
    expect(() => b.record(record, 'cancelled')).toThrow();
    expect(b.list()[0]?.phase).toBe('saved');
    expect(readFileSync(f.path, 'utf8')).toContain('🙂');
    for (const phase of ['failed', 'cancelled'] as const) {
      const next = createMcpSourceApprovalRecord(intent(phase), 'subject');
      expect(b.prepare(next)).toBe(true);
      b.record(next, phase);
      expect(() => b.record(next, 'pending')).toThrow();
    }
    b.close();
    expect(() => b.list()).toThrow();
  } finally {
    f.close();
  }
});
test('unconfirmed Source decision conflicts across Session and fingerprint, with Store and Workspace kept distinct', () => {
  const f = fixture();
  try {
    const journal = f.open(),
      record = createMcpSourceApprovalRecord(intent(), 'subject');
    journal.prepare(record);
    for (const phase of ['submitting', 'pending', 'outcome_unknown'] as const) {
      journal.record(record, phase);
      const next = intent(`conflict-${phase}`);
      next.sessionId = 'another-session';
      next.request.input.expectedReadSet.variablesDigest = 'b'.repeat(64);
      expect(() => journal.prepare(createMcpSourceApprovalRecord(next, 'subject'))).toThrow(
        'mcp_source_approval_original_outcome_required',
      );
    }
    for (const [key, change] of [
      [
        'other-store',
        (row: TuiMcpSourceApprovalIntent) => {
          row.request.expectedStoreId = 'another-store';
        },
      ],
      [
        'other-workspace',
        (row: TuiMcpSourceApprovalIntent) => {
          row.workspaceId = 'another-workspace';
        },
      ],
      [
        'other-server',
        (row: TuiMcpSourceApprovalIntent) => {
          row.request.input.serverId = `mcp-${'b'.repeat(64)}`;
        },
      ],
    ] as const) {
      const next = intent(key);
      change(next);
      expect(journal.prepare(createMcpSourceApprovalRecord(next, 'subject'))).toBe(true);
    }
    expect(journal.list()).toHaveLength(4);
  } finally {
    f.close();
  }
});
test('closed Source codec rejects altered authority even after recomputing request hashes', () => {
  const record = createMcpSourceApprovalRecord(intent(), 'subject');
  const rewrite = (request: unknown) => {
    const row = request as Record<string, unknown>;
    const { commandId: _id, expectedStoreId: _store, ...core } = row;
    return {
      ...record,
      intent: { ...record.intent, request },
      bodySha256: mcpSha(request),
      requestSha256: mcpSha(core),
    };
  };
  for (const invalid of [
    { ...record, phase: ['saved'] },
    { ...record, subjectId: ['subject'] },
    { ...record, hotPostPermit: true },
    { ...record, bodySha256: 'b'.repeat(64) },
    { ...record, requestSha256: 'b'.repeat(64) },
    rewrite({ ...record.intent.request, actionId: 'mcp.source.credential.bind' }),
    rewrite({
      ...record.intent.request,
      input: { ...record.intent.request.input, serverId: 'safe-but-not-source-id' },
    }),
    rewrite({
      ...record.intent.request,
      input: {
        ...record.intent.request.input,
        expectedReadSet: { ...record.intent.request.input.expectedReadSet, userEtag: sha },
      },
    }),
    rewrite({
      ...record.intent.request,
      input: {
        ...record.intent.request.input,
        expectedReadSet: {
          ...record.intent.request.input.expectedReadSet,
          user: {
            ...record.intent.request.input.expectedReadSet.user,
            identity: {
              ...record.intent.request.input.expectedReadSet.user.identity,
              kind: 'workspace',
            },
          },
        },
      },
    }),
  ])
    expect(() => parseMcpSourceApprovalRecord(invalid)).toThrow();
  const nullable = intent();
  nullable.request.input.expectedReadSet.workspace = null;
  nullable.request.input.expectedReadSet.user.error = 'x'.repeat(4097);
  expect(createMcpSourceApprovalRecord(nullable, 'subject').intent).toEqual(nullable);
});
test('Source journal never evicts unknown records and refuses oversized complete bytes before publication', () => {
  const f = fixture();
  try {
    const journal = f.open();
    for (let n = 0; n < 128; n++) {
      const row = intent(`id-${n}`);
      row.workspaceId = `w-${n}`;
      journal.prepare(createMcpSourceApprovalRecord(row, 'subject'));
    }
    const before = readFileSync(f.path),
      extra = intent('extra');
    extra.workspaceId = 'extra';
    expect(() => journal.prepare(createMcpSourceApprovalRecord(extra, 'subject'))).toThrow(
      'mcp_source_approval_intent_limit',
    );
    expect(readFileSync(f.path)).toEqual(before);
    expect(journal.list()).toHaveLength(128);
    writeFileSync(f.path, Buffer.alloc(16 * 1024 * 1024 + 1), { mode: 0o600 });
    expect(() => journal.list()).toThrow('mcp_source_approval_journal_unavailable');
    writeFileSync(f.path, before);
    const oversized = intent('oversized');
    oversized.request.input.expectedReadSet.user.error = 'x'.repeat(16 * 1024 * 1024);
    expect(() => createMcpSourceApprovalRecord(oversized, 'subject')).toThrow();
    expect(readFileSync(f.path)).toEqual(before);
  } finally {
    f.close();
  }
});
test('Source journal refuses public permissions, links, duplicate IDs and invalid UTF8 without changing original bytes', () => {
  const f = fixture();
  try {
    const journal = f.open(),
      record = createMcpSourceApprovalRecord(intent(), 'subject');
    journal.prepare(record);
    const before = readFileSync(f.path);
    chmodSync(f.path, 0o644);
    expect(() => journal.list()).toThrow();
    chmodSync(f.path, 0o600);
    const hard = `${f.path}.hard`;
    linkSync(f.path, hard);
    expect(() => journal.list()).toThrow();
    rmSync(hard);
    const actual = `${f.path}.actual`;
    writeFileSync(actual, before, { mode: 0o600 });
    rmSync(f.path);
    symlinkSync(actual, f.path);
    expect(() => journal.list()).toThrow();
    rmSync(f.path);
    writeFileSync(f.path, before, { mode: 0o600 });
    writeFileSync(f.path, JSON.stringify({ version: 1, records: [record, record] }));
    expect(() => journal.list()).toThrow();
    writeFileSync(f.path, Buffer.from([0xff]));
    expect(() => journal.list()).toThrow();
    writeFileSync(f.path, before);
    expect(journal.list()).toEqual([record]);
    expect(readFileSync(f.path)).toEqual(before);
  } finally {
    f.close();
  }
});
