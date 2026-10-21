import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { selectProfile } from '@kite-ai/agent/profile';
import { callerDigest } from '../electron/caller-journal';
import { parseNativeQueueRecord } from '../electron/native-input-queue-journal';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';

const [profileJson, bunExecutable, bunSha256, helperPath, helperSha256] = process.argv.slice(
  2,
) as string[];
const profile = JSON.parse(profileJson!);
const profilePath = selectProfile(profile).profilePath;
const open = async () =>
  openPrivateData(
    profilePath,
    await acquireDesktopProfileAccess({
      profile,
      bunExecutable: bunExecutable!,
      bunSha256: bunSha256!,
      helperPath: helperPath!,
      helperSha256: helperSha256!,
    }),
  );
let data = await open();
assert.deepEqual(data.inputQueueRecords(), []);
const request = {
  kind: 'input.withdraw' as const,
  expectedStoreId: 'store',
  commandId: 'original-edit',
  targetCommandId: 'pending-input',
  expectedRevision: 'a'.repeat(64),
};
const { expectedStoreId: _store, commandId: _command, ...body } = request;
const original = parseNativeQueueRecord({
  scope: { storeId: 'store', sessionId: 'session', workspaceId: 'workspace' },
  subjectId: 'user',
  request,
  operation: 'edit',
  phase: 'submitting',
  requestDigest: callerDigest(body),
  text: '完整 Markdown **原文**\r\n雪🙂\u0000',
  delivered: false,
});
data.saveInputQueueRecord(original);
data.saveInputQueueRecord({ ...original, phase: 'unknown' });
data.close();
data = await open();
assert.deepEqual(data.inputQueueRecords(), [{ ...original, phase: 'unknown' }]);
data.saveInputQueueRecord({ ...original, phase: 'applied' });
assert.throws(
  () => data.saveInputQueueRecord({ ...original, phase: 'applied', text: '篡改原文' }),
  /input_queue_intent_conflict/,
);
assert.throws(
  () => data.saveInputQueueRecord({ ...original, phase: 'unknown' }),
  /input_queue_intent_conflict/,
);
data.saveInputQueueRecord({ ...original, phase: 'applied', delivered: true });
data.close();
data = await open();
assert.equal(data.inputQueueRecords()[0]!.delivered, true);
data.close();
const path = `${profilePath}/desktop-private/data.sqlite`;
const raw = new DatabaseSync(path);
assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 11);
assert.equal(
  raw.prepare("SELECT name FROM sqlite_master WHERE name='scheduled_tasks'").get()!.name,
  'scheduled_tasks',
);
assert.equal(
  raw.prepare("SELECT name FROM sqlite_master WHERE name='workspace_removal_intents'").get()!.name,
  'workspace_removal_intents',
);
raw
  .prepare('UPDATE input_queue_intents SET state=? WHERE command_id=?')
  .run(JSON.stringify({ ...original, requestDigest: 'b'.repeat(64) }), 'original-edit');
raw.close();
data = await open();
assert.throws(() => data.inputQueueRecords(), /input_queue_storage_unavailable/);
data.close();
console.log('input-queue-cold-journal-ok');
