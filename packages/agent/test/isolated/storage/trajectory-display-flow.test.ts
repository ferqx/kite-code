import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFixedModel,
  type ModelAdapter,
  ModelAttemptError,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { projectTrajectory, type TrajectoryEvent } from '@kite-ai/trajectory';
import { createArtifactStore } from '../../../src/artifacts';
import type { JobDefinition, JobEvent } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import { createRuntime, type RuntimeOptions } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';
import { createShellExtension } from '../../../src/tools/shell';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function* call(name: string, input: unknown): Generator<ModelEvent> {
  yield { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) };
  yield { ...finish, type: 'finish', reason: 'tool_calls' };
}
const object = (value: Json | undefined) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
async function fixture(options: Omit<RuntimeOptions, 'store'>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-trajectory-display-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    ...options,
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'test',
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'display',
  });
  return {
    runtime,
    store,
    storeId,
    async start(content = '用户公开提示词') {
      await runtime.submitCommand({
        expectedStoreId: storeId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content },
      });
      await runtime.waitForCommand('work', { timeoutMs: 15000 });
    },
    async events() {
      const scope = { storeId, sessionId: 's', subjectId: 'owner' };
      const { upperCursor } = await store.openTrajectory(scope);
      let afterCursor = '0';
      const events: TrajectoryEvent[] = [];
      for (let pageNo = 0; pageNo < 30; pageNo++) {
        const page = await store.readTrajectoryEvents({ ...scope, upperCursor, afterCursor });
        events.push(...page.events);
        if (page.exhausted) return events;
        afterCursor = page.scannedThrough;
      }
      throw Error('pagination did not terminate');
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const permissions = { authorize: async () => ({ allowed: true, revision: 'actual' }) };

test('real Artifact-backed requests and metadata retain actual model identity/counts before sealing without indexing bodies', async () => {
  for (const largeMetadata of [false, true]) {
    const requests: ModelRequest[] = [];
    const model: ModelAdapter = {
      describeRequest() {
        return {
          adapterId: 'opaque-adapter',
          adapterVersion: '1',
          provider: {
            availability: 'available',
            family: 'fixture',
            modelId: 'actual-provider-model',
          },
          settings: { maxRetries: 0, maxSteps: 1, allowSystemInMessages: true },
          transformation: { id: 'fixture', version: '1' },
        };
      },
      async *stream(request) {
        requests.push(structuredClone(request));
        yield finish;
      },
    };
    const f = await fixture({
      model,
      modelId: 'model-opaque-adapter',
      permissions,
      sources: {
        async capture() {
          return [
            {
              id: 'large',
              kind: 'fixture',
              scope: 's',
              digest: '1',
              content: 'PRIVATE_SYSTEM_BODY'.repeat(6000),
            },
          ];
        },
      },
      ...(largeMetadata
        ? {
            extensions: [
              {
                id: 'fixture.large',
                version: '1',
                apiMajor: 1,
                tools: [
                  {
                    id: 'fixture.large',
                    version: '1',
                    description: 'PRIVATE_TOOL_CATALOGUE'.repeat(4000),
                    inputSchema: { type: 'object' },
                    model: { name: 'large_tool' },
                    async execute() {
                      throw Error('display reader must never dispatch');
                    },
                  },
                ],
              },
            ],
          }
        : {}),
    });
    try {
      await f.start();
      const events = await f.events();
      const event = events.filter((event) => event.kind === 'model').at(-1)!;
      if (event.kind !== 'model') throw Error('missing Model fact');
      const saved = await f.store.getModelInputSnapshot({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        executionId: event.executionId!,
      });
      expect(object(saved.input).body).toBeDefined();
      expect(object(saved.metadata ?? null).body).toBeDefined();
      const metadataBody = object(object(saved.metadata ?? null).body);
      const metadataBytes = BigInt(String(object(metadataBody.reference).size));
      expect(metadataBytes > 65536n).toBe(largeMetadata);
      const { outputPresence, ...inputDisplay } = event.attributes.display!;
      expect(inputDisplay as unknown).toEqual(object(saved.metadata ?? null).display);
      expect(outputPresence).toMatchObject({ hasText: false, toolCallCount: 0, complete: true });
      expect(event.attributes.display).toMatchObject({
        kind: 'model',
        modelName: 'actual-provider-model',
        requestContext: { tools: largeMetadata ? 1 : 0 },
      });

      expect(event.attributes.display?.requestContext?.systemMessages).toBe(
        requests[0]!.messages.filter((message) => message.role === 'system').length,
      );
      expect(event.attributes.display?.requestContext?.historyMessages).toBe(
        requests[0]!.messages.filter((message) => message.role !== 'system').length,
      );
      expect(JSON.stringify(event.attributes.display)).not.toContain('PRIVATE_');
      const ref = event.evidenceRefs.find((ref) => ref.kind === 'model_input')!;
      const before = await f.store.getMetadata();
      const evidence = await f.runtime.readTrajectoryEvidence({
        storeId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        upperCursor: events.at(-1)!.sequence,
        atCursor: event.sequence,
        eventId: event.eventId,
        evidenceId: ref.evidenceId,
        contentVersion: ref.contentVersion,
      });
      const body = JSON.parse(Buffer.from(evidence.content).toString());
      expect(body.request).toEqual(requests[0]!);
      expect(body.metadata.adapter.provider.modelId).toBe('actual-provider-model');
      expect(body.metadata).not.toHaveProperty('display');
      expect(await f.store.getMetadata()).toEqual(before);
      expect(requests).toHaveLength(1);
      const snapshotReader = f.store.getModelInputSnapshot.bind(f.store);
      try {
        const { display: _display, ...oldMetadata } = object(saved.metadata ?? null);
        f.store.getModelInputSnapshot = async () => ({ ...saved, metadata: oldMetadata });
        const target = {
          expectedStoreId: f.storeId,
          sessionId: 's',
          subjectId: 'owner',
          executionId: event.executionId!,
        };
        expect((await f.runtime.readModelInput(target)).request).toEqual(requests[0]!);
        f.store.getModelInputSnapshot = async () => ({
          ...saved,
          metadata: {
            ...object(saved.metadata ?? null),
            display: { ...object(object(saved.metadata ?? null).display), raw: 'PRIVATE' },
          },
        });
        const invalid = await f.runtime.readModelInput(target).then(
          () => null,
          (error: unknown) => error,
        );
        expect(invalid).toMatchObject({ code: 'model_snapshot_invalid' });
      } finally {
        f.store.getModelInputSnapshot = snapshotReader;
      }
      const logs = await f.store.getSessionLogs({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        afterCursor: '0',
      });
      expect(logs.entries.some((entry) => entry.modelExecutionId === event.executionId)).toBe(true);
    } finally {
      await f.close();
    }
  }
}, 30000);

test('real writer exposes bounded public user/reply snippets while exact full bodies remain Evidence', async () => {
  const model = createFixedModel([
    [
      { type: 'reasoning_delta', text: 'PRIVATE_REASONING' },
      { type: 'text_delta', text: '公开回复'.repeat(100) },
      finish,
    ],
  ]);
  const f = await fixture({ model, modelId: 'opaque', permissions });
  try {
    await f.start('公开问题'.repeat(100));
    const events = await f.events();
    const messages = events.filter((event) => event.kind === 'message');
    const input = messages.find(
      (event) => event.kind === 'message' && event.attributes.role === 'user',
    )!;
    const reply = [...messages]
      .reverse()
      .find((event) => event.kind === 'message' && event.attributes.role === 'assistant')!;
    for (const event of [input, reply]) {
      if (event.kind !== 'message') throw Error('expected public message');
      expect(event.attributes.display?.kind).toBe('message');
      expect(event.attributes.display?.summary?.length).toBeLessThanOrEqual(160);
      expect(event.attributes.display?.summary).toEndWith('…');
      expect(event.evidenceRefs.some((ref) => ref.kind === 'message')).toBe(true);
      const ref = event.evidenceRefs.find((value) => value.kind === 'message')!;
      const evidence = await f.runtime.readTrajectoryEvidence({
        storeId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        upperCursor: events.at(-1)!.sequence,
        atCursor: event.sequence,
        eventId: event.eventId,
        evidenceId: ref.evidenceId,
        contentVersion: ref.contentVersion,
      });
      const body = JSON.parse(Buffer.from(evidence.content).toString());
      expect(body.content).toBe(
        event.attributes.role === 'user' ? '公开问题'.repeat(100) : '公开回复'.repeat(100),
      );
    }
    expect(JSON.stringify(events)).not.toContain('PRIVATE_REASONING');
  } finally {
    await f.close();
  }
}, 20000);

test('real Runtime writer seals one Shell Job target for launch/read/wait and keeps timeout distinct from terminal outcome', async () => {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0,
    stage = 0,
    handle = '';
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'controlled Job',
    inputSchema: { type: 'object' },
    async start() {
      starts++;
      return { reference: {} };
    },
    async *observe(): AsyncIterable<JobEvent> {
      await done;
      yield {
        type: 'terminal',
        result: { outcome: 'succeeded', content: 'done', details: { exitCode: 0 } },
        supervision: 'ended',
      };
    },
    async cancel() {
      release();
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  let f!: Awaited<ReturnType<typeof fixture>>;
  const model: ModelAdapter = {
    describeRequest() {
      return {
        adapterId: 'fixture',
        adapterVersion: '1',
        provider: { availability: 'available', family: 'fixture', modelId: 'actual-model' },
        settings: { maxRetries: 0, maxSteps: 100, allowSystemInMessages: true },
        transformation: { id: 'fixture', version: '1' },
      };
    },
    async *stream(_request: ModelRequest) {
      if (stage > 0) {
        const starter = (await f.store.listExecutions('s')).find(
          (row) => row.definitionId === 'shell.execute',
        )!;
        handle = String(object(object(starter.result).details).shell_id);
      }
      switch (stage++) {
        case 0:
          yield* call('shell_execute', { command: 'echo PRIVATE_TOKEN', background: true });
          break;
        case 1:
          yield* call('shell_wait', { shell_id: handle, wait_ms: 0 });
          break;
        case 2:
          yield* call('shell_read', { shell_id: handle });
          break;
        case 3:
          release();
          yield* call('shell_wait', { shell_id: handle, wait_ms: 10000 });
          break;
        case 4:
          yield* call('shell_read', { shell_id: handle });
          break;
        default:
          yield finish;
      }
    },
  };
  f = await fixture({
    model,
    modelId: 'alias',
    permissions,
    extensions: [createShellExtension({ job })],
  });
  try {
    await f.start();
    const events = await f.events(),
      executions = await f.store.listExecutions('s');
    const target = executions.find((row) => row.kind === 'job')!,
      starter = executions.find((row) => row.definitionId === 'shell.execute')!;
    expect(starts).toBe(1);
    expect(target.parentExecutionId).toBe(starter.id);
    const shellFacts = events.filter(
      (event): event is Extract<TrajectoryEvent, { kind: 'tool' | 'job' }> =>
        (event.kind === 'tool' || event.kind === 'job') &&
        'display' in event.attributes &&
        event.attributes.display?.kind === 'shell',
    );
    const linked = shellFacts.filter(
      (event) => 'display' in event.attributes && event.attributes.display?.targetExecutionId,
    );
    expect(
      new Set(
        linked.map(
          (event) => 'display' in event.attributes && event.attributes.display?.targetExecutionId,
        ),
      ),
    ).toEqual(new Set([target.id]));
    expect(
      linked.every(
        (event) =>
          'display' in event.attributes &&
          event.attributes.display?.targetExecutionOriginStoreId === f.storeId,
      ),
    ).toBe(true);
    expect(
      linked.some(
        (event) =>
          'display' in event.attributes &&
          event.attributes.display?.operation === 'wait' &&
          event.attributes.display.timedOut === true &&
          event.attributes.display.observedStatus === 'running',
      ),
    ).toBe(true);
    expect(
      linked.some(
        (event) =>
          'display' in event.attributes &&
          event.attributes.display?.operation === 'read' &&
          event.attributes.display.observedStatus === 'succeeded' &&
          event.attributes.display.exitCode === 0,
      ),
    ).toBe(true);
    expect(
      linked.some(
        (event) =>
          'display' in event.attributes &&
          event.attributes.display?.accepted === true &&
          event.attributes.display.observedStatus === undefined,
      ),
    ).toBe(true);
    const metadata = events
      .filter((event) => 'display' in event.attributes)
      .map((event) => 'display' in event.attributes && event.attributes.display);
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE');
    expect(
      metadata.some(
        (display) =>
          display &&
          display.kind === 'model' &&
          display.modelName === 'actual-model' &&
          display.requestContext &&
          display.requestContext.tools > 0,
      ),
    ).toBe(true);
    const steps = projectTrajectory(events, { atCursor: events.at(-1)!.sequence }).steps;
    expect(steps.find((step) => step.executionId === target.id)).toMatchObject({
      parentExecutionId: starter.id,
      display: { kind: 'shell', targetExecutionId: target.id },
    });
  } finally {
    release();
    await f.close();
  }
}, 20000);

test('real child admission and observation preserve exact carrier/child identities without treating accepted as completed', async () => {
  let stage = 0,
    agentId = '',
    workRef = '';
  let f!: Awaited<ReturnType<typeof fixture>>;
  const model: ModelAdapter = {
    async *stream() {
      if (stage > 0) {
        const spawn = (await f.store.listExecutions('s')).find(
          (row) => row.definitionId === 'task.spawn',
        )!;
        const receipt = object(object(spawn.result).details);
        agentId = String(receipt.agent_id);
        workRef = String(receipt.work_ref);
      }
      switch (stage++) {
        case 0:
          yield* call('spawn_agent', { prompt: 'PRIVATE delegated prompt', task_name: '回归检查' });
          break;
        case 1:
          yield* call('wait_agent_events', { work_refs: [workRef], wait_ms: 0 });
          break;
        case 2:
          yield* call('send_agent_message', { agent_id: agentId, content: 'PRIVATE message' });
          break;
        default:
          yield finish;
      }
    },
  };
  f = await fixture({
    model,
    modelId: 'parent',
    modelConcurrency: 2,
    permissions,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'Worker' }],
      }),
    ],
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        model: createFixedModel([[finish]]),
        modelId: 'child',
        toolIds: [],
        snapshot: {},
      },
    ],
  });
  try {
    await f.start();
    const events = await f.events(),
      executions = await f.store.listExecutions('s');
    const carrier = executions.find((row) => row.kind === 'job' && row.childSessionId === agentId)!;
    expect(carrier).toBeDefined();
    expect(executions.find((row) => row.definitionId === 'task.message')?.result).toMatchObject({
      outcome: 'succeeded',
    });
    const spawn = [...events]
      .reverse()
      .find((event) => event.kind === 'tool' && event.attributes.display?.operation === 'spawn');
    expect(spawn).toMatchObject({
      attributes: {
        display: {
          kind: 'task',
          summary: '回归检查',
          accepted: true,
          targetExecutionId: carrier.id,
          targetExecutionOriginStoreId: f.storeId,
          targetSessionId: agentId,
        },
      },
    });
    expect(spawn && 'display' in spawn.attributes && spawn.attributes.display).not.toHaveProperty(
      'observedStatus',
    );
    expect(
      events.some(
        (event) =>
          event.kind === 'tool' &&
          event.attributes.display?.operation === 'events' &&
          event.attributes.display.targetExecutionId === carrier.id,
      ),
    ).toBe(true);
    const message = [...events]
      .reverse()
      .find((event) => event.kind === 'tool' && event.attributes.display?.operation === 'message');
    expect(message).toMatchObject({
      attributes: { display: { kind: 'task', targetSessionId: agentId } },
    });
    expect(
      message && 'display' in message.attributes && message.attributes.display,
    ).not.toHaveProperty('targetExecutionId');
    expect(
      JSON.stringify(
        events.map((event) => 'display' in event.attributes && event.attributes.display),
      ),
    ).not.toContain('PRIVATE');
  } finally {
    await f.close();
  }
}, 20000);

