import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type {
  Extension,
  JobEvent,
  NecessaryConditions,
  OperationRef,
  ToolContext,
  ToolDefinition,
} from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json, RequirementRef, Store } from '../../../src/storage';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const calls = (...names: string[]): ModelEvent[] => [
  ...names.map((name) => ({
    type: 'tool_call' as const,
    id: crypto.randomUUID(),
    name,
    arguments: '{}',
  })),
  { ...finish, reason: 'tool_calls' },
];
const declaration = (key: string, phase: RequirementRef['phase'] = 'completion') => ({
  definitionVersion: '1',
  requirementId: key,
  recordKey: key,
  revision: '1',
  phase,
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('requirement_core_timeout')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fact<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('requirement_core_missing_fact');
    await Bun.sleep(5);
  }
}
async function rejected(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
function tool(id: string, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    id,
    version: '1',
    description: 'Finite actual requirement fixture',
    inputSchema: { type: 'object', additionalProperties: false },
    execute,
  };
}
function extension(tools: ToolDefinition[]): Extension {
  return {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools,
    records: [
      { contentType: 'fixture.requirement', contentVersion: 7, schema: { type: 'object' } },
      { contentType: 'fixture.requirement', contentVersion: 4, schema: { type: 'object' } },
    ],
  };
}
async function write(context: ToolContext, key: string, value: Json) {
  return context.records.write({
    key,
    expectedRevision: null,
    contentType: 'fixture.requirement',
    contentVersion: 7,
    value,
    executable: true,
  });
}
async function fixture(
  ext: Extension,
  responses: ModelEvent[][],
  configure: (store: Store) => Partial<RuntimeOptions> = () => ({}),
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-core-requirements-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const model = createFixedModel(responses);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [ext],
    ...configure(store),
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'requirements',
  });
  return {
    store,
    runtime,
    model,
    base,
    async submit(commandId = 'work') {
      await runtime.submitCommand({
        ...base,
        commandId,
        request: { kind: 'run.start', content: commandId },
      });
    },
    async done(commandId = 'work') {
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 4000 });
      const runId = (command.receipt as { runId?: string })?.runId;
      return { command, run: runId ? await store.getRun(runId) : null };
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Tool registration persists actual obligations; missing evaluator and unsatisfied completion cannot report completed', async () => {
  for (const implementation of ['missing', 'unsatisfied'] as const) {
    let registration: readonly RequirementRef[] = [];
    const phases: string[] = [];
    const ext = extension([
      tool('fixture.register', async (_input, context) => {
        await write(context, 'required', { required: true, satisfied: false });
        registration = await context.requirements!.register([declaration('required')]);
        return { outcome: 'succeeded', content: 'obligation registered' };
      }),
    ]);
    const f = await fixture(ext, [calls('fixture.register'), [finish]], (store) =>
      implementation === 'missing'
        ? {}
        : {
            conditions: {
              async evaluate(refs, phase) {
                phases.push(phase);
                return Promise.all(
                  refs.map(async (ref) => {
                    const record = await store.getExtensionRecord({
                      sessionId: ref.sessionId,
                      extensionId: ref.extensionId,
                      key: ref.recordKey,
                    });
                    return {
                      requirement: ref,
                      recordRevision: record!.revision,
                      outcome: (record!.value as { satisfied: boolean }).satisfied
                        ? ('satisfied' as const)
                        : ('unsatisfied' as const),
                      evidence: { record: record!.key, actual: record!.value },
                    };
                  }),
                );
              },
            },
          },
    );
    try {
      await f.submit();
      const result = await f.done();
      expect(f.model.requests).toHaveLength(2);
      expect(registration).toHaveLength(1);
      expect(registration[0]!.extensionId).toBe('fixture');
      expect(registration[0]!.sessionId).toBe('s');
      expect(registration[0]!.runId).toBe(result.run!.id);
      expect(registration[0]!.originStoreId).toBe(f.base.expectedStoreId);
      expect(result.run!.requirements).toEqual([...registration]);
      expect(result.run!.status).toBe('failed');
      expect(result.run!.reason).toBe(
        implementation === 'missing'
          ? 'necessary_condition_implementation_missing'
          : 'necessary_condition_unsatisfied',
      );
      expect(
        (await f.store.getExtensionRecord({ ...f.base, extensionId: 'fixture', key: 'required' }))!
          .value,
      ).toEqual({ required: true, satisfied: false });
      if (implementation === 'unsatisfied') expect(phases).toEqual(['completion']);
    } finally {
      await f.close();
    }
  }
});

