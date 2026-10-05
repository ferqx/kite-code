import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  inspectProfileRestore,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { verifyMcpSelectionIntentsDocument } from '../../../src/maintenance/mcp-selection-intents';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';
import { nodeAssets } from './assets-fixture';
import {
  coldNodeMcpAssets,
  type SelectionRecord,
  seedMcpSelectionAssets,
} from './mcp-selection-assets-fixture';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function proofs(row: SelectionRecord) {
  const { commandId: _id, expectedStoreId: _store, ...request } = row.intent.request;
  row.bodySha256 = hash(canonicalJson(row.intent.request as unknown as Json));
  row.requestSha256 = hash(canonicalJson(request as unknown as Json));
  return row;
}
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-mcp-maintenance-');
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.close();
  return {
    root,
    profile,
    storeId,
    path: join(selectProfile(profile).profilePath, 'ui/mcp-selection-intents.json'),
    destinationRoot: join(root, 'backups'),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function write(path: string, records: SelectionRecord[], version = 1) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify({ version, records }, null, 2)}\r\n`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}
async function code(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test('real journal owner v1 and actual cold Node preserve exact old scope, subject, readSet and two hashes through DB5/v8 new-Store restore without HTTP authority', async () => {
  const f = await fixture();
  try {
    await nodeAssets(f.root, f.profile, f.storeId);
    const original = await seedMcpSelectionAssets(f.profile, f.storeId);
    const before = readFileSync(f.path);
    const warm = await coldNodeMcpAssets(f.root, f.profile, f.storeId);
    expect(warm.records).toEqual(original);
    expect(warm.scope).toBe('original');
    expect(original.map((r) => r.phase)).toEqual(['failed', 'outcome_unknown']);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(8);
    expect(backup.manifest.assets.desktopUi.format?.userVersion).toBe(5);
    expect(backup.manifest.assets.fileRecoveryIntents).toMatchObject({
      present: false,
      proof: null,
      format: null,
    });
    expect(backup.manifest.assets.mcpSelectionIntents).toMatchObject({
      path: 'ui/mcp-selection-intents.json',
      present: true,
      format: { version: 1 },
      proof: { sha256: hash(before), byteLength: String(before.length) },
    });
    expect(readFileSync(f.path)).toEqual(before);
    expect(readFileSync(join(backup.directory, 'ui/mcp-selection-intents.json'))).toEqual(before);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    const store = await openSqliteStore(f.profile);
    let currentStoreId: string;
    try {
      currentStoreId = (await store.getMetadata()).storeId;
    } finally {
      await store.close();
    }
    expect(currentStoreId).toBe(restored.storeId);
    const cold = await coldNodeMcpAssets(f.root, f.profile, currentStoreId);
    expect(cold.records).toEqual(original);
    expect(cold.scope).toBe('foreign');
    expect(cold.queryAdmission).toBe('unavailable_foreign_store');
    expect(cold.getRequests).toBe(0);
    expect(cold.postRequests).toBe(0);
    expect(cold.sha256).toBe(hash(before));
    expect(cold.byteLength).toBe(before.length);
    expect(readFileSync(f.path)).toEqual(before);
    console.log(
      JSON.stringify({
        originalStoreId: f.storeId,
        restoredStoreId: restored.storeId,
        commandIds: original.map((r) => r.intent.request.commandId),
        subjectIds: original.map((r) => r.subjectId),
        byteLength: before.length,
        sha256: hash(before),
        bodySha256: original.map((r) => r.bodySha256),
        requestSha256: original.map((r) => r.requestSha256),
        coldScope: cold.scope,
        queryAdmission: cold.queryAdmission,
        getRequests: cold.getRequests,
        postRequests: cold.postRequests,
      }),
    );
  } finally {
    f.close();
  }
}, 30000);

test('fixed action/readSet/scope/phase/two hashes and closed document reject inner damage without source changes or pruning', async () => {
  const f = await fixture();
  try {
    const records = await seedMcpSelectionAssets(f.profile, f.storeId);
    const changes: ((r: SelectionRecord) => void)[] = [
      (r) => {
        r.phase = 'future';
      },
      (r) => {
        r.bodySha256 = '0'.repeat(64);
      },
      (r) => {
        r.requestSha256 = '0'.repeat(64);
      },
      (r) => {
        r.subjectId = 'x'.repeat(257);
      },
      (r) => {
        r.intent.workspaceIdentity = '';
      },
      (r) => {
        r.intent.request.actionId = 'mcp.server.other';
        proofs(r);
      },
      (r) => {
        r.intent.request.extensionId = 'other';
        proofs(r);
      },
      (r) => {
        r.intent.request.definitionVersion = '2';
        proofs(r);
      },
      (r) => {
        r.intent.request.input.scope = 'other';
        proofs(r);
      },
      (r) => {
        r.intent.request.input.expectedReadSet.registryDigest = 'bad';
        proofs(r);
      },
      (r) => {
        r.intent.request.input.expectedReadSet.registryRevision = '';
        proofs(r);
      },
      (r) => {
        r.intent.request.input.scope = 'workspace';
        r.intent.request.input.expectedReadSet.workspaceEtag = null;
        proofs(r);
      },
      (r) => {
        Object.assign(r, { authority: true });
      },
      (r) => {
        Object.assign(r.intent.request, { token: 'forged' });
        proofs(r);
      },
      (r) => {
        Object.assign(r.intent.request.input.expectedReadSet, { future: true });
        proofs(r);
      },
    ];
    for (const change of changes) {
      const row = structuredClone(records[0]!);
      change(row);
      const bytes = write(f.path, [row]);
      expect(await code(createProfileBackup(f))).toBe('backup_mcp_selection_intents_invalid');
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
    }
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from(JSON.stringify({ version: 2, records })),
      Buffer.from(JSON.stringify({ version: 1, records, future: true })),
      Buffer.from(JSON.stringify({ version: 1, records: [records[0], records[0]] })),
    ]) {
      writeFileSync(f.path, bytes);
      expect(await code(createProfileBackup(f))).toBe('backup_mcp_selection_intents_invalid');
      expect(readFileSync(f.path)).toEqual(bytes);
    }
  } finally {
    f.close();
  }
}, 30000);

test('128 unknown identities and exactly 16MiB raw JSON retain full bytes; count/size and unsafe linked files reject', async () => {
  const f = await fixture();
  try {
    const records = await seedMcpSelectionAssets(f.profile, f.storeId, 128);
    const bytes = readFileSync(f.path);
    const full = Buffer.concat([bytes, Buffer.alloc(16 * 1024 * 1024 - bytes.length, 0x20)]);
    writeFileSync(f.path, full);
    verifyMcpSelectionIntentsDocument(f.path);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(8);
    expect(readFileSync(join(backup.directory, 'ui/mcp-selection-intents.json'))).toEqual(full);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).records).toHaveLength(128);
    expect(readFileSync(f.path)).toEqual(full);
    writeFileSync(f.path, Buffer.concat([full, Buffer.from(' ')]));
    expect(await code(createProfileBackup(f))).toBe('backup_mcp_selection_intents_invalid');
    const extra = structuredClone(records[0]!);
    extra.intent.request.commandId = 'overflow';
    proofs(extra);
    write(f.path, [...records, extra]);
    expect(await code(createProfileBackup(f))).toBe('backup_mcp_selection_intents_invalid');
    write(f.path, records);
    chmodSync(f.path, 0o644);
    expect(await code(createProfileBackup(f))).not.toBe('success');
    chmodSync(f.path, 0o600);
    const outside = join(f.root, 'original.json');
    linkSync(f.path, outside);
    expect(await code(createProfileBackup(f))).not.toBe('success');
    rmSync(f.path);
    symlinkSync(outside, f.path);
    expect(await code(createProfileBackup(f))).not.toBe('success');
  } finally {
    f.close();
  }
}, 30000);

test('v8 is a closed new asset, old v2-v7 remain strict, absent file stays absent, and rehashed bad inner data never restores', async () => {
  const f = await fixture();
  try {
    const absent = await createProfileBackup(f);
    expect(absent.manifest.version).toBe(5);
    expect(absent.manifest.assets.mcpSelectionIntents).toBeUndefined();
    expect(existsSync(f.path)).toBe(false);
    const records = await seedMcpSelectionAssets(f.profile, f.storeId);
    const original = readFileSync(f.path),
      backup = await createProfileBackup(f);
    const ready = join(backup.directory, 'ready.json');
    for (const version of [2, 3, 4, 5, 6, 7, 9]) {
      const manifest = structuredClone(backup.manifest);
      manifest.version = version as typeof manifest.version;
      writeFileSync(ready, JSON.stringify(manifest));
      expect(await code(inspectProfileBackup(backup))).toBe('backup_invalid_manifest');
    }
    const disguised = structuredClone(backup.manifest);
    disguised.version = 7;
    delete disguised.assets.mcpSelectionIntents;
    writeFileSync(ready, JSON.stringify(disguised));
    expect(await code(inspectProfileBackup(backup))).toBe('backup_unexpected_asset');
    for (const format of [{ version: 2 }, { version: 1, authority: true }]) {
      const manifest = structuredClone(backup.manifest);
      Object.assign(manifest.assets.mcpSelectionIntents!, { format });
      writeFileSync(ready, JSON.stringify(manifest));
      expect(await code(inspectProfileBackup(backup))).toBe('backup_invalid_manifest');
    }
    const damaged = structuredClone(records);
    damaged[0]!.requestSha256 = '0'.repeat(64);
    const copy = join(backup.directory, 'ui/mcp-selection-intents.json'),
      bad = write(copy, damaged);
    backup.manifest.assets.mcpSelectionIntents!.proof = {
      sha256: hash(bad),
      byteLength: String(bad.length),
    };
    writeFileSync(ready, JSON.stringify(backup.manifest));
    expect(await code(inspectProfileBackup(backup))).toBe('backup_mcp_selection_intents_invalid');
    expect(
      await code(
        restoreProfileBackup({
          profile: f.profile,
          expectedStoreId: f.storeId,
          backup,
          intent: 'replace_with_selected_backup',
        }),
      ),
    ).toBe('backup_mcp_selection_intents_invalid');
    expect(await inspectProfileRestore({ profile: f.profile })).toBeNull();
    expect(readFileSync(f.path)).toEqual(original);
  } finally {
    f.close();
  }
}, 30000);
