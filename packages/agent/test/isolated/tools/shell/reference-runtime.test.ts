import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import type { JobDefinition, JobEvent } from '../../../../src/extensions';
import { openSqliteStore } from '../../../../src/sqlite';
import { createShellExtension } from '../../../../src/tools/shell';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function calls(...items: [string, Record<string, unknown>][]): ModelEvent[] {
  return [
    ...items.map(([name, input], index) => ({
      type: 'tool_call' as const,
      id: `call-${index}`,
      name,
      arguments: JSON.stringify(input),
    })),
    { ...finish, reason: 'tool_calls' },
  ];
}
function shellHandle(request: ModelRequest): number {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== 'tool') continue;
    try {
      const result = JSON.parse(message.content);
      if (Number.isSafeInteger(result.session_id)) return result.session_id;
    } catch {}
  }
  throw Error('shell_session_missing_from_actual_model_feedback');
}
async function fixture(
  responses: ModelEvent[][],
  startFailure = false,
  gates?: { job: Promise<void>; beforeModel: (index: number) => Promise<void> },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-reference-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const model = createFixedModel(responses);
  let starts = 0,
    cancels = 0,
    probes = 0;
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'controlled original Job',
    inputSchema: { type: 'object' },
    async start() {
      starts++;
      appendFileSync(join(root, 'effects'), 'start\n');
      return { reference: { original: true } };
    },
    async *observe(): AsyncIterable<JobEvent> {
      if (gates) await gates.job;
      yield {
        type: 'terminal',
        result: startFailure
          ? {
              outcome: 'outcome_unknown',
              content: 'effect result unavailable after confirmed process exit',
            }
          : { outcome: 'succeeded', content: 'original result' },
        supervision: 'ended',
      };
    },
    async cancel() {
      cancels++;
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const runtime = createRuntime({
    store,
    model: {
      async *stream(request, options) {
        const index = model.requests.length;
        if (gates) await gates.beforeModel(index);
        responses[index] = (responses[index] ?? []).map((event) => {
          if (event.type !== 'tool_call') return event;
          const input = JSON.parse(event.arguments);
          if (input.session_id === 'original-shell') input.session_id = shellHandle(request);
          return { ...event, arguments: JSON.stringify(input) };
        });
        yield* model.stream(request, options);
      },
    },
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
    extensions: [
      createShellExtension({ job }),
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.read',
            version: '1',
            description: 'independent read',
            inputSchema: { type: 'object' },
            async execute() {
              probes++;
              return { outcome: 'succeeded', content: 'independent read completed' };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'test',
    expectedStoreId,
  });
  await runtime.createSession({
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'test',
    subjectId: 'owner',
    expectedStoreId,
  });
  const run = async () => {
    await runtime.submitCommand({
      commandId: 'original',
      sessionId: 's',
      subjectId: 'owner',
      expectedStoreId,
      request: { kind: 'run.start', content: 'inspect the exact original Shell' },
    });
    await runtime.waitForCommand('original');
    return runtime.getView('s');
  };
  return {
    root,
    store,
    model,
    runtime,
    run,
    counts: () => ({ starts, cancels, probes }),
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const [tool, definitionId] of [
  ['poll_command', 'shell.read'],
  ['terminate_session', 'shell.stop'],
] as const)
  test(`${tool} missing reference remains a correctable failure in the actual Loop`, async () => {
    const input = {
      session_id: 998,
    };
    const f = await fixture([
      calls([tool, input], ['fixture.read', {}]),
      [
        { type: 'text_delta', text: 'Reference unavailable; independent inspection completed.' },
        finish,
      ],
    ]);
    try {
      const view = await f.run();
      expect(view.runs[0]!.status).toBe('completed');
      const failed = view.executions.find((e) => e.definitionId === definitionId)!;
      expect(failed.status).toBe('failed');
      expect(failed.result).toMatchObject({
        outcome: 'failed',
        details: { code: 'shell_reference_not_found', shellId: 998 },
      });
      expect(view.executions.find((e) => e.definitionId === 'fixture.read')!.status).toBe(
        'succeeded',
      );
      expect(f.model.requests).toHaveLength(2);
      const feedback = f.model.requests[1]!.messages.find(
        (m) => m.role === 'tool' && m.content.includes('998'),
      )!;
      expect(feedback.content).toContain('did not start or stop');
      expect(feedback.content).toContain('exec_command');
      expect(f.counts()).toEqual({ starts: 0, cancels: 0, probes: 1 });
    } finally {
      await f.close();
    }
  });

test('wrong reference does not alter or restart an existing original Job', async () => {
  const f = await fixture([
    calls(['exec_command', { cmd: 'controlled command' }]),
    calls(['poll_command', { session_id: 997 }], ['terminate_session', { session_id: 997 }]),
    calls(['poll_command', { session_id: 'original-shell' }]),
    [finish],
  ]);
  try {
    const view = await f.run();
    expect(view.runs[0]!.status).toBe('completed');
    const jobs = view.executions.filter((e) => e.kind === 'job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('succeeded');
    expect(jobs[0]!.result).toMatchObject({ content: 'original result' });
    expect(f.counts()).toEqual({ starts: 1, cancels: 0, probes: 0 });
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('start\n');
    const read = view.executions.find(
      (execution) => execution.definitionId === 'shell.read' && execution.status === 'succeeded',
    )!;
    const saved = read.result as { details: { ref: { executionId: string; key: string } } };
    expect(saved.details.ref.executionId).toBe(jobs[0]!.id);
    const feedback = f.model.requests
      .at(-1)!
      .messages.find((message) => message.sourceIds?.includes(read.id))!;
    expect(feedback.toolCallId).toBe(read.callId);
    expect(feedback.sourceIds).toEqual([read.id]);
    expect(JSON.parse(feedback.content)).toMatchObject({
      session_id: 1,
      status: 'succeeded',
      terminal: true,
    });
  } finally {
    await f.close();
  }
});

test('the directory proves a numeric Shell handoff from the exact saved starter and keeps its Job identity through exit', async () => {
  const reachedHandoff = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  const releaseJob = Promise.withResolvers<void>();
  const f = await fixture(
    [
      calls(['exec_command', { cmd: 'controlled command', yield_time_ms: 0 }]),
      calls(['poll_command', { session_id: 'original-shell' }]),
      [finish],
    ],
    false,
    {
      job: releaseJob.promise,
      async beforeModel(index) {
        if (index === 1) {
          reachedHandoff.resolve();
          await releaseModel.promise;
        }
      },
    },
  );
  const run = f.run();
  try {
    await Promise.race([
      reachedHandoff.promise,
      run.then(() => {
        throw Error('handoff_missing');
      }),
    ]);
    const expectedStoreId = (await f.store.getMetadata()).storeId;
    const scope = { expectedStoreId, rootSessionId: 's', subjectId: 'owner' };
    const first = (await f.store.listBackgroundExecutions({ ...scope, includeSourceTool: true }))
      .items[0]!;
    expect(first.sourceTool).toEqual({
      id: first.execution.parentExecutionId!,
      definitionId: 'shell.execute',
      definitionVersion: '1',
      continued: true,
    });
    expect(['planned', 'dispatching', 'running']).toContain(first.execution.status);
    expect((await f.store.listBackgroundExecutions(scope)).items[0]?.sourceTool).toBeUndefined();
    releaseJob.resolve();
    releaseModel.resolve();
    const view = await run;
    const final = (await f.store.listBackgroundExecutions({ ...scope, includeSourceTool: true }))
      .items[0]!;
    expect(final.execution.id).toBe(first.execution.id);
    expect(final.execution.status).toBe('succeeded');
    expect(final.sourceTool).toEqual(first.sourceTool!);
    expect(
      view.executions.find((entry) => entry.definitionId === 'shell.read')?.result,
    ).toMatchObject({ details: { outputStart: { afterSeq: '0', offset: 0 } } });
    expect(f.counts()).toEqual({ starts: 1, cancels: 0, probes: 0 });
  } finally {
    releaseJob.resolve();
    releaseModel.resolve();
    await f.close();
  }
});

for (const yieldTime of [undefined, 0])
  test(`exec_command yield ${yieldTime ?? 'default'} assigns two distinct session IDs`, async () => {
    const f = await fixture([
      calls(
        [
          'exec_command',
          { cmd: 'same read', yield_time_ms: yieldTime, description: 'First operation' },
        ],
        [
          'exec_command',
          { cmd: 'same read', yield_time_ms: yieldTime, description: 'Second operation' },
        ],
        ['fixture.read', {}],
      ),
      calls(['poll_command', { session_id: 'original-shell' }]),
      [finish],
    ]);
    try {
      const view = await f.run();
      expect(view.runs[0]!.status).toBe('completed');
      const jobs = view.executions.filter((e) => e.kind === 'job');
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
      const launches = view.executions.filter((e) => e.definitionId === 'shell.execute');
      expect(launches).toHaveLength(2);
      expect(launches.every((execution) => execution.status === 'succeeded')).toBe(true);
      expect(
        new Set(
          launches.map((execution) => {
            const result = execution.result;
            if (
              !result ||
              typeof result !== 'object' ||
              Array.isArray(result) ||
              typeof result.content !== 'string'
            )
              throw Error('original_shell_result_unavailable');
            const details = result.details as Record<string, unknown>;
            expect(Number.isSafeInteger(details.session_id)).toBe(true);
            expect(details.execution_id).toBe(execution.id);
            return details.session_id;
          }),
        ).size,
      ).toBe(2);
      expect(f.counts()).toEqual({ starts: 2, cancels: 0, probes: 1 });
      const read = view.executions.find((execution) => execution.definitionId === 'shell.read')!;
      expect(read.result).toMatchObject({
        details: { execution: { result: { content: 'original result' } } },
      });
      const feedback = f.model.requests[2]!.messages.find((message) =>
        message.sourceIds?.includes(read.id),
      )!;
      expect(feedback.toolCallId).toBe(read.callId);
      expect(feedback.sourceIds).toEqual([read.id]);
      expect(JSON.parse(feedback.content)).toMatchObject({
        session_id: expect.any(Number),
        status: 'succeeded',
        terminal: true,
      });
      expect(
        (
          await f.store.readExecutionGroupSafety({
            expectedStoreId: (await f.store.getMetadata()).storeId,
            subjectId: 'owner',
            sessionId: 's',
          })
        ).quiescent,
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

test('an attempted Shell with unknown business outcome remains unknown after confirmed cleanup', async () => {
  const f = await fixture([calls(['exec_command', { cmd: 'controlled command' }]), [finish]], true);
  try {
    const view = await f.run();
    expect(view.runs[0]!.status).toBe('completed');
    expect(view.executions.some((e) => e.kind === 'job' && e.status === 'outcome_unknown')).toBe(
      true,
    );
    expect(f.model.requests).toHaveLength(2);
    const originalTool = view.executions.find(
      (execution) => execution.definitionId === 'shell.execute',
    )!;
    const feedback = f.model.requests[1]!.messages.find(
      (message) => message.toolCallId === originalTool.callId,
    )!;
    expect(feedback.sourceIds).toEqual([originalTool.id]);
    expect(feedback.content).toContain('outcome_unknown');
    expect(feedback.content).toContain('do not repeat it');
    expect(f.counts().starts).toBe(1);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('start\n');
  } finally {
    await f.close();
  }
});

test('a failure reading local reference storage stays unknown in the actual Runtime', async () => {
  const f = await fixture([calls(['poll_command', { session_id: 999 }]), [finish]]);
  const read = f.store.getExtensionRecord.bind(f.store);
  f.store.getExtensionRecord = async (input) => {
    if (input.extensionId === 'builtin.shell' && input.key === 'shell-session/999')
      throw Error('original_reference_storage_unavailable');
    return read(input);
  };
  try {
    const view = await f.run();
    expect(view.runs[0]!.status).toBe('completed');
    expect(view.executions.find((e) => e.definitionId === 'shell.read')!.status).toBe(
      'outcome_unknown',
    );
    expect(f.model.requests).toHaveLength(2);
    expect(
      f.model.requests[1]!.messages.some((message) =>
        message.content.includes('may have produced effects'),
      ),
    ).toBe(true);
    expect(f.counts()).toEqual({ starts: 0, cancels: 0, probes: 0 });
  } finally {
    f.store.getExtensionRecord = read;
    await f.close();
  }
});
