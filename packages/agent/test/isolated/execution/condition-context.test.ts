import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type {
  AcceptedInformation,
  Extension,
  JobEvent,
  OperationRef,
  RunInitializationContext,
  ToolContext,
  ToolDefinition,
} from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionAnswer, InteractionRecord, Store } from '../../../src/storage';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
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
    if (Date.now() > deadline) throw new Error('condition_context_timeout');
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
const tool = (id: string, execute: ToolDefinition['execute']): ToolDefinition => ({
  id,
  version: '1',
  description: 'Harmless scoped context fixture',
  inputSchema: { type: 'object', additionalProperties: false },
  execute,
});
const extension = (tools: ToolDefinition[]): Extension => ({
  id: 'fixture',
  version: '1',
  apiMajor: 1,
  tools,
  records: [
    {
      contentType: 'fixture.metadata',
      contentVersion: 1,
      schema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
        additionalProperties: false,
      },
    },
  ],
});
async function fixture(
  ext: Extension,
  responses: ModelEvent[][],
  options: (store: Store) => Partial<RuntimeOptions> = () => ({}),
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-condition-context-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const model = createFixedModel(responses);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    extensions: [ext],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'policy-1' };
      },
    },
    ...options(store),
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  const session = (id = 's') =>
    runtime.createSession({
      ...base,
      sessionId: id,
      commandId: `create-${id}`,
      workspaceId: 'w',
      title: id,
    });
  await session();
  const submit = (commandId = 'work', sessionId = 's') =>
    runtime.submitCommand({
      ...base,
      commandId,
      sessionId,
      request: { kind: 'run.start', content: commandId },
    });
  const done = async (id = 'work') => {
    const command = await runtime.waitForCommand(id, { timeoutMs: 5000 });
    const runId = (command.receipt as { runId?: string }).runId;
    return runId ? store.getRun(runId) : null;
  };
  const pending = (sessionId = 's', exclude: string[] = []) =>
    fact(
      async () =>
        (
          await runtime.listInteractions({ expectedStoreId, sessionId, state: 'pending' })
        ).interactions.find((r) => !exclude.includes(r.id)) ?? null,
    );
  const answer = (record: InteractionRecord, value: InteractionAnswer) =>
    runtime.answerInteraction({
      ...base,
      commandId: `answer-${record.id}`,
      presentationSessionId: record.presentationSessionId,
      interactionId: record.id,
      expectedRevision: record.revision,
      answer: value,
    });
  return {
    store,
    model,
    runtime,
    base,
    session,
    submit,
    done,
    pending,
    answer,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Run initializer seals actual metadata before Model and cannot retain write authority after the first Execution', async () => {
  for (const mode of ['enabled', 'namespace', 'schema', 'prefix', 'rewrite'] as const) {
    let retained: RunInitializationContext | undefined,
      key = '',
      effects = 0;
    const f = await fixture(
      extension([
        tool('fixture.retained', async () => {
          await rejected(
            retained!.records.create({
              key: `${key}-late`,
              contentType: 'fixture.metadata',
              contentVersion: 1,
              value: { enabled: true },
            }),
            'run_initialization_closed',
          );
          effects++;
          return { outcome: 'succeeded', content: 'retained metadata authority closed' };
        }),
      ]),
      [call('fixture.retained'), [finish]],
      (store) => ({
        async initializeRunRequirements(input) {
          expect(Object.isFrozen(input.run)).toBe(true);
          expect(await store.listExecutions('s')).toHaveLength(0);
          retained = await input.forExtension(mode === 'namespace' ? 'unselected' : 'fixture');
          expect('owner' in retained).toBe(false);
          expect('store' in retained).toBe(false);
          expect('write' in retained.records).toBe(false);
          key = `run/${input.run.id}/enabled`;
          const write = {
            key: mode === 'prefix' ? 'run/imagined/enabled' : key,
            contentType: 'fixture.metadata',
            contentVersion: 1,
            value: { enabled: true },
          };
          if (mode === 'schema')
            await retained.records.create({ ...write, value: { enabled: 'not-boolean' } });
          else {
            const record = await retained.records.create(write);
            expect(record.originStoreId).toBe(input.run.originStoreId);
            const retry = await retained.records.create(write);
            expect(retry).toEqual(record);
            if (mode === 'rewrite')
              await retained.records.create({ ...write, value: { enabled: false } });
          }
          return [
            {
              extensionId: 'fixture',
              sessionId: input.session.id,
              runId: input.run.id,
              requirementId: 'enabled',
              definitionVersion: '1',
              recordKey: key,
              revision: '1',
              phase: 'both',
            },
          ];
        },
        conditions: {
          async evaluate(refs, _phase, context) {
            return Promise.all(
              refs.map(async (requirement) => {
                const scoped = await context!.forRequirement(requirement);
                const record = await scoped.records.get(requirement.recordKey);
                expect(record!.value).toEqual({ enabled: true });
                expect(record!.key).toBe(`run/${requirement.runId}/enabled`);
                if (f.model.requests.length === 0) {
                  expect(context!.boundary.kind).toBe('model');
                  expect((await scoped.getExecution(context!.boundary.executionId!))!.status).toBe(
                    'planned',
                  );
                }
                return {
                  requirement,
                  recordRevision: record!.revision,
                  outcome: 'satisfied' as const,
                  evidence: { enabled: true },
                };
              }),
            );
          },
        },
      }),
    );
    try {
      await f.submit();
      const run = await f.done();
      if (mode === 'enabled') expect(run!.reason).toBeNull();
      expect(run!.status).toBe(mode === 'enabled' ? 'completed' : 'failed');
      expect(f.model.requests).toHaveLength(mode === 'enabled' ? 2 : 0);
      expect(effects).toBe(mode === 'enabled' ? 1 : 0);
      if (mode === 'enabled' || mode === 'rewrite') {
        const record = await f.store.getExtensionRecord({
          sessionId: 's',
          extensionId: 'fixture',
          key,
        });
        expect(record!.value).toEqual({ enabled: true });
        expect(record!.revision).toBe('1');
        expect(
          await f.store.getExtensionRecord({
            sessionId: 's',
            extensionId: 'fixture',
            key: `${key}-late`,
          }),
        ).toBeNull();
      }
      if (mode !== 'enabled')
        expect(run!.reason).toBe(
          {
            namespace: 'extension_not_available',
            schema: 'extension_record_format_unavailable',
            prefix: 'invalid_extension_record',
            rewrite: 'record_revision_conflict',
          }[mode],
        );
    } finally {
      await f.close();
    }
  }
});

