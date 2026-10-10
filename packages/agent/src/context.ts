import { AgentError, type Json } from './storage/types';

export interface ContextSource {
  id: string;
  kind: string;
  scope: string;
  digest: string;
  content: string;
  /** Trusted host placement: executable evidence and remote content use user data. */
  role?: 'system' | 'user';
}
export interface SourceRequest {
  sessionId: string;
  workspaceId: string;
  definitionId: string;
  input: Json;
}
export function assertContextSource(source: ContextSource): void {
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    Object.keys(source).some(
      (key) => !['id', 'kind', 'scope', 'digest', 'content', 'role'].includes(key),
    ) ||
    [source.id, source.kind, source.scope, source.digest].some(
      (value) => typeof value !== 'string' || value.length < 1 || value.length > 4096,
    ) ||
    typeof source.content !== 'string' ||
    (source.role !== undefined && !['system', 'user'].includes(source.role))
  )
    throw new AgentError('context_source_invalid');
}
/** Host-owned applicable sources. Extensions and HTTP callers cannot assert freshness. */
export interface ContextSources {
  capture(request: SourceRequest): Promise<ContextSource[]>;
  /** Complete requests at one checkpoint. No cross-checkpoint cache or discarded inputs. */
  captureBatch?(requests: readonly SourceRequest[]): Promise<ContextSource[]>;
}

/** A single trusted pure algorithm slot. It describes a recorded Model call; never calls a Provider. */
export interface ContextCompressor {
  readonly id: string;
  readonly version: string;
  prepare(input: CompressionInput): Promise<{ instructions: string; snapshot: Json } | null>;
  /** Trusted actual-output reduction/window check; no Provider call. */
  validateSummary?(input: CompressionInput & { readonly summary: string }): Promise<boolean>;
  /** Explicit opt-in automatic trigger. Absence means manual only. */
  shouldCompress?(input: CompressionInput): Promise<boolean>;
  /** Trusted model-window preflight for restoring complete selected history; no Provider call. */
  validateExpanded?(input: CompressionInput): Promise<boolean>;
}
export interface CompressionInput {
  readonly command: Readonly<import('./storage/types').CommandRecord>;
  readonly run: Readonly<import('./storage/types').RunRecord>;
  readonly session: Readonly<import('./storage/types').SessionRecord>;
  readonly messages: readonly import('@kite-ai/ai').ModelMessage[];
  readonly sources: readonly ContextSource[];
  readonly trigger: 'manual' | 'automatic';
  readonly focus: string | null;
  readonly signal: AbortSignal;
}
export function sealCompressor(
  value: ContextCompressor | undefined,
): ContextCompressor | undefined {
  if (!value) return undefined;
  if (
    !value.id ||
    value.id.length > 128 ||
    !value.version ||
    value.version.length > 128 ||
    typeof value.prepare !== 'function'
  )
    throw new AgentError('compression_configuration_invalid');
  return Object.freeze({
    id: value.id,
    version: value.version,
    prepare: value.prepare.bind(value),
    ...(value.validateSummary ? { validateSummary: value.validateSummary.bind(value) } : {}),
    ...(value.validateExpanded ? { validateExpanded: value.validateExpanded.bind(value) } : {}),
    ...(value.shouldCompress ? { shouldCompress: value.shouldCompress.bind(value) } : {}),
  });
}
