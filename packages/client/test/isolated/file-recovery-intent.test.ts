import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { decodeResponse } from '../../src/decode';
import {
  canonicalFileRecoveryCodeRequest,
  canonicalFileRecoveryForkRequest,
  canonicalFileRecoveryIntent,
  canTransitionFileRecoveryPhase,
  type FileRecoveryIdentity,
  type FileRecoveryIntent,
  lookupFileRecoveryLeg,
  observeFileRecoveryLeg,
  parseFileRecoveryIntent,
  planFileRecoveryIntent,
  prepareFileRecoveryLeg,
  submitFileRecoveryLeg,
} from '../../src/file-recovery-intent';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const identity: FileRecoveryIdentity & { contextSelectionId: string } = {
  storeId: 'store-A',
  sessionId: 's',
  workspaceId: 'w',
  subjectId: 'local-user',
  contextSelectionId: 'selected-current',
};
let counter = 0;
async function plan(scope: FileRecoveryIntent['scope'] = 'both') {
  const n = ++counter;
  return planFileRecoveryIntent({
    scope,
    subjectId: identity.subjectId,
    observation: {
      storeId: identity.storeId,
      sessionId: 's',
      workspaceId: 'w',
      contextSelectionId: 'selected-current',
      checkpoint: {
        id: 'a'.repeat(64),
        workspace: { device: '1', inode: '2' },
        boundary: {
          storeId: 'original-A',
          sessionId: 'source-parent',
          workspaceId: 'source-w',
          runId: 'original-run',
          contextSelectionId: 'original-selection',
          messageId: null,
          messageSeq: '0',
          triggerMessageId: 'original-trigger',
          triggerSeq: '3',
        },
      },
      boundary: { messageId: 'selected-message', seq: '9007199254740993' },
      trigger: { messageId: 'selected-trigger', seq: '9007199254740994' },
    },
    ...(scope !== 'session' ? { code: { commandId: `code-${n}`, restoreId: `restore-${n}` } } : {}),
    ...(scope !== 'code'
      ? { fork: { commandId: `fork-${n}`, newSessionId: `new-${n}`, title: '完整 😀\r\n é' } }
      : {}),
  });
}
function command(
  i: FileRecoveryIntent,
  leg: 'code' | 'fork',
  status: 'applied' | 'accepted' | 'rejected' = 'applied',
) {
  const request = i[leg]!;
  return decodeResponse('Command', {
    id: request.request.commandId,
    sessionId: leg === 'code' ? i.sessionId : i.fork!.request.newSessionId,
    kind: leg === 'code' ? 'extension.invoke' : 'session.create',
    status,
    originStoreId: i.storeId,
    subjectId: i.subjectId,
    requestDigest: request.requestDigest,
    cancelRequestedAt: null,
    receipt:
      leg === 'code'
        ? { executionId: 'original-job', preparingNextAttempt: false }
        : {
            sessionId: i.fork!.request.newSessionId,
            selectionId: 'new-selection',
            sourceSessionId: i.sessionId,
            sourceSelectionId: i.contextSelectionId,
            sourceUpperSeq: i.boundary!.seq,
            omittedExtensionState: false,
            namespaceReport: [],
          },
  });
}
function proof(i: FileRecoveryIntent) {
  return {
    command: command(i, 'code'),
    restoreStatus: decodeResponse('FileRestoreStatus', {
      storeId: i.storeId,
      sessionId: i.sessionId,
      workspaceId: i.workspaceId,
      payload: {
        journal: {
          id: (i.code!.request.input as { restoreId: string }).restoreId,
          checkpointId: i.checkpoint.id,
          executionId: 'original-job',
          planDigest: 'b'.repeat(64),
          phase: 'restored',
          rootWorkSeq: '9223372036854775806',
          files: [
            {
              path: 'original.txt',
              operation: 'restore',
              state: 'restored',
              expected: { hash: 'd'.repeat(64), size: 4, device: '1', inode: '3' },
              original: { hash: 'c'.repeat(64), size: 250003, device: '1', inode: '2' },
              preimage: null,
              error: null,
              confirmedPost: {
                baseline: {
                  hash: 'c'.repeat(64),
                  size: 250003,
                  device: '1',
                  inode: '4',
                },
              },
            },
          ],
        },
        execution: { id: 'original-job', status: 'succeeded', resultRevision: '5' },
      },
    }),
  };
}