test('same Model decision cannot bypass new dispatch obligations; exact business waiver remains distinct from passed evidence', async () => {
  for (const waived of [false, true]) {
    let effects = 0;
    let held: ToolContext | undefined;
    const evaluations: { phase: string; outcome: string; evidence: Json }[] = [];
    const ext = extension([
      tool('fixture.register', async (_input, context) => {
        if (held) {
          await rejected(
            context.requirements!.register([
              {
                ...declaration('required'),
                requirementId: 'old-real-execution',
                executionId: held.executionId,
                attempt: 1,
              },
            ]),
            'requirement_scope_mismatch',
          );
          await rejected(
            context.requirements!.register([
              { ...declaration('required'), runId: 'old-public-claim' },
            ] as unknown as Parameters<NonNullable<ToolContext['requirements']>['register']>[0]),
            'invalid_requirement',
          );
          await rejected(held.requirements!.register([declaration('required')]), 'owner_changed');
          return {
            outcome: 'succeeded',
            content: 'actual old execution and caller scope claims refused',
          };
        }
        held = context;
        await write(context, 'required', { required: true });
        const refs = await context.requirements!.register([declaration('required', 'both')]);
        await write(context, 'evidence', {
          outcome: waived ? 'waived' : 'unsatisfied',
          requirementId: refs[0]!.requirementId,
          revision: refs[0]!.revision,
          sessionId: refs[0]!.sessionId,
          runId: refs[0]!.runId,
          subjectId: 'owner',
          reason: 'explicit harmless fixture waiver',
          time: 1000,
        });
        await rejected(
          context.requirements!.register([
            { ...declaration('spoof'), extensionId: 'foreign' },
          ] as unknown as Parameters<NonNullable<ToolContext['requirements']>['register']>[0]),
          'invalid_requirement',
        );
        await rejected(
          context.requirements!.register([
            {
              ...declaration('required'),
              requirementId: 'wrong-exec',
              executionId: 'not-an-execution',
              attempt: 1,
            },
          ]),
          'requirement_scope_mismatch',
        );
        return { outcome: 'succeeded', content: 'required evidence stored' };
      }),
      tool('fixture.effect', async () => {
        effects++;
        return { outcome: 'succeeded', content: 'harmless local counter' };
      }),
    ]);
    const f = await fixture(
      ext,
      [calls('fixture.register', 'fixture.effect'), [finish], calls('fixture.register'), [finish]],
      (store) => ({
        conditions: {
          async evaluate(refs, phase) {
            return Promise.all(
              refs.map(async (ref) => {
                const evidence = (await store.getExtensionRecord({
                  sessionId: ref.sessionId,
                  extensionId: ref.extensionId,
                  key: 'evidence',
                }))!.value;
                const value = evidence as {
                  outcome: 'waived' | 'unsatisfied';
                  runId: string;
                  revision: string;
                  requirementId: string;
                };
                expect(value.runId).toBe(ref.runId);
                expect(value.revision).toBe(ref.revision);
                expect(value.requirementId).toBe(ref.requirementId);
                evaluations.push({ phase, outcome: value.outcome, evidence });
                return {
                  requirement: ref,
                  recordRevision: ref.revision,
                  outcome: value.outcome,
                  evidence,
                };
              }),
            );
          },
        },
      }),
    );
    try {
      await f.submit();
      const result = await f.done();
      expect(effects).toBe(waived ? 1 : 0);
      expect(result.run!.status).toBe(waived ? 'completed' : 'failed');
      expect(evaluations.length).toBeGreaterThan(0);
      expect(evaluations.some((value) => value.phase === 'dispatch')).toBe(true);
      const evidence = (await f.store.getExtensionRecord({
        ...f.base,
        extensionId: 'fixture',
        key: 'evidence',
      }))!.value as { outcome: string; runId: string };
      expect(evidence.outcome).toBe(waived ? 'waived' : 'unsatisfied');
      expect(evidence.runId).toBe(result.run!.id);
      expect(evidence).not.toHaveProperty('passed');
      const execution = (await f.store.listExecutions('s')).find(
        (value) => value.definitionId === 'fixture.effect',
      )!;
      expect(execution.status).toBe(waived ? 'succeeded' : 'failed');
      expect(execution.decisionSource).toMatchObject({ kind: 'model_decision' });
      if (waived) {
        await f.submit('new-run');
        const next = await f.done('new-run');
        expect(next.run!.requirements).toEqual([]);
        expect(next.run!.status).toBe('completed');
        await rejected(held!.requirements!.register([declaration('required')]), 'owner_changed');
        expect((await f.store.getRun(result.run!.id))!.requirements).toHaveLength(1);
      }
    } finally {
      await f.close();
    }
  }
});

