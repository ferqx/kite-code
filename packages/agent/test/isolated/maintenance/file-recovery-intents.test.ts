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
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';
import { nodeFileRecoveryAssets } from './file-recovery-assets-fixture';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-file-recovery-maintenance-');
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  await store.close();
  const selected = selectProfile(profile);
  mkdirSync(join(selected.profilePath, 'ui'), { recursive: true, mode: 0o700 });
  return {
    root,
    profile,
    selected,
    storeId,
    path: join(selected.profilePath, 'ui/file-recovery-intents.json'),
    desktopPath: join(selected.profilePath, 'desktop-private/data.sqlite'),
    destinationRoot: join(root, 'backups'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function row(storeId: string, scope: 'session' | 'code' | 'both' = 'both', index = 0) {
  const checkpoint = {
    id: 'a'.repeat(64),
    boundary: {
      storeId,
      workspaceId: 'w',
      sessionId: 'original_parent',
      runId: 'original_run',
      contextSelectionId: 'original_selection',
      messageId: 'original_before',
      messageSeq: '1',
      triggerMessageId: 'original_trigger',
      triggerSeq: '2',
    },
    workspace: { device: '1', inode: '2' },
  };
  const input = { checkpointId: checkpoint.id, restoreId: `restore_${index}` };
  const code =
    scope === 'session'
      ? null
      : {
          request: {
            expectedStoreId: storeId,
            commandId: `code_${index}`,
            kind: 'extension.invoke',
            extensionId: 'builtin.files',
            actionId: 'files.checkpoint.restore',
            definitionVersion: '1',
            input,
          },
          requestDigest: hash(
            canonicalJson({
              kind: 'extension.invoke',
              extensionId: 'builtin.files',
              actionId: 'files.checkpoint.restore',
              definitionVersion: '1',
              input,
            }),
          ),
          phase: 'succeeded',
        };
  const boundary = { messageId: 'current_before', seq: '1' };
  const title = 'Original é e\u0301\r\n" \\ tail';
  const fork =
    scope === 'code'
      ? null
      : {
          request: {
            expectedStoreId: storeId,
            commandId: `fork_${index}`,
            expectedContextSelectionId: 'current_selection',
            boundary,
            newSessionId: `new_${index}`,
            title,
          },
          requestDigest: hash(
            canonicalJson({
              kind: 'session.create',
              title,
              fork: {
                sourceSessionId: 'original_current',
                expectedContextSelectionId: 'current_selection',
                boundary,
              },
            }),
          ),
          phase: 'unknown',
        };
  return {
    version: 1,
    scope,
    storeId,
    sessionId: 'original_current',
    workspaceId: 'w',
    subjectId: 'original_subject',
    contextSelectionId: 'current_selection',
    checkpoint,
    boundary,
    trigger: { messageId: 'current_trigger', seq: '2' },
    code,
    fork,
  };
}
function write(path: string, records: unknown[]) {
  const bytes = Buffer.from(JSON.stringify({ version: 1, records }, null, 2) + '\n');
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}
async function reject(work: Promise<unknown>, code?: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  if (code) expect((error as { code?: string }).code).toBe(code);
}
function rewriteReady(directory: string, manifest: unknown) {
  const path = join(directory, 'ready.json');
  chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify(manifest));
  chmodSync(path, 0o400);
}
test('independent file intent asset retains exact three scopes, original aliases and partial known state through new Store restore', async () => {
  const f = await fixture();
  try {
    const records = ['session', 'code', 'both'].map((scope, index) =>
      row(f.storeId, scope as 'session' | 'code' | 'both', index),
    );
    const supplementaryTitle = '😀'.repeat(300);
    records[2]!.fork!.request.title = supplementaryTitle;
    records[2]!.fork!.requestDigest = hash(
      canonicalJson({
        kind: 'session.create',
        title: supplementaryTitle,
        fork: {
          sourceSessionId: 'original_current',
          expectedContextSelectionId: 'current_selection',
          boundary: records[2]!.boundary,
        },
      }),
    );
    const bytes = write(f.path, records);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(6);
    expect(backup.manifest.assets.fileRecoveryIntents).toMatchObject({
      path: 'ui/file-recovery-intents.json',
      present: true,
      format: { version: 1 },
      proof: { sha256: hash(bytes), byteLength: String(bytes.length) },
    });
    expect(readFileSync(join(backup.directory, 'ui/file-recovery-intents.json'))).toEqual(bytes);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    expect(readFileSync(f.path)).toEqual(bytes);
    const saved = JSON.parse(readFileSync(f.path, 'utf8')).records;
    expect(saved).toEqual(records);
    expect(saved[2].fork.request.title).toBe(supplementaryTitle);
    expect(saved[2]).toMatchObject({
      storeId: f.storeId,
      checkpoint: { boundary: { sessionId: 'original_parent' } },
      boundary: { messageId: 'current_before' },
      code: { phase: 'succeeded' },
      fork: { phase: 'unknown' },
    });
    expect(existsSync(join(f.selected.profilePath, 'ui/caller-intents.json'))).toBe(false);
  } finally {
    f.close();
  }
});
test('closed file intent digests, branch metadata, phases and foreign authority cannot be hidden by valid outer proofs', async () => {
  const f = await fixture();
  try {
    const base = row(f.storeId);
    const changes: ((value: any) => void)[] = [
      (v) => {
        v.code.request.input.restoreId = 'changed';
      },
      (v) => {
        v.code.request.actionId = 'other.action';
      },
      (v) => {
        v.fork.requestDigest = hash(canonicalJson(v.fork.request as Json));
      },
      (v) => {
        v.fork.request.title += ' changed';
      },
      (v) => {
        v.fork.phase = 'dispatching';
      },
      (v) => {
        v.code.phase = 'unknown';
      },
      (v) => {
        v.boundary.seq = '9223372036854775808';
      },
      (v) => {
        v.checkpoint.boundary.messageId = null;
      },
      (v) => {
        v.code.request.expectedStoreId = 'retargeted';
      },
      (v) => {
        v.hotPermit = { kind: 'file_recovery_hot_permit' };
      },
      (v) => {
        v.checkpoint.workspace = { 'device|inode': '1' };
      },
      (v) => {
        v.checkpoint.workspace = {};
      },
      (v) => {
        v.checkpoint.workspace = { device: '1', 'inode|extra': '2' };
      },
    ];
    for (const change of changes) {
      const value = structuredClone(base);
      change(value);
      write(f.path, [value]);
      await reject(createProfileBackup(f), 'backup_file_recovery_intents_invalid');
    }
    write(f.path, [base, base]);
    await reject(createProfileBackup(f), 'backup_file_recovery_intents_invalid');
    write(f.path, [base]);
    const backup = await createProfileBackup(f);
    const candidate = join(backup.directory, 'ui/file-recovery-intents.json');
    const bad = structuredClone(base);
    bad.code!.request.input.restoreId = 'tampered';
    const bytes = write(candidate, [bad]);
    backup.manifest.assets.fileRecoveryIntents!.proof = {
      sha256: hash(bytes),
      byteLength: String(bytes.length),
    };
    rewriteReady(backup.directory, backup.manifest);
    await reject(inspectProfileBackup(backup), 'backup_file_recovery_intents_invalid');
    await reject(
      restoreProfileBackup({
        profile: f.profile,
        expectedStoreId: f.storeId,
        backup,
        intent: 'replace_with_selected_backup',
      }),
      'backup_file_recovery_intents_invalid',
    );
    const store = await openSqliteStore(f.profile);
    try {
      expect((await store.getMetadata()).storeId).toBe(f.storeId);
    } finally {
      await store.close();
    }
  } finally {
    f.close();
  }
});
test('old manifests retain their exact file whitelist and private file recovery bytes require no-follow and one link', async () => {
  const f = await fixture();
  try {
    const bytes = write(f.path, [row(f.storeId)]);
    const backup = await createProfileBackup(f);
    for (const version of [2, 3, 4, 5]) {
      const old = structuredClone(backup.manifest);
      old.version = version as 2 | 3 | 4 | 5;
      rewriteReady(backup.directory, old);
      await reject(
        inspectProfileBackup({ directory: backup.directory }),
        'backup_invalid_manifest',
      );
    }
    const old = structuredClone(backup.manifest);
    old.version = 5;
    delete old.assets.fileRecoveryIntents;
    rewriteReady(backup.directory, old);
    await reject(inspectProfileBackup({ directory: backup.directory }), 'backup_unexpected_asset');
    const outside = join(f.root, 'outside.json');
    writeFileSync(outside, bytes, { mode: 0o600 });
    rmSync(f.path);
    symlinkSync(outside, f.path);
    await reject(createProfileBackup(f));
    rmSync(f.path);
    linkSync(outside, f.path);
    await reject(createProfileBackup(f));
    rmSync(f.path);
    writeFileSync(f.path, bytes, { mode: 0o644 });
    await reject(createProfileBackup(f));
  } finally {
    f.close();
  }
});
test('actual Node PrivateData DB5 preserves three file intent scopes through offline restore and cold metadata reads with no HTTP', async () => {
  const f = await fixture();
  try {
    const before = await nodeFileRecoveryAssets(f.root, f.profile, f.storeId);
    expect(before.records).toHaveLength(3);
    expect(before.httpRequests).toBe(0);
    expect(
      (
        before.records.find((record) => record.scope === 'both')!.fork as {
          request: { title: string };
        }
      ).request.title,
    ).toContain('\r\n');
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(7);
    expect(backup.manifest.assets.desktopUi.format).toEqual({
      applicationId: 1263888689,
      userVersion: 5,
    });
    expect(backup.manifest.assets.fileRecoveryIntents).toMatchObject({
      present: false,
      proof: null,
      format: null,
    });
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    const after = await nodeFileRecoveryAssets(f.root, f.profile, restored.storeId, 'read');
    expect(after.records).toEqual(before.records);
    expect(after.httpRequests).toBe(0);
    expect(after.records.every((record) => record.storeId === f.storeId)).toBe(true);
    const db = new Database(f.desktopPath);
    try {
      const first = db
        .query<{ intent_id: string; state: string }, []>(
          'SELECT intent_id,state FROM file_recovery_intents ORDER BY intent_id LIMIT 1',
        )
        .get()!;
      const value = JSON.parse(first.state);
      value.code.requestDigest = 'f'.repeat(64);
      db.query('UPDATE file_recovery_intents SET state=? WHERE intent_id=?').run(
        JSON.stringify(value),
        first.intent_id,
      );
    } finally {
      db.close(true);
    }
    await reject(createProfileBackup(f), 'backup_file_recovery_intents_invalid');
  } finally {
    f.close();
  }
}, 30000);
