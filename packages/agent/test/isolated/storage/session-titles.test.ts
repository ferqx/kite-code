import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import { expect, test } from '#kite-test';
import {
  automaticTitleIdentity,
  automaticTitleRecord,
  readAutomaticTitleAttempt,
} from '../../../src/business/session-title/state';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture(title = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-title-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  return {
    profile,
    store,
    base,
    owner,
    async admit(commandId: string, content: string) {
      await store.acceptCommand({ ...base, commandId, request: { kind: 'run.start', content } });
    },
    async start(commandId: string) {
      return store.startRun({
        expectedStoreId,
        owner,
        commandId,
        configuration: { modelId: 'fixture' },
      });
    },
    async close() {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('persisting user Messages does not infer a Session title or emit an implicit rename', async () => {
  const f = await fixture();
  try {
    expect((await f.store.getSession('s'))!.title).toBe('');
    const original = `🪁{"task":"请保留第一条原文"}\n${'完整用户正文 🪁 '.repeat(25)}`;
    await f.admit('first', original);
    expect((await f.store.getSession('s'))!.title).toBe('');
    const run = await f.start('first');
    expect(await f.store.getSession('s')).toMatchObject({
      title: '',
      controlRevision: '0',
    });
    await f.store.finishRun({
      expectedStoreId: f.base.expectedStoreId,
      owner: f.owner,
      runId: run.id,
      status: 'completed',
      requirements: [],
    });
    await f.admit('second', 'A later message must not rename the Session');
    await f.start('second');
    expect(await f.store.getSession('s')).toMatchObject({
      title: '',
      controlRevision: '0',
    });
    const { events } = await f.store.getChanges({ after: '0', limit: 100 });
    expect(events.filter((event) => event.type === 'session.renamed')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('explicit creation and a rename before a delayed Run preserve the chosen title', async () => {
  const f = await fixture('CLI chosen title');
  const peer = await openSqliteStore(f.profile);
  try {
    await f.admit('late', 'Late original message');
    await peer.renameSession({
      ...f.base,
      commandId: 'rename',
      ifRevision: '0',
      title: 'User chosen title',
    });
    await f.start('late');
    expect(await f.store.getSession('s')).toMatchObject({
      title: 'User chosen title',
      controlRevision: '1',
    });
  } finally {
    await peer.close();
    await f.close();
  }
});

test('an explicit rename before message materialization remains unchanged across Workers', async () => {
  const f = await fixture();
  const peer = await openSqliteStore(f.profile);
  try {
    await f.admit('late', 'Queued first message');
    await peer.renameSession({
      ...f.base,
      commandId: 'rename',
      ifRevision: '0',
      title: 'Chosen while queued',
    });
    await f.start('late');
    expect(await f.store.getSession('s')).toMatchObject({
      title: 'Chosen while queued',
      controlRevision: '1',
    });
    expect(
      (await f.store.getChanges({ after: '0', limit: 100 })).events.filter(
        (event) => event.type === 'session.renamed',
      ),
    ).toHaveLength(1);
  } finally {
    await peer.close();
    await f.close();
  }
});

test('automatic fallback and intent commit together without advancing execution control revision', async () => {
  const f = await fixture();
  try {
    const content = '  修复   会话\n\n命名🙂 并保留全文  ';
    await f.admit('first', content);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const claimed = await f.store.claimAutomaticSessionTitle({
      ...f.base,
      sourceCommandId: 'first',
    });
    expect(claimed?.session).toMatchObject({ title: '修复 会话 命名🙂', controlRevision: '0' });
    expect(claimed?.command).toMatchObject({
      kind: 'session.rename',
      status: 'applied',
      request: { kind: 'session.rename', ifRevision: '0', title: claimed?.session.title },
    });
    expect(readAutomaticTitleAttempt(claimed!.record.value)).toMatchObject({
      sourceCommandId: 'first',
      publication: 'pending',
      sourceRunId: null,
      jobExecutionId: null,
    });
    const events = (await f.store.getChanges({ after: before, limit: 20 })).events;
    expect(events.map((event) => event.type)).toEqual([
      'session.renamed',
      'extension.record_updated',
    ]);
    expect(events[0]?.payload).toMatchObject({ controlRevision: '0' });
    const run = await f.start('first');
    expect((await f.store.listMessages('s'))[0]?.content).toBe(content);
    expect(run.originCommandId).toBe('first');
    expect((await f.store.getSession('s'))?.controlRevision).toBe('0');
  } finally {
    await f.close();
  }
});

test('concurrent Workers share one exact fallback receipt and idempotent lookup never writes over a manual name', async () => {
  const f = await fixture(),
    peer = await openSqliteStore(f.profile);
  try {
    await f.admit('first', '原始输入标题');
    const input = { ...f.base, sourceCommandId: 'first' };
    const [one, two] = await Promise.all([
      f.store.claimAutomaticSessionTitle(input),
      peer.claimAutomaticSessionTitle(input),
    ]);
    expect(one?.command.id).toBe(two?.command.id);
    expect(one?.record.revision).toBe('1');
    expect(two?.record.revision).toBe('1');
    await peer.renameSession({
      ...f.base,
      commandId: 'manual-a',
      ifRevision: '0',
      title: '另一个名称',
    });
    await peer.renameSession({
      ...f.base,
      commandId: 'manual-b',
      ifRevision: '1',
      title: one!.session.title,
    });
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const again = await f.store.claimAutomaticSessionTitle(input);
    expect(again?.command).toEqual(one?.command);
    expect(again?.session.controlRevision).toBe('2');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(again?.record).toEqual(one?.record);
  } finally {
    await peer.close();
    await f.close();
  }
});

test('public rename cannot reuse an internal automatic receipt even with identical original JSON', async () => {
  const f = await fixture();
  try {
    await f.admit('first', 'exact first input');
    const claimed = await f.store.claimAutomaticSessionTitle({
      ...f.base,
      sourceCommandId: 'first',
    });
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const refused = await f.store
      .renameSession({
        ...f.base,
        commandId: claimed!.command.id,
        ifRevision: '0',
        title: claimed!.session.title,
      })
      .catch((error) => error);
    expect(refused.code).toBe('command_conflict');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
  } finally {
    await f.close();
  }
});

test('internal fallback cannot adopt a public receipt sharing its stable ID', async () => {
  const f = await fixture();
  try {
    await f.admit('first', 'exact first input');
    const identity = automaticTitleIdentity(f.base.expectedStoreId, 's', 'first');
    await f.store.renameSession({
      ...f.base,
      commandId: identity.fallbackCommandId,
      ifRevision: '0',
      title: 'exact firs',
    });
    const refused = await f.store
      .claimAutomaticSessionTitle({ ...f.base, sourceCommandId: 'first' })
      .catch((error) => error);
    expect(refused.code).toBe('command_conflict');
    expect(
      await f.store.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }),
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test.each([
  'named',
  'later',
  'existing-run',
  'manual-name',
] as const)('automatic claim does not adopt %s history', async (kind) => {
  const f = await fixture(kind === 'named' ? 'Explicit' : '');
  try {
    await f.admit('first', 'First input');
    if (kind === 'later') await f.admit('second', 'Second input');
    if (kind === 'existing-run') await f.start('first');
    if (kind === 'manual-name')
      await f.store.renameSession({
        ...f.base,
        commandId: 'manual',
        ifRevision: '0',
        title: 'Explicit',
      });
    const before = (await f.store.getMetadata()).lastChangeCursor;
    expect(
      await f.store.claimAutomaticSessionTitle({
        ...f.base,
        sourceCommandId: kind === 'later' ? 'second' : 'first',
      }),
    ).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
  } finally {
    await f.close();
  }
});

test('automatic claim refuses foreign identities and reopens as readonly metadata without reacquiring work', async () => {
  const f = await fixture();
  try {
    await f.admit('first', 'source');
    const refused = await f.store
      .claimAutomaticSessionTitle({ ...f.base, sourceCommandId: 'first', subjectId: 'foreign' })
      .catch((error) => error);
    expect(refused.code).toBe('session_title_source_invalid');
    const claimed = await f.store.claimAutomaticSessionTitle({
      ...f.base,
      sourceCommandId: 'first',
    });
    await f.store.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(await cold.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' })).toEqual(
        claimed!.record,
      );
      expect((await cold.getSession('s'))?.controlRevision).toBe('0');
      expect((await cold.getView('s')).runs).toHaveLength(0);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('a failure between fallback receipt and intent insertion rolls back title, sequence, events and receipt together', async () => {
  const f = await fixture();
  const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  try {
    await f.admit('first', 'source');
    const before = await f.store.getSession('s');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    physical.run(
      "CREATE TRIGGER fail_title_intent BEFORE INSERT ON extension_record WHEN NEW.key='automatic-title-attempt' BEGIN SELECT RAISE(ABORT,'rollback title intent'); END",
    );
    const refused = await f.store
      .claimAutomaticSessionTitle({ ...f.base, sourceCommandId: 'first' })
      .catch((error) => error);
    expect(refused.code).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(await f.store.getSession('s')).toEqual(before);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const id = automaticTitleIdentity(f.base.expectedStoreId, 's', 'first').fallbackCommandId;
    expect(await f.store.getCommand(id)).toBeNull();
    expect(
      await f.store.getExtensionRecord({ ...automaticTitleRecord, sessionId: 's' }),
    ).toBeNull();
    physical.run('DROP TRIGGER fail_title_intent');
    expect(
      await f.store.claimAutomaticSessionTitle({ ...f.base, sourceCommandId: 'first' }),
    ).not.toBeNull();
  } finally {
    physical.close();
    await f.close();
  }
});

test('unknown private attempt shapes and mismatched fallback digests never authorize metadata adoption', async () => {
  const f = await fixture();
  const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  try {
    await f.admit('first', 'source');
    const input = { ...f.base, sourceCommandId: 'first' };
    const claim = await f.store.claimAutomaticSessionTitle(input);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    for (const json of [
      JSON.stringify({ ...(claim!.record.value as object), future: true }),
      JSON.stringify({ ...(claim!.record.value as object), fallbackDigest: '0'.repeat(64) }),
    ]) {
      physical.run(
        "UPDATE extension_record SET json=? WHERE extension_id=? AND scope_id='s' AND key=?",
        [json, automaticTitleRecord.extensionId, automaticTitleRecord.key],
      );
      const refused = await f.store.claimAutomaticSessionTitle(input).catch((error) => error);
      expect(refused.code).toBe('session_title_attempt_invalid');
      expect((await f.store.getSession('s'))?.title).toBe(claim!.session.title);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    }
  } finally {
    physical.close();
    await f.close();
  }
});