test('automatic scoped condition reads reject a related-record race before Job start; unrelated writes do not block', async () => {
  for (const related of [true, false]) {
    const entered = gate(),
      resume = gate();
    let writer: ToolContext | undefined,
      operation: OperationRef | undefined,
      starts = 0,
      held = false,
      completion = false,
      jobCompletions = 0;
    const ext = extension([
      tool('fixture.writer', async (_input, context) => {
        writer = context;
        for (const key of ['required', 'plan', 'unrelated'])
          await context.records.write({
            key,
            expectedRevision: null,
            contentType: 'fixture.metadata',
            contentVersion: 1,
            value: { enabled: true },
            executable: true,
          });
        await context.requirements!.register([
          {
            requirementId: 'required',
            definitionVersion: '1',
            recordKey: 'required',
            revision: '1',
            phase: 'both',
          },
        ]);
        operation = await context.operations.ensure({
          key: 'job',
          cancellation: 'detached',
          request: { kind: 'job', definitionId: 'fixture.job', definitionVersion: '1', input: {} },
        });
        await context.operations.wait(operation);
        return { outcome: 'succeeded', content: 'Job result observed' };
      }),
    ]);
    const withJobs: Extension = {
      ...ext,
      jobs: [
        {
          id: 'fixture.job',
          version: '1',
          description: 'Harmless counted Job',
          inputSchema: { type: 'object' },
          async start() {
            starts++;
            return { reference: { started: true } };
          },
          async *observe(): AsyncIterable<JobEvent> {
            yield {
              type: 'terminal',
              supervision: 'ended',
              result: { outcome: 'succeeded', content: 'done' },
            };
          },
          async cancel() {
            return { status: 'stopped' };
          },
          async dispose() {},
        },
      ],
    };
    const f = await fixture(withJobs, [call('fixture.writer'), [finish]], () => ({
      conditions: {
        async evaluate(refs, phase, context) {
          expect(context).toBeDefined();
          const reads = await context!.forRequirement(refs[0]!);
          expect('write' in reads.records).toBe(false);
          expect('owner' in reads).toBe(false);
          await rejected(
            context!.forRequirement({ ...refs[0]!, extensionId: 'foreign' }),
            'requirement_scope_mismatch',
          );
          const requirement = await reads.records.get('required');
          await reads.records.get('plan');
          if (phase === 'completion') {
            if (context!.boundary.kind === 'job') {
              jobCompletions++;
              expect(context!.boundary.executionId).toBe(operation!.executionId);
              expect(context!.boundary.runId).toBeNull();
              const actual = await reads.getExecution(context!.boundary.executionId!);
              expect(actual!.status).toBe('running');
              expect(actual!.definitionId).toBe('fixture.job');
              expect(actual!.rootWorkCommandId).toBe('work');
              expect(actual!.originStoreId).toBe(f.base.expectedStoreId);
            } else {
              completion = true;
              expect(context!.boundary.executionId).toBeNull();
              expect(context!.boundary.kind).toBeNull();
            }
          }
          if (context!.boundary.kind === 'job' && !held) {
            held = true;
            const execution = await reads.getExecution(context!.boundary.executionId!);
            expect(execution!.status).toBe('planned');
            expect(execution!.originStoreId).toBe(f.base.expectedStoreId);
            expect(execution!.definitionId).toBe('fixture.job');
            expect(execution!.attempt).toBe(1);
            expect(execution!.rootWorkCommandId).toBe('work');
            expect(execution!.inputDigest).toBeString();
            entered.release();
            await resume.promise;
          }
          // Intentionally omit recordReads: the Core must carry actual reads into the final transaction.
          return refs.map((ref) => ({
            requirement: ref,
            recordRevision: requirement!.revision,
            outcome: 'satisfied' as const,
            evidence: { enabled: true },
          }));
        },
      },
    }));
    try {
      await f.submit();
      await fact(async () => (held ? true : null));
      await entered.promise;
      await writer!.records.write({
        key: related ? 'plan' : 'unrelated',
        expectedRevision: '1',
        contentType: 'fixture.metadata',
        contentVersion: 1,
        value: { enabled: false },
      });
      resume.release();
      const run = await f.done();
      const execution = await f.store.getExecution(operation!.executionId!);
      expect(starts).toBe(related ? 0 : 1);
      expect(execution!.status).toBe(related ? 'failed' : 'succeeded');
      expect(run!.status).toBe('completed');
      expect(completion).toBe(true);
      expect(jobCompletions).toBe(related ? 0 : 1);
      if (related)
        expect((execution!.result as { content: string }).content).toBe(
          'requirement_not_satisfied',
        );
    } finally {
      resume.release();
      await f.close();
    }
  }
});

