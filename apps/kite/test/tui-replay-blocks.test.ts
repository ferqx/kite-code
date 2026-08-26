import { describe, expect, test } from 'bun:test';
import { sessionDataToUI } from '../src/tui/replay-blocks';

describe('safe TUI replay', () => {
  test('replays only client-safe event projections', () => {
    const result = sessionDataToUI({
      threadId: 'session-1',
      messages: [],
      runtimeEvents: [
        {
          type: 'user.message',
          messageId: 'message-1',
          kind: 'task',
          text: 'Inspect the project.',
        },
        {
          type: 'model.text_delta',
          requestId: 'request-replay-1',
          text: 'I found the contract.',
        },
        {
          type: 'tool.queued',
          toolId: 'tool-1',
          toolName: 'read_file',
          presentation: 'exploration',
          arguments: { path: 'packages/runtime-contract/src/index.ts' },
          summary: 'Inspecting runtime contract.',
        },
      ],
      interrupt: null,
      modelProvider: 'test',
      modelName: 'test',
      thinkingLevel: null,
      plan: null,
      interactionMode: 'accept_edits',
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
      runtimeEvents: [{ type: 'unavailable', reason: 'redacted' }],
      interrupt: { kind: 'approval', callId: 'tool-1' },
      modelProvider: 'test',
      modelName: 'test',
      thinkingLevel: null,
      plan: null,
      interactionMode: 'accept_edits',
    });
    expect(result.interrupt).toBeNull();
    expect(result.recoveredPendingInteraction).toBe(true);
  });
});
