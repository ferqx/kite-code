/** Service-only transports. The configuration owner verifies the chosen credential's service,
 * account and authentication kind, then supplies a resolver bound to that exact reference.
 * No process environment, current model, history, workspace or ambient account fallback. */
export type SearchAdapter = 'deepseek-search' | 'perplexity-search' | 'openai-search';

type WebSource = {
  title?: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  updatedAt?: string;
};

type SearchAnswer = {
  kind: 'answer';
  query: string;
  text: string;
  citations: WebSource[];
  sources: WebSource[];
  searchPerformed: true;
  truncated: boolean;
};

type SearchResult =
  | { kind: 'results'; query: string; items: WebSource[]; truncated: boolean }
  | SearchAnswer;

type TokenUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens?: number };
export type WebSearchProviderUsage = {
  executionId: string;
  adapter: SearchAdapter;
  /** One dispatch attempt, not a claim about billable use or the number of server-side searches. */
  requests: 1;
  searchModelTokens?: TokenUsage;
};

type OpenAISearch = (input: {
  query: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
  signal: AbortSignal;
}) => Promise<SearchAnswer & { usage?: TokenUsage }>;

type SearchTransport = (url: string, init: RequestInit) => Promise<Response>;

export type WebSearchProviderOptions = {
  readonly adapter: SearchAdapter;
  readonly baseURL: string;
  readonly maxResults?: number;
  readonly modelId?: string;
  readonly resolveApiKey: () => string | undefined | Promise<string | undefined>;
  /** Trusted host injection, never exposed via a user preference or model argument. */
  readonly openaiSearch?: OpenAISearch;
  /** Optional local accounting sink. Never exposed in the result fed back to the model. */
  readonly onUsage?: (usage: WebSearchProviderUsage) => void;
  readonly fetch?: SearchTransport;
  readonly timeoutMs?: number;
};

const maxResponseBytes = 2 * 1024 * 1024;
const maxModelBytes = 16 * 1024;
const origins = {
  'deepseek-search': 'https://api.deepseek.com',
  'perplexity-search': 'https://api.perplexity.ai',
  'openai-search': 'https://api.openai.com',
} as const;

type SearchErrorCode =
  | 'search_provider_invalid'
  | 'search_credential_unavailable'
  | 'search_query_invalid'
  | 'search_query_too_long'
  | 'search_auth_failed'
  | 'search_payment_required'
  | 'search_forbidden'
  | 'search_rate_limited'
  | 'search_bad_request'
  | 'search_provider_unavailable'
  | 'search_redirect_refused'
  | 'search_invalid_response'
  | 'search_response_too_large'
  | 'search_network_error'
  | 'search_cancelled'
  | 'search_timeout'
  | 'search_not_performed'
  | 'search_failed'
  | 'search_incomplete';

export class WebSearchProviderError extends Error {
  readonly code: SearchErrorCode;
  readonly retrySafety: 'safe' | 'unknown' | 'unsafe';

  constructor(code: SearchErrorCode, retrySafety: 'safe' | 'unknown' | 'unsafe' = 'safe') {
    super(code);
    this.name = 'WebSearchProviderError';
    this.code = code;
    this.retrySafety = retrySafety;
  }
}

/** Accept only literal first-party bases (not a gateway with a similar name or normalized path).
 * Return constants, not a URL derived from untrusted path/query/fragment text. */
export function webSearchProviderBaseURL(adapter: SearchAdapter, baseURL: string): string {
  if (!Object.hasOwn(origins, adapter) || typeof baseURL !== 'string')
    throw new WebSearchProviderError('search_provider_invalid');
  const origin = origins[adapter];
  const bases: string[] = [origin, `${origin}/`];
  if (adapter !== 'perplexity-search') bases.push(`${origin}/v1`, `${origin}/v1/`);
  if (!bases.includes(baseURL)) throw new WebSearchProviderError('search_provider_invalid');
  return adapter === 'openai-search' ? `${origin}/v1` : origin;
}

