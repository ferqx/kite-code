import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { ArtifactContentStore } from '../../../src/artifact-port';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
  { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
];
const body = `begin\n${'x'.repeat(17 * 1024 * 1024)}\nend`;
async function setup(
  mode:
    | 'normal'
    | 'corrupt'
    | 'cancel'
    | 'foreign'
    | 'source'
    | 'ask'
    | 'receipt'
    | 'origin' = 'normal',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-body-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  let effects = 0,
    readEntered = false;
  let releaseRead: () => void = () => {};
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const port: ArtifactContentStore = {
    ...artifacts,
    async read(input) {
      const bytes = await artifacts.read(input);
      if (mode === 'cancel') {
        readEntered = true;
        await readGate;
      }
      return bytes;
    },
  };
  const model = createFixedModel(
    mode === 'source' || mode === 'origin'
      ? [call('sample.effect'), [finish]]
      : [call('sample.body'), call('sample.effect'), [finish]],
  );
  const reviewer = createFixedModel([
    [
      {
        type: 'text_delta',
        text:
          mode === 'ask'
            ? '{"decision":"ask_user","reason":"human must decide"}'
            : '{"decision":"approve_once","reason":"exact complete body reviewed"}',
      },
      finish,
    ],
  ]);
  const extensions = [
    {
      id: 'sample',
      version: '1',
      apiMajor: 1 as const,
      tools: [
        {
          id: 'sample.body',
          version: '1',
          description: 'Complete immutable text',
          inputSchema: { type: 'object' },
          async execute(_input: unknown, ctx: import('../../../src/extensions').ToolContext) {
            const ref = await ctx.artifacts!.publish({
              key: 'full',
              content: Buffer.from(body),
              mediaType: 'text/plain',
            });
            if (mode === 'corrupt') {
              const full = await store.getArtifactReference({
                expectedStoreId,
                sessionId: 's',
                subjectId: 'owner',
                refId: ref.id,
                scope: ref.scope!,
              });
              const path = artifactPath(
                join(profile.dataRoot, 'profiles', profile.profile),
                full!.hash,
              );
              chmodSync(path, 0o600);
              writeFileSync(path, body.replace('begin', 'WRONG'));
            }
            return {
              outcome: 'succeeded' as const,
              content: 'complete body stored',
              artifactRefs: [ref],
              modelContent: {
                kind: 'artifact' as const,
                reference:
                  mode === 'foreign'
                    ? { ...ref, scope: { kind: 'session' as const, id: 'another-session' } }
                    : ref,
                encoding: 'utf-8' as const,
              },
            };
          },
        },
        {
          id: 'sample.effect',
          version: '1',
          description: 'Count',
          inputSchema: { type: 'object' },
          async execute() {
            effects++;
            return { outcome: 'succeeded' as const, content: 'effect' };
          },
        },
      ],
    },
  ];
  const runtime = createRuntime({
    store:
      mode === 'receipt'
        ? new Proxy(store, {
            get(target, property) {
              if (property !== 'finishExecution') return Reflect.get(target, property);
              return async (input: Parameters<typeof store.finishExecution>[0]) => {
                if (
                  input.status === 'succeeded' &&
                  input.result &&
                  typeof input.result === 'object' &&
                  !Array.isArray(input.result) &&
                  input.result.modelInputBodyHash
                )
                  return store.finishExecution({
                    ...input,
                    result: { ...input.result, modelInputBodyHash: '0'.repeat(64) },
                  });
                return store.finishExecution(input);
              };
            },
          })
        : store,
    artifacts: port,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    maxConcurrentSubagents: 1,
    extensions,
    ...(mode === 'source'
      ? {
          sources: {
            async capture() {
              return [
                {
                  id: 'host.large',
                  kind: 'instruction',
                  scope: 'session',
                  digest: 'exact-v1',
                  content: body,
                  role: 'user' as const,
                },
              ];
            },
          },
        }
      : {}),
    authorizationReview: { id: 'review', version: '1', modelId: 'review-model', model: reviewer },
    permissions: {
      async authorize(request) {
        return request.kind === 'model' || request.definitionId === 'sample.body'
          ? { allowed: true, revision: 'p1' }
          : {
              allowed: false,
              revision: 'p1',
              review: {
                request:
                  mode === 'source' || mode === 'origin'
                    ? { task: 'actual complete source', plan: null }
                    : { task: body, plan: { full: body } },
              },
            };
      },
    },
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: `file://${root}` });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 's',
    subjectId: 'owner',
  });
  const start = async () => {
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: {
        kind: 'run.start',
        content:
          mode === 'origin'
            ? '\0'.repeat(1024 * 1024)
            : 'read complete body and perform harmless effect',
      },
    });
  };
  return {
    root,
    profile,
    store,
    artifacts,
    runtime,
    model,
    reviewer,
    extensions,
    expectedStoreId,
    start,
    effects: () => effects,
    readEntered: () => readEntered,
    releaseRead,
    async close() {
      releaseRead();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('17 MiB Tool body reaches actual Model and durable Auto reviewer completely through immutable Model intent refs and survives cold reopen', async () => {
  const f = await setup();
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    expect(f.model.requests).toHaveLength(3);
    expect(
      f.model.requests[1]!.messages.find((message) => message.role === 'tool')!.content.endsWith(
        body,
      ),
    ).toBe(true);
    expect(
      f.model.requests[1]!.messages.find((message) => message.role === 'tool')!.content,
    ).toContain('complete body stored');
    expect(f.reviewer.requests).toHaveLength(1);
    expect(f.reviewer.requests[0]!.tools).toEqual([]);
    const review = JSON.parse(
      f.reviewer.requests[0]!.messages.find((message) => message.role === 'user')!.content,
    );
    expect(review.request.task).toBe(body);
    expect(review.request.plan.full).toBe(body);
    expect(
      review.decisionContext.messages.some((message: { content: string }) =>
        message.content.endsWith(body),
      ),
    ).toBe(true);
    const executions = await f.store.listExecutions('s');
    const actual = executions.find(
      (execution) =>
        execution.kind === 'model' &&
        execution.input &&
        typeof execution.input === 'object' &&
        !Array.isArray(execution.input) &&
        execution.input.body,
    )!;
    expect(actual.status).toBe('succeeded');
    expect(JSON.stringify(actual.input).length).toBeLessThan(4096);
    const descriptor = (
      actual.input as unknown as {
        body: { reference: import('../../../src/storage/types').ArtifactReference };
      }
    ).body.reference;
    expect(BigInt(descriptor.size)).toBeGreaterThan(17n * 1024n * 1024n);
    expect(descriptor.scope).toEqual({ kind: 'session', id: 's' });
    await f.runtime.close();
    const store = await openSqliteStore(f.profile);
    const artifacts = createArtifactStore({ profile: f.profile, store });
    const model = createFixedModel([[finish]]);
    const reopened = createRuntime({
      store,
      artifacts,
      model,
      modelId: 'fixed',
      extensions: f.extensions,
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'p2' };
        },
      },
    });
    try {
      const persisted = JSON.parse(
        Buffer.from(
          await artifacts.read({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            refId: descriptor.id,
            scope: descriptor.scope,
          }),
        ).toString('utf8'),
      );
      expect(
        persisted.messages.some((message: { content: string }) => message.content.endsWith(body)),
      ).toBe(true);
      await reopened.submitCommand({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        commandId: 'cold',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'read precise original history' },
      });
      await reopened.waitForCommand('cold');
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]!.messages.some((message) => message.content.endsWith(body))).toBe(
        true,
      );
      expect(f.effects()).toBe(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
}, 30000);

