import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (text: string, key?: string): ModelEvent[] => [
  {
    type: 'tool_call',
    id: crypto.randomUUID(),
    name: 'fixture.command',
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
    await Bun.sleep(10);
  }
}
async function fixture(responses: ModelEvent[][], trustedDigest?: (input: unknown) => string) {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-grant-core-'));
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
  const runtime = createRuntime({
    store: proxy,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize(request) {
        if (request.kind !== 'model' && hardDenied)
          return { allowed: false, revision: 'revoked-policy', reason: 'hard_capability_denied' };
        return request.kind === 'model'
          ? { allowed: true, revision: 'policy' }
          : {
              allowed: false,
              revision: 'policy',
              approval: {
                ...(trustedDigest ? { commandDigest: trustedDigest(request.input) } : {}),
                request: { title: 'Exact command' },
                grants: ['approve_once', 'same_command'],
              },
            };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.command',
            version: '1',
            description: 'Harmless explicit command',
            inputSchema: { type: 'object' },
            async execute(input) {
              effects.push(input);
              return { outcome: 'succeeded', content: 'done' };
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
    name: 'Temporary',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 's',
  });
  const submit = (commandId: string, sessionId = 's') =>
    runtime.submitCommand({
      expectedStoreId,
      subjectId: 'owner',
      commandId,
      sessionId,
      request: { kind: 'run.start', content: commandId },
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
    expect((card.request as { grants: string[] }).grants).toContain('same_command');
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
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
    await f.submit('second');
    expect((await f.terminal('second')).status).toBe('completed');
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
    await f.submit('different');
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
      answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
    });
    await f.terminal('first');
    const page = await f.store.listPermissionGrants({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
    });
    f.hold();
    await f.submit('second');
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
    const executions = await f.store.listExecutions('s');
    const target = executions.find(
      (item) => item.originCommandId === 'second' && item.kind === 'tool',
    )!;
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
    expect((card.request as { commandDigest: string }).commandDigest).toBe(
      digest({ command: 'original', cwd: 'original' }),
    );
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
    });
    await f.terminal('first');
    await f.submit('second');
    await f.terminal('second');
    expect(f.effects).toEqual([
      { command: 'original', cwd: 'original', key: 'one' },
      { command: 'original', cwd: 'original', key: 'two' },
    ]);
    const page = await f.store.listPermissionGrants({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
    });
    expect(page.items[0]!.grant.commandDigest).toBe(
      digest({ command: 'original', cwd: 'original' }),
    );
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
      answer: { kind: 'approval', decision: 'approve' },
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
      answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
    });
    await granted.terminal('first');
    granted.denyCapability();
    await granted.submit('denied');
    await granted.terminal('denied');
    expect(granted.effects).toHaveLength(1);
    const execution = (await granted.store.listExecutions('s')).find(
      (value) => value.originCommandId === 'denied' && value.kind === 'tool',
    )!;
    expect(execution.status).toBe('failed');
    expect(execution.result).toMatchObject({ outcome: 'failed', content: 'permission_denied' });
  } finally {
    await granted.close();
  }
});
