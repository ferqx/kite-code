import { createHash } from 'node:crypto';
import type { ArtifactContentStore } from './artifact-port';
import { canonicalJson } from './json';
import type { Store } from './storage/port';
import { AgentError, type ArtifactReference, type Json } from './storage/types';
import {
  webSearchBlockBytes,
  webSearchDisplayUrl,
  webSearchMediaType,
  webSearchRefId,
  webSearchRequestBytes,
} from './web-search-evidence-identity';

export interface WebSearchEvidenceScope {
  expectedStoreId: string;
  sessionId: string;
  subjectId: string;
  executionId: string;
  signal?: AbortSignal;
}

export interface WebSearchAnchor {
  executionId: string;
  blockIndex: number;
  textSha256: string;
  blockLengthUtf16: number;
  blockStartUtf16?: number;
  startUtf16: number;
  endUtf16: number;
}
export interface WebSearchEvidenceBlock {
  callId: string;
  route: 'native' | 'provider';
  provider: string;
  status: 'searching' | 'completed' | 'incomplete' | 'failed' | 'outcome_unknown';
  query?: string;
  sourceScope?: 'response';
  sources: { url: string; title?: string; snippet?: string }[];
  citations: { url: string; title?: string; anchor?: WebSearchAnchor }[];
  truncated: boolean;
  errorCode?: string;
  usage?: {
    providerRequests?: number;
    searchModelInputTokens?: number;
    searchModelOutputTokens?: number;
    providerSearchCalls?: number;
  };
}
export interface WebSearchEvidence {
  schema: 'kite.web-search';
  schemaVersion: 1;
  storeId: string;
  sessionId: string;
  executionId: string;
  revision: number;
  blocks: WebSearchEvidenceBlock[];
}

