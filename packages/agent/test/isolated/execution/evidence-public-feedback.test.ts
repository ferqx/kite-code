import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { createExecutionEvidenceExtension } from '../../../src/business/execution-evidence';
import type { Extension, JobDefinition, JobEvent, Json } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import { modelExecutionId } from '../../../src/model-identifier';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { createShellExtension } from '../../../src/tools/shell';

const stdout = '原始业务🪁\r\n{"job":"订单","metadata":{"dispatch":"原值"}}\n';
const stderr = '诊断：退出17；保留原文。\n';
const finish = {
  type: 'finish' as const,
  reason: 'stop' as const,
  usage: { inputTokens: 1, outputTokens: 1 },
};

async function fixture(mode: 'builtin' | 'wrong-scope' | 'foreign-owner') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-evidence-public-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let starts = 0;
  let opaque = '';
  const requests: ModelRequest[] = [];
  const originalReads: string[] = [];
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Controlled nonzero original command',
    inputSchema: { type: 'object' },
    async start() {
      starts++;
      return { reference: { original: true } };
    },
    async *observe(): AsyncIterable<JobEvent> {
      yield { type: 'output', stream: 'stdout', content: stdout };
      yield { type: 'output', stream: 'stderr', content: stderr };
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: 'failed',
          content: 'Shell failed',
          details: { exitCode: 17, processTreeStopped: true },
        },
      };
    },
    async cancel() {
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const evidence = createExecutionEvidenceExtension({
    async read(request) {
      originalReads.push(request.executionId!);
      const original = await store.getExecution(request.executionId!);
      if (!original) throw Error('fixture_original_missing');
      return {
        items: [
          { execution: original, taskRunId: mode === 'wrong-scope' ? 'foreign' : request.runId },
        ],
        nextCursor: null,
      };
    },
  });
  const reader: Extension =
    mode === 'foreign-owner'
      ? {
          ...evidence,
          id: 'fixture.foreign-evidence',
          tools: evidence.tools!.map((tool) => ({
            ...tool,
            async execute(input, context) {
              const result = await tool.execute(input, context);
              opaque = result.content;
              return result;
            },
          })),
        }
      : evidence;
  const model: ModelAdapter = {
    async *stream(request) {
      const index = requests.length;
      requests.push(request);
      if (index === 0) {
        yield {
          type: 'tool_call',
          id: 'original-shell',
          name: 'shell_execute',
          arguments: '{"command":"controlled exit 17"}',
        };
        yield { ...finish, reason: 'tool_calls' };
      } else if (index <= (mode === 'builtin' ? 2 : 1)) {
        const rows = await store.listExecutions('s');
        const original = rows.find(
          (row) => row.definitionId === (index === 1 ? 'shell.command' : 'shell.execute'),
        )!;
        yield {
          type: 'tool_call',
          id: `evidence-${index}`,
          name: 'read_execution_evidence',
          arguments: JSON.stringify({ execution_id: original.id }),
        };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'Report the original failure without restarting it.' };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'controlled',
    extensions: [createShellExtension({ job }), reader],
    permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
  });
  return {
    store,
    requests,
    originalReads,
    counts: () => starts,
    opaque: () => opaque,
    async run() {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'test',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'create',
        workspaceId: 'w',
        title: 'evidence',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Inspect this command failure using its original evidence. Do not restart it.',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('exact original Shell evidence reaches the next model as public feedback without replay or business-byte loss', async () => {
  const f = await fixture('builtin');
  try {
    await f.run();
    const rows = await f.store.listExecutions('s');
    const shell = rows.find((row) => row.definitionId === 'shell.execute')!;
    const original = rows.find((row) => row.definitionId === 'shell.command')!;
    const saved = structuredClone(shell.result);
    expect(original.result).toMatchObject({
      outcome: 'failed',
      details: { exitCode: 17, processTreeStopped: true },
    });
    const raw = JSON.parse((shell.result as { content: string }).content);
    expect(raw.stdout).toBe(stdout);
    expect(raw.stderr).toBe(stderr);
    expect(raw.execution.id).toBe(original.id);
    expect(raw).toEqual((shell.result as { details: unknown }).details);
    expect(original.parentExecutionId).toBe(shell.id);
    const first = f.requests[1]!.messages.find(
      (message) => message.toolCallId === 'original-shell',
    )!;
    expect(first.sourceIds).toEqual([shell.id]);
    expect(first.content).toContain(stdout);
    expect(first.content).toContain(stderr);
    expect(f.originalReads).toEqual([original.id, shell.id]);
    for (const index of [1, 2]) {
      const read = rows.find((row) => row.callId === `evidence-${index}`)!;
      const next = f.requests[index + 1]!.messages.find(
        (message) => message.toolCallId === read.callId,
      )!;
      expect(next.sourceIds).toEqual([read.id]);
      const detail = JSON.parse(next.content);
      expect(detail.items).toHaveLength(1);
      expect(detail.items[0].execution_id).toBe(
        modelExecutionId(index === 1 ? original.id : shell.id),
      );
      expect(detail.items[0].result).toContain('The command failed.');
      expect(detail.items[0].result).toContain('Exit code: 17');
      expect(detail.items[0].result).not.toContain('produced no effects');
      for (const internal of [
        'originStoreId',
        'parentExecutionId',
        'definitionVersion',
        'input_digest',
        'task_run_id',
      ])
        expect(next.content).not.toContain(internal);
      expect(JSON.parse((read.result as { content: string }).content).items[0].result).toEqual(
        index === 1 ? original.result : shell.result,
      );
      expect(detail.items[0].result).toContain(stdout);
      expect(detail.items[0].result).toContain(stderr);
    }
    expect((await f.store.getExecution(shell.id))?.result).toEqual(saved);
    expect(f.counts()).toBe(1);
    expect(rows.filter((row) => row.kind === 'job')).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 10000);

for (const mode of ['wrong-scope', 'foreign-owner'] as const)
  test(`execution evidence does not borrow builtin projection for ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      await f.run();
      const rows = await f.store.listExecutions('s');
      const read = rows.find((row) => row.definitionId === 'execution_evidence.read')!;
      const next = f.requests[2]!.messages.find((message) => message.toolCallId === 'evidence-1')!;
      expect(next.sourceIds).toEqual([read.id]);
      if (mode === 'wrong-scope') {
        expect(read.status).toBe('failed');
        expect(next.content).toContain('current task scope');
        expect(next.content).not.toContain('Exit code: 17');
        expect(next.content).not.toContain(stdout);
      } else {
        expect(read.status).toBe('succeeded');
        expect(next.content).toBe(f.opaque());
        expect(JSON.parse(next.content).items[0].result).toMatchObject({
          outcome: 'failed',
          content: 'Shell failed',
          details: { exitCode: 17 },
        });
        expect(next.content).not.toContain('The command failed.');
      }
      expect(f.counts()).toBe(1);
      expect(rows.filter((row) => row.kind === 'job')).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 10000);

test('evidence recovery preserves the complete unknown child evidence instead of only its report', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-evidence-unknown-child-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const qualification = {
    futureQualification: 'Partial history; retain these observations and diagnostics.',
  };
  const finishExecution = store.finishExecution.bind(store);
  store.finishExecution = async (input) => {
    const execution = await store.getExecution(input.executionId);
    const result = input.result;
    if (
      execution?.childSessionId &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result)
    ) {
      const details = result.details as Record<string, Json>;
      input = {
        ...input,
        result: {
          ...result,
          details: {
            ...details,
            evidence: { ...(details.evidence as Record<string, Json>), ...qualification },
          },
        },
      };
    }
    return finishExecution(input);
  };
  let starts = 0;
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'One original failed command',
    inputSchema: { type: 'object' },
    async start() {
      starts++;
      return { reference: { original: true } };
    },
    async *observe(): AsyncIterable<JobEvent> {
      yield { type: 'output', stream: 'stdout', content: stdout };
      yield { type: 'output', stream: 'stderr', content: stderr };
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: 'failed',
          content: 'Shell failed',
          details: { exitCode: 17, processTreeStopped: true },
        },
      };
    },
    async cancel() {
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const child = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'child-command',
        name: 'shell_execute',
        arguments: '{"command":"controlled exit 17"}',
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [
      { type: 'text_delta', text: 'The original command failed with exit 17; do not repeat it.' },
      finish,
    ],
  ]);
  const requests: ModelRequest[] = [];
  let spawned = false;
  let requestedDetail = false;
  let cursor: string | undefined;
  let originalId = '';
  const evidence = createExecutionEvidenceExtension({
    async read(request) {
      return {
        items: [
          {
            execution: (await store.getExecution(request.executionId!))!,
            taskRunId: request.runId,
          },
        ],
        nextCursor: null,
      };
    },
  });
  const model: ModelAdapter = {
    async *stream(request) {
      requests.push(request);
      if (!spawned) {
        spawned = true;
        yield {
          type: 'tool_call',
          id: 'spawn-original',
          name: 'spawn_agent',
          arguments: '{"prompt":"Run the controlled command once and report its actual result."}',
        };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      if (requestedDetail) {
        yield finish;
        return;
      }
      const carrier = (await store.listExecutions('s')).find((record) => record.childSessionId);
      if (carrier?.status === 'succeeded') {
        originalId = carrier.id;
        expect(
          request.messages.some((message) =>
            message.content.includes(qualification.futureQualification),
          ),
        ).toBe(true);
        requestedDetail = true;
        yield {
          type: 'tool_call',
          id: 'recover-unknown-child',
          name: 'read_execution_evidence',
          arguments: JSON.stringify({ execution_id: carrier.id }),
        };
      } else {
        const observed = request.messages.filter((message) => message.role === 'tool').at(-1);
        if (observed?.toolCallId?.startsWith('wait-'))
          cursor = JSON.parse(observed.content).next_cursor;
        yield {
          type: 'tool_call',
          id: `wait-${requests.length}`,
          name: 'wait_agent_events',
          arguments: JSON.stringify({ ...(cursor ? { cursor } : {}), wait_ms: 10000 }),
        };
      }
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'parent',
    modelConcurrency: 2,
    permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
    extensions: [
      createShellExtension({ job }),
      evidence,
      createTaskExtension({
        roles: [
          { id: 'worker', configurationId: 'worker', description: 'Run exactly one command.' },
        ],
      }),
    ],
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['shell.execute'],
        snapshot: {},
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'test',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'create',
      workspaceId: 'w',
      title: 'unknown child evidence',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'work',
      request: {
        kind: 'run.start',
        content: 'Delegate once, then inspect the original child receipt.',
      },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const original = (await store.getExecution(originalId))!;
    const raw = structuredClone(original.result);
    const message = requests
      .flatMap((request) => request.messages)
      .find((entry) => entry.toolCallId === 'recover-unknown-child')!;
    const recovered = JSON.parse(message.content);
    expect(recovered.items[0].execution_id).toBe(modelExecutionId(originalId));
    expect(JSON.parse(recovered.items[0].result)).toEqual(raw);
    expect(recovered.items[0].result).toContain(qualification.futureQualification);
    const restored = JSON.parse(recovered.items[0].result);
    expect(restored.details.evidence.shellReceipts[0].stdout.text).toBe(stdout);
    expect(restored.details.evidence.shellReceipts[0].stderr.text).toBe(stderr);
    const reader = (await store.listExecutions('s')).find(
      (record) => record.callId === 'recover-unknown-child',
    )!;
    expect(message.sourceIds).toEqual([reader.id]);
    expect((await store.getExecution(originalId))!.result).toEqual(raw);
    expect((await store.getView('s')).runs[0]!.status).toBe('completed');
    expect(starts).toBe(1);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

for (const mode of ['complete', 'missing', 'corrupt', 'cancel'] as const)
  test(`evidence recovery after compaction ${mode === 'complete' ? 'reads the complete original body' : mode === 'cancel' ? 'cancels its original nested body read' : `fails closed for a ${mode} original body`}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-evidence-body-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const artifacts = createArtifactStore({ profile, store });
    const body = 'Original evidence: 雪🪁\r\n{"job":"business data"}\n';
    const requests: ModelRequest[] = [];
    let originalCalls = 0;
    let detailReads = 0;
    let compressed = false;
    let originalId = '';
    let originalResult: Json = null;
    let nestedReadSignal: AbortSignal | undefined;
    let readAborted = false;
    let readEntered!: () => void;
    let releaseRead: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      readEntered = resolve;
    });
    if (mode === 'cancel') {
      const read = artifacts.readReference!.bind(artifacts);
      artifacts.readReference = async (input) => {
        if (detailReads === 1 && input.reference.scope.id === originalId) {
          nestedReadSignal = input.signal;
          return new Promise<never>((_resolve, reject) => {
            const abort = () => {
              readAborted = true;
              reject(input.signal!.reason);
            };
            releaseRead = () => {
              input.signal?.removeEventListener('abort', abort);
              reject(new Error('fixture_nested_read_released'));
            };
            input.signal?.addEventListener('abort', abort, { once: true });
            if (input.signal?.aborted) abort();
            readEntered();
          });
        }
        return read(input);
      };
    }
    const evidence = createExecutionEvidenceExtension({
      async read(request) {
        detailReads++;
        const original = await store.getExecution(request.executionId!);
        expect(original!.id).toBe(originalId);
        expect(original!.result).toEqual(originalResult);
        const result = original!.result as {
          modelContent: { reference: { id: string; scope: { kind: 'execution'; id: string } } };
        };
        const reference = await store.getArtifactReference({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          refId: result.modelContent.reference.id,
          scope: result.modelContent.reference.scope,
        });
        const path = artifactPath(join(profile.dataRoot, profile.profile), reference!.hash);
        expect(readFileSync(path, 'utf8')).toBe(body);
        if (mode === 'missing') unlinkSync(path);
        if (mode === 'corrupt') {
          chmodSync(path, 0o600);
          writeFileSync(path, body.replace('Original', 'Modified'));
        }
        return { items: [{ execution: original!, taskRunId: request.runId }], nextCursor: null };
      },
    });
    const model: ModelAdapter = {
      async *stream(request) {
        if (request.messages.some((message) => message.content === 'SUMMARIZE_BODY_FIXTURE')) {
          yield {
            type: 'text_delta',
            text: 'The original observation is saved; retrieve its receipt when needed.',
          };
          yield finish;
          return;
        }
        const index = requests.length;
        requests.push(request);
        if (index === 0) {
          yield { type: 'tool_call', id: 'original-read', name: 'fixture.read', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else if (index === 1) {
          expect(compressed).toBe(true);
          expect(request.messages.some((message) => message.toolCallId === 'original-read')).toBe(
            false,
          );
          const original = (await store.listExecutions('s')).find(
            (record) => record.definitionId === 'fixture.read',
          )!;
          originalId = original.id;
          originalResult = structuredClone(original.result);
          yield {
            type: 'tool_call',
            id: 'recover-original',
            name: 'read_execution_evidence',
            arguments: JSON.stringify({ execution_id: original.id }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield {
            type: 'text_delta',
            text: 'Recovered the original complete evidence without repeating it.',
          };
          yield finish;
        }
      },
    };
    const runtime = createRuntime({
      store,
      artifacts,
      model,
      modelId: 'controlled',
      permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
      compressor: {
        id: 'fixture.body',
        version: '1',
        async shouldCompress() {
          return originalCalls === 1 && !compressed;
        },
        async prepare() {
          compressed = true;
          return { instructions: 'SUMMARIZE_BODY_FIXTURE', snapshot: {} };
        },
      },
      extensions: [
        evidence,
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.read',
              version: '1',
              description: 'Read original evidence once',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                originalCalls++;
                const reference = await context.artifacts!.publish({
                  key: 'original',
                  content: Buffer.from(body),
                  mediaType: 'text/plain',
                });
                return {
                  outcome: 'succeeded',
                  content: 'Complete evidence is stored.',
                  details: {
                    futureQualification: 'Preserve this original metadata.',
                    business: { job: '订单' },
                  },
                  artifactRefs: [reference],
                  modelContent: { kind: 'artifact', encoding: 'utf-8', reference },
                };
              },
            },
          ],
        },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'test',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'create',
        workspaceId: 'w',
        title: 'recover evidence',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Read once, then recover the original evidence after compaction.',
        },
      });
      const done = runtime.waitForCommand('work', { timeoutMs: 5000 });
      if (mode === 'cancel') {
        await Promise.race([
          reading,
          done.then(() => {
            throw new Error('fixture_nested_read_did_not_start');
          }),
        ]);
        expect(nestedReadSignal).toBeDefined();
        expect(nestedReadSignal!.aborted).toBe(false);
        await runtime.cancelCommand({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'cancel-recovery',
          targetCommandId: 'work',
        });
      }
      await done;
      const view = await store.getView('s');
      const reader = (await store.listExecutions('s')).find(
        (record) => record.callId === 'recover-original',
      )!;
      expect(reader.status).toBe('succeeded');
      expect(JSON.parse((reader.result as { content: string }).content).items[0].result).toEqual(
        originalResult,
      );
      expect(view.runs[0]!.status).toBe(
        mode === 'complete' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed',
      );
      expect(requests).toHaveLength(mode === 'complete' ? 3 : 2);
      if (mode === 'cancel') {
        expect(readAborted).toBe(true);
        expect(nestedReadSignal!.aborted).toBe(true);
        expect((await store.getCommand('work'))!.cancelRequestedAt).not.toBeNull();
      }
      if (mode === 'complete') {
        const recovered = requests[2]!.messages.find(
          (message) => message.toolCallId === 'recover-original',
        )!;
        const restored: string = JSON.parse(recovered.content).items[0].result;
        expect(restored).toContain(JSON.stringify(originalResult));
        expect(restored.split('Complete artifact body:\n')[1]).toBe(body);
      }
      expect((await store.getExecution(originalId))!.result).toEqual(originalResult);
      expect(originalCalls).toBe(1);
      expect(detailReads).toBe(1);
    } finally {
      releaseRead?.();
      await runtime.close();
      await artifacts.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
