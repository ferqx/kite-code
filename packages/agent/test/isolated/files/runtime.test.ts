import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: unknown): ModelEvent[] {
  return [
    { type: 'tool_call', id: 'call', name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
test('fixed model uses ordinary UnifiedExecution file tools; read returns the exact persisted baseline, unknown/denied tools have no file I/O', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-runtime-')));
  const files = createWorkspaceFiles({ root });
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const model = createFixedModel([
    call('files.write', { path: 'actual', content: 'hello', base: null }),
    [finish],
    call('files.read', { path: 'actual' }),
    [finish],
    call('files.unknown', { path: 'unknown', content: 'bad', base: null }),
    [finish],
    call('files.write', { path: 'denied', content: 'bad', base: null }),
    [finish],
  ]);
  let deny = false;
  let fileAuthorization = 0;
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize(request) {
        if (request.definitionId.startsWith('files.')) {
          fileAuthorization++;
          return { allowed: !deny, revision: '1' };
        }
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [{ id: 'files', version: '1', apiMajor: 1, tools: createFileTools(files) }],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'temp',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'files',
    });
    const submit = async (commandId: string) => {
      await runtime.submitCommand({
        expectedStoreId,
        commandId,
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: commandId },
      });
      await runtime.waitForCommand(commandId);
    };
    await submit('write');
    expect(readFileSync(join(root, 'actual'), 'utf8')).toBe('hello');
    const written = (await store.listExecutions('s')).find((e) => e.definitionId === 'files.write');
    expect(written?.status).toBe('succeeded');
    await submit('read');
    const read = (await store.listExecutions('s')).find((e) => e.definitionId === 'files.read');
    expect(read?.status).toBe('succeeded');
    const result = read?.result as { content: string };
    const observed = JSON.parse(result.content) as { baseline: unknown; content: string };
    expect(observed.content).toBe('hello');
    expect(observed.baseline).toEqual((await files.read('actual')).baseline);
    await submit('unknown');
    expect(existsSync(join(root, 'unknown'))).toBe(false);
    deny = true;
    await submit('deny');
    expect(existsSync(join(root, 'denied'))).toBe(false);
    expect(fileAuthorization).toBe(5);
    expect(
      (await store.listExecutions('s')).find(
        (e) => e.definitionId === 'files.write' && e.status === 'failed',
      )?.status,
    ).toBe('failed');
  } finally {
    await runtime.close();
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});
