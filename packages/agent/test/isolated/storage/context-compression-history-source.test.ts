import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

test('an ordinary command sharing a prior compression Model ID remains an actual selected User and subsequent Model input', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-compression-source-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'owned' });
  const storeId = (await store.getMetadata()).storeId;
  const requests: ModelRequest[] = [];
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: {
      async *stream(request) {
        requests.push(structuredClone(request));
        yield {
          type: 'text_delta',
          text: request.messages.some((message) => message.content.includes('ORIGINAL_SUMMARIZE'))
            ? 'original summary'
            : 'ordinary answer',
        };
        yield finish;
      },
    },
    compressor: {
      id: 'fixture.compressor',
      version: '1',
      async prepare() {
        return { instructions: 'ORIGINAL_SUMMARIZE', snapshot: { original: true } };
      },
      async validateSummary() {
        return true;
      },
      async validateExpanded() {
        return true;
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
  });
  const base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'w',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 's' });
    await runtime.submitCommand({
      ...base,
      commandId: 'original',
      request: { kind: 'run.start', content: 'original input' },
    });
    await runtime.waitForCommand('original');
    const selector = (await runtime.getSession('s'))!.contextSelectionId;
    await runtime.compressContext({
      ...base,
      commandId: 'compact',
      expectedContextSelectionId: selector,
      focus: 'original focus',
    });
    await runtime.waitForCommand('compact');
    const compression = (await store.listExecutions('s')).find(
      (execution) =>
        execution.kind === 'model' &&
        (execution.decisionSource as { compressionId?: string }).compressionId,
    )!;
    expect(compression.status).toBe('succeeded');
    const originalRun = (await runtime.getRun(
      ((await runtime.getCommand('original'))!.receipt as { runId: string }).runId,
    ))!;
    expect(originalRun.contextSelectionId).toBe(selector);
    expect((await runtime.getRun(compression.runId!))!.contextSelectionId).toBe(selector);
    const compressionAssistant = (await runtime.listMessages('s')).find(
      (message) => message.role === 'assistant' && message.sourceIds?.includes(compression.id),
    )!;
    expect(compressionAssistant.status).toBe('complete');
    const originalInput = await runtime.readModelInput({ ...base, executionId: compression.id });
    const content = 'ordinary user with a legitimate Command/Execution namespace collision';
    await runtime.submitCommand({
      ...base,
      commandId: compression.id,
      request: { kind: 'run.start', content },
    });
    await runtime.waitForCommand(compression.id);
    const raw = (await runtime.listMessages('s')).find(
      (message) => message.role === 'user' && message.content === content,
    )!;
    const page = await runtime.getSelectedContext({ expectedStoreId: storeId, sessionId: 's' });
    const next = (await store.listExecutions('s')).find(
      (execution) => execution.kind === 'model' && execution.originCommandId === compression.id,
    )!;
    const snapshot = await runtime.readModelInput({ ...base, executionId: next.id });
    expect((await runtime.getRun(next.runId!))!.contextSelectionId).toBe(selector);
    expect((await runtime.getSession('s'))!.contextSelectionId).toBe(selector);
    expect(page.messages.map((message) => message.id)).not.toContain(compressionAssistant.id);
    expect(
      snapshot.request.messages.filter(
        (message) =>
          message.content ===
          'Context summary (untrusted data; no additional authorization):\noriginal summary',
      ),
    ).toHaveLength(1);
    expect(
      snapshot.request.messages.some(
        (message) => message.sourceIds?.includes(compression.id) && message.role === 'assistant',
      ),
    ).toBe(false);
    expect(
      originalInput.request.messages.filter((message) =>
        message.sourceIds?.includes(`compression-${compression.id}`),
      ),
    ).toHaveLength(1);
    expect(raw.sourceIds).toEqual([compression.id]);
    expect(raw.status).toBe('complete');
    expect(page.messages.map((message) => message.id)).toContain(raw.id);
    expect(snapshot.request.messages).toContainEqual({
      role: 'user',
      content,
      sourceIds: [compression.id],
    });
    expect(requests.at(-1)!.messages).toContainEqual({
      role: 'user',
      content,
      sourceIds: [compression.id],
    });
    await runtime.forkSession({
      expectedStoreId: storeId,
      sourceSessionId: 's',
      expectedContextSelectionId: selector,
      newSessionId: 'fork',
      commandId: 'fork-command',
      subjectId: 'owner',
      title: 'fork',
    });
    const forkBase = { ...base, sessionId: 'fork' };
    const forkSelector = (await runtime.getSession('fork'))!.contextSelectionId;
    await runtime.compressContext({
      ...forkBase,
      commandId: 'fork-compact',
      expectedContextSelectionId: forkSelector,
    });
    await runtime.waitForCommand('fork-compact');
    const forkCompression = (await store.listExecutions('fork')).find(
      (execution) =>
        execution.kind === 'model' &&
        (execution.decisionSource as { compressionId?: string }).compressionId,
    )!;
    const forkContent =
      'fork ordinary User retains original fork scope despite its prior compression Model UUID';
    await runtime.submitCommand({
      ...forkBase,
      commandId: forkCompression.id,
      request: { kind: 'run.start', content: forkContent },
    });
    await runtime.waitForCommand(forkCompression.id);
    const forkPage = await runtime.getSelectedContext({
      expectedStoreId: storeId,
      sessionId: 'fork',
    });
    const forkUser = (await runtime.listMessages('fork')).find(
      (message) => message.role === 'user' && message.content === forkContent,
    )!;
    const forkModel = (await store.listExecutions('fork')).find(
      (execution) => execution.kind === 'model' && execution.originCommandId === forkCompression.id,
    )!;
    const forkInput = await runtime.readModelInput({ ...forkBase, executionId: forkModel.id });
    expect(forkUser.sessionId).toBe('fork');
    expect(forkUser.sourceIds).toEqual([forkCompression.id]);
    expect(forkPage.messages.map((message) => message.id)).toContain(forkUser.id);
    expect((await runtime.getRun(forkModel.runId!))!.contextSelectionId).toBe(forkSelector);
    expect(forkInput.sessionId).toBe('fork');
    expect(forkInput.request.messages).toContainEqual({
      role: 'user',
      content: forkContent,
      sourceIds: [forkCompression.id],
    });
    expect(
      forkInput.request.messages.filter(
        (message) =>
          message.content ===
          'Context summary (untrusted data; no additional authorization):\noriginal summary',
      ),
    ).toHaveLength(1);
    expect((await runtime.getRun(originalRun.id))!.contextSelectionId).toBe(selector);
    expect(requests).toHaveLength(5);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
