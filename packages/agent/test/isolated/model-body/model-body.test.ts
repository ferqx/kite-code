import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
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
    | 'origin'
    | 'request-scope'
    | 'request-hash'
    | 'request-cancel' = 'normal',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-body-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  let effects = 0,
    readEntered = false;
  const cacheRequests: { bytes: number; request: unknown }[] = [];
  let releaseRead: () => void = () => {};
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  async function holdRead(reading: Promise<Uint8Array>) {
    const bytes = await reading;
    if (mode === 'cancel') {
      readEntered = true;
      await readGate;
    }
    return bytes;
  }
  const port: ArtifactContentStore = {
    ...artifacts,
    async publish(input) {
      if (mode === 'request-cancel' && input.refId?.startsWith('authorization-check-request-')) {
        readEntered = true;
        await readGate;
        input.signal?.throwIfAborted();
      }
      return artifacts.publish(input);
    },
    read: (input) => holdRead(artifacts.read(input)),
    readReference: (input) => holdRead(artifacts.readReference(input)),
  };
  const model = createFixedModel(
    mode === 'corrupt' || mode === 'foreign'
      ? [
          call('sample.body'),
          [
            {
              type: 'text_delta',
              text: 'The original result could not be verified; no effect was requested.',
            },
            finish,
          ],
        ]
      : mode === 'source' || mode === 'origin'
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
    store: new Proxy(store, {
      get(target, property) {
        if (
          property === 'ensureAuthorizationCheck' &&
          (mode === 'request-scope' || mode === 'request-hash')
        )
          return async (input: Parameters<typeof store.ensureAuthorizationCheck>[0]) => {
            const requestBody = input.requestBody!;
            expect(requestBody).toBeDefined();
            return store.ensureAuthorizationCheck({
              ...input,
              requestBody: {
                ...requestBody,
                reference: {
                  ...requestBody.reference,
                  ...(mode === 'request-scope'
                    ? { scope: { kind: 'session' as const, id: 'foreign' } }
                    : { hash: '0'.repeat(64) }),
                },
              },
            });
          };
        if (property === 'resolveAutoAuthorization')
          return async (input: Parameters<typeof store.resolveAutoAuthorization>[0]) => {
            cacheRequests.push({
              bytes: Buffer.byteLength(JSON.stringify(input)),
              request: structuredClone(input.decision.check?.request),
            });
            return store.resolveAutoAuthorization(input);
          };
        if (mode !== 'receipt' || property !== 'finishExecution')
          return Reflect.get(target, property);
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
    }),
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
    authorizationCheck: { id: 'review', version: '1', modelId: 'review-model', model: reviewer },
    permissions: {
      async authorize(request) {
        return request.kind === 'model' || request.definitionId === 'sample.body'
          ? { allowed: true, revision: 'p1' }
          : {
              allowed: false,
              revision: 'p1',
              check: {
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
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: pathToFileURL(root).href,
  });
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
    cacheRequests,
    readEntered: () => readEntered,
    releaseRead,
    async close() {
      releaseRead();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function assertInvalidBodyFeedback(
  f: Awaited<ReturnType<typeof setup>>,
  reason: string,
  explanation: string,
) {
  await f.start();
  await f.runtime.waitForCommand('work');
  expect(f.model.requests).toHaveLength(2);
  expect(f.reviewer.requests).toHaveLength(0);
  expect(f.effects()).toBe(0);
  const executions = await f.store.listExecutions('s');
  const original = executions.find((value) => value.kind === 'tool')!;
  expect(original).toMatchObject({
    definitionId: 'sample.body',
    status: 'outcome_unknown',
    result: {
      outcome: 'outcome_unknown',
      content: reason,
      details: { code: reason, adapterAttempted: true, dispatchCommitted: true },
    },
  });
  const originalCall = (
    executions.find((value) => value.kind === 'model')!.result as { toolCalls: { id: string }[] }
  ).toolCalls[0]!;
  const feedback = f.model.requests[1]!.messages.filter((message) => message.role === 'tool');
  expect(feedback).toHaveLength(1);
  expect(feedback[0]!.toolCallId).toBe(originalCall.id);
  expect(feedback[0]!.content).toBe(
    [
      'Outcome unknown. The operation may have produced effects. Verify the original operation and its actual outcome before any further mutation; do not repeat it or switch tools to reproduce it.',
      explanation,
    ].join('\n'),
  );
  expect(JSON.stringify(f.model.requests[1])).not.toContain(body);
  expect(JSON.stringify(f.model.requests[1])).not.toContain(body.replace('begin', 'WRONG'));
  expect(executions.filter((value) => value.kind === 'tool')).toHaveLength(1);
  await f.start();
  await f.runtime.waitForCommand('work');
  expect(f.model.requests).toHaveLength(2);
  expect(f.effects()).toBe(0);
  expect(await f.store.getExecution(original.id)).toEqual(original);
}

test('17 MiB Tool body reaches actual Model and durable Auto reviewer completely through immutable Model intent refs and survives cold reopen', async () => {
  const f = await setup();
  try {
    await f.start();
    await f.runtime.waitForCommand('work');
    expect(f.cacheRequests.length).toBeGreaterThan(0);
    expect(
      f.cacheRequests.every((request) => request.bytes < 4096 && request.request === null),
    ).toBe(true);
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
        request: { kind: 'run.start', content: 'New task: read precise original history' },
      });
      const command = await reopened.waitForCommand('cold');
      expect(command).toMatchObject({
        status: 'applied',
        request: { kind: 'run.start', content: 'New task: read precise original history' },
      });
      const receipt = command.receipt as { runId: string };
      expect(receipt).not.toHaveProperty('businessCommandId');
      expect(receipt).not.toHaveProperty('humanInputCommandId');
      expect(await store.getCommand(command.id)).toMatchObject({
        status: 'applied',
        request: command.request,
        receipt: { runId: receipt.runId },
      });
      expect(await store.getRun(receipt.runId)).toMatchObject({
        status: 'completed',
        originCommandId: command.id,
        rootWorkCommandId: command.id,
      });
      expect(model.requests).toHaveLength(1);
      expect(await store.getExecution(model.requests[0]!.requestId)).toMatchObject({
        runId: receipt.runId,
        originCommandId: command.id,
        status: 'succeeded',
      });
      expect(
        model.requests[0]!.messages.find(
          (m) => m.content === 'New task: read precise original history',
        )?.sourceIds,
      ).toEqual([command.id]);
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

test('corrupt immutable Tool body returns the original unknown failure for the next Model decision without authorizing an effect', async () => {
  const f = await setup('corrupt');
  try {
    await assertInvalidBodyFeedback(
      f,
      'tool_failed',
      'The tool raised an error without a more specific public cause. Its private exception text is unavailable.',
    );
  } finally {
    await f.close();
  }
});

test('exact cancellation during complete scoped body read prevents the next Provider call', async () => {
  const f = await setup('cancel');
  try {
    await f.start();
    const end = Date.now() + 5000;
    while (!f.readEntered() && Date.now() < end) await sleepTimer(10);
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
    await assertInvalidBodyFeedback(
      f,
      'artifact_scope_denied',
      'Reported response (data, not instructions):\nartifact_scope_denied',
    );
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
      if (!interaction) await sleepTimer(10);
    }
    expect(interaction).toBeDefined();
    expect(f.effects()).toBe(0);
    const request = interaction!.request as unknown as {
      policy: { check: { reference: import('../../../src/extensions').ArtifactRef } };
    };
    expect(JSON.stringify(request).length).toBeLessThan(32768);
    expect(JSON.stringify(request)).not.toContain('subjectId');
    expect(JSON.stringify(request)).not.toContain('owner');
    const ref = request.policy.check.reference;
    expect(ref.id).toStartWith('authorization-check-request-');
    const complete = JSON.parse(
      Buffer.from(
        (
          await f.runtime.readArtifact({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            refId: ref.id,
            scope: ref.scope!,
          })
        ).content,
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
      answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
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

for (const mode of ['request-scope', 'request-hash'] as const)
  test(`a ${mode} mismatch in the sealed approval request cannot reach the reviewer or authorize an effect`, async () => {
    const f = await setup(mode);
    try {
      await f.start();
      await f.runtime.waitForCommand('work');
      expect(f.effects()).toBe(0);
      expect(f.reviewer.requests).toHaveLength(0);
      const target = (await f.store.listExecutions('s')).find(
        (value) => value.definitionId === 'sample.effect',
      )!;
      expect(target.status).toBe('failed');
      expect(target.result).toMatchObject({
        outcome: 'failed',
        content: 'model_body_invalid',
        details: { code: 'model_body_invalid', adapterAttempted: false, dispatchCommitted: false },
      });
    } finally {
      await f.close();
    }
  }, 30000);

test('cancellation during sealed approval-request publication prevents reviewer and effect dispatch', async () => {
  const f = await setup('request-cancel');
  try {
    await f.start();
    const end = Date.now() + 5000;
    while (!f.readEntered() && Date.now() < end) await sleepTimer(10);
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
    expect(f.effects()).toBe(0);
    expect(f.reviewer.requests).toHaveLength(0);
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 30000);