test('scoped ordinary Job safety reads capture the actual boundary and fence a later unknown execution before adapter start', async () => {
  for (const race of [false, true]) {
    const resume = gate();
    let parent: ToolContext | undefined,
      original: OperationRef | undefined,
      observed = false,
      starts = 0;
    const ext: Extension = {
      ...extension([
        tool('fixture.parent', async (_input, context) => {
          parent = context;
          await context.records.write({
            key: 'job-safety',
            expectedRevision: null,
            contentType: 'fixture.metadata',
            contentVersion: 1,
            value: { enabled: true },
            executable: true,
          });
          await context.requirements!.register([
            {
              requirementId: 'job-safety',
              definitionVersion: '1',
              recordKey: 'job-safety',
              revision: '1',
              phase: 'dispatch',
            },
          ]);
          original = await context.operations.ensure({
            key: 'original',
            request: {
              kind: 'job',
              definitionId: 'fixture.original',
              definitionVersion: '1',
              input: {},
            },
          });
          await context.operations.wait(original);
          return { outcome: 'succeeded', content: 'original Job observed' };
        }),
      ]),
      jobs: ['original', 'other'].map((id) => ({
        id: `fixture.${id}`,
        version: '1',
        description: 'Harmless ordinary Job safety consumer',
        inputSchema: { type: 'object', additionalProperties: false },
        async start() {
          if (id === 'original') starts++;
          return { reference: { id } };
        },
        async *observe(): AsyncIterable<JobEvent> {
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: {
              outcome: id === 'other' ? 'outcome_unknown' : 'succeeded',
              content: 'actual ordinary Job result',
            },
          };
        },
        async cancel() {
          return { status: 'stopped' as const };
        },
        async dispose() {},
      })),
    };
    const f = await fixture(ext, [call('fixture.parent'), [finish]], () => ({
      conditions: {
        async evaluate(refs, phase, context) {
          expect(phase).toBe('dispatch');
          return Promise.all(
            refs.map(async (requirement) => {
              const read = await context!.forRequirement(requirement);
              await read.records.get(requirement.recordKey);
              const facts = await read.readRunExecutionSafety!(requirement.runId);
              expect(facts.originStoreId).toBe(f.base.expectedStoreId);
              if (context!.boundary.kind === 'job') {
                const job = await read.getExecution(context!.boundary.executionId!);
                expect(facts.excludedExecutionId).toBeNull();
                expect(facts.unconfirmedExecutionIds).toContain(job!.id);
                expect(facts.unconfirmedExecutionIds).toContain(job!.parentExecutionId!);
                expect(job!.status).toBe('planned');
                if (job!.definitionId === 'fixture.original' && !observed) {
                  observed = true;
                  await resume.promise;
                }
              }
              // Core captures the observation; this evaluator cannot inject or omit its CAS read.
              return {
                requirement,
                recordRevision: requirement.revision,
                outcome: 'satisfied' as const,
                evidence: {},
              };
            }),
          );
        },
      },
    }));
    try {
      await f.submit();
      await fact(async () => (observed ? true : null));
      if (race) {
        const other = await parent!.operations.ensure({
          key: 'independent-unknown',
          request: {
            kind: 'job',
            definitionId: 'fixture.other',
            definitionVersion: '1',
            input: {},
          },
        });
        await parent!.operations.wait(other);
        expect((await f.store.getExecution(other.executionId!))?.status).toBe('outcome_unknown');
      }
      resume.release();
      await f.done();
      const actual = await f.store.getExecution(original!.executionId!);
      expect(starts).toBe(race ? 0 : 1);
      expect(actual!.status).toBe(race ? 'failed' : 'succeeded');
      if (race)
        expect(actual!.result).toMatchObject({
          outcome: 'failed',
          content: 'requirement_not_satisfied',
          details: { adapterAttempted: false },
        });
      else expect(f.model.requests).toHaveLength(2);
    } finally {
      resume.release();
      await f.close();
    }
  }
}, 15000);

