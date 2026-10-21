import { AsyncLocalStorage } from 'node:async_hooks';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import type { ModelAdapter, ModelRequest, ModelToolCall, ModelUsage } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createUserConfiguration, parseModelPreset } from '@kite-ai/service/configuration';
import { createPhysicalObserver } from './live-physical-stream-observer';

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
export async function createLiveLoadModelFixture(options: {
  requestLimit: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Explicit independent finite-output experiment; ordinary suites retain their 4096 cap. */
  outputTokenLimit?: 8192;
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
  const physical = createPhysicalObserver();
  const requestContext = new AsyncLocalStorage<string>();
  const requests: ModelRequest[] = [];
  const calls: ModelToolCall[] = [];
  const usage: ModelUsage[] = [];
  const wire: { status: number; tools: string[] }[] = [];
  const metadata: Record<string, unknown> = {};
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
      wire.push(observation);
      const physicalAttempt = physical.begin(requestContext.getStore() ?? null);
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
        return physical.response(physicalAttempt, response);
      } catch {
        physical.transportFailed(physicalAttempt);
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
      requests.push(structuredClone(request));
      const signal = AbortSignal.any([deadline, context.signal]);
      try {
        const iterator = sdk.stream(request, { signal })[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await requestContext.run(request.requestId, () => iterator.next());
            if (next.done) break;
            const event = next.value;
            if (event.type === 'tool_call') calls.push(structuredClone(event));
            if (event.type === 'finish') usage.push(event.usage);
            yield event;
          }
        } finally {
          await requestContext.run(request.requestId, () => iterator.return?.());
        }
      } catch {
        // Fail this live attempt immediately. Do not retry or change model/protocol.
        throw Error('live_model_provider_attempt_failed');
      }
    },
  };

  return {
    physical,
    model,
    modelId: 'live',
    signal: deadline,
    requests,
    calls,
    usage,
    wire,
    metadata,
  };
}
