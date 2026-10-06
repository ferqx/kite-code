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
import { verifyMcpSourceMutationIntentsDocument } from '../../../src/maintenance/mcp-source-mutation-intents';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';

let qualified: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>> | undefined;
beforeAll(async () => {
  qualified = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => qualified?.close());

const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
function row(storeId: string, index = 0) {
  const request = {
    expectedStoreId: storeId,
    commandId: `source_${index}`,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId: 'mcp.source.add',
    definitionVersion: '1',
    input: {
      scope: 'workspace',
      name: 'owned-server',
      entry: { type: 'http', url: 'http://127.0.0.1:12345/mcp' },
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
    subjectId: 'original_subject_原始\r\n',
    bodySha256: hash(canonicalJson(request)),
    requestSha256: hash(canonicalJson(publicRequest)),
    phase: 'outcome_unknown',
  };
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-mutation-assets-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'original_w',
    rootUri: 'file:///owned-maintenance-fixture',
    name: 'original',
  });
  await store.createSession({
    expectedStoreId: storeId,
    sessionId: 'original_s',
    workspaceId: 'original_w',
    commandId: 'original_create',
    subjectId: 'original_subject_原始\r\n',
    title: '原始 Session',
  });
  const originalSession = await store.getSession('original_s');
  await store.close();
  if (!originalSession) throw Error('original_session_missing');
  const path = join(selectProfile(profile).profilePath, 'ui/mcp-source-mutation-intents.json');
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  return {
    root,
    profile,
    storeId,
    originalSession,
    path,
    destinationRoot: join(root, 'backups'),
    close: () => {
      rmSync(root, { recursive: true, force: true });
      const rootRemoved = !existsSync(root);
      console.log(JSON.stringify({ case: 'source_mutation_asset_cleanup', root, rootRemoved }));
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

test('public v12 create/inspect/restore preserves whole original A intent bytes, hashes and identities without rewriting to Store B', async () => {
  const f = await fixture();
  try {
    const removal = structuredClone(row(f.storeId, 3));
    Object.assign(removal.intent.request, {
      actionId: 'mcp.source.remove',
      input: {
        scope: 'user',
        serverId: `mcp-${'a'.repeat(64)}`,
        expectedRawEntryDigest: '4'.repeat(64),
        expectedReadSet: removal.intent.request.input.expectedReadSet,
      },
    });
    reseal(removal);
    const original = [
      row(f.storeId),
      { ...row(f.storeId, 1), phase: 'saved' },
      { ...row(f.storeId, 2), phase: 'cancelled' },
      removal,
    ];
    const bytes = write(f.path, original);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(12);
    expect(backup.manifest.assets.mcpSourceMutationIntents).toMatchObject({
      path: 'ui/mcp-source-mutation-intents.json',
      present: true,
      format: { version: 1 },
      proof: proof(bytes),
    });
    expect(backup.manifest.assets.mcpReconnectionIntents).toMatchObject({
      present: false,
      format: null,
      proof: null,
    });
    expect(backup.manifest.assets.mcpSourceApprovalIntents).toMatchObject({
      present: false,
      format: null,
      proof: null,
    });
    expect(backup.manifest.assets.mcpSelectionIntents).toMatchObject({
      present: false,
      format: null,
      proof: null,
    });
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect(readFileSync(join(backup.directory, 'ui/mcp-source-mutation-intents.json'))).toEqual(
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
    verifyMcpSourceMutationIntentsDocument(f.path);
    const records = JSON.parse(readFileSync(f.path, 'utf8')).records;
    expect(records).toEqual(original);
    expect(records[0].intent.request.expectedStoreId).toBe(f.storeId);
    console.log(
      JSON.stringify({
        case: 'source_mutation_intent_backup_restore',
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
      // Public restore invalidates old owners; business Session identity and content remain original.
      expect(await store.getSession('original_s')).toEqual({
        ...f.originalSession,
        ownerGeneration: String(BigInt(f.originalSession.ownerGeneration) + 1n),
      });
    } finally {
      await store.close();
    }
  } finally {
    f.close();
  }
}, 30000);

function reseal(r: ReturnType<typeof row>) {
  r.bodySha256 = hash(canonicalJson(r.intent.request));
  const { commandId: _c, expectedStoreId: _s, ...request } = r.intent.request;
  r.requestSha256 = hash(canonicalJson(request));
}
test('closed mutation inputs reject extra fields and unsafe declarations even with correct inner hashes', async () => {
  const f = await fixture();
  try {
    const original = row(f.storeId);
    const changes: ((r: ReturnType<typeof row>) => void)[] = [
      (r) => {
        r.intent.request.actionId = 'mcp.source.approve';
      },
      (r) => {
        r.intent.request.definitionVersion = '2';
      },
      (r) => {
        r.intent.request.input.name = 'constructor';
      },
      (r) => {
        r.intent.request.input.name = 'prototype';
      },
      (r) => {
        r.intent.request.input.name = ' bad';
      },
      (r) => {
        r.intent.request.input.entry.url = 'https://u:p@example.com';
      },
      (r) => {
        r.intent.request.input.entry.url = 'https://example.com/?secret=a';
      },
      (r) => {
        r.intent.request.input.entry.url = 'https://example.com/#a';
      },
      (r) => {
        r.intent.request.input.entry.url = 'file:///tmp/a';
      },
      (r) => {
        r.intent.request.input.entry.url = 'https://example.com/?';
      },
      (r) => {
        r.intent.request.input.entry.url = 'https://example.com/#';
      },
      (r) => {
        r.intent.request.input.entry.url = 'https://example.com/' + '${' + 'TOKEN}';
      },
      (r) => {
        r.intent.request.input.entry.url = 'https://example.com/\n';
      },
      (r) => {
        Object.assign(r.intent.request.input.entry, { header: { Authorization: 'opaque' } });
      },
      (r) => {
        Object.assign(r.intent.request.input, { scope: 'system' });
      },
      (r) => {
        Object.assign(r.intent.request.input.expectedReadSet, { workspace: null });
      },
      (r) => {
        r.intent.request.input.expectedReadSet.user.identity.kind = 'workspace';
      },
      (r) => {
        r.intent.request.input.expectedReadSet.variablesDigest = 'bad';
      },
      (r) => {
        Object.assign(r.intent, { postPermit: true });
      },
      (r) => {
        Object.assign(r, { authority: true });
      },
      (r) => {
        r.phase = 'ready';
      },
    ];
    for (const change of changes) {
      const r = structuredClone(original);
      change(r);
      reseal(r);
      write(f.path, [r]);
      expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    }
    for (const command of ['relative', '/tmp/' + '${' + 'SECRET}', '/tmp/x\n']) {
      const r = structuredClone(original);
      Object.assign(r.intent.request.input, { entry: { type: 'stdio', command } });
      reseal(r);
      write(f.path, [r]);
      expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    }
    const stdio = structuredClone(original);
    Object.assign(stdio.intent.request.input, {
      entry: { type: 'stdio', command: '/tmp/owned-tool' },
    });
    reseal(stdio);
    write(f.path, [stdio]);
    verifyMcpSourceMutationIntentsDocument(f.path);
    for (const field of ['bodySha256', 'requestSha256'] as const) {
      const r = structuredClone(original);
      r[field] = '0'.repeat(64);
      write(f.path, [r]);
      expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    }
    for (const phase of [
      'submitting',
      'pending',
      'saved',
      'failed',
      'cancelled',
      'outcome_unknown',
    ]) {
      const r = { ...original, phase };
      const bytes = write(f.path, [r]);
      verifyMcpSourceMutationIntentsDocument(f.path);
      expect(readFileSync(f.path)).toEqual(bytes);
    }
    write(f.path, [original, original]);
    expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    for (const content of [
      Buffer.from([0xff]),
      Buffer.from(JSON.stringify({ version: 2, records: [] })),
      Buffer.from(JSON.stringify({ version: 1, records: [], extra: true })),
    ]) {
      writeFileSync(f.path, content);
      expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    }
  } finally {
    f.close();
  }
});
test('128 records and 16MiB bytes are preserved; excess and unsafe private files reject', async () => {
  const f = await fixture();
  try {
    const rows = Array.from({ length: 128 }, (_, i) => row(f.storeId, i));
    const base = write(f.path, rows);
    const bytes = write(f.path, rows, 16 * 1024 * 1024 - base.length);
    expect(bytes.length).toBe(16 * 1024 * 1024);
    verifyMcpSourceMutationIntentsDocument(f.path);
    expect(readFileSync(f.path)).toEqual(bytes);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(12);
    expect(
      (await inspectProfileBackup(backup)).manifest.assets.mcpSourceMutationIntents?.proof,
    ).toEqual(proof(bytes));
    expect(readFileSync(join(backup.directory, 'ui/mcp-source-mutation-intents.json'))).toEqual(
      bytes,
    );
    write(f.path, rows, 16 * 1024 * 1024 - base.length + 1);
    expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    write(f.path, [...rows, row(f.storeId, 128)]);
    expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    write(f.path, [rows[0]]);
    chmodSync(f.path, 0o644);
    expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    chmodSync(f.path, 0o600);
    const hard = join(f.root, 'hard');
    linkSync(f.path, hard);
    expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
    unlinkSync(hard);
    const source = join(f.root, 'source');
    writeFileSync(source, readFileSync(f.path), { mode: 0o600 });
    unlinkSync(f.path);
    symlinkSync(source, f.path);
    expect(() => verifyMcpSourceMutationIntentsDocument(f.path)).toThrow();
  } finally {
    f.close();
  }
}, 30000);
test('absence preserves old version; all old versions and recomputed outer proofs refuse new journal', async () => {
  const f = await fixture();
  try {
    const old = await createProfileBackup(f);
    expect(old.manifest.version).toBe(5);
    expect(old.manifest.assets.mcpSourceMutationIntents).toBeUndefined();
    write(f.path, [row(f.storeId)]);
    const backup = await createProfileBackup(f);
    const ready = join(backup.directory, 'ready.json');
    const manifest = JSON.parse(readFileSync(ready, 'utf8'));
    for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const) {
      const bad = structuredClone(manifest);
      bad.version = version;
      delete bad.assets.mcpSourceMutationIntents;
      if (version < 11) delete bad.assets.mcpReconnectionIntents;
      if (version < 10) delete bad.assets.mcpSourceApprovalIntents;
      if (version < 9) delete bad.assets.mcpConnectionIntents;
      if (version < 8) delete bad.assets.mcpSelectionIntents;
      if (version < 6) delete bad.assets.fileRecoveryIntents;
      if (version < 4) delete bad.assets.callerIntents;
      if (version < 3) delete bad.assets.tuiRecovery;
      expect(parseManifest(bad).version).toBe(version);
      writeFileSync(ready, JSON.stringify(bad));
      let error: unknown;
      try {
        await inspectProfileBackup(backup);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'backup_unexpected_asset' });
      bad.assets.mcpSourceMutationIntents = manifest.assets.mcpSourceMutationIntents;
      expect(() => parseManifest(bad)).toThrow();
    }
    const current = parseManifest({ ...manifest, version: 13 });
    expect(current.version).toBe(13);
    expect(current.assets.mcpSourceMutationIntents).toEqual(
      manifest.assets.mcpSourceMutationIntents,
    );
    for (const change of [
      (m: typeof manifest) => {
        m.version = 14;
      },
      (m: typeof manifest) => {
        m.assets.mcpSourceMutationIntents.format.version = 2;
      },
      (m: typeof manifest) => {
        m.assets.mcpSourceMutationIntents.path = 'ui/mcp.json';
      },
      (m: typeof manifest) => {
        m.assets.mcpSourceMutationIntents.authority = true;
      },
    ]) {
      const bad = structuredClone(manifest);
      change(bad);
      expect(() => parseManifest(bad)).toThrow();
    }
    const corrupt = Buffer.from(
      JSON.stringify({ version: 1, records: [{ ...row(f.storeId), phase: 'applied' }] }),
    );
    writeFileSync(join(backup.directory, 'ui/mcp-source-mutation-intents.json'), corrupt);
    manifest.assets.mcpSourceMutationIntents.proof = proof(corrupt);
    writeFileSync(ready, JSON.stringify(manifest));
    const before = readFileSync(f.path);
    await expect(
      restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.storeId,
        backup,
        intent: 'replace_with_selected_backup',
      }),
    ).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(before);
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
