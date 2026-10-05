import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { Permissions, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionAnswer, InteractionRecord } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name = 'fixture.effect', input: unknown = {}): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
async function eventually<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}
async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
const base = {
  id: 'fixture.effect',
  version: '1',
  description: 'Harmless explicit effect',
  inputSchema: { type: 'object' },
} as const;
function ask(): Permissions {
  return {
    async authorize(request) {
      return request.kind === 'model'
        ? { allowed: true, revision: 'policy-1' }
        : { allowed: false, revision: 'policy-1', approval: { request: { title: 'Exact call' } } };
    },
  };
}
async function fixture(
  tools: ToolDefinition[],
  responses: ModelEvent[][],
  permissions = ask(),
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-core-interactions-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const model = createFixedModel(responses);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    processConcurrency: 1,
    permissions,
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools }],
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  const session = (id = 's') =>
    runtime.createSession({
      expectedStoreId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'w',
      title: id,
      subjectId: 'owner',
    });
  await session();
  const submit = (id = 'work', sessionId = 's') =>
    runtime.submitCommand({
      expectedStoreId,
      commandId: id,
      sessionId,
      subjectId: 'owner',
      request: { kind: 'run.start', content: id },
    });
  const pending = (sessionId = 's', excluded: string[] = []) =>
    eventually(async () => {
      const page = await runtime.listInteractions({ expectedStoreId, sessionId, state: 'pending' });
      return page.interactions.find((record) => !excluded.includes(record.id)) ?? null;
    }, 'pending interaction');
  const answer = (
    record: InteractionRecord,
    value: InteractionAnswer,
    commandId = `answer-${record.id}`,
  ) =>
    runtime.answerInteraction({
      expectedStoreId,
      commandId,
      presentationSessionId: record.presentationSessionId,
      interactionId: record.id,
      expectedRevision: record.revision,
      subjectId: 'owner',
      answer: value,
    });
  const read = (record: InteractionRecord) =>
    runtime.getInteraction({ expectedStoreId, sessionId: 's', interactionId: record.id });
  return {
    root,
    store,
    runtime,
    model,
    expectedStoreId,
    session,
    submit,
    pending,
    answer,
    read,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const change of [
  'revision',
  'deny_same_revision',
  'approval_same_revision',
  'review_same_revision',
  'none',
] as const) {
  test(`information acceptance rechecks bound permissions: ${change}`, async () => {
    let changed = false,
      proofs = 0;
    const permissions: Permissions = {
      async authorize(request) {
        if (request.kind === 'model') return { allowed: true, revision: 'model' };
        if (!changed || change === 'none') return { allowed: true, revision: 'policy-1' };
        if (change === 'revision') return { allowed: true, revision: 'policy-2' };
        if (change === 'deny_same_revision') return { allowed: false, revision: 'policy-1' };
        return {
          allowed: false,
          revision: 'policy-1',
          ...(change === 'approval_same_revision'
            ? { approval: { request: { title: 'new approval' } } }
            : { review: { request: { title: 'new review' } } }),
        };
      },
    };
    const f = await fixture(
      [
        {
          ...base,
          async execute(_input, context) {
            await context.requestInteractionWithReceipt!({
              kind: 'question',
              request: {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['waive'],
                  properties: { waive: { type: 'boolean' } },
                },
              },
            });
            proofs++;
            return { outcome: 'succeeded', content: 'accepted actual information' };
          },
        },
      ],
      [call(), [finish]],
      permissions,
      {
        resolveRunConfiguration: async () => ({
          model: createFixedModel([call(), [finish]]),
          modelId: 'bound',
          snapshot: {},
          permissions,
        }),
        permissions: { authorize: async () => ({ allowed: false, revision: 'wrong-global' }) },
      },
    );
    try {
      await f.submit();
      const question = await f.pending();
      expect(question.kind).toBe('question');
      expect(question.informationPermission?.revision).toBe('policy-1');
      await rejected(
        f.runtime.answerInteraction({
          expectedStoreId: f.expectedStoreId,
          commandId: 'foreign-answer',
          presentationSessionId: 's',
          interactionId: question.id,
          expectedRevision: question.revision,
          subjectId: 'foreign',
          answer: { kind: 'question', answers: { waive: true } },
        }),
        'interaction_scope_denied',
      );
      changed = true;
      await f.answer(question, { kind: 'question', answers: { waive: true } });
      await f.runtime.waitForCommand('work');
      const stored = await f.read(question);
      expect(stored?.acceptedDecisionRevision).toBe(change === 'none' ? '2' : null);
      expect(proofs).toBe(change === 'none' ? 1 : 0);
      expect((await f.store.listExecutions('s')).filter((e) => e.kind === 'tool')).toHaveLength(1);
      expect((await f.store.getExecution(question.executionId))?.interactionBinding).toBeNull();
      expect(
        (
          await f.store.listPermissionGrants({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            limit: 10,
          })
        ).items,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 10000);
}
test('already approved exact Tool can ask information without obtaining a second grant', async () => {
  let proofs = 0;
  const f = await fixture(
    [
      {
        ...base,
        async execute(_input, context) {
          await context.requestInteractionWithReceipt!({
            kind: 'question',
            request: { schema: { type: 'object' } },
          });
          proofs++;
          return { outcome: 'succeeded', content: 'actual question accepted' };
        },
      },
    ],
    [call(), [finish]],
    ask(),
  );
  try {
    await f.submit();
    const approval = await f.pending();
    await f.answer(approval, { kind: 'approval', decision: 'approve', grant: 'approve_once' });
    const question = await f.pending('s', [approval.id]);
    expect(question.kind).toBe('question');
    await f.answer(question, { kind: 'question', answers: {} });
    await f.runtime.waitForCommand('work');
    expect(proofs).toBe(1);
    expect((await f.read(question))?.acceptedDecisionRevision).toBe('2');
  } finally {
    await f.close();
  }
}, 10000);

test('generic waived safety condition records actual reads and permits the next Model and completion', async () => {
  let toolFact: unknown,
    accepted = false,
    safetyReads = 0;
  const f = await fixture(
    [
      {
        ...base,
        async execute(_input, context) {
          toolFact = await context.readRunExecutionSafety!(context.runId!);
          await context.requestInteractionWithReceipt!({
            kind: 'question',
            request: { schema: { type: 'object' } },
          });
          accepted = true;
          return { outcome: 'succeeded', content: 'accepted finite decision' };
        },
      },
    ],
    [call(), [finish]],
    { authorize: async () => ({ allowed: true, revision: 'fixed' }) },
    {
      async initializeRunRequirements(input) {
        const context = await input.forExtension('fixture');
        const key = `run/${input.run.id}/safety`;
        const record = await context.records.create({
          key,
          contentType: 'safe',
          contentVersion: 1,
          value: { required: true },
        });
        return [
          {
            extensionId: 'fixture',
            requirementId: 'safe',
            definitionVersion: '1',
            recordKey: key,
            revision: record.revision,
            sessionId: 's',
            runId: input.run.id,
            phase: 'completion',
            evaluationProvider: 'extension',
          },
        ];
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          records: [{ contentType: 'safe', contentVersion: 1, schema: { type: 'object' } }],
          tools: [
            {
              ...base,
              async execute(_input, context) {
                toolFact = await context.readRunExecutionSafety!(context.runId!);
                await context.requestInteractionWithReceipt!({
                  kind: 'question',
                  request: { schema: { type: 'object' } },
                });
                accepted = true;
                return { outcome: 'succeeded', content: 'accepted finite decision' };
              },
            },
          ],
          conditions: {
            async evaluate(refs, _phase, context) {
              return Promise.all(
                refs.map(async (ref) => {
                  const read = await context!.forRequirement(ref);
                  const fact = await read.readRunExecutionSafety!(ref.runId);
                  safetyReads++;
                  return {
                    requirement: ref,
                    recordRevision: ref.revision,
                    outcome:
                      accepted && !fact.unconfirmed
                        ? ('waived' as const)
                        : ('unsatisfied' as const),
                    evidence: {},
                  };
                }),
              );
            },
          },
        },
      ],
    },
  );
  try {
    await f.submit();
    const question = await f.pending();
    expect(toolFact).toMatchObject({ unconfirmed: false, runId: question.runId });
    await f.answer(question, { kind: 'question', answers: {} });
    await f.runtime.waitForCommand('work');
    expect((await f.store.getRun(question.runId!))?.status).toBe('completed');
    expect(f.model.requests).toHaveLength(2);
    expect(safetyReads).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
}, 10000);