test('corrupt immutable Tool body cannot reach another Provider call or authorize an effect', async () => {
  const f = await setup('corrupt');
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    expect(f.model.requests).toHaveLength(1);
    expect(f.reviewer.requests).toHaveLength(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.close();
  }
});

test('exact cancellation during complete scoped body read prevents the next Provider call', async () => {
  const f = await setup('cancel');
  try {
    await f.start();
    const end = Date.now() + 5000;
    while (!f.readEntered() && Date.now() < end) await Bun.sleep(10);
    expect(f.readEntered()).toBe(true);
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      commandId: 'cancel',
      targetCommandId: 'work',
      subjectId: 'owner',
    });
    f.releaseRead();
    await f.runtime.waitForCommand('work');
    expect(f.model.requests).toHaveLength(1);
    expect(f.effects()).toBe(0);
    expect(f.reviewer.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a Tool cannot substitute a different Artifact scope as Model body authority', async () => {
  const f = await setup('foreign');
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    expect(f.model.requests).toHaveLength(1);
    expect(f.reviewer.requests).toHaveLength(0);
    expect(f.effects()).toBe(0);
    const execution = (await f.store.listExecutions('s')).find((value) => value.kind === 'tool')!;
    expect(execution.status).toBe('outcome_unknown');
  } finally {
    await f.close();
  }
});

