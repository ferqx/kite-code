import { afterAll, beforeAll, expect, test } from 'bun:test';
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
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { parseManifest } from '../../../src/maintenance/manifest';
import { verifyMcpReconnectionIntentsDocument } from '../../../src/maintenance/mcp-reconnection-intents';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';

let qualified: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>> | undefined;
beforeAll(async () => {
  qualified = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => qualified?.close());
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const proof = (v: Uint8Array) => ({ sha256: hash(v), byteLength: String(v.length) });
function row(storeId: string, index = 0) {
  const targetRequest = {
    expectedStoreId: storeId,
    commandId: `warm_carrier_B_${index}`,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.connect',
    definitionVersion: '1',
    input: { serverId: 'static_server', key: `carrier_B_${index}` },
  };
  const request = {
    expectedStoreId: storeId,
    commandId: `reconnect_${index}`,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.reconnect',
    definitionVersion: '1',
    input: {
      serverId: 'static_server',
      key: `replacement_${index}`,
      target: {
        carrierExecutionId: `carrier_execution_B_${index}`,
        carrierKey: `carrier_B_${index}`,
        operationRef: {
          commandId: `original_job_A_${index}`,
          sessionId: 'original_s',
          originStoreId: storeId,
          extensionId: 'builtin.mcp',
          key: `connection/static_server/job_A_${index}`,
          executionId: `original_connection_${index}`,
        },
        connectionExecutionId: `original_connection_${index}`,
        configDigest: 'a'.repeat(64),
        currentGeneration: 2,
      },
      replacement: {
        kind: 'source',
        expectedConfigDigest: 'b'.repeat(64),
        expectedReadSet: {
          scopeDigest: 'c'.repeat(64),
          user: {
            identity: { kind: 'user', pathDigest: 'd'.repeat(64), rootIdentity: 'e'.repeat(64) },
            etag: null,
            error: null,
          },
          workspace: null,
          approvalEtag: null,
          bindingEtag: 'f'.repeat(64),
          variablesDigest: '1'.repeat(64),
        },
      },
    },
  };
  return seal({
    intent: {
      sessionId: 'original_s',
      workspaceId: 'original_w',
      workspaceIdentity: '原目录\r\n:dev:ino',
      targetRequest,
      request,
    },
    subjectId: 'original_subject',
    bodySha256: '',
    requestSha256: '',
    phase: 'outcome_unknown',
  });
}
function seal<
  T extends {
    intent: { request: { commandId: string; expectedStoreId: string } };
    bodySha256: string;
    requestSha256: string;
  },
>(value: T): T {
  value.bodySha256 = hash(canonicalJson(value.intent.request));
  const { commandId: _id, expectedStoreId: _store, ...request } = value.intent.request;
  value.requestSha256 = hash(canonicalJson(request));
  return value;
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-reconnection-assets-')));
  chmodSync(root, 0o700);
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  let storeId: string;
  try {
    storeId = (await store.getMetadata()).storeId;
  } finally {
    await store.close();
  }
  const path = join(selectProfile(profile).profilePath, 'ui/mcp-reconnection-intents.json');
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  return {
    root,
    profile,
    storeId,
    path,
    destinationRoot: join(root, 'backups'),
    close() {
      rmSync(root, { recursive: true });
      const confirmed = !existsSync(root);
      console.log(JSON.stringify({ stage: 'reconnection_asset_cleanup', confirmed }));
      if (!confirmed) throw Error('owned_root_cleanup_unconfirmed');
    },
  };
}
function write(path: string, records: unknown[], padding = 0) {
  const bytes = Buffer.from(
    `${JSON.stringify({ version: 1, records }, null, 2)}\r\n${' '.repeat(padding)}`,
  );
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}

test('public v11 create/inspect/restore retains original source/static and previous reconnect bytes and identities across Store replacement', async () => {
  const f = await fixture();
  try {
    const source = row(f.storeId);
    const staticRow = row(f.storeId, 1);
    Object.assign(staticRow.intent.request.input, {
      replacement: { kind: 'static', expectedConfigDigest: '2'.repeat(64) },
    });
    seal(staticRow);
    staticRow.phase = 'ready';
    // A previous reconnect is a complete finite request, not a recursively saved intent.
    const next = row(f.storeId, 2);
    Object.assign(next.intent, { targetRequest: structuredClone(source.intent.request) });
    next.intent.request.input.target.carrierKey = source.intent.request.input.key;
    seal(next);
    next.phase = 'cancelled';
    const original = [source, staticRow, next];
    const bytes = write(f.path, original);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(11);
    expect(backup.manifest.assets.mcpReconnectionIntents).toMatchObject({
      path: 'ui/mcp-reconnection-intents.json',
      present: true,
      format: { version: 1 },
      proof: proof(bytes),
    });
    for (const asset of [
      'mcpSourceApprovalIntents',
      'mcpConnectionIntents',
      'mcpSelectionIntents',
      'fileRecoveryIntents',
      'callerIntents',
      'tuiRecovery',
    ] as const)
      expect(backup.manifest.assets[asset]).toMatchObject({
        present: false,
        format: null,
        proof: null,
      });
    expect(readFileSync(join(backup.directory, 'ui/mcp-reconnection-intents.json'))).toEqual(bytes);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    expect(readFileSync(f.path)).toEqual(bytes);
    verifyMcpReconnectionIntentsDocument(f.path);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).records).toEqual(original);
    for (const r of original) {
      expect(r.intent.request.expectedStoreId).toBe(f.storeId);
      expect(r.intent.targetRequest.expectedStoreId).toBe(f.storeId);
      expect(r.intent.request.input.target.operationRef.originStoreId).toBe(f.storeId);
    }
    const store = await openSqliteStore(f.profile);
    try {
      expect((await store.getMetadata()).storeId).toBe(restored.storeId);
    } finally {
      await store.close();
    }
    console.log(
      JSON.stringify({
        stage: 'reconnection_backup_restore',
        originalStoreId: f.storeId,
        currentStoreId: restored.storeId,
        byteLength: bytes.length,
        sha256: hash(bytes),
        commandIds: original.map((r) => r.intent.request.commandId),
        carrierCommandIds: original.map((r) => r.intent.targetRequest.commandId),
        originalJobCommandIds: original.map(
          (r) => r.intent.request.input.target.operationRef.commandId,
        ),
        phases: original.map((r) => r.phase),
      }),
    );
  } finally {
    f.close();
  }
}, 30000);

