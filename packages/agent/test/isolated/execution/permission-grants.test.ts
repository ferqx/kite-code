import { createHash } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src';
import {
  approvalOptions,
  type GrantOffer,
  grantDigest,
  grantScopeDigest,
} from '../../../src/permission-grants';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const offerFor = (scope: unknown, definitions = ['fixture.command']): GrantOffer => {
  const candidate = {
    ruleId: 'fixture.command',
    contractId: 'fixture.command-scope',
    scope: scope as import('../../../src/storage/types').Json,
    bindings: definitions.map((definitionId) => ({
      kind: 'tool' as const,
      definitionId,
      definitionVersion: '1',
    })),
    presentation: { label: '本会话相同命令', details: ['仅准确命令'] },
  };
  return {
    ...candidate,
    scopeDigest: grantScopeDigest(candidate),
    policyBindings: candidate.bindings.map((capability) => ({
      capability,
      reuseRevision: grantDigest({ policy: 'fixture.policy', scope: candidate.scope }),
    })),
  };
};
const scopeOption = (request: unknown): string =>
  (request as { options: { optionId: string; kind: string }[] }).options.find(
    (option) => option.kind === 'scope',
  )!.optionId;
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (text: string, key?: string, name = 'fixture.command'): ModelEvent[] => [
  {
    type: 'tool_call',
    id: crypto.randomUUID(),
    name,
    arguments: JSON.stringify({ command: text, cwd: 'original', ...(key ? { key } : {}) }),
  },
  { ...finish, reason: 'tool_calls' },
];
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error('permission_grant_fixture_timeout');
    await sleepTimer(10);
  }
}
async function exactBusinessTool(
  store: Store,
  publicCommandId: string,
  runtime: ReturnType<typeof createRuntime>,
) {
  const original = (await store.getCommand(publicCommandId))!;
  expect(original.status).toBe('applied');
  const receipt = original.receipt as { runId: string };
  expect(receipt.runId).toBeString();
  expect(original.receipt).toEqual({ runId: receipt.runId });
  const run = (await store.getRun(receipt.runId))!;
  expect(original.rootWorkCommandId).toBe(original.id);
  expect(run).toMatchObject({
    originStoreId: original.originStoreId,
    sessionId: original.sessionId,
    originCommandId: original.id,
    rootWorkCommandId: original.id,
    rootWorkSeq: original.rootWorkSeq,
  });
  const model = (await store.listExecutions(original.sessionId)).find(
    (execution) => execution.kind === 'model' && execution.runId === run.id,
  )!;
  expect(model).toMatchObject({
    originStoreId: original.originStoreId,
    sessionId: original.sessionId,
    originCommandId: original.id,
    rootWorkCommandId: original.id,
    rootWorkSeq: original.rootWorkSeq,
  });
  const input = await runtime.readModelInput({
    expectedStoreId: original.originStoreId,
    sessionId: original.sessionId,
    subjectId: original.subjectId,
    executionId: model.id,
  });
  expect(input.confirmation).toBe('succeeded');
  expect(
    input.request.messages.find(
      (message) => message.content === (original.request as { content: string }).content,
    )?.sourceIds,
  ).toEqual([original.id]);
  const tool = (await store.listExecutions(original.sessionId)).find(
    (execution) =>
      execution.kind === 'tool' &&
      execution.runId === run.id &&
      execution.originCommandId === original.id,
  );
  expect(tool).toBeDefined();
  expect(tool).toMatchObject({
    originStoreId: original.originStoreId,
    sessionId: original.sessionId,
    rootWorkCommandId: original.id,
    rootWorkSeq: original.rootWorkSeq,
  });
  return tool!;
}
async function fixture(
  responses: ModelEvent[][],
  trustedDigest?: (input: unknown) => string,
  definitions = ['fixture.command'],
  changingRevision = false,
) {
  const root = realpathSync(temporaryDirectory('kite-grant-core-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  let held = false,
    release!: () => void,
    arrived!: () => void;
  const atDispatch = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const effects: unknown[] = [];
  let hardDenied = false;
  const proxy = new Proxy(store, {
    get(target, key) {
      if (key === 'markDispatching')
        return async (input: Parameters<Store['markDispatching']>[0]) => {
          const execution = await store.getExecution(input.executionId);
          if (held && execution?.kind === 'tool') {
            held = false;
            arrived();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return store.markDispatching(input);
        };
      return Reflect.get(target, key);
    },
  });
  const model = createFixedModel(responses);
  let independent = false;
  let independentHuman = false;
  const reviewer = createFixedModel(
    ['approve_once', 'reject'].map((decision) => [
      {
        type: 'text_delta' as const,
        text: JSON.stringify({ decision, reason: 'independent trusted checker' }),
      },
      finish,
    ]),
  );
  const runtime = createRuntime({
    store: proxy,
    model,
    modelId: 'fixed',
    authorizationCheck: {
      id: 'independent.checker',
      version: '1',
      modelId: 'review',
      model: reviewer,
    },
    permissions: {
      async authorize(request) {
        if (request.kind !== 'model' && hardDenied)
          return { allowed: false, revision: 'revoked-policy', reason: 'hard_capability_denied' };
        if (request.kind === 'model') return { allowed: true, revision: 'policy' };
        const offer = offerFor(
          trustedDigest ? trustedDigest(request.input) : request.input,
          definitions,
        );
        return {
          allowed: false,
          revision: changingRevision
            ? grantDigest({ input: request.input, independent })
            : 'policy',
          grantOffers: definitions.includes(request.definitionId) ? [offer] : [],
          ...(independent
            ? {
                check: {
                  request: { kind: 'independent', invocation: request.input },
                  ...(independentHuman ? { requireApproval: true } : {}),
                },
              }
            : {}),
          approval: {
            request: { title: 'Exact command' },
            options: approvalOptions(definitions.includes(request.definitionId) ? [offer] : []),
          },
        };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: ['fixture.command', 'fixture.write', 'fixture.third'].map((id) => ({
          id,
          version: '1',
          description: 'Harmless explicit command',
          inputSchema: { type: 'object' },
          async execute(input) {
            effects.push(input);
            return { outcome: 'succeeded', content: 'done' };
          },
        })),
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'Temporary',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 's',
  });
  const submit = (commandId: string, sessionId = 's', content = commandId) =>
    runtime.submitCommand({
      expectedStoreId,
      subjectId: 'owner',
      commandId,
      sessionId,
      request: { kind: 'run.start', content },
    });
  const terminal = (commandId: string) =>
    until(async () => {
      const command = await store.getCommand(commandId);
      const id = (command?.receipt as { runId?: string })?.runId;
      if (!id) return null;
      const run = await store.getRun(id);
      return run && !run.isActive ? run : null;
    });
  const pending = () =>
    until(
      async () =>
        (await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
          .interactions[0] ?? null,
    );
  return {
    reviewer,
    enableIndependentChecker(human = false) {
      independent = true;
      independentHuman = human;
    },
    denyCapability() {
      hardDenied = true;
    },
    store,
    runtime,
    model,
    effects,
    expectedStoreId,
    submit,
    terminal,
    pending,
    atDispatch,
    hold() {
      held = true;
    },
    release() {
      release?.();
    },
    async close() {
      release?.();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual accepted same_command applies only to exact original Session and full command parameters', async () => {
  const f = await fixture([
    call('original'),
    [finish],
    call('original'),
    [finish],
    call('changed'),
    [finish],
  ]);
  try {
    await f.submit('first');
    const card = await f.pending();
    expect(
      (card.request as { options: { kind: string }[] }).options.some(
        (option) => option.kind === 'scope',
      ),
    ).toBe(true);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: scopeOption(card.request) },
    });
    expect((await f.terminal('first')).status).toBe('completed');
    const page = await f.store.listPermissionGrants({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.grant.interactionId).toBe(card.id);
    const before = f.model.requests.length;
    await f.store.listPermissionGrants({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
    });
    expect(f.model.requests.length).toBe(before);
    await f.submit('second', 's', 'New task: second');
    expect((await f.terminal('second')).status).toBe('completed');
    await exactBusinessTool(f.store, 'second', f.runtime);
    expect(f.effects).toHaveLength(2);
    expect(
      (
        await f.runtime.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions,
    ).toHaveLength(0);
    await f.submit('different', 's', 'New task: different');
    const different = await f.pending();
    expect(different.id).not.toBe(card.id);
    expect(f.effects).toHaveLength(2);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'deny-different',
      presentationSessionId: 's',
      interactionId: different.id,
      expectedRevision: different.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    await f.terminal('different');
    await exactBusinessTool(f.store, 'different', f.runtime);
    const foreign = await f.store
      .listPermissionGrants({ expectedStoreId: 'foreign', subjectId: 'owner', sessionId: 's' })
      .catch((error) => error);
    expect(foreign.code).toBe('store_identity_mismatch');
    const other = await f.store
      .listPermissionGrants({
        expectedStoreId: f.expectedStoreId,
        subjectId: 'other',
        sessionId: 's',
      })
      .catch((error) => error);
    expect(other.code).toBe('permission_grant_scope_denied');
  } finally {
    await f.close();
  }
});

test('clear is durable CAS and final dispatch transaction rejects a proof captured before revocation', async () => {
  const f = await fixture([call('original'), [finish], call('original'), [finish]]);
  try {
    await f.submit('first');
    const card = await f.pending();
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: scopeOption(card.request) },
    });
    await f.terminal('first');
    const page = await f.store.listPermissionGrants({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
    });
    f.hold();
    await f.submit('second', 's', 'New task: second');
    await f.atDispatch;
    const intent = {
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'clear',
      ifRevision: page.revision,
    };
    const cleared = await f.store.clearPermissionGrants(intent);
    expect(cleared.state).toBe('applied');
    expect(await f.store.clearPermissionGrants(intent)).toEqual(cleared);
    const stale = await f.store
      .clearPermissionGrants({ ...intent, commandId: 'stale' })
      .catch((error) => error);
    expect(stale.code).toBe('host_control_conflict');
    f.release();
    await f.terminal('second');
    expect(f.effects).toHaveLength(1);
    const target = await exactBusinessTool(f.store, 'second', f.runtime);
    expect(target.status).not.toBe('succeeded');
    expect(
      (
        await f.store.listPermissionGrants({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          sessionId: 's',
        })
      ).items,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('trusted command semantics permits a new logical operation key but another Session still needs its own approval', async () => {
  const digest = (input: unknown) => {
    const value = input as { command: string; cwd: string };
    return createHash('sha256')
      .update(
        JSON.stringify({
          namespace: 'fixture.command@1',
          command: value.command,
          cwd: value.cwd,
          env: { fixed: 'fixture' },
          runner: 'fixed-local',
        }),
      )
      .digest('hex');
  };
  const f = await fixture(
    [
      call('original', 'one'),
      [finish],
      call('original', 'two'),
      [finish],
      call('original', 'three'),
      [finish],
    ],
    digest,
  );
  try {
    await f.submit('first');
    const card = await f.pending();
    expect(
      (card.request as unknown as { options: GrantOffer[] }).options.find(
        (option) => option.scopeDigest,
      )!.scope,
    ).toBe(digest({ command: 'original', cwd: 'original' }));
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: scopeOption(card.request) },
    });
    await f.terminal('first');
    await f.submit('second', 's', 'New task: second');
    await f.terminal('second');
    await exactBusinessTool(f.store, 'second', f.runtime);
    expect(f.effects).toEqual([
      { command: 'original', cwd: 'original', key: 'one' },
      { command: 'original', cwd: 'original', key: 'two' },
    ]);
    const page = await f.store.listPermissionGrants({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
    });
    expect(page.items[0]!.grant.scope).toBe(digest({ command: 'original', cwd: 'original' }));
    await f.runtime.createSession({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'create-other',
      sessionId: 'other',
      workspaceId: 'w',
      title: 'other',
    });
    await f.submit('third', 'other');
    const other = await until(
      async () =>
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 'other',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
    expect(other.sessionId).toBe('other');
    expect(f.effects).toHaveLength(2);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'deny-other',
      presentationSessionId: 'other',
      interactionId: other.id,
      expectedRevision: other.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    await f.terminal('third');
  } finally {
    await f.close();
  }
});

test('approve_once creates no session grant, and an existing same-command grant never defeats current hard denial', async () => {
  const once = await fixture([call('original'), [finish]]);
  try {
    await once.submit('once');
    const card = await once.pending();
    await once.runtime.answerInteraction({
      expectedStoreId: once.expectedStoreId,
      subjectId: 'owner',
      commandId: 'answer-once',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
    });
    await once.terminal('once');
    expect(once.effects).toHaveLength(1);
    expect(
      (
        await once.store.listPermissionGrants({
          expectedStoreId: once.expectedStoreId,
          subjectId: 'owner',
          sessionId: 's',
        })
      ).items,
    ).toHaveLength(0);
  } finally {
    await once.close();
  }
  const granted = await fixture([call('original'), [finish], call('original'), [finish]]);
  try {
    await granted.submit('first');
    const card = await granted.pending();
    await granted.runtime.answerInteraction({
      expectedStoreId: granted.expectedStoreId,
      subjectId: 'owner',
      commandId: 'answer-grant',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: scopeOption(card.request) },
    });
    await granted.terminal('first');
    granted.denyCapability();
    await granted.submit('denied', 's', 'New task: denied');
    await granted.terminal('denied');
    expect(granted.effects).toHaveLength(1);
    const execution = await exactBusinessTool(granted.store, 'denied', granted.runtime);
    expect(execution.status).toBe('failed');
    expect(execution.result).toMatchObject({
      outcome: 'failed',
      content: expect.stringContaining('Permission denied; this tool was not executed.'),
    });
  } finally {
    await granted.close();
  }
});

test('one frozen range authorizes another bound definition with a new input and complete policy revision, never a third definition', async () => {
  const f = await fixture(
    [
      call('first'),
      [finish],
      call('new-body', undefined, 'fixture.write'),
      [finish],
      call('third-body', undefined, 'fixture.third'),
      [finish],
    ],
    () => 'precise-position',
    ['fixture.command', 'fixture.write'],
    true,
  );
  try {
    await f.submit('edit');
    const card = await f.pending();
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'approve-range',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: scopeOption(card.request) },
    });
    await f.terminal('edit');
    await f.submit('write');
    await f.terminal('write');
    expect(f.effects).toEqual([
      { command: 'first', cwd: 'original' },
      { command: 'new-body', cwd: 'original' },
    ]);
    const write = (await f.store.listExecutions('s')).find(
      (execution) => execution.kind === 'tool' && execution.definitionId === 'fixture.write',
    )!;
    expect(write.status).toBe('succeeded');
    await f.submit('third');
    const third = await f.pending();
    expect(
      (third.request as { options: { kind: string }[] }).options.map((option) => option.kind),
    ).toEqual(['once']);
    expect(f.effects).toHaveLength(2);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'deny-third',
      presentationSessionId: 's',
      interactionId: third.id,
      expectedRevision: third.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    await f.terminal('third');
    const grants = await f.store.listPermissionGrants({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
    });
    expect(grants.items).toHaveLength(1);
    expect(grants.items[0]!.grant.definitionId).toBe('fixture.command');
    expect(grants.items[0]!.grant.bindings.map((binding) => binding.definitionId)).toEqual([
      'fixture.command',
      'fixture.write',
    ]);
  } finally {
    await f.close();
  }
});

test('a reused range still executes its independent checker, carries the result through final dispatch, and its rejection has zero effects', async () => {
  const f = await fixture(
    [
      call('original', 'one'),
      [finish],
      call('original', 'two'),
      [finish],
      call('original', 'three'),
      [finish],
    ],
    () => 'one-exact-command',
    ['fixture.command'],
    true,
  );
  try {
    await f.submit('first');
    const card = await f.pending();
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'approve-range',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: scopeOption(card.request) },
    });
    await f.terminal('first');
    f.enableIndependentChecker();
    await f.submit('second');
    await f.terminal('second');
    expect(f.effects).toHaveLength(2);
    expect(f.reviewer.requests).toHaveLength(1);
    expect(
      (await f.runtime.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
        .interactions,
    ).toHaveLength(1);
    await f.submit('third');
    await f.terminal('third');
    expect(f.reviewer.requests).toHaveLength(2);
    expect(f.effects).toHaveLength(2);
    const third = (await f.store.listExecutions('s')).find(
      (execution) => execution.kind === 'tool' && execution.originCommandId === 'third',
    )!;
    expect(third.status).toBe('failed');
    expect(third.result).toMatchObject({
      outcome: 'failed',
      details: { code: 'permission_denied', adapterAttempted: false, dispatchCommitted: false },
    });
  } finally {
    await f.close();
  }
});

test('a range never removes a custom checker independently required human approval when no coverage was declared', async () => {
  const f = await fixture(
    [call('original', 'one'), [finish], call('original', 'two'), [finish]],
    () => 'one-exact-command',
    ['fixture.command'],
    true,
  );
  try {
    await f.submit('first');
    const first = await f.pending();
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'approve-range',
      presentationSessionId: 's',
      interactionId: first.id,
      expectedRevision: first.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: scopeOption(first.request) },
    });
    await f.terminal('first');
    f.enableIndependentChecker(true);
    await f.submit('second');
    const required = await f.pending();
    expect(required.id).not.toBe(first.id);
    expect(f.reviewer.requests).toHaveLength(1);
    expect(f.effects).toHaveLength(1);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'deny-independent',
      presentationSessionId: 's',
      interactionId: required.id,
      expectedRevision: required.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    await f.terminal('second');
    expect(f.effects).toHaveLength(1);
  } finally {
    await f.close();
  }
});