export function isWebSearchApiKey(key: unknown): key is string {
  // Real keys are opaque bearer tokens. Reject known sentinels, reference expressions,
  // control characters and redact/mask placeholders before constructing any headers.
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 4096 &&
    /^[A-Za-z0-9._~+/=-]+$/.test(key) &&
    !/^(?:none|null|undefined|no[-_]?key|not[-_]?(?:required|configured)|not[-_]?needed|missing|dummy(?:[-_]key)?|placeholder|redacted|changeme|your[-_].*key|(?:deepseek|perplexity|openai)_api_key|x{3,}|\.{3,})$/i.test(
      key,
    )
  );
}

function normalizeQuery(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') throw new WebSearchProviderError('search_query_invalid');
  const query = value.trim();
  if (query.length > maxChars * 2) throw new WebSearchProviderError('search_query_too_long');
  if (!query || /[\uD800-\uDFFF]/u.test(query))
    throw new WebSearchProviderError('search_query_invalid');
  if (Array.from(query).length > maxChars)
    throw new WebSearchProviderError('search_query_too_long');
  return query;
}

function statusError(
  status: number,
  safety: 'unknown' | 'unsafe' = 'unknown',
): WebSearchProviderError {
  const codes: Partial<Record<number, SearchErrorCode>> = {
    400: 'search_bad_request',
    401: 'search_auth_failed',
    402: 'search_payment_required',
    403: 'search_forbidden',
    408: 'search_timeout',
    422: 'search_bad_request',
    429: 'search_rate_limited',
    504: 'search_timeout',
  };
  const code =
    status >= 300 && status < 400
      ? 'search_redirect_refused'
      : (codes[status] ?? 'search_provider_unavailable');
  return new WebSearchProviderError(code, safety);
}

function invalidResponse(): never {
  throw new WebSearchProviderError('search_invalid_response', 'unknown');
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status !== 200) throw statusError(response.status);
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maxResponseBytes)
    throw new WebSearchProviderError('search_response_too_large', 'unknown');
  if (!response.body) return invalidResponse();
  const reader = response.body.getReader();
  // A single bounded allocation also caps metadata if the server sends tiny chunks.
  const bytes = new Uint8Array(maxResponseBytes);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxResponseBytes)
        throw new WebSearchProviderError('search_response_too_large', 'unknown');
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    return invalidResponse();
  }
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalidResponse();
  return raw as Record<string, unknown>;
}

function link(raw: unknown): string | undefined {
  if (
    typeof raw !== 'string' ||
    !/^https?:\/\//i.test(raw) ||
    Buffer.byteLength(raw) > 2048 ||
    /[\s\\]/u.test(raw) ||
    [...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return raw;
  } catch {
    return;
  }
}

function jsonSize(value: SearchResult): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function withoutCredential(result: SearchResult, apiKey: string): SearchResult {
  // A misbehaving provider could echo the Authorization value in an otherwise valid
  // title, link or answer. Never publish that value as a result or evidence.
  if (JSON.stringify(result).includes(apiKey)) return invalidResponse();
  return result;
}

function limitedText(raw: unknown, max: number, state: { truncated: boolean }): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return;
  const value = raw.trim();
  if (value.length <= max) return value;
  state.truncated = true;
  // Avoid splitting a surrogate pair, including at chunk/byte-budget boundaries.
  const end = /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return value.slice(0, end);
}

