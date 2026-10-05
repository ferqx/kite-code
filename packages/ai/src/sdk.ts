import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from '@ai-sdk/openai-compatible';
import {
  jsonSchema,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
} from 'ai';
import type { ModelAdapter, ModelRequest } from './index';
import {
  type ModelAdapterSnapshot,
  type ReasoningEffort,
  reasoningEfforts,
} from './request-snapshot';

export { type ReasoningEffort, reasoningEfforts } from './request-snapshot';

// Only this trusted factory knows the non-secret Provider identity. Arbitrary SDK
// LanguageModel properties are opaque and must never be interpreted as safe metadata.
const compatibleSnapshots = new WeakMap<object, { family: string; modelId: string }>();

function messages(request: ModelRequest): SdkMessage[] {
  const calls = new Map<string, string>();
  return request.messages.map((message): SdkMessage => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: message.content },
          ...(message.toolCalls ?? []).map((call) => {
            calls.set(call.id, call.name);
            return {
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.name,
              input: JSON.parse(call.arguments),
            };
          }),
        ],
      };
    }
    if (message.role === 'tool') {
      const toolName = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      if (!message.toolCallId || !toolName) throw new Error('invalid_tool_history');
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName,
            output: { type: 'text', value: message.content },
          },
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

export interface SdkModelPreset {
  readonly reasoningEffort?: ReasoningEffort;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
}
function modelPreset(value: SdkModelPreset): SdkModelPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_model_options');
  if (
    Object.keys(value).some(
      (key) => !['temperature', 'topP', 'maxOutputTokens', 'reasoningEffort'].includes(key),
    ) ||
    (value.reasoningEffort !== undefined && !reasoningEfforts.includes(value.reasoningEffort)) ||
    (value.temperature !== undefined &&
      (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) ||
    (value.topP !== undefined &&
      (!Number.isFinite(value.topP) || value.topP < 0 || value.topP > 1)) ||
    (value.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(value.maxOutputTokens) ||
        value.maxOutputTokens < 1 ||
        value.maxOutputTokens > 1000000))
  )
    throw new Error('invalid_model_options');
  return Object.freeze({ ...value });
}

