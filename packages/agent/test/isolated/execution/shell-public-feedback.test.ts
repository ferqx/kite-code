import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { Extension, JobDefinition, JobEvent, Json } from '../../../src/extensions';
import { modelExecutionId } from '../../../src/model-identifier';
import { openSqliteStore } from '../../../src/sqlite';
import { createShellExtension } from '../../../src/tools/shell';

const stdout = '程序原文🪁\n{"job":"customer-order","metadata":{"dispatch":"业务原值"}}\n';
const stderr = '原始诊断：保留原文\n';
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: Record<string, unknown>, id: string): ModelEvent[] {
  return [
    { type: 'tool_call', name, id, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
function publicHandle(request: ModelRequest): string {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== 'tool') continue;
    const match = /shell_id:\s*("(?:[^"\\]|\\.)*")/.exec(message.content);
    if (match) return JSON.parse(match[1]!);
  }
  throw Error('original_public_shell_handle_missing');
}
function publicFeedback(content: string) {
  const prose = content.split('stdout:\n')[0]!;
  expect(prose).not.toMatch(/\b(?:Job|carrier|dispatch|dispatched|Run|Session)\b/i);
  for (const field of ['originStoreId', 'parentExecutionId', 'definitionVersion', 'job_result'])
    expect(content).not.toContain(field);
}

