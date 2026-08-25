import { createHash } from 'node:crypto';
import {
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  type CanonicalModelMessage,
  type CanonicalProviderOptions,
  type CanonicalToolDeclaration,
  MODEL_PURPOSE_TO_PROVIDER_DISPATCH_,
  MODEL_SURFACE_SCHEMA_,
  type ModelInvocationPurpose,
  type ModelProviderDispatchPurpose,
  type ModelSurface,
  type ResolvedModelCapabilitiesValue,
  type Sha256Digest,
} from '@kite/runtime-spi';
import type { ToolSet } from 'ai';
import type { ModelRuntimeConfig } from './config';
import {
  computeProviderEndpointIdentityDigest,
  providerRouteIdentityFromModelConfig,
} from './config';
import type { ModelProviderOptions, SupportedChatModel } from './factory';
import {
  type AIMessage,
  type BaseMessage,
  isAIMessage,
  isHumanMessage,
  isSystemMessage,
  isToolMessage,
  type ToolMessage,
} from './messages';
import type { ResolvedModelCapabilities } from './model-capabilities';
import { resolveModelCapabilities } from './model-capabilities';
import {
  canonicalModelJson,
  computeCanonicalProviderOptionsDigest,
  computeModelSurfaceDigest,
  computeResolvedModelCapabilitiesDigest,
} from './surface-canonicalizer';
import { countTokens } from './token-counter';

const ADAPTER_PROTOCOL_VERSION = 'ai-sdk-language-model-v4';

export class ModelSurfaceCompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSurfaceCompilationError';
  }
}

export interface CompiledModelSurface {
  /** Deep-frozen, canonical clone. This is the only request object admitted and dispatched. */
  surface: ModelSurface;
  surfaceDigest: Sha256Digest;
  providerDispatchPurpose: ModelProviderDispatchPurpose;
  estimatedInputTokens: number;
}

export function compileModelSurface(input: {
  purpose: ModelInvocationPurpose;
  config: ModelRuntimeConfig;
  model: SupportedChatModel;
  messages: readonly BaseMessage[];
  tools: ToolSet;
  maxOutputTokens?: number;
  providerOptions?: ModelProviderOptions;
  transport?: 'stream' | 'generate';
  /** Existing projection estimator result, bound to this frozen compilation. */
  estimatedInputTokens?: number;
}): CompiledModelSurface {
  const canonicalMessages = input.messages.map((message, index) => compileMessage(message, index));
  const system = canonicalMessages
    .filter((entry): entry is { system: string } => 'system' in entry)
    .map((entry) => entry.system)
    .filter(Boolean)
    .join('\n\n');
  const messages = canonicalMessages.flatMap((entry) =>
    'message' in entry ? [entry.message] : [],
  );
  const tools = compileTools(input.tools);
  const resolved = resolveModelCapabilities({
    config: input.config,
    adapter: {
      ...input.model.capabilityMetadata,
      supportsToolCalls: input.model.supportsToolCalls,
    },
  });
  const capabilities = canonicalCapabilities(resolved);
  const providerOptions = canonicalProviderOptions(input.providerOptions);
  const routeIdentity = providerRouteIdentityFromModelConfig(input.config);
  const routeFingerprint = computeProviderEndpointIdentityDigest(routeIdentity) as Sha256Digest;
  const replayOwnerFingerprint = privateDigest('kite.model-adapter-replay-owner.v1', {
    adapterKind: input.config.providerType,
    adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
    modelName: input.config.modelName,
    routeFingerprint,
  });
  const maxOutputTokens = positiveIntegerOrNull(input.maxOutputTokens ?? resolved.maxOutputTokens);
  const surface: ModelSurface = {
    schema: MODEL_SURFACE_SCHEMA_,
    purpose: input.purpose,
    route: {
      providerKind: input.config.providerType,
      modelName: input.config.modelName,
      adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
      routeFingerprint,
      replayOwner: {
        adapterKind: input.config.providerType,
        adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
        ownerFingerprint: replayOwnerFingerprint,
      },
    },
    request: {
      system,
      messages,
      tools,
      temperature: 0,
      maxOutputTokens,
      stopPolicy: { kind: 'single_step', maxSteps: 1 },
      transport: input.transport ?? (resolved.streaming ? 'stream' : 'generate'),
      sdkRetry: { maxRetries: 0 },
      resolvedCapabilities: {
        value: capabilities,
        digest: computeResolvedModelCapabilitiesDigest(capabilities),
      },
      providerOptions,
    },
  };
  const canonicalClone = JSON.parse(canonicalModelJson(surface)) as ModelSurface;
  const frozen = deepFreeze(canonicalClone);
  const surfaceDigest = computeModelSurfaceDigest(frozen);
  const estimatedInputTokens =
    input.estimatedInputTokens != null
      ? requirePositiveInteger(input.estimatedInputTokens, 'estimatedInputTokens')
      : Math.max(
          1,
          countTokens(
            canonicalModelJson({
              system: frozen.request.system,
              messages: frozen.request.messages,
              tools: frozen.request.tools,
            }),
          ),
        );
  return Object.freeze({
    surface: frozen,
    surfaceDigest,
    providerDispatchPurpose: MODEL_PURPOSE_TO_PROVIDER_DISPATCH_[input.purpose],
    estimatedInputTokens,
  });
}

