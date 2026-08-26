import { describe, expect, test } from 'bun:test';
import type { ToolGovernanceInvocationFact, ToolGovernancePolicyFact } from '@kite-ai/agent-kernel';
import {
  classifyToolOutcome,
  createToolApprovalBindingDigest,
  createToolRecoveryJournal,
  recordRecoveryFailure,
} from '@kite-ai/agent-kernel';
import type { AIMessage } from '@kite-ai/builtin-runtime/model';
import {
  aiMessage,
  humanMessage,
  isAIMessage,
  isHumanMessage,
  isSystemMessage,
  isToolMessage,
  systemMessage,
  toolMessage,
} from '@kite-ai/builtin-runtime/model';
import { getRoleConfig } from '@kite-ai/builtin-runtime/subagent';
import { classifyFailure } from '#kite-service/bootstrap/runtime/failures';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
} from '#kite-service/bootstrap/runtime/subagent/continuation-codec';
import type { SubAgentContinuation } from '#kite-service/bootstrap/runtime/subagent/types';

const TEST_RECOVERY_IDENTITY_KEY = '1'.repeat(64);

const failedOutcome = classifyToolOutcome({
  status: 'failed',
  failure: classifyFailure('tool_runtime_error', 'redacted'),
  authority: { dispatchState: 'unknown', externalEffects: 'unknown' },
});

const bindingInvocationFact: ToolGovernanceInvocationFact = {
  workspace: '/workspace',
  threadId: 'thread-binding',
  turnId: 'turn-binding',
  modelMessageId: 'model-binding',
  toolCallId: 'call-2',
  exposedToolName: 'shell_execute',
  operationId: 'builtin:shell_execute',
  capabilityId: 'builtin:shell_execute',
  capabilityRevision: '1'.repeat(64),
  executorRevision: null,
  descriptorRevision: '2'.repeat(64),
  parserRevision: '3'.repeat(64),
  schemaDigest: '4'.repeat(64),
  argumentsDigest: '5'.repeat(64),
  effectiveEffectsDigest: '6'.repeat(64),
  bindingId: null,
  builtinCatalogRevision: '7'.repeat(64),
  dynamicCatalogRevision: null,
  nestedCapabilityId: null,
  nestedCapabilityRevision: null,
  nestedCatalogRevision: null,
  commandDigest: '8'.repeat(64),
};

const bindingPolicyFact: ToolGovernancePolicyFact = {
  operationId: 'builtin:shell_execute',
  capabilityRevision: '1'.repeat(64),
  parserRevision: '3'.repeat(64),
  effectiveEffectsDigest: '6'.repeat(64),
  minimumApproval: 'user',
  fullAccessMayBypassApproval: false,
  sameCommandMayBypassApproval: false,
  decision: 'ask',
  allowed: true,
  requiresApproval: true,
  risk: 'execute_code',
  effects: { uncertainEffects: true },
  reason: 'The command requires approval.',
  expectedEffects: ['execute code'],
};

const exactApprovalBinding = {
  schema: 'kite.app-approval-binding.v1' as const,
  digest: createToolApprovalBindingDigest(bindingInvocationFact, bindingPolicyFact),
  invocationFact: bindingInvocationFact,
  policyFact: bindingPolicyFact,
  childToolCallId: 'call-2',
};

function recomputeApprovalBindingDigest(binding: Record<string, unknown>): void {
  binding.digest = createToolApprovalBindingDigest(
    binding.invocationFact as ToolGovernanceInvocationFact,
    binding.policyFact as ToolGovernancePolicyFact,
  );
}

