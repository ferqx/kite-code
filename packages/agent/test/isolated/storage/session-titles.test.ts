import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture(title = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-title-')));
  const profile = { dataRoot: root, profile: 'test' };
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
