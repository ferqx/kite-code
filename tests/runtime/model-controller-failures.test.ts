import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { projectRuntimeEventToObservabilityFactV1 } from '@kite/agent-kernel';
import {
  createBuiltinObservabilityProjectorV1,
  digestCapabilityValueV1,
} from '@kite/builtin-runtime';
import { aiMessage, buildContextProjection } from '@kite/builtin-runtime/model';
import { createRuntimeHostState25InitialStateV1 } from '@kite/runtime-host';
import type { SuspendedSubagentSnapshot } from '@kite/runtime-spi';
import { eventsForInvalidModelToolCalls } from '#app/bootstrap/runtime/model-effect';
import { mapRuntimeMetadataV1 } from '#app/session-logger';
import { subagentTaskDigestV1 } from '#builtin-runtime';
import { reduceRuntimeState } from '#runtime-support/runtime-state25-reducer';
import { restoreState25HostSessionHarnessV1 as restoreState25KernelCoordinatorV1 } from '../../scripts/support/runtime-host-state25';
import { openState25Store4ForTestV1 } from '../../scripts/support/runtime-storage';
import { createTestModelInvocationHarnessV1 } from '../helpers/model-invocation';
import {
  executeTestRuntimeToolsV1,
  projectTestPrimaryModelEffectV1,
  testSubagentContinuationArtifactsV1,
  testSubagentTaskRequestsV1,
} from '../helpers/runtime-model';
import { createMockModel } from '../mock-model';

function projectObservabilityMetrics(events: readonly unknown[]) {
  const projector = createBuiltinObservabilityProjectorV1();
  return events.flatMap((event) => {
    const fact = projectRuntimeEventToObservabilityFactV1(event, new Date(0).toISOString());
    return fact ? projector.mapRuntimeFact(fact) : [];
  });
}

test('classifies invalid model tool arguments before tool execution', () => {
  const events = eventsForInvalidModelToolCalls(
    [{ id: 'bad-call', name: 'read_file', args: { _parse_error: 'invalid JSON' } }],
    'message-1',
    0,
    'a'.repeat(64),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool.failed',
      toolCallId: 'bad-call',
      failure: expect.objectContaining({ kind: 'model_invalid_tool_args' }),
    }),
  );
});

