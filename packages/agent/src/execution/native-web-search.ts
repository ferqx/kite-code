import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import type { ArtifactContentStore } from '../artifact-port';
import type { Store } from '../storage/port';
import { AgentError } from '../storage/types';
import {
  type WebSearchEvidenceBlock,
  type WebSearchEvidenceScope,
  WebSearchEvidenceWriter,
  webSearchCitationAnchor,
} from '../web-search-evidence';

export interface NativeWebSearchBinding {
  readonly dialect: 'openai-web-search';
  /** Sealed host identity of the account, endpoint, model, route and serializer. */
  readonly bindingDigest: string;
  readonly accountDigest?: string;
  readonly authorizeDescendant?: NativeWebSearchBinding['authorize'];
  authorize(input: {
    sessionId: string;
    runId: string;
    executionId: string;
    modelId: string;
    signal: AbortSignal;
  }): Promise<boolean>;
}

export function nativeSearchMessages(
  messages: ModelRequest['messages'],
  bindingDigest: string | undefined,
): ModelRequest['messages'] {
  return messages.map((message) => {
    const data = message.continuation;
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      data.kind !== 'native_web_search_continuation'
    )
      return message;
    const { continuation: _private, ...plain } = message;
    return bindingDigest &&
      data.version === 1 &&
      data.bindingDigest === bindingDigest &&
      data.value !== undefined
      ? { ...plain, continuation: data.value }
      : plain;
  });
}

type Observation = Extract<ModelEvent, { type: 'web_search' }>['observation'];
type CallStatus = 'searching' | 'completed' | 'failed' | 'incomplete' | 'outcome_unknown';
type Citation = Extract<Observation, { kind: 'citation' }>;
const maxCalls = 16;
const maxLinks = 64;

/** Calls and output annotations have different owners. Externally produced data is never a local ToolCall. */
export class NativeSearchActivity {
  private readonly writer: WebSearchEvidenceWriter;
  private readonly scope: WebSearchEvidenceScope;
  private readonly calls = new Map<string, { status: CallStatus; query?: string }>();
  private readonly sources: { url: string; title?: string }[] = [];
  private readonly citations: Citation[] = [];
  private truncated = false;
  private responseWritten = false;
  observed = false;

  constructor(store: Store, artifacts: ArtifactContentStore, scope: WebSearchEvidenceScope) {
    this.scope = scope;
    this.writer = new WebSearchEvidenceWriter(store, artifacts, scope);
  }

  private write(callId: string, status: CallStatus, query?: string) {
    return this.writer.append({
      callId,
      route: 'native',
      provider: 'openai',
      status,
      ...(query ? { query } : {}),
      sources: [],
      citations: [],
      truncated: this.truncated,
    });
  }
  async observe(observation: Observation) {
    this.observed = true;
    if (observation.kind === 'activity') {
      if (
        !observation.callId ||
        observation.callId.length > 256 ||
        observation.callId === this.scope.executionId
      )
        throw new AgentError('native_search_event_invalid');
      const prior = this.calls.get(observation.callId);
      if (!prior && this.calls.size >= maxCalls) throw new AgentError('native_search_call_limit');
      // Some protocol paths repeat the terminal item and its earlier notification.
      if (prior && prior.status !== 'searching') {
        if (observation.status !== 'searching' && prior.status !== observation.status)
          throw new AgentError('native_search_status_conflict');
        return;
      }
      // One initial query and a terminal update bound progress writes per provider call.
      if (prior?.query !== undefined && observation.status === 'searching') return;
      const query = observation.query?.slice(0, 4096) ?? prior?.query;
      if (query !== undefined && observation.query && query !== observation.query)
        this.truncated = true;
      if (prior && prior.status === observation.status && prior.query === query) return;
      this.calls.set(observation.callId, { status: observation.status, query });
      await this.write(observation.callId, observation.status, query);
      return;
    }
    if (!observation.url || observation.url.length > 4096) {
      this.truncated = true;
      return;
    }
    if ((observation.title?.length ?? 0) > 512) this.truncated = true;
    if (observation.kind === 'source') {
      if (this.sources.some((s) => s.url === observation.url)) return;
      if (this.sources.length >= maxLinks) {
        this.truncated = true;
        return;
      }
      this.sources.push({
        url: observation.url,
        ...(observation.title ? { title: observation.title.slice(0, 512) } : {}),
      });
    } else {
      if (this.citations.length >= maxLinks) {
        this.truncated = true;
        return;
      }
      if (
        this.citations.some(
          (c) =>
            c.url === observation.url &&
            c.blockIndex === observation.blockIndex &&
            c.blockStartUtf16 === observation.blockStartUtf16 &&
            c.startUtf16 === observation.startUtf16 &&
            c.endUtf16 === observation.endUtf16,
        )
      )
        return;
      const text = observation.text;
      this.citations.push({
        ...observation,
        title: observation.title?.slice(0, 512),
        text: text && text.length <= 16384 ? text : undefined,
      });
      if (text && text.length > 16384) this.truncated = true;
    }
  }
  async finish(content: string) {
    for (const [id, call] of this.calls) {
      if (call.status === 'searching') {
        call.status = 'incomplete';
        await this.write(id, call.status, call.query);
      }
    }
    if (!this.sources.length && !this.citations.length) return;
    const citations: WebSearchEvidenceBlock['citations'][number][] = [];
    for (const c of this.citations) {
      // The adapter returns the full original text block for grounded ranges. A rewritten,
      // repeated or truncated block cannot locate a unique position in the stored message.
      const text = c.text;
      const suppliedOffset = c.blockStartUtf16;
      const offset = suppliedOffset ?? (text ? content.indexOf(text) : -1);
      const located =
        text &&
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        content.slice(offset, offset + text.length) === text &&
        (suppliedOffset !== undefined || content.lastIndexOf(text) === offset);
      const anchor =
        located &&
        c.blockIndex !== undefined &&
        c.startUtf16 !== undefined &&
        c.endUtf16 !== undefined
          ? webSearchCitationAnchor(
              this.scope.executionId,
              c.blockIndex,
              text,
              c.startUtf16,
              c.endUtf16,
              offset,
            )
          : undefined;
      citations.push({
        url: c.url,
        ...(c.title ? { title: c.title } : {}),
        ...(anchor ? { anchor } : {}),
      });
    }
    const statuses = [...this.calls.values()].map((c) => c.status);
    const status =
      statuses.length > 0 && statuses.every((s) => s === 'completed')
        ? 'completed'
        : statuses.includes('failed')
          ? 'failed'
          : 'incomplete';
    await this.writer.append({
      callId: this.scope.executionId,
      sourceScope: 'response',
      route: 'native',
      provider: 'openai',
      status,
      sources: this.sources,
      citations,
      truncated: this.truncated,
    });
    this.responseWritten = true;
  }
  async interrupted() {
    if (
      !this.responseWritten &&
      (!this.calls.size || this.sources.length || this.citations.length)
    ) {
      await this.writer.append({
        callId: this.scope.executionId,
        sourceScope: 'response',
        route: 'native',
        provider: 'openai',
        status: 'outcome_unknown',
        sources: this.sources,
        citations: this.citations.map(({ url, title }) => ({ url, ...(title ? { title } : {}) })),
        truncated: this.truncated,
      });
    }
    for (const [id, call] of this.calls) {
      if (call.status !== 'searching') continue;
      call.status = 'outcome_unknown';
      await this.write(id, call.status, call.query);
    }
  }
}