test('trusted initializer receives readonly actual Run before first Model; missing record or implementation produces zero Model calls', async () => {
  for (const mode of ['ready', 'missing-record', 'missing-implementation'] as const) {
    let initializedRun = '';
    let modelCountAtInitialize = -1;
    let calls = 0;
    const ext: Extension = {
      ...extension([]),
      actions: [
        {
          id: 'seed',
          version: '1',
          description: 'Seed immutable executable metadata without a Model',
          inputSchema: { type: 'object' },
          async prepare(input) {
            return input;
          },
          async execute(_input, context) {
            await context.records.write({
              key: 'initial',
              expectedRevision: null,
              contentType: 'fixture.requirement',
              contentVersion: 4,
              value: { required: true },
              executable: true,
            });
            return { outcome: 'succeeded', content: 'seeded' };
          },
        },
      ],
    };
    const selected = createFixedModel([[finish]]);
    const f = await fixture(ext, [[finish]], () => ({
      async resolveRunConfiguration() {
        return {
          model: selected,
          modelId: 'initialized',
          snapshot: { fixture: 'per-run' },
          conditions:
            mode === 'missing-implementation'
              ? undefined
              : {
                  async evaluate(refs) {
                    calls++;
                    return refs.map((ref) => ({
                      requirement: ref,
                      recordRevision: ref.revision,
                      outcome: 'satisfied' as const,
                      evidence: { actual: 'initializer record' },
                    }));
                  },
                },
          async initializeRequirements({ command, run, session }) {
            initializedRun = run.id;
            modelCountAtInitialize = selected.requests.length;
            expect(Object.isFrozen(command)).toBe(true);
            expect(Object.isFrozen(run)).toBe(true);
            expect(Object.isFrozen(session)).toBe(true);
            expect(run.originCommandId).toBe(command.id);
            expect(session.id).toBe(run.sessionId);
            return [
              {
                ...declaration(mode === 'missing-record' ? 'absent' : 'initial', 'both'),
                extensionId: 'fixture',
                sessionId: session.id,
                runId: run.id,
              },
            ];
          },
        };
      },
    }));
    try {
      await f.runtime.submitCommand({
        ...f.base,
        commandId: 'seed',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'seed',
          definitionVersion: '1',
          input: {},
        },
      });
      await f.runtime.waitForCommand('seed', { timeoutMs: 4000 });
      await f.submit();
      const result = await f.done();
      expect(initializedRun).toBe(result.run!.id);
      expect(modelCountAtInitialize).toBe(0);
      expect(selected.requests).toHaveLength(mode === 'ready' ? 1 : 0);
      const models = (await f.store.listExecutions('s')).filter((value) => value.kind === 'model');
      expect(models.filter((value) => value.status === 'succeeded')).toHaveLength(
        mode === 'ready' ? 1 : 0,
      );
      expect(result.run!.status).toBe(mode === 'ready' ? 'completed' : 'failed');
      expect(result.run!.reason).toBe(
        mode === 'ready'
          ? null
          : mode === 'missing-record'
            ? 'record_revision_conflict'
            : 'necessary_condition_implementation_missing',
      );
      expect(calls).toBe(mode === 'ready' ? 2 : 0);
    } finally {
      await f.close();
    }
  }
});