test('closed reconnect codec rejects rehashed shape, identity, replacement and collision corruption without assigning authority', async () => {
  const f = await fixture();
  try {
    type Row = ReturnType<typeof row>;
    const changes: ((r: Row) => void)[] = [
      (r) => {
        Object.assign(r, { authority: true });
      },
      (r) => {
        Object.assign(r.intent, { permission: true });
      },
      (r) => {
        Object.assign(r.intent.targetRequest, { targetRequest: {} });
      },
      (r) => {
        r.intent.request.actionId = 'mcp.connect';
      },
      (r) => {
        r.intent.request.definitionVersion = '2';
      },
      (r) => {
        r.intent.targetRequest.actionId = 'mcp.refresh';
      },
      (r) => {
        r.intent.targetRequest.expectedStoreId = 'foreign';
      },
      (r) => {
        r.intent.targetRequest.input.serverId = 'other';
      },
      (r) => {
        r.intent.request.input.target.carrierKey = 'other';
      },
      (r) => {
        r.intent.request.input.key = r.intent.targetRequest.input.key;
      },
      (r) => {
        r.intent.request.input.key = r.intent.request.input.target.operationRef.key.split('/')[2]!;
      },
      (r) => {
        r.intent.request.commandId = r.intent.targetRequest.commandId;
      },
      (r) => {
        r.intent.request.commandId = r.intent.request.input.target.operationRef.commandId;
      },
      (r) => {
        r.intent.request.input.target.operationRef.originStoreId = 'foreign';
      },
      (r) => {
        r.intent.request.input.target.operationRef.sessionId = 'foreign_session';
      },
      (r) => {
        r.intent.request.input.target.operationRef.executionId = 'other_execution';
      },
      (r) => {
        r.intent.request.input.target.operationRef.key = 'job_A_0';
      },
      (r) => {
        r.intent.request.input.target.operationRef.key = 'connection/other/job_A_0';
      },
      (r) => {
        r.intent.request.input.target.operationRef.extensionId = 'other';
      },
      (r) => {
        Object.assign(r.intent.request.input.target.operationRef, { childSessionId: 'child' });
      },
      (r) => {
        r.intent.request.input.target.currentGeneration = 0;
      },
      (r) => {
        r.intent.request.input.target.currentGeneration = Number.MAX_SAFE_INTEGER + 1;
      },
      (r) => {
        r.intent.request.input.target.configDigest = 'invalid';
      },
      (r) => {
        r.intent.request.input.target.connectionExecutionId = '';
      },
      (r) => {
        Object.assign(r.intent.request.input.target, { currentReady: true });
      },
      (r) => {
        r.intent.request.input.replacement.kind = 'unknown';
      },
      (r) => {
        r.intent.request.input.replacement.expectedConfigDigest = 'bad';
      },
      (r) => {
        Object.assign(r.intent.request.input.replacement, { credential: 'not-a-field' });
      },
      (r) => {
        Object.assign(r.intent.request.input.replacement.expectedReadSet, { selected: true });
      },
      (r) => {
        r.intent.request.input.replacement.expectedReadSet.user.identity.kind = 'workspace';
      },
      (r) => {
        r.intent.request.input.replacement.expectedReadSet.scopeDigest = 'bad';
      },
      (r) => {
        Object.assign(r.intent.request.input.replacement.expectedReadSet, {
          workspace: {
            identity: { kind: 'user', pathDigest: 'a'.repeat(64), rootIdentity: 'b'.repeat(64) },
            etag: null,
            error: null,
          },
        });
      },
      (r) => {
        Object.assign(r.intent.request.input.replacement.expectedReadSet.user, { error: 4 });
      },
      (r) => {
        r.phase = 'saved';
      },
      (r) => {
        Object.assign(r, { phase: ['ready'] });
      },
    ];
    for (const change of changes) {
      const bad = row(f.storeId);
      change(bad);
      seal(bad);
      write(f.path, [bad]);
      expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    }
    for (const field of ['bodySha256', 'requestSha256'] as const) {
      const bad = row(f.storeId);
      bad[field] = '0'.repeat(64);
      write(f.path, [bad]);
      expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    }
    const workspaceRead = row(f.storeId);
    Object.assign(workspaceRead.intent.request.input.replacement.expectedReadSet, {
      workspace: {
        identity: { kind: 'workspace', pathDigest: '2'.repeat(64), rootIdentity: '3'.repeat(64) },
        etag: null,
        error: '原始错误\r\n'.repeat(1000),
      },
    });
    seal(workspaceRead);
    const workspaceBytes = write(f.path, [workspaceRead]);
    verifyMcpReconnectionIntentsDocument(f.path);
    expect(readFileSync(f.path)).toEqual(workspaceBytes);
    const previousReconnect = row(f.storeId, 1);
    const next = row(f.storeId, 2);
    Object.assign(next.intent, { targetRequest: previousReconnect.intent.request });
    next.intent.request.input.target.carrierKey = previousReconnect.intent.request.input.key;
    seal(next);
    previousReconnect.intent.request.input.target.operationRef.sessionId = 'foreign_session';
    write(f.path, [next]);
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    previousReconnect.intent.request.input.target.operationRef.sessionId = 'original_s';
    Object.assign(previousReconnect.intent.request.input.target.operationRef, { extra: true });
    write(f.path, [next]);
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    for (const document of [
      { version: 1, records: [], extra: true },
      { version: 1, records: {} },
      { version: 1 },
    ]) {
      writeFileSync(f.path, JSON.stringify(document));
      expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    }
    const original = row(f.storeId);
    write(f.path, [original, original]);
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    for (const phase of [
      'submitting',
      'pending',
      'ready',
      'failed',
      'cancelled',
      'outcome_unknown',
    ]) {
      const valid = row(f.storeId);
      valid.phase = phase;
      const bytes = write(f.path, [valid]);
      verifyMcpReconnectionIntentsDocument(f.path);
      expect(readFileSync(f.path)).toEqual(bytes);
    }
    writeFileSync(f.path, Buffer.from([0xff]));
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    writeFileSync(f.path, JSON.stringify({ version: 2, records: [] }));
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
  } finally {
    f.close();
  }
});

