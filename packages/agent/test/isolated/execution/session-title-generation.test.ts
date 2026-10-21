import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ModelAdapter,
  ModelAttemptError,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createSessionTitleExtension } from '../../../src/business/session-title';
import { sessionTitleInstructions } from '../../../src/business/session-title/title';
import { type AgentRuntime, createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const usage = { inputTokens: 1, outputTokens: 1 };
const finish = { type: 'finish', reason: 'stop', usage } as const;
const generated = '修复自动命名流程';
const original = `🪁{"task":"请保留第一条原文"}\n${'完整用户正文 🪁 '.repeat(25)}`;
const truncatedOriginal = Array.from(original).slice(0, 10).join('');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  titleStream: (signal: AbortSignal) => AsyncIterable<ModelEvent>,
  title = '',
  completionGate?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> },
  mainMode: 'success' | 'failure' | 'unavailable' | 'retrying' = 'success',
  explainWork = false,
  interpretationReply?: (
    request: ModelRequest,
    identity: Record<string, unknown>,
  ) => Record<string, unknown>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-title-generation-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const requests: ModelRequest[] = [];
  const titleStarted = deferred();
  const model: ModelAdapter = {
    async *stream(request, { signal }) {
      requests.push(structuredClone(request));
      const interpretation = request.messages.find(
        (message) =>
          message.role === 'system' && message.content.includes('Original input identity: '),
      );
      if ((explainWork || interpretationReply) && interpretation) {
        expect(request.tools).toEqual([]);
        const identity = JSON.parse(
          interpretation.content
            .split('\n')
            .find((line) => line.startsWith('Original input identity: '))!
            .slice('Original input identity: '.length),
        );
        yield {
          type: 'text_delta',
          text: JSON.stringify(
            interpretationReply?.(request, identity) ?? {
              ...identity,
              relation: 'independent_work',
              purpose: 'work',
              target_root_work_command_id: null,
              selection_effect: 'select_work',
              answer: null,
              clarification: null,
            },
          ),
        };
        yield finish;
        return;
      }
      if (
        request.messages.some(
          (message) => message.role === 'system' && message.content === sessionTitleInstructions,
        )
      ) {
        expect(request.tools).toEqual([]);
        titleStarted.resolve();
        yield* titleStream(signal);
      } else {
        if (mainMode === 'failure') throw new Error('fixture main model failed');
        if (mainMode === 'retrying') throw new ModelAttemptError('provider_unavailable');
        yield { type: 'text_delta', text: '已完成主要任务' };
        yield finish;
      }
    },
  };
  let pausedCompletion = false;
  const runtimeStore = new Proxy(store, {
    get(target, key) {
      if (key === 'finishRun')
        return async (input: Parameters<Store['finishRun']>[0]) => {
          if (
            completionGate &&
            !pausedCompletion &&
            input.status === 'completed' &&
            (await target.getRun(input.runId))?.sessionId === 'session'
          ) {
            pausedCompletion = true;
            completionGate.entered.resolve();
            await completionGate.release.promise;
          }
          return target.finishRun(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let runtime!: AgentRuntime;
  const titles = createSessionTitleExtension({
    runtime: () => runtime,
    resolveModel: async () => ({ model, modelId: 'fixture', toolIds: [], snapshot: null }),
  });
  runtime = createRuntime({
    store: runtimeStore,
    ...(mainMode === 'unavailable' ? {} : { model }),
    modelId: 'fixture',
    extensions: [titles.extension],
    childConfigurations: [titles.childConfiguration],
    resolveChildRunConfiguration: titles.resolveChild,
    sessionInputMetadata: { preserve: (command) => titles.preserveInputFallback(command) },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    name: 'Fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'workspace', title });
  return {
    root,
    profile,
    store,
    runtime,
    base,
    requests,
    titleStarted,
    preserveInputFallback: titles.preserveInputFallback,
    async submitPublic(commandId = 'work', content = original) {
      return runtime.submitCommand({ ...base, commandId, request: { kind: 'run.start', content } });
    },
    async submit(commandId = 'work', content = original) {
      const input = { ...base, commandId, request: { kind: 'run.start' as const, content } };
      // These module cases start an already admitted business command. Preserve the exact
      // quoted/whitespace input; public input interpretation is a separate admission boundary.
      await store.acceptCommand(input);
      await runtime.submitCommand(input);
    },
    titleRequests() {
      return requests.filter((request) =>
        request.messages.some((message) => message.content === sessionTitleInstructions),
      );
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('AI title is durable metadata, excluded from complete history and later model input', async () => {
  const f = await fixture(async function* () {
    yield { type: 'text_delta', text: `标题：“${generated}”` };
    yield finish;
  });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    const view = await f.runtime.getView('session');
    expect(view.runs[0]?.status).toBe('completed');
    expect((await f.store.getSession('session'))?.title).toBe(generated);
    const titleExecution = view.executions.find(
      (execution) => execution.definitionId === 'agent/session-title',
    );
    expect(titleExecution?.status).toBe('succeeded');
    expect(view.messages).toHaveLength(2);
    expect(JSON.stringify(view.messages)).not.toContain(generated);
    expect(f.titleRequests()).toHaveLength(1);
    expect(f.titleRequests()[0]?.messages.at(-1)?.content).toBe(
      original.replace(/\s+/gu, ' ').trim(),
    );
    await f.submit('later', '继续完善名称展示');
    await f.runtime.waitForCommand('later');
    expect(f.titleRequests()).toHaveLength(1);
    const ordinary = f.requests.filter(
      (request) =>
        !request.messages.some((message) => message.content === sessionTitleInstructions),
    );
    expect(ordinary).toHaveLength(2);
    expect(JSON.stringify(ordinary[1]?.messages)).not.toContain(generated);
    expect((await f.runtime.getView('session')).messages).toHaveLength(4);
    await f.runtime.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await cold.getSession('session'))?.title).toBe(generated);
      expect((await cold.getView('session')).messages).toHaveLength(4);
      expect((await cold.getExecution(titleExecution!.id))?.status).toBe('succeeded');
      expect(f.requests).toHaveLength(3);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test.each([
  'success',
  'failure',
  'unavailable',
] as const)('title whitespace is normalized without altering the original input: %s', async (mode) => {
  const input = `${' \r\n\t'.repeat(3000)}修复   会话\n\n命名，保持原文`;
  const normalized = '修复 会话 命名，保持原文';
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: ' \r\n\t' };
      yield finish;
    },
    '',
    undefined,
    mode,
  );
  try {
    await f.submit('work', input);
    await f.runtime.waitForCommand('work');
    const view = await f.runtime.getView('session');
    expect(view.session.title).toBe('修复 会话 命名，保');
    expect((await f.runtime.getCommand('work'))?.request).toMatchObject({ content: input });
    if (mode === 'unavailable') {
      expect(f.requests).toHaveLength(0);
      expect(view.runs).toHaveLength(0);
    } else {
      expect(view.messages[0]?.content).toBe(input);
      expect(f.requests[0]?.messages.some((message) => message.content === input)).toBe(true);
      expect(view.runs[0]?.status).toBe(mode === 'success' ? 'completed' : 'failed');
    }
    expect(f.titleRequests()).toHaveLength(mode === 'success' ? 1 : 0);
    if (mode === 'success') expect(f.titleRequests()[0]?.messages.at(-1)?.content).toBe(normalized);
  } finally {
    await f.close();
  }
});

test('whitespace-only input retains a visible fallback without a title Model request', async () => {
  const input = ' \t\r\n\u3000\u00a0'.repeat(2000);
  const f = await fixture(async function* () {
    yield { type: 'text_delta', text: generated };
    yield finish;
  });
  try {
    await f.submit('work', input);
    await f.runtime.waitForCommand('work');
    const view = await f.runtime.getView('session');
    expect(view.session.title).toBe('新会话');
    expect(view.runs[0]?.status).toBe('completed');
    expect(view.messages[0]?.content).toBe(input);
    expect(f.titleRequests()).toHaveLength(0);
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('an unnamed Session with existing history is not named by a later Run', async () => {
  const f = await fixture(async function* () {
    yield { type: 'text_delta', text: generated };
    yield finish;
  });
  try {
    const owner = (await f.store.acquireSessionOwner('session', 'history-host'))!;
    try {
      await f.store.acceptCommand({
        ...f.base,
        commandId: 'history',
        request: { kind: 'run.start', content: '已有的第一条消息' },
      });
      const run = await f.store.startRun({
        expectedStoreId: f.base.expectedStoreId,
        owner,
        commandId: 'history',
        configuration: { modelId: 'fixture' },
      });
      await f.store.finishRun({
        expectedStoreId: f.base.expectedStoreId,
        owner,
        runId: run.id,
        status: 'completed',
        requirements: [],
      });
    } finally {
      await f.store.releaseSessionOwner(owner);
    }
    expect(await f.store.getSession('session')).toMatchObject({
      title: '',
      controlRevision: '0',
    });
    await f.submit('work', '稍后继续对话');
    await f.runtime.waitForCommand('work');
    expect(f.requests).toHaveLength(1);
    expect(f.titleRequests()).toHaveLength(0);
    const view = await f.runtime.getView('session');
    expect(view.session).toMatchObject({ title: '', controlRevision: '0' });
    expect(view.runs.find((run) => run.originCommandId === 'work')?.status).toBe('completed');
    expect(
      (await f.store.getChanges({ after: '0', limit: 100 })).events.filter(
        (event) => event.type === 'session.renamed',
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('ordinary child isolation preserves the main recovery checkpoint before final Run completion', async () => {
  const completionGate = { entered: deferred(), release: deferred() };
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    completionGate,
  );
  try {
    await f.submit();
    await completionGate.entered.promise;
    const before = await f.runtime.getView('session');
    const run = before.runs[0]!;
    expect(run.isActive).toBe(true);
    expect(before.executions).toHaveLength(4);
    const titleExecution = before.executions.find(
      (execution) => execution.definitionId === 'agent/session-title',
    )!;
    const mainExecution = before.executions.find((execution) => execution.kind === 'model')!;
    expect(titleExecution.status).toBe('succeeded');
    expect(mainExecution.status).toBe('succeeded');
    const child = await f.runtime.getView(titleExecution.childSessionId!);
    expect(child.messages.at(-1)?.content).toBe(generated);
    const fullTitle = await f.runtime.readModelOutput({
      ...f.base,
      sessionId: child.session.id,
      executionId: child.executions.find((execution) => execution.kind === 'model')!.id,
    });
    expect(fullTitle.output).toMatchObject({ content: generated, complete: true, toolCalls: [] });
    const session = (await f.store.getSession('session'))!;
    const input = {
      ...f.base,
      commandId: 'resume',
      runId: run.id,
      expectedOwnerGeneration: session.ownerGeneration,
    };
    const recovery = await f.store.verifyRunResume(input);
    expect(recovery.checkpoint?.boundary).toBe('completion');
    expect(recovery.checkpoint?.contextSelectionId).toBe(session.contextSelectionId);
    expect(
      recovery.executions
        .filter((execution) => execution.kind === 'model')
        .map((execution) => execution.id),
    ).toEqual([mainExecution.id]);
    expect(recovery.executions.some((execution) => execution.id === titleExecution.id)).toBe(false);
    completionGate.release.resolve();
    await f.runtime.waitForCommand('work');
    const after = await f.runtime.getView('session');
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({ id: run.id, status: 'completed' });
    expect(f.requests).toHaveLength(2);
    expect(f.titleRequests()).toHaveLength(1);
    expect(after.executions.map((execution) => execution.id)).toEqual(
      before.executions.map((execution) => execution.id),
    );
    const messages = await f.runtime.listMessages('session');
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain(generated);
    expect(JSON.stringify(messages)).toContain('已完成主要任务');
    expect((await f.store.getSession('session'))?.title).toBe(generated);
  } finally {
    completionGate.release.resolve();
    await f.close();
  }
});

test('a late title result cannot overwrite a peer Worker manual rename', async () => {
  const release = deferred();
  const f = await fixture(async function* () {
    await release.promise;
    yield { type: 'text_delta', text: generated };
    yield finish;
  });
  const peer = await openSqliteStore(f.profile);
  try {
    await f.submit();
    await f.titleStarted.promise;
    const before = (await peer.getSession('session'))!;
    await peer.renameSession({
      ...f.base,
      commandId: 'manual',
      ifRevision: before.controlRevision,
      title: '用户选择的名称',
    });
    release.resolve();
    await f.runtime.waitForCommand('work');
    expect((await peer.getSession('session'))?.title).toBe('用户选择的名称');
    expect((await f.runtime.getView('session')).runs[0]?.status).toBe('completed');
  } finally {
    release.resolve();
    await peer.close();
    await f.close();
  }
});

test.each([
  'explicit',
  'manual',
] as const)('a preexisting %s title skips metadata generation', async (mode) => {
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    mode === 'explicit' ? '明确标题' : '',
  );
  try {
    if (mode === 'manual')
      await f.store.renameSession({
        ...f.base,
        commandId: 'manual',
        ifRevision: '0',
        title: '明确标题',
      });
    await f.submit();
    await f.runtime.waitForCommand('work');
    expect(f.titleRequests()).toHaveLength(0);
    expect((await f.store.getSession('session'))?.title).toBe('明确标题');
    expect((await f.runtime.getView('session')).runs[0]?.status).toBe('completed');
  } finally {
    await f.close();
  }
});

test.each([
  'empty',
  'json',
  'multiline',
  'length',
  'tool_call',
  'transport',
  'partial',
  'retryable',
] as const)('invalid or failed metadata preserves fallback and the completed task: %s', async (mode) => {
  const f = await fixture(async function* () {
    if (mode === 'retryable') throw new ModelAttemptError('provider_unavailable');
    if (mode === 'transport') throw new Error('local fixture transport failure');
    yield {
      type: 'text_delta',
      text:
        mode === 'empty'
          ? '  '
          : mode === 'json'
            ? '{"title":"topic"}'
            : mode === 'multiline'
              ? 'Topic\nExplanation'
              : generated,
    };
    if (mode === 'partial') throw new Error('local fixture partial transport failure');
    if (mode === 'tool_call')
      yield { type: 'tool_call', id: 'forbidden', name: 'not_registered', arguments: '{}' };
    yield {
      ...finish,
      reason: mode === 'length' ? 'length' : mode === 'tool_call' ? 'tool_calls' : 'stop',
    };
  });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    const view = await f.runtime.getView('session');
    expect(view.runs[0]?.status).toBe('completed');
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(view.messages).toHaveLength(2);
    expect(f.titleRequests()).toHaveLength(1);
    expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('cancellation reaches the actual metadata adapter signal and preserves fallback', async () => {
  const aborted = deferred();
  let titleSignal: AbortSignal | undefined;
  const f = await fixture(async function* (signal) {
    titleSignal = signal;
    await new Promise<void>((_resolve, reject) => {
      const cancel = () => {
        aborted.resolve();
        reject(signal.reason);
      };
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
    yield finish;
  });
  try {
    await f.submit();
    await f.titleStarted.promise;
    await f.runtime.cancelCommand({ ...f.base, commandId: 'cancel', targetCommandId: 'work' });
    await aborted.promise;
    await f.runtime.waitForCommand('work');
    expect(titleSignal?.aborted).toBe(true);
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    for (let attempt = 0; attempt < 200; attempt++) {
      const carrier = (await f.runtime.getView('session')).executions.find(
        (e) => e.definitionId === 'agent/session-title',
      );
      if (carrier?.status === 'cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const view = await f.runtime.getView('session');
    expect(view.messages).toHaveLength(2);
    expect(
      view.executions.find((execution) => execution.definitionId === 'agent/session-title')?.status,
    ).toBe('cancelled');
  } finally {
    await f.close();
  }
});

test('the title deadline cancels the actual child and waits for its recorded terminal result', async () => {
  let cancelled = false;
  const f = await fixture(async function* (signal) {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
    yield finish;
  });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 14000 });
    const view = await f.runtime.getView('session');
    expect(view.runs[0]?.status).toBe('completed');
    expect(cancelled).toBe(true);
    expect(view.session.title).toBe(truncatedOriginal);
    expect(f.titleRequests()).toHaveLength(1);
    expect(
      view.executions.find((execution) => execution.definitionId === 'agent/session-title')?.status,
    ).toBe('cancelled');
    expect(
      view.executions.find(
        (execution) => execution.definitionId === 'builtin.session-title/generate',
      )?.result,
    ).toMatchObject({ outcome: 'succeeded', content: 'fallback_retained' });
  } finally {
    await f.close();
  }
}, 15000);

test('a failed first ordinary Model preserves the exact original input prefix without an AI title request', async () => {
  const f = await fixture(
    async function* () {
      yield finish;
    },
    '',
    undefined,
    'failure',
  );
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    const view = await f.runtime.getView('session');
    expect(view.runs[0]?.status).toBe('failed');
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(Array.from((await f.store.getSession('session'))!.title)).toHaveLength(10);
    expect(f.titleRequests()).toHaveLength(0);
    expect(f.requests).toHaveLength(1);
    expect(
      f.requests[0]?.messages.some(
        (message) => message.role === 'user' && message.content === original,
      ),
    ).toBe(true);
    expect(view.executions.filter((execution) => execution.kind === 'model')).toHaveLength(1);
    expect(view.executions.find((execution) => execution.kind === 'model')?.status).toBe('failed');
    await f.submit('later', '第二条输入不能覆盖第一条原文');
    await f.runtime.waitForCommand('later');
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(f.titleRequests()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('an unavailable Model before Run creation still preserves the exact first input prefix without Provider work', async () => {
  const f = await fixture(
    async function* () {
      yield finish;
    },
    '',
    undefined,
    'unavailable',
  );
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    expect((await f.store.getCommand('work'))?.status).toBe('rejected');
    const view = await f.runtime.getView('session');
    expect(view.runs).toHaveLength(0);
    expect(view.executions.filter((execution) => execution.kind === 'model')).toHaveLength(0);
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(Array.from((await f.store.getSession('session'))!.title)).toHaveLength(10);
    expect(f.requests).toHaveLength(0);
    expect(f.titleRequests()).toHaveLength(0);
    await f.submit('later', '第二条输入不能覆盖第一条原文');
    await f.runtime.waitForCommand('later');
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('actual provider retry waiting preserves the first raw input title and cancellation never starts title generation', async () => {
  const f = await fixture(
    async function* () {
      yield finish;
    },
    '',
    undefined,
    'retrying',
  );
  const failedAttempts = async (count: number) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const view = await f.runtime.getView('session');
      const failed = view.executions.filter(
        (execution) => execution.kind === 'model' && execution.status === 'failed',
      );
      if (failed.length >= count) return { view, failed };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('fixture retry did not reach the expected failed attempt');
  };
  try {
    await f.submit();
    const first = await failedAttempts(1);
    expect(first.failed[0]?.result).toMatchObject({ incomplete: true });
    expect(first.view.runs[0]?.isActive).toBe(true);
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(Array.from((await f.store.getSession('session'))!.title)).toHaveLength(10);
    expect(f.titleRequests()).toHaveLength(0);
    const retry = await failedAttempts(2);
    expect(retry.failed[1]?.decisionSource).toMatchObject({
      retry: {
        previousExecutionId: first.failed[0]!.id,
        attempt: 2,
        maxAttempts: null,
        reason: 'provider_unavailable',
      },
    });
    expect(retry.view.runs[0]?.isActive).toBe(true);
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(f.titleRequests()).toHaveLength(0);
    await f.runtime.cancelCommand({
      ...f.base,
      commandId: 'cancel-original',
      targetCommandId: 'work',
    });
    await f.runtime.waitForCommand('work');
    expect((await f.runtime.getView('session')).runs[0]?.status).toBe('cancelled');
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(f.titleRequests()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

async function publicInputSettled(f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const command = (await f.runtime.getCommand('work'))!;
    if (command.status === 'rejected') return command;
    const receipt = command.receipt as { outcome?: string; observation?: { runId?: string } };
    if (
      receipt.outcome === 'human_input_unresolved' &&
      receipt.observation?.runId &&
      (await f.store.getRun(receipt.observation.runId))?.isActive === false
    )
      return command;
    if (Date.now() >= deadline) throw Error('public title input did not settle');
    await Bun.sleep(5);
  }
}

test.each([
  'unresolved',
  'unavailable',
  'whitespace',
] as const)('public %s input saves only the exact first metadata fallback before business admission', async (mode) => {
  const content = mode === 'whitespace' ? ' \t\r\n\u3000\u00a0'.repeat(2000) : original;
  const f = await fixture(
    async function* () {
      yield finish;
    },
    '',
    undefined,
    mode === 'unavailable' ? 'unavailable' : 'success',
  );
  try {
    await f.submitPublic('work', content);
    const command = await publicInputSettled(f);
    expect(command.request).toEqual({ kind: 'run.start', content });
    const receipt = command.receipt as {
      humanInputCommandId: string;
      businessCommandId?: string | null;
    };
    const raw = (await f.store.getCommand(receipt.humanInputCommandId))!;
    expect(raw.request).toMatchObject({
      content,
      publicCommandId: 'work',
      originalRequest: command.request,
    });
    expect(receipt.businessCommandId ?? null).toBeNull();
    expect((await f.store.readHumanWorkState(f.base)).selectedWork).toBeNull();
    const view = await f.runtime.getView('session');
    const fallback = mode === 'whitespace' ? '新会话' : truncatedOriginal;
    expect(view.session.title).toBe(fallback);
    expect(f.titleRequests()).toHaveLength(0);
    expect(f.requests).toHaveLength(mode === 'unavailable' ? 0 : 1);
    expect(view.executions.every((execution) => execution.kind === 'model')).toBe(true);
    expect(view.runs).toHaveLength(mode === 'unavailable' ? 0 : 1);
    expect(
      view.runs.every(
        (run) =>
          (run.configuration as { snapshot: { kind: string } }).snapshot.kind ===
          'human_input_processing',
      ),
    ).toBe(true);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.submitPublic('work', content);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.requests).toHaveLength(mode === 'unavailable' ? 0 : 1);
    await f.runtime.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await cold.getSession('session'))?.title).toBe(fallback);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      expect((await cold.getCommand(raw.id))?.request).toEqual(raw.request);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('a public interpreted first task binds metadata and one AI title to its actual business Run', async () => {
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
    true,
  );
  try {
    await f.submitPublic();
    await f.runtime.waitForCommand('work', { timeoutMs: 2000 });
    const command = (await f.runtime.getCommand('work'))!;
    const receipt = command.receipt as {
      businessCommandId: string;
      runId: string;
      humanInputCommandId: string;
    };
    expect(receipt).toMatchObject({ outcome: 'human_input_applied' });
    expect(receipt.businessCommandId).not.toBe(command.id);
    const business = (await f.store.getCommand(receipt.businessCommandId))!;
    expect(business.request).toMatchObject({ kind: 'input.follow_up', content: original });
    const run = (await f.store.getRun(receipt.runId))!;
    expect(run).toMatchObject({
      originCommandId: business.id,
      rootWorkCommandId: 'work',
      status: 'completed',
    });
    expect((await f.store.getSession('session'))?.title).toBe(generated);
    expect(f.requests).toHaveLength(3);
    expect(f.titleRequests()).toHaveLength(1);
    expect(f.titleRequests()[0]?.messages.at(-1)?.content).toBe(
      original.replace(/\s+/gu, ' ').trim(),
    );
    const view = await f.runtime.getView('session');
    expect(JSON.stringify(view.messages)).not.toContain(generated);
    expect(
      view.executions.filter((execution) => execution.definitionId === 'agent/session-title'),
    ).toHaveLength(1);
    expect((await f.store.getCommand(receipt.humanInputCommandId))?.request).toMatchObject({
      content: original,
    });
  } finally {
    await f.close();
  }
});

test('public metadata does not replace a manual name or name an old empty history', async () => {
  for (const mode of ['manual', 'history'] as const) {
    const f = await fixture(async function* () {
      yield finish;
    });
    try {
      if (mode === 'manual')
        await f.runtime.renameSession({
          ...f.base,
          commandId: 'manual',
          ifRevision: '0',
          title: '人工名称',
        });
      else {
        const owner = (await f.store.acquireSessionOwner('session', 'history-host'))!;
        try {
          await f.store.acceptCommand({
            ...f.base,
            commandId: 'history',
            request: { kind: 'run.start', content: 'Original first work' },
          });
          const run = await f.store.startRun({
            expectedStoreId: f.base.expectedStoreId,
            owner,
            commandId: 'history',
            configuration: { modelId: 'fixture' },
          });
          await f.store.finishRun({
            expectedStoreId: f.base.expectedStoreId,
            owner,
            runId: run.id,
            status: 'completed',
            requirements: [],
          });
        } finally {
          await f.store.releaseSessionOwner(owner);
        }
      }
      const before = f.requests.length;
      await f.submitPublic();
      await publicInputSettled(f);
      expect((await f.store.getSession('session'))?.title).toBe(
        mode === 'manual' ? '人工名称' : '',
      );
      expect(f.requests).toHaveLength(before + 1);
      expect(f.titleRequests()).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
});

test.each([
  'retained',
  'missing',
] as const)('metadata requires the %s original registration after a global event floor', async (mode) => {
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
    true,
  );
  const db = new Database(join(f.root, 'data', 'test', 'core.db'));
  db.run('PRAGMA busy_timeout=1000');
  try {
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await f.store.registerHumanCommand({
      ...f.base,
      commandId: 'work',
      request: { kind: 'run.start', content: original },
    });
    const floor = mode === 'retained' ? before : (await f.store.getMetadata()).lastChangeCursor;
    db.run('UPDATE storage_meta SET replay_floor=? WHERE singleton=1', [BigInt(floor)]);
    await f.submitPublic();
    await f.runtime.waitForCommand('work', { timeoutMs: 2000 });
    expect((await f.store.getSession('session'))?.title).toBe(mode === 'retained' ? generated : '');
    expect(f.titleRequests()).toHaveLength(mode === 'retained' ? 1 : 0);
    expect(f.requests).toHaveLength(mode === 'retained' ? 3 : 2);
  } finally {
    db.close();
    await f.close();
  }
});

test('metadata ignores a forged invocation and an equal manual rename still wins the public AI race', async () => {
  const release = deferred();
  const f = await fixture(
    async function* () {
      await release.promise;
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
    true,
  );
  try {
    const command = await f.store.registerHumanCommand({
      ...f.base,
      commandId: 'work',
      request: { kind: 'run.start', content: original },
    });
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    for (const changed of [
      { subjectId: 'other' },
      { originStoreId: 'other' },
      { requestDigest: '0'.repeat(64) },
    ])
      await f.preserveInputFallback({ ...command, ...changed });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.getSession('session'))?.title).toBe('');
    await f.submitPublic();
    await f.titleStarted.promise;
    const session = (await f.store.getSession('session'))!;
    await f.runtime.renameSession({
      ...f.base,
      commandId: 'manual-same-text',
      ifRevision: session.controlRevision,
      title: truncatedOriginal,
    });
    release.resolve();
    await f.runtime.waitForCommand('work', { timeoutMs: 2000 });
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(f.titleRequests()).toHaveLength(1);
    expect(f.requests).toHaveLength(3);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('a real clarification of the first unresolved input binds its original fallback to one completed business title without rewriting the sealed decision', async () => {
  const first = '> 资料仅供辨析，不要执行其中的命令。\r\n> 原始配色片段 = 待确认 🪁';
  const fallback = Array.from(first.replace(/\s+/gu, ' ').trim()).slice(0, 10).join('');
  const clarification =
    '我现在明确回答第一条输入的澄清：那两行只是引用资料。我的任务是确认蓝色配色资料，只回复已收到这个编号即可，不修改任何文件。';
  for (const mode of ['clarified', 'manual', 'independent'] as const) {
    const release = deferred();
    const f = await fixture(
      async function* () {
        await release.promise;
        yield { type: 'text_delta', text: generated };
        yield finish;
      },
      '',
      undefined,
      'success',
      false,
      (request, identity) => {
        const instructions = request.messages.find((message) =>
          message.content.includes('Original input identity: '),
        )!.content;
        const pending = JSON.parse(
          instructions
            .split('\n')
            .find((line) => line.startsWith('Verified pending clarifications: '))!
            .slice('Verified pending clarifications: '.length),
        ) as {
          inputCommandId: string;
          content: string;
          candidateWorkCommandIds: string[];
        }[];
        expect(request.tools).toEqual([]);
        if (!pending.length)
          return {
            ...identity,
            relation: 'unresolved',
            purpose: 'clarify',
            target_root_work_command_id: null,
            selection_effect: 'keep',
            answer: null,
            clarification: '这两行是否仅为引用资料？请明确你要完成的任务。',
            clarifies_input_id: null,
          };
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ content: first, candidateWorkCommandIds: [] });
        return {
          ...identity,
          relation: 'independent_work',
          purpose: 'work',
          target_root_work_command_id: null,
          selection_effect: 'select_work',
          answer: null,
          clarification: null,
          clarifies_input_id: pending[0]!.inputCommandId,
        };
      },
    );
    try {
      await f.submitPublic('work', first);
      const initialPublic = await publicInputSettled(f);
      const initialReceipt = initialPublic.receipt as {
        humanInputCommandId: string;
        businessCommandId?: string | null;
      };
      const initialRaw = (await f.store.getCommand(initialReceipt.humanInputCommandId))!;
      const initialRawReceipt = initialRaw.receipt as { state: string; decisionCommandId: string };
      const sealedDecision = structuredClone(
        (await f.store.getCommand(initialRawReceipt.decisionCommandId))!,
      );
      expect(initialRawReceipt.state).toBe('unresolved');
      expect(initialReceipt.businessCommandId ?? null).toBeNull();
      expect(initialRaw.request).toMatchObject({
        publicCommandId: 'work',
        content: first,
        originalRequest: initialPublic.request,
      });
      expect((await f.store.getSession('session'))?.title).toBe(fallback);
      expect((await f.store.readHumanWorkState(f.base)).selectedWork).toBeNull();
      expect(f.requests).toHaveLength(1);
      expect(f.titleRequests()).toHaveLength(0);
      expect(
        (await f.runtime.getView('session')).executions.every(
          (execution) => execution.kind === 'model',
        ),
      ).toBe(true);
      if (mode === 'manual') {
        const session = (await f.store.getSession('session'))!;
        await f.runtime.renameSession({
          ...f.base,
          commandId: 'manual-before-clarification',
          ifRevision: session.controlRevision,
          title: '用户保留名称',
        });
      }
      const secondContent =
        mode === 'independent'
          ? 'New task: 另一项独立工作，只回复收到，不修改文件，不回答此前澄清。'
          : clarification;
      await f.submitPublic('clarification', secondContent);
      const deadline = Date.now() + 2000;
      for (;;) {
        const current = (await f.runtime.getCommand('clarification'))!;
        const receipt = current.receipt as { runId?: string };
        if (
          f.titleRequests().length ||
          (receipt.runId && (await f.store.getRun(receipt.runId))?.isActive === false)
        )
          break;
        if (Date.now() >= deadline) throw Error('first clarification business did not settle');
        await Bun.sleep(5);
      }
      const publicCommand = (await f.runtime.getCommand('clarification'))!;
      const receipt = publicCommand.receipt as {
        humanInputCommandId: string;
        businessCommandId: string;
        runId: string;
      };
      const raw = (await f.store.getCommand(receipt.humanInputCommandId))!;
      const rawReceipt = raw.receipt as { decisionCommandId: string; businessCommandId: string };
      const decision = (await f.store.getCommand(rawReceipt.decisionCommandId))!;
      const business = (await f.store.getCommand(receipt.businessCommandId))!;
      expect(publicCommand.request).toEqual({ kind: 'run.start', content: secondContent });
      expect(raw.request).toMatchObject({
        publicCommandId: publicCommand.id,
        content: secondContent,
        originalRequest: publicCommand.request,
      });
      expect(rawReceipt.businessCommandId).toBe(business.id);
      expect(decision.request).toMatchObject({
        inputCommandId: raw.id,
        inputDigest: raw.requestDigest,
        proposal: { relation: 'independent_work', purpose: 'work', targetRootWorkCommandId: null },
      });
      expect(decision.receipt).toMatchObject({ businessCommandId: business.id });
      expect(business.receipt).toMatchObject({ runId: receipt.runId });
      expect(business.request).toMatchObject({ content: secondContent });
      expect(await f.store.getRun(receipt.runId)).toMatchObject({
        originCommandId: business.id,
        rootWorkCommandId: publicCommand.id,
      });
      expect(await f.store.getCommand(sealedDecision.id)).toEqual(sealedDecision);
      expect((await f.store.getCommand(initialRaw.id))?.request).toEqual(initialRaw.request);
      if (mode === 'independent') {
        expect((await f.store.getCommand(initialRaw.id))?.receipt).toEqual(initialRaw.receipt);
        expect(f.requests).toHaveLength(2);
        expect(f.titleRequests()).toHaveLength(0);
      } else {
        expect(
          f.requests.filter((request) =>
            request.messages.some((message) =>
              message.content.includes('Original input identity: '),
            ),
          ),
        ).toHaveLength(2);
        expect(decision.request).toMatchObject({ clarifiesInputId: initialRaw.id });
        expect((await f.store.getCommand(initialRaw.id))?.receipt).toMatchObject({
          state: 'clarified',
          clarifyingInputId: raw.id,
        });
        expect((await f.store.getCommand(initialPublic.id))?.receipt).toMatchObject({
          reason: 'clarified_by_input',
          clarifyingInputId: raw.id,
        });
        expect((await f.store.readHumanWorkState(f.base)).pendingInputIds).not.toContain(
          initialRaw.id,
        );
        if (mode === 'clarified') {
          expect(f.titleRequests()).toHaveLength(1);
          expect(f.titleRequests()[0]?.messages.at(-1)?.content).toBe(
            first.replace(/\s+/gu, ' ').trim(),
          );
          expect(await f.store.getRun(receipt.runId)).toMatchObject({ isActive: true });
          expect((await f.store.getSession('session'))?.title).toBe(fallback);
        } else expect(f.titleRequests()).toHaveLength(0);
      }
      release.resolve();
      await f.runtime.waitForCommand('clarification', { timeoutMs: 2000 });
      expect(await f.store.getRun(receipt.runId)).toMatchObject({
        status: 'completed',
        originCommandId: business.id,
      });
      expect((await f.store.getSession('session'))?.title).toBe(
        mode === 'manual' ? '用户保留名称' : mode === 'clarified' ? generated : fallback,
      );
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      const requestCount = f.requests.length;
      await f.submitPublic('clarification', secondContent);
      expect(f.requests).toHaveLength(requestCount);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(f.titleRequests()).toHaveLength(mode === 'clarified' ? 1 : 0);
    } finally {
      release.resolve();
      await f.close();
    }
  }
});
