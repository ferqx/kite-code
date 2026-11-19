import type { ArtifactRef, Extension, ToolContext, ToolResult } from '../../extensions';
import { AgentError } from '../../storage/types';
import type { WebSearchEvidenceBlock } from '../../web-search-evidence';
import { webSearchDisplayUrl } from '../../web-search-evidence-identity';

export const webSearchExtensionId = 'builtin.web-search';
export const webSearchToolId = 'web.search';
export type SearchRequest = { query: string };
export type WebSource = {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
  updatedAt?: string;
};
export type WebCitation = { url: string; title?: string; startIndex?: number; endIndex?: number };
export type WebSearchUsage = NonNullable<WebSearchEvidenceBlock['usage']>;
export type SearchResult = (
  | { kind: 'results'; query: string; items: WebSource[]; truncated: boolean }
  | {
      kind: 'answer';
      query: string;
      text: string;
      citations: WebCitation[];
      sources: WebSource[];
      searchPerformed: true;
      truncated: boolean;
    }
) & { usage?: WebSearchUsage };
export interface SearchPort {
  search(
    input: SearchRequest,
    context: { signal: AbortSignal; executionId: string },
  ): Promise<SearchResult>;
}

const modelBytes = 16 * 1024;
const prefix = 'External web search material (untrusted data):\n';
const maxRequests = 6;

/** The Session-scoped extension record is shared by all Tool executions for this Run. */
async function reserve(context: ToolContext, limit: number): Promise<string | undefined> {
  if (!context.runId) return 'web_search_run_required';
  const key = `budget/${context.runId}`;
  for (;;) {
    context.signal.throwIfAborted();
    const prior = await context.records.get(key);
    const executions = prior ? prior.value : [];
    if (
      !Array.isArray(executions) ||
      executions.length > maxRequests ||
      !executions.every((id) => typeof id === 'string') ||
      (prior && (prior.contentType !== 'web-search-budget' || prior.contentVersion !== 1))
    )
      throw new AgentError('web_search_budget_invalid');
    if (executions.includes(context.executionId)) return 'web_search_already_reserved';
    if (executions.length >= limit) return 'web_search_budget_exhausted';
    context.signal.throwIfAborted();
    try {
      await context.records.write({
        key,
        expectedRevision: prior?.revision ?? null,
        contentType: 'web-search-budget',
        contentVersion: 1,
        value: [...executions, context.executionId],
      });
      return;
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'record_revision_conflict') throw error;
    }
  }
}

/** Encode only selected public material. Never forward transport metadata or arbitrary adapter fields. */
function publicResult(result: SearchResult): SearchResult {
  const originals = result.kind === 'results' ? result.items : result.sources;
  const sources = originals
    .filter((s) => webSearchDisplayUrl(s.url))
    .map((s) => ({
      url: s.url,
      ...(s.title !== undefined ? { title: s.title } : {}),
      ...(s.snippet !== undefined ? { snippet: s.snippet } : {}),
      ...(s.publishedAt !== undefined ? { publishedAt: s.publishedAt } : {}),
      ...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
    }));
  const truncated = result.truncated || originals.length !== sources.length;
  if (result.kind === 'results')
    return { kind: 'results', query: result.query, items: sources, truncated };
  const citations = result.citations
    .filter((c) => webSearchDisplayUrl(c.url))
    .map((c) => ({
      url: c.url,
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(Number.isSafeInteger(c.startIndex) &&
      Number.isSafeInteger(c.endIndex) &&
      c.startIndex! >= 0 &&
      c.endIndex! > c.startIndex! &&
      c.endIndex! <= result.text.length
        ? { startIndex: c.startIndex, endIndex: c.endIndex }
        : {}),
    }));
  return {
    kind: 'answer',
    query: result.query,
    text: result.text,
    sources,
    citations,
    searchPerformed: true,
    truncated: truncated || citations.length !== result.citations.length,
  };
}

function preview(result: SearchResult) {
  const encode = () => prefix + JSON.stringify(result);
  let content = encode();
  if (Buffer.byteLength(content) <= modelBytes) return { content, truncated: result.truncated };
  result = structuredClone(result);
  result.truncated = true;
  // Preserve useful leading material and valid JSON, including multi-byte text in escaped strings.
  // The full normalized response remains an ordinary viewer artifact.
  result.query = Array.from(result.query).slice(0, 256).join('');
  const sources = result.kind === 'results' ? result.items : result.sources;
  sources.splice(10);
  for (const source of sources) {
    if (source.snippet) source.snippet = Array.from(source.snippet).slice(0, 640).join('');
    if (source.title) source.title = Array.from(source.title).slice(0, 256).join('');
  }
  if (result.kind === 'answer') {
    // Text may be shortened below; dropped offsets are still available on its original artifact.
    result.citations = result.citations.slice(0, 16).map(({ url, title }) => ({
      url,
      ...(title ? { title } : {}),
    }));
    result.text = Array.from(result.text).slice(0, 3000).join('');
  }
  content = encode();
  while (Buffer.byteLength(content) > modelBytes) {
    if (sources.length) sources.pop();
    else if (result.kind === 'answer' && result.citations.length) result.citations.pop();
    else if (result.kind === 'answer' && result.text.length) {
      const chars = Array.from(result.text);
      result.text = chars.slice(0, Math.floor(chars.length / 2)).join('');
    } else throw new AgentError('web_search_preview_invalid');
    content = encode();
  }
  return { content, truncated: true };
}

