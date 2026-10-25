import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { selectProfile } from '@kite-ai/agent/profile';
import type { StartCommandRequest } from '@kite-ai/client';
import { canonicalCallerCommandRequest } from '@kite-ai/client';
import { callerDigest, callerTarget, callerTextDigest } from '../electron/caller-journal';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';
import type { NativeCallerRecord } from '../src/native-bridge';

const input = JSON.parse(process.argv[2]!);
let access: Awaited<ReturnType<typeof acquireDesktopProfileAccess>>;
const open = async () => {
  access = await acquireDesktopProfileAccess(input);
  return openPrivateData(selectProfile(input.profile).profilePath, access);
};
let data = await open();
const close = () => {
  data.close();
  access.close();
};
const checked: string[] = [];
try {
  for (const phase of ['accepted', 'applied', 'unknown', 'rejected'] as const) {
    const scope = { storeId: 'store', workspaceId: 'workspace', rootSessionId: phase };
    const content = `原提示词 ${phase} 雪🙂  `;
    const saved = data.save(scope, 0, `${content}\r\n\n\r\n`);
    assert.equal(saved.consumedFrom, undefined);
    const request: StartCommandRequest = {
      kind: 'run.start',
      expectedStoreId: scope.storeId,
      commandId: phase,
      content,
    };
    const callerScope = {
      storeId: scope.storeId,
      workspaceId: scope.workspaceId,
      sessionId: scope.rootSessionId,
    };
    const record: NativeCallerRecord = {
      intent: {
        scope: callerScope,
        subjectId: 'local-user',
        request,
        target: callerTarget(callerScope, request),
        bodyDigest: callerDigest(request),
        requestDigest: callerTextDigest(canonicalCallerCommandRequest(request)),
        draft: {
          id: saved.id,
          revision: String(saved.revision),
          textDigest: callerTextDigest(saved.content),
        },
      },
      phase: 'submitting',
    };
    data.beginCaller(record);
    data.finishCaller(phase, phase);
    const sent = phase === 'accepted' || phase === 'applied';
    assert.equal(data.readId(saved.id).content, sent ? '' : saved.content);
    assert.equal(data.read(scope).content, sent ? '' : saved.content);
    assert.equal(data.read(scope).revision, sent ? 2 : 1);
    assert.deepEqual(
      data.read(scope).consumedFrom,
      sent ? { commandId: phase, revision: 1 } : undefined,
    );
    close();
    data = await open();
    assert.equal(data.read(scope).content, sent ? '' : saved.content);
    assert.equal(data.read(scope).consumedFrom, undefined);
    checked.push(`cold-${phase}`);
  }
  const scope = { storeId: 'store', workspaceId: 'workspace', rootSessionId: 'new-edit' };
  const saved = data.save(scope, 0, '原提示词');
  const original = data.callers().find((r) => r.intent.request.commandId === 'accepted')!;
  const request: StartCommandRequest = {
    kind: 'run.start',
    expectedStoreId: 'store',
    commandId: 'new-edit',
    content: saved.content,
  };
  const record: NativeCallerRecord = {
    intent: {
      ...original.intent,
      scope: { ...original.intent.scope, sessionId: scope.rootSessionId },
      request,
      target: { kind: 'session', id: scope.rootSessionId },
      bodyDigest: callerDigest(request),
      requestDigest: callerTextDigest(canonicalCallerCommandRequest(request)),
      draft: {
        id: saved.id,
        revision: String(saved.revision),
        textDigest: callerTextDigest(saved.content),
      },
    },
    phase: 'submitting',
  };
  data.beginCaller(record);
  data.save(scope, saved.revision, '发送期间新输入');
  data.finishCaller('new-edit', 'accepted');
  assert.equal(data.read(scope).content, '发送期间新输入');
  checked.push('new-revision-preserved');

  // Model the old on-disk layout: an accepted caller and its unchanged saved prompt.
  const path = join(selectProfile(input.profile).profilePath, 'desktop-private/data.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE drafts SET content=?,revision=? WHERE id=?').run(
      JSON.stringify('原提示词'),
      1,
      saved.id,
    );
  } finally {
    db.close();
  }
  close();
  data = await open();
  assert.equal(data.read(scope).content, '');
  assert.equal(data.read(scope).revision, 2);
  assert.equal(data.read(scope).revision, 2);
  assert.deepEqual(data.read(scope).consumedFrom, { commandId: 'new-edit', revision: 1 });
  assert.equal(
    data.callers().find((r) => r.intent.request.commandId === 'new-edit')!.phase,
    'accepted',
  );
  checked.push('legacy-accepted-reconciled-once');

  // Saving identical text again is a new draft; an old receipt cannot consume it.
  data.save(scope, 2, '原提示词');
  data.finishCaller('new-edit', 'applied');
  close();
  data = await open();
  assert.equal(data.read(scope).content, '原提示词');
  assert.equal(data.read(scope).revision, 3);
  checked.push('identical-new-draft-preserved');

  // Storage failure cannot commit an accepted receipt while leaving its draft unconsumed.
  const rollbackScope = { ...scope, rootSessionId: 'rollback' };
  const rollbackDraft = data.save(rollbackScope, 0, '事务失败时保留原文');
  const rollbackRequest = { ...request, commandId: 'rollback', content: rollbackDraft.content };
  data.beginCaller({
    intent: {
      ...record.intent,
      scope: { ...record.intent.scope, sessionId: 'rollback' },
      target: { kind: 'session', id: 'rollback' },
      request: rollbackRequest,
      bodyDigest: callerDigest(rollbackRequest),
      requestDigest: callerTextDigest(canonicalCallerCommandRequest(rollbackRequest)),
      draft: {
        id: rollbackDraft.id,
        revision: '1',
        textDigest: callerTextDigest(rollbackDraft.content),
      },
    },
    phase: 'submitting',
  });
  const blocked = new DatabaseSync(path);
  try {
    blocked.exec(
      "CREATE TRIGGER owned_draft_failure BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT,'owned_failure'); END",
    );
    assert.throws(() => data.finishCaller('rollback', 'accepted'), /draft_storage_unavailable/);
    assert.equal(
      data.callers().find((r) => r.intent.request.commandId === 'rollback')!.phase,
      'submitting',
    );
    assert.equal(data.read(rollbackScope).content, rollbackDraft.content);
  } finally {
    blocked.exec('DROP TRIGGER owned_draft_failure');
    blocked.close();
  }
  checked.push('receipt-and-draft-atomic');

  const preparePrompt = (sessionId: string) => {
    const promptScope = { ...scope, rootSessionId: sessionId };
    const prompt = data.save(promptScope, 0, `original ${sessionId}`);
    const promptRequest = { ...request, commandId: sessionId, content: prompt.content };
    data.beginCaller({
      intent: {
        ...record.intent,
        scope: { ...record.intent.scope, sessionId },
        target: { kind: 'session', id: sessionId },
        request: promptRequest,
        bodyDigest: callerDigest(promptRequest),
        requestDigest: callerTextDigest(canonicalCallerCommandRequest(promptRequest)),
        draft: {
          id: prompt.id,
          revision: String(prompt.revision),
          textDigest: callerTextDigest(prompt.content),
        },
      },
      phase: 'submitting',
    });
    return { scope: promptScope, draft: prompt };
  };

  const consumed = preparePrompt('consumption-proof');
  data.finishCaller('consumption-proof', 'accepted');
  const proof = { commandId: 'consumption-proof', revision: 1 };
  assert.deepEqual(data.read(consumed.scope).consumedFrom, proof);
  assert.deepEqual(data.read(consumed.scope).consumedFrom, proof);
  assert.equal(data.readId(consumed.draft.id).consumedFrom, undefined);
  assert.equal(
    data.list().drafts.find((value) => value.id === consumed.draft.id)!.consumedFrom,
    undefined,
  );
  const next = data.save(consumed.scope, 2, 'next unsent draft');
  assert.equal(next.revision, 3);
  assert.equal(next.consumedFrom, undefined);
  assert.equal(data.read(consumed.scope).consumedFrom, undefined);
  data.finishCaller('consumption-proof', 'applied');
  close();
  data = await open();
  assert.equal(data.read(consumed.scope).content, 'next unsent draft');
  assert.equal(data.read(consumed.scope).revision, 3);
  assert.equal(data.read(consumed.scope).consumedFrom, undefined);
  checked.push('committed-consumption-proof-and-save-invalidation');

  const cleared = preparePrompt('independent-clear');
  data.save(cleared.scope, 1, '');
  data.finishCaller('independent-clear', 'accepted');
  assert.equal(data.read(cleared.scope).revision, 2);
  assert.equal(data.read(cleared.scope).content, '');
  assert.equal(data.read(cleared.scope).consumedFrom, undefined);
  assert.throws(() => data.save(cleared.scope, 1, 'later edit'), /draft_revision_conflict/);
  checked.push('independent-empty-clear-keeps-cas-conflict');

  // DELETE journaling permits the UPDATE under a RESERVED lock, but a second
  // reader's SHARED lock blocks COMMIT. No hot consumption proof may leak.
  const commitFailure = preparePrompt('commit-failure');
  const reader = new DatabaseSync(path);
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT revision FROM drafts WHERE id=?').get(commitFailure.draft.id);
    assert.throws(
      () => data.finishCaller('commit-failure', 'accepted'),
      /draft_storage_unavailable/,
    );
    assert.equal(
      data.callers().find((value) => value.intent.request.commandId === 'commit-failure')!.phase,
      'submitting',
    );
    assert.equal(data.read(commitFailure.scope).revision, 1);
    assert.equal(data.read(commitFailure.scope).content, commitFailure.draft.content);
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
  }
  const independentWriter = new DatabaseSync(path);
  try {
    independentWriter
      .prepare('UPDATE drafts SET revision=2,content=? WHERE id=?')
      .run(JSON.stringify(''), commitFailure.draft.id);
  } finally {
    independentWriter.close();
  }
  assert.equal(data.read(commitFailure.scope).revision, 2);
  assert.equal(data.read(commitFailure.scope).content, '');
  assert.equal(data.read(commitFailure.scope).consumedFrom, undefined);
  checked.push('commit-rollback-cannot-publish-consumption-proof');

  let firstConsumed: ReturnType<typeof preparePrompt> | undefined;
  let lastConsumed: ReturnType<typeof preparePrompt> | undefined;
  for (let index = 0; index < 129; index++) {
    const sessionId = `bounded-consumption-${index}`;
    lastConsumed = preparePrompt(sessionId);
    firstConsumed ??= lastConsumed;
    data.finishCaller(sessionId, 'applied');
    data.clearCaller(sessionId);
  }
  assert.equal(data.read(firstConsumed!.scope).consumedFrom, undefined);
  assert.deepEqual(data.read(lastConsumed!.scope).consumedFrom, {
    commandId: 'bounded-consumption-128',
    revision: 1,
  });
  checked.push('bounded-hot-consumption-proof');
  console.log(JSON.stringify({ checked }));
} finally {
  close();
}