test('128 original unknown rows and exact 16MiB accepted; excess, unsafe permissions, hardlink and symlink rejected', async () => {
  const f = await fixture();
  try {
    const records = Array.from({ length: 128 }, (_, i) => row(f.storeId, i));
    const base = write(f.path, records);
    const bytes = write(f.path, records, 16 * 1024 * 1024 - base.length);
    expect(bytes.length).toBe(16 * 1024 * 1024);
    verifyMcpReconnectionIntentsDocument(f.path);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(11);
    expect(readFileSync(join(backup.directory, 'ui/mcp-reconnection-intents.json'))).toEqual(bytes);
    expect(
      (await inspectProfileBackup(backup)).manifest.assets.mcpReconnectionIntents?.proof,
    ).toEqual(proof(bytes));
    write(f.path, records, 16 * 1024 * 1024 - base.length + 1);
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    write(f.path, [...records, row(f.storeId, 128)]);
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    write(f.path, [records[0]]);
    chmodSync(f.path, 0o644);
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    chmodSync(f.path, 0o600);
    const hard = join(f.root, 'hard');
    linkSync(f.path, hard);
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
    unlinkSync(hard);
    const source = join(f.root, 'source');
    writeFileSync(source, readFileSync(f.path), { mode: 0o600 });
    unlinkSync(f.path);
    symlinkSync(source, f.path);
    expect(() => verifyMcpReconnectionIntentsDocument(f.path)).toThrow();
  } finally {
    f.close();
  }
}, 30000);

