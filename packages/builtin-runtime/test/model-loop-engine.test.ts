import { describe, expect, test } from 'bun:test';
import {
  type BuiltinSubagentModelLoopCoordinator,
  createBuiltinSubagentModelLoopEngine,
} from '@kite/builtin-runtime';
import type { AIMessage, BaseMessage, ToolMessage } from '@kite/builtin-runtime/model';
import {
  aiMessage,
  type BuiltinModelEvent,
  type BuiltinSubagentModelStepInput,
  type BuiltinSubagentModelStepResult,
  createChatModel,
  humanMessage,
  type ModelInvocationStateView,
  type ModelRuntimeConfig,
  toolMessage,
} from '@kite/builtin-runtime/model';
import type { ToolSet } from 'ai';

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
    readonly estimatedInputTokens: number;
    readonly maxOutputTokens?: number;
  }>;
} {
  let responseIndex = 0;
  const calls: Array<{
    readonly messages: readonly BaseMessage[];
    readonly estimatedInputTokens: number;
    readonly maxOutputTokens?: number;
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
        estimatedInputTokens: input.estimatedInputTokens,
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
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
});
