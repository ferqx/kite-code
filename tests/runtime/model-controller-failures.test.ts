import { expect, test } from 'bun:test';
import { eventsForInvalidModelToolCalls } from '@/core/controllers/model-controller';
import { AgentKernel, restoreRuntimeStateFromStore } from '@/core/runtime/kernel';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

test('classifies invalid model tool arguments before tool execution', () => {
  const events = eventsForInvalidModelToolCalls(
    [{ id: 'bad-call', name: 'read_file', args: { _parse_error: 'invalid JSON' } }],
    'message-1',
    0,
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool.failed',
      toolCallId: 'bad-call',
      failure: expect.objectContaining({ kind: 'model_invalid_tool_args' }),
    }),
  );
});

test('invalid model tool arguments require one atomic response-to-terminal closure', () => {
  const state = createInitialRuntimeState({
    threadId: 'invalid-tool-closure',
    userId: 'u',
    workspace: '/workspace',
  });
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: state,
    interactionMode: 'accept_edits',
  });
  const response = {
    type: 'model.responded' as const,
    messageId: 'invalid-response',
    toolCalls: [
      {
        id: 'bad-call',
        name: 'read_file',
        args: { _parse_error: 'invalid JSON' },
      },
    ],
  };
  const closure = eventsForInvalidModelToolCalls(
    [
      {
        id: 'bad-call',
        name: 'read_file',
        args: { _parse_error: 'invalid JSON' },
      },
    ],
    response.messageId,
    0,
  );

  expect(() => kernel.processEvent(response)).toThrow('queued/failed closure');
  expect(() => kernel.processEventBatch([response, closure[0]!])).toThrow('queued/failed closure');
  kernel.processEventBatch([response, ...closure]);
  expect(kernel.getState().tools.calls['bad-call']).toMatchObject({
    status: 'failed',
    result: { ok: false },
  });
  expect(
    kernel
      .getState()
      .transcript.messages.some(
        (message) => message.kind === 'tool' && message.toolCallId === 'bad-call',
      ),
  ).toBe(true);
});

test('schema-v22 tail replay rejects an orphan invalid Tool Call', () => {
  const source = createRuntimeStore(':memory:');
  const state = createInitialRuntimeState({
    threadId: 'invalid-source',
    userId: 'u',
    workspace: '/workspace',
  });
  const kernel = new AgentKernel({
    store: source,
    initialState: state,
    interactionMode: 'accept_edits',
  });
  const response = {
    type: 'model.responded' as const,
    messageId: 'invalid-response',
    toolCalls: [
      {
        id: 'bad-call',
        name: 'read_file',
        args: { _parse_error: 'invalid JSON' },
      },
    ],
  };
  kernel.processEventBatch([
    response,
    ...eventsForInvalidModelToolCalls(
      [
        {
          id: 'bad-call',
          name: 'read_file',
          args: { _parse_error: 'invalid JSON' },
        },
      ],
      response.messageId,
      0,
    ),
  ]);
  const persisted = source.loadEvents('invalid-source');
  const target = createRuntimeStore(':memory:');
  target.saveSnapshot('invalid-target', {
    ...createInitialRuntimeState({
      threadId: 'invalid-target',
      userId: 'u',
      workspace: '/workspace',
    }),
    schemaVersion: 23,
  });
  target.appendEvents(
    'invalid-target',
    persisted.slice(0, 2).map((entry) => entry.event),
    persisted.slice(0, 2).map((entry) => ({
      eventId: entry.event_id!,
      revision: entry.revision!,
      occurredAt: entry.occurred_at!,
      ...(entry.causation_id ? { causationId: entry.causation_id } : {}),
    })),
  );
  const restored = restoreRuntimeStateFromStore({
    store: target,
    threadId: 'invalid-target',
    userId: 'u',
    workspace: '/workspace',
  });
  expect(restored.state.recoveryState).toEqual({
    kind: 'corrupted',
    reason: "Invalid model Tool Call 'bad-call' lacks one exact queued/failed closure.",
  });
  expect(restored.state.transcript.messages).toEqual([]);
  target.close();
});
