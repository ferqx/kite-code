import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';

test('precise cancellation while the real scoped Artifact reader is awaited prevents file publication', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-body-cancel-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const files = createWorkspaceFiles({ root: workspace });
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: `file://${workspace}`,
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 's',
    subjectId: 'owner',
  });
  const ref = await artifacts.publish({
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: { kind: 'session', id: 's' },
    refId: 'input',
    content: Buffer.from('complete content'),
    mediaType: 'text/plain',
  });
  let entered = false,
    writes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'call',
        name: 'files.write',
        arguments: JSON.stringify({
          path: 'never',
          base: null,
          contentArtifact: {
            id: ref.id,
            mediaType: ref.mediaType,
            size: ref.size,
            scope: ref.scope,
          },
        }),
      },
      { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
    ],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'p1' };
      },
    },
    artifacts: {
      ...artifacts,
      async read(input) {
        const bytes = await artifacts.read(input);
        entered = true;
        await gate;
        return bytes;
      },
    },
    extensions: [
      {
        id: 'files',
        version: '2',
        apiMajor: 1,
        tools: createFileTools({
          ...files,
          async write(input) {
            writes++;
            return files.write(input);
          },
        }),
      },
    ],
  });
  try {
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'write exact Artifact' },
    });
    const deadline = Date.now() + 3000;
    while (!entered && Date.now() < deadline) await Bun.sleep(10);
    expect(entered).toBe(true);
    await runtime.cancelCommand({
      expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      subjectId: 'owner',
      targetCommandId: 'work',
    });
    release();
    await runtime.waitForCommand('work');
    expect(writes).toBe(0);
    expect(existsSync(join(workspace, 'never'))).toBe(false);
    expect(
      (await store.listExecutions('s')).find((value) => value.definitionId === 'files.write')
        ?.status,
    ).toBe('cancelled');
  } finally {
    release();
    await runtime.close();
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});