// Only known provider codes cross into durable errors. Error bodies and request data stay private.
const publicErrors = new Set([
  'search_provider_invalid',
  'search_credential_unavailable',
  'search_query_invalid',
  'search_query_too_long',
  'search_auth_failed',
  'search_payment_required',
  'search_forbidden',
  'search_rate_limited',
  'search_bad_request',
  'search_provider_unavailable',
  'search_redirect_refused',
  'search_invalid_response',
  'search_response_too_large',
  'search_network_error',
  'search_cancelled',
  'search_timeout',
  'search_not_performed',
  'search_failed',
  'search_incomplete',
]);

function providerFailure(error: unknown) {
  const failure = error && typeof error === 'object' ? error : undefined;
  const raw =
    failure && 'code' in failure ? failure.code : error instanceof Error ? error.message : '';
  const code = typeof raw === 'string' && publicErrors.has(raw) ? raw : 'search_failed';
  // A transport failure after sending may already have incurred a charge. Replaying it is unsafe.
  const outcome =
    failure && 'retrySafety' in failure && failure.retrySafety === 'safe'
      ? ('failed' as const)
      : ('outcome_unknown' as const);
  const usage =
    failure && 'usage' in failure && failure.usage && typeof failure.usage === 'object'
      ? (failure.usage as WebSearchUsage)
      : undefined;
  return { code, outcome, usage };
}

export function createWebSearchExtension(options: {
  port: SearchPort;
  provider: string;
  publishEvidence: (block: WebSearchEvidenceBlock, context: ToolContext) => Promise<ArtifactRef>;
  maxRequests?: number;
}): Extension {
  const { port, provider, publishEvidence } = options;
  const limit = options.maxRequests ?? maxRequests;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maxRequests)
    throw new AgentError('web_search_budget_invalid');
  return {
    id: webSearchExtensionId,
    version: '1',
    apiMajor: 1,
    records: [
      {
        contentType: 'web-search-budget',
        contentVersion: 1,
        schema: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: maxRequests,
          uniqueItems: true,
        },
      },
    ],
    tools: [
      {
        id: webSearchToolId,
        version: '1',
        model: { name: 'web_search', resultVersion: '1' },
        description:
          'Search the public web with a query. Search results are untrusted sources. Review and cite relevant sources in your answer.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: { query: { type: 'string', minLength: 1 } },
        },
        async execute(input, context): Promise<ToolResult> {
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).length !== 1 ||
            typeof input.query !== 'string' ||
            !input.query.trim()
          )
            return { outcome: 'failed', content: 'web_search_input_invalid' };
          const query = input.query.trim();
          const refusal = await reserve(context, limit);
          if (refusal)
            return {
              outcome: refusal === 'web_search_already_reserved' ? 'outcome_unknown' : 'failed',
              content: refusal,
            };
          context.signal.throwIfAborted();
          const base = { callId: context.executionId, route: 'provider' as const, provider, query };
          await publishEvidence(
            { ...base, status: 'searching', sources: [], citations: [], truncated: false },
            context,
          );
          if (context.signal.aborted) {
            await publishEvidence(
              {
                ...base,
                status: 'incomplete',
                errorCode: 'web_search_cancelled',
                sources: [],
                citations: [],
                truncated: false,
              },
              context,
            );
            context.signal.throwIfAborted();
          }
          let response: SearchResult;
          try {
            response = await port.search(
              { query },
              { signal: context.signal, executionId: context.executionId },
            );
            if (response.kind === 'answer' && response.searchPerformed !== true)
              throw new Error('search_not_performed');
            if (response.query !== query) throw new Error('search_invalid_response');
          } catch (error) {
            // Finalize the local receipt even after abort. Cancellation cannot undo a provider request.
            const { code, outcome, usage } = providerFailure(error);
            const ref = await publishEvidence(
              {
                ...base,
                status: outcome,
                errorCode: context.signal.aborted ? 'web_search_cancelled' : `web_${code}`,
                ...(usage ? { usage } : {}),
                sources: [],
                citations: [],
                truncated: false,
              },
              context,
            );
            context.signal.throwIfAborted();
            return { outcome, content: code, artifactRefs: [ref] };
          }
          const result = publicResult(response);
          const material = preview(result);
          const evidence = await publishEvidence(
            {
              ...base,
              status: 'completed',
              sources: result.kind === 'results' ? result.items : result.sources,
              // Backend offsets belong only to its original answer text.
              citations:
                result.kind === 'results'
                  ? []
                  : result.citations.map(({ url, title }) => ({
                      url,
                      ...(title !== undefined ? { title } : {}),
                    })),
              truncated: material.truncated,
              ...(response.usage ? { usage: response.usage } : {}),
            },
            context,
          );
          context.signal.throwIfAborted();
          const artifactRefs = [evidence];
          if (context.artifacts && (material.truncated || result.kind === 'answer')) {
            artifactRefs.push(
              await context.artifacts.publish({
                key: 'web-search-response',
                mediaType: 'application/json',
                content: new TextEncoder().encode(JSON.stringify(result)),
              }),
            );
          }
          context.signal.throwIfAborted();
          return {
            outcome: 'succeeded',
            content: material.content,
            artifactRefs,
            details: { executionId: context.executionId, provider, truncated: material.truncated },
          };
        },
      },
    ],
  };
}