test('original Model and assistant Message facts seal exact output presence before material reads for inline and Artifact outputs', async () => {
  for (const mode of ['tool_only', 'text_and_tool', 'large_text', 'large_call'] as const) {
    let requests = 0;
    const text =
      mode === 'large_text'
        ? 'ORIGINAL_TEXT'.repeat(7000)
        : mode === 'text_and_tool'
          ? 'Original explanation'
          : '';
    const model: ModelAdapter = {
      async *stream() {
        if (++requests === 1) {
          if (text) yield { type: 'text_delta', text };
          yield* call('presence_tool', {
            payload: mode === 'large_call' ? 'PRIVATE_ARGUMENT'.repeat(6000) : 'ok',
          });
        } else {
          yield { type: 'text_delta', text: 'Final normal reply' };
          yield finish;
        }
      },
    };
    const f = await fixture({
      model,
      permissions,
      extensions: [
        {
          id: 'presence',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'presence.tool',
              version: '1',
              description: 'fixture',
              model: { name: 'presence_tool' },
              inputSchema: {
                type: 'object',
                properties: { payload: { type: 'string' } },
                required: ['payload'],
                additionalProperties: false,
              },
              async execute() {
                return { outcome: 'succeeded', content: 'tool finished' };
              },
            },
          ],
        },
      ],
    });
    try {
      await f.start();
      const events = await f.events();
      const models = events.filter(
        (event) => event.kind === 'model' && event.phase === 'completed',
      );
      const first = models.find((event) => event.executionId === models[0]!.executionId)!;
      expect(first).toBeDefined();
      const saved = await f.store.getModelOutputSnapshot({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        executionId: first.executionId!,
      });
      expect(Boolean(saved.output)).toBe(mode === 'large_text' || mode === 'large_call');
      if (saved.output) {
        expect(saved.toolCalls).toEqual([]);
        expect(saved.output.toolCallCount).toBe(1);
        expect(saved.output.contentBytes === '0').toBe(text === '');
      }
      for (const event of events.filter(
        (event) =>
          event.executionId === first.executionId &&
          ((event.kind === 'model' && event.phase === 'completed') ||
            (event.kind === 'message' &&
              event.attributes.role === 'assistant' &&
              event.attributes.status === 'complete')),
      )) {
        if (event.kind !== 'model' && event.kind !== 'message') throw Error('wrong fact');
        const ref = event.evidenceRefs.find(
          (ref) => ref.kind === (event.kind === 'model' ? 'model_output' : 'message'),
        )!;
        expect(event.attributes.display?.outputPresence).toEqual({
          hasText: text.length > 0,
          toolCallCount: 1,
          complete: true,
          evidenceId: ref.evidenceId,
          contentVersion: ref.contentVersion,
        });
        expect(JSON.stringify(event.attributes.display?.outputPresence)).not.toContain(
          'PRIVATE_ARGUMENT',
        );
      }
      const final = models.at(-1)!;
      if (final.kind !== 'model') throw Error('wrong final fact');
      expect(final.executionId).not.toBe(first.executionId);
      expect(final.attributes.display?.outputPresence).toMatchObject({
        hasText: true,
        toolCallCount: 0,
        complete: true,
      });
    } finally {
      await f.close();
    }
  }
});

