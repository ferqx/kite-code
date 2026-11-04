import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { selectProfile } from '@kite-ai/agent/profile';
import { callerDigest } from '../electron/caller-journal';
import { parseNativeQueueRecord } from '../electron/native-input-queue-journal';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';
import type { NativeRequest } from '../src/native-bridge';

const input = JSON.parse(process.argv[2]!);
const access = await acquireDesktopProfileAccess(input);
const profilePath = selectProfile(input.profile).profilePath;
const data = openPrivateData(profilePath, access);
const mark = (storeId: string, runId: string, status: 'completed' | 'interrupted' = 'completed') =>
  data.markTurnRead({
    method: 'session.markRead',
    generation: 1,
    expectedStoreId: storeId,
    sessionId: 'session',
    runId,
    status,
  });
try {
  if (input.phase === 'write') {
    assert.deepEqual(data.readTurns('store'), []);
    data.save(
      { storeId: 'store', workspaceId: 'workspace', rootSessionId: 'session' },
      0,
      'keep draft',
    );
    mark('store', 'original-run');
    mark('other-store', 'other-run');
    const request = {
      kind: 'input.withdraw' as const,
      expectedStoreId: 'store',
      commandId: 'queue-edit',
      targetCommandId: 'pending-input',
      expectedRevision: 'a'.repeat(64),
    };
    const { expectedStoreId: _store, commandId: _command, ...body } = request;
    data.saveInputQueueRecord(
      parseNativeQueueRecord({
        scope: { storeId: 'store', sessionId: 'session', workspaceId: 'workspace' },
        subjectId: 'user',
        request,
        operation: 'edit',
        phase: 'submitting',
        requestDigest: callerDigest(body),
        text: 'keep queued edit',
        delivered: false,
      }),
    );
  } else {
    assert.deepEqual(data.readTurns('store'), [['session', '["original-run","completed"]']]);
    assert.deepEqual(data.readTurns('other-store'), [['session', '["other-run","completed"]']]);
    assert.deepEqual(data.readTurns('unseen-store'), []);
    assert.equal(data.inputQueueRecords()[0]?.text, 'keep queued edit');
    assert.equal(
      data.read({ storeId: 'store', workspaceId: 'workspace', rootSessionId: 'session' }).content,
      'keep draft',
    );
    const raw = new DatabaseSync(join(profilePath, 'desktop-private/data.sqlite'));
    try {
      assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 12);
      raw.exec(
        "CREATE TRIGGER reject_read_receipt BEFORE UPDATE ON session_read_turns BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
      );
      assert.throws(() => mark('store', 'next-run'));
      assert.deepEqual(data.readTurns('store'), [['session', '["original-run","completed"]']]);
      raw.exec('DROP TRIGGER reject_read_receipt');
      mark('store', 'next-run', 'interrupted');
      mark('store', 'next-run');
      assert.deepEqual(data.readTurns('store'), [['session', '["next-run","completed"]']]);
      assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM session_read_turns').get()!.count, 2);
      const invalid = {
        method: 'session.markRead',
        generation: 1,
        expectedStoreId: 'store',
        sessionId: 'session',
        runId: 'bad',
        status: 'running',
      };
      assert.throws(() =>
        data.markTurnRead(invalid as Extract<NativeRequest, { method: 'session.markRead' }>),
      );
    } finally {
      raw.close();
    }
  }
  console.log(JSON.stringify({ phase: input.phase, receipts: data.readTurns('store') }));
} finally {
  data.close();
  access.close();
}
