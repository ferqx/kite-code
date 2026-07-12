import { describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
} from '@/core/subagent/continuation-codec';
import { getRoleConfig } from '@/core/subagent/roles';
import type { SubAgentContinuation } from '@/core/subagent/types';

describe('sub-agent continuation codec', () => {
  test('round-trips JSON-safe continuation snapshots with LangChain message details', () => {
    const continuation: SubAgentContinuation = {
      id: 'sub-1',
      role: getRoleConfig('code'),
      task: 'inspect the repository',
      messages: [
        new SystemMessage({
          id: 'system-1',
          name: 'system-instructions',
          content: 'You are a coding agent.',
          response_metadata: { trace: { source: 'system' } },
        }),
        new HumanMessage({
          id: 'human-1',
          name: 'operator',
          content: 'Inspect src.',
          response_metadata: { trace: { source: 'human' } },
        }),
        new AIMessage({
          id: 'ai-1',
          name: 'tool-planner',
          content: 'I will inspect the source.',
          additional_kwargs: { reasoning_content: 'Need to inspect.' },
          response_metadata: { finish_reason: 'tool_calls' },
          invalid_tool_calls: [
            {
              id: 'invalid-call-1',
              name: 'read_file',
              args: '{',
              error: 'Unexpected end of JSON input',
              type: 'invalid_tool_call',
            },
          ],
          usage_metadata: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
          tool_calls: [
            {
              id: 'call-1',
              name: 'read_file',
              args: { path: 'src/index.ts' },
              type: 'tool_call',
            },
          ],
        }),
        new ToolMessage({
          id: 'tool-1',
          content: 'export {}',
          tool_call_id: 'call-1',
          name: 'read_file',
          status: 'success',
          response_metadata: { request_id: 'request-1' },
          metadata: { execution: { attempt: 1 } },
          artifact: { fullOutput: { bytes: 9 } },
        }),
      ],
      toolCallCount: 2,
      steps: [
        {
          toolName: 'read_file',
          toolArgs: { path: 'src/index.ts' },
          status: 'success',
          ok: true,
          totalLines: 1,
        },
      ],
      executionJournal: [
        {
          toolCallId: 'call-1',
          toolName: 'read_file',
          status: 'applied',
          startedAt: 1,
          finishedAt: 2,
        },
      ],
      exhaustedFingerprints: { 'read_file:ENOENT': true },
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      toolCallId: 'call-2',
      toolName: 'shell_execute',
      args: { command: 'bun test' },
      command: 'bun test',
    });
    const restored = deserializeSubagentContinuation(JSON.parse(JSON.stringify(snapshot)));

    expect(snapshot).toEqual(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.id).toBe('sub-1');
    expect(restored.role).toEqual(getRoleConfig('code'));
    expect(restored.task).toBe('inspect the repository');
    expect(restored.toolCallCount).toBe(2);
    expect(restored.steps).toEqual(continuation.steps);
    expect(restored.executionJournal).toEqual(continuation.executionJournal);
    expect(restored.exhaustedFingerprints).toEqual(continuation.exhaustedFingerprints);
    expect(restored.messages[0]).toBeInstanceOf(SystemMessage);
    expect(restored.messages[1]).toBeInstanceOf(HumanMessage);
    expect(restored.messages[2]).toBeInstanceOf(AIMessage);
    expect((restored.messages[2] as AIMessage).tool_calls).toMatchObject([
      { id: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } },
    ]);
    expect((restored.messages[2] as AIMessage).additional_kwargs).toEqual({
      reasoning_content: 'Need to inspect.',
    });
    expect(restored.messages[0]).toMatchObject({
      name: 'system-instructions',
      response_metadata: { trace: { source: 'system' } },
    });
    expect(restored.messages[1]).toMatchObject({
      name: 'operator',
      response_metadata: { trace: { source: 'human' } },
    });
    expect(restored.messages[2]).toMatchObject({
      name: 'tool-planner',
      response_metadata: { finish_reason: 'tool_calls' },
      invalid_tool_calls: [
        {
          id: 'invalid-call-1',
          name: 'read_file',
          args: '{',
          error: 'Unexpected end of JSON input',
        },
      ],
      usage_metadata: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    });
    expect(restored.messages[3]).toBeInstanceOf(ToolMessage);
    expect(restored.messages[3]).toMatchObject({
      tool_call_id: 'call-1',
      name: 'read_file',
      status: 'success',
      response_metadata: { request_id: 'request-1' },
      metadata: { execution: { attempt: 1 } },
      artifact: { fullOutput: { bytes: 9 } },
    });
    expect(restored.blockedTool).toEqual({
      toolCallId: 'call-2',
      toolName: 'shell_execute',
      args: { command: 'bun test' },
      command: 'bun test',
    });
  });

  test('decodes nested JSON state into mutation-isolated runtime messages', () => {
    const continuation: SubAgentContinuation = {
      id: 'sub-isolated',
      role: getRoleConfig('code'),
      task: 'keep nested state isolated',
      messages: [
        new AIMessage({
          content: [{ type: 'text', text: 'original content' }],
          tool_calls: [
            {
              id: 'call-isolated',
              name: 'read_file',
              args: { path: { value: 'src/index.ts' } },
              type: 'tool_call',
            },
          ],
        }),
      ],
      toolCallCount: 1,
      steps: [
        {
          toolName: 'read_file',
          toolArgs: { path: { value: 'src/index.ts' } },
          status: 'awaiting_approval',
        },
      ],
    };
    const snapshot = serializeSubagentContinuation(continuation, {
      toolCallId: 'call-isolated',
      toolName: 'read_file',
      args: { path: { value: 'src/index.ts' } },
      command: 'read src/index.ts',
    });
    const restored = deserializeSubagentContinuation(snapshot);

    ((snapshot.messages[0]!.content as Array<{ text: string }>)[0] as { text: string }).text =
      'mutated content';
    (
      (snapshot.messages[0] as Extract<(typeof snapshot.messages)[number], { type: 'ai' }>)
        .toolCalls[0]!.args.path as { value: string }
    ).value = 'mutated-tool-call';
    (snapshot.steps[0]!.toolArgs.path as { value: string }).value = 'mutated-step';
    (snapshot.blockedTool.args.path as { value: string }).value = 'mutated-blocked-tool';

    const restoredAi = restored.messages[0] as AIMessage;
    expect(restoredAi.content).toEqual([{ type: 'text', text: 'original content' }]);
    expect(restoredAi.tool_calls?.[0]?.args).toEqual({ path: { value: 'src/index.ts' } });
    expect(restored.steps[0]?.toolArgs).toEqual({ path: { value: 'src/index.ts' } });
    expect(restored.blockedTool.args).toEqual({ path: { value: 'src/index.ts' } });
  });

  test('round-trips exhausted ToolMessage status', () => {
    const continuation: SubAgentContinuation = {
      id: 'sub-exhausted',
      role: getRoleConfig('code'),
      task: 'preserve exhausted status',
      messages: [
        new ToolMessage({
          content: 'retry limit reached',
          tool_call_id: 'call-exhausted',
          name: 'shell_execute',
          status: 'exhausted' as unknown as 'success',
        }),
      ],
      toolCallCount: 1,
      steps: [],
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      toolCallId: 'call-exhausted',
      toolName: 'shell_execute',
      args: {},
      command: 'false',
    });
    const restored = deserializeSubagentContinuation(snapshot);

    expect(snapshot.messages[0]).toMatchObject({ type: 'tool', status: 'exhausted' });
    expect(restored.messages[0]).toMatchObject({ status: 'exhausted' });
  });

  test('deserializes pre-metadata snapshots with empty response metadata', () => {
    const legacySnapshot = JSON.parse(
      JSON.stringify({
        subagentId: 'sub-legacy',
        role: 'code',
        task: 'resume old continuation',
        messages: [
          { type: 'system', id: 'system-legacy', content: 'You are a coding agent.' },
          { type: 'human', content: 'Continue.' },
          { type: 'ai', content: '', toolCalls: [], additionalKwargs: {} },
          {
            type: 'tool',
            content: 'ok',
            toolCallId: 'call-legacy',
            name: 'read_file',
            status: 'success',
          },
        ],
        toolCallCount: 1,
        steps: [],
        blockedTool: {
          toolCallId: 'call-legacy',
          toolName: 'read_file',
          args: { path: 'src/index.ts' },
          command: 'read src/index.ts',
        },
      }),
    ) as import('@/protocol/subagent').SuspendedSubagentSnapshot;

    const restored = deserializeSubagentContinuation(legacySnapshot);

    expect(restored.messages).toHaveLength(4);
    expect(restored.messages[0]).toBeInstanceOf(SystemMessage);
    expect(restored.messages[0]?.response_metadata).toEqual({});
    expect(restored.messages[3]).toBeInstanceOf(ToolMessage);
    expect(restored.messages[3]?.response_metadata).toEqual({});
  });

  test('rejects unsupported LangChain message types', () => {
    const continuation = {
      id: 'sub-unsupported',
      role: getRoleConfig('code'),
      task: 'unsupported message',
      messages: [{ getType: () => 'function' }],
      toolCallCount: 0,
      steps: [],
    } as unknown as SubAgentContinuation;

    expect(() =>
      serializeSubagentContinuation(continuation, {
        toolCallId: 'call-1',
        toolName: 'shell_execute',
        args: {},
        command: 'true',
      }),
    ).toThrow('function');
  });
});

