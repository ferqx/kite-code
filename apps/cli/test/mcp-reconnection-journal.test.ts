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
import type { TuiMcpConnectionIntent, TuiMcpReconnectionIntent } from '@kite-ai/ui/tui';
import { createMcpConnectionRecord } from '../host/mcp-connection-intents';
import { openMcpConnectionJournal } from '../host/mcp-connection-journal';
import {
  createMcpReconnectionRecord,
  parseMcpReconnectionRecord,
} from '../host/mcp-reconnection-intents';
import { openMcpReconnectionJournal } from '../host/mcp-reconnection-journal';
import { mcpSha } from '../host/mcp-selection-intents';

const connect = (commandId = 'warm-carrier-B'): TuiMcpConnectionIntent => ({
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: 'canonical-original-UTF8-🙂',
  request: {
    expectedStoreId: 'store',
    commandId,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.connect',
    definitionVersion: '1',
    input: { serverId: 'server', key: 'carrier-B' },
  },
});
const intent = (commandId = 'forced-one'): TuiMcpReconnectionIntent => ({
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: connect().workspaceIdentity,
  targetRequest: connect().request,
  request: {
    expectedStoreId: 'store',
    commandId,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.reconnect',
    definitionVersion: '1',
    input: {
      serverId: 'server',
      key: `key-${commandId}`,
      target: {
        carrierExecutionId: 'carrier-exec-B',
        carrierKey: 'carrier-B',
        operationRef: {
          commandId: 'job-command-A',
          sessionId: 's',
          originStoreId: 'store',
          extensionId: 'builtin.mcp',
          key: 'connection/server/underlying-A',
          executionId: 'job-A',
        },
        connectionExecutionId: 'job-A',
        configDigest: 'a'.repeat(64),
        currentGeneration: 1,
      },
      replacement: { kind: 'static', expectedConfigDigest: 'a'.repeat(64) },
    },
  },
});
function fixture() {
  const root = mkdtempSync('/private/tmp/kite-mcp-reconnection-journal-');
  const access = acquireProfileAccess({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  const open = () => ({
    connection: openMcpConnectionJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    }),
    reconnection: openMcpReconnectionJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    }),
  });
  return {
    root,
    access,
    open,
    path: join(access.profilePath, 'ui/mcp-reconnection-intents.json'),
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('original full reconnection and one prior R request retain bytes, canonical hashes and no cold prepare right', () => {
  const f = fixture();
  try {
    const record = createMcpReconnectionRecord(intent(), 'subject');
    const first = f.open();
    expect(first.reconnection.prepare(record)).toBe(true);
    const bytes = readFileSync(f.path);
    expect(record.bodySha256).toBe(mcpSha(record.intent.request));
    expect(record.bodySha256).not.toBe(record.requestSha256);
    expect(parseMcpReconnectionRecord(record)).toEqual(record);
    first.reconnection.close();
    first.connection.close();
    const cold = f.open();
    expect(cold.reconnection.list()).toEqual([record]);
    expect(cold.reconnection.prepare(record)).toBe(false);
    expect(readFileSync(f.path)).toEqual(bytes);
    cold.reconnection.record(record, 'ready');
    expect(() => cold.reconnection.record(record, 'outcome_unknown')).toThrow();
    const second = intent('forced-two');
    second.targetRequest = record.intent.request;
    second.request.input.target.carrierKey = record.intent.request.input.key;
    second.request.input.target.carrierExecutionId = 'first-R-execution';
    second.request.input.target.operationRef.key = `connection/server/${record.intent.request.input.key}`;
    second.request.input.target.operationRef.commandId = 'first-new-job-command';
    second.request.input.target.operationRef.executionId = 'first-new-job';
    second.request.input.target.connectionExecutionId = 'first-new-job';
    expect(cold.reconnection.prepare(createMcpReconnectionRecord(second, 'subject'))).toBe(true);
    expect(Object.hasOwn(cold.reconnection.list()[1]!.intent.targetRequest, 'targetRequest')).toBe(
      false,
    );
    expect(readFileSync(f.path, 'utf8')).toContain('UTF8-🙂');
    cold.reconnection.close();
    cold.connection.close();
    expect(() => cold.reconnection.list()).toThrow('mcp_reconnection_journal_unavailable');
  } finally {
    f.close();
  }
});
test('both actual journal files share unknown conflict under one data lock and only proven terminal phases unblock', () => {
  const f = fixture();
  try {
    const journals = f.open();
    const c = createMcpConnectionRecord(connect(), 'subject');
    const r = createMcpReconnectionRecord(intent(), 'subject');
    expect(journals.connection.prepare(c)).toBe(true);
    expect(() => journals.reconnection.prepare(r)).toThrow(
      'mcp_reconnection_original_outcome_required',
    );
    journals.connection.record(c, 'ready');
    expect(journals.reconnection.prepare(r)).toBe(true);
    const fresh = createMcpConnectionRecord(connect('later-connection'), 'subject');
    expect(() => journals.connection.prepare(fresh)).toThrow(
      'mcp_connection_original_outcome_required',
    );
    journals.reconnection.record(r, 'outcome_unknown');
    expect(() => journals.connection.prepare(fresh)).toThrow(
      'mcp_connection_original_outcome_required',
    );
    const otherSession = connect('other-session-connection');
    otherSession.sessionId = 'other-s';
    expect(journals.connection.prepare(createMcpConnectionRecord(otherSession, 'subject'))).toBe(
      true,
    );
    journals.reconnection.record(r, 'failed');
    expect(journals.connection.prepare(fresh)).toBe(true);
    expect(() => journals.reconnection.record(r, 'pending')).toThrow();
    expect(journals.reconnection.list()[0]!.phase).toBe('failed');
    journals.connection.close();
    journals.reconnection.close();
  } finally {
    f.close();
  }
});
test('foreign original Store does not conflict in the current domain, command identity cannot collide across assets', () => {
  const f = fixture();
  try {
    const journals = f.open();
    const r = createMcpReconnectionRecord(intent(), 'subject');
    expect(journals.reconnection.prepare(r)).toBe(true);
    const foreign = connect('foreign-current-command');
    foreign.request.expectedStoreId = 'current-B';
    expect(journals.connection.prepare(createMcpConnectionRecord(foreign, 'subject'))).toBe(true);
    const collision = connect(r.intent.request.commandId);
    collision.sessionId = 'other-s';
    expect(() =>
      journals.connection.prepare(createMcpConnectionRecord(collision, 'subject')),
    ).toThrow();
    journals.connection.close();
    journals.reconnection.close();
  } finally {
    f.close();
  }
});
test('closed full request refuses aliases, wrong original identities, suffix overwrite and repaired outer hashes', () => {
  const valid = createMcpReconnectionRecord(intent(), 'subject');
  const operation = ['intent', 'request', 'input', 'target', 'operationRef'];
  const mutations: Array<[string[], unknown]> = [
    [[...operation, 'childSessionId'], 'child'],
    [[...operation, 'executionId'], 'different'],
    [[...operation, 'sessionId'], 'foreign'],
    [[...operation, 'originStoreId'], 'foreign'],
    [[...operation, 'key'], 'bare'],
    [['intent', 'request', 'input', 'key'], 'underlying-A'],
    [['intent', 'request', 'input', 'key'], 'carrier-B'],
    [['intent', 'request', 'commandId'], 'job-command-A'],
    [['intent', 'request', 'commandId'], valid.intent.targetRequest.commandId],
    [['intent', 'request', 'input', 'target', 'currentGeneration'], 0],
    [['intent', 'request', 'input', 'replacement', 'kind'], ['static']],
    [['intent', 'request', 'input', 'replacement', 'env'], { SECRET: 'fixture' }],
    [['intent', 'targetRequest', 'targetRequest'], valid.intent.targetRequest],
    [['intent', 'targetRequest', 'input', 'key'], 'different'],
    [['phase'], ['ready']],
    [['extra'], true],
  ];
  for (const [path, value] of mutations) {
    const row = structuredClone(valid) as unknown as Record<string, unknown>;
    let parent = row;
    for (const field of path.slice(0, -1)) parent = parent[field] as Record<string, unknown>;
    parent[path.at(-1)!] = value;
    const request = (row.intent as Record<string, unknown>).request as Record<string, unknown>;
    row.bodySha256 = mcpSha(request);
    const { commandId: _commandId, expectedStoreId: _storeId, ...body } = request;
    row.requestSha256 = mcpSha(body);
    expect(() => parseMcpReconnectionRecord(row)).toThrow();
  }
});
test('cross file private permissions, links, future shape and fatal UTF8 fail closed and release the actual data lock', () => {
  const f = fixture();
  try {
    const journals = f.open();
    const r = createMcpReconnectionRecord(intent(), 'subject');
    expect(journals.reconnection.prepare(r)).toBe(true);
    journals.reconnection.record(r, 'ready');
    const original = readFileSync(f.path);
    const c = createMcpConnectionRecord(connect('later'), 'subject');
    chmodSync(f.path, 0o644);
    expect(() => journals.connection.prepare(c)).toThrow('mcp_connection_journal_unavailable');
    chmodSync(f.path, 0o600);
    const hard = join(f.root, 'hard-link');
    linkSync(f.path, hard);
    expect(() => journals.connection.prepare(c)).toThrow();
    rmSync(hard);
    rmSync(f.path);
    const saved = join(f.root, 'saved.json');
    writeFileSync(saved, original, { mode: 0o600 });
    symlinkSync(saved, f.path);
    expect(() => journals.connection.prepare(c)).toThrow();
    rmSync(f.path);
    writeFileSync(f.path, Buffer.from([0xff]), { mode: 0o600 });
    expect(() => journals.connection.prepare(c)).toThrow();
    writeFileSync(f.path, JSON.stringify({ version: 2, records: [] }), { mode: 0o600 });
    expect(() => journals.connection.prepare(c)).toThrow();
    writeFileSync(f.path, original, { mode: 0o600 });
    const held = acquireProfileDataLock(f.access, 'tui_private');
    held.release();
    expect(journals.connection.prepare(c)).toBe(true);
    journals.connection.close();
    journals.reconnection.close();
  } finally {
    f.close();
  }
});
test('128 original intents fill the real asset without evicting unknown and UTF8 document bytes have a separate bound', () => {
  const f = fixture();
  try {
    const journals = f.open();
    for (let i = 0; i < 128; i++) {
      const request = intent(`capacity-${i}`);
      request.sessionId = `session-${i}`;
      request.request.input.target.operationRef.sessionId = request.sessionId;
      expect(journals.reconnection.prepare(createMcpReconnectionRecord(request, 'subject'))).toBe(
        true,
      );
    }
    const bytes = readFileSync(f.path);
    expect(journals.reconnection.list()).toHaveLength(128);
    expect(journals.reconnection.list().every((row) => row.phase === 'submitting')).toBe(true);
    expect(() =>
      journals.reconnection.prepare(createMcpReconnectionRecord(intent('overflow'), 'subject')),
    ).toThrow('mcp_reconnection_intent_limit');
    expect(readFileSync(f.path)).toEqual(bytes);
    journals.connection.close();
    journals.reconnection.close();
    // Byte budget, independent of item count; this is a codec/file limit case, not a Source producer qualification.
    writeFileSync(f.path, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });
    const cold = f.open();
    expect(() => cold.reconnection.list()).toThrow('mcp_reconnection_journal_unavailable');
    expect(readFileSync(f.path).length).toBe(16 * 1024 * 1024 + 1);
    cold.connection.close();
    cold.reconnection.close();
  } finally {
    f.close();
  }
});