test('large actual decision sources retain complete Provider and review content while persisted source identity stays compact', async () => {
  const f = await setup('source');
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    expect(
      f.model.requests[0]!.messages.find((message) => message.sourceIds?.includes('host.large'))!
        .content,
    ).toBe(body);
    const review = JSON.parse(
      f.reviewer.requests[0]!.messages.find((message) => message.role === 'user')!.content,
    );
    expect(review.target.source.sources[0].content).toBe(body);
    expect(review.target.source.sources[0].id).toBe('host.large');
    const target = (await f.store.listExecutions('s')).find(
      (execution) => execution.kind === 'tool',
    )!;
    expect(JSON.stringify(target.decisionSource).length).toBeLessThan(4096);
    expect(
      (target.decisionSource as { sources: { id: string; digest: string }[] }).sources,
    ).toEqual([{ id: 'host.large', digest: 'exact-v1' }]);
  } finally {
    await f.close();
  }
}, 30000);

test('large Auto ask_user preserves a real bounded human card with the exact complete request attachment', async () => {
  const f = await setup('ask');
  try {
    await f.start();
    let interaction:
      | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
      | undefined;
    const end = Date.now() + 15000;
    while (!interaction && Date.now() < end) {
      interaction = (
        await f.runtime.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions[0];
      if (!interaction) await Bun.sleep(10);
    }
    expect(interaction).toBeDefined();
    expect(f.effects()).toBe(0);
    const request = interaction!.request as unknown as {
      policy: { review: { reference: import('../../../src/extensions').ArtifactRef } };
    };
    expect(JSON.stringify(request).length).toBeLessThan(32768);
    expect(JSON.stringify(request)).not.toContain('subjectId');
    expect(JSON.stringify(request)).not.toContain('owner');
    const ref = request.policy.review.reference;
    const complete = JSON.parse(
      Buffer.from(
        await f.artifacts.read({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          refId: ref.id,
          scope: ref.scope!,
        }),
      ).toString('utf8'),
    );
    expect(complete.task).toBe(body);
    expect(complete.plan.full).toBe(body);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      commandId: 'approve',
      presentationSessionId: 's',
      interactionId: interaction!.id,
      expectedRevision: interaction!.revision,
      subjectId: 'owner',
      answer: { kind: 'approval', decision: 'approve' },
    });
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    expect(f.reviewer.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

test('a mismatched Model body receipt cannot become a succeeded decision or grant an Auto target', async () => {
  const f = await setup('receipt');
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(0);
    expect(f.model.requests).toHaveLength(2);
    expect(f.reviewer.requests).toHaveLength(0);
    const executions = await f.store.listExecutions('s');
    const bodyModel = executions.find(
      (execution) =>
        execution.kind === 'model' &&
        execution.input &&
        typeof execution.input === 'object' &&
        !Array.isArray(execution.input) &&
        execution.input.body,
    )!;
    expect(bodyModel.status).toBe('failed');
    expect((bodyModel.result as { code: string }).code).toBe('model_body_receipt_invalid');
  } finally {
    await f.close();
  }
}, 30000);

test('valid one MiB UTF-8 original task with worst-case JSON escaping remains complete in Auto origin and actual Model context', async () => {
  const f = await setup('origin');
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    const review = JSON.parse(
      f.reviewer.requests[0]!.messages.find((message) => message.role === 'user')!.content,
    );
    const content = '\0'.repeat(1024 * 1024);
    expect(review.originCommandRequest.content).toBe(content);
    expect(review.rootWorkRequest.content).toBe(content);
    expect(
      review.decisionContext.messages.some(
        (message: { content: string }) => message.content === content,
      ),
    ).toBe(true);
    expect(f.model.requests[0]!.messages.some((message) => message.content === content)).toBe(true);
  } finally {
    await f.close();
  }
}, 30000);