describe('resume-specific safety invariants', () => {
  // Regression: resumeSubAgent used a synthetic `${id}-resume` tool_call_id
  // that didn't match any tool_call.id in the AI message, causing 400 errors
  // from the model provider.
  test('blockedTool.toolCallId is preserved and matches the AI message tool_call.id', () => {
    const originalCallId = 'call-blocked-original-123';
    const continuation: SubAgentContinuation = {
      id: 'sub-resume-test',
      role: getRoleConfig('code'),
      task: 'verify tool_call_id matching',
      messages: [
        new AIMessage({
          content: 'I will run a shell command.',
          tool_calls: [
            {
              id: originalCallId,
              name: 'shell_execute',
              args: { command: 'echo test' },
              type: 'tool_call',
            },
          ],
        }),
      ],
      toolCallCount: 1,
      steps: [
        {
          toolName: 'shell_execute',
          toolArgs: { command: 'echo test' },
          status: 'awaiting_approval',
        },
      ],
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      toolCallId: originalCallId,
      toolName: 'shell_execute',
      args: { command: 'echo test' },
      command: 'echo test',
    });

    // JSON round-trip simulates RuntimeState persistence
    const restored = deserializeSubagentContinuation(JSON.parse(JSON.stringify(snapshot)));

    // The blockedTool.toolCallId must match the original AI message tool_call.id
    // so resumeSubAgent can construct a valid ToolMessage.
    expect(restored.blockedTool.toolCallId).toBe(originalCallId);

    // The AI message must still contain the original tool_call
    const aiMsg = restored.messages.find((m) => m.getType() === 'ai') as AIMessage;
    expect(aiMsg).toBeDefined();
    expect(aiMsg.tool_calls).toHaveLength(1);
    expect(aiMsg.tool_calls![0]!.id).toBe(originalCallId);
  });

  // Regression: when an AI message had multiple tool calls and resumeSubAgent
  // only added a ToolMessage for the blocked one, the remaining tool_call_ids
  // had no matching ToolMessage → 400 error from model provider.
  test('multi-tool-call AI message preserves all tool_call IDs after round-trip', () => {
    const callA = 'call-a';
    const callB = 'call-b';
    const callC = 'call-c';
    const continuation: SubAgentContinuation = {
      id: 'sub-multi',
      role: getRoleConfig('code'),
      task: 'multi-tool message',
      messages: [
        new AIMessage({
          content: 'I will do three things.',
          tool_calls: [
            { id: callA, name: 'search_content', args: { pattern: 'foo' }, type: 'tool_call' },
            { id: callB, name: 'read_file', args: { path: 'src/a.ts' }, type: 'tool_call' },
            { id: callC, name: 'write_file', args: { path: '/tmp/f' }, type: 'tool_call' },
          ],
        }),
      ],
      toolCallCount: 0,
      steps: [],
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      toolCallId: callC,
      toolName: 'write_file',
      args: { path: '/tmp/f' },
      command: 'write_file /tmp/f',
    });

    const restored = deserializeSubagentContinuation(JSON.parse(JSON.stringify(snapshot)));

    const aiMsg = restored.messages.find((m) => m.getType() === 'ai') as AIMessage;
    const ids = aiMsg.tool_calls!.map((tc) => tc.id);

    // All three original IDs must survive the round-trip
    expect(ids).toContain(callA);
    expect(ids).toContain(callB);
    expect(ids).toContain(callC);

    // The blocked tool references the correct one
    expect(restored.blockedTool.toolCallId).toBe(callC);
  });

  // Regression: when blockedTool.toolCallId is synthetic (like `${id}-resume`),
  // it won't match any AI message tool_call.id. This test ensures the chain
  // from blocked tool → AI message is always traceable.
  test('blockedTool.toolCallId always references a tool_call present in the AI message', () => {
    const realId = 'tc-real-1';
    const continuation: SubAgentContinuation = {
      id: 'sub-traceable',
      role: getRoleConfig('code'),
      task: 'traceable tool id',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: realId, name: 'shell_execute', args: { command: 'ls' }, type: 'tool_call' },
          ],
        }),
      ],
      toolCallCount: 1,
      steps: [
        { toolName: 'shell_execute', toolArgs: { command: 'ls' }, status: 'awaiting_approval' },
      ],
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      toolCallId: realId,
      toolName: 'shell_execute',
      args: { command: 'ls' },
      command: 'ls',
    });

    const restored = deserializeSubagentContinuation(JSON.parse(JSON.stringify(snapshot)));

    const aiMsg = restored.messages.find((m) => m.getType() === 'ai') as AIMessage;
    const hasMatchingCall = aiMsg.tool_calls?.some(
      (tc) => tc.id === restored.blockedTool.toolCallId,
    );
    expect(hasMatchingCall).toBe(true);
  });
});
