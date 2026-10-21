import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { AgentError, createRuntime } from '../../../src';
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
    expect(Object.keys(modelResult).sort()).toEqual(['baseline', 'fileChange', 'path', 'summary']);
    expect(modelResult.baseline.size).toBe(Buffer.byteLength(content));
    expect(modelResult.baseline.hash).toBe(hash(content));
    expect(readFileSync(join(f.root, 'large'), 'utf8')).toBe(content);
    const preview = (result.details as unknown as { fileChange: FileChangePreview }).fileChange;
    expect(modelResult.fileChange).toEqual(preview);
    expect(modelResult.path).toBe('large');
    expect(modelResult.summary).toBe('Wrote 1 lines to large');
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
    expect(failed.content).toContain('This invocation did not publish');
    expect(failed.content).toContain('does not report the current file content');
    expect(failed.content).toContain('Other successful operations are not rolled back');
    expect(failed.content).not.toContain('actual published');
    expect(readFileSync(join(f.root, 'published'), 'utf8')).toBe('actual published');
  } finally {
    await f.close();
  }
});

test('a stale edit reports its own rejected effect without claiming the historical read is current', async () => {
  const f = fixture();
  try {
    const initial = 'A=0\r\nB=0\r\n';
    writeFileSync(join(f.root, 'shared'), initial);
    const old = await f.files.read('shared');
    const current = await f.files.edit({
      path: 'shared',
      base: old.baseline,
      find: 'B=0',
      replace: 'B=1',
      occurrences: 1,
    });
    const tool = createFileTools(f.files).find((item) => item.id === 'files.edit')!;
    const result = await tool.execute(
      { path: 'shared', base: { ...old.baseline }, find: 'A=0', replace: 'A=1', occurrences: 1 },
      { signal: new AbortController().signal } as Parameters<typeof tool.execute>[1],
    );
    expect(result.outcome).toBe('failed');
    expect(result.details).toEqual({ code: 'file_baseline_conflict' });
    expect(result.content).toContain('Earlier read content is historical');
    expect(result.content).toContain('baseline describes the complete file identity and version');
    expect(result.content).toContain('does not prove that another edit targeted the same text');
    expect(result.content).toContain('does not report the current file content');
    expect(result.content).not.toContain('B=0');
    expect(result.content).not.toContain('B=1');
    expect(await f.files.read('shared')).toMatchObject({
      content: 'A=0\r\nB=1\r\n',
      baseline: current.baseline,
    });

    const captured = createFileTools(f.files, {
      capture: {
        async before() {
          return {};
        },
        async after() {
          throw new AgentError('file_baseline_conflict');
        },
        async failed() {},
      },
    }).find((item) => item.id === 'files.edit')!;
    const unknown = await captured.execute(
      {
        path: 'shared',
        base: { ...current.baseline },
        find: 'A=0',
        replace: 'A=1',
        occurrences: 1,
      },
      { signal: new AbortController().signal } as Parameters<typeof captured.execute>[1],
    );
    expect(unknown.outcome).toBe('outcome_unknown');
    expect(unknown.details).toEqual({ code: 'file_publish_outcome_unknown' });
    expect(unknown.content).not.toContain('did not publish');
    expect(readFileSync(join(f.root, 'shared'), 'utf8')).toBe('A=1\r\nB=1\r\n');
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
        name: 'write_file',
        arguments: JSON.stringify({ path, base: null, content: `actual ${path} bytes` }),
      } as ModelEvent,
      { ...finish, reason: 'tool_calls' } as ModelEvent,
    ],
    [finish],
  ]);
  const model = createFixedModel(calls);
  const runtime = createRuntime({
    store,
    model,
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
      rootUri: pathToFileURL(f.root).href,
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
        request: { kind: 'run.start', content: `New task: ${commandId}` },
      });
      const command = await runtime.waitForCommand(commandId);
      expect(command.status).toBe('applied');
      const receipt = command.receipt as { runId: string; businessCommandId?: string };
      const businessId = receipt.businessCommandId ?? command.id;
      const business = await store.getCommand(businessId);
      expect(business).toMatchObject({
        status: 'applied',
        sessionId: 's',
        rootWorkCommandId: commandId,
      });
      expect((business!.request as { content: string }).content).toBe(`New task: ${commandId}`);
      const actualRun = await store.getRun(receipt.runId);
      expect(actualRun).toMatchObject({
        status: 'completed',
        originCommandId: businessId,
        rootWorkCommandId: commandId,
      });
      const executions = (await store.listExecutions('s')).filter(
        (execution) => execution.runId === actualRun!.id,
      );
      const models = executions.filter((execution) => execution.kind === 'model');
      expect(models).toHaveLength(2);
      for (const execution of models) {
        expect(execution).toMatchObject({
          status: 'succeeded',
          originCommandId: businessId,
          rootWorkCommandId: commandId,
        });
        expect(
          model.requests
            .find((request) => request.requestId === execution.id)
            ?.messages.find((message) => message.sourceIds?.includes(businessId)),
        ).toMatchObject({ content: `New task: ${commandId}`, sourceIds: [businessId] });
      }
      for (const tool of executions.filter((execution) => execution.kind === 'tool'))
        expect(tool).toMatchObject({ originCommandId: businessId, rootWorkCommandId: commandId });
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