function currentDetail(i: FileRecoveryIntent) {
  return decodeResponse('FileCheckpointDetail', {
    storeId: i.storeId,
    sessionId: i.sessionId,
    workspaceId: i.workspaceId,
    payload: {
      checkpoint: i.checkpoint,
      files: [
        {
          path: 'original.txt',
          recordRevision: '1',
          status: 'unchanged',
          reason: null,
          preimage: null,
          original: { hash: 'c'.repeat(64), size: 250003, device: '1', inode: '2' },
          expected: { hash: 'c'.repeat(64), size: 250003, device: '1', inode: '4' },
        },
      ],
    },
  });
}

test('exact Core canonical requests preserve CRLF/Unicode and exclude only actual identity; phase never changes immutable comparison', async () => {
  const i = await plan();
  expect(canonicalFileRecoveryCodeRequest(i.code!.request)).toBe(
    JSON.stringify({
      actionId: 'files.checkpoint.restore',
      definitionVersion: '1',
      extensionId: 'builtin.files',
      input: {
        checkpointId: 'a'.repeat(64),
        restoreId: (i.code!.request.input as { restoreId: string }).restoreId,
      },
      kind: 'extension.invoke',
    }),
  );
  const fork = canonicalFileRecoveryForkRequest(i.sessionId, i.fork!.request);
  expect(fork).toContain('"kind":"session.create"');
  expect(fork).toContain('"sourceSessionId":"s"');
  expect(fork).not.toContain('newSessionId');
  expect(fork).not.toContain('commandId');
  expect(i.code!.requestDigest).toBe(sha(canonicalFileRecoveryCodeRequest(i.code!.request)));
  expect(i.fork!.requestDigest).toBe(sha(fork));
  expect(fork).toContain('\\r\\n');
  expect(fork).toContain('é');
  const applied = observeFileRecoveryLeg(i, 'code', identity, proof(i));
  expect(applied.code!.phase).toBe('succeeded');
  expect(canonicalFileRecoveryIntent(applied)).toBe(canonicalFileRecoveryIntent(i));
  expect(applied.checkpoint.boundary.sessionId).toBe('source-parent');
  expect(Object.isFrozen(applied.code!.request.input)).toBe(true);
});