type CompiledMessage = { system: string } | { message: CanonicalModelMessage };

function compileMessage(message: BaseMessage, index: number): CompiledMessage {
  const path = `messages[${index}]`;
  if (isSystemMessage(message)) return { system: compileTextContent(message.content, path) };
  if (isHumanMessage(message)) {
    const text = compileTextContent(message.content, path);
    return {
      message: { role: 'user', content: [{ type: 'text', text: text || ' ' }] },
    };
  }
  if (isAIMessage(message)) return { message: compileAssistantMessage(message, path) };
  if (isToolMessage(message)) return { message: compileToolMessage(message, path) };
  throw new ModelSurfaceCompilationError(`${path} has an unsupported role.`);
}

function compileTextContent(content: BaseMessage['content'], path: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new ModelSurfaceCompilationError(`${path} content is not losslessly JSON-safe.`);
  }
  return content
    .map((part, index) => {
      assertExactPlainObject(part, ['type', 'text'], `${path}.content[${index}]`);
      if (part.type !== 'text' || typeof part.text !== 'string') {
        throw new ModelSurfaceCompilationError(`${path} contains a provider-native message part.`);
      }
      return part.text;
    })
    .join('');
}

function compileAssistantMessage(message: AIMessage, path: string): CanonicalModelMessage {
  const content: Extract<CanonicalModelMessage, { role: 'assistant' }>['content'][number][] = [];
  if (typeof message.content === 'string') {
    if (message.content) content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const [index, part] of message.content.entries()) {
      const partPath = `${path}.content[${index}]`;
      if (part.type === 'text' || part.type === 'reasoning') {
        assertExactPlainObject(part, ['type', 'text'], partPath);
        if (typeof part.text !== 'string') {
          throw new ModelSurfaceCompilationError(`${partPath}.text must be a string.`);
        }
        content.push({ type: part.type, text: part.text });
      } else if (part.type === 'tool-call') {
        assertExactPlainObject(part, ['type', 'toolCallId', 'toolName', 'input'], partPath);
        content.push({
          type: 'tool_call',
          toolCallId: requireString(part.toolCallId, `${partPath}.toolCallId`),
          toolName: requireString(part.toolName, `${partPath}.toolName`),
          input: canonicalJsonValue(part.input, `${partPath}.input`),
        });
      } else {
        throw new ModelSurfaceCompilationError(`${partPath} is provider-native or unsupported.`);
      }
    }
  } else {
    throw new ModelSurfaceCompilationError(`${path} content is not losslessly JSON-safe.`);
  }

  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    const callPath = `${path}.tool_calls[${index}]`;
    assertExactPlainObject(call, ['id', 'name', 'args', 'type'], callPath, true);
    const toolCallId = requireString(call.id ?? '', `${callPath}.id`);
    if (content.some((part) => part.type === 'tool_call' && part.toolCallId === toolCallId)) {
      throw new ModelSurfaceCompilationError(`${callPath} duplicates a content tool call.`);
    }
    content.push({
      type: 'tool_call',
      toolCallId,
      toolName: requireString(call.name, `${callPath}.name`),
      input: canonicalJsonValue(call.args, `${callPath}.args`),
    });
  }

  const additionalKeys = Object.keys(message.additional_kwargs ?? {});
  if (additionalKeys.some((key) => key !== 'reasoning_content')) {
    throw new ModelSurfaceCompilationError(
      `${path} contains unsupported provider-native metadata.`,
    );
  }
  const reasoning = message.additional_kwargs?.reasoning_content;
  if (reasoning != null) {
    if (typeof reasoning !== 'string') {
      throw new ModelSurfaceCompilationError(`${path}.reasoning_content must be a string.`);
    }
    if (
      reasoning &&
      !content.some((part) => part.type === 'reasoning' && part.text === reasoning)
    ) {
      content.push({ type: 'reasoning', text: reasoning });
    }
  }
  return { role: 'assistant', content };
}

function compileToolMessage(message: ToolMessage, path: string): CanonicalModelMessage {
  const output =
    typeof message.content === 'string'
      ? message.content
      : canonicalModelJson(canonicalJsonValue(message.content, `${path}.content`));
  return {
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolCallId: requireString(message.tool_call_id, `${path}.tool_call_id`),
        toolName: typeof message.name === 'string' ? message.name : '',
        output: { type: 'text', value: output },
      },
    ],
  };
}

