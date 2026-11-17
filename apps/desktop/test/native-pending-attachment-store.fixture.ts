import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  type AgentClient,
  type Command,
  canonicalCallerCommandRequest,
  type SessionView,
  type StartCommandRequest,
} from '@kite-ai/client';
import {
  callerDigest,
  callerTarget,
  callerTextDigest,
  NativeCallerJournal,
} from '../electron/caller-journal';
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
const scope = (rootSessionId: string) => ({
  storeId: 'store',
  workspaceId: 'workspace',
  rootSessionId,
});
const bytes = Buffer.from('pending original bytes 雪');
const hash = createHash('sha256').update(bytes).digest('hex');
const image = {
  id: 'image',
  kind: 'image' as const,
  name: 'image.png',
  mediaType: 'image/png',
  size: bytes.length,
  hash,
  state: 'ready' as const,
  chunks: [bytes],
};
const file = {
  ...image,
  id: 'file',
  kind: 'file' as const,
  name: 'file.txt',
  mediaType: 'text/plain',
};
const reference = {
  id: 'reference',
  kind: 'reference' as const,
  name: 'local.txt',
  uri: 'file:///not-read/local.txt',
  state: 'ready' as const,
};
const checked: string[] = [];
function record(sessionId: string, phase: NativeCallerRecord['phase']): NativeCallerRecord {
  const request: StartCommandRequest = {
    kind: 'run.start',
    commandId: `command-${sessionId}`,
    expectedStoreId: 'store',
    content: 'send',
  };
  const callerScope = { storeId: 'store', workspaceId: 'workspace', sessionId };
  return {
    phase,
    intent: {
      scope: callerScope,
      subjectId: 'local-user',
      request,
      target: callerTarget(callerScope, request),
      bodyDigest: callerDigest(request),
      requestDigest: callerTextDigest(canonicalCallerCommandRequest(request)),
    },
  };
}
try {
  const original = data.attachments!.save(scope('restart'), 0, [image, file, reference]);
  assert.equal(original.revision, 1);
  close();
  data = await open();
  const restored = data.attachments!.read(scope('restart'));
  assert.equal(restored.attachments.length, 3);
  assert.equal(restored.attachments[2]!.uri, reference.uri);
  assert.deepEqual(Buffer.concat(data.attachments!.readBytes(scope('restart'), 'image')), bytes);
  assert.deepEqual(Buffer.concat(data.attachments!.readBytes(scope('restart'), 'file')), bytes);
  checked.push('cold-reopen-original-image-file-and-local-reference');
  assert.equal(
    data.attachments!.read({ ...scope('restart'), storeId: 'other' }).attachments.length,
    0,
  );
  assert.equal(
    data.attachments!.read({ ...scope('restart'), workspaceId: 'other' }).attachments.length,
    0,
  );
  checked.push('store-and-workspace-isolation');
  data.attachments!.save(scope('restart'), restored.revision, []);
  assert.throws(() => data.attachments!.save(scope('restart'), restored.revision, [image]));
  assert.throws(() => data.attachments!.readBytes(scope('restart'), 'image'));
  checked.push('removal-frees-bytes-and-stale-write-cannot-resurrect');
  data.attachments!.save(scope('deleted'), 0, [file]);
  data.attachments!.deleteSession('store', 'deleted');
  assert.throws(() => data.attachments!.save(scope('deleted'), 1, [file]));
  close();
  data = await open();
  assert.throws(() => data.attachments!.save(scope('deleted'), 0, [file]));
  checked.push('deleted-session-tombstone-survives-restart');
  for (const phase of ['accepted', 'applied', 'unknown', 'rejected'] as const) {
    const saved = data.attachments!.save(scope(phase), 0, [image, file]);
    data.attachments!.bind(`command-${phase}`, scope(phase), saved.revision, ['image'], ['file']);
    data.beginCaller(record(phase, 'submitting'));
    close();
    data = await open();
    data.finishCaller(`command-${phase}`, phase);
    const next = data.attachments!.read(scope(phase));
    assert.equal(next.attachments.length, phase === 'accepted' || phase === 'applied' ? 0 : 2);
  }
  checked.push('accepted-only-exact-batch-consumption-unknown-and-rejected-retain');
  const saved = data.attachments!.save(scope('newer'), 0, [image]);
  data.attachments!.bind('command-newer', scope('newer'), saved.revision, ['image'], []);
  data.attachments!.save(scope('newer'), saved.revision, [image, file]);
  data.beginCaller(record('newer', 'submitting'));
  data.finishCaller('command-newer', 'accepted');
  close();
  data = await open();
  assert.deepEqual(
    data.attachments!.read(scope('newer')).attachments.map((item) => item.id),
    ['file'],
  );
  assert.throws(() => data.attachments!.readBytes(scope('newer'), 'image'));
  checked.push('accepted-old-items-removed-newer-additions-survive-cold-open');
  const replacementBytes = Buffer.from('replacement image bytes');
  const replacement = {
    ...image,
    size: replacementBytes.length,
    hash: createHash('sha256').update(replacementBytes).digest('hex'),
    chunks: [replacementBytes],
  };
  const replaced = data.attachments!.save(scope('replaced'), 0, [image]);
  data.attachments!.bind('command-replaced', scope('replaced'), replaced.revision, ['image'], []);
  data.attachments!.save(scope('replaced'), replaced.revision, [replacement]);
  data.beginCaller(record('replaced', 'submitting'));
  data.finishCaller('command-replaced', 'accepted');
  close();
  data = await open();
  assert.equal(data.attachments!.read(scope('replaced')).attachments[0]!.hash, replacement.hash);
  assert.deepEqual(
    Buffer.concat(data.attachments!.readBytes(scope('replaced'), 'image')),
    replacementBytes,
  );
  checked.push('same-id-new-bytes-not-consumed-by-older-proof');
  const race = data.attachments!.save(scope('capture-race'), 0, [image]);
  const bind = data.attachments!.capture(scope('capture-race'), race.revision, ['image'], []);
  data.attachments!.save(scope('capture-race'), race.revision, [image, file]);
  bind('command-capture-race');
  data.beginCaller(record('capture-race', 'submitting'));
  close();
  data = await open();
  data.finishCaller('command-capture-race', 'accepted');
  close();
  data = await open();
  assert.deepEqual(
    data.attachments!.read(scope('capture-race')).attachments.map((item) => item.id),
    ['file'],
  );
  assert.deepEqual(
    Buffer.concat(data.attachments!.readBytes(scope('capture-race'), 'file')),
    bytes,
  );
  assert.throws(() => data.attachments!.readBytes(scope('capture-race'), 'image'));
  checked.push('capture-then-edit-then-bind-cold-accept-consumes-only-captured-items');
  assert.throws(() =>
    data.attachments!.save(
      scope('limits'),
      0,
      Array.from({ length: 129 }, (_, i) => ({ ...reference, id: `ref-${i}` })),
    ),
  );
  assert.equal(data.attachments!.read(scope('limits')).revision, 0);
  checked.push('count-budget-rejection-is-atomic');
  const empty = {
    ...file,
    id: 'empty',
    size: 0,
    hash: createHash('sha256').digest('hex'),
    chunks: [],
  };
  data.attachments!.save(scope('empty'), 0, [empty]);
  close();
  data = await open();
  assert.deepEqual(data.attachments!.readBytes(scope('empty'), 'empty'), []);
  assert.equal(data.attachments!.read(scope('empty')).attachments[0]!.state, 'ready');
  checked.push('zero-byte-file-reopens');
  data.attachments!.save(scope('corrupt'), 0, [image, file]);
  const database = new DatabaseSync(
    join(selectProfile(input.profile).profilePath, 'desktop-private', 'data.sqlite'),
  );
  try {
    const draftId = database
      .prepare('SELECT id FROM pending_attachment_drafts WHERE session_id=?')
      .get('corrupt')!.id!;
    database
      .prepare('UPDATE pending_attachment_chunks SET bytes=? WHERE draft_id=? AND attachment_id=?')
      .run(Buffer.alloc(bytes.length, 1), draftId, 'image');
    const corrupt = data.attachments!.read(scope('corrupt'));
    assert.equal(corrupt.attachments[0]!.state, 'error');
    assert.equal(corrupt.attachments[1]!.state, 'ready');
    assert.deepEqual(Buffer.concat(data.attachments!.readBytes(scope('corrupt'), 'file')), bytes);
    database
      .prepare('DELETE FROM pending_attachment_chunks WHERE draft_id=? AND attachment_id=?')
      .run(draftId, 'file');
    assert.equal(data.attachments!.read(scope('corrupt')).attachments[1]!.state, 'error');
  } finally {
    database.close();
  }
  checked.push('corrupt-and-missing-chunks-are-item-local-errors');
  assert.throws(() =>
    data.attachments!.save(
      scope('image-limit'),
      0,
      Array.from({ length: 11 }, (_, i) => ({ ...image, id: `image-${i}` })),
    ),
  );
  assert.equal(data.attachments!.read(scope('image-limit')).revision, 0);
  checked.push('image-count-limit-atomic');
  const subset = data.attachments!.save(scope('subset'), 0, [image, file]);
  data.attachments!.capture(scope('subset'), subset.revision, ['image'], [])('command-subset');
  data.beginCaller(record('subset', 'submitting'));
  data.finishCaller('command-subset', 'accepted');
  close();
  data = await open();
  assert.deepEqual(
    data.attachments!.read(scope('subset')).attachments.map((item) => item.id),
    ['file'],
  );
  assert.deepEqual(Buffer.concat(data.attachments!.readBytes(scope('subset'), 'file')), bytes);
  checked.push('capture-latest-version-only-consumes-explicit-submitted-subset');
  data.attachments!.deleteSession('store', 'never-written');
  assert.throws(() => data.attachments!.save(scope('never-written'), 0, [file]));
  close();
  data = await open();
  assert.throws(() => data.attachments!.save(scope('never-written'), 0, [file]));
  assert.throws(() =>
    data.attachments!.save({ ...scope('never-written'), workspaceId: 'another-workspace' }, 0, [
      file,
    ]),
  );
  assert.equal(
    data.attachments!.save({ ...scope('never-written'), storeId: 'another-store' }, 0, [file])
      .attachments.length,
    1,
  );
  checked.push('never-written-deletion-tombstone-is-durable-and-store-scoped');
  const sourceScope = scope('new-conversation');
  const targetScope = scope('move-target');
  const source = data.attachments!.save(sourceScope, 0, [image]);
  const target = data.attachments!.save(targetScope, 0, [file]);
  data.attachments!.capture(sourceScope, source.revision, ['image'], [])('command-move-target');
  data.beginCaller(record('move-target', 'submitting'));
  data.finishCaller('command-move-target', 'unknown');
  assert.throws(() => data.attachments!.move(sourceScope, 0, targetScope, target.revision));
  assert.deepEqual(Buffer.concat(data.attachments!.readBytes(sourceScope, 'image')), bytes);
  assert.equal(data.attachments!.read(targetScope).revision, target.revision);
  const moved = data.attachments!.move(sourceScope, source.revision, targetScope, target.revision);
  assert.equal(moved.attachments.length, 2);
  assert.equal(data.attachments!.read(sourceScope).attachments.length, 0);
  assert.throws(() => data.attachments!.save(sourceScope, source.revision, [image]));
  close();
  data = await open();
  assert.equal(data.attachments!.read(sourceScope).attachments.length, 0);
  assert.deepEqual(Buffer.concat(data.attachments!.readBytes(targetScope, 'image')), bytes);
  data.finishCaller('command-move-target', 'accepted');
  close();
  data = await open();
  assert.deepEqual(
    data.attachments!.read(targetScope).attachments.map((entry) => entry.id),
    ['file'],
  );
  checked.push('atomic-move-cold-restore-cas-and-unknown-binding-migration');
  const conflictSource = data.attachments!.read(sourceScope);
  data.attachments!.save(sourceScope, conflictSource.revision, [image]);
  const conflictTarget = scope('move-conflict');
  const conflict = data.attachments!.save(conflictTarget, 0, [replacement]);
  assert.throws(() =>
    data.attachments!.move(
      sourceScope,
      conflictSource.revision + 1,
      conflictTarget,
      conflict.revision,
    ),
  );
  assert.deepEqual(Buffer.concat(data.attachments!.readBytes(sourceScope, 'image')), bytes);
  assert.deepEqual(
    Buffer.concat(data.attachments!.readBytes(conflictTarget, 'image')),
    replacementBytes,
  );
  assert.equal(data.attachments!.read(conflictTarget).revision, conflict.revision);
  checked.push('move-conflicting-identity-rolls-back-both-scopes-and-bytes');
  const recoveryScope = scope('recover-rejected');
  const pendingRecovery = data.attachments!.save(recoveryScope, 0, [image]);
  data.attachments!.bind(
    'command-recover-rejected',
    recoveryScope,
    pendingRecovery.revision,
    ['image'],
    [],
  );
  data.beginCaller(record('recover-rejected', 'submitting'));
  data.finishCaller('command-recover-rejected', 'accepted');
  close();
  data = await open();
  assert.equal(data.attachments!.read(recoveryScope).attachments.length, 0);
  assert.equal(data.attachments!.recoveryItems('command-recover-rejected')![0]!.id, 'image');
  data.attachments!.save(recoveryScope, data.attachments!.read(recoveryScope).revision, [file]);
  data.finishCaller('command-recover-rejected', 'rejected');
  const retryImage = { ...image, id: 'image-retry' };
  data.attachments!.recover(record('recover-rejected', 'rejected'), [retryImage]);
  close();
  data = await open();
  assert.deepEqual(
    data
      .attachments!.read(recoveryScope)
      .attachments.map((entry) => entry.id)
      .sort(),
    ['file', 'image-retry'],
  );
  assert.deepEqual(Buffer.concat(data.attachments!.readBytes(recoveryScope, 'image-retry')), bytes);
  assert.equal(data.attachments!.proof('command-recover-rejected')!.recovery!.phase, 'restored');
  data.attachments!.recover(record('recover-rejected', 'rejected'), [retryImage]);
  assert.equal(data.attachments!.read(recoveryScope).attachments.length, 2);
  data.attachments!.save(recoveryScope, data.attachments!.read(recoveryScope).revision, [file]);
  data.attachments!.recover(record('recover-rejected', 'rejected'), [retryImage]);
  assert.deepEqual(
    data.attachments!.read(recoveryScope).attachments.map((entry) => entry.id),
    ['file'],
  );
  checked.push('accepted-cold-hidden-rejected-recovers-new-id-once-preserving-newer-files');
  for (const failure of ['deleted-recovery', 'capacity-recovery']) {
    const failureScope = scope(failure);
    const savedFailure = data.attachments!.save(failureScope, 0, [image]);
    data.attachments!.bind(
      `command-${failure}`,
      failureScope,
      savedFailure.revision,
      ['image'],
      [],
    );
    data.beginCaller(record(failure, 'submitting'));
    data.finishCaller(`command-${failure}`, 'accepted');
    const afterAcceptance = data.attachments!.read(failureScope);
    const retained =
      failure === 'capacity-recovery'
        ? Array.from({ length: 10 }, (_, i) => ({ ...image, id: `retained-${i}` }))
        : [file];
    data.attachments!.save(failureScope, afterAcceptance.revision, retained);
    data.finishCaller(`command-${failure}`, 'rejected');
    if (failure === 'deleted-recovery') data.attachments!.deleteSession('store', failure);
    assert.throws(() => data.attachments!.recover(record(failure, 'rejected'), [retryImage]));
    assert.equal(data.attachments!.recoveryItems(`command-${failure}`)![0]!.id, 'image');
    if (failure === 'capacity-recovery') {
      assert.deepEqual(
        data.attachments!.read(failureScope).attachments.map((entry) => entry.id),
        retained.map((entry) => entry.id),
      );
      assert.deepEqual(
        Buffer.concat(data.attachments!.readBytes(failureScope, retained[0]!.id)),
        bytes,
      );
    }
    data.attachments!.recoveryFailed(
      record(failure, 'rejected'),
      'attachment_recovery_unavailable',
    );
    assert.equal(data.attachments!.proof(`command-${failure}`)!.recovery!.phase, 'unavailable');
    assert.throws(() => data.clearCaller(`command-${failure}`));
  }
  checked.push('recovery-deleted-and-capacity-failure-preserve-evidence-and-block-clear');
  // Commit only the rejected receipt, then cold-open before any asynchronous reads.
  const crashScope = scope('rejection-crash');
  const crashSaved = data.attachments!.save(crashScope, 0, [image, file]);
  data.attachments!.bind(
    'command-rejection-crash',
    crashScope,
    crashSaved.revision,
    ['image'],
    ['file'],
  );
  data.beginCaller(record('rejection-crash', 'submitting'));
  data.finishCaller('command-rejection-crash', 'accepted');
  data.finishCaller('command-rejection-crash', 'rejected');
  close();
  data = await open();
  assert.equal(data.attachments!.proof('command-rejection-crash')!.recovery!.phase, 'unavailable');
  assert.equal(
    data.attachments!.proof('command-rejection-crash')!.recovery!.error,
    'attachment_recovery_pending',
  );
  assert.equal(data.attachments!.read(crashScope).attachments.length, 0);
  assert.throws(() => data.clearCaller('command-rejection-crash'));
  assert.deepEqual(
    data.attachments!.recoveryItems('command-rejection-crash')!.map((item) => item.id),
    ['image', 'file'],
  );
  checked.push('rejected-receipt-crash-atomically-keeps-cold-recovery-marker-and-originals');
  for (const mode of ['removed', 'replaced', 'all-removed'] as const) {
    const session = `during-send-${mode}`,
      target = scope(session),
      commandId = `command-${session}`;
    const saved = data.attachments!.save(target, 0, [image, file]);
    data.attachments!.bind(commandId, target, saved.revision, ['image'], ['file']);
    data.beginCaller(record(session, 'submitting'));
    const replacementBytes = Buffer.from('new user choice');
    const replacement = {
      ...image,
      hash: createHash('sha256').update(replacementBytes).digest('hex'),
      size: replacementBytes.length,
      chunks: [replacementBytes],
    };
    data.attachments!.save(
      target,
      saved.revision,
      mode === 'removed' ? [file] : mode === 'replaced' ? [replacement, file] : [],
    );
    data.finishCaller(commandId, 'accepted');
    data.finishCaller(commandId, 'accepted');
    data.finishCaller(commandId, 'rejected');
    close();
    data = await open();
    if (mode === 'all-removed') {
      assert.equal(data.attachments!.recoveryItems(commandId), undefined);
      assert.equal(data.attachments!.proof(commandId)!.recovery!.phase, 'not_needed');
      assert.equal(data.attachments!.read(target).attachments.length, 0);
    } else {
      assert.deepEqual(
        data.attachments!.recoveryItems(commandId)!.map((item) => item.id),
        ['file'],
      );
      data.attachments!.recover(record(session, 'rejected'), [
        { ...file, id: `retry-file-${mode}` },
      ]);
      close();
      data = await open();
      const result = data.attachments!.read(target);
      assert.deepEqual(
        result.attachments.map((item) => item.id),
        mode === 'removed' ? ['retry-file-removed'] : ['image', 'retry-file-replaced'],
      );
      if (mode === 'replaced')
        assert.deepEqual(
          Buffer.concat(data.attachments!.readBytes(target, 'image')),
          replacementBytes,
        );
      data.attachments!.recover(record(session, 'rejected'), [
        { ...file, id: `retry-file-${mode}` },
      ]);
      assert.equal(data.attachments!.read(target).revision, result.revision);
    }
  }
  checked.push(
    'late-rejection-recovers-only-receipt-consumed-intersection-not-user-removal-or-replacement',
  );
  // Exercise the real journal cold lookup and immutable Artifact recovery together.
  for (const mode of [
    'success',
    'foreign',
    'artifact-failure',
    'hash-mismatch',
    'message',
    'late-page',
    'run',
    'late-delete',
  ] as const) {
    const sessionId = `journal-recovery-${mode}`,
      commandId = `command-${sessionId}`;
    const target = scope(sessionId),
      saved = data.attachments!.save(target, 0, [image, file, reference]);
    data.attachments!.bind(commandId, target, saved.revision, [image.id], [file.id], [reference]);
    const original = record(sessionId, 'submitting');
    const artifact = (kind: 'image' | 'file') => ({
      id:
        kind === 'image'
          ? `input-image-${image.id}-${sessionId}`
          : `input-file-${createHash('sha256')
              .update(JSON.stringify(['store', sessionId, file.id]))
              .digest('hex')}`,
      storeId: 'store',
      sessionId,
      subjectId: 'local-user',
      scope: { kind: 'session' as const, id: sessionId },
      hash,
      size: String(bytes.length),
      mediaType: kind === 'image' ? ('image/png' as const) : 'text/plain',
    });
    const imageRef = { ...artifact('image'), mediaType: 'image/png' as const },
      fileRef = artifact('file');
    const request: StartCommandRequest = {
      kind: 'run.start',
      expectedStoreId: 'store',
      commandId,
      content: 'original',
      images: [{ name: image.name, reference: imageRef }],
      files: [
        { name: file.name, uri: 'file:///artifact/file.txt', reference: fileRef },
        { name: reference.name, uri: reference.uri },
      ],
    };
    original.intent.request = request;
    original.intent.bodyDigest = callerDigest(request);
    original.intent.requestDigest = callerTextDigest(canonicalCallerCommandRequest(request));
    data.beginCaller(original);
    data.finishCaller(commandId, 'accepted');
    data.finishCaller(commandId, 'rejected');
    close();
    data = await open();
    assert.equal(data.attachments!.proof(commandId)!.recovery!.phase, 'unavailable');
    assert.equal(data.attachments!.read(target).attachments.length, 0);
    data.attachments!.save(target, data.attachments!.read(target).revision, [
      { ...reference, id: 'later-B', name: 'B.txt', uri: 'file:///B.txt' },
    ]);
    const command: Command = {
      id: commandId,
      kind: 'run.start',
      sessionId,
      originStoreId: mode === 'foreign' ? 'other-store' : 'store',
      subjectId: 'local-user',
      requestDigest: original.intent.requestDigest,
      status: 'rejected',
      receipt: { reason: 'target_stopped' },
      cancelRequestedAt: null,
    };
    let reads = 0,
      posts = 0,
      pages = 0,
      views = 0;
    const message = (seq: string, origin?: string) => ({
      id: `message-${seq}`,
      sessionId,
      runId: null,
      seq,
      role: 'user' as const,
      content: 'saved',
      status: 'complete' as const,
      ...(origin ? { originCommandId: origin } : {}),
    });
    const view = () =>
      ({
        storeId: 'store',
        snapshotCursor: '1',
        session: {
          id: sessionId,
          workspaceId: 'workspace',
          parentSessionId: null,
          rootSessionId: sessionId,
          title: 'test',
          nextSeq: mode === 'late-page' ? '202' : '1',
          contextSelectionId: 'selection',
          controlRevision: '1',
          deletedAt: mode === 'late-delete' && views > 1 ? 1 : null,
        },
        runs: mode === 'run' ? [{ id: 'actual-run', originCommandId: commandId }] : [],
        executions: [],
        messages: mode === 'message' ? [message('1', commandId)] : [],
      }) as unknown as SessionView;
    const client = {
      serverInfo: { storeId: 'store', subjectId: 'local-user' },
      async getCommand() {
        return command;
      },
      async getView() {
        views++;
        return view();
      },
      async listMessages() {
        pages++;
        return mode === 'late-page'
          ? pages === 1
            ? Array.from({ length: 200 }, (_, i) => message(String(i + 1)))
            : [message('201', commandId)]
          : [];
      },
      async readArtifact(
        _session: string,
        request: { refId: string },
        options: { expectedReference: unknown },
      ) {
        reads++;
        assert.deepEqual(
          options.expectedReference,
          request.refId === imageRef.id ? imageRef : fileRef,
        );
        if (mode === 'artifact-failure') throw Error('artifact_content_unavailable');
        return {
          reference: options.expectedReference,
          content: mode === 'hash-mismatch' ? Buffer.alloc(bytes.length) : bytes,
        };
      },
      async startRun() {
        posts++;
        throw Error('unexpected_post');
      },
      async uploadInputFile() {
        posts++;
        throw Error('unexpected_post');
      },
      async uploadInputImage() {
        posts++;
        throw Error('unexpected_post');
      },
    } as unknown as AgentClient;
    const journal = new NativeCallerJournal(client, data);
    if (mode === 'foreign') await assert.rejects(journal.lookup(commandId));
    else await journal.lookup(commandId);
    assert.equal(posts, 0);
    const proof = data.attachments!.proof(commandId)!;
    if (mode === 'success') {
      assert.equal(reads, 2);
      assert.equal(proof.recovery!.phase, 'restored');
      const restored = data.attachments!.read(target);
      assert.equal(restored.attachments.length, 4);
      assert.equal(restored.attachments[0]!.id, 'later-B');
      const recoveredFile = restored.attachments.find((item) => item.kind === 'file')!;
      assert.notEqual(recoveredFile.id, file.id);
      assert.notEqual(
        createHash('sha256')
          .update(JSON.stringify(['store', sessionId, recoveredFile.id]))
          .digest('hex'),
        fileRef.id.slice('input-file-'.length),
      );
      for (const item of restored.attachments.filter((item) => item.kind !== 'reference'))
        assert.deepEqual(Buffer.concat(data.attachments!.readBytes(target, item.id)), bytes);
      close();
      data = await open();
      const coldJournal = new NativeCallerJournal(client, data);
      await coldJournal.lookup(commandId);
      assert.equal(reads, 2);
      assert.equal(data.attachments!.read(target).revision, restored.revision);
      data.attachments!.save(target, restored.revision, [restored.attachments[0]!]);
      await coldJournal.lookup(commandId);
      assert.equal(data.attachments!.read(target).attachments.length, 1);
    } else if (['message', 'late-page', 'run'].includes(mode)) {
      assert.equal(reads, 0);
      assert.equal(proof.recovery!.phase, 'not_needed');
      assert.equal(data.attachments!.read(target).attachments.length, 1);
      if (mode === 'late-page') assert.equal(pages, 2);
    } else {
      assert.equal(data.attachments!.read(target).attachments.length, 1);
      assert.equal(data.attachments!.recoveryItems(commandId)!.length, 3);
      if (mode !== 'foreign') {
        assert.equal(proof.recovery!.phase, 'unavailable');
        assert.throws(() => data.clearCaller(commandId));
      }
    }
  }
  checked.push(
    'real-cold-journal-artifact-recovery-new-import-identities-no-post-and-idempotent-removal',
  );
  checked.push(
    'recovery-authority-history-conflicts-byte-failure-and-late-deletion-retain-originals',
  );

  console.log(JSON.stringify({ checked }));
} finally {
  close();
}
