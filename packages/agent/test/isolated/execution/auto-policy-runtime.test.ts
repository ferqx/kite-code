import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFixedModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { createPermissionPolicy } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (id: string, value = 1): ModelEvent[] => [
  { type: 'tool_call', id, name: 'fixture.effect', arguments: JSON.stringify({ value }) },
  { ...finish, reason: 'tool_calls' },
];
async function fixture(options: {
  slow?: boolean;
  reject?: boolean;
  different?: boolean;
  fallback?: boolean;
  customCheckOnly?: boolean;
  human?: boolean;
  parallel?: boolean;
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-auto-policy-')));
  const profile = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(profile);
  let effects = 0,
    reviews = 0;
  const reviewInputs: ModelRequest[] = [];
  const model = createFixedModel([
    ...(options.parallel
      ? [
          [
            ...call('first').slice(0, 1),
            ...call('second').slice(0, 1),
            { ...finish, reason: 'tool_calls' } as ModelEvent,
          ],
        ]
      : [call('first'), call('second', options.different ? 2 : 1)]),
    [{ type: 'text_delta', text: 'Explained the actual outcomes.' }, finish],
  ]);
  const reviewer: ModelAdapter = {
    async *stream(input) {
      reviews++;
      reviewInputs.push(structuredClone(input));
      const payload = JSON.parse(
        input.messages.find((message) => message.role === 'user')!.content,
      );
      expect(payload.authorizationContext).toMatchObject({ availability: 'available' });
      expect(payload.authorizationContext.taskInputs).toContainEqual(
        expect.objectContaining({ source: 'user', kind: 'run.start' }),
      );
      expect(payload.decisionContext).toBeUndefined();
      if (options.slow) await new Promise((resolve) => setTimeout(resolve, 150));
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          decision: options.reject ? 'reject' : 'approve_once',
          reason: 'Fixture operation decision.',
        }),
      };
      yield finish;
    },
  };
  const policy = createPermissionPolicy({
    readCheckContext: () => ({
      reviewInput: 'task_authorization',
      task: { availability: 'available' },
      plan: null,
      rejectionReasons: [],
    }),
    readPolicy: () => ({
      mode: 'auto',
      workspaceTrust: true,
      revision: 'current',
      allowed: [
        { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
        { kind: 'tool', definitionId: 'fixture.effect', definitionVersion: '1' },
      ],
    }),
    describeCapability: (request) => ({
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      revision: 'effect-1',
      hardAllowed: true,
      safeRead: false,
      effects: request.kind === 'model' ? [] : ['workspace_write'],
      ...(options.fallback !== false ? { autoTimeoutScope: 'governed' as const } : {}),
    }),
  });
  const permissions = {
    async authorize(request: Parameters<typeof policy.authorize>[0]) {
      const decision = await policy.authorize(request);
      if (options.customCheckOnly && decision.check) {
        const { timeoutScope: _scope, ...check } = decision.check;
        return { ...decision, check };
      }
      return options.human && decision.check
        ? { ...decision, check: { ...decision.check, requireApproval: true } }
        : decision;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    permissions,
    authorizationCheck: {
      id: 'checker',
      version: '1',
      modelId: 'reviewer',
      model: reviewer,
      timeoutMs: 40,
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'One governed fixture effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'Effect confirmed.' };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'test',
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Auto policy',
  });
  return {
    runtime,
    store,
    model,
    reviewInputs,
    counts: () => ({ effects, reviews }),
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Perform these governed operations.' },
      });
      await runtime.waitForCommand('work');
      return (await store.getView('s')).runs[0]!;
    },
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Auto timeout continues governed effects, records timeout rather than approval, and ignores late rejection', async () => {
  const f = await fixture({ slow: true, reject: true });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 2 });
    const executions = await f.store.listExecutions('s');
    const checks = executions.filter((e) => e.definitionId === 'reviewer');
    expect(checks).toHaveLength(2);
    expect(
      checks.every(
        (e) =>
          e.status === 'failed' &&
          (e.result as { code: string }).code === 'authorization_check_timeout',
      ),
    ).toBe(true);
    expect(executions.filter((e) => e.kind === 'tool').every((e) => e.status === 'succeeded')).toBe(
      true,
    );
    expect(
      (
        await f.runtime.listInteractions({
          expectedStoreId: (await f.store.getMetadata()).storeId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions,
    ).toHaveLength(0);
    expect(f.model.requests.at(-1)!.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('an unchanged approved operation reuses actual approval without another reviewer call', async () => {
  const f = await fixture({});
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 1 });
    const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.every((e) => e.status === 'succeeded')).toBe(true);
    const actual = f.reviewInputs[0]!;
    const scope = {
      expectedStoreId: (await f.store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
      executionId: actual.requestId,
    };
    const first = await f.runtime.readModelInput(scope);
    const second = await f.runtime.readModelInput(scope);
    expect(first.request).toEqual(actual);
    expect(second.request).toEqual(actual);
    expect(second.bodyHash).toBe(first.bodyHash);
    const publicMaterial = JSON.parse(
      first.request.messages.find((message) => message.role === 'user')!.content,
    );
    expect(Object.hasOwn(publicMaterial, 'decisionContext')).toBe(false);
    expect(publicMaterial.authorizationContext.taskInputs).toContainEqual(
      expect.objectContaining({ source: 'user', kind: 'run.start' }),
    );
  } finally {
    await f.close();
  }
});

test('a changed operation is reviewed independently', async () => {
  const f = await fixture({ different: true });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 2 });
  } finally {
    await f.close();
  }
});

