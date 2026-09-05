import { describe, expect, test } from 'bun:test';
import type { AcceptedPresentationEnvelope, RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { sessionDataToUI } from '../src/tui/replay-blocks';

function historyEnvelope(event: RuntimeClientEvent, revision = 1): AcceptedPresentationEnvelope {
  return {
    sessionId: 'session-1',
    connectionGeneration: 1,
    durability: 'durable',
    revision,
    runId: 'history-run-1',
    taskId: 'history-task-1',
    turnId: 'history-turn-1',
    event,
  };
}

describe('safe TUI replay', () => {
  test('replays only client-safe event projections', () => {
    const result = sessionDataToUI({
      threadId: 'session-1',
      messages: [],
      runtimeEvents: [
        historyEnvelope({
          type: 'user.message',
          messageId: 'message-1',
          kind: 'task',
          text: 'Inspect the project.',
        }),
        historyEnvelope({
          type: 'model.text_delta',
          requestId: 'request-replay-1',
          text: 'I found the contract.',
        }),
        historyEnvelope({
          type: 'tool.queued',
          toolId: 'tool-1',
          toolName: 'read_file',
          presentation: 'exploration',
          arguments: { path: 'packages/runtime-contract/src/index.ts' },
          summary: 'Inspecting runtime contract.',
        }),
      ],
      interrupt: null,
      modelProvider: 'test',
      modelName: 'test',
      thinkingLevel: null,
      plan: null,
      interactionMode: 'accept_edits',
      recovery: 'normal',
    });
    expect(result.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', content: 'Inspect the project.' }),
      ]),
    );
    expect(result.pendingToolCalls).toEqual({
      'tool-1': {
        name: 'read_file',
        args: { path: 'packages/runtime-contract/src/index.ts' },
        presentation: 'exploration',
      },
    });
    expect(result.interrupt).toBeNull();
    expect(result.recoveredPendingInteraction).toBe(false);
  });

  test('never restores a historical interaction as a live settlement target', () => {
    const result = sessionDataToUI({
      threadId: 'session-1',
      messages: [],
      runtimeEvents: [historyEnvelope({ type: 'unavailable', reason: 'redacted' })],
      interrupt: { kind: 'approval', callId: 'tool-1' },
      modelProvider: 'test',
      modelName: 'test',
      thinkingLevel: null,
      plan: null,
      interactionMode: 'accept_edits',
      recovery: 'pending_interaction',
    });
    expect(result.interrupt).toBeNull();
    expect(result.recoveredPendingInteraction).toBe(true);
  });
});