function directResult(
  raw: unknown,
  query: string,
  deepseek: boolean,
  maxResults: number,
): SearchResult {
  const rows = record(raw).results;
  if (!Array.isArray(rows)) return invalidResponse();
  const result: Extract<SearchResult, { kind: 'results' }> = {
    kind: 'results',
    query,
    items: [],
    truncated: rows.length > maxResults,
  };
  for (const item of rows.slice(0, maxResults)) {
    const row = record(item);
    if (typeof row.url !== 'string' || typeof row.title !== 'string') return invalidResponse();
    const url = link(row.url);
    if (!url) {
      result.truncated = true;
      continue;
    }
    const title = limitedText(row.title, 512, result) ?? url;
    const summary =
      deepseek && typeof row.summary === 'string' && row.summary.trim() ? row.summary : row.snippet;
    const snippet = limitedText(summary, 2048, result);
    const publishedAt = limitedText(row.date, 64, result);
    const updatedAt = !deepseek ? limitedText(row.last_updated, 64, result) : undefined;
    const source: WebSource = {
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
    result.items.push(source);
    if (jsonSize(result) > maxModelBytes) {
      result.truncated = true;
      delete source.snippet;
      if (jsonSize(result) > maxModelBytes) result.items.pop();
    }
  }
  return result;
}

function boundedAnswer(answer: SearchAnswer, query: string): SearchAnswer {
  if (answer?.kind !== 'answer' || answer.searchPerformed !== true)
    throw new WebSearchProviderError('search_not_performed', 'unknown');
  if (
    answer.query !== query ||
    typeof answer.text !== 'string' ||
    !answer.text.trim() ||
    !Array.isArray(answer.citations) ||
    !Array.isArray(answer.sources)
  )
    return invalidResponse();
  const result: SearchAnswer = {
    kind: 'answer',
    searchPerformed: true,
    query,
    text: '',
    citations: [],
    sources: [],
    truncated: answer.truncated,
  };
  // Retain the answer even for very large outputs. Coordinates in the model's original
  // answer do not refer to the main model's reworded reply. Links alone can cross this port.
  result.text = limitedText(answer.text, 8192, result) ?? '';
  while (jsonSize(result) > maxModelBytes) {
    result.text =
      limitedText(result.text, Math.max(1, Math.floor(result.text.length * 0.75)), result) ?? '';
  }
  for (const kind of ['citations', 'sources'] as const) {
    const rows = answer[kind];
    if (rows.length > 64) result.truncated = true;
    for (const source of rows.slice(0, 64)) {
      const url = link(source?.url);
      if (!url) {
        result.truncated = true;
        continue;
      }
      const title = limitedText(source.title, 512, result);
      result[kind].push({ url, ...(title ? { title } : {}) });
      if (jsonSize(result) > maxModelBytes) {
        result[kind].pop();
        result.truncated = true;
        break;
      }
    }
  }
  return result;
}

function openAIError(error: unknown): WebSearchProviderError {
  if (!(error instanceof Error))
    return new WebSearchProviderError('search_network_error', 'unknown');
  const details = error as Error & {
    retrySafety?: unknown;
    statusCode?: unknown;
    detail?: unknown;
    reason?: unknown;
  };
  const safety = details.retrySafety === 'unsafe' ? 'unsafe' : 'unknown';
  const message = error.message;
  if (message === 'search_http_error' && typeof details.statusCode === 'number')
    return statusError(details.statusCode, safety);
  if (details.detail === 'rate_limited')
    return new WebSearchProviderError('search_rate_limited', safety);
  if (
    details.detail === 'request_timeout' ||
    details.detail === 'connection_timeout' ||
    error.name === 'TimeoutError'
  )
    return new WebSearchProviderError('search_timeout', safety);
  if (details.reason === 'provider_unavailable')
    return new WebSearchProviderError('search_provider_unavailable', safety);
  if (details.reason === 'stream_incomplete')
    return new WebSearchProviderError('search_incomplete', safety);
  switch (message) {
    case 'search_not_performed':
    case 'search_failed':
    case 'search_incomplete':
    case 'search_auth_failed':
    case 'search_forbidden':
    case 'search_rate_limited':
    case 'search_provider_unavailable':
    case 'search_payment_required':
      return new WebSearchProviderError(message, safety);
    default:
      return new WebSearchProviderError('search_network_error', safety);
  }
}

export function createWebSearchProviderPort(options: WebSearchProviderOptions) {
  const { adapter, modelId, resolveApiKey, openaiSearch, onUsage } = options;
  const baseURL = webSearchProviderBaseURL(adapter, options.baseURL);
  const openAI = adapter === 'openai-search';
  const maxResults = options.maxResults ?? 5;
  const defaultTimeout = openAI ? 60_000 : 30_000;
  const timeoutMs = options.timeoutMs ?? defaultTimeout;
  const transport = options.fetch ?? globalThis.fetch;
  if (
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 10 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > defaultTimeout ||
    (openAI && (!openaiSearch || !modelId || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(modelId)))
  )
    throw new WebSearchProviderError('search_provider_invalid');
  return {
    async search(
      input: { readonly query: string },
      context: { readonly signal: AbortSignal; readonly executionId: string },
    ): Promise<SearchResult> {
      const query = normalizeQuery(input?.query, adapter === 'deepseek-search' ? 128 : 1024);
      const callerSignal = context.signal;
      if (callerSignal.aborted) throw new WebSearchProviderError('search_cancelled');
      const controller = new AbortController();
      let dispatched = false;
      let searchModelTokens: TokenUsage | undefined;
      const retrySafety = () => (dispatched ? ('unknown' as const) : ('safe' as const));
      const cancel = () =>
        controller.abort(new WebSearchProviderError('search_cancelled', retrySafety()));
      const timer = setTimeout(
        () => controller.abort(new WebSearchProviderError('search_timeout', retrySafety())),
        timeoutMs,
      );
      callerSignal.addEventListener('abort', cancel, { once: true });
      const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
      });
      const run = async (): Promise<SearchResult> => {
        let apiKey: unknown;
        try {
          apiKey = await resolveApiKey();
        } catch {
          throw new WebSearchProviderError('search_credential_unavailable');
        }
        controller.signal.throwIfAborted();
        if (!isWebSearchApiKey(apiKey))
          throw new WebSearchProviderError('search_credential_unavailable');
        if (query.includes(apiKey)) throw new WebSearchProviderError('search_query_invalid');
        dispatched = true;
        if (openAI) {
          let answer: Awaited<ReturnType<OpenAISearch>>;
          try {
            answer = await openaiSearch!({
              query,
              modelId: modelId!,
              baseURL,
              apiKey,
              signal: controller.signal,
            });
          } catch (e) {
            throw openAIError(e);
          }
          if (answer?.usage) {
            const count = (n: unknown) =>
              typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
            const totalTokens = count(answer.usage.totalTokens);
            searchModelTokens = {
              inputTokens: count(answer.usage.inputTokens),
              outputTokens: count(answer.usage.outputTokens),
              ...(totalTokens === null ? {} : { totalTokens }),
            };
          }
          return withoutCredential(boundedAnswer(answer, query), apiKey);
        }
        const deepseek = adapter === 'deepseek-search';
        // First-party contracts: https://api-docs.deepseek.com/api/search/
        // and https://docs.perplexity.ai/api-reference/search-post. No redirect, retry or fallback.
        const response = await transport(baseURL + (deepseek ? '/v1/tools/search' : '/search'), {
          method: 'POST',
          redirect: 'manual',
          credentials: 'omit',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(
            deepseek
              ? { query, count: maxResults, need_content: false }
              : { query, max_results: maxResults },
          ),
        });
        try {
          return withoutCredential(
            directResult(await boundedJson(response), query, deepseek, maxResults),
            apiKey,
          );
        } finally {
          if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
        }
      };
      try {
        return await Promise.race([run(), stopped]);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof WebSearchProviderError) throw error;
        throw new WebSearchProviderError('search_network_error', retrySafety());
      } finally {
        clearTimeout(timer);
        callerSignal.removeEventListener('abort', cancel);
        controller.abort();
        if (dispatched) {
          try {
            onUsage?.({
              executionId: context.executionId,
              adapter,
              requests: 1,
              ...(searchModelTokens ? { searchModelTokens } : {}),
            });
          } catch {
            /* Local telemetry must never turn a paid request into a retry. */
          }
        }
      }
    },
  };
}