test('background ordinary Job freezes original refs and retains per-Run evaluator/permissions after a newer Run binding replaces admission', async () => {
  const terminal = gate(),
    started = gate(),
    disposed = [gate(), gate()];
  const disposals = [0, 0],
    starts = [0, 0];
  const permissionCalls: { binding: number; kind: string }[] = [],
    conditionCalls: { binding: number; phase: string; refs: RequirementRef[] }[] = [];
  let ref: OperationRef | undefined,
    selected = 0,
    fallback = 0;
  const first = createFixedModel([calls('perrun.launch'), [finish]]),
    second = createFixedModel([[finish]]);
  const f = await fixture(extension([]), [[finish]], (store) => ({
    conditions: {
      async evaluate() {
        fallback++;
        throw new Error('global evaluator must not replace retained binding');
      },
    },
    async resolveRunConfiguration() {
      const index = selected++,
        version = String(index + 1);
      const conditions: NecessaryConditions = {
        async evaluate(refs, phase) {
          conditionCalls.push({ binding: index + 1, phase, refs: structuredClone([...refs]) });
          return Promise.all(
            refs.map(async (requirement) => {
              const record = await store.getExtensionRecord({
                sessionId: requirement.sessionId,
                extensionId: requirement.extensionId,
                key: requirement.recordKey,
              });
              expect(record!.revision).toBe(requirement.revision);
              return {
                requirement,
                recordRevision: record!.revision,
                outcome: 'satisfied' as const,
                evidence: { binding: index + 1, key: record!.key, record: record!.value },
              };
            }),
          );
        },
      };
      const ext: Extension = {
        ...extension([]),
        id: 'perrun',
        version,
        tools: [
          {
            ...tool('perrun.launch', async (_input, context) => {
              await write(context, 'first', { required: true });
              await context.requirements!.register([declaration('first')]);
              ref = await context.operations.ensure({
                key: 'background',
                cancellation: 'detached',
                request: {
                  kind: 'job',
                  definitionId: 'perrun.job',
                  definitionVersion: version,
                  input: {},
                },
              });
              await bounded(started.promise);
              await write(context, 'later', { required: true });
              await context.requirements!.register([declaration('later')]);
              return {
                outcome: 'succeeded',
                content: 'one background Job and two Run obligations',
              };
            }),
            version,
          },
        ],
        jobs: [
          {
            id: 'perrun.job',
            version,
            description: 'Harmless held background fact',
            inputSchema: { type: 'object' },
            async start() {
              starts[index]!++;
              started.release();
              return { reference: { binding: index + 1 } };
            },
            async *observe(): AsyncIterable<JobEvent> {
              await terminal.promise;
              yield {
                type: 'terminal',
                supervision: 'ended',
                result: { outcome: 'succeeded', content: 'original binding result' },
              };
            },
            async cancel() {
              terminal.release();
              return { status: 'stopped' };
            },
            async dispose() {},
          },
        ],
      };
      return {
        model: index === 0 ? first : second,
        modelId: `binding-${version}`,
        extensions: [ext],
        snapshot: { version },
        conditions,
        permissions: {
          async authorize(request) {
            permissionCalls.push({ binding: index + 1, kind: request.kind });
            return { allowed: request.kind !== 'job' || index === 0, revision: version };
          },
        },
        ...(index === 1
          ? {
              async initializeRequirements({ run, session }) {
                return [
                  {
                    ...declaration('first'),
                    extensionId: 'perrun',
                    sessionId: session.id,
                    runId: run.id,
                  },
                ];
              },
            }
          : {}),
        async dispose() {
          disposals[index]!++;
          disposed[index]!.release();
        },
      };
    },
  }));
  try {
    await f.submit('first');
    const original = await f.done('first');
    expect(original.run!.status).toBe('completed');
    expect(original.run!.requirements.map((item) => item.requirementId)).toEqual([
      'first',
      'later',
    ]);
    const frozen = (await f.store.getExecution(ref!.executionId!))!;
    expect(frozen.requirements.map((item) => item.requirementId)).toEqual(['first']);
    expect(frozen.requirements[0]!.runId).toBe(original.run!.id);
    expect(disposals[0]).toBe(0);
    await f.submit('second');
    const newer = await f.done('second');
    await bounded(disposed[1]!.promise);
    expect(newer.run!.status).toBe('completed');
    expect(newer.run!.id).not.toBe(original.run!.id);
    expect(disposals).toEqual([0, 1]);
    expect(
      conditionCalls.some((call) => call.binding === 2 && call.refs[0]!.runId === newer.run!.id),
    ).toBe(true);
    terminal.release();
    const job = await fact(async () => {
      const job = await f.store.getExecution(ref!.executionId!);
      return job?.status === 'succeeded' ? job : undefined;
    });
    await bounded(disposed[0]!.promise);
    expect(job.requirements).toEqual(frozen.requirements);
    expect(job.result).toMatchObject({ outcome: 'succeeded', content: 'original binding result' });
    expect(
      conditionCalls.some(
        (call) =>
          call.binding === 1 &&
          call.phase === 'completion' &&
          call.refs.length === 1 &&
          call.refs[0]!.runId === original.run!.id,
      ),
    ).toBe(true);
    expect(
      conditionCalls.some(
        (call) => call.binding === 2 && call.refs.some((ref) => ref.runId === original.run!.id),
      ),
    ).toBe(false);
    const jobPermissions = permissionCalls.filter((call) => call.kind === 'job');
    expect(jobPermissions.length).toBeGreaterThan(0);
    expect(jobPermissions.every((call) => call.binding === 1)).toBe(true);
    expect(permissionCalls.some((call) => call.binding === 2 && call.kind === 'model')).toBe(true);
    expect(starts).toEqual([1, 0]);
    expect(fallback).toBe(0);
    expect(first.requests).toHaveLength(2);
    expect(second.requests).toHaveLength(1);
    expect(disposals).toEqual([1, 1]);
    await f.runtime.close();
    expect(disposals).toEqual([1, 1]);
  } finally {
    terminal.release();
    await f.close();
  }
}, 10000);