test('original Artifact checkpoints remain incomplete and bound to their own revision across success, failure, cancellation and retry', async () => {
  for (const mode of ['success', 'failed', 'cancelled', 'retry'] as const) {
    let ready!: () => void,
      release!: () => void,
      requests = 0;
    const checkpoint = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      permissions,
      model: {
        async *stream(_request, { signal }) {
          if (++requests === 1) {
            yield {
              type: 'tool_call',
              id: 'large-call',
              name: 'presence_tool',
              arguments: JSON.stringify({ payload: 'PRIVATE_CALL'.repeat(7000) }),
            };
            ready();
            if (mode === 'cancelled')
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', () => resolve(), { once: true });
              });
            else await gate;
            signal.throwIfAborted();
            if (mode === 'failed') throw Error('fixture provider failed after checkpoint');
            if (mode === 'retry') throw new ModelAttemptError('connection_failed');
            yield { ...finish, reason: 'tool_calls' };
          } else {
            yield { type: 'text_delta', text: 'Final' };
            yield finish;
          }
        },
      },
      extensions: [
        {
          id: 'presence',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'presence.tool',
              version: '1',
              description: 'fixture',
              model: { name: 'presence_tool' },
              inputSchema: {
                type: 'object',
                properties: { payload: { type: 'string' } },
                required: ['payload'],
                additionalProperties: false,
              },
              async execute() {
                return { outcome: 'succeeded', content: 'done' };
              },
            },
          ],
        },
      ],
    });
    let started: Promise<void> | undefined;
    try {
      started = f.start();
      await checkpoint;
      const before = await f.events();
      const model = before.filter((event) => event.kind === 'model').at(-1)!;
      const message = before
        .filter((event) => event.kind === 'message' && event.attributes.role === 'assistant')
        .at(-1)!;
      expect(model).toBeDefined();
      expect(message).toBeDefined();
      if (model.kind !== 'model') throw Error('wrong Model');
      // Streaming checkpoints belong to Message observations. Older Model facts
      // cannot gain output metadata before their own next original observation.
      expect(model.attributes.display?.outputPresence).toBeUndefined();
      for (const event of [message]) {
        if (event.kind !== 'model' && event.kind !== 'message') throw Error('wrong fact');
        const ref = event.evidenceRefs.find(
          (ref) => ref.kind === (event.kind === 'model' ? 'model_output' : 'message'),
        )!;
        expect(ref.availability).toBe('partial');
        expect(event.attributes.display?.outputPresence).toEqual({
          hasText: false,
          toolCallCount: 1,
          complete: false,
          evidenceId: ref.evidenceId,
          contentVersion: ref.contentVersion,
        });
      }
      const original = structuredClone([model, message]);
      if (mode === 'cancelled')
        await f.runtime.cancelCommand({
          expectedStoreId: f.storeId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'cancel',
          targetCommandId: 'work',
        });
      release();
      await started;
      const later = await f.events();
      const final = later
        .filter((event) => event.kind === 'model' && event.executionId === model.executionId)
        .at(-1)!;
      if (final.kind !== 'model') throw Error('wrong final fact');
      expect(final.phase).toBe(
        mode === 'success' ? 'completed' : mode === 'cancelled' ? 'cancelled' : 'failed',
      );
      expect(final.attributes.display?.outputPresence).toMatchObject({
        hasText: false,
        toolCallCount: 1,
        complete: mode === 'success',
      });
      if (mode === 'retry') {
        const retried = later
          .filter((event) => event.kind === 'model' && event.executionId !== model.executionId)
          .at(-1)!;
        if (retried.kind !== 'model') throw Error('missing retry');
        expect(retried.attributes.previousExecutionId).toBe(model.executionId);
        expect(retried.attributes.display?.outputPresence).toMatchObject({
          hasText: true,
          toolCallCount: 0,
          complete: true,
        });
        expect(retried.attributes.display?.outputPresence?.evidenceId).not.toBe(
          final.attributes.display?.outputPresence?.evidenceId,
        );
      }
      expect([model, message]).toEqual(original);
      expect(
        later.filter((event) => [model.eventId, message.eventId].includes(event.eventId)),
      ).toEqual(original);
      expect(final.attributes.display?.outputPresence?.contentVersion).not.toBe(
        message.evidenceRefs.find((ref) => ref.kind === 'message')!.contentVersion,
      );
    } finally {
      release();
      await started?.catch(() => {});
      await f.close();
    }
  }
});
