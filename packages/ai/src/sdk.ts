import { createOpenAI } from '@ai-sdk/openai';
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from '@ai-sdk/openai-compatible';
import {
  APICallError,
  jsonSchema,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
  wrapLanguageModel,
} from 'ai';
import type { Json, ModelAdapter, ModelRequest, ModelUsage } from './index';
import { ModelAttemptError } from './model-attempt';
import {
  type ModelAdapterSnapshot,
  type ReasoningEffort,
  reasoningEfforts,
} from './request-snapshot';
import { compatibleModelUsage, sdkModelUsage } from './usage';

export { type ReasoningEffort, reasoningEffortLevels, reasoningEfforts } from './request-snapshot';

// Only this trusted factory knows the non-secret Provider identity. Arbitrary SDK
// LanguageModel properties are opaque and must never be interpreted as safe metadata.
type Protocol = 'chat-completions' | 'responses';
const compatibleSnapshots = new WeakMap<
  object,
  { family: string; modelId: string; protocol: Protocol }
>();
const responseBindings = new WeakMap<object, string>();

/** Internal IDs can contain namespaces; the compatible wire only accepts short ASCII names. */
function toolNames(request: ModelRequest) {
  const ids = new Set([
    ...request.tools.map((definition) => definition.id),
    ...request.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.name)),
  ]);
  const safe = (name: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  const used = new Set([...ids].filter(safe));
  const encoded = new Map([...used].map((name) => [name, name]));
  // Reserve every literal name first, including historical tools that are no longer offered.
  for (const id of [...ids].filter((name) => !safe(name)).sort()) {
    const base = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
    let name = base;
    for (let next = 1; used.has(name); next++) {
      const suffix = `_${next}`;
      name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }
    used.add(name);
    encoded.set(id, name);
  }
  const decoded = new Map([...encoded].map(([id, name]) => [name, id]));
  return {
    encode: (id: string) => encoded.get(id) ?? id,
    decode: (name: string) => decoded.get(name) ?? name,
  };
}

