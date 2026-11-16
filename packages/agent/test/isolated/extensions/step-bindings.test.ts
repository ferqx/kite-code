import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import {
  createRuntime,
  type RunConfiguration,
  type RuntimeOptions,
  type StepCapabilitiesReader,
} from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension, JobEvent, OperationRef, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, version: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify({ version }) },
  { ...finish, reason: 'tool_calls' },
];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fact<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('step_binding_timeout');
    await Bun.sleep(5);
  }
}
type StepInput = Parameters<StepCapabilitiesReader>[0];
const tool = (id: string, version: string, execute: ToolDefinition['execute']): ToolDefinition => ({
  id,
  version,
  description: `Actual version ${version}`,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { version: { const: version } },
    required: ['version'],
  },
  execute,
});
const extension = (version: string, tools: ToolDefinition[]): Extension => ({
  id: 'fixture',
  version,
  apiMajor: 1,
  tools,
  records: [{ contentType: 'fixture.record', contentVersion: 1, schema: { type: 'object' } }],
});
async function fixture(
  responses: ModelEvent[][],
  configuration: (model: ReturnType<typeof createFixedModel>) => RunConfiguration,
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-step-bindings-'))),
    store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' }),
    model = createFixedModel(responses);
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: join(root, 'data'), profile: 'new' },
      store,
    }),
    modelId: 'fixed',
    model,
    modelConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'policy-1' };
      },
    },
    async resolveRunConfiguration() {
      return configuration(model);
    },
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId,
    base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'steps' });
  return {
    model,
    store,
    runtime,
    base,
    async submit() {
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: { kind: 'run.start', content: 'actual step refresh' },
      });
    },
    async done() {
      const command = await runtime.waitForCommand('work', { timeoutMs: 5000 });
      return store.getRun((command.receipt as { runId: string }).runId);
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const decision = (value: Json) =>
  value as {
    toolBindings: { id: string; version: string; extensionId: string }[];
    capabilitySnapshot: Json;
  };

test('same Run refreshes v1 to v2 before Model and actual v2 Tool writes its namespace using the persisted Model binding', async () => {
  let current = '1',
    reads = 0,
    proofExecution = '';
  const effects: string[] = [];
  const versions = Object.fromEntries(
    ['1', '2'].map((version) => [
      version,
      extension(version, [
        tool('fixture.change', version, async () => {
          effects.push(`change-${version}`);
          current = '2';
          return { outcome: 'succeeded', content: 'catalogue changed' };
        }),
        tool('fixture.write', version, async (_input, context) => {
          const record = await context.records.write({
            key: 'actual',
            expectedRevision: null,
            contentType: 'fixture.record',
            contentVersion: 1,
            value: { version },
            executable: true,
          });
          expect(record.extensionId).toBe('fixture');
          effects.push(`write-${version}`);
          return { outcome: 'succeeded', content: 'actual namespace write' };
        }),
      ]),
    ]),
  );
  const f = await fixture(
    [call('fixture.change', '1'), call('fixture.write', '2'), [finish]],
    (model) => ({
      model,
      modelId: 'fixed',
      extensions: [versions['1']!],
      snapshot: { initial: '1' },
      async readStepCapabilities(input: StepInput) {
        reads++;
        expect(Object.isFrozen(input.command)).toBe(true);
        expect(Object.isFrozen(input.run)).toBe(true);
        expect(input.run.originCommandId).toBe(input.command.id);
        expect(input.session.id).toBe(input.run.sessionId);
        expect('owner' in input).toBe(false);
        input.signal.throwIfAborted();
        return { extensions: [versions[current]!], snapshot: { catalogue: current } };
      },
    }),
    {
      extensions: [
        {
          id: 'reader',
          version: '1',
          apiMajor: 1,
          queries: [
            {
              id: 'proof',
              version: '1',
              description: 'Read existing execution without loading catalogue',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'array' },
              async execute(_input, context) {
                const execution = await context.getExecution(proofExecution);
                return [
                  {
                    extensionId: 'reader',
                    contentType: 'fixture.proof',
                    contentVersion: 1,
                    summary: 'Existing proof',
                    payload: JSON.parse(JSON.stringify(execution)),
                    artifactRefs: [],
                    actions: [],
                  },
                ];
              },
            },
          ],
        },
      ],
    },
  );
  try {
    await f.submit();
    const run = await f.done();
    expect(run!.reason).toBeNull();
    expect(run!.status).toBe('completed');
    expect(effects).toEqual(['change-1', 'write-2']);
    expect(f.model.requests).toHaveLength(3);
    expect(
      (run!.configuration as { tools: { id: string; version: string }[] }).tools.find(
        (t) => t.id === 'fixture.write',
      )!.version,
    ).toBe('1');
    const executions = await f.store.listExecutions('s'),
      models = executions.filter((e) => e.kind === 'model');
    for (const [index, model] of models.entries()) {
      const expected = index === 0 ? '1' : '2',
        source = decision(model.decisionSource);
      expect(source.toolBindings).toContainEqual({
        id: 'fixture.write',
        version: expected,
        extensionId: 'fixture',
      });
      expect(source.capabilitySnapshot).toEqual({ catalogue: expected });
      expect(
        f.model.requests[index]!.tools.find((t) => t.id === 'fixture.write')!.inputSchema,
      ).toEqual(versions[expected]!.tools!.find((t) => t.id === 'fixture.write')!.inputSchema);
    }
    expect(executions.find((e) => e.definitionId === 'fixture.write')!.definitionVersion).toBe('2');
    expect(
      (await f.store.getExtensionRecord({ sessionId: 's', extensionId: 'fixture', key: 'actual' }))!
        .value,
    ).toEqual({ version: '2' });
    const count = reads,
      cursor = (await f.store.getMetadata()).lastChangeCursor;
    proofExecution = models[0]!.id;
    expect(
      await f.runtime.queryExtension({
        sessionId: 's',
        extensionId: 'reader',
        queryId: 'proof',
        input: {},
        subjectId: 'owner',
        expectedStoreId: f.base.expectedStoreId,
      }),
    ).toHaveLength(1);
    await f.runtime.getView('s');
    await f.runtime.getRun(run!.id);
    await f.runtime.getExecution(models[0]!.id);
    expect(reads).toBe(count);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('catalogue changes while awaiting approval or a resource reject the original Tool before effects and refresh the next Model', async () => {
  for (const waiting of ['approval', 'resource'] as const) {
    let current = '1';
    const effects: string[] = [],
      entered = gate(),
      resume = gate();
    const versions = Object.fromEntries(
      ['1', '2'].map((version) => [
        version,
        extension(version, [
          {
            ...tool('fixture.write', version, async () => {
              effects.push(version);
              return { outcome: 'succeeded', content: version };
            }),
            ...(waiting === 'resource'
              ? { resources: { serial: { scope: 'workspace' as const, key: 'fixture' } } }
              : {}),
          },
        ]),
      ]),
    );
    let blocked = false;
    const f = await fixture(
      [call('fixture.write', '1'), call('fixture.write', '2'), [finish]],
      (model) => ({
        model,
        modelId: 'fixed',
        extensions: [versions['1']!],
        snapshot: null,
        async readStepCapabilities() {
          return { extensions: [versions[current]!], snapshot: { catalogue: current } };
        },
      }),
      {
        permissions: {
          async authorize(request) {
            return request.kind === 'model' || waiting === 'resource'
              ? { allowed: true, revision: 'policy-1' }
              : {
                  allowed: false,
                  revision: 'policy-1',
                  approval: { request: { title: 'Exact version' } },
                };
          },
        },
        ...(waiting === 'resource'
          ? {
              workspaceSerialLocks: {
                async acquire(_input, signal) {
                  if (!blocked) {
                    blocked = true;
                    entered.release();
                    await resume.promise;
                  }
                  signal.throwIfAborted();
                  return () => {};
                },
              },
            }
          : {}),
      },
    );
    const pending = (excluded: string[] = []) =>
      fact(
        async () =>
          (
            await f.runtime.listInteractions({
              expectedStoreId: f.base.expectedStoreId,
              sessionId: 's',
              state: 'pending',
            })
          ).interactions.find((card) => !excluded.includes(card.id)) ?? null,
      );
    const answer = (card: Awaited<ReturnType<typeof pending>>) =>
      f.runtime.answerInteraction({
        ...f.base,
        commandId: `answer-${card.id}`,
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
    try {
      await f.submit();
      if (waiting === 'approval') {
        const old = await pending();
        current = '2';
        await answer(old);
        const fresh = await pending([old.id]);
        await answer(fresh);
        expect(
          (await f.store.getInteraction({
            expectedStoreId: f.base.expectedStoreId,
            sessionId: 's',
            interactionId: old.id,
          }))!.acceptedDecisionRevision,
        ).toBeNull();
      } else {
        await entered.promise;
        current = '2';
        resume.release();
      }
      const run = await f.done();
      expect(run!.status).toBe('completed');
      expect(effects).toEqual(['2']);
      expect(f.model.requests).toHaveLength(3);
      const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
      expect(tools).toHaveLength(2);
      expect(tools[0]!.definitionVersion).toBe('1');
      expect(tools[0]!.result).toMatchObject({
        content: 'capability_refresh_required',
        details: { adapterAttempted: false },
      });
      expect(tools[1]!.definitionVersion).toBe('2');
      expect(tools[1]!.status).toBe('succeeded');
      expect(f.model.requests[1]!.tools[0]!.inputSchema).toEqual(
        versions['2']!.tools![0]!.inputSchema,
      );
    } finally {
      resume.release();
      await f.close();
    }
  }
});

test('dispatched background Job keeps its original step implementation and Run lease across later step catalogues', async () => {
  const started = gate(),
    terminal = gate(),
    disposed = gate();
  let current = '1',
    reference: OperationRef | undefined,
    runDisposals = 0;
  const starts = [0, 0],
    jobDisposals = [0, 0];
  const versions = Object.fromEntries(
    ['1', '2'].map((version, index) => {
      const ext = extension(version, [
        tool('fixture.launch', version, async (_input, context) => {
          reference = await context.operations.ensure({
            key: 'background',
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: 'fixture.job',
              definitionVersion: version,
              input: {},
            },
          });
          await started.promise;
          current = '2';
          return { outcome: 'succeeded', content: 'old Job started' };
        }),
        tool('fixture.write', version, async () => ({
          outcome: 'succeeded',
          content: `new step ${version}`,
        })),
      ]);
      return [
        version,
        {
          ...ext,
          jobs: [
            {
              id: 'fixture.job',
              version,
              description: 'Held real Job',
              inputSchema: { type: 'object' },
              async start() {
                starts[index]!++;
                started.release();
                return { reference: { version } };
              },
              async *observe(): AsyncIterable<JobEvent> {
                await terminal.promise;
                yield {
                  type: 'terminal',
                  supervision: 'ended',
                  result: { outcome: 'succeeded', content: `original version ${version}` },
                };
              },
              async cancel() {
                terminal.release();
                return { status: 'stopped' as const };
              },
              async dispose() {
                jobDisposals[index]!++;
              },
            },
          ],
        } satisfies Extension,
      ];
    }),
  );
  const f = await fixture(
    [call('fixture.launch', '1'), call('fixture.write', '2'), [finish]],
    (model) => ({
      model,
      modelId: 'fixed',
      extensions: [versions['1']!],
      snapshot: null,
      async readStepCapabilities() {
        const root = await f.runtime.getSessionExecutionRoot({ sessionId: 's' });
        return {
          extensions: [versions[current]!],
          executionRoot: root,
          snapshot: { catalogue: current, executionRoot: root as unknown as Json },
        };
      },
      async dispose() {
        runDisposals++;
        disposed.release();
      },
    }),
  );
  try {
    await f.submit();
    const run = await f.done();
    expect(run!.status).toBe('completed');
    expect(starts).toEqual([1, 0]);
    expect(jobDisposals).toEqual([0, 0]);
    expect(runDisposals).toBe(0);
    expect((await f.store.getExecution(reference!.executionId!))!.status).toBe('running');
    expect((await f.store.getExecution(reference!.executionId!))!.definitionVersion).toBe('1');
    terminal.release();
    await disposed.promise;
    const actual = await f.store.getExecution(reference!.executionId!);
    expect(actual!.status).toBe('succeeded');
    expect(actual!.result).toMatchObject({ content: 'original version 1' });
    expect(actual!.decisionSource).toMatchObject({
      executionRoot: await f.runtime.getSessionExecutionRoot({ sessionId: 's', epoch: '0' }),
      toolBatchSize: 1,
    });
    expect(actual!.decisionSource).toEqual(
      (await f.store.getExecution(actual!.parentExecutionId!))!.decisionSource,
    );
    expect(jobDisposals).toEqual([1, 0]);
    expect(runDisposals).toBe(1);
    await f.runtime.close();
    expect(runDisposals).toBe(1);
    expect(starts).toEqual([1, 0]);
  } finally {
    terminal.release();
    await f.close();
  }
});

test('duplicate step declarations and oversized capability snapshots reject before any Model', async () => {
  for (const invalid of ['duplicate', 'snapshot'] as const) {
    let effects = 0;
    const ext = extension('1', [
      tool('fixture.write', '1', async () => {
        effects++;
        return { outcome: 'succeeded', content: 'must not execute' };
      }),
    ]);
    const f = await fixture([call('fixture.write', '1')], (model) => ({
      model,
      modelId: 'fixed',
      extensions: [ext],
      snapshot: null,
      async readStepCapabilities() {
        return {
          extensions: invalid === 'duplicate' ? [ext, ext] : [ext],
          snapshot: (invalid === 'snapshot' ? { oversized: 'x'.repeat(1024 * 1024) } : {}) as Json,
        };
      },
    }));
    try {
      await f.submit();
      const run = await f.done();
      expect(run!.status).toBe('failed');
      expect(run!.reason).not.toBeNull();
      expect(effects).toBe(0);
      expect(f.model.requests).toHaveLength(0);
      expect(await f.store.listExecutions('s')).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
});

test('a catalogue change at Model admission retries with a rebuilt actual tool request instead of invoking the old request', async () => {
  const entered = gate(),
    resume = gate();
  let current = '1',
    held = false,
    effects = 0;
  const versions = Object.fromEntries(
    ['1', '2'].map((version) => [
      version,
      extension(version, [
        tool('fixture.write', version, async () => {
          effects++;
          return { outcome: 'succeeded', content: version };
        }),
      ]),
    ]),
  );
  const f = await fixture(
    [call('fixture.write', '2'), [finish]],
    (model) => ({
      model,
      modelId: 'fixed',
      extensions: [versions['1']!],
      snapshot: null,
      async readStepCapabilities() {
        return { extensions: [versions[current]!], snapshot: { catalogue: current } };
      },
    }),
    {
      permissions: {
        async authorize(request) {
          if (request.kind === 'model' && !held) {
            held = true;
            entered.release();
            await resume.promise;
          }
          return { allowed: true, revision: 'policy-1' };
        },
      },
    },
  );
  try {
    await f.submit();
    await entered.promise;
    current = '2';
    resume.release();
    expect((await f.done())!.status).toBe('completed');
    expect(effects).toBe(1);
    expect(f.model.requests).toHaveLength(2);
    expect(f.model.requests[0]!.tools[0]!.inputSchema).toEqual(
      versions['2']!.tools![0]!.inputSchema,
    );
    const models = (await f.store.listExecutions('s')).filter((e) => e.kind === 'model');
    expect(models.filter((e) => e.status === 'failed')).toHaveLength(1);
    expect(
      decision(models.find((e) => e.status === 'failed')!.decisionSource).toolBindings,
    ).toContainEqual({ id: 'fixture.write', version: '1', extensionId: 'fixture' });
    expect(
      decision(models.find((e) => e.status === 'succeeded')!.decisionSource).toolBindings,
    ).toContainEqual({ id: 'fixture.write', version: '2', extensionId: 'fixture' });
  } finally {
    resume.release();
    await f.close();
  }
});

test('each Step selects one coherent source and permission scope without falling back to the initial policy', async () => {
  let current = '1';
  const effects: string[] = [],
    authorizations: string[] = [],
    evaluations: string[] = [];
  const ext = extension('1', [
    tool('fixture.change', '1', async () => {
      effects.push('change');
      current = '2';
      return { outcome: 'succeeded', content: 'select next scope' };
    }),
    tool('fixture.write', '1', async () => {
      effects.push('write');
      return { outcome: 'succeeded', content: 'new scope write' };
    }),
    tool('fixture.forbidden', '1', async () => {
      effects.push('forbidden');
      return { outcome: 'succeeded', content: 'must not execute' };
    }),
  ]);
  const f = await fixture(
    [
      call('fixture.change', '1'),
      call('fixture.write', '1'),
      call('fixture.forbidden', '1'),
      [finish],
    ],
    (model) => ({
      model,
      modelId: 'fixed',
      extensions: [ext],
      snapshot: null,
      sources: {
        async capture() {
          throw Error('initial source must not be captured');
        },
      },
      async initializeRequirements(input) {
        const context = await input.forExtension('fixture');
        const record = await context.records.create({
          key: `run/${input.run.id}/required`,
          contentType: 'fixture.record',
          contentVersion: 1,
          value: { required: true },
        });
        return [
          {
            extensionId: 'fixture',
            definitionVersion: '1',
            requirementId: 'required',
            recordKey: record.key,
            revision: record.revision,
            phase: 'both',
            sessionId: input.session.id,
            runId: input.run.id,
          },
        ];
      },
      conditions: {
        async evaluate(refs, _phase, context) {
          evaluations.push(`initial:${context?.boundary.definitionId}`);
          return refs.map((requirement) => ({
            requirement,
            recordRevision: requirement.revision,
            outcome: 'satisfied' as const,
            evidence: { scope: 'initial' },
          }));
        },
      },
      async readStepCapabilities(input) {
        expect(input.originalSnapshot).toBeUndefined();
        const selected = current;
        return {
          extensions: [ext],
          snapshot: { scope: selected },
          sources: {
            async capture() {
              return [
                {
                  id: 'scope',
                  kind: 'test',
                  scope: 's',
                  digest: selected,
                  content: `scope-canary-${selected}`,
                },
              ];
            },
          },
          conditions: {
            async evaluate(refs, _phase, context) {
              evaluations.push(`${selected}:${context?.boundary.definitionId}`);
              return refs.map((requirement) => ({
                requirement,
                recordRevision: requirement.revision,
                outcome: 'satisfied' as const,
                evidence: { scope: selected },
              }));
            },
          },
          permissions: {
            async authorize(request) {
              authorizations.push(`${selected}:${request.definitionId}`);
              return request.definitionId === 'fixture.forbidden' ||
                (selected === '1' && request.definitionId === 'fixture.write')
                ? { allowed: false, revision: `scope-${selected}`, reason: 'selected_scope_denial' }
                : { allowed: true, revision: `scope-${selected}` };
            },
          },
        };
      },
    }),
  );
  try {
    await f.submit();
    const run = await f.done();
    expect(run!.status, JSON.stringify(run)).toBe('completed');
    expect(effects).toEqual(['change', 'write']);
    expect(authorizations).toContain('1:fixture.change');
    expect(authorizations).toContain('2:fixture.write');
    expect(authorizations).not.toContain('1:fixture.write');
    expect(authorizations).toContain('2:fixture.forbidden');
    expect(evaluations).toContain('1:fixture.change');
    expect(evaluations).toContain('2:fixture.write');
    expect(evaluations).not.toContain('1:fixture.write');
    expect(f.model.requests).toHaveLength(4);
    for (const [index, request] of f.model.requests.entries()) {
      const actual = JSON.stringify(request.messages);
      expect(actual).toContain(`scope-canary-${index === 0 ? '1' : '2'}`);
      expect(actual).not.toContain(`scope-canary-${index === 0 ? '2' : '1'}`);
    }
    const blocked = (await f.store.listExecutions('s')).find(
      (e) => e.definitionId === 'fixture.forbidden',
    );
    expect(blocked!.status).toBe('failed');
    expect(blocked!.result).toMatchObject({
      details: { reason: 'selected_scope_denial', adapterAttempted: false },
    });
  } finally {
    await f.close();
  }
});

test('actual Model and Tool proofs seal host-resolved epoch zero identity and complete model tool batch size', async () => {
  const effects: string[] = [];
  const ext = extension('1', [
    tool('fixture.write', '1', async () => {
      effects.push('write');
      return { outcome: 'succeeded', content: 'written' };
    }),
  ]);
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(
    [[...call('fixture.write', '1').slice(0, 1), ...call('fixture.write', '1')], [finish]],
    (model) => ({
      model,
      modelId: 'fixed',
      extensions: [ext],
      snapshot: null,
      async readStepCapabilities() {
        const root = await f.runtime.getSessionExecutionRoot({ sessionId: 's' });
        const identity = statSync(fileURLToPath(root.effectiveRootUri), { bigint: true });
        const resolved = {
          ...root,
          identity: { dev: String(identity.dev), ino: String(identity.ino) },
        };
        return {
          extensions: [ext],
          executionRoot: resolved,
          snapshot: { executionRoot: resolved as unknown as Json },
        };
      },
    }),
  );
  try {
    const original = await f.runtime.getSessionExecutionRoot({ sessionId: 's' });
    const identity = statSync(fileURLToPath(original.effectiveRootUri), { bigint: true });
    const sealed = {
      ...original,
      identity: { dev: String(identity.dev), ino: String(identity.ino) },
    };
    await f.submit();
    expect((await f.done())!.status).toBe('completed');
    expect(effects).toEqual(['write', 'write']);
    const executions = await f.store.listExecutions('s');
    for (const execution of executions) {
      expect(execution.decisionSource).toMatchObject({ executionRoot: sealed });
      if (execution.kind === 'tool')
        expect(execution.decisionSource).toMatchObject({ toolBatchSize: 2 });
      else expect(execution.decisionSource).not.toHaveProperty('toolBatchSize');
    }
    expect(
      await f.runtime.getSessionExecutionRoot({ sessionId: 's', epoch: original.epoch }),
    ).toEqual(original);
  } finally {
    await f.close();
  }
});

test('forged, foreign or mismatched root snapshots fail before any Model or Tool', async () => {
  for (const invalid of ['foreign', 'snapshot', 'identity', 'epoch'] as const) {
    let effects = 0;
    const ext = extension('1', [
      tool('fixture.write', '1', async () => {
        effects++;
        return { outcome: 'succeeded', content: 'must not execute' };
      }),
    ]);
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture([call('fixture.write', '1')], (model) => ({
      model,
      modelId: 'fixed',
      extensions: [ext],
      snapshot: null,
      async readStepCapabilities() {
        const original = await f.runtime.getSessionExecutionRoot({ sessionId: 's' });
        const root = {
          ...original,
          ...(invalid === 'foreign' ? { sessionId: 'other' } : {}),
          ...(invalid === 'identity' ? { identity: { dev: 'invalid', ino: '2' } } : {}),
          ...(invalid === 'epoch' ? { epoch: '9223372036854775808' } : {}),
        };
        return {
          extensions: [ext],
          executionRoot: root,
          snapshot: {
            executionRoot: (invalid === 'snapshot'
              ? { ...root, epoch: '123' }
              : root) as unknown as Json,
          },
        };
      },
    }));
    try {
      await f.submit();
      const run = await f.done();
      expect(run!.status).toBe('failed');
      expect(run!.reason).toBe('step_execution_root_invalid');
      expect(f.model.requests).toHaveLength(0);
      expect(await f.store.listExecutions('s')).toHaveLength(0);
      expect(effects).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('a trusted behavior configuration change invalidates a waiting Tool even with unchanged schemas and snapshot', async () => {
  let current = 'a',
    held = false,
    effects = 0;
  const entered = gate(),
    release = gate();
  const definition: ToolDefinition = {
    ...tool('fixture.write', '1', async () => {
      effects++;
      return { outcome: 'succeeded', content: 'actual fresh behavior' };
    }),
    resources: { serial: { scope: 'workspace', key: 'same' } },
  };
  const ext = extension('1', [definition]);
  const f = await fixture(
    [call('fixture.write', '1'), call('fixture.write', '1'), [finish]],
    (model) => ({
      model,
      modelId: 'fixed',
      extensions: [ext],
      snapshot: null,
      async readStepCapabilities() {
        return {
          extensions: [ext],
          snapshot: { unchanged: true },
          toolBehaviors: [
            {
              definition,
              capability: {
                kind: 'tool',
                definitionId: definition.id,
                definitionVersion: definition.version,
              },
              contractRef: 'fixture:scope',
              configurationDigest: current.repeat(64),
            },
          ],
        };
      },
    }),
    {
      workspaceSerialLocks: {
        async acquire(_input, signal) {
          if (!held) {
            held = true;
            entered.release();
            await release.promise;
          }
          signal.throwIfAborted();
          return () => {};
        },
      },
    },
  );
  try {
    await f.submit();
    await entered.promise;
    current = 'b';
    release.release();
    expect((await f.done())!.status).toBe('completed');
    expect(effects).toBe(1);
    const tools = (await f.store.listExecutions('s')).filter(
      (execution) => execution.kind === 'tool',
    );
    expect(tools).toHaveLength(2);
    expect(tools[0]!.result).toMatchObject({
      content: 'capability_refresh_required',
      details: { adapterAttempted: false },
    });
    expect(tools[1]!.status).toBe('succeeded');
  } finally {
    release.release();
    await f.close();
  }
});

test('a selected Step allowance cannot replace an independent Run denial', async () => {
  let effects = 0,
    ceilingCalls = 0;
  const ext = extension('1', [
    tool('fixture.write', '1', async () => {
      effects++;
      return { outcome: 'succeeded', content: 'must not execute' };
    }),
  ]);
  const f = await fixture([call('fixture.write', '1'), [finish]], (model) => ({
    model,
    modelId: 'fixed',
    extensions: [ext],
    snapshot: null,
    permissions: {
      async authorize(request) {
        ceilingCalls++;
        return request.kind === 'tool'
          ? { allowed: false, revision: 'run-ceiling', reason: 'run_denies_effect' }
          : { allowed: true, revision: 'run-ceiling' };
      },
    },
    async readStepCapabilities() {
      return {
        extensions: [ext],
        snapshot: { scope: 'new' },
        permissions: {
          toolDispatchOrder: 'model',
          async authorize() {
            return { allowed: true, revision: 'step-allows' };
          },
        },
      };
    },
  }));
  try {
    await f.submit();
    expect((await f.done())!.status).toBe('completed');
    expect(ceilingCalls).toBeGreaterThan(0);
    expect(effects).toBe(0);
    const actual = (await f.store.listExecutions('s')).find((e) => e.kind === 'tool');
    expect(actual!.result).toMatchObject({
      details: { reason: 'run_denies_effect', adapterAttempted: false },
    });
  } finally {
    await f.close();
  }
});

test('an independently wrapped Run policy still gates the final Tool authorization when Step policy declares model order', async () => {
  let effects = 0,
    calls = 0;
  const entered = gate(),
    resume = gate();
  const ext = extension('1', [
    tool('fixture.write', '1', async () => {
      effects++;
      return { outcome: 'succeeded', content: 'actual effect' };
    }),
  ]);
  const selected = {
    toolDispatchOrder: 'model' as const,
    async authorize() {
      return { allowed: true, revision: 'same-default' };
    },
  };
  const f = await fixture([call('fixture.write', '1'), [finish]], (model) => ({
    model,
    modelId: 'fixed',
    extensions: [ext],
    snapshot: null,
    permissions: {
      async authorize(request) {
        const decision = await selected.authorize();
        if (request.kind === 'tool' && ++calls === 2) {
          entered.release();
          await resume.promise;
        }
        return decision;
      },
    },
    async readStepCapabilities() {
      return { extensions: [ext], snapshot: { selected: true }, permissions: selected };
    },
  }));
  try {
    await f.submit();
    await entered.promise;
    expect(effects).toBe(0);
    const planned = (await f.store.listExecutions('s')).find((e) => e.kind === 'tool');
    expect(planned!.authorization?.dispatched).not.toBe(true);
    resume.release();
    expect((await f.done())!.status).toBe('completed');
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(effects).toBe(1);
  } finally {
    resume.release();
    await f.close();
  }
});

test('a Run mandatory human confirmation survives the selected Step policy and one automatic reviewer', async () => {
  let effects = 0;
  const ext = extension('1', [
    tool('fixture.write', '1', async () => {
      effects++;
      return { outcome: 'succeeded', content: 'once approved' };
    }),
  ]);
  const reviewer = createFixedModel([
    [
      {
        type: 'text_delta',
        text: JSON.stringify({ decision: 'approve_once', reason: 'ordinary risk only' }),
      },
      finish,
    ],
  ]);
  const f = await fixture([call('fixture.write', '1'), [finish]], (model) => ({
    model,
    modelId: 'fixed',
    extensions: [ext],
    snapshot: null,
    authorizationCheck: {
      id: 'run-ceiling-review',
      version: '1',
      modelId: 'review',
      model: reviewer,
    },
    permissions: {
      async authorize(request) {
        return request.kind === 'tool'
          ? {
              allowed: false,
              revision: 'run-mandatory',
              approval: { request: { title: 'Independent Run confirmation' } },
              check: { request: { kind: 'run-ceiling', requires: 'human' }, requireApproval: true },
            }
          : { allowed: true, revision: 'run-mandatory' };
      },
    },
    async readStepCapabilities() {
      return {
        extensions: [ext],
        snapshot: { selected: true },
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'step-allows' };
          },
        },
      };
    },
  }));
  try {
    await f.submit();
    const card = await fact(
      async () =>
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.base.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
    expect(reviewer.requests).toHaveLength(1);
    expect(effects).toBe(0);
    await f.runtime.answerInteraction({
      ...f.base,
      commandId: `answer-${card.id}`,
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
    });
    expect((await f.done())!.status).toBe('completed');
    expect(effects).toBe(1);
    expect(reviewer.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const artifactBacked of [false, true])
  test(`automatic review uses each original Model Step behavior rather than the initial Run behavior (${artifactBacked ? 'artifact' : 'inline'})`, async () => {
    let current = 'a';
    const effects: string[] = [];
    const definition = tool('fixture.reviewed', '1', async () => {
      effects.push(current);
      current = 'b';
      return { outcome: 'succeeded', content: 'actual reviewed Step' };
    });
    const ext = extension('1', [definition]);
    const capability = {
      kind: 'tool' as const,
      definitionId: definition.id,
      definitionVersion: '1',
    };
    const behaviors = Object.fromEntries(
      ['a', 'b'].map((value) => [
        value,
        {
          definition,
          capability,
          contractRef: 'fixture.reviewed-step',
          configurationDigest: value.repeat(64),
          async prepareReview() {
            return {
              instructions: 'Return one approval JSON object for this harmless fixture.',
              material: { selected: value },
              fingerprint: value.repeat(64),
              reusable: false,
            };
          },
          interpretReview(content: string) {
            return { answer: JSON.parse(content) };
          },
        },
      ]),
    );
    const reviewer = createFixedModel(
      Array.from({ length: 2 }, () => [
        {
          type: 'text_delta' as const,
          text: JSON.stringify({ decision: 'approve_once', reason: 'harmless fixture' }),
        },
        finish,
      ]),
    );
    const f = await fixture(
      [
        ...Array.from({ length: 2 }, () => [
          ...(artifactBacked ? [{ type: 'text_delta' as const, text: 'x'.repeat(70 * 1024) }] : []),
          ...call('fixture.reviewed', '1'),
        ]),
        [finish],
      ],
      (model) => ({
        model,
        modelId: 'fixed',
        extensions: [ext],
        snapshot: null,
        toolBehaviors: [behaviors.a!],
        authorizationCheck: { id: 'step-review', version: '1', modelId: 'review', model: reviewer },
        async readStepCapabilities() {
          const selected = behaviors[current]!;
          const binding = {
            capability,
            contractRef: selected.contractRef,
            configurationDigest: selected.configurationDigest,
          };
          return {
            extensions: [ext],
            snapshot: { selected: current },
            toolBehaviors: [selected],
            permissions: {
              async authorize(request) {
                return request.kind === 'tool'
                  ? {
                      allowed: false,
                      revision: selected.configurationDigest,
                      check: { request: { selected: binding }, behavior: binding },
                    }
                  : { allowed: true, revision: selected.configurationDigest };
              },
            },
          };
        },
      }),
    );
    try {
      await f.submit();
      expect((await f.done())!.status).toBe('completed');
      expect(effects).toEqual(['a', 'b']);
      expect(reviewer.requests).toHaveLength(2);
      const models = (await f.store.listExecutions('s')).filter(
        (execution) => execution.kind === 'model' && execution.definitionId === 'fixed',
      );
      expect(models).toHaveLength(3);
      for (const [index, model] of models.entries()) {
        if (artifactBacked && index < 2) {
          expect(model.result).toMatchObject({
            modelOutput: { complete: true, toolCallCount: 1 },
            modelToolCalls: [
              { name: 'fixture.reviewed', inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
            ],
          });
          expect(
            JSON.stringify((model.result as Record<string, Json>).modelToolCalls),
          ).not.toContain('arguments');
        }
        expect(model.decisionSource).toMatchObject({
          toolBehaviorBindings: [
            {
              capability,
              contractRef: 'fixture.reviewed-step',
              configurationDigest: (index === 0 ? 'a' : 'b').repeat(64),
            },
          ],
        });
      }
    } finally {
      await f.close();
    }
  });

for (const artifactBacked of [false, true])
  test(`owner execution-confirmation consumes each original Step binding (${artifactBacked ? 'artifact' : 'inline'})`, async () => {
    let current = 'a';
    const effects: string[] = [];
    const definition = tool('fixture.confirmed-step', '1', async () => {
      effects.push(current);
      current = 'b';
      return { outcome: 'succeeded', content: 'exact confirmed effect' };
    });
    const ext = extension('1', [definition]);
    const capability = {
      kind: 'tool' as const,
      definitionId: definition.id,
      definitionVersion: '1',
    };
    const behaviors = Object.fromEntries(
      ['a', 'b'].map((value) => [
        value,
        {
          definition,
          capability,
          contractRef: 'fixture.confirmed-step',
          configurationDigest: value.repeat(64),
          async executionConfirmation() {
            return { request: { reason: 'Confirm this exact Step effect', selected: value } };
          },
        },
      ]),
    );
    const f = await fixture(
      [
        ...Array.from({ length: 2 }, () => [
          ...(artifactBacked ? [{ type: 'text_delta' as const, text: 'x'.repeat(70 * 1024) }] : []),
          ...call(definition.id, '1'),
        ]),
        [finish],
      ],
      (model) => ({
        model,
        modelId: 'fixed',
        extensions: [ext],
        snapshot: null,
        toolBehaviors: [behaviors.a!],
        async readStepCapabilities() {
          const behavior = behaviors[current]!;
          return { extensions: [ext], snapshot: { selected: current }, toolBehaviors: [behavior] };
        },
      }),
    );
    try {
      await f.submit();
      for (const [index, value] of ['a', 'b'].entries()) {
        const card = await fact(
          async () =>
            (
              await f.runtime.listInteractions({
                expectedStoreId: f.base.expectedStoreId,
                sessionId: 's',
                state: 'pending',
              })
            ).interactions[0] ?? null,
        );
        expect(effects).toHaveLength(index);
        expect(card.request).toMatchObject({
          executionConfirmation: {
            owner: {
              capability,
              contractRef: 'fixture.confirmed-step',
              configurationDigest: value.repeat(64),
            },
          },
        });
        await f.runtime.answerInteraction({
          ...f.base,
          commandId: `confirm-${card.id}`,
          presentationSessionId: 's',
          interactionId: card.id,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
        });
        await fact(async () => (effects.length === index + 1 ? true : null));
      }
      expect((await f.done())!.status).toBe('completed');
      expect(effects).toEqual(['a', 'b']);
      const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
      expect(tools).toHaveLength(2);
      for (const execution of tools) {
        expect(execution.status).toBe('succeeded');
        expect(execution.authorization?.dispatched).toBe(true);
      }
    } finally {
      await f.close();
    }
  });
