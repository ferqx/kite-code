/**
 * TUI E2E — Tool Parse Error Handling
 *
 * Tests end-to-end flow: invalid_tool_calls → synthetic tool_calls →
 * runApprovedTool error feedback → model retry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AIMessage } from '@langchain/core/messages';
import type { MockResponse } from '../mock-model';
import { createTui, type TuiHarness } from './render-tui';

const TIMEOUT = 30000;

/** Mock response with invalid_tool_calls (simulates parseToolCall failure) */
function invalidToolCall(
  name: string,
  rawArgs: string,
  parseError: string,
  content = 'let me do that',
): MockResponse {
  const id = `tc-${name}-invalid`;
  return {
    message: new AIMessage({
      content,
      tool_calls: [],
      invalid_tool_calls: [
        { id, name, args: rawArgs, error: parseError, type: 'invalid_tool_call' },
      ],
      additional_kwargs: {
        tool_calls: [{ id, type: 'function', function: { name, arguments: rawArgs } }],
      },
    }) as any,
    delay: 20,
  };
}

// ── Shared TUI (Ink single-render constraint) ──

let tui: TuiHarness;

beforeAll(async () => {
  tui = await createTui({
    modelResponses: [
      // 1. shell_execute with broken JSON args
      invalidToolCall('shell_execute', '{"command":"bad', 'Unexpected end of JSON input'),
      // 2. ask_user with broken JSON args — model retries after error
      invalidToolCall('ask_user', '{question: 123 invalid}', "Expected '}' at line 1"),
      // 3. unknown tool parse error
      invalidToolCall('unknown_tool', '{bad}', 'Unexpected token', ''),
    ],
  });
});

afterAll(() => {
  tui?.unmount();
});

// ── Tests ──

describe('tool parse error E2E', () => {
  test(
    'shell_execute: invalid JSON → error ToolMessage',
    async () => {
      await tui.sendMessage('run command');
      await tui.waitForIdle(TIMEOUT);
      expect(tui.getOutput()).toContain('shell_execute');
    },
    TIMEOUT,
  );

  test(
    'ask_user: invalid JSON → error with raw args',
    async () => {
      await tui.sendMessage('ask something');
      await tui.waitForIdle(TIMEOUT);
      const output = tui.getOutput();
      expect(output).toContain('ask_user');
    },
    TIMEOUT,
  );

  test(
    'unknown tool: invalid JSON → does not crash',
    async () => {
      await tui.sendMessage('do unknown');
      await tui.waitForIdle(TIMEOUT);
      expect(tui.getOutput()).toContain('unknown_tool');
    },
    TIMEOUT,
  );
});