const safeOffset = (value: number) => Number.isSafeInteger(value) && value >= 0;
const boundary = (text: string, at: number) =>
  !(
    at > 0 &&
    at < text.length &&
    /[\uD800-\uDBFF]/.test(text[at - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[at]!)
  );

export function webSearchCitationAnchor(
  executionId: string,
  blockIndex: number,
  text: string,
  startUtf16: number,
  endUtf16: number,
  blockStartUtf16?: number,
): WebSearchAnchor | undefined {
  if (
    !executionId ||
    !safeOffset(blockIndex) ||
    !safeOffset(startUtf16) ||
    !safeOffset(endUtf16) ||
    startUtf16 >= endUtf16 ||
    endUtf16 > text.length ||
    (blockStartUtf16 !== undefined &&
      (!safeOffset(blockStartUtf16) || !safeOffset(blockStartUtf16 + text.length))) ||
    !boundary(text, startUtf16) ||
    !boundary(text, endUtf16)
  )
    return undefined;
  return {
    executionId,
    blockIndex,
    textSha256: createHash('sha256').update(text).digest('hex'),
    blockLengthUtf16: text.length,
    ...(blockStartUtf16 === undefined ? {} : { blockStartUtf16 }),
    startUtf16,
    endUtf16,
  };
}

function validAnchor(anchor: WebSearchAnchor, executionId: string) {
  return (
    anchor.executionId === executionId &&
    /^[a-f0-9]{64}$/.test(anchor.textSha256) &&
    safeOffset(anchor.blockIndex) &&
    safeOffset(anchor.blockLengthUtf16) &&
    (anchor.blockStartUtf16 === undefined ||
      (safeOffset(anchor.blockStartUtf16) &&
        safeOffset(anchor.blockStartUtf16 + anchor.blockLengthUtf16))) &&
    safeOffset(anchor.startUtf16) &&
    safeOffset(anchor.endUtf16) &&
    anchor.startUtf16 < anchor.endUtf16 &&
    anchor.endUtf16 <= anchor.blockLengthUtf16
  );
}
function normalBlock(input: WebSearchEvidenceBlock, executionId: string): WebSearchEvidenceBlock {
  if (
    !input ||
    !['native', 'provider'].includes(input.route) ||
    !['searching', 'completed', 'incomplete', 'failed', 'outcome_unknown'].includes(input.status) ||
    typeof input.provider !== 'string' ||
    !input.provider ||
    input.provider.length > 256 ||
    typeof input.callId !== 'string' ||
    !input.callId ||
    input.callId.length > 256 ||
    !Array.isArray(input.sources) ||
    !Array.isArray(input.citations) ||
    typeof input.truncated !== 'boolean'
  )
    throw new AgentError('web_search_evidence_invalid');
  let truncated = input.truncated || input.sources.length > 64 || input.citations.length > 128;
  function text(value: string, limit: number) {
    if (typeof value !== 'string') throw new AgentError('web_search_evidence_invalid');
    if (value.length <= limit) return value;
    truncated = true;
    return value.slice(0, boundary(value, limit) ? limit : limit - 1);
  }
  const sources = input.sources.slice(0, 64).flatMap((source) => {
    if (!webSearchDisplayUrl(source?.url)) {
      truncated = true;
      return [];
    }
    return [
      {
        url: source.url,
        ...(source.title === undefined ? {} : { title: text(source.title, 512) }),
        ...(source.snippet === undefined ? {} : { snippet: text(source.snippet, 2048) }),
      },
    ];
  });
  const citations = input.citations.slice(0, 128).flatMap((citation) => {
    if (!webSearchDisplayUrl(citation?.url)) {
      truncated = true;
      return [];
    }
    const a = citation.anchor;
    const anchor =
      input.route === 'native' && a && validAnchor(a, executionId)
        ? {
            executionId,
            blockIndex: a.blockIndex,
            textSha256: a.textSha256,
            startUtf16: a.startUtf16,
            endUtf16: a.endUtf16,
            blockLengthUtf16: a.blockLengthUtf16,
            ...(a.blockStartUtf16 === undefined ? {} : { blockStartUtf16: a.blockStartUtf16 }),
          }
        : undefined;
    return [
      {
        url: citation.url,
        ...(citation.title === undefined ? {} : { title: text(citation.title, 512) }),
        ...(anchor ? { anchor } : {}),
      },
    ];
  });
  const usage: WebSearchEvidenceBlock['usage'] = {};
  for (const key of [
    'providerRequests',
    'searchModelInputTokens',
    'searchModelOutputTokens',
    'providerSearchCalls',
  ] as const) {
    const n = input.usage?.[key];
    if (n === undefined) continue;
    if (!safeOffset(n)) throw new AgentError('web_search_evidence_invalid');
    usage[key] = n;
  }
  if (input.errorCode !== undefined && !/^web_search_[a-z0-9_]{1,110}$/.test(input.errorCode))
    throw new AgentError('web_search_evidence_invalid');
  return {
    callId: input.callId,
    route: input.route,
    provider: input.provider,
    status: input.status,
    ...(input.query === undefined ? {} : { query: text(input.query, 2048) }),
    ...(input.sourceScope === 'response' ? { sourceScope: 'response' } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    sources,
    citations,
    truncated,
  };
}

function canonical(value: unknown) {
  return canonicalJson(value as Json);
}
function identity(scope: WebSearchEvidenceScope) {
  return {
    schema: 'kite.web-search' as const,
    schemaVersion: 1 as const,
    storeId: scope.expectedStoreId,
    sessionId: scope.sessionId,
    executionId: scope.executionId,
  };
}
async function references(store: Store, scope: WebSearchEvidenceScope) {
  const { signal, ...owner } = scope;
  signal?.throwIfAborted();
  try {
    return await store.listWebSearchEvidenceReferences(owner);
  } catch (error) {
    if (
      error instanceof AgentError &&
      ['artifact_scope_invalid', 'artifact_scope_denied'].includes(error.code)
    )
      throw new AgentError('web_search_evidence_unavailable');
    throw error;
  }
}

async function readBlock(
  artifacts: ArtifactContentStore,
  scope: WebSearchEvidenceScope,
  ref: ArtifactReference,
  revision: number,
) {
  const bytes = artifacts.readReference
    ? await artifacts.readReference({
        expectedStoreId: scope.expectedStoreId,
        reference: ref,
        signal: scope.signal,
      })
    : await artifacts.read({
        expectedStoreId: scope.expectedStoreId,
        subjectId: scope.subjectId,
        sessionId: scope.sessionId,
        scope: ref.scope,
        refId: ref.id,
        signal: scope.signal,
      });
  if (
    bytes.byteLength !== Number(ref.size) ||
    bytes.byteLength > webSearchBlockBytes ||
    createHash('sha256').update(bytes).digest('hex') !== ref.hash
  )
    throw new AgentError('web_search_evidence_invalid');
  try {
    const stored = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const block = normalBlock(stored.block, scope.executionId);
    const inputHash = stored.inputHash;
    if (typeof inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(inputHash))
      throw new AgentError('web_search_evidence_invalid');
    const envelope = { ...identity(scope), storeId: ref.storeId, revision, inputHash, block };
    if (canonical(stored) !== canonical(envelope))
      throw new AgentError('web_search_evidence_invalid');
    return { block, inputHash };
  } catch {
    throw new AgentError('web_search_evidence_invalid');
  }
}

export async function readWebSearchEvidence(
  store: Store,
  artifacts: ArtifactContentStore | undefined,
  scope: WebSearchEvidenceScope,
): Promise<WebSearchEvidence> {
  const refs = await references(store, scope);
  const calls = new Map<string, WebSearchEvidenceBlock>();
  for (const [i, ref] of refs.entries()) {
    if (!artifacts) throw new AgentError('artifact_content_unavailable');
    scope.signal?.throwIfAborted();
    const { block } = await readBlock(artifacts, scope, ref, i + 1);
    calls.set(JSON.stringify([block.sourceScope ?? null, block.callId]), block);
  }
  scope.signal?.throwIfAborted();
  return { ...identity(scope), revision: refs.length, blocks: [...calls.values()] };
}

function boundedRevision(
  scope: WebSearchEvidenceScope,
  revision: number,
  inputHash: string,
  original: WebSearchEvidenceBlock,
  limit: number,
) {
  const block = structuredClone(original);
  const encode = () => Buffer.from(canonical({ ...identity(scope), revision, inputHash, block }));
  const complete = encode();
  if (complete.length <= limit) return complete;
  block.truncated = true;
  let bytes = encode().length;
  // Remove whole entries, accounting for their UTF-8 representation and the comma.
  for (const entries of [block.sources, block.citations]) {
    while (entries.length && bytes > limit) {
      bytes -= Buffer.byteLength(canonical(entries.pop())) + (entries.length ? 1 : 0);
    }
  }
  if (bytes > limit && block.query !== undefined) delete block.query;
  const content = encode();
  if (content.length > limit) throw new AgentError('web_search_evidence_limit');
  return content;
}

/** Each ordinal is one immutable Artifact identity. Competing writers can only claim the same next ordinal once. */
export class WebSearchEvidenceWriter {
  private readonly store: Store;
  private readonly artifacts: ArtifactContentStore;
  private readonly scope: WebSearchEvidenceScope;

  constructor(store: Store, artifacts: ArtifactContentStore, scope: WebSearchEvidenceScope) {
    this.store = store;
    this.artifacts = artifacts;
    this.scope = { ...scope };
  }
  async append(input: WebSearchEvidenceBlock): Promise<ArtifactReference> {
    const scope = this.scope;
    const original = normalBlock(input, scope.executionId);
    const execution = await this.store.getExecution(scope.executionId);
    if (
      !execution ||
      execution.sessionId !== scope.sessionId ||
      execution.originStoreId !== scope.expectedStoreId ||
      (original.route === 'native'
        ? execution.kind !== 'model'
        : execution.kind !== 'tool' || execution.definitionId !== 'web.search')
    )
      throw new AgentError('web_search_evidence_unavailable');
    const inputHash = createHash('sha256').update(canonical(original)).digest('hex');
    let conflicted = 0;
    for (;;) {
      const refs = await references(this.store, scope);
      const revision = refs.length + 1;
      if (revision <= conflicted) throw new AgentError('web_search_evidence_invalid');
      for (let i = refs.length - 1; i >= 0; i--) {
        const prior = await readBlock(this.artifacts, scope, refs[i]!, i + 1);
        if (
          prior.block.callId !== original.callId ||
          prior.block.sourceScope !== original.sourceScope
        )
          continue;
        if (prior.inputHash === inputHash) return refs[i]!;
        if (
          prior.block.route !== original.route ||
          prior.block.provider !== original.provider ||
          (prior.block.status !== 'searching' && prior.block.status !== original.status)
        )
          throw new AgentError('web_search_evidence_transition_invalid');
        break;
      }
      const remaining = webSearchRequestBytes - refs.reduce((size, r) => size + Number(r.size), 0);
      const bytes = boundedRevision(
        scope,
        revision,
        inputHash,
        original,
        Math.min(webSearchBlockBytes, remaining),
      );
      try {
        return await this.artifacts.publish({
          expectedStoreId: scope.expectedStoreId,
          sessionId: scope.sessionId,
          subjectId: scope.subjectId,
          scope: { kind: 'execution', id: scope.executionId },
          refId: webSearchRefId(scope.sessionId, scope.executionId, revision),
          mediaType: webSearchMediaType,
          content: bytes,
          signal: scope.signal,
        });
      } catch (error) {
        if (!(error instanceof AgentError && error.code === 'artifact_reference_conflict'))
          throw error;
        conflicted = revision;
      }
    }
  }
}
