import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import {
  type ModelAdapter,
  ModelAttemptError,
  type ModelRequest,
  type ModelToolCall,
  type ModelUsage,
} from '@kite-ai/ai';
import {
  createCompatibleModelBinding,
  createSdkModelAdapter,
  type ReasoningEffort,
  type SdkModelPreset,
} from '@kite-ai/ai/sdk';
import { createUserConfiguration, parseModelPreset } from '@kite-ai/service/configuration';
import { CODEX_BASE_URL, createCodexLocalSource } from '../../../../apps/service/src/codex-auth';
import { resolveModelTransport } from '../../../../apps/service/src/model-transport';

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(`live_model_${code}`);
}

export interface LiveModelAttemptFailure {
  requestId: string;
  eventCount: number;
  reason: ModelAttemptError['reason'] | 'model_failed';
}

/** Preserve only the SDK's finite neutral classification, never an arbitrary error payload. */
export function describeLiveModelAttemptFailure(
  requestId: string,
  eventCount: number,
  error: unknown,
): LiveModelAttemptFailure {
  return {
    requestId,
    eventCount,
    reason: ModelAttemptError.isInstance(error) ? error.reason : 'model_failed',
  };
}

/** Export only names present in trusted request schemas; model-created names stay opaque. */
export function summarizeLiveToolCalls(
  requests: readonly ModelRequest[],
  calls: readonly ModelToolCall[],
) {
  const schemas = new Map<string, Set<string>>();
  for (const request of requests)
    for (const tool of request.tools) {
      const properties = tool.inputSchema.properties;
      if (properties && typeof properties === 'object' && !Array.isArray(properties))
        schemas.set(tool.id, new Set(Object.keys(properties)));
      else if (!schemas.has(tool.id)) schemas.set(tool.id, new Set());
    }
  return calls.map((call) => {
    let fields: string[] = [];
    try {
      const input = JSON.parse(call.arguments);
      if (input && typeof input === 'object' && !Array.isArray(input)) fields = Object.keys(input);
    } catch {}
    const trusted = schemas.get(call.name);
    return {
      name: trusted ? call.name : 'unknown',
      fields: fields.filter((name) => trusted?.has(name)),
      unknownFieldCount: fields.filter((name) => !trusted?.has(name)).length,
      schemaMatched: trusted !== undefined,
    };
  });
}

