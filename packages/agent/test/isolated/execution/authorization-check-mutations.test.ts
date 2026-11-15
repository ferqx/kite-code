import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizationRecordedMutations } from '../../../src/storage/sqlite/authorization-check-mutations';
import type { SqliteOperations } from '../../../src/storage/sqlite/operations';
import type { Json } from '../../../src/storage/types';
import { createWorkspaceFiles } from '../../../src/tools/files';

function fixture() {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE session(id TEXT,workspace_id TEXT); CREATE TABLE run(id TEXT,session_id TEXT,origin_store_id TEXT,config_json TEXT); CREATE TABLE change_event(cursor INTEGER,object_id TEXT,scope_session_id TEXT,type TEXT); CREATE TABLE execution(id TEXT,session_id TEXT,run_id TEXT,origin_store_id TEXT,root_work_command_id TEXT,root_work_seq TEXT,kind TEXT,adapter_id TEXT,definition_version TEXT,state TEXT,dispatched INTEGER,cancel_requested INTEGER,cancel_requested_at INTEGER,completed_cursor INTEGER,intent_json TEXT,result_json TEXT,result_revision INTEGER);`,
  );
  const tools = [
    { id: 'files.read', version: '5', extensionId: 'builtin.files' },
    { id: 'files.write', version: '3', extensionId: 'builtin.files' },
    { id: 'files.edit', version: '2', extensionId: 'builtin.files' },
  ];
  db.query('INSERT INTO session VALUES (?,?)').run('s', 'w');
  db.query('INSERT INTO run VALUES (?,?,?,?)').run('r', 's', 'store', JSON.stringify({ tools }));
  db.query('INSERT INTO change_event VALUES (?,?,?,?)').run(20, 'read', 's', 'execution.planned');
  const result = {
    outcome: 'succeeded',
    content: JSON.stringify({
      path: 'notes.md',
      executionId: 'write',
      runId: 'r',
      baseline: { device: '1', inode: '2', hash: 'SECRET_HASH', size: 10 },
      content: 'SECRET_BODY',
    }),
    details: { fileChange: { text: 'SECRET_DIFF' } },
  };
  db.query('INSERT INTO execution VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'write',
    's',
    'r',
    'store',
    'work',
    '1',
    'tool',
    'files.write',
    '3',
    'succeeded',
    1,
    0,
    null,
    10,
    JSON.stringify({ path: 'notes.md', content: 'SECRET_INPUT' }),
    JSON.stringify(result),
    1,
  );
  const target = {
    id: 'read',
    session_id: 's',
    run_id: 'r',
    origin_store_id: 'store',
    root_work_command_id: 'work',
    root_work_seq: '1',
    kind: 'tool',
    adapter_id: 'files.read',
    definition_version: '5',
    intent_json: JSON.stringify({ path: 'notes.md' }),
  };
  const current = {
    kind: 'native_workspace_file_identity',
    workspaceId: 'w',
    workspaceRoot: '/workspace',
    path: 'notes.md',
    canonicalPath: '/workspace/notes.md',
    rootIdentity: { device: '1', inode: '4' },
    parentIdentity: { device: '1', inode: '4' },
    fileIdentity: { device: '1', inode: '2' },
  };
  const request = (): Json => ({ mode: 'auto', context: { currentFileTarget: current } });
  const ops = {
    row: (sql: string, ...args: unknown[]) => db.query(sql).get(...(args as never[])),
    rows: (sql: string, ...args: unknown[]) => db.query(sql).all(...(args as never[])),
  } as unknown as SqliteOperations;
  return {
    db,
    target,
    current,
    request,
    read: () => authorizationRecordedMutations(ops, target, request(), '/workspace'),
    close: () => db.close(),
  };
}

test('same-run exact native identity exposes only historical metadata, never content or grants', () => {
  const f = fixture();
  try {
    const evidence = f.read();
    expect(evidence.recordedFileMutations).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toContain('SECRET');
    expect((evidence.recordedFileMutations as Array<Record<string, Json>>)[0]).toMatchObject({
      historical: true,
      currentVersionVerified: false,
      resultRevision: '1',
      canonicalPath: '/workspace/notes.md',
    });
  } finally {
    f.close();
  }
});
for (const [field, value] of [
  ['session_id', 'other'],
  ['run_id', 'other'],
  ['origin_store_id', 'other'],
  ['root_work_command_id', 'other'],
  ['state', 'failed'],
  ['state', 'cancelled'],
  ['dispatched', 0],
  ['cancel_requested', 1],
  ['cancel_requested_at', 1],
  ['completed_cursor', 20],
  ['completed_cursor', 21],
  ['definition_version', '99'],
] as const)
  test(`mutation evidence excludes ${field}=${value}`, () => {
    const f = fixture();
    try {
      f.db.query(`UPDATE execution SET ${field}=?`).run(value);
      expect(f.read()).toEqual({});
    } finally {
      f.close();
    }
  });
for (const change of [
  'other-path',
  'replacement-identity',
  'forged-owner',
  'missing-current',
  'malformed-result',
  'outside',
  'same-name-other-directory',
] as const)
  test(`mutation evidence excludes ${change}`, () => {
    const f = fixture();
    try {
      if (change === 'other-path') f.target.intent_json = JSON.stringify({ path: 'other.md' });
      if (change === 'replacement-identity') f.current.fileIdentity.inode = '3';
      if (change === 'forged-owner')
        f.db
          .query('UPDATE run SET config_json=?')
          .run(
            JSON.stringify({ tools: [{ id: 'files.read', version: '5', extensionId: 'evil' }] }),
          );
      if (change === 'missing-current') f.current.kind = 'untrusted';
      if (change === 'malformed-result') f.db.query('UPDATE execution SET result_json=?').run('{}');
      if (change === 'outside') f.target.intent_json = JSON.stringify({ path: '/other/notes.md' });
      if (change === 'same-name-other-directory')
        f.db
          .query('UPDATE execution SET intent_json=?')
          .run(JSON.stringify({ path: 'different/notes.md' }));
      expect(f.read()).toEqual({});
    } finally {
      f.close();
    }
  });

test('native identity observer rejects symlink substitution and identifies replacement without reading content', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mutation-identity-')));
  const files = createWorkspaceFiles({ root, protectReads: true, protectedPaths: [] });
  try {
    writeFileSync(join(root, 'notes.md'), 'private-original');
    writeFileSync(join(root, 'other.md'), 'private-other');
    const before = await files.inspectIdentity('notes.md');
    renameSync(join(root, 'notes.md'), join(root, 'original-kept.md'));
    symlinkSync(join(root, 'other.md'), join(root, 'notes.md'));
    await expect(files.inspectIdentity('notes.md')).rejects.toThrow();
    unlinkSync(join(root, 'notes.md'));
    writeFileSync(join(root, 'notes.md'), 'replacement');
    const after = await files.inspectIdentity('notes.md');
    expect(after.file).not.toEqual(before.file);
  } finally {
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('successful edit metadata is accepted but false tool outcome is excluded', () => {
  const f = fixture();
  try {
    f.db.query("UPDATE execution SET adapter_id='files.edit',definition_version='2'").run();
    expect((f.read().recordedFileMutations as Array<Record<string, Json>>)[0]?.definitionId).toBe(
      'files.edit',
    );
    const saved = JSON.parse(
      (f.db.query('SELECT result_json FROM execution').get() as { result_json: string })
        .result_json,
    );
    saved.outcome = 'failed';
    f.db.query('UPDATE execution SET result_json=?').run(JSON.stringify(saved));
    expect(f.read()).toEqual({});
  } finally {
    f.close();
  }
});

test('in-place content change does not turn matching identity into current-version proof', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mutation-inplace-')));
  const files = createWorkspaceFiles({ root, protectReads: true, protectedPaths: [] });
  const f = fixture();
  try {
    writeFileSync(join(root, 'notes.md'), 'first private value');
    const before = await files.inspectIdentity('notes.md');
    writeFileSync(join(root, 'notes.md'), 'different private value');
    expect((await files.inspectIdentity('notes.md')).file).toEqual(before.file);
    // Matching identity deliberately preserves only a historical statement.
    expect((f.read().recordedFileMutations as Array<Record<string, Json>>)[0]).toMatchObject({
      historical: true,
      currentVersionVerified: false,
    });
    expect(JSON.stringify(f.read())).not.toContain('private value');
  } finally {
    f.close();
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});
