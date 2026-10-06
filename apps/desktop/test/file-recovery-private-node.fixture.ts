import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  parseFileRecoveryIntent,
  planFileRecoveryIntent,
  prepareFileRecoveryLeg,
} from '@kite-ai/client/file-recovery-intent';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';

const [profileJson, bunExecutable, bunSha256, helperPath, helperSha256] = process.argv.slice(2);
const profile = JSON.parse(profileJson!),
  path = selectProfile(profile).profilePath;
const acquire = () =>
  acquireDesktopProfileAccess({
    profile,
    bunExecutable: bunExecutable!,
    bunSha256: bunSha256!,
    helperPath: helperPath!,
    helperSha256: helperSha256!,
  });
let access = await acquire(),
  data = openPrivateData(path, access);
const identity = {
  storeId: 'store-A',
  sessionId: 's',
  workspaceId: 'w',
  subjectId: 'owner',
  contextSelectionId: 'selector',
};
async function plan(n: number, scope: 'session' | 'code' | 'both' = 'both') {
  return planFileRecoveryIntent({
    scope,
    subjectId: identity.subjectId,
    observation: {
      storeId: identity.storeId,
      sessionId: identity.sessionId,
      workspaceId: identity.workspaceId,
      contextSelectionId: identity.contextSelectionId,
      checkpoint: {
        id: 'a'.repeat(64),
        workspace: { device: '1', inode: '2' },
        boundary: {
          storeId: 'source-A',
          sessionId: 'parent',
          workspaceId: 'source-w',
          runId: 'run',
          contextSelectionId: 'original',
          messageId: null,
          messageSeq: '0',
          triggerMessageId: 'old-trigger',
          triggerSeq: '3',
        },
      },
      boundary: { messageId: 'm', seq: '9007199254740993' },
      trigger: { messageId: 'trigger', seq: '9007199254740994' },
    },
    ...(scope === 'session' ? {} : { code: { commandId: `code-${n}`, restoreId: `restore-${n}` } }),
    ...(scope === 'code'
      ? {}
      : { fork: { commandId: `fork-${n}`, newSessionId: `new-${n}`, title: '原始 😀\r\n' } }),
  });
}
for (const [n, scope] of [
  [0, 'session'],
  [1, 'code'],
  [2, 'both'],
] as const) {
  const original = await plan(n, scope),
    saved = await data.prepareFileRecovery(original);
  assert.equal(saved.created, true);
  assert.deepEqual(saved.value, original);
  assert.equal((await data.prepareFileRecovery(original)).created, false);
}
assert.equal((await data.fileRecoveries()).length, 3);
const other = await plan(999);
const collision = await planFileRecoveryIntent({
  scope: 'both',
  subjectId: other.subjectId,
  observation: {
    storeId: other.storeId,
    sessionId: other.sessionId,
    workspaceId: other.workspaceId,
    contextSelectionId: other.contextSelectionId,
    checkpoint: other.checkpoint,
    boundary: other.boundary,
    trigger: other.trigger,
  },
  code: { commandId: other.code!.request.commandId, restoreId: 'restore-other' },
  fork: { commandId: 'fork-2', newSessionId: 'different-session', title: 'Second-leg duplicate' },
});
await assert.rejects(data.prepareFileRecovery(collision), /file_recovery_intent_conflict/);
assert.equal((await data.fileRecoveries()).length, 3);

