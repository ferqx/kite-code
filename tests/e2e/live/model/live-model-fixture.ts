import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import type { ModelAdapter, ModelRequest, ModelToolCall, ModelUsage } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createUserConfiguration, parseModelPreset } from '@kite-ai/service/configuration';

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(`live_model_${code}`);
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
  requestLimit: number;
  timeoutMs: number;
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
  check(Number.isSafeInteger(options.requestLimit) && options.requestLimit > 0, 'limit_invalid');
  check(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0, 'timeout_invalid');
  check(
    options.outputTokenLimit === undefined || options.outputTokenLimit === 8192,
    'output_token_limit_invalid',
  );
  const deadline = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs),
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
  const requestContext = new AsyncLocalStorage<string>();
  const metadata: Record<string, unknown> = {};
  const observe = (event: string) => options.observe?.({ event, requests, wire, usage, metadata });
  const configuration = createUserConfiguration();
  const value = configuration.read().value;
  const selected = (Array.isArray(value.models) ? value.models : []).find(
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
    ['openai', 'deepseek', 'compatible', 'ollama'].includes(String(selected.provider)),
    'provider_invalid',
  );
  const protocol = selected.protocol ?? 'chat-completions';
  check(protocol === 'chat-completions' || protocol === 'responses', 'protocol_invalid');
  const configuredPreset = parseModelPreset(selected.options);
  const preset = {
    ...configuredPreset,
    maxOutputTokens:
      options.outputTokenLimit ?? Math.min(configuredPreset.maxOutputTokens ?? 4096, 4096),
  };
  metadata.model = selected.model;
  metadata.provider = selected.provider;
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
  const apiKey =
    typeof selected.credentialRef === 'string'
      ? (configuration.resolveCredential(selected.credentialRef) ??
        (await vault.resolve(selected.credentialRef)))
      : undefined;
  const fetchProvider: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      check(wire.length < options.requestLimit, 'request_budget_exhausted');
      deadline.throwIfAborted();
      const body = JSON.parse(String(init?.body)) as {
        tools?: { type: string; name?: string; function?: { name: string } }[];
      };
      const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '');
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
        const response = await fetch(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([
            deadline,
            AbortSignal.timeout(60_000),
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
    },
    { preconnect: fetch.preconnect },
  );
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
      check(requests.length < options.requestLimit, 'request_budget_exhausted');
      options.beforeModelRequest?.(request, metadata);
      requests.push(structuredClone(request));
      observe('model_started');
      const signal = AbortSignal.any([deadline, context.signal]);
      try {
        const iterator = sdk.stream(request, { signal })[Symbol.asyncIterator]();
        try {
          for (;;) {
            const step = await requestContext.run(request.requestId, () => iterator.next());
            if (step.done) break;
            const event = step.value;
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
    metadata,
  };
}
