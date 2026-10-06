import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';
import { nodeAnswerAssets } from './desktop-answer-assets-fixture';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(canonicalJson(value as Json));
function mutate(path: string, work: (db: Database) => void) {
  const db = new Database(path);
  try {
    work(db);
  } finally {
    db.close(true);
  }
}
function states(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ command_id: string; state_hex: string }, []>(
        'SELECT command_id,hex(CAST(state AS BLOB)) AS state_hex FROM answer_intents ORDER BY command_id',
      )
      .all();
  } finally {
    db.close(true);
  }
}
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-answer-maintenance-'),
    profile = { dataRoot: join(root, 'data'), profile: 'owned' },
    store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  await store.close();
  const path = join(selectProfile(profile).profilePath, 'desktop-private/data.sqlite');
  return {
    root,
    profile,
    storeId,
    path,
    destinationRoot: join(root, 'backups'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function code(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
function proofs(row: Awaited<ReturnType<typeof nodeAnswerAssets>>['records'][number]) {
  row.intent.bodyDigest = digest(row.intent.request);
  row.intent.requestDigest = digest({
    kind: 'interaction.answer',
    interactionId: row.intent.interaction.id,
    expectedRevision: row.intent.request.expectedRevision,
    answer: row.intent.request.answer,
  });
  return row;
}

test('actual private Node DB5 answers preserve original IDs, subject, digest and full Unicode CRLF bytes across v7 snapshot and restored cold metadata with zero HTTP', async () => {
  const f = await fixture();
  try {
    const original = await nodeAnswerAssets(f.root, f.profile, f.storeId),
      before = readFileSync(f.path),
      rows = states(f.path);
    expect(original.records).toHaveLength(3);
    expect(original.httpRequests).toBe(0);
    expect(original.records.every((row) => row.phase === 'unknown')).toBe(true);
    const text = (
      original.records.find((row) => row.intent.interaction.id === 'original-question')!.intent
        .request.answer as { answers: { exact: string } }
    ).answers.exact;
    expect(Buffer.byteLength(text)).toBeGreaterThan(300000);
    expect(text.endsWith('ORIGINAL_ANSWER_TAIL\r\n')).toBe(true);
    const backup = await createProfileBackup(f);
    expect(backup.manifest.version).toBe(7);
    expect(backup.manifest.assets.desktopUi.format).toEqual({
      applicationId: 1263888689,
      userVersion: 5,
    });
    expect(readFileSync(f.path)).toEqual(before);
    const copy = join(backup.directory, 'desktop-private/data.sqlite');
    expect(states(copy)).toEqual(rows);
    expect(hash(readFileSync(copy))).toBe(backup.manifest.assets.desktopUi.proof!.sha256);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.storeId);
    expect(states(f.path)).toEqual(rows);
    expect(hash(readFileSync(f.path))).toBe(hash(readFileSync(copy)));
    const cold = await nodeAnswerAssets(f.root, f.profile, f.storeId, 'read');
    expect(cold).toEqual(original);
    expect(states(f.path)).toEqual(rows);
    expect(
      cold.records.every(
        (row) =>
          row.intent.scope.storeId === f.storeId &&
          row.intent.subjectId === 'original-subject' &&
          row.intent.request.expectedStoreId === f.storeId,
      ),
    ).toBe(true);
    console.log(
      JSON.stringify({
        originalStoreId: f.storeId,
        restoredStoreId: restored.storeId,
        commandIds: rows.map((row) => row.command_id),
        subjectId: 'original-subject',
        answerByteLength: Buffer.byteLength(text),
        answerSha256: hash(text),
        snapshotSha256: hash(readFileSync(copy)),
        stateSha256: rows.map((row) => hash(Buffer.from(row.state_hex, 'hex'))),
        httpRequests: cold.httpRequests,
      }),
    );
  } finally {
    f.close();
  }
}, 30000);

test('DB5 answer rows fail closed for forged PK, digests, phase, authority, duplicate target, invalid UTF8, capacity and unsafe source without pruning or ready', async () => {
  const f = await fixture();
  try {
    const original = (await nodeAnswerAssets(f.root, f.profile, f.storeId)).records;
    const reset = () =>
      mutate(f.path, (db) => {
        db.exec('DELETE FROM answer_intents');
        for (const row of original)
          db.query('INSERT INTO answer_intents VALUES(?,?)').run(
            String(row.intent.request.commandId),
            JSON.stringify(row),
          );
      });
    const changes = [
      (r: (typeof original)[number]) => {
        r.phase = 'future';
      },
      (r: (typeof original)[number]) => {
        r.intent.request.token = 'forged';
      },
      (r: (typeof original)[number]) => {
        r.intent.request.commandId = 'wrong-pk';
      },
      (r: (typeof original)[number]) => {
        r.intent.bodyDigest = '0'.repeat(64);
      },
      (r: (typeof original)[number]) => {
        r.intent.requestDigest = '0'.repeat(64);
      },
      (r: (typeof original)[number]) => {
        r.intent.request.expectedStoreId = 'wrong-store';
      },
      (r: (typeof original)[number]) => {
        r.intent.observationDigest = 'bad';
      },
    ];
    for (const change of changes) {
      reset();
      const row = structuredClone(original[0]!);
      change(row);
      mutate(f.path, (db) =>
        db
          .query('UPDATE answer_intents SET state=? WHERE command_id=?')
          .run(JSON.stringify(row), String(original[0]!.intent.request.commandId)),
      );
      const before = readFileSync(f.path);
      expect(await code(createProfileBackup(f))).toBe('backup_ui_invalid');
      expect(readFileSync(f.path)).toEqual(before);
    }
    for (const kind of ['utf8', 'target', 'count', 'bytes', 'row'] as const) {
      reset();
      mutate(f.path, (db) => {
        if (kind === 'utf8') db.exec("UPDATE answer_intents SET state=CAST(x'ff' AS TEXT)");
        else if (kind === 'target') {
          const row = structuredClone(original[0]!);
          row.intent.request.commandId = 'duplicate-target';
          proofs(row);
          db.query('INSERT INTO answer_intents VALUES(?,?)').run(
            'duplicate-target',
            JSON.stringify(row),
          );
        } else {
          db.exec('DELETE FROM answer_intents');
          for (let i = 0; i < (kind === 'count' ? 129 : kind === 'bytes' ? 18 : 1); i++) {
            const row = structuredClone(original[0]!);
            row.intent.request.commandId = 'capacity-' + i;
            row.intent.interaction.id = 'target-' + i;
            if (kind !== 'count')
              row.intent.request.answer = {
                kind: 'approval',
                decision: 'approve',
                grant: 'approve_once',
              };
            if (kind !== 'count') {
              const r = row as unknown as {
                intent: { interaction: { kind: string }; request: { answer: unknown } };
              };
              r.intent.interaction.kind = 'question';
              r.intent.request.answer = {
                kind: 'question',
                answers: { exact: '🙂'.repeat(kind === 'row' ? 1100000 : 250000) },
              };
            }
            proofs(row);
            db.query('INSERT INTO answer_intents VALUES(?,?)').run(
              'capacity-' + i,
              JSON.stringify(row),
            );
          }
        }
      });
      const before = readFileSync(f.path);
      expect(await code(createProfileBackup(f))).toBe('backup_ui_invalid');
      expect(readFileSync(f.path)).toEqual(before);
      expect(existsSync(f.destinationRoot) ? readdirSync(f.destinationRoot) : []).toEqual([]);
    }
    reset();
    chmodSync(f.path, 0o644);
    const before = readFileSync(f.path);
    expect(await code(createProfileBackup(f))).not.toBe('success');
    expect(readFileSync(f.path)).toEqual(before);
  } finally {
    f.close();
  }
}, 30000);

test('future DB/manifest fields and old version aliases reject DB5, including rehashed internally damaged restore assets', async () => {
  const f = await fixture();
  try {
    const original = (await nodeAnswerAssets(f.root, f.profile, f.storeId)).records,
      backup = await createProfileBackup(f);
    for (const version of [2, 3, 4, 5, 6, 8]) {
      const manifest = structuredClone(backup.manifest);
      manifest.version = version as typeof manifest.version;
      if (version < 6) delete manifest.assets.fileRecoveryIntents;
      if (version < 4) delete manifest.assets.callerIntents;
      if (version < 3) delete manifest.assets.tuiRecovery;
      writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(manifest), {
        mode: 0o600,
      });
      expect(await code(inspectProfileBackup(backup))).toBe('backup_invalid_manifest');
    }
    writeFileSync(
      join(backup.directory, 'ready.json'),
      JSON.stringify({ ...backup.manifest, future: true }),
      { mode: 0o600 },
    );
    expect(await code(inspectProfileBackup(backup))).toBe('backup_invalid_manifest');
    const copy = join(backup.directory, 'desktop-private/data.sqlite');
    mutate(copy, (db) => {
      const row = structuredClone(original[0]!);
      row.intent.bodyDigest = '0'.repeat(64);
      db.query('UPDATE answer_intents SET state=? WHERE command_id=?').run(
        JSON.stringify(row),
        String(row.intent.request.commandId),
      );
    });
    const bytes = readFileSync(copy);
    backup.manifest.assets.desktopUi.proof = {
      sha256: hash(bytes),
      byteLength: String(bytes.length),
    };
    writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(backup.manifest), {
      mode: 0o600,
    });
    expect(await code(inspectProfileBackup(backup))).toBe('backup_ui_invalid');
    expect(
      await code(
        restoreProfileBackup({
          profile: f.profile,
          expectedStoreId: f.storeId,
          backup,
          intent: 'replace_with_selected_backup',
        }),
      ),
    ).toBe('backup_ui_invalid');
    expect(await inspectProfileRestore({ profile: f.profile })).toBeNull();
    expect((await nodeAnswerAssets(f.root, f.profile, f.storeId, 'read')).records).toEqual(
      original,
    );
    for (const statement of [
      'PRAGMA user_version=7',
      'PRAGMA user_version=5;CREATE TABLE future(value TEXT)',
    ]) {
      mutate(f.path, (db) => db.exec(statement));
      const before = readFileSync(f.path);
      expect(await code(createProfileBackup(f))).toBe('backup_ui_incompatible');
      expect(readFileSync(f.path)).toEqual(before);
    }
  } finally {
    f.close();
  }
}, 30000);