test('persists only an opaque HMAC identity for invalid provider raw arguments', () => {
  const rawSecret = '{"path":"/private/secret.txt","token":"hunter2"';
  const events = eventsForInvalidModelToolCalls(
    [
      {
        id: 'bad-private-call',
        name: 'read_file',
        args: { _raw_invalid_args: rawSecret, _parse_error: `invalid near ${rawSecret}` },
      },
    ],
    'message-private',
    0,
    'a'.repeat(64),
  );
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain('/private/secret.txt');
  expect(serialized).not.toContain('hunter2');
  expect(events[0]).toMatchObject({
    type: 'tool.queued',
    args: {
      _invalid_args_code: 'invalid_json',
      _invalid_args_redacted: true,
    },
    invocationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify((events[0] as { args?: unknown }).args)).not.toMatch(/[a-f0-9]{64}/u);
});

test('keeps invalid provider raw arguments out of model/responded, event store, state, and transcript', () => {
  const dir = mkdtempSync(join(process.cwd(), '.kite-invalid-provider-privacy-'));
  const storePath = join(dir, 'runtime.db');
  const rawSecret = '{"path":"/private/store-secret.txt","token":"store-hunter2"';
  const threadId = 'invalid-provider-store-privacy';
  try {
    const events = eventsForInvalidModelToolCalls(
      [
        {
          id: 'bad-store-call',
          name: 'read_file',
          args: { _raw_invalid_args: rawSecret, _parse_error: `private ${rawSecret}` },
        },
      ],
      'message-store-private',
      0,
      'b'.repeat(64),
    );
    const queued = events.find((event) => event.type === 'tool.queued');
    expect(queued?.type).toBe('tool.queued');
    if (queued?.type !== 'tool.queued') throw new Error('expected queued invalid call');
    const kernel = restoreState25KernelCoordinatorV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'user',
      workspace: '/workspace',
      store: openState25Store4ForTestV1(storePath),
    });
    kernel.processEvent({
      type: 'model.responded',
      messageId: 'message-store-private',
      toolCalls: [
        {
          id: queued.toolCallId,
          name: queued.name,
          args: queued.args,
          canonicalInvocationFingerprint: queued.invocationFingerprint,
        },
      ],
    });
    kernel.processEvents(events);
    expect(JSON.stringify(kernel.getState())).not.toContain('store-secret');
    expect(JSON.stringify(kernel.getState())).not.toContain('store-hunter2');
    const providerProjection = buildContextProjection({
      role: 'agent',
      state: kernel.getState(),
      serializedTools: [],
    });
    const providerJson = JSON.stringify(providerProjection.providerMessages);
    expect(providerJson).toContain('"_invalid_args_redacted":true');
    expect(providerJson).not.toContain(queued.invocationFingerprint!);
    expect(providerJson).not.toContain(kernel.getState().toolRecovery.identityKey);
    kernel.close();

    const store = openState25Store4ForTestV1(storePath);
    const stored = JSON.stringify(store.loadEventsStrict(threadId));
    store.close();
    expect(stored).not.toContain('store-secret');
    expect(stored).not.toContain('store-hunter2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps a new Task body and raw digests out of every Runtime and diagnostic projection', async () => {
  const task = 'PRIVATE_TASK_SENTINEL_3d95445c review the exact runtime privacy boundary';
  const rawTaskDigest = subagentTaskDigestV1(task);
  const rawArgumentsDigest = digestCapabilityValueV1({ subagent_type: 'review', task });
  const state = createRuntimeHostState25InitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'private-task-runtime-projection',
    userId: 'user',
    workspace: process.cwd(),
  });
  const model = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          { id: 'private-task-call', name: 'task', args: { subagent_type: 'review', task } },
        ],
      }),
    },
  ]);
  model.supportsToolCalls = true;
  const events = await projectTestPrimaryModelEffectV1({
    model,
    state,
    config: {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      modelName: 'fixture',
      sandbox: { enabled: false },
    },
  });
  const responded = events.find((event) => event.type === 'model.responded');
  const queued = events.find((event) => event.type === 'tool.queued');
  expect(responded).toMatchObject({
    type: 'model.responded',
    toolCalls: [
      {
        id: 'private-task-call',
        name: 'task',
        args: {
          subagent_type: 'review',
          taskArtifact: {
            kind: 'subagent_task_request',
            artifactId: expect.stringMatching(/^pa_[0-9a-f]{64}$/),
          },
        },
      },
    ],
  });
  if (responded?.type !== 'model.responded') throw new Error('expected model response');
  expect(Object.hasOwn(responded, 'text')).toBe(false);
  expect(Object.hasOwn(responded, 'reasoningText')).toBe(false);
  expect(queued).toMatchObject({
    type: 'tool.queued',
    args: { subagent_type: 'review', taskArtifact: { kind: 'subagent_task_request' } },
  });
  let restored = state;
  for (const event of events) restored = reduceRuntimeState(restored, event);
  const sessionProjection = events.map(mapRuntimeMetadataV1);
  const metricProjection = projectObservabilityMetrics(events);
  const publicJson = JSON.stringify({ events, restored, sessionProjection, metricProjection });
  expect(publicJson).not.toContain(task);
  expect(publicJson).not.toContain(rawTaskDigest);
  expect(publicJson).not.toContain(rawArgumentsDigest);
});

test('omits absent optional model response fields so live reduction matches replay', async () => {
  const state = createRuntimeHostState25InitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'canonical-model-response',
    userId: 'user',
    workspace: process.cwd(),
  });
  const model = createMockModel([{ message: aiMessage({ content: 'done' }) }]);
  const events = await projectTestPrimaryModelEffectV1({
    model,
    state,
    config: {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      modelName: 'fixture',
      sandbox: { enabled: false },
    },
  });
  const responded = events.find((event) => event.type === 'model.responded');
  if (responded?.type !== 'model.responded') throw new Error('expected model response');

  expect(Object.hasOwn(responded, 'reasoningText')).toBe(false);
  expect(Object.hasOwn(responded, 'text')).toBe(true);
  const live = reduceRuntimeState(state, responded);
  const replay = reduceRuntimeState(
    state,
    JSON.parse(JSON.stringify(responded)) as typeof responded,
  );
  expect(live).toEqual(replay);
  expect(live.transcript.final).toBe('done');
});

