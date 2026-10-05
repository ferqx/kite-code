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
import type { TuiMcpConnectionIntent } from '@kite-ai/ui/tui';
import {
  createMcpConnectionRecord,
  parseMcpConnectionRecord,
} from '../host/mcp-connection-intents';
import { openMcpConnectionJournal } from '../host/mcp-connection-journal';
import { mcpSha } from '../host/mcp-selection-intents';

const intent = (commandId = 'original'): TuiMcpConnectionIntent => ({
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: 'original-workspace-UTF8-🙂',
  request: {
    expectedStoreId: 'store',
    commandId,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.connect',
    definitionVersion: '1',
    input: { serverId: 'server', key: 'original-key' },
  },
});
function fixture() {
  const root = mkdtempSync('/private/tmp/kite-mcp-connection-journal-');
  const access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  const path = join(access.profilePath, 'ui/mcp-connection-intents.json');
  const open = () =>
    openMcpConnectionJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
  return {
    root,
    path,
    access,
    open,
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('original connection bytes survive cold reopen, old prepare has no POST permit and ready never regresses', () => {
  const f = fixture();
  try {
    const record = createMcpConnectionRecord(intent(), 'subject');
    const a = f.open();
    expect(a.prepare(record)).toBe(true);
    const before = readFileSync(f.path);
    a.close();
    const b = f.open();
    expect(b.list()).toEqual([record]);
    expect(b.prepare(record)).toBe(false);
    expect(readFileSync(f.path)).toEqual(before);
    expect(() =>
      b.prepare(
        createMcpConnectionRecord({ ...intent(), workspaceIdentity: 'changed' }, 'subject'),
      ),
    ).toThrow('mcp_connection_intent_conflict');
    b.record(record, 'outcome_unknown');
    b.record(record, 'pending');
    b.record(record, 'ready');
    expect(b.list()[0]?.phase).toBe('ready');
    expect(() => b.record(record, 'outcome_unknown')).toThrow();
    expect(() => b.record(record, 'failed')).toThrow();
    expect(readFileSync(f.path, 'utf8')).toContain('UTF8-🙂');
    b.close();
    expect(() => b.list()).toThrow();
  } finally {
    f.close();
  }
});
test('unknown conflicts only on original Store plus Session plus Server even when Workspace or key changes', () => {
  const f = fixture();
  try {
    const journal = f.open();
    journal.prepare(createMcpConnectionRecord(intent(), 'subject'));
    const changed = intent('conflict');
    changed.workspaceId = 'different-workspace';
    changed.request.input.key = 'new-key';
    expect(() => journal.prepare(createMcpConnectionRecord(changed, 'subject'))).toThrow(
      'mcp_connection_original_outcome_required',
    );
    for (const [command, change] of [
      [
        'other-session',
        (row: TuiMcpConnectionIntent) => {
          row.sessionId = 'other-session';
        },
      ],
      [
        'other-server',
        (row: TuiMcpConnectionIntent) => {
          row.request.input.serverId = 'other-server';
        },
      ],
      [
        'other-store',
        (row: TuiMcpConnectionIntent) => {
          row.request.expectedStoreId = 'other-store';
        },
      ],
    ] as const) {
      const next = intent(command);
      change(next);
      expect(journal.prepare(createMcpConnectionRecord(next, 'subject'))).toBe(true);
    }
    expect(journal.list()).toHaveLength(4);
  } finally {
    f.close();
  }
});
test('closed original connection codec rejects rehashed other actions, authority fields, alias enums and unsafe keys', () => {
  const record = createMcpConnectionRecord(intent(), 'subject');
  const invalid: unknown[] = [
    { ...record, token: 'untrusted' },
    { ...record, phase: ['ready'] },
    { ...record, subjectId: ['subject'] },
    { ...record, bodySha256: '0'.repeat(64) },
    { ...record, requestSha256: '0'.repeat(64) },
    { ...record, intent: { ...record.intent, hotPostPermit: true } },
  ];
  for (const input of [
    { serverId: 'server', key: '' },
    { serverId: 'server', key: 'a'.repeat(65) },
    { serverId: 'server', key: ['key'] },
    { serverId: 'server', key: 'bad/key' },
    { serverId: ['server'], key: 'key' },
    { serverId: 'server', key: 'key', url: 'untrusted' },
  ]) {
    const request = { ...record.intent.request, input };
    const { commandId: _command, expectedStoreId: _store, ...withoutEnvelope } = request;
    invalid.push({
      ...record,
      intent: { ...record.intent, request },
      bodySha256: mcpSha(request),
      requestSha256: mcpSha(withoutEnvelope),
    });
  }
  for (const [extensionId, actionId, definitionVersion] of [
    ['builtin.mcp.management', 'mcp.server.select', '1'],
    ['builtin.mcp', 'mcp.catalogue.refresh', '1'],
    ['builtin.mcp', 'mcp.connect', '2'],
  ]) {
    const request = { ...record.intent.request, extensionId, actionId, definitionVersion };
    const { commandId: _command, expectedStoreId: _store, ...withoutEnvelope } = request;
    invalid.push({
      ...record,
      intent: { ...record.intent, request },
      bodySha256: mcpSha(request),
      requestSha256: mcpSha(withoutEnvelope),
    });
  }
  for (const value of invalid) expect(() => parseMcpConnectionRecord(value)).toThrow();
});
test('private physical journal rejects public permissions, links, duplicate IDs, bad UTF8, size and invalid leases without replacing bytes', () => {
  const f = fixture();
  try {
    const journal = f.open(),
      record = createMcpConnectionRecord(intent(), 'subject');
    journal.prepare(record);
    const original = readFileSync(f.path);
    chmodSync(f.path, 0o644);
    expect(() => journal.list()).toThrow();
    chmodSync(f.path, 0o600);
    linkSync(f.path, join(f.root, 'linked'));
    expect(() => journal.list()).toThrow();
    rmSync(join(f.root, 'linked'));
    expect(readFileSync(f.path)).toEqual(original);
    for (const bytes of [
      Buffer.from(JSON.stringify({ version: 1, records: [record, record] })),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(' '.repeat(16 * 1024 * 1024 + 1)),
    ]) {
      writeFileSync(f.path, bytes);
      expect(() =>
        journal.prepare(createMcpConnectionRecord(intent('fresh'), 'subject')),
      ).toThrow();
      expect(readFileSync(f.path)).toEqual(bytes);
    }
    writeFileSync(f.path, original);
    rmSync(f.path);
    writeFileSync(join(f.root, 'original.json'), original, { mode: 0o600 });
    symlinkSync(join(f.root, 'original.json'), f.path);
    expect(() => journal.list()).toThrow();
    expect(readFileSync(join(f.root, 'original.json'))).toEqual(original);
    rmSync(f.path);
    writeFileSync(f.path, original, { mode: 0o600 });
    const copied = openMcpConnectionJournal({
      access: { ...f.access },
      acquireWriteLock: () => acquireProfileDataLock(f.access, 'tui_private'),
    });
    expect(() => copied.list()).toThrow();
    f.access.lock.release();
    expect(() => journal.list()).toThrow();
  } finally {
    f.close();
  }
});
test('128 independently scoped unknown intents reach finite capacity and are never evicted for a new request', () => {
  const f = fixture();
  try {
    const journal = f.open();
    for (let n = 0; n < 128; n++) {
      const next = intent(`original-${n}`);
      next.request.input.serverId = `server-${n}`;
      expect(journal.prepare(createMcpConnectionRecord(next, 'subject'))).toBe(true);
    }
    const bytes = readFileSync(f.path);
    expect(() => journal.prepare(createMcpConnectionRecord(intent('overflow'), 'subject'))).toThrow(
      'mcp_connection_intent_limit',
    );
    expect(journal.list()).toHaveLength(128);
    expect(readFileSync(f.path)).toEqual(bytes);
  } finally {
    f.close();
  }
});