/** Resolve the configured model in memory; never expose endpoint, keys, or payloads in metadata. */
export async function createLiveModelFixture(options: {
  /** Isolated live child processes may retain the original user document by absolute path. */
  userConfigurationPath?: string;
  /** Omit to leave total logical and physical request counts unbounded. */
  requestLimit?: number;
  /** Omit to leave the whole fixture without an execution deadline. */
  timeoutMs?: number;
  /** Per-HTTP deadline; defaults to 60 seconds. null keeps only inherited cancellation. */
  requestTimeoutMs?: number | null;
  /** Explicit existing local ChatGPT model; absent retains the configured default provider. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Isolated same-connection preset comparison; never writes user configuration. */
  presetOverride?: SdkModelPreset;
  signal?: AbortSignal;
  /** Explicit independent finite-output experiment; ordinary suites retain their 4096 cap. */
  outputTokenLimit?: 8192;
  /** Isolated transparent transport fault control; absent in ordinary suites. */
  transportResponse?(response: Response, physicalIndex: number): Promise<Response>;
  /** Preserve SDK's own neutral retry classification for Runtime fault controls. */
  preserveSdkAttemptErrors?: true;
  /** Private synthetic A/B evidence only. Bodies exclude transport URL and headers. */
  captureWireRequests?: true;
  /** Isolated paired-run guards, before any dispatch. No request mutation. */
  beforeModelRequest?(request: ModelRequest, binding: Readonly<Record<string, unknown>>): void;
  beforeWireRequest?(entry: {
    physicalIndex: number;
    requestId: string | null;
    body: string;
  }): void;
  /** Isolated crash artifact only: synchronous durable observation, never response edits. */
  observe?(state: {
    event: string;
    requests: readonly ModelRequest[];
    wire: readonly { status: number; tools: string[] }[];
    usage: readonly ModelUsage[];
    metadata: Readonly<Record<string, unknown>>;
  }): void;
}) {
  check(
    options.requestLimit === undefined ||
      (Number.isSafeInteger(options.requestLimit) && options.requestLimit > 0),
    'limit_invalid',
  );
  check(
    options.timeoutMs === undefined ||
      (Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0),
    'timeout_invalid',
  );
  const requestTimeoutMs =
    options.requestTimeoutMs === undefined ? 60_000 : options.requestTimeoutMs;
  check(
    requestTimeoutMs === null || (Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0),
    'request_timeout_invalid',
  );
  check(
    options.outputTokenLimit === undefined || options.outputTokenLimit === 8192,
    'output_token_limit_invalid',
  );
  const deadline = AbortSignal.any([
    ...(options.timeoutMs === undefined ? [] : [AbortSignal.timeout(options.timeoutMs)]),
    ...(options.signal ? [options.signal] : []),
  ]);
  const requests: ModelRequest[] = [];
  const calls: ModelToolCall[] = [];
  const usage: ModelUsage[] = [];
  const wire: { status: number; tools: string[] }[] = [];
  const wireRequests: {
    physicalIndex: number;
    requestId: string | null;
    body: string;
    bytes: number;
  }[] = [];
  const attemptFailures: LiveModelAttemptFailure[] = [];
  const requestContext = new AsyncLocalStorage<string>();
  const metadata: Record<string, unknown> = {};
  const observe = (event: string) => options.observe?.({ event, requests, wire, usage, metadata });
  const configuration = createUserConfiguration(options.userConfigurationPath);
  const value = configuration.read().value;
  const localSource = options.model ? createCodexLocalSource() : undefined;
  const discovery = localSource?.discover();
  check(
    !options.model || discovery?.models.some((entry) => entry.name === options.model),
    'selected_model_unavailable',
  );
  const selected: Json | undefined = options.model
    ? {
        id: 'live',
        provider: 'codex',
        model: options.model,
        baseURL: CODEX_BASE_URL,
        protocol: 'responses',
        enabled: true,
        options: options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {},
      }
    : (Array.isArray(value.models) ? value.models : []).find(
        (model) =>
          model && typeof model === 'object' && !Array.isArray(model) && model.id === value.modelId,
      );
  check(selected && typeof selected === 'object' && !Array.isArray(selected), 'default_missing');
  check(selected.enabled !== false, 'default_disabled');
  check(
    typeof selected.model === 'string' && typeof selected.baseURL === 'string',
    'model_invalid',
  );
  check(
    ['openai', 'deepseek', 'compatible', 'ollama', ...(localSource ? ['codex'] : [])].includes(
      String(selected.provider),
    ),
    'provider_invalid',
  );
  const protocol = selected.protocol ?? 'chat-completions';
  check(protocol === 'chat-completions' || protocol === 'responses', 'protocol_invalid');
  const configuredPreset = options.presetOverride
    ? parseModelPreset(options.presetOverride as Json)
    : parseModelPreset(selected.options);
  check(!localSource || options.outputTokenLimit === undefined, 'local_output_limit_unsupported');
  const preset = localSource
    ? configuredPreset
    : {
        ...configuredPreset,
        maxOutputTokens:
          options.outputTokenLimit ?? Math.min(configuredPreset.maxOutputTokens ?? 4096, 4096),
      };
  metadata.model = selected.model;
  metadata.provider = localSource ? 'chatgpt-local-session' : selected.provider;
  metadata.protocol = protocol;
  metadata.settings = preset;
  // Detect endpoint/model binding drift without disclosing endpoint or credentials.
  metadata.bindingFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        provider: selected.provider,
        baseURL: selected.baseURL,
        model: selected.model,
        protocol,
        preset,
      }),
    )
    .digest('hex');
  const vault = createCredentialVault({
    backend: createOsCredentialBackend({ service: 'kite-agent', accountNamespace: 'user-models' }),
  });
  check(
    selected.credentialRef === undefined || typeof selected.credentialRef === 'string',
    'credential_invalid',
  );
  const localCredentials = localSource
    ? await localSource.binding(discovery!.alias, (await resolveModelTransport()).fetch)
    : undefined;
  const apiKey =
    localCredentials?.apiKey ??
    (typeof selected.credentialRef === 'string'
      ? (configuration.resolveCredential(selected.credentialRef) ??
        (await vault.resolve(selected.credentialRef)))
      : undefined);
  const fetchProvider: typeof fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    check(
      options.requestLimit === undefined || wire.length < options.requestLimit,
      'request_budget_exhausted',
    );
    deadline.throwIfAborted();
    const body = JSON.parse(String(init?.body)) as {
      tools?: { type: string; name?: string; function?: { name: string } }[];
    };
    const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '');
    if (options.model) {
      const actual = body as Record<string, unknown>;
      check(actual.model === options.model, 'selected_wire_model_changed');
      check(
        actual.reasoning &&
          typeof actual.reasoning === 'object' &&
          (actual.reasoning as Record<string, unknown>).effort === options.reasoningEffort,
        'selected_wire_reasoning_changed',
      );
    }
    check(
      tools.every((name) => /^[a-z][a-z0-9_]{0,63}$/.test(name)),
      'wire_name_invalid',
    );
    const observation = { status: 0, tools };
    const physicalIndex = wire.length;
    options.beforeWireRequest?.({
      physicalIndex,
      requestId: requestContext.getStore() ?? null,
      body: String(init?.body),
    });
    if (options.captureWireRequests)
      wireRequests.push({
        physicalIndex,
        requestId: requestContext.getStore() ?? null,
        body: String(init?.body),
        bytes: Buffer.byteLength(String(init?.body)),
      });
    wire.push(observation);
    observe('http_dispatch_intent');
    try {
      const response = await (localCredentials?.fetch ?? fetch)(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          deadline,
          ...(requestTimeoutMs === null ? [] : [AbortSignal.timeout(requestTimeoutMs)]),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      observation.status = response.status;
      observe('http_headers');
      return options.transportResponse
        ? await options.transportResponse(response, physicalIndex)
        : response;
    } catch (error) {
      observe('http_transport_failed');
      if (options.preserveSdkAttemptErrors) throw error;
      throw Error('live_model_transport_failed');
    }
  };
  const sdk = createSdkModelAdapter({
    models: new Map([
      [
        'live',
        createCompatibleModelBinding({
          name: String(selected.provider),
          baseURL: selected.baseURL,
          modelId: selected.model,
          protocol,
          apiKey,
          ...(localCredentials
            ? {
                headers: localCredentials.headers,
                continuationIdentity: localCredentials.continuationIdentity,
              }
            : {}),
          fetch: fetchProvider,
        }),
      ],
    ]),
    presets: new Map([['live', preset]]),
  });
  const model: ModelAdapter = {
    describeRequest: sdk.describeRequest?.bind(sdk),
    async *stream(request, context) {
      deadline.throwIfAborted();
      check(
        options.requestLimit === undefined || requests.length < options.requestLimit,
        'request_budget_exhausted',
      );
      options.beforeModelRequest?.(request, metadata);
      requests.push(structuredClone(request));
      observe('model_started');
      const signal = AbortSignal.any([deadline, context.signal]);
      let eventCount = 0;
      try {
        const iterator = sdk.stream(request, { signal })[Symbol.asyncIterator]();
        try {
          for (;;) {
            const step = await requestContext.run(request.requestId, () => iterator.next());
            if (step.done) break;
            const event = step.value;
            eventCount++;
            if (event.type === 'tool_call') calls.push(structuredClone(event));
            if (event.type === 'finish') {
              usage.push(event.usage);
              observe('model_finish_usage');
            }
            yield event;
          }
        } finally {
          await iterator.return?.();
        }
      } catch (error) {
        attemptFailures.push(describeLiveModelAttemptFailure(request.requestId, eventCount, error));
        observe('model_attempt_failed');
        if (options.preserveSdkAttemptErrors) throw error;
        // Fail this live attempt immediately. Do not retry or change model/protocol.
        throw Error('live_model_provider_attempt_failed');
      }
    },
  };

  return {
    model,
    modelId: 'live',
    signal: deadline,
    requests,
    calls,
    usage,
    wire,
    wireRequests,
    attemptFailures,
    metadata,
  };
}
