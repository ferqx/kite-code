import { expect, test } from 'bun:test';
import {
  createReadStream,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const permissions = {
  async authorize() {
    return { allowed: true, revision: '1' };
  },
};
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-input-files-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'fixture' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const model = createFixedModel([[finish], [finish]]);
  const runtime = createRuntime({ permissions, store, model, modelId: 'fixed', artifacts });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'fixture',
    rootUri: 'file:///fixture',
  });
  for (const sessionId of ['s', 'other'])
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      workspaceId: 'w',
      commandId: `create-${sessionId}`,
      subjectId: 'owner',
      title: sessionId,
    });
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  return { root, profile, store, artifacts, model, runtime, scope };
}
async function rejects(work: Promise<unknown>, code: string) {
  let actual: unknown;
  try {
    await work;
  } catch (error) {
    actual = error;
  }
  expect(actual).toMatchObject({ code });
}

test('streamed import survives source deletion, binds atomically and remains readable after backup restore', async () => {
  const f = await fixture();
  let runtime = f.runtime;
  try {
    const source = join(f.root, '原文.txt');
    const text = '第一行\n完整附件：源文件删除后仍然可读\n';
    writeFileSync(source, text);
    const file = await runtime.uploadInputFile({
      ...f.scope,
      id: 'source',
      name: '原文.txt',
      mediaType: 'text/plain',
      content: createReadStream(source, { highWaterMark: 7 }),
    });
    unlinkSync(source);
    expect((await runtime.getInputFileImport({ ...f.scope, id: 'source' }))?.state).toBe(
      'prepared',
    );
    // A supplied URI cannot change the actual bytes or the path presented to the model.
    const input = {
      ...f.scope,
      commandId: 'first',
      request: {
        kind: 'run.start' as const,
        content: 'read',
        files: [{ ...file, uri: 'file:///forged-location' }],
      },
    };
    await runtime.submitCommand(input);
    await runtime.waitForCommand('first', { timeoutMs: 5000 });
    await runtime.submitCommand(input);
    expect((await runtime.getInputFileImport({ ...f.scope, id: 'source' }))?.boundCommandId).toBe(
      'first',
    );
    expect((await runtime.resolveInputFile({ ...f.scope, uri: file.uri }))?.id).toBe('source');
    expect(
      await runtime.resolveInputFile({ ...f.scope, sessionId: 'other', uri: file.uri }),
    ).toBeNull();
    await rejects(
      runtime.releaseInputFileImport({ ...f.scope, id: 'source' }),
      'input_file_already_bound',
    );
    expect(f.model.requests[0]?.messages.find((m) => m.role === 'user')?.content).toContain(
      file.uri,
    );
    expect(f.model.requests[0]?.messages.find((m) => m.role === 'user')?.content).not.toContain(
      'forged-location',
    );
    expect(
      new TextDecoder().decode(
        await f.artifacts.readReference({
          expectedStoreId: f.scope.expectedStoreId,
          reference: file.reference!,
        }),
      ),
    ).toBe(text);
    await runtime.close();
    const backup = await createProfileBackup({
      profile: f.profile,
      destinationRoot: join(f.root, 'backups'),
    });
    await inspectProfileBackup({ directory: backup.directory });
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: f.scope.expectedStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    const store = await openSqliteStore(f.profile);
    const artifacts = createArtifactStore({ profile: f.profile, store });
    const model = createFixedModel([[finish]]);
    runtime = createRuntime({ permissions, store, artifacts, model, modelId: 'fixed' });
    expect(restored.storeId).not.toBe(f.scope.expectedStoreId);
    const record = await runtime.getInputFileImport({
      ...f.scope,
      expectedStoreId: restored.storeId,
      id: 'source',
    });
    expect(record?.originStoreId).toBe(f.scope.expectedStoreId);
    expect(record?.reference).toEqual(file.reference);
    expect(
      new TextDecoder().decode(
        await artifacts.readReference({
          expectedStoreId: restored.storeId,
          reference: file.reference!,
        }),
      ),
    ).toBe(text);
    await rejects(
      runtime.releaseInputFileImport({
        ...f.scope,
        expectedStoreId: restored.storeId,
        id: 'source',
      }),
      'input_file_scope_denied',
    );
    await runtime.submitCommand({
      ...f.scope,
      expectedStoreId: restored.storeId,
      commandId: 'after-restore',
      request: { kind: 'run.start', content: 'continue reading' },
    });
    await runtime.waitForCommand('after-restore', { timeoutMs: 5000 });
    expect(model.requests[0]?.messages.some((m) => m.content.includes(file.reference!.hash))).toBe(
      true,
    );
  } finally {
    await runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 60000);

test('release and command admission serialize; foreign, changed and released imports cannot bind', async () => {
  const f = await fixture();
  try {
    const upload = (id: string) =>
      f.runtime.uploadInputFile({
        ...f.scope,
        id,
        name: 'a.txt',
        mediaType: 'text/plain',
        content: [Buffer.from('complete')],
      });
    const file = await upload('a');
    expect(await upload('a')).toEqual(file);
    await rejects(
      f.runtime.uploadInputFile({
        ...f.scope,
        id: 'a',
        name: 'changed.txt',
        mediaType: 'text/plain',
        content: [Buffer.from('complete')],
      }),
      'input_file_import_conflict',
    );
    await rejects(
      f.runtime.submitCommand({
        ...f.scope,
        sessionId: 'other',
        commandId: 'foreign',
        request: { kind: 'run.start', content: 'x', files: [file] },
      }),
      'input_file_scope_denied',
    );
    await rejects(
      f.runtime.getInputFileImport({ ...f.scope, subjectId: 'intruder', id: 'a' }),
      'input_file_scope_denied',
    );
    await rejects(
      f.runtime.submitCommand({
        ...f.scope,
        commandId: 'forged',
        request: {
          kind: 'run.start',
          content: 'x',
          files: [{ ...file, reference: { ...file.reference!, hash: 'f'.repeat(64) } }],
        },
      }),
      'input_file_scope_denied',
    );
    expect(await f.store.getCommand('forged')).toBeNull();
    await f.runtime.releaseInputFileImport({ ...f.scope, id: 'a' });
    expect((await f.runtime.releaseInputFileImport({ ...f.scope, id: 'a' })).state).toBe(
      'released',
    );
    await rejects(
      f.runtime.submitCommand({
        ...f.scope,
        commandId: 'released',
        request: { kind: 'run.start', content: 'x', files: [file] },
      }),
      'input_file_scope_denied',
    );
    await rejects(upload('a'), 'input_file_released');
    const raced = await upload('race');
    const results = await Promise.allSettled([
      f.store.acceptCommand({
        ...f.scope,
        commandId: 'race',
        request: { kind: 'run.start', content: 'x', files: [raced] },
      }),
      f.runtime.releaseInputFileImport({ ...f.scope, id: 'race' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const record = await f.runtime.getInputFileImport({ ...f.scope, id: 'race' });
    const command = await f.store.getCommand('race');
    expect(record?.state === 'bound').toBe(command !== null);
    const controller = new AbortController();
    async function* cancelled() {
      yield Buffer.from('prefix');
      controller.abort();
      yield Buffer.from('tail');
    }
    let cancelledError: unknown;
    try {
      await f.runtime.uploadInputFile({
        ...f.scope,
        id: 'cancelled',
        name: 'a',
        mediaType: 'text/plain',
        content: cancelled(),
        signal: controller.signal,
      });
    } catch (error) {
      cancelledError = error;
    }
    expect(cancelledError).toBeDefined();
    expect(await f.runtime.getInputFileImport({ ...f.scope, id: 'cancelled' })).toBeNull();
  } finally {
    await f.runtime.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 60000);
