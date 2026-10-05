import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { verifyMcpSourceApprovalIntentsDocument } from '../../../src/maintenance/mcp-source-approval-intents';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import { initializeDefaultSqliteEngine } from '../../../src/sqlite-engine';

const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
function row(storeId: string, index = 0) {
  const request = {
    expectedStoreId: storeId,
    commandId: `source_${index}`,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId: 'mcp.source.approve',
    definitionVersion: '1',
    input: {
      serverId: `mcp-${'a'.repeat(64)}`,
      expectedReadSet: {
        scopeDigest: 'b'.repeat(64),
        user: {
          identity: { kind: 'user', pathDigest: 'c'.repeat(64), rootIdentity: 'd'.repeat(64) },
          etag: null,
          error: null,
        },
        workspace: {
          identity: { kind: 'workspace', pathDigest: 'e'.repeat(64), rootIdentity: 'f'.repeat(64) },
          etag: '1'.repeat(64),
          error: null,
        },
        approvalEtag: null,
        bindingEtag: '2'.repeat(64),
        variablesDigest: '3'.repeat(64),
      },
    },
  };
  const { commandId: _commandId, expectedStoreId: _storeId, ...publicRequest } = request;
  return {
    intent: {
      sessionId: 'original_s',
      workspaceId: 'original_w',
      workspaceIdentity: 'original-root:dev:ino',
      request,
    },
    subjectId: 'original_subject',
    bodySha256: hash(canonicalJson(request)),
    requestSha256: hash(canonicalJson(publicRequest)),
    phase: 'outcome_unknown',
  };
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-approval-assets-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.close();
  const path = join(selectProfile(profile).profilePath, 'ui/mcp-source-approval-intents.json');
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  return {
    root,
    profile,
    storeId,
    path,
    destinationRoot: join(root, 'backups'),
    close: () => {
      rmSync(root, { recursive: true, force: true });
      const rootRemoved = !existsSync(root);
      console.log(JSON.stringify({ case: 'source_approval_asset_cleanup', root, rootRemoved }));
      if (!rootRemoved) throw Error('owned_root_cleanup_unconfirmed');
    },
  };
}
function write(path: string, records: unknown[], padding = 0) {
  const b = Buffer.from(
    `${JSON.stringify({ version: 1, records }, null, 2)}\r\n${' '.repeat(padding)}`,
  );
  writeFileSync(path, b, { mode: 0o600 });
  return b;
}
const proof = (bytes: Uint8Array) => ({ sha256: hash(bytes), byteLength: String(bytes.length) });

