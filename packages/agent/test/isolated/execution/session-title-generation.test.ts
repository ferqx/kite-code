import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Database } from '@kite-ai/agent/runtime-sqlite';
import {
  type ModelAdapter,
  ModelAttemptError,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createArtifactStore } from '../../../src/artifacts';
import { createSessionTitleExtension } from '../../../src/business/session-title';
import { sessionTitleInstructions } from '../../../src/business/session-title/title';
import type { Permissions } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { type AgentRuntime, createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { AgentError } from '../../../src/storage/types';

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
  options: {
    titlePermissions?(store: Store): Permissions;
    titleDispose?(): Promise<void>;
    beforeResolveTitle?(sessionId: string): Promise<void>;
    blocker?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
    titleBlocker?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
    modelConcurrency?: number;
    artifacts?: boolean;
    publishTitle?(
      input: Parameters<Store['publishAutomaticSessionTitle']>[0],
      publish: Store['publishAutomaticSessionTitle'],
    ): ReturnType<Store['publishAutomaticSessionTitle']>;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-title-generation-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const requests: ModelRequest[] = [];
  const titleStarted = deferred();
  const model: ModelAdapter = {
    async *stream(request, { signal }) {
      requests.push(structuredClone(request));
      expect(
        request.messages.some((message) => message.content.includes('Original input identity:')),
      ).toBe(false);
      if (
        request.messages.some(
          (message) => message.role === 'system' && message.content === sessionTitleInstructions,
        )
      ) {
        expect(request.tools).toEqual([]);
        titleStarted.resolve();
        if (options.titleBlocker && request.messages.at(-1)?.content === 'BLOCK_TITLE_MODEL_SLOT') {
          options.titleBlocker.entered.resolve();
          await options.titleBlocker.release.promise;
        }
        yield* titleStream(signal);
      } else {
        if (
          options.blocker &&
          request.messages.some((message) => message.content === 'BLOCK_TITLE_MODEL_SLOT')
        ) {
          options.blocker.entered.resolve();
          await options.blocker.release.promise;
        }
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
      if (key === 'publishAutomaticSessionTitle' && options.publishTitle)
        return (input: Parameters<Store['publishAutomaticSessionTitle']>[0]) =>
          options.publishTitle!(input, target.publishAutomaticSessionTitle.bind(target));
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
    resolveModel: async ({ session }) => {
      await options.beforeResolveTitle?.(session.id);
      return {
        model,
        modelId: 'fixture',
        toolIds: [],
        snapshot: null,
        ...(options.titleDispose ? { dispose: options.titleDispose } : {}),
        ...(options.titlePermissions ? { permissions: options.titlePermissions(store) } : {}),
      };
    },
  });
  runtime = createRuntime({
    store: runtimeStore,
    ...(options.artifacts ? { artifacts: createArtifactStore({ profile, store }) } : {}),
    ...(mainMode === 'unavailable' ? {} : { model }),
    modelId: 'fixture',
    ...(options.modelConcurrency ? { modelConcurrency: options.modelConcurrency } : {}),
    extensions: [titles.extension],
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
    ordinaryRequests() {
      return requests.filter(
        (request) =>
          !request.messages.some((message) => message.content === sessionTitleInstructions),
      );
    },
    async waitForTitle(timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const record = await store.getExtensionRecord({
          extensionId: 'builtin.session-title',
          sessionId: 'session',
          key: 'automatic-title-attempt',
        });
        const attempt = record?.value as
          | { publication: string; jobExecutionId: string | null }
          | undefined;
        const job = attempt?.jobExecutionId
          ? await store.getExecution(attempt.jobExecutionId)
          : null;
        if (
          !attempt ||
          (attempt.publication !== 'pending' &&
            job &&
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(job.status))
        )
          return;
        if (Date.now() >= deadline)
          throw new Error(`title settlement timeout: ${JSON.stringify({ attempt, job })}`);
        await sleepTimer(5);
      }
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('main completion and the next Run do not wait for the original detached title Job', async () => {
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
    { modelConcurrency: 1 },
  );
  try {
    await f.submit();
    await f.titleStarted.promise;
    await f.runtime.waitForCommand('work', { timeoutMs: 2000 });
    let view = await f.runtime.getView('session');
    expect(view.runs.find((run) => run.originCommandId === 'work')?.status).toBe('completed');
    expect(view.session).toMatchObject({ title: truncatedOriginal, controlRevision: '0' });
    const job = view.executions.find(
      (execution) => execution.definitionId === 'builtin.session-title/generate',
    )!;
    expect(job).toMatchObject({
      kind: 'job',
      runId: null,
      status: 'running',
      cancelWithParent: false,
    });
    expect(['dispatching', 'running']).toContain(
      view.executions.find((execution) => execution.parentExecutionId === job.id)!.status,
    );
    await f.submit('later', '下一轮无需等待标题');
    await f.runtime.waitForCommand('later', { timeoutMs: 2000 });
    view = await f.runtime.getView('session');
    expect(view.runs.find((run) => run.originCommandId === 'later')?.status).toBe('completed');
    expect((await f.store.getExecution(job.id))?.status).toBe('running');
    expect(
      view.executions.filter(
        (execution) => execution.definitionId === 'builtin.session-title/generate',
      ),
    ).toHaveLength(1);
    release.resolve();
    await f.waitForTitle();
    expect((await f.store.getSession('session'))?.title).toBe(generated);
    expect(await f.store.getExecution(job.id)).toMatchObject({
      delivery: 'suppressed',
      deliveryReason: 'internal_metadata',
    });
    expect(f.titleRequests()).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test.each([
  'committed-reply-lost',
  'pending-reply-lost',
  'unconfirmed-live-call',
  'pending-rollback',
] as const)('one original publication is resolved without repeating the title effect: %s', async (mode) => {
  const gate = { entered: deferred(), release: deferred() };
  let publications = 0;
  let originalPublication: ReturnType<Store['publishAutomaticSessionTitle']> | undefined;
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
    {
      publishTitle: async (input, publish) => {
        publications++;
        gate.entered.resolve();
        if (mode === 'unconfirmed-live-call') {
          originalPublication = gate.release.promise.then(() => publish(input));
          void originalPublication.catch(() => {});
          throw new AgentError('fixture_title_ack_unknown');
        }
        if (mode !== 'committed-reply-lost') await gate.release.promise;
        const result = await publish(input);
        if (mode !== 'pending-rollback') throw new AgentError('fixture_title_reply_lost');
        return result;
      },
    },
  );
  const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  try {
    if (mode === 'pending-rollback')
      physical.run(
        "CREATE TRIGGER fail_title_publish BEFORE UPDATE ON extension_record WHEN NEW.key='automatic-title-attempt' AND json_extract(NEW.json,'$.publication')='published' BEGIN SELECT RAISE(ABORT,'rollback publication'); END",
      );
    await f.submit();
    await gate.entered.promise;
    await f.runtime.waitForCommand('work');
    if (mode !== 'committed-reply-lost') {
      const before = await f.store.getExtensionRecord({
        extensionId: 'builtin.session-title',
        sessionId: 'session',
        key: 'automatic-title-attempt',
      });
      expect(before?.value).toMatchObject({ publication: 'pending' });
      expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
      await f.submit('later', '标题事务尚未结束时继续业务');
      await f.runtime.waitForCommand('later', { timeoutMs: 2000 });
      expect(
        (await f.runtime.getView('session')).runs.find((run) => run.originCommandId === 'later')
          ?.status,
      ).toBe('completed');
      expect(
        (
          await f.store.getExtensionRecord({
            extensionId: 'builtin.session-title',
            sessionId: 'session',
            key: 'automatic-title-attempt',
          })
        )?.value,
      ).toMatchObject({ publication: 'pending' });
      gate.release.resolve();
    }
    await f.waitForTitle();
    expect(publications).toBe(1);
    expect(f.titleRequests()).toHaveLength(1);
    const view = await f.runtime.getView('session');
    expect(view.session.title).toBe(mode === 'pending-rollback' ? truncatedOriginal : generated);
    expect(
      view.executions.find(
        (execution) => execution.definitionId === 'builtin.session-title/generate',
      )?.status,
    ).toBe('succeeded');
    expect(
      (
        await f.store.getExtensionRecord({
          extensionId: 'builtin.session-title',
          sessionId: 'session',
          key: 'automatic-title-attempt',
        })
      )?.value,
    ).toMatchObject(
      mode === 'pending-rollback'
        ? { publication: 'closed', closedReason: 'title_publication_failed' }
        : { publication: 'published' },
    );
    const events = await f.store.getChanges({ after: '0', limit: 200 });
    expect(events.events.filter((event) => event.type === 'session.renamed')).toHaveLength(
      mode === 'pending-rollback' ? 1 : 2,
    );
  } finally {
    gate.release.resolve();
    await originalPublication?.catch(() => {});
    physical.close();
    await f.close();
  }
});

test('AI title is durable metadata, excluded from complete history and later model input', async () => {
  const f = await fixture(async function* () {
    yield { type: 'text_delta', text: `标题：“${generated}”` };
    yield finish;
  });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    await f.waitForTitle();
    const view = await f.runtime.getView('session');
    expect(view.runs[0]?.status).toBe('completed');
    expect((await f.store.getSession('session'))?.title).toBe(generated);
    const titleExecution = view.executions.find(
      (execution) => execution.kind === 'model' && execution.runId === null,
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
    expect(JSON.stringify(ordinary[1]?.messages)).not.toContain('title_saved');
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

test('title admission overflow retains fallback once while every business Run and the next input still complete', async () => {
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
    { modelConcurrency: 1 },
  );
  const ids = Array.from({ length: 8 }, (_, i) => `overflow-${i}`);
  const read = (sessionId: string) =>
    f.store.getExtensionRecord({
      extensionId: 'builtin.session-title',
      sessionId,
      key: 'automatic-title-attempt',
    });
  try {
    await f.submit();
    await f.titleStarted.promise;
    await f.runtime.waitForCommand('work');
    for (const sessionId of ids)
      await f.runtime.createSession({
        ...f.base,
        sessionId,
        commandId: `create-${sessionId}`,
        workspaceId: 'workspace',
        title: '',
      });
    await Promise.all(
      ids.map((sessionId) =>
        f.runtime.submitCommand({
          ...f.base,
          sessionId,
          commandId: `work-${sessionId}`,
          request: { kind: 'run.start', content: `overflow ${sessionId}` },
        }),
      ),
    );
    await Promise.all(
      ids.map((sessionId) => f.runtime.waitForCommand(`work-${sessionId}`, { timeoutMs: 4000 })),
    );
    let records: Awaited<ReturnType<typeof read>>[] = [];
    const deadline = Date.now() + 3000;
    for (;;) {
      records = await Promise.all(ids.map(read));
      if (
        records.some(
          (record) => (record?.value as { publication?: string })?.publication === 'closed',
        )
      )
        break;
      if (Date.now() >= deadline) throw Error('overflow was not retired');
      await sleepTimer(5);
    }
    const rejected = records.filter(
      (record) => (record?.value as { publication?: string })?.publication === 'closed',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.value).toMatchObject({ closedReason: 'session_title_capacity_exceeded' });
    expect(f.titleRequests()).toHaveLength(1);
    for (const id of ids) expect((await f.runtime.getView(id)).runs[0]?.status).toBe('completed');
    const sessionId = rejected[0]!.sessionId;
    const before = (await f.store.getSession(sessionId))!.title;
    await f.runtime.submitCommand({
      ...f.base,
      sessionId,
      commandId: 'overflow-next',
      request: { kind: 'run.start', content: 'next business input' },
    });
    await f.runtime.waitForCommand('overflow-next', { timeoutMs: 2000 });
    expect((await f.store.getSession(sessionId))?.title).toBe(before);
    expect(f.titleRequests()).toHaveLength(1);
    release.resolve();
    await f.waitForTitle();
    const settledDeadline = Date.now() + 3000;
    while (
      (await Promise.all(ids.map(read))).some(
        (record) => (record?.value as { publication?: string })?.publication === 'pending',
      )
    ) {
      if (Date.now() >= settledDeadline) throw Error('admitted titles did not settle');
      await sleepTimer(5);
    }
    await f.runtime.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const outcomes = await Promise.all(
        ids.map((id) =>
          cold.getExtensionRecord({
            extensionId: 'builtin.session-title',
            sessionId: id,
            key: 'automatic-title-attempt',
          }),
        ),
      );
      expect(
        outcomes.filter(
          (record) => (record?.value as { publication?: string })?.publication === 'published',
        ),
      ).toHaveLength(7);
      expect(
        outcomes.filter(
          (record) => (record?.value as { publication?: string })?.publication === 'closed',
        ),
      ).toHaveLength(1);
      expect(f.titleRequests()).toHaveLength(8);
    } finally {
      await cold.close();
    }
  } finally {
    release.resolve();
    await f.close();
  }
});

test('a title continuation keeps complete bounded result text bound to its original output receipt', async () => {
  const content = `${' '.repeat(4096)}${generated}${' '.repeat(4096)}`;
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: content };
      yield { ...finish, continuation: { protocol: 'fixture', token: 'original-title-only' } };
    },
    '',
    undefined,
    'success',
    { artifacts: true },
  );
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    await f.waitForTitle();
    const model = (await f.runtime.getView('session')).executions.find(
      (execution) => execution.kind === 'model' && execution.runId === null,
    )!;
    expect(model).toMatchObject({ status: 'succeeded' });
    expect((await f.store.getExecution(model.id))?.result).toMatchObject({
      content,
      modelOutput: { complete: true },
    });
    const full = await f.runtime.readModelOutput({ ...f.base, executionId: model.id });
    expect(full.output).toMatchObject({ content, complete: true, toolCalls: [] });
    expect((await f.store.getSession('session'))?.title).toBe(generated);
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
    await f.waitForTitle();
    const view = await f.runtime.getView('session');
    expect(view.session.title).toBe('修复 会话 命名，保');
    expect((await f.runtime.getCommand('work'))?.request).toMatchObject({ content: input });
    if (mode === 'unavailable') {
      expect(f.requests).toHaveLength(0);
      expect(view.runs).toHaveLength(0);
    } else {
      expect(view.messages[0]?.content).toBe(input);
      expect(f.ordinaryRequests()[0]?.messages.some((message) => message.content === input)).toBe(
        true,
      );
      expect(view.runs[0]?.status).toBe(mode === 'success' ? 'completed' : 'failed');
    }
    if (mode === 'unavailable') expect(f.titleRequests()).toHaveLength(0);
    else expect(f.titleRequests().length).toBeLessThanOrEqual(1);
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

test('internal title Model isolation preserves the main recovery checkpoint before final Run completion', async () => {
  const completionGate = { entered: deferred(), release: deferred() };
  let disposed = 0;
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    completionGate,
    'success',
    {
      titleDispose: async () => {
        disposed++;
      },
    },
  );
  try {
    await f.submit();
    await completionGate.entered.promise;
    await f.titleStarted.promise;
    for (let i = 0; disposed === 0 && i < 400; i++) await sleepTimer(5);
    expect(disposed).toBe(1);
    const before = await f.runtime.getView('session');
    const run = before.runs[0]!;
    expect(run.isActive).toBe(true);
    expect(before.executions).toHaveLength(4);
    const titleExecution = before.executions.find(
      (execution) => execution.kind === 'model' && execution.runId === null,
    )!;
    const mainExecution = before.executions.find((execution) => execution.kind === 'model')!;
    expect(titleExecution.status).toBe('succeeded');
    expect(mainExecution.status).toBe('succeeded');
    expect(titleExecution.childSessionId).toBeNull();
    expect(before.executions.every((execution) => execution.childSessionId === null)).toBe(true);
    expect((await f.runtime.getCommand(titleExecution.originCommandId))!.kind).toBe(
      'session.title',
    );
    const fullTitle = await f.runtime.readModelOutput({
      ...f.base,
      executionId: titleExecution.id,
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
    await f.waitForTitle();
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
    await f.waitForTitle();
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
    await f.waitForTitle();
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
        (e) => e.kind === 'model' && e.runId === null,
      );
      if (carrier?.status === 'cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const view = await f.runtime.getView('session');
    expect(view.messages).toHaveLength(2);
    expect(
      view.executions.find((execution) => execution.kind === 'model' && execution.runId === null)
        ?.status,
    ).toBe('cancelled');
  } finally {
    await f.close();
  }
});

test('the title deadline cancels the actual internal Model and waits for its recorded terminal result', async () => {
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
    await f.waitForTitle(14000);
    const view = await f.runtime.getView('session');
    expect(view.runs[0]?.status).toBe('completed');
    expect(cancelled).toBe(true);
    expect(view.session.title).toBe(truncatedOriginal);
    expect(f.titleRequests()).toHaveLength(1);
    expect(
      view.executions.find((execution) => execution.kind === 'model' && execution.runId === null)
        ?.status,
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

test('a failed first ordinary Model closes its parallel title without publishing or borrowing later success', async () => {
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
    await f.waitForTitle();
    const view = await f.runtime.getView('session');
    expect(view.runs[0]?.status).toBe('failed');
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(Array.from((await f.store.getSession('session'))!.title)).toHaveLength(10);
    const titleCalls = f.titleRequests().length;
    expect(titleCalls).toBeLessThanOrEqual(1);
    expect(f.requests).toHaveLength(1 + titleCalls);
    expect(
      f
        .ordinaryRequests()[0]
        ?.messages.some((message) => message.role === 'user' && message.content === original),
    ).toBe(true);
    expect(
      view.executions.filter((execution) => execution.kind === 'model' && execution.runId !== null),
    ).toHaveLength(1);
    expect(
      view.executions.find((execution) => execution.kind === 'model' && execution.runId !== null)
        ?.status,
    ).toBe('failed');
    await f.submit('later', '第二条输入不能覆盖第一条原文');
    await f.runtime.waitForCommand('later');
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(f.titleRequests()).toHaveLength(titleCalls);
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

test('actual business Provider retry waiting retains fallback and cancellation closes the parallel title', async () => {
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
        (execution) =>
          execution.kind === 'model' && execution.runId !== null && execution.status === 'failed',
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
    expect(f.titleRequests().length).toBeLessThanOrEqual(1);
    const retry = await failedAttempts(2);
    expect(retry.failed[1]?.decisionSource).toMatchObject({
      retry: {
        previousExecutionId: first.failed[0]!.id,
        attempt: 2,
        maxAttempts: 6,
        reason: 'provider_unavailable',
      },
    });
    expect(retry.view.runs[0]?.isActive).toBe(true);
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(f.titleRequests().length).toBeLessThanOrEqual(1);
    await f.runtime.cancelCommand({
      ...f.base,
      commandId: 'cancel-original',
      targetCommandId: 'work',
    });
    await f.runtime.waitForCommand('work');
    await f.waitForTitle();
    expect((await f.runtime.getView('session')).runs[0]?.status).toBe('cancelled');
    expect((await f.store.getSession('session'))?.title).toBe(truncatedOriginal);
    expect(f.titleRequests().length).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
});

async function publicInputSettled(f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const command = (await f.runtime.getCommand('work'))!;
    if (command.status === 'rejected') return command;
    const receipt = command.receipt as { runId?: string };
    if (receipt.runId && !(await f.store.getRun(receipt.runId))?.isActive) return command;
    if (Date.now() >= deadline) throw Error('public title input did not settle');
    await sleepTimer(5);
  }
}

test.each([
  'ordinary',
  'unavailable',
  'whitespace',
] as const)('public %s input preserves the first fallback without an input classifier', async (mode) => {
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
    await f.waitForTitle();
    expect(command.request).toEqual({ kind: 'run.start', content });
    expect(command.receipt).not.toHaveProperty('humanInputCommandId');
    const view = await f.runtime.getView('session');
    const fallback = mode === 'whitespace' ? '新会话' : truncatedOriginal;
    expect(view.session.title).toBe(fallback);
    expect(f.titleRequests()).toHaveLength(mode === 'ordinary' ? 1 : 0);
    expect(f.requests).toHaveLength(mode === 'unavailable' ? 0 : mode === 'whitespace' ? 1 : 2);
    expect(view.runs).toHaveLength(mode === 'unavailable' ? 0 : 1);
    expect(
      view.runs.every(
        (run) =>
          (run.configuration as { snapshot?: { kind?: string } }).snapshot?.kind !==
          'human_input_processing',
      ),
    ).toBe(true);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.submitPublic('work', content);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.requests).toHaveLength(mode === 'unavailable' ? 0 : mode === 'whitespace' ? 1 : 2);
    await f.runtime.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await cold.getSession('session'))?.title).toBe(fallback);
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      expect((await cold.getCommand(command.id))?.request).toEqual(command.request);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('a public first task directly binds metadata and one AI title to its original command Run', async () => {
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
  );
  try {
    await f.submitPublic();
    await f.runtime.waitForCommand('work', { timeoutMs: 2000 });
    await f.waitForTitle();
    const command = (await f.runtime.getCommand('work'))!;
    const receipt = command.receipt as { runId: string };
    expect(receipt).not.toHaveProperty('humanInputCommandId');
    const run = (await f.store.getRun(receipt.runId))!;
    expect(run).toMatchObject({
      originCommandId: command.id,
      rootWorkCommandId: 'work',
      status: 'completed',
    });
    expect((await f.store.getSession('session'))?.title).toBe(generated);
    expect(f.requests).toHaveLength(2);
    expect(f.titleRequests()).toHaveLength(1);
    expect(f.titleRequests()[0]?.messages.at(-1)?.content).toBe(
      original.replace(/\s+/gu, ' ').trim(),
    );
    const view = await f.runtime.getView('session');
    expect(JSON.stringify(view.messages)).not.toContain(generated);
    expect(
      view.executions.filter((execution) => execution.kind === 'model' && execution.runId === null),
    ).toHaveLength(1);
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

test('ordinary clarification preserves the first input, its reply and the manual title across the next input', async () => {
  const f = await fixture(async function* () {
    yield { type: 'text_delta', text: generated };
    yield finish;
  });
  try {
    await f.submitPublic('work', '> quoted palette material');
    await f.runtime.waitForCommand('work', { timeoutMs: 2000 });
    const first = (await f.store.getCommand('work'))!;
    const messages = await f.store.listMessages('session');
    const current = (await f.store.getSession('session'))!;
    await f.runtime.renameSession({
      ...f.base,
      commandId: 'manual',
      ifRevision: current.controlRevision,
      title: '用户保留名称',
    });
    await f.submitPublic('clarification', 'The quotation is reference material. Use blue.');
    const second = await f.runtime.waitForCommand('clarification', { timeoutMs: 2000 });
    expect(second.receipt).not.toHaveProperty('humanInputCommandId');
    expect(await f.store.getCommand('work')).toEqual(first);
    expect((await f.store.listMessages('session')).slice(0, messages.length)).toEqual(messages);
    expect((await f.store.getSession('session'))?.title).toBe('用户保留名称');
    expect(f.requests).toHaveLength(3);
    expect(f.titleRequests()).toHaveLength(1);
    expect(
      f
        .ordinaryRequests()
        .at(-1)!
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['> quoted palette material', 'The quotation is reference material. Use blue.']);
  } finally {
    await f.close();
  }
});

test('a title adapter that ignores deadline cancellation remains unknown and its late output cannot rename the session', async () => {
  const release = deferred();
  const prefix = 'TITLE_PARTIAL_BEFORE_UNCONFIRMED_STOP';
  let signal: AbortSignal | undefined;
  let draining: Promise<void> | undefined;
  let disposed = 0;
  const f = await fixture(
    async function* (current) {
      signal = current;
      yield { type: 'text_delta', text: prefix };
      await release.promise;
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
    {
      modelConcurrency: 1,
      titleDispose: async () => {
        disposed++;
      },
    },
  );
  try {
    await f.submit();
    await f.titleStarted.promise;
    await f.runtime.waitForCommand('work', { timeoutMs: 14000 });
    await f.waitForTitle(14000);
    const before = await f.runtime.getView('session');
    const model = before.executions.find(
      (execution) => execution.kind === 'model' && execution.runId === null,
    )!;
    expect(signal?.aborted).toBe(true);
    expect(model.status).toBe('outcome_unknown');
    expect(disposed).toBe(0);
    expect(model.result).toMatchObject({ content: prefix });
    expect(
      before.executions.find(
        (execution) => execution.definitionId === 'builtin.session-title/generate',
      )?.result,
    ).toMatchObject({
      outcome: 'outcome_unknown',
      content: 'job_stop_unconfirmed',
      details: { actualResult: { outcome: 'outcome_unknown', content: 'title_stop_unconfirmed' } },
    });
    expect(before.session.title).toBe(truncatedOriginal);
    expect(before.runs[0]?.status).toBe('completed');
    expect(before.executions.every((execution) => execution.childSessionId === null)).toBe(true);
    await f.submit('later', '标题停止未确认时继续业务');
    await f.runtime.waitForCommand('later', { timeoutMs: 2000 });
    expect(
      (await f.runtime.getView('session')).runs.find((run) => run.originCommandId === 'later')
        ?.status,
    ).toBe('completed');
    expect(disposed).toBe(0);
    let storeClosed = false;
    const closeStore = f.store.close.bind(f.store);
    f.store.close = async () => {
      storeClosed = true;
      await closeStore();
    };
    let drained = false;
    draining = f.runtime.close().then(() => {
      drained = true;
    });
    void draining.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(storeClosed).toBe(false);
    expect(drained).toBe(false);
    expect(disposed).toBe(0);
    expect(f.runtime.getLifecycleState().state).toBe('draining');
    expect((await f.store.getMetadata()).storeId).toBe(f.base.expectedStoreId);
    release.resolve();
    await draining;
    expect(storeClosed).toBe(true);
    expect(disposed).toBe(1);
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const late = await cold.getExecution(model.id);
      expect(late?.status).toBe('outcome_unknown');
      expect(late?.result).toMatchObject({ content: prefix });
      expect((await cold.getSession('session'))?.title).toBe(truncatedOriginal);
    } finally {
      await cold.close();
    }

    expect(f.titleRequests()).toHaveLength(1);
  } finally {
    release.resolve();
    await draining?.catch(() => {});
    await f.close();
  }
}, 17000);

test('a late title disposer failure keeps its original physical owner after the Job became unknown', async () => {
  const release = deferred();
  const disposing = deferred();
  let disposed = 0;
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: 'title partial' };
      await release.promise;
      yield finish;
    },
    '',
    undefined,
    'success',
    {
      modelConcurrency: 1,
      titleDispose: async () => {
        disposed++;
        disposing.resolve();
        throw Error('fixture late title cleanup unconfirmed');
      },
    },
  );
  let peer: Store | undefined;
  let peerOwner: Awaited<ReturnType<Store['acquireSessionOwner']>> | undefined;
  try {
    await f.submit();
    await f.titleStarted.promise;
    await f.runtime.waitForCommand('work', { timeoutMs: 14000 });
    await f.waitForTitle(14000);
    const before = await f.store.getSession('session');
    expect(before?.ownerInstanceId).toBeTruthy();
    expect(disposed).toBe(0);
    expect(
      (await f.runtime.getView('session')).executions.find(
        (execution) => execution.definitionId === 'builtin.session-title/generate',
      )?.status,
    ).toBe('outcome_unknown');
    release.resolve();
    await disposing.promise;
    await f.submit('later', 'late title cleanup does not fence ordinary business');
    await f.runtime.waitForCommand('later', { timeoutMs: 3000 });
    const view = await f.runtime.getView('session');
    expect(view.runs.find((run) => run.originCommandId === 'later')?.status).toBe('completed');
    expect(view.session.title).toBe(truncatedOriginal);
    expect(f.titleRequests()).toHaveLength(1);
    const failure = await f.runtime.close().catch((error) => error);
    expect(failure.code).toBe('shutdown_cleanup_unconfirmed');
    expect(disposed).toBe(1);
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect((await f.store.getMetadata()).storeId).toBe(f.base.expectedStoreId);
    peer = await openSqliteStore(f.profile);
    peerOwner = await peer.acquireSessionOwner('session', 'late-cleanup-peer');
    expect(peerOwner).toBeNull();
    expect(await f.store.getSession('session')).toMatchObject({
      ownerInstanceId: before!.ownerInstanceId,
      ownerGeneration: before!.ownerGeneration,
    });
  } finally {
    release.resolve();
    if (peerOwner) await peer?.releaseSessionOwner(peerOwner);
    await peer?.close();
    await f.runtime.close().catch(() => {});
    // The fixture disposer owns no real resource; production must retain this Store above.
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}, 20000);

test('the resolved title Model host ceiling can deny a tool-free metadata call', async () => {
  let checked = 0;
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
    {
      titlePermissions: () => ({
        async authorize(request) {
          checked++;
          expect(request).toMatchObject({
            kind: 'model',
            runId: null,
            sessionId: 'session',
            definitionId: 'fixture',
            definitionVersion: '1',
          });
          return {
            allowed: false,
            revision: 'title-host-denied',
            reason: 'fixture_title_model_denied',
          };
        },
      }),
    },
  );
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    expect(checked).toBeGreaterThan(0);
    expect(f.titleRequests()).toHaveLength(0);
    const view = await f.runtime.getView('session');
    expect(view.session.title).toBe(truncatedOriginal);
    expect(view.runs[0]?.status).toBe('completed');
    expect(
      view.executions.find(
        (execution) => execution.definitionId === 'builtin.session-title/generate',
      ),
    ).toMatchObject({ status: 'succeeded', result: { content: 'fallback_retained' } });
    expect(
      view.executions
        .filter((execution) => execution.kind === 'model' && execution.runId === null)
        .every((execution) => execution.status === 'failed'),
    ).toBe(true);
    expect(view.executions.every((execution) => execution.childSessionId === null)).toBe(true);
  } finally {
    await f.close();
  }
});

test('a title Model rechecks host controls after waiting for its independent title permit', async () => {
  const resolving = { entered: deferred(), release: deferred() };
  const blocker = { entered: deferred(), release: deferred() };
  let checks = 0;
  let allowedChecks = 0;
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
    {
      modelConcurrency: 1,
      titleBlocker: blocker,
      beforeResolveTitle: async (sessionId) => {
        if (sessionId !== 'session') return;
        resolving.entered.resolve();
        await resolving.release.promise;
      },
      titlePermissions: (store) => ({
        async authorize(request) {
          if (request.sessionId !== 'session') return { allowed: true, revision: 'blocker-title' };
          checks++;
          const control = await store.readHostControl({
            expectedStoreId: (await store.getMetadata()).storeId,
            subjectId: 'owner',
            kind: 'permission.mode',
            scope: 'session:session',
          });
          const mode = (control.record?.safeRequest as { mode?: string } | undefined)?.mode;
          if (mode === 'full') allowedChecks++;
          expect(request.kind).toBe('model');
          return {
            allowed: mode === 'full',
            revision: control.revision,
            reason: 'fixture_title_mode_tightened',
            controlReads: [
              { kind: 'permission.mode', scope: 'session:session', revision: control.revision },
            ],
          };
        },
      }),
    },
  );
  const setMode = async (mode: 'auto' | 'full') => {
    const identity = { expectedStoreId: f.base.expectedStoreId, subjectId: f.base.subjectId };
    const current = await f.store.readHostControl({
      ...identity,
      kind: 'permission.mode',
      scope: 'session:session',
    });
    const defaults = await f.store.readHostControl({
      ...identity,
      kind: 'permission.mode',
      scope: 'user',
    });
    const safeRequest = {
      scope: 'session',
      sessionId: 'session',
      mode,
      ifRevision: current.revision,
      makeDefault: false,
      ifDefaultRevision: defaults.revision,
    };
    const request = {
      ...identity,
      commandId: `title-mode-${mode}`,
      kind: 'permission.mode' as const,
      scope: 'session:session',
      safeRequest,
      requestDigest: await semanticDigest(safeRequest),
    };
    await f.store.beginHostMutation(request);
    await f.store.finishHostMutation({
      ...identity,
      commandId: request.commandId,
      requestDigest: request.requestDigest,
      state: 'applied',
      receipt: { status: 'applied' },
    });
  };
  try {
    await setMode('full');
    await f.submit();
    await resolving.entered.promise;
    await f.runtime.createSession({
      ...f.base,
      sessionId: 'blocker',
      commandId: 'create-blocker',
      workspaceId: 'workspace',
      title: '',
    });
    await f.runtime.submitCommand({
      ...f.base,
      sessionId: 'blocker',
      commandId: 'blocker-work',
      request: { kind: 'run.start', content: 'BLOCK_TITLE_MODEL_SLOT' },
    });
    await blocker.entered.promise;
    resolving.release.resolve();
    const deadline = Date.now() + 2000;
    let planned = false;
    while (!planned && Date.now() < deadline) {
      planned =
        allowedChecks > 0 &&
        (await f.store.listExecutions('session')).some(
          (execution) =>
            execution.kind === 'model' &&
            execution.runId === null &&
            execution.status === 'planned',
        );
      if (!planned) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(planned).toBe(true);
    expect(f.titleRequests()).toHaveLength(1);
    await setMode('auto');
    blocker.release.resolve();
    await f.runtime.waitForCommand('blocker-work');
    await f.runtime.waitForCommand('work');
    await f.waitForTitle();
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(f.titleRequests()).toHaveLength(1);
    const view = await f.runtime.getView('session');
    expect(view.session.title).toBe(truncatedOriginal);
    expect(view.runs[0]?.status).toBe('completed');
    expect(view.executions.every((execution) => execution.childSessionId === null)).toBe(true);
  } finally {
    resolving.release.resolve();
    blocker.release.resolve();
    await f.close();
  }
});

test('a proven title disposer failure retains its own cleanup without fencing later business work', async () => {
  let disposed = 0;
  const f = await fixture(
    async function* () {
      yield { type: 'text_delta', text: generated };
      yield finish;
    },
    '',
    undefined,
    'success',
    {
      modelConcurrency: 1,
      titleDispose: async () => {
        disposed++;
        throw new Error('fixture title cleanup unconfirmed');
      },
    },
  );
  try {
    await f.submit();
    await f.runtime.waitForCommand('work');
    await f.waitForTitle();
    expect(disposed).toBe(1);
    const before = await f.runtime.getView('session');
    expect(before.session.title).toBe(truncatedOriginal);
    expect(
      before.executions.find(
        (execution) => execution.definitionId === 'builtin.session-title/generate',
      ),
    ).toMatchObject({
      status: 'outcome_unknown',
      result: { details: { actualResult: { content: 'title_cleanup_unconfirmed' } } },
    });
    expect(f.runtime.getLifecycleState().reasons).toContain('cleanup');
    await f.submit('later', '独立命名清理失败后继续业务');
    await f.runtime.waitForCommand('later', { timeoutMs: 2000 });
    expect(
      (await f.runtime.getView('session')).runs.find((run) => run.originCommandId === 'later')
        ?.status,
    ).toBe('completed');
    const failure = await f.runtime.close().catch((error) => error);
    expect(failure.code).toBe('shutdown_cleanup_unconfirmed');
    expect(disposed).toBe(1);
    expect((await f.store.getMetadata()).storeId).toBe(f.base.expectedStoreId);
  } finally {
    // This fixture's disposer owns no real resource. Release only its test Store after
    // asserting that production shutdown retained the failed cleanup and never replayed it.
    await f.runtime.close().catch(() => {});
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const mode of [
  'success',
  'provider-failure',
  'permission-denied',
  'missing-finish',
  'event-after-finish',
] as const)
  test(`a resolved title Model disposes its configuration exactly once after ${mode}`, async () => {
    let disposed = 0;
    const f = await fixture(
      async function* () {
        if (mode === 'provider-failure') throw Error('fixture title Provider failed');
        yield { type: 'text_delta', text: generated };
        if (mode === 'missing-finish') return;
        yield finish;
        if (mode === 'event-after-finish') yield { type: 'text_delta', text: 'late' };
      },
      '',
      undefined,
      'success',
      {
        titleDispose: async () => {
          disposed++;
        },
        ...(mode === 'permission-denied'
          ? {
              titlePermissions: () => ({
                async authorize() {
                  return { allowed: false, revision: 'denied-title-model' };
                },
              }),
            }
          : {}),
      },
    );
    try {
      await f.submit();
      await f.runtime.waitForCommand('work');
      await f.waitForTitle();
      expect(disposed).toBe(1);
      expect(f.titleRequests()).toHaveLength(mode === 'permission-denied' ? 0 : 1);
      const view = await f.runtime.getView('session');
      expect(view.session.title).toBe(mode === 'success' ? generated : truncatedOriginal);
      expect(view.runs[0]?.status).toBe('completed');
      await f.runtime.close();
      expect(disposed).toBe(1);
    } finally {
      await f.close();
    }
  });