test('absent reconnect asset keeps old version; old v2-v10 physical whitelist and rehashed invalid v11 restore remain closed', async () => {
  const f = await fixture();
  try {
    const old = await createProfileBackup(f);
    expect(old.manifest.version).toBe(5);
    expect(old.manifest.assets.mcpReconnectionIntents).toBeUndefined();
    const invalidSource = row(f.storeId);
    invalidSource.bodySha256 = '0'.repeat(64);
    const invalidSourceBytes = write(f.path, [invalidSource]);
    await expect(createProfileBackup(f)).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(invalidSourceBytes);
    write(f.path, [row(f.storeId)]);
    const backup = await createProfileBackup(f);
    const ready = join(backup.directory, 'ready.json');
    const manifest = JSON.parse(readFileSync(ready, 'utf8'));
    for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
      const disguised = structuredClone(manifest);
      disguised.version = version;
      delete disguised.assets.mcpReconnectionIntents;
      if (version < 10) delete disguised.assets.mcpSourceApprovalIntents;
      if (version < 9) delete disguised.assets.mcpConnectionIntents;
      if (version < 8) delete disguised.assets.mcpSelectionIntents;
      if (version < 6) delete disguised.assets.fileRecoveryIntents;
      if (version < 4) delete disguised.assets.callerIntents;
      if (version < 3) delete disguised.assets.tuiRecovery;
      writeFileSync(ready, JSON.stringify(disguised));
      expect(parseManifest(disguised).version).toBe(version);
      let error: unknown;
      try {
        await inspectProfileBackup(backup);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'backup_unexpected_asset' });
    }
    for (const mutation of [
      (m: typeof manifest) => {
        m.version = 12;
      },
      (m: typeof manifest) => {
        m.assets.mcpReconnectionIntents.format.version = 2;
      },
      (m: typeof manifest) => {
        m.assets.mcpReconnectionIntents.path = 'ui/mcp.json';
      },
      (m: typeof manifest) => {
        m.assets.authority = true;
      },
    ]) {
      const bad = structuredClone(manifest);
      mutation(bad);
      writeFileSync(ready, JSON.stringify(bad));
      await expect(inspectProfileBackup(backup)).rejects.toThrow();
    }
    const invalid = row(f.storeId);
    invalid.intent.request.input.key =
      invalid.intent.request.input.target.operationRef.key.split('/')[2]!;
    seal(invalid);
    const path = join(backup.directory, 'ui/mcp-reconnection-intents.json');
    const invalidBytes = write(path, [invalid]);
    manifest.assets.mcpReconnectionIntents.proof = proof(invalidBytes);
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