function messages(
  request: ModelRequest,
  encodeTool: (name: string) => string,
  binding?: string,
): SdkMessage[] {
  const calls = new Map<string, string>();
  return request.messages.map((message): SdkMessage => {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) calls.set(call.id, encodeTool(call.name));
      const continuation = message.continuation;
      if (
        binding &&
        continuation &&
        typeof continuation === 'object' &&
        !Array.isArray(continuation) &&
        continuation.version === 1 &&
        continuation.protocol === 'responses' &&
        continuation.binding === binding &&
        continuation.modelId === request.modelId &&
        Array.isArray(continuation.content)
      ) {
        // Only trusted output artifacts carry this field. SDK revalidates content;
        // text/tool calls remain the Core's authority for execution.
        return {
          role: 'assistant',
          content: continuation.content.map((part) => {
            if (
              !part ||
              typeof part !== 'object' ||
              Array.isArray(part) ||
              part.type !== 'tool-call'
            )
              return part;
            // The opaque content records that attempt's wire names. Re-encode from
            // the Core call ID because this request can have a different collision set.
            const original = message.toolCalls?.find((call) => call.id === part.toolCallId);
            if (!original) throw new Error('invalid_tool_history');
            return { ...part, toolName: encodeTool(original.name) };
          }) as unknown as Extract<SdkMessage, { role: 'assistant' }>['content'],
        };
      }
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: message.content },
          ...(message.toolCalls ?? []).map((call) => {
            const toolName = encodeTool(call.name);
            calls.set(call.id, toolName);
            return {
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName,
              input: (() => {
                try {
                  return JSON.parse(call.arguments);
                } catch {
                  return call.arguments;
                }
              })(),
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
        ? { availability: 'available', family: provider.family, modelId: provider.modelId }
        : { availability: 'unavailable', reason: 'provider_binding_opaque' },
      settings: {
        ...presets.get(request.modelId),
        maxRetries: 0,
        maxSteps: 1,
        allowSystemInMessages: true,
        ...(provider ? { includeUsage: true, protocol: provider.protocol } : {}),
      },
      transformation: {
        id: 'kite.sdk.messages',
        version: provider?.protocol === 'responses' ? '3' : '2',
      },
    };
  };
  return {
    describeRequest,
    async *stream(request, { signal }) {
      signal.throwIfAborted();
      const model = models.get(request.modelId);
      if (!model) throw new Error('model_not_bound');
      const rawBinding =
        typeof model === 'object' && model !== null ? responseBindings.get(model) : undefined;
      const binding =
        rawBinding === undefined
          ? undefined
          : Array.from(
              new Uint8Array(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBinding)),
              ),
              (byte) => byte.toString(16).padStart(2, '0'),
            ).join('');
      const names = toolNames(request);
      const tools: ToolSet = Object.create(null);
      for (const definition of request.tools) {
        const name = names.encode(definition.id);
        if (Object.hasOwn(tools, name)) throw new Error('duplicate_model_tool');
        tools[name] = tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema),
        });
      }
      let finished = false;
      let recordedUsage: ModelUsage | undefined;
      const argumentsById = new Map<string, string>();
      const emittedCalls = new Set<string>();
      const startedCalls = new Set<string>();
      const completedCalls: import('./index').ModelToolCall[] = [];
      try {
        const { reasoningEffort, ...settings } = presets.get(request.modelId) ?? {};
        let continuation: Json | undefined;
        const response = streamText({
          model,
          ...settings,
          ...(binding
            ? {
                providerOptions: {
                  openai: {
                    store: false,
                    include: ['reasoning.encrypted_content'],
                    ...(reasoningEffort === undefined
                      ? {}
                      : { reasoningEffort, forceReasoning: true }),
                  },
                },
              }
            : reasoningEffort === undefined
              ? {}
              : { providerOptions: { openaiCompatible: { reasoningEffort } } }),
          messages: messages(request, names.encode, binding),
          onStepFinish(step) {
            if (!binding) return;
            const assistant = step.response.messages.find(
              (message) => message.role === 'assistant',
            );
            if (assistant && Array.isArray(assistant.content)) {
              continuation = JSON.parse(
                JSON.stringify({
                  version: 1,
                  protocol: 'responses',
                  binding,
                  modelId: request.modelId,
                  content: assistant.content,
                }),
              ) as Json;
            }
          },
          allowSystemInMessages: true,
          tools,
          maxRetries: 0,
          stopWhen: stepCountIs(1),
          abortSignal: signal,
          // Read only the usage leaf before Provider schemas discard extra token details.
          include: { rawChunks: compatibleSnapshots.has(model as object) },
          // SDK errors are consumed below and never logged with host credentials.
          onError() {},
        });
        for await (const part of response.stream) {
          signal.throwIfAborted();
          switch (part.type) {
            case 'raw': {
              const value = part.rawValue;
              if (
                value !== null &&
                typeof value === 'object' &&
                'usage' in value &&
                value.usage !== null &&
                typeof value.usage === 'object' &&
                !Array.isArray(value.usage)
              ) {
                recordedUsage = compatibleModelUsage(value.usage);
                yield { type: 'usage', usage: recordedUsage };
              }
              break;
            }
            case 'finish-step':
              if (!recordedUsage) {
                recordedUsage = sdkModelUsage(part.usage);
                yield { type: 'usage', usage: recordedUsage };
              }
              break;
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
              if (part.providerExecuted || emittedCalls.has(part.toolCallId))
                throw new Error('invalid_model_tool_call');
              const argumentsText =
                argumentsById.get(part.toolCallId) ?? JSON.stringify(part.input);
              if (typeof argumentsText !== 'string') throw new Error('invalid_model_tool_call');
              emittedCalls.add(part.toolCallId);
              completedCalls.push({
                id: part.toolCallId,
                name: names.decode(part.toolName),
                arguments: argumentsText,
              });
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
              if (!reason) {
                if (part.rawFinishReason !== undefined) throw new Error('model_finish_unavailable');
                throw new ModelAttemptError('stream_incomplete');
              }
              if ([...startedCalls].some((id) => !emittedCalls.has(id)))
                throw new ModelAttemptError('stream_incomplete');
              if (finished) throw new Error('model_finish_unavailable');
              finished = true;
              const usage = recordedUsage ?? sdkModelUsage(part.totalUsage);
              for (const call of completedCalls) yield { type: 'tool_call', ...call };
              yield {
                type: 'finish',
                reason,
                usage,
                ...(continuation === undefined ? {} : { continuation }),
              };
              break;
            }
            case 'abort':
              throw new Error('model_cancelled');
            case 'error':
              throw part.error;
            case 'tool-error':
              // SDK schema rejection is not a Tool execution. Preserve the original
              // completed call for Core's own rejected-call/result transaction.
              if (!emittedCalls.has(part.toolCallId)) throw new Error('invalid_model_tool_call');
              break;
            case 'tool-input-start':
              startedCalls.add(part.id);
              break;
            case 'start':
            case 'start-step':
            case 'text-start':
            case 'text-end':
            case 'reasoning-start':
            case 'reasoning-end':
            case 'tool-input-end':
              break;
            default:
              throw new Error('unsupported_model_event');
          }
        }
        if (!finished) throw new ModelAttemptError('stream_incomplete');
      } catch (error) {
        signal.throwIfAborted();
        if (ModelAttemptError.isInstance(error)) throw error;
        if (APICallError.isInstance(error) && error.isRetryable)
          throw new ModelAttemptError(
            error.statusCode === undefined ? 'connection_failed' : 'provider_unavailable',
          );
        if (error instanceof TypeError) {
          const code = (error as TypeError & { code?: unknown }).code;
          const cause = error.cause;
          const causeCode =
            cause instanceof Error ? (cause as Error & { code?: unknown }).code : null;
          if (
            [code, causeCode].some(
              (value) =>
                typeof value === 'string' &&
                ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(value),
            )
          )
            throw new ModelAttemptError('connection_failed');
        }
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
  protocol?: Protocol;
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
  const protocol = options.protocol ?? 'chat-completions';
  if (protocol !== 'chat-completions' && protocol !== 'responses')
    throw new Error('invalid_model_protocol');
  if (protocol === 'responses' && ['deepseek', 'ollama'].includes(options.name ?? ''))
    throw new Error('model_protocol_unsupported');
  const transportFetch = options.fetch ?? globalThis.fetch;
  const omitAuthorization =
    !options.apiKey &&
    !Object.keys(options.headers ?? {}).some((key) => key.toLowerCase() === 'authorization');
  const model =
    protocol === 'responses'
      ? wrapLanguageModel({
          model: createOpenAI({
            baseURL: options.baseURL,
            // Never fall back to ambient OPENAI_API_KEY for an explicit host binding.
            apiKey: options.apiKey ?? '',
            headers: { ...options.headers },
            fetch: Object.assign(
              async (...args: Parameters<typeof fetch>) => {
                const [input, init] = args;
                const headers = new Headers(init?.headers);
                if (omitAuthorization) headers.delete('authorization');
                return transportFetch(input, { ...init, headers });
              },
              { preconnect: globalThis.fetch.preconnect },
            ),
          }).responses(options.modelId),
          middleware: {
            specificationVersion: 'v4',
            async wrapStream({ doStream }) {
              const result = await doStream();
              return {
                ...result,
                stream: result.stream.pipeThrough(
                  new TransformStream({
                    transform(part, controller) {
                      // SDK warning details may serialize private reasoning/history. Keep a
                      // generic diagnostic without allowing Provider content into logs.
                      controller.enqueue(
                        part.type === 'stream-start'
                          ? {
                              ...part,
                              warnings: part.warnings.map(() => ({
                                type: 'other' as const,
                                message: 'Provider warning details omitted.',
                              })),
                            }
                          : part,
                      );
                    },
                  }),
                ),
              };
            },
          },
        })
      : createOpenAICompatible({
          baseURL: options.baseURL,
          name: options.name ?? 'compatible',
          apiKey: options.apiKey,
          headers: options.headers,
          fetch: options.fetch,
          includeUsage: true,
          // The SDK compatible default fills missing fields in a partial usage object
          // with zero. Preserve absent Provider measurements as unknown instead.
          convertUsage(usage) {
            const measured = compatibleModelUsage(usage);
            const input = measured.inputTokens ?? undefined;
            const output = measured.outputTokens ?? undefined;
            const cached = measured.cachedInputTokens;
            const reasoning = measured.reasoningTokens;
            return {
              inputTokens: {
                total: input,
                noCache: input !== undefined && cached !== undefined ? input - cached : undefined,
                cacheRead: cached,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: output,
                text:
                  output !== undefined && reasoning !== undefined ? output - reasoning : undefined,
                reasoning,
              },
              raw: measured.raw,
            };
          },
        }).chatModel(options.modelId);
  if (protocol === 'responses')
    responseBindings.set(
      model,
      JSON.stringify([
        options.baseURL.replace(/\/$/, ''),
        options.name ?? 'compatible',
        options.modelId,
        options.apiKey ?? '',
        Object.entries(options.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    );
  compatibleSnapshots.set(
    model,
    Object.freeze({
      family:
        options.name && ['openai', 'deepseek', 'ollama'].includes(options.name)
          ? options.name
          : 'openai-compatible',
      modelId: options.modelId,
      protocol,
    }),
  );
  return model;
}

export type { LanguageModel } from 'ai';
export type { ModelAdapter, ModelEvent, ModelRequest } from './index';