test('information receipts expose exact accepted facts and same-Session proofs without granting another Tool permission', async () => {
  const receipts: AcceptedInformation[] = [];
  let effects = 0,
    foreignId = '';
  const ext = extension([
    tool('fixture.foreign', async (_input, context) => {
      await context.requestInput!({ title: 'Other Session', schema: { type: 'object' } });
      return { outcome: 'succeeded', content: 'foreign answered' };
    }),
    tool('fixture.receipts', async (_input, context) => {
      expect(await context.getInteraction!(foreignId)).toBeNull();
      for (const kind of ['question', 'plan_review'] as const) {
        const receipt = await context.requestInteractionWithReceipt!({
          kind,
          request:
            kind === 'question'
              ? { title: 'Question', schema: { type: 'object' } }
              : { title: 'Plan review' },
        });
        receipts.push(receipt);
        const interaction = await context.getInteraction!(receipt.interactionId),
          execution = await context.getExecution(receipt.executionId);
        expect(interaction!.acceptedDecisionRevision).toBe(receipt.decisionRevision);
        expect(interaction!.revision).toBe(receipt.decisionRevision);
        expect(interaction!.answer).toEqual(receipt.answer);
        expect(interaction!.request).toEqual(receipt.request);
        expect(interaction!.executionId).toBe(execution!.id);
        expect(interaction!.attempt).toBe(execution!.attempt!);
        expect(interaction!.definitionId).toBe('fixture.receipts');
        expect(interaction!.inputDigest).toBe(execution!.inputDigest!);
        expect(execution!.rootWorkSeq).toBeString();
        expect(receipt.originStoreId).toBe(execution!.originStoreId!);
        expect(receipt.sessionId).toBe('s');
        expect(receipt.runId).toBe(execution!.runId);
        expect(execution!.originCommandId).toBe('work');
        expect(execution!.rootWorkCommandId).toBe('work');
      }
      return { outcome: 'succeeded', content: 'information accepted without authority' };
    }),
    tool('fixture.effect', async () => {
      effects++;
      return { outcome: 'succeeded', content: 'effect' };
    }),
  ]);
  const foreign = createFixedModel([call('fixture.foreign'), [finish]]);
  const f = await fixture(
    ext,
    [call('fixture.receipts'), call('fixture.effect'), [finish]],
    () => ({
      async resolveRunConfiguration({ command }) {
        return {
          model: command.sessionId === 'other' ? foreign : f.model,
          modelId: 'fixed',
          snapshot: null,
        };
      },
      permissions: {
        async authorize(input) {
          return { allowed: input.definitionId !== 'fixture.effect', revision: 'policy-1' };
        },
      },
    }),
  );
  try {
    await f.session('other');
    await f.submit('foreign-work', 'other');
    const other = await f.pending('other');
    foreignId = other.id;
    await f.submit();
    const question = await f.pending();
    await f.answer(question, { kind: 'question', answers: { confirmed: true } });
    const plan = await f.pending('s', [question.id]);
    await f.answer(plan, { kind: 'plan_review', decision: 'approve', mode: 'auto' });
    await f.done();
    expect(receipts).toHaveLength(2);
    expect(effects).toBe(0);
    const records = await f.store.listExecutions('s');
    expect(records.find((r) => r.definitionId === 'fixture.receipts')!.status).toBe('succeeded');
    expect(
      records.find((r) => r.definitionId === 'fixture.receipts')!.interactionBinding,
    ).toBeNull();
    expect(records.find((r) => r.definitionId === 'fixture.effect')!.status).toBe('failed');
    await f.answer(other, { kind: 'question', answers: {} });
    await f.done('foreign-work');
  } finally {
    await f.close();
  }
});