test('exactly 128 original unknown answer identities fit without clipping, and v7 format extras never grant DB5 authority', async () => {
  const f = await fixture();
  try {
    const original = (await nodeAnswerAssets(f.root, f.profile, f.storeId)).records;
    mutate(f.path, (db) => {
      db.exec('DELETE FROM answer_intents');
      for (let i = 0; i < 128; i++) {
        const row = structuredClone(original[0]!);
        row.intent.request.commandId = 'bounded-' + i;
        row.intent.interaction.id = 'bounded-target-' + i;
        proofs(row);
        db.query('INSERT INTO answer_intents VALUES(?,?)').run('bounded-' + i, JSON.stringify(row));
      }
    });
    const rows = states(f.path),
      before = readFileSync(f.path),
      backup = await createProfileBackup(f);
    expect(rows).toHaveLength(128);
    expect(states(join(backup.directory, 'desktop-private/data.sqlite'))).toEqual(rows);
    expect(readFileSync(f.path)).toEqual(before);
    expect((await inspectProfileBackup(backup)).manifest.version).toBe(7);
    for (const work of [
      (value: Record<string, unknown>) => {
        value.future = true;
      },
      (value: Record<string, unknown>) => {
        const userVersion = value.userVersion;
        delete value.userVersion;
        value['userVersion,future'] = userVersion;
      },
    ]) {
      const manifest = structuredClone(backup.manifest);
      work(manifest.assets.desktopUi.format!);
      writeFileSync(join(backup.directory, 'ready.json'), JSON.stringify(manifest), {
        mode: 0o600,
      });
      expect(await code(inspectProfileBackup(backup))).toBe('backup_invalid_manifest');
    }
  } finally {
    f.close();
  }
}, 30000);
