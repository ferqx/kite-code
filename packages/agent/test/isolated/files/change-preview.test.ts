import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createFileTools, createWorkspaceFiles, type FileChangePreview } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-preview-')));
  const files = createWorkspaceFiles({ root });
  return {
    root,
    files,
    async close() {
      await files.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('saved file preview uses the verified complete preimage and confirmed postimage, preserving each operation', async () => {
  const f = fixture();
  try {
    const original = '\uFEFFfirst\r\nold 雪🙂\r\nlast\n';
    writeFileSync(join(f.root, 'text'), original);
    const base = (await f.files.read('text', { limit: 1 })).baseline;
    const edited = await f.files.edit({
      path: 'text',
      base,
      find: 'old 雪🙂',
      replace: 'new α🙂',
      occurrences: 1,
    });
    expect(edited.change).toMatchObject({
      version: 1,
      format: 'line_diff',
      path: 'text',
      before: base,
      after: edited.baseline,
      truncated: false,
    });
    expect(edited.change!.text).toContain('2 -old 雪🙂\r');
    expect(edited.change!.text).toContain('2 +new α🙂\r');
    expect(edited.content).toBe(original.replace('old 雪🙂', 'new α🙂'));
    const created = await f.files.write({ path: 'new', base: null, content: 'written 雪🙂\r\n' });
    expect(created.change).toMatchObject({
      before: null,
      format: 'file_content',
      truncated: false,
    });
    expect(created.change!.text).toContain('written 雪🙂\r');
    const same = await f.files.write({
      path: 'new',
      base: created.baseline,
      content: created.content,
    });
    expect(same.change!.text).toContain('content unchanged');
    writeFileSync(join(f.root, 'text'), 'external later content');
    expect(edited.change!.text).not.toContain('external later content');
  } finally {
    await f.close();
  }
});

test('presentation is explicitly bounded on UTF-8 boundaries while complete write bytes and Model result stay unchanged', async () => {
  const f = fixture();
  try {
    const content = '雪🙂'.repeat(400000);
    const tool = createFileTools(f.files).find((tool) => tool.id === 'files.write')!;
    const result = await tool.execute({ path: 'large', base: null, content }, {
      signal: new AbortController().signal,
    } as Parameters<typeof tool.execute>[1]);
    expect(result.outcome).toBe('succeeded');
    const modelResult = JSON.parse(result.content);
    expect(Object.keys(modelResult).sort()).toEqual(['baseline', 'path']);
    expect(modelResult.baseline.size).toBe(Buffer.byteLength(content));
    expect(modelResult.baseline.hash).toBe(hash(content));
    expect(readFileSync(join(f.root, 'large'), 'utf8')).toBe(content);
    const preview = (result.details as unknown as { fileChange: FileChangePreview }).fileChange;
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(65536);
    expect(preview.text).not.toContain('\ufffd');
    expect(Buffer.from(preview.text).toString('utf8')).toBe(preview.text);
    expect(preview.after).toEqual(modelResult.baseline);
  } finally {
    await f.close();
  }
});

test('failed baselines and uncertain post-publication capture never save a successful file preview', async () => {
  const f = fixture();
  try {
    const tool = createFileTools(f.files, {
      capture: {
        async before() {
          return {};
        },
        async after() {
          throw Error('capture unavailable');
        },
        async failed() {},
      },
    }).find((tool) => tool.id === 'files.write')!;
    const context = { signal: new AbortController().signal } as Parameters<typeof tool.execute>[1];
    const unknown = await tool.execute(
      { path: 'published', base: null, content: 'actual published' },
      context,
    );
    expect(unknown.outcome).toBe('outcome_unknown');
    expect(unknown.details).toEqual({ code: 'file_publish_outcome_unknown' });
    expect(readFileSync(join(f.root, 'published'), 'utf8')).toBe('actual published');
    const failed = await tool.execute(
      { path: 'published', base: null, content: 'must not replace' },
      context,
    );
    expect(failed.outcome).toBe('failed');
    expect(failed.details).toEqual({ code: 'file_baseline_conflict' });
    expect(readFileSync(join(f.root, 'published'), 'utf8')).toBe('actual published');
  } finally {
    await f.close();
  }
});

test('real Core saves the preview in original Execution receipts; repeated call IDs across Runs have distinct exact message sources', async () => {
  const f = fixture();
  const store = await openSqliteStore({ dataRoot: join(f.root, 'data'), profile: 'owned' });
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const calls = ['first', 'second'].flatMap((path) => [
    [
      {
        type: 'tool_call',
        id: 'repeated-call',
        name: 'files.write',
        arguments: JSON.stringify({ path, base: null, content: `actual ${path} bytes` }),
      } as ModelEvent,
      { ...finish, reason: 'tool_calls' } as ModelEvent,
    ],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model: createFixedModel(calls),
    extensions: [{ id: 'files', version: '1', apiMajor: 1, tools: createFileTools(f.files) }],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const storeId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${f.root}`,
      name: 'owned',
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      subjectId: 'owner',
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'files',
    });
    for (const commandId of ['first', 'second']) {
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId,
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: commandId },
      });
      await runtime.waitForCommand(commandId);
    }
    const messages = (await store.listMessages('s')).filter((message) => message.role === 'tool');
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.toolCallId)).toEqual([
      'repeated-call',
      'repeated-call',
    ]);
    expect(messages[0]!.sourceIds).not.toEqual(messages[1]!.sourceIds);
    expect(messages[0]!.runId).not.toBe(messages[1]!.runId);
    for (const message of messages) {
      expect(message.sourceIds).toHaveLength(1);
      const execution = (await store.getExecution(message.sourceIds![0]!))!;
      expect(execution).toMatchObject({
        sessionId: message.sessionId,
        runId: message.runId,
        kind: 'tool',
        definitionId: 'files.write',
        definitionVersion: '2',
        status: 'succeeded',
      });
      const result = execution.result as unknown as {
        content: string;
        details: { fileChange: FileChangePreview };
      };
      expect(result.content).toBe(message.content);
      const facts = JSON.parse(message.content);
      expect(result.details.fileChange.after).toEqual(facts.baseline);
      expect(result.details.fileChange.text).toContain(`actual ${facts.path} bytes`);
    }
  } finally {
    await runtime.close();
    await f.close();
  }
});