test('interrupts duplicate provider tool-call ids before publishing or queueing either Task', async () => {
  const state = createRuntimeHostState25InitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'duplicate-provider-tool-call-id',
    userId: 'user',
    workspace: process.cwd(),
  });
  const model = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'duplicate-task-call',
            name: 'task',
            args: { subagent_type: 'review', task: 'first private task' },
          },
          {
            id: 'duplicate-task-call',
            name: 'task',
            args: { subagent_type: 'review', task: 'second private task' },
          },
        ],
      }),
    },
  ]);
  model.supportsToolCalls = true;
  const harness = createTestModelInvocationHarnessV1({ workspace: process.cwd(), state });
  const delegate = testSubagentTaskRequestsV1();
  let artifactWrites = 0;
  await expect(
    projectTestPrimaryModelEffectV1({
      model,
      state,
      config: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        modelName: 'fixture',
        sandbox: { enabled: false },
      },
      modelInvocationGateway: harness.gateway,
      modelInvocationPersistence: harness.persistence,
      subagentTaskRequests: {
        ...delegate,
        write: (input) => {
          artifactWrites += 1;
          return delegate.write(input);
        },
      },
    }),
  ).rejects.toThrow('duplicate tool-call id');
  expect(artifactWrites).toBe(0);
  expect(model.callCount.count).toBe(1);
  expect(harness.events.at(-1)).toMatchObject({
    type: 'model.invocation_interrupted',
    reasonCode: 'persistence_unavailable',
    dispatchCertainty: 'attempted',
  });
  expect(
    harness.events.some(
      (event) =>
        event.type === 'model.invocation_completed' ||
        event.type === 'model.responded' ||
        event.type === 'tool.queued',
    ),
  ).toBe(false);
  const invocationId = harness.events.find(
    (event) => event.type === 'model.invocation_prepared',
  )?.invocationId;
  expect(invocationId).toBeDefined();
  expect(harness.getState().modelInvocations[invocationId!]).toMatchObject({
    status: 'interrupted',
    interruptionReason: 'persistence_unavailable',
  });
});

test('keeps a real blocked continuation body out of DB, Runtime state, SessionLog, and metrics', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.kite-private-continuation-projection-'));
  const storePath = join(dir, 'runtime.db');
  const task = 'PRIVATE_CONTINUATION_TASK_SENTINEL_7541';
  const message = 'PRIVATE_CONTINUATION_MESSAGE_SENTINEL_7541';
  try {
    const state = createRuntimeHostState25InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'private-continuation-db',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls['task-private-db'] = {
      toolCallId: 'task-private-db',
      modelMessageId: 'model-private-db',
      name: 'task',
      args: { subagent_type: 'review', task },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task-private-db'];
    const childModel = createMockModel([
      {
        message: aiMessage({
          content: message,
          tool_calls: [
            {
              id: 'blocked-private-db',
              name: 'shell_execute',
              args: { command: 'rg approved /outside/approved-minimal-disclosure.txt' },
            },
          ],
        }),
      },
    ]);
    const continuationArtifacts = testSubagentContinuationArtifactsV1();
    let capturedContinuation: SuspendedSubagentSnapshot | undefined;
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['task-private-db'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        modelName: 'fixture',
        sandbox: { enabled: false },
      },
      taskModel: childModel,
      subagentContinuationArtifacts: {
        ...continuationArtifacts,
        write: (input) => {
          capturedContinuation = structuredClone(input.snapshot);
          return continuationArtifacts.write(input);
        },
      },
    });
    expect(events.some((event) => event.type === 'subagent.suspended')).toBe(true);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    let restored = createRuntimeHostState25InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'private-continuation-db',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const event of events) restored = reduceRuntimeState(restored, event);
    const sessionJson = JSON.stringify(events.map(mapRuntimeMetadataV1));
    const metricJson = JSON.stringify(projectObservabilityMetrics(events));
    const db = openState25Store4ForTestV1(storePath);
    db.appendEvents('private-continuation-db', events);
    const storedJson = JSON.stringify(db.loadEventsStrict('private-continuation-db'));
    db.close();
    const publicJson = JSON.stringify({ events, restored, sessionJson, metricJson, storedJson });
    expect(capturedContinuation).toBeDefined();
    const rawContinuationDigest = digestCapabilityValueV1({
      schema: 'kite.subagent-continuation.v1',
      snapshot: capturedContinuation!,
    });
    for (const secret of [task, message, subagentTaskDigestV1(task), rawContinuationDigest]) {
      expect(publicJson).not.toContain(secret);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