const original = (await data.fileRecoveries()).find((value) => value.scope === 'both')!;
const prepared = prepareFileRecoveryLeg(original, 'code', identity, {
  explicitContinue: true,
}).intent;
await data.updateFileRecovery(prepared, original);
const submitting = await parseFileRecoveryIntent({
  ...prepared,
  code: { ...prepared.code!, phase: 'submitting' },
});
await data.updateFileRecovery(submitting, prepared);
await assert.rejects(data.updateFileRecovery(prepared, submitting), /file_recovery_phase_conflict/);
await assert.rejects(data.updateFileRecovery(submitting, original), /file_recovery_phase_conflict/);
const unknown = await parseFileRecoveryIntent({
  ...submitting,
  code: { ...submitting.code!, phase: 'unknown' },
});
await data.updateFileRecovery(unknown, submitting);
const bad = { ...unknown, code: { ...unknown.code!, requestDigest: '0'.repeat(64) } };
await assert.rejects(data.updateFileRecovery(bad, unknown), /file_recovery_intent_invalid/);
data.close();
access.close();
access = await acquire();
data = openPrivateData(path, access);
assert.deepEqual(
  (await data.fileRecoveries()).find((value) => value.code?.request.commandId === 'code-2'),
  unknown,
);
const sql = () => new DatabaseSync(join(path, 'desktop-private/data.sqlite'));
let raw = sql();
assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 6);
assert.deepEqual(
  raw
    .prepare('PRAGMA table_info(file_recovery_intents)')
    .all()
    .map((row) => [row.name, row.type, row.notnull, row.pk]),
  [
    ['intent_id', 'TEXT', 0, 1],
    ['state', 'TEXT', 1, 0],
  ],
);
raw.close();
for (let n = 3; n < 128; n++) await data.prepareFileRecovery(await plan(n));
await assert.rejects(data.prepareFileRecovery(await plan(128)), /file_recovery_capacity_exceeded/);
assert.equal((await data.fileRecoveries()).length, 128);
data.close();
access.close();
raw = sql();
const replaced = raw
  .prepare('SELECT state FROM file_recovery_intents WHERE intent_id=?')
  .get('code-127')!;
raw
  .prepare('UPDATE file_recovery_intents SET intent_id=?,state=? WHERE intent_id=?')
  .run('code-999', JSON.stringify(collision), 'code-127');
raw.close();
access = await acquire();
data = openPrivateData(path, access);
await assert.rejects(data.fileRecoveries(), /file_recovery_intent_conflict/);
data.close();
access.close();
raw = sql();
raw
  .prepare('UPDATE file_recovery_intents SET intent_id=?,state=? WHERE intent_id=?')
  .run('code-127', replaced.state as string, 'code-999');
raw.close();
raw = sql();
const row = raw.prepare('SELECT state FROM file_recovery_intents WHERE intent_id=?').get('code-2')!;
raw
  .prepare('UPDATE file_recovery_intents SET state=CAST(? AS TEXT) WHERE intent_id=?')
  .run(Buffer.from([0xff, 0xfe]), 'code-2');
raw.close();
access = await acquire();
data = openPrivateData(path, access);
await assert.rejects(data.fileRecoveries(), /file_recovery_storage_unavailable/);
data.close();
access.close();
raw = sql();
raw
  .prepare('UPDATE file_recovery_intents SET state=? WHERE intent_id=?')
  .run(row.state as string, 'code-2');
raw
  .prepare('UPDATE file_recovery_intents SET intent_id=? WHERE intent_id=?')
  .run('wrong-primary', 'code-2');
raw.close();
access = await acquire();
data = openPrivateData(path, access);
await assert.rejects(data.fileRecoveries(), /file_recovery_storage_unavailable/);
data.close();
access.close();
raw = sql();
raw
  .prepare('UPDATE file_recovery_intents SET intent_id=? WHERE intent_id=?')
  .run('code-2', 'wrong-primary');
raw.exec(
  'DROP TABLE configuration_intents; DROP TABLE model_routes; DROP TABLE answer_intents; DROP TABLE file_recovery_intents; PRAGMA user_version=3;',
);
raw.close();
access = await acquire();
data = openPrivateData(path, access);
assert.deepEqual(await data.fileRecoveries(), []);
assert.deepEqual(data.creations(), []);
data.close();
access.close();
console.log('file-recovery-private-node-qualified');