test('ordinary Auto timeout defaults to normal tool execution without capability-specific opt-in', async () => {
  const f = await fixture({ slow: true, fallback: false });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 2 });
    const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.every((tool) => tool.authorization?.policy?.reason === 'timeout_continue')).toBe(
      true,
    );
    expect(tools.every((tool) => tool.status === 'succeeded')).toBe(true);
  } finally {
    await f.close();
  }
});

test('an explicit custom check-only policy retains its own unexecuted timeout contract', async () => {
  const f = await fixture({ slow: true, customCheckOnly: true });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 0, reviews: 2 });
    const last = f.model.requests.at(-1)!.messages.filter((m) => m.role === 'tool');
    expect(last).toHaveLength(2);
    expect(last.every((m) => String(m.content).includes('not executed'))).toBe(true);
  } finally {
    await f.close();
  }
});

test('review timeout preserves the original independent human approval and executes only after its answer', async () => {
  const f = await fixture({ slow: true, human: true });
  try {
    const work = f.run();
    void work.catch(() => {});
    const expectedStoreId = (await f.store.getMetadata()).storeId;
    for (let i = 0; i < 2; i++) {
      let card:
        | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
        | undefined;
      const deadline = Date.now() + 3000;
      while (!card && Date.now() < deadline) {
        card = (
          await f.runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
        ).interactions[0];
        if (!card) await Bun.sleep(5);
      }
      expect(card).toBeDefined();
      expect(f.counts().effects).toBe(i);
      expect(card!.request).toMatchObject({ policy: { kind: 'approval_after_check_timeout' } });
      await f.runtime.answerInteraction({
        expectedStoreId,
        commandId: `answer-${i}`,
        presentationSessionId: 's',
        interactionId: card!.id,
        expectedRevision: card!.revision,
        subjectId: 'owner',
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
    }
    expect((await work).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 2 });
  } finally {
    await f.close();
  }
});

test('equivalent concurrent calls share one in-flight review while keeping both actual effects', async () => {
  const f = await fixture({ parallel: true });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 1 });
    expect((await f.store.listExecutions('s')).filter((e) => e.kind === 'tool')).toHaveLength(2);
  } finally {
    await f.close();
  }
});
