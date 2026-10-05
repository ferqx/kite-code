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
import { verifyMcpConnectionIntentsDocument } from '../../../src/maintenance/mcp-connection-intents';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';

const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
function row(storeId: string, index = 0) {
  const request = {
    expectedStoreId: storeId,
    commandId: `connect_${index}`,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.connect',
    definitionVersion: '1',
    input: { serverId: 'local', key: `key_${index}` },
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-connection-assets-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.close();
  const path = join(selectProfile(profile).profilePath, 'ui/mcp-connection-intents.json');
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  return {
    root,
    profile,
    storeId,
    path,
    destinationRoot: join(root, 'backups'),
    close: () => rmSync(root, { recursive: true, force: true }),
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

test('public v9 create/inspect/restore preserves whole original A intent bytes, hashes and identities without rewriting to Store B', async () => {
  const f = await fixture();
  try {
    const original = [row(f.storeId), { ...row(f.storeId, 1), phase: 'ready' }];
    const bytes = write(f.path, original);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(9);
    expect(backup.manifest.assets.mcpConnectionIntents).toMatchObject({
      path: 'ui/mcp-connection-intents.json',
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
    expect(readFileSync(join(backup.directory, 'ui/mcp-connection-intents.json'))).toEqual(bytes);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    expect(readFileSync(f.path)).toEqual(bytes);
    verifyMcpConnectionIntentsDocument(f.path);
    const records = JSON.parse(readFileSync(f.path, 'utf8')).records;
    expect(records).toEqual(original);
    expect(records[0].intent.request.expectedStoreId).toBe(f.storeId);
    console.log(
      JSON.stringify({
        case: 'connection_intent_backup_restore',
        originalStoreId: f.storeId,
        currentStoreId: restored.storeId,
        byteLength: bytes.length,
        sha256: hash(bytes),
        records: original,
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
test('closed connect-only codec rejects future/mixed action/shape/hash/duplicate identities; all original unknown rows retained', async () => {
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
        r.intent.request.input.key = 'bad/key';
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
        Object.assign(r.intent.request.input, { transport: 'stdio' });
      },
      (r) => {
        Object.assign(r.intent, { authority: true });
      },
    ];
    for (const change of cases) {
      const bad = structuredClone(original);
      change(bad);
      write(f.path, [bad]);
      expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
    }
    write(f.path, [original, original]);
    expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
    write(f.path, [original]);
    verifyMcpConnectionIntentsDocument(f.path);
    const bytes = readFileSync(f.path);
    expect(JSON.parse(bytes.toString()).records[0].phase).toBe('outcome_unknown');
    expect(readFileSync(f.path)).toEqual(bytes);
    writeFileSync(f.path, Buffer.from([0xff]));
    expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
    writeFileSync(f.path, JSON.stringify({ version: 2, records: [] }));
    expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
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
    verifyMcpConnectionIntentsDocument(f.path);
    expect(readFileSync(f.path)).toEqual(bytes);
    write(f.path, rows, 16 * 1024 * 1024 - base.length + 1);
    expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
    write(f.path, [...rows, row(f.storeId, 128)]);
    expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
    write(f.path, [rows[0]]);
    chmodSync(f.path, 0o644);
    expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
    chmodSync(f.path, 0o600);
    const hard = join(f.root, 'hard');
    linkSync(f.path, hard);
    expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
    unlinkSync(hard);
    const source = join(f.root, 'source');
    writeFileSync(source, readFileSync(f.path), { mode: 0o600 });
    unlinkSync(f.path);
    symlinkSync(source, f.path);
    expect(() => verifyMcpConnectionIntentsDocument(f.path)).toThrow();
  } finally {
    f.close();
  }
});
test('absent new asset retains old version; v8 whitelist and corrupt v9 restore reject even matching outer proof', async () => {
  const f = await fixture();
  try {
    const old = await createProfileBackup(f);
    expect(old.manifest.version).toBe(5);
    expect(old.manifest.assets.mcpConnectionIntents).toBeUndefined();
    write(f.path, [row(f.storeId)]);
    const backup = await createProfileBackup(f);
    const ready = join(backup.directory, 'ready.json');
    const manifest = JSON.parse(readFileSync(ready, 'utf8'));
    const disguised = { ...manifest, version: 8 };
    writeFileSync(ready, JSON.stringify(disguised));
    await expect(inspectProfileBackup(backup)).rejects.toThrow();
    writeFileSync(ready, JSON.stringify(manifest));
    const path = join(backup.directory, 'ui/mcp-connection-intents.json');
    const invalid = Buffer.from(
      JSON.stringify({ version: 1, records: [{ ...row(f.storeId), phase: 'applied' }] }),
    );
    writeFileSync(path, invalid);
    manifest.assets.mcpConnectionIntents.proof = proof(invalid);
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