describe('sub-agent continuation codec', () => {
  test('round-trips JSON-safe continuation snapshots with LangChain message details', () => {
    const childRecovery = recordRecoveryFailure(
      createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
      {
        toolCallId: 'child-failure',
        toolName: 'read_file',
        invocationFingerprint: 'a'.repeat(64),
        modelMessageId: 'child-model',
        outcome: failedOutcome,
      },
    );
    const continuation: SubAgentContinuation = {
      id: 'sub-1',
      role: getRoleConfig('code'),
      task: 'inspect the repository',
      messages: [
        systemMessage('You are a coding agent.', {
          id: 'system-1',
          name: 'system-instructions',
          response_metadata: { trace: { source: 'system' } },
        }),
        humanMessage({
          content: 'Inspect src.',
          id: 'human-1',
          name: 'operator',
          response_metadata: { trace: { source: 'human' } },
        }),
        aiMessage({
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
        toolMessage({
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
      toolRecovery: childRecovery,
      allowedTools: ['mcp__fixture__read', 'read_file'],
      mcpBindingIds: ['binding-fixture-read'],
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
      toolCallId: 'call-2',
      toolName: 'shell_execute',
      args: { command: 'bun test' },
      command: 'bun test',
      approvalBinding: exactApprovalBinding,
    });
    const restored = deserializeSubagentContinuation(
      JSON.parse(JSON.stringify(snapshot)),
      TEST_RECOVERY_IDENTITY_KEY,
    );
    expect([...restored.role.allowedTools!]).toEqual(['mcp__fixture__read', 'read_file']);
    expect(restored.allowedTools).toEqual(['mcp__fixture__read', 'read_file']);
    expect(restored.mcpBindingIds).toEqual(['binding-fixture-read']);

    expect(snapshot).toEqual(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.id).toBe('sub-1');
    expect(restored.role).toEqual({
      ...getRoleConfig('code'),
      allowedTools: new Set(['mcp__fixture__read', 'read_file']),
    });
    expect(restored.task).toBe('inspect the repository');
    expect(restored.toolCallCount).toBe(2);
    expect(restored.steps).toEqual(continuation.steps);
    expect(restored.executionJournal).toEqual(continuation.executionJournal);
    expect(restored.exhaustedFingerprints).toEqual(continuation.exhaustedFingerprints);
    expect(restored.toolRecovery).toEqual(childRecovery);
    expect(restored.blockedTool.reasonCode).toBe('SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW');
    expect(isSystemMessage(restored.messages[0])).toBe(true);
    expect(isHumanMessage(restored.messages[1])).toBe(true);
    expect(isAIMessage(restored.messages[2])).toBe(true);
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
    expect(isToolMessage(restored.messages[3])).toBe(true);
    expect(restored.messages[3]).toMatchObject({
      tool_call_id: 'call-1',
      name: 'read_file',
      status: 'success',
      response_metadata: { request_id: 'request-1' },
      metadata: { execution: { attempt: 1 } },
      artifact: { fullOutput: { bytes: 9 } },
    });
    expect(restored.blockedTool).toEqual({
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
      toolCallId: 'call-2',
      toolName: 'shell_execute',
      args: { command: 'bun test' },
      command: 'bun test',
      approvalBinding: exactApprovalBinding,
    });
  });

  test.each([
    [
      'unknown envelope field',
      (binding: Record<string, unknown>) => {
        binding.unexpected = true;
      },
    ],
    [
      'unknown invocation field',
      (binding: Record<string, unknown>) => {
        (binding.invocationFact as Record<string, unknown>).unexpected = true;
        recomputeApprovalBindingDigest(binding);
      },
    ],
    [
      'unknown policy field',
      (binding: Record<string, unknown>) => {
        (binding.policyFact as Record<string, unknown>).unexpected = true;
        recomputeApprovalBindingDigest(binding);
      },
    ],
    [
      'missing invocation field',
      (binding: Record<string, unknown>) => {
        Reflect.deleteProperty(binding.invocationFact as object, 'schemaDigest');
        recomputeApprovalBindingDigest(binding);
      },
    ],
    [
      'invalid policy enum',
      (binding: Record<string, unknown>) => {
        Reflect.set(binding.policyFact as object, 'minimumApproval', 'system');
        recomputeApprovalBindingDigest(binding);
      },
    ],
    [
      'unknown nested effects field',
      (binding: Record<string, unknown>) => {
        Reflect.set(binding.policyFact as Record<string, unknown>, 'effects', {
          uncertainEffects: true,
          unexpected: true,
        });
        recomputeApprovalBindingDigest(binding);
      },
    ],
    [
      'invalid expected effect shape',
      (binding: Record<string, unknown>) => {
        Reflect.set(binding.policyFact as object, 'expectedEffects', ['execute code', 7]);
        recomputeApprovalBindingDigest(binding);
      },
    ],
    [
      'tampered digest',
      (binding: Record<string, unknown>) => {
        binding.digest = '0'.repeat(64);
      },
    ],
  ] as const)('rejects a malformed approval binding in a continuation: %s', (_label, mutate) => {
    const continuation: SubAgentContinuation = {
      id: 'sub-binding-invalid',
      role: getRoleConfig('code'),
      task: 'resume safely',
      messages: [humanMessage('continue')],
      toolCallCount: 1,
      steps: [],
      toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
    };
    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'call-2',
      toolName: 'shell_execute',
      args: { command: 'true' },
      command: 'true',
      approvalBinding: exactApprovalBinding,
    });
    const tampered = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const binding = tampered.blockedTool.approvalBinding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error('expected a JSON approval binding fixture');
    }
    mutate(binding as Record<string, unknown>);

    expect(() => deserializeSubagentContinuation(tampered, TEST_RECOVERY_IDENTITY_KEY)).toThrow(
      'approval binding is malformed',
    );
  });

  test('fails closed when a current continuation snapshot omits its recovery journal', () => {
    const continuation: SubAgentContinuation = {
      id: 'sub-current-missing-journal',
      role: getRoleConfig('code'),
      task: 'resume safely',
      messages: [humanMessage('continue')],
      toolCallCount: 1,
      steps: [],
      toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
    };
    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'blocked-current',
      toolName: 'shell_execute',
      args: { command: 'true' },
      command: 'true',
    });
    delete (snapshot as Partial<typeof snapshot>).toolRecovery;

    expect(() => deserializeSubagentContinuation(snapshot, TEST_RECOVERY_IDENTITY_KEY)).toThrow();
  });

  test('fails closed when a current continuation forges internally matching failure ids', () => {
    const journal = recordRecoveryFailure(createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY), {
      toolCallId: 'child-forged',
      toolName: 'read_file',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'child-model',
      outcome: failedOutcome,
      turnId: 'child-turn',
    });
    const continuation: SubAgentContinuation = {
      id: 'sub-current-forged-journal',
      role: getRoleConfig('code'),
      task: 'resume safely',
      messages: [humanMessage('continue')],
      toolCallCount: 1,
      steps: [],
      toolRecovery: journal,
    };
    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'blocked-current',
      toolName: 'shell_execute',
      args: { command: 'true' },
      command: 'true',
    });
    const originalId = journal.order[0]!;
    const forgedId = 'b'.repeat(64);
    const original = journal.failures[originalId]!;
    snapshot.toolRecovery = {
      ...journal,
      order: [forgedId],
      failures: {
        [forgedId]: {
          ...original,
          failureInstanceId: forgedId,
          outcome: {
            ...original.outcome,
            lineage: { ...original.outcome.lineage, failureInstanceId: forgedId },
          },
        },
      },
    } as never;

    const restored = deserializeSubagentContinuation(snapshot, TEST_RECOVERY_IDENTITY_KEY);
    expect(restored.toolRecovery?.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
      turnId: 'child-turn',
    });
  });

  test('decodes nested JSON state into mutation-isolated runtime messages', () => {
    const continuation: SubAgentContinuation = {
      id: 'sub-isolated',
      role: getRoleConfig('code'),
      task: 'keep nested state isolated',
      messages: [
        aiMessage({
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
      toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
    };
    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'call-isolated',
      toolName: 'read_file',
      args: { path: { value: 'src/index.ts' } },
      command: 'read src/index.ts',
    });
    const restored = deserializeSubagentContinuation(snapshot, TEST_RECOVERY_IDENTITY_KEY);

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
        toolMessage({
          content: 'retry limit reached',
          tool_call_id: 'call-exhausted',
          name: 'shell_execute',
          status: 'exhausted',
        }),
      ],
      toolCallCount: 1,
      steps: [],
      toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'call-exhausted',
      toolName: 'shell_execute',
      args: {},
      command: 'false',
    });
    const restored = deserializeSubagentContinuation(snapshot, TEST_RECOVERY_IDENTITY_KEY);

    expect(snapshot.messages[0]).toMatchObject({ type: 'tool', status: 'exhausted' });
    expect(restored.messages[0]).toMatchObject({ status: 'exhausted' });
  });

  test('rejects pre-metadata continuation snapshots', () => {
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
    ) as import('@kite-ai/runtime-spi').SuspendedSubagentSnapshot;

    expect(() =>
      deserializeSubagentContinuation(legacySnapshot, TEST_RECOVERY_IDENTITY_KEY),
    ).toThrow();
  });

  test('rejects unsupported LangChain message types', () => {
    const continuation: SubAgentContinuation = {
      id: 'sub-unsupported',
      role: getRoleConfig('code'),
      task: 'unsupported message',
      messages: [],
      toolCallCount: 0,
      steps: [],
      toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
    };
    Reflect.set(continuation, 'messages', [{ type: 'function' }]);

    expect(() =>
      serializeSubagentContinuation(continuation, {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
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
        aiMessage({
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
      toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: originalCallId,
      toolName: 'shell_execute',
      args: { command: 'echo test' },
      command: 'echo test',
    });

    // JSON round-trip simulates RuntimeState persistence
    const restored = deserializeSubagentContinuation(
      JSON.parse(JSON.stringify(snapshot)),
      TEST_RECOVERY_IDENTITY_KEY,
    );

    // The blockedTool.toolCallId must match the original AI message tool_call.id
    // so resumeSubAgent can construct a valid ToolMessage.
    expect(restored.blockedTool.toolCallId).toBe(originalCallId);

    // The AI message must still contain the original tool_call
    const aiMsg = restored.messages.find((m) => m.type === 'ai') as AIMessage;
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
        aiMessage({
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
      toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: callC,
      toolName: 'write_file',
      args: { path: '/tmp/f' },
      command: 'write_file /tmp/f',
    });

    const restored = deserializeSubagentContinuation(
      JSON.parse(JSON.stringify(snapshot)),
      TEST_RECOVERY_IDENTITY_KEY,
    );

    const aiMsg = restored.messages.find((m) => m.type === 'ai') as AIMessage;
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
        aiMessage({
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
      toolRecovery: createToolRecoveryJournal(TEST_RECOVERY_IDENTITY_KEY),
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: realId,
      toolName: 'shell_execute',
      args: { command: 'ls' },
      command: 'ls',
    });

    const restored = deserializeSubagentContinuation(
      JSON.parse(JSON.stringify(snapshot)),
      TEST_RECOVERY_IDENTITY_KEY,
    );

    const aiMsg = restored.messages.find((m) => m.type === 'ai') as AIMessage;
    const hasMatchingCall = aiMsg.tool_calls?.some(
      (tc) => tc.id === restored.blockedTool.toolCallId,
    );
    expect(hasMatchingCall).toBe(true);
  });
});