test('public v10 create/inspect/restore preserves whole original A intent bytes, hashes and identities without rewriting to Store B', async () => {
  const f = await fixture();
  try {
    const original = [
      row(f.storeId),
      { ...row(f.storeId, 1), phase: 'saved' },
      { ...row(f.storeId, 2), phase: 'cancelled' },
    ];
    const bytes = write(f.path, original);
    const qualification = initializeDefaultSqliteEngine();
    const memory = new Database(':memory:');
    let identity: { version: string; sourceId: string } | null = null;
    try {
      identity = memory
        .query<{ version: string; sourceId: string }, []>(
          'SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId',
        )
        .get();
    } finally {
      memory.close(true);
    }
    if (!identity) throw Error('default_sqlite_fixture_observation_failed');
    const databasePath = selectProfile(f.profile).databasePath;
    const coreFiles = ['', '-wal', '-shm'].map((suffix) => {
      const path = databasePath + suffix;
      const present = existsSync(path);
      return { suffix, path, present, bytes: present ? readFileSync(path) : null };
    });
    const unchangedCore = () => {
      for (const file of coreFiles) {
        expect(existsSync(file.path)).toBe(file.present);
        if (file.bytes !== null) expect(readFileSync(file.path)).toEqual(file.bytes);
      }
    };
    console.log(
      JSON.stringify({
        stage: 'default_closed_sqlite_source',
        qualification: qualification.qualification,
        version: identity.version,
        sourceId: identity.sourceId,
        files: coreFiles.map((file) => ({
          suffix: file.suffix,
          present: file.present,
          byteLength: file.bytes?.length ?? null,
        })),
      }),
    );
    const backup = await createProfileBackup(f);
    unchangedCore();
    expect(backup.manifest.version).toBe(10);
    expect(backup.manifest.assets.mcpSourceApprovalIntents).toMatchObject({
      path: 'ui/mcp-source-approval-intents.json',
      present: true,
      format: { version: 1 },
      proof: proof(bytes),
    });
    expect(backup.manifest.assets.mcpSelectionIntents).toMatchObject({
      present: false,
      format: null,
      proof: null,
    });
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    unchangedCore();
    expect(readFileSync(join(backup.directory, 'ui/mcp-source-approval-intents.json'))).toEqual(
      bytes,
    );
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    expect(readFileSync(f.path)).toEqual(bytes);
    verifyMcpSourceApprovalIntentsDocument(f.path);
    const records = JSON.parse(readFileSync(f.path, 'utf8')).records;
    expect(records).toEqual(original);
    expect(records[0].intent.request.expectedStoreId).toBe(f.storeId);
    console.log(
      JSON.stringify({
        case: 'source_approval_intent_backup_restore',
        originalStoreId: f.storeId,
        currentStoreId: restored.storeId,
        byteLength: bytes.length,
        sha256: hash(bytes),
        originalCommandIds: original.map((r) => r.intent.request.commandId),
        phases: original.map((r) => r.phase),
      }),
    );
    const store = await openSqliteStore(f.profile);
    try {
      expect((await store.getMetadata()).storeId).toBe(restored.storeId);
    } finally {
      await store.close();
    }
  } finally {
    f.close();
  }
}, 30000);
test('closed source-approval-only codec rejects future/mixed action/shape/hash/duplicate identities; all original unknown rows retained', async () => {
  const f = await fixture();
  try {
    const original = row(f.storeId);
    const cases: ((r: ReturnType<typeof row>) => void)[] = [
      (r) => {
        r.intent.request.actionId = 'mcp.server.select';
      },
      (r) => {
        r.intent.request.extensionId = 'builtin.mcp.management';
      },
      (r) => {
        r.intent.request.input.serverId = 'mcp-bad';
      },
      (r) => {
        r.bodySha256 = 'a'.repeat(64);
      },
      (r) => {
        r.requestSha256 = 'b'.repeat(64);
      },
      (r) => {
        r.phase = 'applied';
      },
      (r) => {
        Object.assign(r.intent.request.input.expectedReadSet, { authority: true });
      },
      (r) => {
        Object.assign(r.intent, { authority: true });
      },
    ];
    for (const change of cases) {
      const bad = structuredClone(original);
      change(bad);
      write(f.path, [bad]);
      expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    }
    const badReadSets: ((
      read: ReturnType<typeof row>['intent']['request']['input']['expectedReadSet'],
    ) => void)[] = [
      (r) => {
        r.user.identity.kind = 'workspace';
      },
      (r) => {
        r.workspace.identity.kind = 'user';
      },
      (r) => {
        r.scopeDigest = 'invalid';
      },
      (r) => {
        r.user.identity.pathDigest = 'bad';
      },
      (r) => {
        r.user.identity.rootIdentity = 'bad';
      },
      (r) => {
        r.workspace.etag = 'bad';
      },
      (r) => {
        r.approvalEtag = 'bad' as never;
      },
      (r) => {
        r.bindingEtag = 'bad';
      },
      (r) => {
        r.variablesDigest = 'bad';
      },
      (r) => {
        Object.assign(r.user, { error: 3 });
      },
      (r) => {
        Object.assign(r.user.identity, { path: '/not-a-journal-field' });
      },
    ];
    for (const change of badReadSets) {
      const bad = structuredClone(original);
      change(bad.intent.request.input.expectedReadSet);
      bad.bodySha256 = hash(canonicalJson(bad.intent.request));
      const { commandId: _id, expectedStoreId: _store, ...publicRequest } = bad.intent.request;
      bad.requestSha256 = hash(canonicalJson(publicRequest));
      write(f.path, [bad]);
      expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    }
    for (const phase of [['saved'], 'ready', 'applied', 'approved']) {
      write(f.path, [{ ...original, phase }]);
      expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    }
    const nullableWorkspace = structuredClone(original);
    Object.assign(nullableWorkspace.intent.request.input.expectedReadSet, { workspace: null });
    nullableWorkspace.bodySha256 = hash(canonicalJson(nullableWorkspace.intent.request));
    const {
      commandId: _id,
      expectedStoreId: _store,
      ...publicNullable
    } = nullableWorkspace.intent.request;
    nullableWorkspace.requestSha256 = hash(canonicalJson(publicNullable));
    write(f.path, [nullableWorkspace]);
    verifyMcpSourceApprovalIntentsDocument(f.path);
    const longError = structuredClone(original);
    Object.assign(longError.intent.request.input.expectedReadSet.user, {
      error: '原始错误\r\n'.repeat(10000),
    });
    longError.bodySha256 = hash(canonicalJson(longError.intent.request));
    const {
      commandId: _errorId,
      expectedStoreId: _errorStore,
      ...publicError
    } = longError.intent.request;
    longError.requestSha256 = hash(canonicalJson(publicError));
    const errorBytes = write(f.path, [longError]);
    verifyMcpSourceApprovalIntentsDocument(f.path);
    expect(readFileSync(f.path)).toEqual(errorBytes);
    write(f.path, [original, original]);
    expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    write(f.path, [original]);
    verifyMcpSourceApprovalIntentsDocument(f.path);
    const bytes = readFileSync(f.path);
    expect(JSON.parse(bytes.toString()).records[0].phase).toBe('outcome_unknown');
    expect(readFileSync(f.path)).toEqual(bytes);
    writeFileSync(f.path, Buffer.from([0xff]));
    expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    writeFileSync(f.path, JSON.stringify({ version: 2, records: [] }));
    expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
  } finally {
    f.close();
  }
});
test('exact 128 unknown/16MiB raw bytes accepted; excess, private mode and linked files fail closed', async () => {
  const f = await fixture();
  try {
    const rows = Array.from({ length: 128 }, (_, i) => row(f.storeId, i));
    const base = write(f.path, rows);
    const bytes = write(f.path, rows, 16 * 1024 * 1024 - base.length);
    expect(bytes.length).toBe(16 * 1024 * 1024);
    verifyMcpSourceApprovalIntentsDocument(f.path);
    expect(readFileSync(f.path)).toEqual(bytes);
    const boundedBackup = await createProfileBackup(f);
    expect(boundedBackup.manifest.version).toBe(10);
    expect(
      readFileSync(join(boundedBackup.directory, 'ui/mcp-source-approval-intents.json')),
    ).toEqual(bytes);
    expect(
      (await inspectProfileBackup(boundedBackup)).manifest.assets.mcpSourceApprovalIntents?.proof,
    ).toEqual(proof(bytes));
    write(f.path, rows, 16 * 1024 * 1024 - base.length + 1);
    expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    write(f.path, [...rows, row(f.storeId, 128)]);
    expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    write(f.path, [rows[0]]);
    chmodSync(f.path, 0o644);
    expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    chmodSync(f.path, 0o600);
    const hard = join(f.root, 'hard');
    linkSync(f.path, hard);
    expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
    unlinkSync(hard);
    const source = join(f.root, 'source');
    writeFileSync(source, readFileSync(f.path), { mode: 0o600 });
    unlinkSync(f.path);
    symlinkSync(source, f.path);
    expect(() => verifyMcpSourceApprovalIntentsDocument(f.path)).toThrow();
  } finally {
    f.close();
  }
});
test('absent new asset retains old version; v9 physical whitelist and corrupt v10 restore reject even matching outer proof', async () => {
  const f = await fixture();
  try {
    const old = await createProfileBackup(f);
    expect(old.manifest.version).toBe(5);
    expect(old.manifest.assets.mcpSourceApprovalIntents).toBeUndefined();
    const badSource = row(f.storeId);
    badSource.bodySha256 = 'a'.repeat(64);
    const invalidSourceBytes = write(f.path, [badSource]);
    await expect(createProfileBackup(f)).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(invalidSourceBytes);
    write(f.path, [row(f.storeId)]);
    const backup = await createProfileBackup(f);
    const ready = join(backup.directory, 'ready.json');
    const manifest = JSON.parse(readFileSync(ready, 'utf8'));
    const disguised = structuredClone(manifest);
    disguised.version = 9;
    delete disguised.assets.mcpSourceApprovalIntents;
    writeFileSync(ready, JSON.stringify(disguised));
    await expect(inspectProfileBackup(backup)).rejects.toThrow();
    writeFileSync(ready, JSON.stringify(manifest));
    const path = join(backup.directory, 'ui/mcp-source-approval-intents.json');
    const invalid = Buffer.from(
      JSON.stringify({ version: 1, records: [{ ...row(f.storeId), phase: 'applied' }] }),
    );
    writeFileSync(path, invalid);
    manifest.assets.mcpSourceApprovalIntents.proof = proof(invalid);
    writeFileSync(ready, JSON.stringify(manifest));
    const original = readFileSync(f.path);
    await expect(
      restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.storeId,
        backup,
        intent: 'replace_with_selected_backup',
      }),
    ).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(original);
    expect(existsSync(join(selectProfile(f.profile).profilePath, 'restore.json'))).toBe(false);
    const store = await openSqliteStore(f.profile);
    try {
      expect((await store.getMetadata()).storeId).toBe(f.storeId);
    } finally {
      await store.close();
    }
  } finally {
    f.close();
  }
}, 30000);
