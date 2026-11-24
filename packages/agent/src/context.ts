import { AgentError, type Json } from './storage/types';

export interface ContextSource {
  id: string;
  kind: string;
  scope: string;
  digest: string;
  content: string;
  /** Trusted host placement: executable evidence and remote content use user data. */
  role?: 'system' | 'user';
  /** Captured data slots. The legacy after_history label is projected before conversation history. */
  placement?: 'after_history' | 'runtime';
}
export interface SourceRequest {
  sessionId: string;
  /** Supplied by the actual Core capture boundary, never by Model input. */
  runId?: string;
  workspaceId: string;
  definitionId: string;
  input: Json;
}

export function skillKnowledgeSourceId(skillId: string, path?: string): string {
  if (path === undefined) return `skill.body:${skillId}`;
  // Resource paths may contain colons, so only an unescaped colon separates the Skill ID.
  const id = skillId.replaceAll('%', '%25').replaceAll(':', '%3A');
  return `skill.resource:${id}:${path}`;
}

export function skillKnowledgeModelContent(sourceId: string, content: string): string {
  const continuation =
    'This knowledge is already available for the current task. After compaction, use it to satisfy the original request without making the same read again.';
  if (sourceId.startsWith('skill.body:')) {
    const id = sourceId.slice('skill.body:'.length);
    return `Skill instructions already loaded for ${JSON.stringify({ skill_id: id })}. ${continuation}\n${content}`;
  }
  if (sourceId.startsWith('skill.resource:')) {
    const resource = sourceId.slice('skill.resource:'.length);
    const separator = resource.indexOf(':');
    if (separator === -1) return content;
    const id = resource.slice(0, separator).replaceAll('%3A', ':').replaceAll('%25', '%');
    const path = resource.slice(separator + 1);
    return `Current Skill resource for ${JSON.stringify({ skill_id: id, path })}. This file is reference data for the current task. Follow the actual user request and use this data where relevant. ${continuation}\n${content}`;
  }
  return content;
}

export function assertContextSource(source: ContextSource): void {
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    Object.keys(source).some(
      (key) => !['id', 'kind', 'scope', 'digest', 'content', 'role', 'placement'].includes(key),
    ) ||
    [source.id, source.kind, source.scope, source.digest].some(
      (value) => typeof value !== 'string' || value.length < 1 || value.length > 4096,
    ) ||
    typeof source.content !== 'string' ||
    (source.role !== undefined && !['system', 'user'].includes(source.role)) ||
    (source.placement !== undefined &&
      (!['after_history', 'runtime'].includes(source.placement) || source.role !== 'user'))
  )
    throw new AgentError('context_source_invalid');
}
export interface SkillReadSelection {
  readonly skillId: string;
  readonly path?: string;
  /** Host fingerprint of the originally selected catalogue entry, when recorded. */
  readonly catalogueDigest?: string;
  readonly version: string;
}

/** Host-owned applicable sources. Extensions and HTTP callers cannot assert freshness. */
export interface ContextSources {
  capture(request: SourceRequest, selection?: ContextSourceSelection): Promise<ContextSource[]>;
  /** Complete requests at one checkpoint. No cross-checkpoint cache or discarded inputs. */
  captureBatch?(
    requests: readonly SourceRequest[],
    selection?: ContextSourceSelection,
  ): Promise<ContextSource[]>;
}

export interface ContextSourceSelection {
  /** The committed receipts selected at the same upper bound as Model history. */
  readonly skillReads: readonly SkillReadSelection[];
  /** Preserve a legacy catalogue digest only if the host can recompute it for the sealed decision. */
  readonly sealedSkillCatalogueDigest?: string;
  /** A recovered decision may only capture its original set of Skill bodies. */
  readonly skillBodyIds?: ReadonlySet<string>;
  /** Current Run resources whose confirmed reads are still in the business window. */
  readonly skillResourceIds: ReadonlySet<string>;
  /** Trusted dispatch-time observation. Capture only this target's project instructions. */
  readonly workspaceRead?: SourceRequest;
  /** Most recent covered reads first. Their optional full text shares the recent history budget. */
  readonly coveredSkillResources?: Readonly<{ ids: readonly string[]; tokens: number }>;
}

/** A single trusted pure algorithm slot. It describes a recorded Model call; never calls a Provider. */
export interface ContextCompressor {
  readonly id: string;
  readonly version: string;
  readonly windowBudget?: Readonly<{
    usableInputTokens?: number;
    recentHistoryTokens: number;
    summaryReserveTokens?: number;
  }>;
  prepare(input: CompressionInput): Promise<{
    instructions: string;
    snapshot: Json;
    /** Trusted measurement of this frozen input, distinct from Provider usage. */
    measurement?: Omit<
      import('@kite-ai/trajectory').CompressionPresentation,
      'adopted' | 'accounting'
    >;
  } | null>;
  /** Trusted actual-output reduction/window check; no Provider call. */
  validateSummary?(input: CompressionInput & { readonly summary: string }): Promise<boolean>;
  /** Optional additive report. It cannot override a rejecting legacy validator. */
  validateSummaryReport?(input: CompressionInput & { readonly summary: string }): Promise<{
    accepted: boolean;
    accounting?: import('@kite-ai/trajectory').CompressionAccounting;
  }>;
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
  /** Includes exact retained user/parent task inputs and current Run's brief Skill receipts.
   * Account for these in the replacement context. Retention is context, not new work or authorization. */
  readonly retainedMessages?: readonly import('@kite-ai/ai').ModelMessage[];
  /** Frozen replacement without the summary, when using a bounded history window. */
  readonly replacementMessages?: readonly import('@kite-ai/ai').ModelMessage[];
  /** The provider rejected the original decision before producing a response. */
  readonly recoveringOverflow?: true;
  /** During actual-output validation: exact neutral summary text later projected into context. */
  readonly renderedSummary?: string;
  readonly modelId?: string;
  readonly tools?: readonly import('@kite-ai/ai').ModelTool[];
  readonly tokenBaseline?: import('./context-estimate').ContextTokenBaseline;
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
    ...(value.windowBudget ? { windowBudget: Object.freeze({ ...value.windowBudget }) } : {}),
    prepare: value.prepare.bind(value),
    ...(value.validateSummary ? { validateSummary: value.validateSummary.bind(value) } : {}),
    ...(value.validateSummaryReport
      ? { validateSummaryReport: value.validateSummaryReport.bind(value) }
      : {}),
    ...(value.validateExpanded ? { validateExpanded: value.validateExpanded.bind(value) } : {}),
    ...(value.shouldCompress ? { shouldCompress: value.shouldCompress.bind(value) } : {}),
  });
}