/** One SDK Provider attempt. Tool execution and the next model Step belong to Agent. */
export function createSdkModelAdapter(options: {
  models: ReadonlyMap<string, LanguageModel>;
  presets?: ReadonlyMap<string, SdkModelPreset>;
}): ModelAdapter {
  const models = new Map(options.models);
  const presets = new Map(
    [...(options.presets ?? [])].map(([id, preset]) => [id, modelPreset(preset)]),
  );
  for (const [id, preset] of presets) {
    const model = models.get(id);
    if (
      preset.reasoningEffort !== undefined &&
      (typeof model !== 'object' || model === null || !compatibleSnapshots.has(model))
    )
      throw new Error('model_reasoning_effort_unsupported');
  }
  const describeRequest = (request: ModelRequest): ModelAdapterSnapshot => {
    const model = models.get(request.modelId);
    if (!model) throw new Error('model_not_bound');
    const provider =
      typeof model === 'object' && model !== null ? compatibleSnapshots.get(model) : undefined;
    return {
      adapterId: 'kite.sdk',
      adapterVersion: '1',
      provider: provider
        ? { availability: 'available', ...provider }
        : { availability: 'unavailable', reason: 'provider_binding_opaque' },
      settings: {
        ...presets.get(request.modelId),
        maxRetries: 0,
        maxSteps: 1,
        allowSystemInMessages: true,
        ...(provider ? { includeUsage: true } : {}),
      },
      transformation: { id: 'kite.sdk.messages', version: '1' },
    };
  };
  return {
    describeRequest,
    async *stream(request, { signal }) {
      signal.throwIfAborted();
      const model = models.get(request.modelId);
      if (!model) throw new Error('model_not_bound');
      const tools: ToolSet = Object.create(null);
      for (const definition of request.tools) {
        if (Object.hasOwn(tools, definition.id)) throw new Error('duplicate_model_tool');
        tools[definition.id] = tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema),
        });
      }
      let finished = false;
      const argumentsById = new Map<string, string>();
      const emittedCalls = new Set<string>();
      try {
        const { reasoningEffort, ...settings } = presets.get(request.modelId) ?? {};
        const response = streamText({
          model,
          ...settings,
          ...(reasoningEffort === undefined
            ? {}
            : {
                providerOptions: { openaiCompatible: { reasoningEffort } },
              }),
          messages: messages(request),
          allowSystemInMessages: true,
          tools,
          maxRetries: 0,
          stopWhen: stepCountIs(1),
          abortSignal: signal,
          // SDK errors are consumed below and never logged with host credentials.
          onError() {},
        });
        for await (const part of response.stream) {
          signal.throwIfAborted();
          switch (part.type) {
            case 'text-delta':
              yield { type: 'text_delta', text: part.text };
              break;
            case 'reasoning-delta':
              yield { type: 'reasoning_delta', text: part.text };
              break;
            case 'tool-input-delta':
              argumentsById.set(part.id, (argumentsById.get(part.id) ?? '') + part.delta);
              break;
            case 'tool-call': {
              if (part.invalid || part.providerExecuted || emittedCalls.has(part.toolCallId))
                throw new Error('invalid_model_tool_call');
              const argumentsText =
                argumentsById.get(part.toolCallId) ?? JSON.stringify(part.input);
              if (typeof argumentsText !== 'string') throw new Error('invalid_model_tool_call');
              JSON.parse(argumentsText);
              emittedCalls.add(part.toolCallId);
              yield {
                type: 'tool_call',
                id: part.toolCallId,
                name: part.toolName,
                arguments: argumentsText,
              };
              break;
            }
            case 'finish': {
              const reason =
                part.finishReason === 'stop'
                  ? 'stop'
                  : part.finishReason === 'tool-calls'
                    ? 'tool_calls'
                    : part.finishReason === 'length'
                      ? 'length'
                      : null;
              if (!reason || finished) throw new Error('model_finish_unavailable');
              finished = true;
              const usage = part.totalUsage;
              yield {
                type: 'finish',
                reason,
                usage: {
                  inputTokens: usage.inputTokens ?? null,
                  outputTokens: usage.outputTokens ?? null,
                  ...(usage.inputTokenDetails.cacheReadTokens !== undefined
                    ? { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens }
                    : {}),
                  ...(usage.outputTokenDetails.reasoningTokens !== undefined
                    ? { reasoningTokens: usage.outputTokenDetails.reasoningTokens }
                    : {}),
                },
              };
              break;
            }
            case 'abort':
              throw new Error('model_cancelled');
            case 'error':
              throw new Error('model_transport_failed');
            case 'start':
            case 'start-step':
            case 'finish-step':
            case 'text-start':
            case 'text-end':
            case 'reasoning-start':
            case 'reasoning-end':
            case 'tool-input-start':
            case 'tool-input-end':
              break;
            default:
              throw new Error('unsupported_model_event');
          }
        }
        if (!finished) throw new Error('model_finish_unavailable');
      } catch (error) {
        signal.throwIfAborted();
        // Provider errors may contain request bodies/URLs. Do not expose them at
        // this neutral boundary, include them as causes, or print them.
        if (
          error instanceof Error &&
          [
            'invalid_model_tool_call',
            'model_finish_unavailable',
            'model_cancelled',
            'unsupported_model_event',
            'invalid_tool_history',
          ].includes(error.message)
        )
          throw error;
        throw new Error('model_transport_failed');
      }
    },
  };
}

/** Host-only binding. Secrets are retained by the Provider closure, never ModelRequest. */
export function createCompatibleModelBinding(options: {
  baseURL: string;
  modelId: string;
  name?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: OpenAICompatibleProviderSettings['fetch'];
}): LanguageModel {
  let url: URL;
  try {
    url = new URL(options.baseURL);
  } catch {
    throw new Error('invalid_provider_endpoint');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('invalid_provider_endpoint');
  const model = createOpenAICompatible({
    baseURL: options.baseURL,
    name: options.name ?? 'compatible',
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: options.fetch,
    includeUsage: true,
    // The SDK compatible default fills missing fields in a partial usage object
    // with zero. Preserve absent Provider measurements as unknown instead.
    convertUsage(usage) {
      const input = usage?.prompt_tokens ?? undefined;
      const output = usage?.completion_tokens ?? undefined;
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? undefined;
      const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? undefined;
      return {
        inputTokens: {
          total: input,
          noCache: input !== undefined && cached !== undefined ? input - cached : undefined,
          cacheRead: cached,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: output,
          text: output !== undefined && reasoning !== undefined ? output - reasoning : undefined,
          reasoning,
        },
        raw: undefined,
      };
    },
  }).chatModel(options.modelId);
  compatibleSnapshots.set(
    model,
    Object.freeze({ family: 'openai-compatible', modelId: options.modelId }),
  );
  return model;
}

export type { LanguageModel } from 'ai';
export type { ModelAdapter, ModelEvent, ModelRequest } from './index';