function compileTools(tools: ToolSet): CanonicalToolDeclaration[] {
  return Object.entries(tools).map(([name, definition], index) => {
    const path = `tools[${index}]`;
    if (!definition || typeof definition !== 'object') {
      throw new ModelSurfaceCompilationError(`${path} is not a tool declaration.`);
    }
    const record = definition as unknown as Record<string, unknown>;
    const carrier = record.inputSchema ?? record.parameters ?? record.schema;
    if (!carrier || typeof carrier !== 'object') {
      throw new ModelSurfaceCompilationError(`${path} has no provider-facing JSON Schema.`);
    }
    const schema =
      'jsonSchema' in carrier ? (carrier as { jsonSchema: unknown }).jsonSchema : carrier;
    const inputSchema = canonicalProviderToolSchema(schema, `${path}.inputSchema`);
    return {
      name,
      description: typeof record.description === 'string' ? record.description : null,
      inputSchema,
    };
  });
}

function canonicalProviderToolSchema(value: unknown, path: string): CanonicalJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelSurfaceCompilationError(`${path} must be a JSON object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const hidden = Object.entries(descriptors).filter(([, descriptor]) => !descriptor.enumerable);
  if (hidden.some(([key]) => key !== '~standard')) {
    throw new ModelSurfaceCompilationError(`${path} contains unsupported hidden metadata.`);
  }
  const providerFacing = Object.fromEntries(
    Object.entries(descriptors).flatMap(([key, descriptor]) => {
      if (!descriptor.enumerable) return [];
      if (!('value' in descriptor)) {
        throw new ModelSurfaceCompilationError(`${path}.${key} must not be an accessor.`);
      }
      return [[key, descriptor.value]];
    }),
  );
  return canonicalJsonObject(providerFacing, path);
}

function canonicalProviderOptions(
  options: ModelProviderOptions | undefined,
): CanonicalProviderOptions {
  const value = canonicalJsonObject(options ?? {}, 'providerOptions');
  return {
    kind: 'inline',
    value,
    digest: computeCanonicalProviderOptionsDigest(value),
  };
}

function canonicalCapabilities(value: ResolvedModelCapabilities): ResolvedModelCapabilitiesValue {
  return {
    providerName: value.providerName,
    modelName: value.modelName,
    contextWindowTokens: value.contextWindowTokens ?? null,
    contextWindowSource: value.contextWindowSource ?? null,
    maxOutputTokens: value.maxOutputTokens ?? null,
    maxOutputTokensSource: value.maxOutputTokensSource ?? null,
    tokenizerFamily: value.tokenizerFamily ?? null,
    tokenizerSource: value.tokenizerSource ?? null,
    supportsUsageMetadata: value.supportsUsageMetadata ?? null,
    supportsUsageMetadataSource: value.supportsUsageMetadataSource ?? null,
    supportsPromptCache: value.supportsPromptCache ?? null,
    supportsPromptCacheSource: value.supportsPromptCacheSource ?? null,
    supportsToolCalls: value.supportsToolCalls ?? null,
    supportsToolCallsSource: value.supportsToolCallsSource ?? null,
    streaming: value.streaming,
    streamingSource: value.streamingSource ?? null,
  };
}

function canonicalJsonObject(value: unknown, path: string): CanonicalJsonObject {
  const canonical = canonicalJsonValue(value, path);
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new ModelSurfaceCompilationError(`${path} must be a JSON object.`);
  }
  return canonical as CanonicalJsonObject;
}

function canonicalJsonValue(value: unknown, path: string): CanonicalJsonValue {
  let text: string;
  try {
    text = canonicalModelJson(value);
  } catch (error) {
    throw new ModelSurfaceCompilationError(
      `${path} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return JSON.parse(text) as CanonicalJsonValue;
}

function assertExactPlainObject(
  value: unknown,
  expected: readonly string[],
  path: string,
  optionalExpected = false,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ModelSurfaceCompilationError(`${path} must be a plain object.`);
  }
  const keys = Object.keys(value);
  if (
    keys.some((key) => !expected.includes(key)) ||
    (!optionalExpected && expected.some((key) => !keys.includes(key)))
  ) {
    throw new ModelSurfaceCompilationError(`${path} contains unsupported fields.`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string')
    throw new ModelSurfaceCompilationError(`${path} must be a string.`);
  return value;
}

function requirePositiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ModelSurfaceCompilationError(`${path} must be a positive safe integer.`);
  }
  return value;
}

function positiveIntegerOrNull(value: number | undefined): number | null {
  return value == null ? null : requirePositiveInteger(Math.floor(value), 'maxOutputTokens');
}

function privateDigest(domain: string, value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256')
    .update('kite-code-private-model-evidence-v1\0')
    .update(domain)
    .update('\0')
    .update(canonicalModelJson(value))
    .digest('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
