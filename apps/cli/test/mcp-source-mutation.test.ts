import { expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import type { TuiMcpSourceMutationIntent } from '@kite-ai/ui/tui';
import { createMcpSourceApprovalRecord } from '../host/mcp-source-approval-intents';
import { openMcpSourceApprovalJournal } from '../host/mcp-source-approval-journal';
import { assertMcpSourceJournalAvailable } from '../host/mcp-source-journal-files';
import {
  createMcpSourceMutationRecord,
  parseMcpSourceMutationIntent,
  parseMcpSourceMutationRecord,
} from '../host/mcp-source-mutation-intents';
import { openMcpSourceMutationJournal } from '../host/mcp-source-mutation-journal';

const sha = 'a'.repeat(64);
const make = (commandId = 'add'): TuiMcpSourceMutationIntent => ({
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: 'physical',
  request: {
    expectedStoreId: 'store',
    commandId,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId: 'mcp.source.add',
    definitionVersion: '1',
    input: {
      scope: 'user',
      name: 'owned',
      entry: { type: 'http', url: 'https://example.invalid/mcp' },
      expectedReadSet: {
        scopeDigest: sha,
        user: {
          identity: { kind: 'user', pathDigest: sha, rootIdentity: sha },
          etag: null,
          error: null,
        },
        workspace: {
          identity: { kind: 'workspace', pathDigest: 'b'.repeat(64), rootIdentity: 'b'.repeat(64) },
          etag: null,
          error: null,
        },
        approvalEtag: null,
        bindingEtag: null,
        variablesDigest: sha,
      },
    },
  },
});
test('closed original source mutation codec rejects secrets, empty query/fragment, variables, unexpected fields and hash forgery', () => {
  const a = make();
  expect(parseMcpSourceMutationIntent(a)).toEqual(a);
  const r = createMcpSourceMutationRecord(a, 'subject');
  expect(parseMcpSourceMutationRecord(r)).toEqual(r);
  for (const url of [
    'https://user:pass@example.invalid/',
    'https://example.invalid/?',
    'https://example.invalid/#',
    ['https://example.invalid/$', '{TOKEN}'].join(''),
    'https://example.invalid/\n',
  ]) {
    const b = make();
    if ('entry' in b.request.input) b.request.input.entry = { type: 'http', url };
    expect(() => parseMcpSourceMutationIntent(b)).toThrow();
  }
  for (const command of [
    'relative',
    'C:\\absolute',
    ['/bin/$', '{TOKEN}'].join(''),
    '/bin/tool\n',
  ]) {
    const b = make();
    if ('entry' in b.request.input) b.request.input.entry = { type: 'stdio', command };
    expect(() => parseMcpSourceMutationIntent(b)).toThrow();
  }
  expect(() => parseMcpSourceMutationIntent({ ...a, path: '/private' })).toThrow();
  expect(() => parseMcpSourceMutationRecord({ ...r, bodySha256: 'b'.repeat(64) })).toThrow();
  const longError = make();
  longError.request.input.expectedReadSet.user.error = 'error'.repeat(2000);
  expect(parseMcpSourceMutationIntent(longError)).toEqual(longError);
});
test('durable source identities conflict across S/W, foreign Store and genuinely other project identity remain independent', () => {
  const a = createMcpSourceMutationRecord(make(), 'subject'),
    b = make('next');
  b.sessionId = 'other';
  b.workspaceId = 'elsewhere';
  expect(() =>
    assertMcpSourceJournalAvailable([a], createMcpSourceMutationRecord(b, 'subject'), () =>
      Error('conflict'),
    ),
  ).toThrow('conflict');
  b.request.expectedStoreId = 'foreign';
  expect(() =>
    assertMcpSourceJournalAvailable([a], createMcpSourceMutationRecord(b, 'subject'), () =>
      Error('conflict'),
    ),
  ).not.toThrow();
  const project = make('project');
  project.request.input.scope = 'workspace';
  const other = structuredClone(project);
  other.request.commandId = 'other';
  other.request.input.expectedReadSet.workspace!.identity.pathDigest = 'c'.repeat(64);
  expect(() =>
    assertMcpSourceJournalAvailable(
      [createMcpSourceMutationRecord(project, 'subject')],
      createMcpSourceMutationRecord(other, 'subject'),
      () => Error('conflict'),
    ),
  ).not.toThrow();
});
test('real private publication, closed cross-journal conflict, terminal monotonicity and corrupt sibling fail closed', () => {
  const root = mkdtempSync('/private/tmp/kite-source-mutation-journal-'),
    access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  const input = { access, acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private') };
  const m = openMcpSourceMutationJournal(input),
    p = openMcpSourceApprovalJournal(input);
  try {
    const r = createMcpSourceMutationRecord(make(), 'subject');
    expect(m.prepare(r)).toBe(true);
    expect(m.prepare(r)).toBe(false);
    const approve = createMcpSourceApprovalRecord(
      {
        sessionId: 'other',
        workspaceId: 'elsewhere',
        workspaceIdentity: 'other-physical',
        request: {
          expectedStoreId: 'store',
          commandId: 'approve',
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp.sources',
          actionId: 'mcp.source.approve',
          definitionVersion: '1',
          input: { serverId: `mcp-${sha}`, expectedReadSet: make().request.input.expectedReadSet },
        },
      },
      'subject',
    );
    expect(() => p.prepare(approve)).toThrow();
    m.record(r, 'saved');
    expect(() => m.record(r, 'outcome_unknown')).toThrow();
    expect(p.prepare(approve)).toBe(true);
    expect(() => m.prepare(createMcpSourceMutationRecord(make('new'), 'subject'))).toThrow();
    p.record(approve, 'saved');
    writeFileSync(
      join(access.profilePath, 'ui/mcp-source-approval-intents.json'),
      '{"version":1,"records":[],"extra":true}',
      { mode: 0o600 },
    );
    expect(() => m.prepare(createMcpSourceMutationRecord(make('corrupt'), 'subject'))).toThrow();
  } finally {
    m.close();
    p.close();
    access.lock.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutation journal rejects full unknown capacity, oversized bytes, invalid UTF8, duplicates and insecure entities without eviction', () => {
  const root = mkdtempSync('/private/tmp/kite-source-mutation-journal-negative-');
  const access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(join(access.profilePath, 'ui'), { recursive: true, mode: 0o700 });
  const path = join(access.profilePath, 'ui/mcp-source-mutation-intents.json');
  const journal = openMcpSourceMutationJournal({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  const rows = Array.from({ length: 128 }, (_, i) =>
    createMcpSourceMutationRecord(make(`original-${i}`), 'subject'),
  );
  const write = (bytes: string | Uint8Array) => {
    rmSync(path, { force: true });
    writeFileSync(path, bytes, { mode: 0o600 });
  };
  try {
    write(JSON.stringify({ version: 1, records: rows }));
    const original = readFileSync(path);
    expect(journal.list()).toHaveLength(128);
    expect(() =>
      journal.prepare(createMcpSourceMutationRecord(make('overflow'), 'subject')),
    ).toThrow('mcp_source_mutation_intent_limit');
    expect(readFileSync(path)).toEqual(original);
    for (const bytes of [
      Buffer.from([0xff]),
      JSON.stringify({ version: 1, records: [rows[0], rows[0]] }),
      ' '.repeat(16 * 1024 * 1024 + 1),
    ]) {
      write(bytes);
      const unchanged = readFileSync(path);
      expect(() => journal.list()).toThrow();
      expect(readFileSync(path)).toEqual(unchanged);
    }
    write(JSON.stringify({ version: 1, records: [] }));
    chmodSync(path, 0o644);
    expect(() => journal.list()).toThrow();
    chmodSync(path, 0o600);
    linkSync(path, join(root, 'linked'));
    expect(() => journal.list()).toThrow();
  } finally {
    journal.close();
    access.lock.release();
    rmSync(root, { recursive: true, force: true });
  }
});
