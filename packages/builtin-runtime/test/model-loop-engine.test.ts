import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AIMessage, BaseMessage, ToolMessage } from '@kite-ai/builtin-runtime/model';
import {
  aiMessage,
  type BuiltinModelEvent,
  type BuiltinSubagentModelStepInput,
  type BuiltinSubagentModelStepResult,
  createChatModel,
  humanMessage,
  type ModelInvocationStateView,
  type ModelRuntimeConfig,
  systemMessage,
  toolMessage,
} from '@kite-ai/builtin-runtime/model';
import {
  type BuiltinSubagentModelLoopCoordinator,
  createBuiltinSubagentModelLoopEngine,
  DEFAULT_SUBAGENT_MAX_TOOL_ROUNDS,
} from '@kite-ai/builtin-runtime/subagent';
import type { ToolSet } from 'ai';
import { SubagentCheckpointArtifactStore } from '../src/subagent/checkpoint-artifacts';
import { createBuiltinSubagentFollowupModelLoopEngine } from '../src/subagent/model-loop-engine';

const CONFIG: ModelRuntimeConfig = Object.freeze({
  apiKey: 'model-loop-engine-test-key',
  baseURL: 'https://model-loop-engine.invalid/v1',
  modelName: 'model-loop-engine-test',
  providerName: 'model-loop-engine-test',
  providerType: 'openai-compatible',
  sandbox: Object.freeze({ enabled: false }),
});

const MODEL = createChatModel(CONFIG);
const TOOLS: ToolSet = Object.freeze({});
const INITIAL_MESSAGE = humanMessage('Inspect the bounded child task.');

const PROVENANCE = Object.freeze({
  parentInvocationId: 'parent-invocation',
  parentToolCallId: 'parent-tool-call',
  contextCheckpointId: 'checkpoint-1',
  promptContractVersion: 'prompt-contract-v2',
  projectionEnvironment: Object.freeze({
    role: 'explore',
    projectInstructions: null,
    workspaceAccess: 'write',
    phase: 'building',
  }),
  capabilityBindings: Object.freeze([]),
});

const PERSISTENCE = {
  getState: () =>
    Object.freeze({
      revision: 25,
      session: Object.freeze({ threadId: 'model-loop-thread' }),
      turn: Object.freeze({ turnId: 'model-loop-turn' }),
      resourceBudget: Object.freeze({ status: 'unconfigured' }),
    }),
  persistEvents: async () => true,
};

function coordinatorFor(responses: readonly AIMessage[]): {
  coordinator: BuiltinSubagentModelLoopCoordinator;
  calls: Array<{
    readonly messages: readonly BaseMessage[];
    readonly tools: ToolSet;
    readonly estimatedInputTokens: number;
    readonly maxOutputTokens?: number;
    readonly parentReservationId?: string;
    readonly parentInvocationId?: string | null;
    readonly parentToolCallId?: string | null;
  }>;
} {
  let responseIndex = 0;
  const calls: Array<{
    readonly messages: readonly BaseMessage[];
    readonly tools: ToolSet;
    readonly estimatedInputTokens: number;
    readonly maxOutputTokens?: number;
    readonly parentReservationId?: string;
    readonly parentInvocationId?: string | null;
    readonly parentToolCallId?: string | null;
  }> = [];
  const coordinator: BuiltinSubagentModelLoopCoordinator = {
    executeSubagentModelStep: async <
      State extends ModelInvocationStateView,
      Event extends BuiltinModelEvent,
    >(
      input: BuiltinSubagentModelStepInput<State, Event>,
    ): Promise<BuiltinSubagentModelStepResult> => {
      const response = responses[responseIndex];
      if (!response) throw new Error('model-loop test ran past its response fixture.');
      responseIndex += 1;
      calls.push({
        messages: input.messages,
        tools: input.tools,
        estimatedInputTokens: input.estimatedInputTokens!,
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
        ...(input.parentReservationId === undefined
          ? {}
          : { parentReservationId: input.parentReservationId }),
        parentInvocationId: input.provenance?.parentInvocationId,
        parentToolCallId: input.provenance?.parentToolCallId,
      });
      return {
        invocationId: `loop-invocation-${responseIndex}`,
        message: response,
        cacheMetrics: null,
      };
    },
  };
  return { coordinator, calls };
}