test('closed keys reject delimiter collisions, missing fields and synthesized replacement keys', async () => {
  const i = await plan();
  for (const workspace of [
    { 'device|inode': '1' },
    { device: '1' },
    { inode: '2' },
    {},
    { device: '1', 'inode|device': '2' },
    { device: '1', inode: '2', 'device|inode': '3' },
  ]) {
    await expect(
      parseFileRecoveryIntent({ ...i, checkpoint: { ...i.checkpoint, workspace } }),
    ).rejects.toBeInstanceOf(Error);
  }
  const code = i.code!;
  await expect(
    parseFileRecoveryIntent({
      ...i,
      code: { request: code.request, 'phase|requestDigest': code.requestDigest },
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(await parseFileRecoveryIntent(JSON.parse(JSON.stringify(i)))).toEqual(i);
});

test('closed parser rejects authority/body/selector/digest/Decimal64 drift and keeps null boundaries distinct', async () => {
  const i = await plan();
  for (const change of [
    (x: any) => {
      x.token = 'secret';
    },
    (x: any) => {
      x.code.request.input.extra = true;
    },
    (x: any) => {
      x.code.request.actionId = 'other';
    },
    (x: any) => {
      x.code.requestDigest = '0'.repeat(64);
    },
    (x: any) => {
      x.storeId = 'store-B';
    },
    (x: any) => {
      x.fork.request.expectedContextSelectionId = 'different';
    },
    (x: any) => {
      x.boundary.seq = '9223372036854775808';
    },
    (x: any) => {
      x.code.phase = 'completed';
    },
    (x: any) => {
      x.checkpoint.boundary.messageId = 'bad';
    },
    (x: any) => {
      x.fork.request.commandId = x.code.request.commandId;
    },
  ]) {
    const raw = structuredClone(i);
    change(raw);
    await expect(parseFileRecoveryIntent(raw)).rejects.toBeInstanceOf(Error);
  }
  const raw = structuredClone(i);
  raw.boundary = null;
  raw.fork!.request.boundary = null;
  raw.fork!.requestDigest = sha(canonicalFileRecoveryForkRequest(raw.sessionId, raw.fork!.request));
  expect((await parseFileRecoveryIntent(raw)).boundary).toBeNull();
  expect(await parseFileRecoveryIntent(JSON.parse(JSON.stringify(i)))).toEqual(i);
});

test('hot permission is one attempt after durable submitting; pending and applied receipt are not Code completion', async () => {
  const i = await plan('code'),
    hot = prepareFileRecoveryLeg(i, 'code', identity, { explicitContinue: true });
  const order: string[] = [];
  const result = await submitFileRecoveryLeg(hot.intent, 'code', hot.permit, {
    currentScope: () => identity,
    async persist(saved) {
      expect(saved.code!.phase).toBe('submitting');
      order.push('durable');
    },
    async post(request) {
      expect(request).toEqual(i.code!.request);
      order.push('POST');
      return command(i, 'code');
    },
  });
  expect(order).toEqual(['durable', 'POST']);
  expect(result.intent.code!.phase).toBe('submitting');
  await expect(
    submitFileRecoveryLeg(hot.intent, 'code', hot.permit, {
      currentScope: () => identity,
      async persist() {},
      async post() {
        throw Error('must not post');
      },
    }),
  ).rejects.toThrow('file_recovery_readonly');
  expect(() => prepareFileRecoveryLeg(i, 'code', identity, { explicitContinue: true })).toThrow(
    'file_recovery_readonly',
  );
  const accepted = observeFileRecoveryLeg(result.intent, 'code', identity, {
    command: command(i, 'code', 'accepted'),
  });
  expect(accepted.code!.phase).toBe('pending');
  const noStatus = observeFileRecoveryLeg(result.intent, 'code', identity, {
    command: command(i, 'code'),
  });
  expect(noStatus.code!.phase).toBe('unknown');
});

test('failed persistence or injected POST uncertainty never grants replay; cold prepared/submitting/unknown use only original GET', async () => {
  const i = await plan('code'),
    hot = prepareFileRecoveryLeg(i, 'code', identity, { explicitContinue: true });
  let posts = 0;
  await expect(
    submitFileRecoveryLeg(hot.intent, 'code', hot.permit, {
      currentScope: () => identity,
      async persist() {
        throw Error('disk');
      },
      async post() {
        posts++;
      },
    }),
  ).rejects.toThrow('disk');
  expect(posts).toBe(0);
  const p = await plan('code'),
    h = prepareFileRecoveryLeg(p, 'code', identity, { explicitContinue: true });
  const lost = await submitFileRecoveryLeg(h.intent, 'code', h.permit, {
    currentScope: () => identity,
    async persist() {},
    async post() {
      posts++;
      throw Error('physical_drop');
    },
  });
  expect(lost.intent.code!.phase).toBe('unknown');
  expect(posts).toBe(1);
  for (const phase of ['prepared', 'submitting', 'unknown'] as const) {
    const cold = await parseFileRecoveryIntent({ ...p, code: { ...p.code!, phase } });
    const reads: string[] = [];
    const missing = await lookupFileRecoveryLeg(cold, 'code', identity, {
      async getCommand(id) {
        reads.push(id);
        return null;
      },
      async getRestoreStatus() {
        throw Error('must not read status');
      },
    });
    expect(missing.code!.phase).toBe('unknown');
    expect(reads).toEqual([p.code!.request.commandId]);
    expect(() =>
      prepareFileRecoveryLeg(cold, 'code', identity, { explicitContinue: true }),
    ).toThrow('file_recovery_readonly');
    await expect(
      submitFileRecoveryLeg(cold, 'code', JSON.parse(JSON.stringify(h.permit)), {
        currentScope: () => identity,
        async persist() {},
        async post() {
          posts++;
        },
      }),
    ).rejects.toThrow('file_recovery_readonly');
  }
  expect(posts).toBe(1);
});

test('both allows explicit Fork only after exact original Code v2 all-confirmed succeeded proof; pending/unknown/legacy/receipt drift fail closed', async () => {
  const i = await plan();
  for (const mutate of [
    (p: any) => {
      p.command.subjectId = 'other';
    },
    (p: any) => {
      p.command.requestDigest = '0'.repeat(64);
    },
    (p: any) => {
      p.command.receipt.executionId = 'another-job';
    },
    (p: any) => {
      p.restoreStatus.workspaceId = 'other';
    },
    (p: any) => {
      p.restoreStatus.payload.execution.status = 'outcome_unknown';
    },
    (p: any) => {
      p.restoreStatus.payload.journal.phase = 'restoring';
    },
    (p: any) => {
      delete p.restoreStatus.payload.journal.rootWorkSeq;
    },
    (p: any) => {
      p.restoreStatus.payload.journal.files[0].confirmedPost = null;
    },
    (p: any) => {
      p.restoreStatus.payload.journal.files[0].confirmedPost.baseline.hash = 'e'.repeat(64);
    },
    (p: any) => {
      p.restoreStatus.payload.journal.files[0].state = 'pending';
    },
  ]) {
    const p = structuredClone(proof(i));
    mutate(p);
    expect(() =>
      prepareFileRecoveryLeg(i, 'fork', identity, {
        explicitContinue: true,
        codeProof: p,
        currentDetail: currentDetail(i),
      }),
    ).toThrow('file_recovery_code_unconfirmed');
  }
  expect(() => prepareFileRecoveryLeg(i, 'fork', identity, { explicitContinue: true })).toThrow(
    'file_recovery_code_unconfirmed',
  );
  const code = observeFileRecoveryLeg(i, 'code', identity, proof(i));
  expect(code.code!.phase).toBe('succeeded');
  const h = prepareFileRecoveryLeg(code, 'fork', identity, {
    explicitContinue: true,
    codeProof: proof(i),
    currentDetail: currentDetail(i),
  });
  const sent = await submitFileRecoveryLeg(h.intent, 'fork', h.permit, {
    currentScope: () => identity,
    async persist() {},
    async post() {
      throw Error('lost');
    },
  });
  expect(sent.intent.fork!.phase).toBe('unknown');
  expect(sent.intent.code!.phase).toBe('succeeded');
  const recovered = await lookupFileRecoveryLeg(
    await parseFileRecoveryIntent(sent.intent),
    'fork',
    identity,
    {
      async getCommand(id) {
        expect(id).toBe(i.fork!.request.commandId);
        return command(i, 'fork');
      },
      async getRestoreStatus() {
        throw Error('must not query Code');
      },
    },
  );
  expect(recovered.fork!.phase).toBe('succeeded');
  expect(observeFileRecoveryLeg(recovered, 'fork', identity, null).fork!.phase).toBe('succeeded');
});

test('both explicit Fork requires closed current unchanged detail without downgrading historical Code success', async () => {
  const i = await plan(),
    known = observeFileRecoveryLeg(i, 'code', identity, proof(i));
  const detail = currentDetail(i);
  const variants: unknown[] = [
    undefined,
    { ...detail, storeId: 'foreign' },
    { ...detail, sessionId: 'other' },
    { ...detail, workspaceId: 'other' },
    { ...detail, extra: true },
    { ...detail, payload: { ...detail.payload, extra: true } },
    {
      ...detail,
      payload: {
        ...detail.payload,
        checkpoint: { ...i.checkpoint, workspace: { device: '1', inode: '99' } },
      },
    },
  ];
  for (const status of ['restore', 'remove', 'conflict', 'unavailable'])
    variants.push({
      ...detail,
      payload: { ...detail.payload, files: [{ ...detail.payload.files[0], status }] },
    });
  variants.push({
    ...detail,
    payload: { ...detail.payload, files: [{ ...detail.payload.files[0], extra: true }] },
  });
  for (const current of variants) {
    expect(() =>
      prepareFileRecoveryLeg(known, 'fork', identity, {
        explicitContinue: true,
        codeProof: proof(i),
        currentDetail: current,
      }),
    ).toThrow('file_recovery_code_unconfirmed');
    expect(known.code!.phase).toBe('succeeded');
    expect(known.fork!.phase).toBe('not_started');
  }
  expect(
    prepareFileRecoveryLeg(known, 'fork', identity, {
      explicitContinue: true,
      codeProof: proof(i),
      currentDetail: detail,
    }).intent.fork!.phase,
  ).toBe('prepared');
});

test('both current detail covers every original Code path exactly once while empty history and extra unchanged paths remain valid', async () => {
  const i = await plan(),
    p = proof(i),
    d = currentDetail(i);
  const journal = p.restoreStatus.payload.journal!;
  if (!('files' in journal)) throw Error('test_journal_missing');
  for (const files of [[], [d.payload.files[0]!, d.payload.files[0]!]]) {
    expect(() =>
      prepareFileRecoveryLeg(i, 'fork', identity, {
        explicitContinue: true,
        codeProof: p,
        currentDetail: { ...d, payload: { ...d.payload, files } },
      }),
    ).toThrow('file_recovery_code_unconfirmed');
  }
  const extended = structuredClone(p);
  const extendedJournal = extended.restoreStatus.payload.journal!;
  if (!('files' in extendedJournal) || !('rootWorkSeq' in extendedJournal))
    throw Error('test_journal_missing');
  extendedJournal.files.push({ ...extendedJournal.files[0]!, path: 'second.txt' });
  expect(() =>
    prepareFileRecoveryLeg(i, 'fork', identity, {
      explicitContinue: true,
      codeProof: extended,
      currentDetail: d,
    }),
  ).toThrow('file_recovery_code_unconfirmed');
  expect(i.code!.phase).toBe('not_started');
  expect(i.fork!.phase).toBe('not_started');
  expect(
    prepareFileRecoveryLeg(i, 'fork', identity, {
      explicitContinue: true,
      codeProof: p,
      currentDetail: {
        ...d,
        payload: {
          ...d.payload,
          files: [...d.payload.files, { ...d.payload.files[0]!, path: 'extra.txt' }],
        },
      },
    }).intent.fork!.phase,
  ).toBe('prepared');
  const empty = await plan(),
    emptyProof = proof(empty),
    emptyJournal = emptyProof.restoreStatus.payload.journal!;
  if (!('files' in emptyJournal)) throw Error('test_journal_missing');
  emptyJournal.files = [];
  expect(
    prepareFileRecoveryLeg(empty, 'fork', identity, {
      explicitContinue: true,
      codeProof: emptyProof,
      currentDetail: {
        ...currentDetail(empty),
        payload: { checkpoint: empty.checkpoint, files: [] },
      },
    }).intent.fork!.phase,
  ).toBe('prepared');
});

test('foreign Store/subject/Workspace intent is readonly; malformed fork provenance stays unknown and old success cannot regress', async () => {
  const i = await plan('session');
  let reads = 0;
  for (const changed of [
    { ...identity, storeId: 'B' },
    { ...identity, workspaceId: 'other' },
    { ...identity, subjectId: 'different' },
  ]) {
    expect(
      await lookupFileRecoveryLeg(i, 'fork', changed, {
        async getCommand() {
          reads++;
        },
        async getRestoreStatus() {
          reads++;
        },
      }),
    ).toBe(i);
    expect(() => prepareFileRecoveryLeg(i, 'fork', changed, { explicitContinue: true })).toThrow(
      'file_recovery_readonly',
    );
  }
  expect(reads).toBe(0);
  for (const change of [
    (c: any) => {
      c.receipt.sourceSessionId = 'other';
    },
    (c: any) => {
      c.sessionId = 's';
    },
    (c: any) => {
      c.receipt.sourceUpperSeq = '0';
    },
    (c: any) => {
      c.receipt.namespaceReport = [{ mode: 'copy' }];
    },
    (c: any) => {
      delete c.subjectId;
    },
  ]) {
    const c = structuredClone(command(i, 'fork'));
    change(c);
    expect(observeFileRecoveryLeg(i, 'fork', identity, c).fork!.phase).toBe('unknown');
  }
  expect(canTransitionFileRecoveryPhase('succeeded', 'unknown')).toBe(false);
  expect(canTransitionFileRecoveryPhase('failed', 'pending')).toBe(false);
  expect(canTransitionFileRecoveryPhase('unknown', 'prepared')).toBe(false);
  expect(canTransitionFileRecoveryPhase('not_started', 'prepared')).toBe(true);
});

test('Fork namespace reports use exact Core eight-key format and three reported modes', async () => {
  const i = await plan('session'),
    c = command(i, 'fork');
  for (const mode of ['copy', 'rebuild', 'omit']) {
    const report = {
      extensionId: 'builtin.files',
      contentType: 'checkpoint',
      contentVersion: 1,
      mode,
      ruleVersion: '1',
      copied: mode === 'copy' ? 1 : 0,
      rebuilt: mode === 'rebuild' ? 1 : 0,
      omitted: mode === 'omit' ? 1 : 0,
    };
    const receipt = {
      ...(c.receipt as Record<string, unknown>),
      namespaceReport: [report],
      omittedExtensionState: mode === 'omit',
    };
    expect(observeFileRecoveryLeg(i, 'fork', identity, { ...c, receipt }).fork!.phase).toBe(
      'succeeded',
    );
    for (const bad of [
      { ...report, extra: true },
      { ...report, mode: 'reject' },
      {
        extensionId: report.extensionId,
        contentType: report.contentType,
        contentVersion: 1,
        mode,
        copied: report.copied,
        rebuilt: report.rebuilt,
        omitted: report.omitted,
      },
    ]) {
      expect(
        observeFileRecoveryLeg(i, 'fork', identity, {
          ...c,
          receipt: { ...receipt, namespaceReport: [bad] },
        }).fork!.phase,
      ).toBe('unknown');
    }
  }
});

test('serializable local success does not authorize Fork; hot preparation records independently verified Code success and blocks forged permit/phase', async () => {
  const i = await plan();
  const forged = await parseFileRecoveryIntent({ ...i, code: { ...i.code!, phase: 'succeeded' } });
  expect(() =>
    prepareFileRecoveryLeg(forged, 'fork', identity, { explicitContinue: true }),
  ).toThrow('file_recovery_code_unconfirmed');
  const h = prepareFileRecoveryLeg(i, 'fork', identity, {
    explicitContinue: true,
    codeProof: proof(i),
    currentDetail: currentDetail(i),
  });
  expect(h.intent.code!.phase).toBe('succeeded');
  expect(h.intent.fork!.phase).toBe('prepared');
  expect(await parseFileRecoveryIntent(h.intent)).toEqual(h.intent);
  await expect(
    parseFileRecoveryIntent({ ...i, fork: { ...i.fork!, phase: 'pending' } }),
  ).rejects.toThrow();
  let calls = 0;
  await expect(
    submitFileRecoveryLeg(
      h.intent,
      'fork',
      { kind: 'file_recovery_hot_permit' },
      {
        currentScope: () => identity,
        async persist() {
          calls++;
        },
        async post() {
          calls++;
        },
      },
    ),
  ).rejects.toThrow('file_recovery_readonly');
  expect(calls).toBe(0);
  const cold = await parseFileRecoveryIntent(h.intent);
  const observed = await lookupFileRecoveryLeg(cold, 'fork', identity, {
    async getCommand() {
      return null;
    },
    async getRestoreStatus() {
      throw Error('must not');
    },
  });
  expect(observed.code!.phase).toBe('succeeded');
  expect(observed.fork!.phase).toBe('unknown');
});

test('fresh preparation requires exact current selection while cold original reads do not retag historical selection', async () => {
  const i = await plan('session');
  expect(() =>
    prepareFileRecoveryLeg(
      i,
      'fork',
      { ...identity, contextSelectionId: 'later-selection' },
      { explicitContinue: true },
    ),
  ).toThrow('file_recovery_readonly');
  const cold = await parseFileRecoveryIntent({ ...i, fork: { ...i.fork!, phase: 'unknown' } });
  const found = await lookupFileRecoveryLeg(cold, 'fork', identity, {
    async getCommand() {
      return command(i, 'fork');
    },
    async getRestoreStatus() {
      throw Error('must not');
    },
  });
  expect(found.fork!.phase).toBe('succeeded');
  expect(found.contextSelectionId).toBe('selected-current');
  for (const key of ['sessionId', 'storeId', 'contextSelectionId'] as const) {
    const bad = structuredClone(i);
    bad[key] = 'has.dot';
    await expect(parseFileRecoveryIntent(bad)).rejects.toThrow();
  }
  const bad = structuredClone(i);
  bad.checkpoint.workspace.inode = '02';
  await expect(parseFileRecoveryIntent(bad)).rejects.toThrow();
});

test('scope/subject/selection drift during durable write causes zero POST; cold original GET uncertainty recovers without replay', async () => {
  for (const changed of [
    { ...identity, storeId: 'B' },
    { ...identity, subjectId: 'other' },
    { ...identity, contextSelectionId: 'new' },
  ]) {
    const i = await plan('code'),
      h = prepareFileRecoveryLeg(i, 'code', identity, { explicitContinue: true });
    let writes = 0,
      posts = 0;
    const result = await submitFileRecoveryLeg(h.intent, 'code', h.permit, {
      currentScope: () => changed,
      async persist(saved) {
        writes++;
        expect(saved.code!.phase).toBe('submitting');
      },
      async post() {
        posts++;
      },
    });
    expect(result.intent.code!.phase).toBe('unknown');
    expect(writes).toBe(1);
    expect(posts).toBe(0);
  }
  const i = await plan('code'),
    cold = await parseFileRecoveryIntent({ ...i, code: { ...i.code!, phase: 'submitting' } });
  const reads: string[] = [];
  const lost = await lookupFileRecoveryLeg(cold, 'code', identity, {
    async getCommand(id) {
      reads.push(id);
      throw Error('first_GET_lost');
    },
    async getRestoreStatus() {
      throw Error('must not');
    },
  });
  expect(lost.code!.phase).toBe('unknown');
  const confirmed = await lookupFileRecoveryLeg(lost, 'code', identity, {
    async getCommand(id) {
      reads.push(id);
      return command(i, 'code');
    },
    async getRestoreStatus(s, point, restore) {
      expect([s, point, restore]).toEqual([
        i.sessionId,
        i.checkpoint.id,
        (i.code!.request.input as { restoreId: string }).restoreId,
      ]);
      return proof(i).restoreStatus;
    },
  });
  expect(confirmed.code!.phase).toBe('succeeded');
  expect(reads).toEqual([i.code!.request.commandId, i.code!.request.commandId]);
  const unknown = proof(i);
  unknown.restoreStatus.payload.journal!.phase = 'outcome_unknown';
  unknown.restoreStatus.payload.execution!.status = 'failed';
  expect(observeFileRecoveryLeg(cold, 'code', identity, unknown).code!.phase).toBe('unknown');
});