async function fixture(
  responses: ModelEvent[][],
  options: { background?: boolean; denyCommand?: boolean; foreign?: boolean } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-public-feedback-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const model = createFixedModel(responses);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (!options.background) release();
  let starts = 0;
  let customCalls = 0;
  let fakeBody = '';
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'controlled original command',
    inputSchema: { type: 'object' },
    async start() {
      starts++;
      return { reference: { original: true } };
    },
    async *observe(): AsyncIterable<JobEvent> {
      await gate;
      yield { type: 'output', stream: 'stdout', content: stdout };
      yield { type: 'output', stream: 'stderr', content: stderr };
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: 'succeeded',
          content: 'Shell succeeded',
          details: { exitCode: 0, processTreeStopped: true },
        },
      };
    },
    async cancel() {
      release();
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const shell = createShellExtension({ job });
  const extension: Extension = options.foreign
    ? {
        ...shell,
        id: 'fixture.foreign-shell',
        tools: shell.tools!.map((tool) =>
          tool.id === 'shell.execute'
            ? {
                ...tool,
                async execute(input, context) {
                  customCalls++;
                  const original = await tool.execute(input, context);
                  const details = structuredClone(original.details) as Record<string, Json>;
                  // The foreign producer uses real original operation identities, but
                  // claims the builtin owner in its payload. Only the frozen registry
                  // can establish ownership; valid-looking record fields cannot.
                  (details.ref as Record<string, Json>).extensionId = 'builtin.shell';
                  details.job = { metadata: { dispatch: 'untrusted business payload' } };
                  fakeBody = JSON.stringify(details);
                  return {
                    ...original,
                    content: fakeBody,
                    details,
                  };
                },
              }
            : tool,
        ),
      }
    : shell;
  let handle: string | undefined;
  const runtime = createRuntime({
    store,
    model: {
      async *stream(request, streamOptions) {
        if (model.requests.length === 1 && options.background) handle = publicHandle(request);
        const index = model.requests.length;
        responses[index] = (responses[index] ?? []).map((event) => {
          if (event.type !== 'tool_call') return event;
          const args = JSON.parse(event.arguments);
          if (args.shell_id === 'ORIGINAL_HANDLE') args.shell_id = handle;
          return { ...event, arguments: JSON.stringify(args) };
        });
        yield* model.stream(request, streamOptions);
      },
    },
    modelId: 'controlled',
    extensions: [extension],
    permissions: {
      async authorize(request) {
        return options.denyCommand && request.kind === 'job'
          ? {
              allowed: false,
              revision: 'fixture',
              approval: { request: { title: 'Approve this exact original command' } },
            }
          : { allowed: true, revision: 'fixture' };
      },
    },
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'test',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...identity,
    commandId: 'create',
    workspaceId: 'w',
    title: 'test',
  });
  return {
    store,
    runtime,
    model,
    identity,
    get fakeBody() {
      return fakeBody;
    },
    release,
    counts: () => ({ starts, customCalls }),
    async submit(commandId: string) {
      await runtime.submitCommand({
        ...identity,
        commandId,
        request: {
          kind: 'run.start',
          content: 'Inspect the original command result without replay.',
        },
      });
    },
    async close() {
      release();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual foreground model feedback is public text while the original command receipt remains intact', async () => {
  const f = await fixture([
    call('shell_execute', { command: 'printf original' }, 'foreground-call'),
    [finish],
  ]);
  try {
    await f.submit('work');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const rows = await f.store.listExecutions('s');
    const tool = rows.find((row) => row.definitionId === 'shell.execute')!;
    const command = rows.find((row) => row.kind === 'job')!;
    const feedback = f.model.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(feedback).toMatchObject({ toolCallId: 'foreground-call', sourceIds: [tool.id] });
    publicFeedback(feedback.content);
    expect(feedback.content).toContain(stdout);
    expect(feedback.content).toContain(stderr);
    expect(feedback.content).toContain('Exit code: 0');
    expect(feedback.content).toContain(
      `execution_id: ${JSON.stringify(modelExecutionId(tool.id))}`,
    );
    expect(feedback.content).not.toContain(
      `execution_id: ${JSON.stringify(modelExecutionId(command.id))}`,
    );
    const saved = tool.result as { content: string; details: Json };
    expect(JSON.parse(saved.content)).toEqual(saved.details);
    expect(JSON.parse(saved.content).execution.id).toBe(command.id);
    expect(JSON.parse(saved.content).execution_id).toBe(tool.id);
    expect(command.parentExecutionId).toBe(tool.id);
    expect(saved.content).not.toBe(feedback.content);
    expect(f.counts().starts).toBe(1);
  } finally {
    await f.close();
  }
}, 10000);

test('actual original-command human denial reaches the next model without executing or hiding its cause', async () => {
  const f = await fixture(
    [call('shell_execute', { command: 'printf original' }, 'denied-call'), [finish]],
    { denyCommand: true },
  );
  try {
    await f.submit('work');
    const deadline = Date.now() + 5000;
    let card:
      | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
      | undefined;
    while (!card) {
      card = (
        await f.runtime.listInteractions({
          expectedStoreId: f.identity.expectedStoreId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions[0];
      if (Date.now() > deadline) throw Error('original_command_approval_missing');
      if (!card) await Bun.sleep(5);
    }
    expect(card.definitionId).toBe('shell.command');
    expect(f.counts().starts).toBe(0);
    await f.runtime.answerInteraction({
      expectedStoreId: f.identity.expectedStoreId,
      subjectId: 'owner',
      commandId: 'deny-original',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const rows = await f.store.listExecutions('s');
    const tool = rows.find((row) => row.definitionId === 'shell.execute')!;
    const command = rows.find((row) => row.id === card.executionId)!;
    const feedback = f.model.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(feedback).toMatchObject({ toolCallId: 'denied-call', sourceIds: [tool.id] });
    publicFeedback(feedback.content);
    expect(feedback.content).toContain('user denied');
    expect(feedback.content).toContain('not executed');
    expect(feedback.content).toContain('Do not resubmit');
    expect(feedback.content).not.toContain('user approved');
    expect(command.authorization).toMatchObject({
      dispatched: false,
      human: { decision: 'deny', accepted: false },
    });
    expect(JSON.parse((tool.result as { content: string }).content).execution.result.content).toBe(
      'approval_denied',
    );
    expect(rows.filter((row) => row.kind === 'job')).toHaveLength(1);
    expect(f.counts().starts).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);

test('background admission, later original completion and shell_read retain one execution and source identity', async () => {
  const f = await fixture(
    [
      call('shell_execute', { command: 'printf original', background: true }, 'background-call'),
      [finish],
      call('shell_read', { shell_id: 'ORIGINAL_HANDLE' }, 'original-read'),
      [finish],
    ],
    { background: true },
  );
  try {
    await f.submit('first');
    await f.runtime.waitForCommand('first', { timeoutMs: 5000 });
    const accepted = f.model.requests[1]!.messages.find((message) => message.role === 'tool')!;
    publicFeedback(accepted.content);
    expect(accepted.content).toContain('accepted for background execution');
    expect(accepted.content).toContain('Completion has not been confirmed');
    const handle = publicHandle(f.model.requests[1]!);
    const before = await f.store.listExecutions('s');
    const starter = before.find((row) => row.definitionId === 'shell.execute')!;
    const original = before.find((row) => row.kind === 'job')!;
    const originalStarterResult = structuredClone(starter.result);
    expect(accepted.sourceIds).toEqual([starter.id]);
    expect(accepted.content).toContain(
      `execution_id: ${JSON.stringify(modelExecutionId(starter.id))}`,
    );
    expect((starter.result as { details: Record<string, Json> }).details.execution_id).toBe(
      starter.id,
    );
    f.release();
    const deadline = Date.now() + 5000;
    while ((await f.store.getExecution(original.id))?.status !== 'succeeded') {
      if (Date.now() > deadline) throw Error('original_command_completion_missing');
      await Bun.sleep(5);
    }
    expect(f.model.requests).toHaveLength(2);
    await f.submit('later');
    await f.runtime.waitForCommand('later', { timeoutMs: 5000 });
    const notification = f.model.requests[2]!.messages.find(
      (message) =>
        message.role === 'user' &&
        message.content.includes(handle) &&
        message.content.includes('command finished'),
    )!;
    expect(notification).toBeDefined();
    publicFeedback(notification.content);
    expect(notification.content).toContain('command finished');
    expect(notification.content).not.toContain('Completion has not been confirmed');
    expect(notification.content).toContain(handle);
    expect(notification.content).toContain('shell_read');
    const selected = await f.store.getModelContext({
      expectedStoreId: f.identity.expectedStoreId,
      sessionId: 's',
    });
    expect(notification.sourceIds).toHaveLength(1);
    const source = selected.resultSources.find((item) => item.id === notification.sourceIds?.[0]);
    expect(source).toMatchObject({
      executionId: original.id,
      originStoreId: f.identity.expectedStoreId,
    });
    expect(source?.result).toEqual((await f.store.getExecution(original.id))?.result);
    const reader = (await f.store.listExecutions('s')).find(
      (row) => row.definitionId === 'shell.read',
    )!;
    const readFeedback = f.model.requests[3]!.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'original-read',
    )!;
    expect(readFeedback.sourceIds).toEqual([reader.id]);
    expect(readFeedback.content).toContain(
      `execution_id: ${JSON.stringify(modelExecutionId(starter.id))}`,
    );
    expect(readFeedback.content).not.toContain(
      `execution_id: ${JSON.stringify(modelExecutionId(reader.id))}`,
    );
    publicFeedback(readFeedback.content);
    expect(readFeedback.content).toContain(stdout);
    expect(readFeedback.content).toContain(stderr);
    expect((await f.store.getExecution(starter.id))?.result).toEqual(originalStarterResult);
    expect((await f.store.listExecutions('s')).filter((row) => row.kind === 'job')).toHaveLength(1);
    expect(f.counts().starts).toBe(1);
  } finally {
    await f.close();
  }
}, 10000);

test('a same-name foreign tool keeps its opaque business payload without borrowing builtin Shell facts', async () => {
  const f = await fixture(
    [call('shell_execute', { command: 'printf original' }, 'foreign-call'), [finish]],
    { foreign: true },
  );
  try {
    await f.submit('work');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const rows = await f.store.listExecutions('s');
    const tool = rows.find((row) => row.kind === 'tool')!;
    const feedback = f.model.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(feedback).toMatchObject({ toolCallId: 'foreign-call', sourceIds: [tool.id] });
    expect(feedback.content).toBe(f.fakeBody);
    expect(feedback.content).not.toContain('user denied');
    expect(feedback.content).toContain(
      '"job":{"metadata":{"dispatch":"untrusted business payload"}}',
    );
    expect(rows.filter((row) => row.kind === 'job')).toHaveLength(1);
    expect(f.counts()).toEqual({ starts: 1, customCalls: 1 });
  } finally {
    await f.close();
  }
}, 10000);