function inputFor(
  coordinator: BuiltinSubagentModelLoopCoordinator,
  overrides: Partial<Parameters<typeof createBuiltinSubagentModelLoopEngine>[0]> = {},
) {
  return {
    coordinator,
    initialMessages: [INITIAL_MESSAGE],
    startModelInvocationOrdinal: 0,
    maxToolRounds: DEFAULT_SUBAGENT_MAX_TOOL_ROUNDS,
    model: MODEL,
    config: CONFIG,
    tools: TOOLS,
    persistence: PERSISTENCE,
    provenance: PROVENANCE,
    providerDataAdmission: () => ({
      admitted: true,
      reason: 'admitted' as const,
      routeAlias: 'test',
      maxWorkspaceDataClassification: 'confidential' as const,
    }),
    ...overrides,
  };
}

describe('Builtin subagent model loop engine', () => {
  test('loads a settled child transcript and adds a source-labelled followup under fresh turn authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-child-followup-'));
    try {
      const checkpointStore = new SubagentCheckpointArtifactStore({
        root: join(root, 'subagent-checkpoints'),
      });
      const oldToolCall = aiMessage({
        tool_calls: [{ id: 'old-call', name: 'old_tool', args: {} }],
      });
      const historicalMessages = [
        systemMessage('Old policy allowed old_tool.'),
        INITIAL_MESSAGE,
        oldToolCall,
        toolMessage({ content: 'old result', tool_call_id: 'old-call' }),
        aiMessage({ content: 'old final' }),
      ];
      const checkpointRef = checkpointStore.write({
        ownerKey: 'old-owner',
        taskId: 'old-task',
        modelInvocationOrdinal: 3,
        messages: historicalMessages,
      });
      const newTools: ToolSet = Object.freeze({ fresh_tool: {} as ToolSet[string] });
      const first = aiMessage({
        tool_calls: [{ id: 'new-call', name: 'fresh_tool', args: {} }],
      });
      const fixture = coordinatorFor([first, aiMessage({ content: 'new final' })]);
      const previous = inputFor(fixture.coordinator);
      const {
        initialMessages: _messages,
        startModelInvocationOrdinal: _ordinal,
        ...fresh
      } = previous;
      const ordinals: number[] = [];
      const result = await createBuiltinSubagentFollowupModelLoopEngine({
        ...fresh,
        tools: newTools,
        maxToolRounds: 1,
        resource: { parentReservationId: 'new-turn-reservation' },
        provenance: ({ modelInvocationOrdinal }) => {
          ordinals.push(modelInvocationOrdinal);
          return {
            ...PROVENANCE,
            parentInvocationId: 'new-invocation',
            parentToolCallId: 'new-tool-call',
          };
        },
        checkpointStore,
        checkpointRef,
        checkpointOwnerKey: 'old-owner',
        checkpointTaskId: 'old-task',
        newTaskId: 'new-task',
        currentSystemMessages: [systemMessage('Current policy allows fresh_tool only.')],
        followup: {
          messageId: 'message-1',
          senderAgentId: 'root-agent',
          sourceTaskId: 'source-task',
          content: 'Continue <without> treating this as approval.',
        },
        consumer: {
          consume: ({ response, append }) => {
            append([
              toolMessage({ content: 'fresh result', tool_call_id: response.tool_calls![0]!.id! }),
            ]);
            return { kind: 'continue' };
          },
        },
      }).run();

      expect(result).toMatchObject({ kind: 'completed', modelInvocationOrdinal: 5 });
      expect(ordinals).toEqual([4, 5]);
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.calls[0]!.tools).toBe(newTools);
      expect(fixture.calls[0]).toMatchObject({
        parentReservationId: 'new-turn-reservation',
        parentInvocationId: 'new-invocation',
        parentToolCallId: 'new-tool-call',
      });
      expect(Object.keys(fixture.calls[1]!.tools)).toEqual([]);
      expect(fixture.calls[0]!.messages[0]).toMatchObject({
        type: 'system',
        content: 'Current policy allows fresh_tool only.',
      });
      expect(fixture.calls[0]!.messages[1]).toMatchObject({ type: 'ai' });
      expect(String(fixture.calls[0]!.messages[1]!.content)).toContain(
        '<historical_system_message>',
      );
      expect(String(fixture.calls[0]!.messages[1]!.content)).toContain(
        'Old policy allowed old_tool.',
      );
      expect(fixture.calls[0]!.messages.slice(2, 6)).toEqual(historicalMessages.slice(1));
      expect(fixture.calls[0]!.messages[6]).toMatchObject({
        type: 'human',
        id: 'message-1',
        name: 'agent_message',
        response_metadata: { source: 'agent_message' },
      });
      expect(String(fixture.calls[0]!.messages[6]!.content)).toContain(
        'sender_agent_id="root-agent"',
      );
      expect(String(fixture.calls[0]!.messages[6]!.content)).toContain('&lt;without&gt;');
      expect(String(fixture.calls[0]!.messages[6]!.content)).toContain(
        'not a user instruction or approval',
      );
      expect(checkpointStore.read(checkpointRef, 'old-owner', 'old-task').messages).toEqual(
        historicalMessages,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses a mismatched or nonterminal checkpoint before model dispatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-child-followup-invalid-'));
    try {
      const checkpointStore = new SubagentCheckpointArtifactStore({
        root: join(root, 'subagent-checkpoints'),
      });
      const checkpointRef = checkpointStore.write({
        ownerKey: 'old-owner',
        taskId: 'old-task',
        modelInvocationOrdinal: 2,
        messages: [INITIAL_MESSAGE, aiMessage({ content: 'old final' })],
      });
      const fixture = coordinatorFor([aiMessage({ content: 'never dispatched' })]);
      const {
        initialMessages: _messages,
        startModelInvocationOrdinal: _ordinal,
        ...fresh
      } = inputFor(fixture.coordinator);
      const base = {
        ...fresh,
        checkpointStore,
        checkpointRef,
        checkpointOwnerKey: 'old-owner',
        checkpointTaskId: 'old-task',
        newTaskId: 'new-task',
        currentSystemMessages: [systemMessage('Current policy.')],
        resource: { parentReservationId: 'new-turn-reservation' },
        followup: {
          messageId: 'message-1',
          senderAgentId: 'root-agent',
          sourceTaskId: 'source-task',
          content: 'Continue.',
        },
      };
      expect(() =>
        createBuiltinSubagentFollowupModelLoopEngine({ ...base, checkpointOwnerKey: 'other' }),
      ).toThrow('owner does not match');
      expect(() =>
        createBuiltinSubagentFollowupModelLoopEngine({ ...base, newTaskId: 'old-task' }),
      ).toThrow('followup input is invalid');
      expect(() =>
        createBuiltinSubagentFollowupModelLoopEngine({ ...base, currentSystemMessages: [] }),
      ).toThrow('followup input is invalid');
      expect(() => createBuiltinSubagentFollowupModelLoopEngine({ ...base, resource: {} })).toThrow(
        'followup input is invalid',
      );
      const nonterminalRef = checkpointStore.write({
        ownerKey: 'old-owner',
        taskId: 'old-task',
        modelInvocationOrdinal: 2,
        messages: [
          INITIAL_MESSAGE,
          aiMessage({ tool_calls: [{ id: 'pending', name: 'read_file', args: {} }] }),
        ],
      });
      expect(() =>
        createBuiltinSubagentFollowupModelLoopEngine({ ...base, checkpointRef: nonterminalRef }),
      ).toThrow('terminal checkpoint');
      expect(fixture.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('retains the exact failed model invocation identity in a bounded loop diagnostic', async () => {
    const coordinator: BuiltinSubagentModelLoopCoordinator = {
      executeSubagentModelStep: async () => {
        throw Object.assign(new Error('private provider failure'), {
          invocationId: 'failed-child-model-invocation',
        });
      },
    };

    const error = await createBuiltinSubagentModelLoopEngine(inputFor(coordinator))
      .run()
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: 'model_step_failed',
      stage: 'model_step',
      modelInvocationId: 'failed-child-model-invocation',
    });
    expect(String(error)).not.toContain('private provider failure');
  });

  test('runs two model rounds with exact ordinals and controlled ToolMessage append', async () => {
    const first = aiMessage({
      content: '',
      tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: 'README.md' } }],
    });
    const second = aiMessage({ content: 'bounded child complete' });
    const fixture = coordinatorFor([first, second]);
    const provenanceOrdinals: number[] = [];
    const engine = createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        startModelInvocationOrdinal: 7,
        provenance: ({ modelInvocationOrdinal }) => {
          provenanceOrdinals.push(modelInvocationOrdinal);
          return PROVENANCE;
        },
        resource: {
          maxOutputTokens: ({ modelInvocationOrdinal, estimatedInputTokens }) => {
            expect(estimatedInputTokens).toBeGreaterThan(0);
            return modelInvocationOrdinal * 10;
          },
        },
        consumer: {
          consume: ({ transcript, response, append }) => {
            expect(Object.isFrozen(transcript)).toBe(true);
            expect(Object.isFrozen(response)).toBe(true);
            append([
              toolMessage({
                content: JSON.stringify({ ok: true, path: 'README.md' }),
                tool_call_id: response.tool_calls![0]!.id!,
                name: response.tool_calls![0]!.name,
              }),
            ]);
            return { kind: 'continue' };
          },
        },
      }),
    );

    const result = await engine.run();

    expect(result).toMatchObject({
      kind: 'completed',
      invocationId: 'loop-invocation-2',
      summary: 'bounded child complete',
      modelInvocationOrdinal: 9,
    });
    expect(provenanceOrdinals).toEqual([8, 9]);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.map((call) => call.maxOutputTokens)).toEqual([80, 90]);
    expect(fixture.calls[1]!.messages.map((message) => message.type)).toEqual([
      'human',
      'ai',
      'tool',
    ]);
    if (result.kind !== 'completed') throw new Error('expected completed model loop');
    expect(Object.isFrozen(result.messages)).toBe(true);
  });

  test('forces one tool-free finalization after the bounded tool rounds', async () => {
    const toolRound = (id: string) =>
      aiMessage({
        tool_calls: [{ id, name: 'read_file', args: { path: `${id}.ts` } }],
      });
    const fixture = coordinatorFor([
      toolRound('call-1'),
      toolRound('call-2'),
      aiMessage({ content: 'finalized from collected evidence' }),
    ]);
    const result = await createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        maxToolRounds: 2,
        consumer: {
          consume: ({ append, response }) => {
            append([
              toolMessage({
                content: 'ok',
                tool_call_id: response.tool_calls![0]!.id!,
              }),
            ]);
            return { kind: 'continue' };
          },
        },
      }),
    ).run();

    expect(result).toMatchObject({
      kind: 'completed',
      summary: 'finalized from collected evidence',
      modelInvocationOrdinal: 3,
    });
    expect(fixture.calls).toHaveLength(3);
    expect(Object.keys(fixture.calls[2]!.tools)).toEqual([]);
    expect(fixture.calls[2]!.messages.at(-1)?.content).toContain('Return the concise final result');
  });

  test('fails closed when the tool-free finalization still returns a tool call', async () => {
    const toolRound = (id: string) =>
      aiMessage({ tool_calls: [{ id, name: 'read_file', args: { path: `${id}.ts` } }] });
    const fixture = coordinatorFor([toolRound('call-1'), toolRound('forged-final-tool')]);
    const run = createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        maxToolRounds: 1,
        consumer: {
          consume: ({ append, response }) => {
            append([toolMessage({ content: 'ok', tool_call_id: response.tool_calls![0]!.id! })]);
            return { kind: 'continue' };
          },
        },
      }),
    ).run();

    await expect(run).rejects.toMatchObject({
      code: 'internal_error',
      stage: 'model_response_validation',
      modelInvocationId: 'loop-invocation-2',
    });
    expect(fixture.calls).toHaveLength(2);
    expect(Object.keys(fixture.calls[1]!.tools)).toEqual([]);
  });

  test('does not reset the finalization ceiling when a suspended child resumes', async () => {
    const fixture = coordinatorFor([aiMessage({ content: 'finalized after resume' })]);
    const result = await createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        startModelInvocationOrdinal: 2,
        maxToolRounds: 2,
      }),
    ).run();

    expect(result).toMatchObject({
      kind: 'completed',
      summary: 'finalized after resume',
      modelInvocationOrdinal: 3,
    });
    expect(fixture.calls).toHaveLength(1);
    expect(Object.keys(fixture.calls[0]!.tools)).toEqual([]);
  });

  test('rejects an invalid local loop ceiling before model dispatch', () => {
    const fixture = coordinatorFor([aiMessage({ content: 'never dispatched' })]);
    expect(() =>
      createBuiltinSubagentModelLoopEngine(inputFor(fixture.coordinator, { maxToolRounds: 0 })),
    ).toThrow('maxToolRounds');
    expect(fixture.calls).toHaveLength(0);
  });

  test('does not dispatch an unsafe model invocation ordinal', async () => {
    const fixture = coordinatorFor([
      aiMessage({ tool_calls: [{ id: 'last-call', name: 'read_file', args: {} }] }),
    ]);
    const run = createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        startModelInvocationOrdinal: Number.MAX_SAFE_INTEGER - 1,
        startToolRounds: 0,
        consumer: {
          consume: ({ response, append }) => {
            append([toolMessage({ content: 'ok', tool_call_id: response.tool_calls![0]!.id! })]);
            return { kind: 'continue' };
          },
        },
      }),
    ).run();

    await expect(run).rejects.toMatchObject({
      code: 'invalid_input',
      stage: 'next_round_preparation',
    });
    expect(fixture.calls).toHaveLength(1);
  });

  test('returns terminal text and frozen transcript when the model has no tool calls', async () => {
    const response = aiMessage({ content: [{ type: 'text', text: 'terminal text' }] });
    const fixture = coordinatorFor([response]);
    const result = await createBuiltinSubagentModelLoopEngine(inputFor(fixture.coordinator)).run();

    expect(result).toMatchObject({
      kind: 'completed',
      summary: 'terminal text',
      invocationId: 'loop-invocation-1',
      modelInvocationOrdinal: 1,
    });
    expect(fixture.calls).toHaveLength(1);
    if (result.kind !== 'completed') throw new Error('expected completed model loop');
    expect(result.messages).toHaveLength(2);
    expect(Object.isFrozen(result.messages)).toBe(true);
  });

  test('allows an asynchronous consumer suspension before continuing', async () => {
    const first = aiMessage({
      tool_calls: [{ id: 'call-suspend', name: 'read_file', args: { path: 'x' } }],
    });
    const second = aiMessage({ content: 'resumed' });
    const fixture = coordinatorFor([first, second]);
    let release!: () => void;
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    let consumerCalls = 0;
    const run = createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        consumer: {
          consume: async ({ append, response }) => {
            consumerCalls += 1;
            await suspended;
            append([
              toolMessage({
                content: 'ok',
                tool_call_id: response.tool_calls![0]!.id!,
              }),
            ]);
            return { kind: 'continue' };
          },
        },
      }),
    ).run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(consumerCalls).toBe(1);
    expect(fixture.calls).toHaveLength(1);
    release();
    await expect(run).resolves.toMatchObject({ kind: 'completed', summary: 'resumed' });
    expect(fixture.calls).toHaveLength(2);
  });

  test('aborts before coordinator dispatch with zero calls', async () => {
    const fixture = coordinatorFor([aiMessage({ content: 'never' })]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      createBuiltinSubagentModelLoopEngine(
        inputFor(fixture.coordinator, { signal: controller.signal }),
      ).run(),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(fixture.calls).toHaveLength(0);
  });

  test('classifies a post-tool next-round preparation failure without retaining its message', async () => {
    const first = aiMessage({
      tool_calls: [{ id: 'call-preparation', name: 'read_file', args: { path: 'x' } }],
    });
    const fixture = coordinatorFor([first]);
    let preparationCount = 0;
    const run = createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        resource: {
          maxOutputTokens: () => {
            preparationCount += 1;
            if (preparationCount === 2) throw new Error('private next-round failure detail');
            return 128;
          },
        },
        consumer: {
          consume: ({ append, response }) => {
            append([
              toolMessage({
                content: 'ok',
                tool_call_id: response.tool_calls![0]!.id!,
              }),
            ]);
            return { kind: 'continue' };
          },
        },
      }),
    ).run();

    await expect(run).rejects.toMatchObject({
      code: 'internal_error',
      stage: 'next_round_preparation',
      message: 'Subagent model loop failed internally.',
    });
    await expect(run).rejects.not.toThrow('private next-round failure detail');
    expect(fixture.calls).toHaveLength(1);
  });

  test('keeps the consumer terminal object unchanged', async () => {
    const response = aiMessage({
      tool_calls: [{ id: 'call-terminal', name: 'read_file', args: { path: 'x' } }],
    });
    const fixture = coordinatorFor([response]);
    const terminal = Object.freeze({
      kind: 'terminal' as const,
      value: Object.freeze({ status: 'suspended', reason: 'approval' }),
    });
    const result = await createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        consumer: {
          consume: () => terminal,
        },
      }),
    ).run();
    expect(result).toBe(terminal);
    expect(fixture.calls).toHaveLength(1);
  });

  test('isolates the consumer transcript and rejects uncontrolled appends', async () => {
    const first = aiMessage({
      content: 'before tool',
      tool_calls: [{ id: 'call-guard', name: 'read_file', args: { path: 'x' } }],
    });
    const second = aiMessage({ content: 'after guard' });
    const fixture = coordinatorFor([first, second]);
    let appendRejected = false;
    const sourceTool = toolMessage({ content: 'source', tool_call_id: 'call-guard' });
    const result = await createBuiltinSubagentModelLoopEngine(
      inputFor(fixture.coordinator, {
        consumer: {
          consume: ({ transcript, append }) => {
            expect(Object.isFrozen(transcript[0])).toBe(true);
            try {
              (transcript as BaseMessage[]).push(INITIAL_MESSAGE);
            } catch {
              appendRejected = true;
            }
            try {
              (transcript[0] as { content: string }).content = 'mutated';
            } catch {
              appendRejected = true;
            }
            expect(transcript[0]!.content).toBe(INITIAL_MESSAGE.content);
            expect(() => append([INITIAL_MESSAGE as unknown as ToolMessage])).toThrow(
              'only ToolMessage',
            );
            append([sourceTool]);
            sourceTool.content = 'changed after append';
            return { kind: 'continue' };
          },
        },
      }),
    ).run();

    expect(result).toMatchObject({ kind: 'completed', summary: 'after guard' });
    expect(appendRejected).toBe(true);
    expect(fixture.calls[1]!.messages.at(-1)!.content).toBe('source');
  });

  test('records one prepared Agent mail frame in the exact child checkpoint transcript', async () => {
    const first = aiMessage({
      tool_calls: [{ id: 'mail-boundary-tool', name: 'read_file', args: {} }],
    });
    const second = aiMessage({ content: 'final after guidance' });
    const responses = [first, second];
    const preparedEstimates: number[] = [];
    const sentTranscripts: BaseMessage[][] = [];
    let modelCalls = 0;
    const coordinator: BuiltinSubagentModelLoopCoordinator = {
      executeSubagentModelStep: async (input) => {
        const ordinal = ++modelCalls;
        const prepared = await input.prepareAgentMail!({
          invocationId: `mail-model-${ordinal}`,
          existingMessages: input.messages,
          childIdentity: input.childIdentity!,
        });
        const appendedAgentMail = prepared.frames.map((frame) =>
          humanMessage({
            id: frame.messageId,
            name: 'agent_message',
            content: frame.content,
            response_metadata: { source: 'agent_message', trust: 'untrusted_agent' },
          }),
        );
        const exact = [...input.messages, ...appendedAgentMail];
        const resolved = await input.resolvePreparedStep!(exact);
        preparedEstimates.push(resolved.estimatedInputTokens);
        sentTranscripts.push(exact);
        return {
          invocationId: `mail-model-${ordinal}`,
          message: responses[ordinal - 1]!,
          cacheMetrics: null,
          appendedAgentMail,
        };
      },
    };
    const result = await createBuiltinSubagentModelLoopEngine(
      inputFor(coordinator, {
        agentMail: {
          childIdentity: { agentId: 'agent-1', taskId: 'task-1' },
          prepareAgentMail: async ({ invocationId }) => ({
            frames:
              invocationId === 'mail-model-2'
                ? [
                    {
                      kind: 'agent_message',
                      trust: 'untrusted_agent',
                      modelRole: 'user',
                      messageId: 'mail-1',
                      content: '<agent_message message_id="mail-1">guide</agent_message>',
                    },
                  ]
                : [],
            ...(invocationId === 'mail-model-2' ? { preparationId: 'batch-1' } : {}),
          }),
        },
        resource: { maxOutputTokens: ({ estimatedInputTokens }) => estimatedInputTokens + 10 },
        consumer: {
          consume: ({ append }) => {
            append([toolMessage({ content: 'tool result', tool_call_id: 'mail-boundary-tool' })]);
            return { kind: 'continue' };
          },
        },
      }),
    ).run();
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(modelCalls).toBe(2);
    expect(preparedEstimates[1]).toBeGreaterThan(preparedEstimates[0]!);
    expect(sentTranscripts[0]!.some((message) => message.name === 'agent_message')).toBe(false);
    expect(sentTranscripts[1]!.filter((message) => message.id === 'mail-1')).toHaveLength(1);
    expect(result.messages.filter((message) => message.id === 'mail-1')).toHaveLength(1);
    expect(result.messages.at(-2)).toMatchObject({ type: 'human', id: 'mail-1' });
    expect(result.messages.at(-1)).toMatchObject({ type: 'ai', content: 'final after guidance' });
    const root = mkdtempSync(join(tmpdir(), 'kite-child-mail-checkpoint-'));
    try {
      const checkpointStore = new SubagentCheckpointArtifactStore({
        root: join(root, 'subagent-checkpoints'),
      });
      const ref = checkpointStore.write({
        ownerKey: 'owner-1',
        taskId: 'task-1',
        modelInvocationOrdinal: result.modelInvocationOrdinal,
        messages: result.messages,
      });
      expect(
        checkpointStore
          .read(ref, 'owner-1', 'task-1')
          .messages.filter((message) => message.id === 'mail-1'),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
