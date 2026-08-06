import { canonicalJsonBytes, sha256DomainSeparated } from '../../release/canonical-json';

/**
 * The parent/child protocol is deliberately small and private.  It is a
 * newline-delimited JSON protocol over explicitly piped stdio, never Bun IPC
 * (which would inject an implementation-owned bootstrap environment value).
 */
export const LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1 = 'LiveIsolatedTransportProtocolV1';
export const LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1 = 1;
export const LIVE_ISOLATED_TRANSPORT_MAX_FRAME_BYTES_V1 = 96 * 1024;
export const LIVE_ISOLATED_TRANSPORT_MAX_PROMPT_BYTES_V1 = 72 * 1024;
export const LIVE_ISOLATED_TRANSPORT_MAX_RESPONSE_TEXT_BYTES_V1 = 16 * 1024;

export const LIVE_ISOLATED_TRANSPORT_TEST_MODES_V1 = [
  'return_summary',
  'return_primary',
  'return_cancelled',
  'hang_before_ready',
  'hang_after_ready',
  'hang_after_dispatch',
  'late_result',
  /** Fixed hostile-fixture mode proving parent cancellation result fencing. */
  'late_summary_after_cancel',
  'spawn_fixed_descendant_then_hang',
  /** Fixed leader-exit fixture proving post-exit process-group quarantine. */
  'leader_exits_with_descendant_then_exit',
  /** Parent-only fixed failure paths for scratch-retention contract tests. */
  'fixed_spawn_failure_with_cleanup_failure',
  'fixed_setup_failure_with_cleanup_failure',
] as const;

export type LiveIsolatedTransportTestModeV1 =
  (typeof LIVE_ISOLATED_TRANSPORT_TEST_MODES_V1)[number];

export type LiveIsolatedTransportOperationV1 = 'aq8' | 'aq9b' | 'test';

export interface LiveIsolatedTransportCredentialLeaseV1 {
  readonly baseURL: string;
  readonly apiKey: string;
}

/** The AQ-9B proxy permits exactly the synthetic text-only prompt surface. */
export interface LiveIsolatedTransportPromptMessageV1 {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LiveIsolatedTransportRequestV1 {
  readonly operation: LiveIsolatedTransportOperationV1;
  readonly routeAlias: 'qualification-qwen3.6-flash';
  readonly model: 'qwen3.6-flash';
  readonly phase: 'aq8' | 'summary' | 'primary' | 'test';
  /** Source-owned phase input cap; child usage cannot exceed this binding. */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly promptDigest: `sha256:${string}`;
  readonly prompt?: string;
  readonly promptMessages?: readonly LiveIsolatedTransportPromptMessageV1[];
  readonly testMode?: LiveIsolatedTransportTestModeV1;
}

export interface LiveIsolatedTransportInitFrameV1 {
  readonly schema: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1;
  readonly version: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1;
  readonly kind: 'init';
  readonly nonce: string;
  readonly cutoffAtMs: number;
  readonly testMode?: Extract<LiveIsolatedTransportTestModeV1, 'hang_before_ready'>;
}

export interface LiveIsolatedTransportDispatchFrameV1 {
  readonly schema: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1;
  readonly version: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1;
  readonly kind: 'dispatch';
  readonly nonce: string;
  readonly request: LiveIsolatedTransportRequestV1;
  /** Omitted for fixed no-credential test modes. */
  readonly lease?: LiveIsolatedTransportCredentialLeaseV1;
}

export interface LiveIsolatedTransportCancelFrameV1 {
  readonly schema: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1;
  readonly version: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1;
  readonly kind: 'cancel';
  readonly nonce: string;
}

export type LiveIsolatedTransportParentFrameV1 =
  | LiveIsolatedTransportInitFrameV1
  | LiveIsolatedTransportDispatchFrameV1
  | LiveIsolatedTransportCancelFrameV1;

export interface LiveIsolatedTransportReadyFrameV1 {
  readonly schema: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1;
  readonly version: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1;
  readonly kind: 'ready';
  readonly nonce: string;
}

export interface LiveIsolatedTransportResultFrameV1 {
  readonly schema: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1;
  readonly version: typeof LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1;
  readonly kind: 'result';
  readonly nonce: string;
  readonly phase: 'aq8' | 'summary' | 'primary' | 'test';
  readonly promptDigest: `sha256:${string}`;
  readonly outcome: 'success' | 'cancelled' | 'not_observed';
  readonly providerDispatchCount: 0 | 1;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
  };
  /** AQ-9B only; raw text/reasoning/tool payloads cannot cross the pipe. */
  readonly generation?:
    | { readonly kind: 'accepted_summary' }
    | { readonly kind: 'accepted_primary' }
    | { readonly kind: 'tool_marker' }
    | { readonly kind: 'empty' };
}

export type LiveIsolatedTransportChildFrameV1 =
  | LiveIsolatedTransportReadyFrameV1
  | LiveIsolatedTransportResultFrameV1;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maximumBytes &&
    !value.includes('\0')
  );
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isUsageBucket(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isPromptMessage(value: unknown): value is LiveIsolatedTransportPromptMessageV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['content', 'role'])) return false;
  return (
    (value.role === 'system' || value.role === 'user' || value.role === 'assistant') &&
    isSafeString(value.content, LIVE_ISOLATED_TRANSPORT_MAX_PROMPT_BYTES_V1)
  );
}

function isTestMode(value: unknown): value is LiveIsolatedTransportTestModeV1 {
  return (
    typeof value === 'string' &&
    (LIVE_ISOLATED_TRANSPORT_TEST_MODES_V1 as readonly string[]).includes(value)
  );
}

export function liveIsolatedTransportPromptDigestV1(
  request: Pick<
    LiveIsolatedTransportRequestV1,
    'operation' | 'phase' | 'prompt' | 'promptMessages'
  >,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-isolated-transport.prompt.v1',
    canonicalJsonBytes({
      operation: request.operation,
      phase: request.phase,
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      ...(request.promptMessages !== undefined ? { promptMessages: request.promptMessages } : {}),
    }),
  );
}

export function isLiveIsolatedTransportRequestV1(
  value: unknown,
): value is LiveIsolatedTransportRequestV1 {
  if (!isPlainRecord(value)) return false;
  const allowedKeys = [
    'operation',
    'routeAlias',
    'model',
    'phase',
    'maxInputTokens',
    'maxOutputTokens',
    'promptDigest',
    'prompt',
    'promptMessages',
    'testMode',
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return false;
  if (
    (value.operation !== 'aq8' && value.operation !== 'aq9b' && value.operation !== 'test') ||
    value.routeAlias !== 'qualification-qwen3.6-flash' ||
    value.model !== 'qwen3.6-flash' ||
    (value.phase !== 'aq8' &&
      value.phase !== 'summary' &&
      value.phase !== 'primary' &&
      value.phase !== 'test') ||
    !isPositiveInteger(value.maxInputTokens, 12_288) ||
    !isPositiveInteger(value.maxOutputTokens, 600) ||
    !isDigest(value.promptDigest)
  ) {
    return false;
  }
  if (value.operation === 'aq8') {
    return (
      value.phase === 'aq8' &&
      isSafeString(value.prompt, LIVE_ISOLATED_TRANSPORT_MAX_PROMPT_BYTES_V1) &&
      value.promptMessages === undefined &&
      value.testMode === undefined &&
      value.promptDigest ===
        liveIsolatedTransportPromptDigestV1({
          operation: 'aq8',
          phase: 'aq8',
          prompt: value.prompt,
        })
    );
  }
  if (value.operation === 'aq9b') {
    return (
      (value.phase === 'summary' || value.phase === 'primary') &&
      Array.isArray(value.promptMessages) &&
      value.promptMessages.length > 0 &&
      value.promptMessages.every(isPromptMessage) &&
      value.prompt === undefined &&
      value.testMode === undefined &&
      new TextEncoder().encode(JSON.stringify(value.promptMessages)).byteLength <=
        LIVE_ISOLATED_TRANSPORT_MAX_PROMPT_BYTES_V1 &&
      value.promptDigest ===
        liveIsolatedTransportPromptDigestV1({
          operation: 'aq9b',
          phase: value.phase,
          promptMessages: value.promptMessages,
        })
    );
  }
  return (
    (value.phase === 'aq8' ||
      value.phase === 'summary' ||
      value.phase === 'primary' ||
      value.phase === 'test') &&
    isTestMode(value.testMode) &&
    value.prompt === undefined &&
    value.promptMessages === undefined &&
    value.promptDigest ===
      liveIsolatedTransportPromptDigestV1({ operation: 'test', phase: value.phase })
  );
}

function isCredentialLease(value: unknown): value is LiveIsolatedTransportCredentialLeaseV1 {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['apiKey', 'baseURL']) &&
    isSafeString(value.baseURL, 512) &&
    isSafeString(value.apiKey, 1024)
  );
}

function isBaseFrame(value: Record<string, unknown>, kind: string, nonce: unknown): boolean {
  return (
    value.schema === LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1 &&
    value.version === LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1 &&
    value.kind === kind &&
    isNonce(nonce)
  );
}

export function parseLiveIsolatedTransportParentFrameV1(
  value: unknown,
): LiveIsolatedTransportParentFrameV1 | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (
    isBaseFrame(value, 'init', value.nonce) &&
    (hasExactKeys(value, ['cutoffAtMs', 'kind', 'nonce', 'schema', 'version']) ||
      hasExactKeys(value, ['cutoffAtMs', 'kind', 'nonce', 'schema', 'testMode', 'version']))
  ) {
    if (
      Number.isSafeInteger(value.cutoffAtMs) &&
      (value.testMode === undefined || value.testMode === 'hang_before_ready')
    ) {
      return value as unknown as LiveIsolatedTransportInitFrameV1;
    }
  }
  if (isBaseFrame(value, 'dispatch', value.nonce)) {
    const keys = Object.keys(value).sort();
    const exact =
      (keys.length === 6 && keys.join(',') === 'kind,lease,nonce,request,schema,version') ||
      (keys.length === 5 && keys.join(',') === 'kind,nonce,request,schema,version');
    if (!exact || !isLiveIsolatedTransportRequestV1(value.request)) return undefined;
    const request = value.request;
    if ((request.operation === 'test') !== (value.lease === undefined)) return undefined;
    if (request.operation !== 'test' && !isCredentialLease(value.lease)) return undefined;
    return value as unknown as LiveIsolatedTransportDispatchFrameV1;
  }
  if (
    isBaseFrame(value, 'cancel', value.nonce) &&
    hasExactKeys(value, ['kind', 'nonce', 'schema', 'version'])
  ) {
    return value as unknown as LiveIsolatedTransportCancelFrameV1;
  }
  return undefined;
}

export function parseLiveIsolatedTransportChildFrameV1(
  value: unknown,
): LiveIsolatedTransportChildFrameV1 | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (
    isBaseFrame(value, 'ready', value.nonce) &&
    hasExactKeys(value, ['kind', 'nonce', 'schema', 'version'])
  ) {
    return value as unknown as LiveIsolatedTransportReadyFrameV1;
  }
  if (!isBaseFrame(value, 'result', value.nonce)) return undefined;
  const allowedKeys = [
    'schema',
    'version',
    'kind',
    'nonce',
    'phase',
    'promptDigest',
    'outcome',
    'providerDispatchCount',
    'usage',
    'generation',
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return undefined;
  if (
    (value.outcome !== 'success' &&
      value.outcome !== 'cancelled' &&
      value.outcome !== 'not_observed') ||
    (value.phase !== 'aq8' &&
      value.phase !== 'summary' &&
      value.phase !== 'primary' &&
      value.phase !== 'test') ||
    !isDigest(value.promptDigest) ||
    (value.providerDispatchCount !== 0 && value.providerDispatchCount !== 1) ||
    !isPlainRecord(value.usage) ||
    !hasExactKeys(value.usage, ['inputTokens', 'outputTokens', 'totalTokens']) ||
    !isUsageBucket(value.usage.inputTokens) ||
    !isUsageBucket(value.usage.outputTokens) ||
    !isUsageBucket(value.usage.totalTokens)
  ) {
    return undefined;
  }
  if (value.generation !== undefined) {
    if (!isPlainRecord(value.generation) || typeof value.generation.kind !== 'string')
      return undefined;
    if (
      value.generation.kind === 'accepted_summary' ||
      value.generation.kind === 'accepted_primary' ||
      value.generation.kind === 'tool_marker' ||
      value.generation.kind === 'empty'
    ) {
      if (!hasExactKeys(value.generation, ['kind'])) return undefined;
    } else return undefined;
  }
  if (value.outcome === 'success' && value.providerDispatchCount !== 1) return undefined;
  if (
    value.outcome === 'success' &&
    value.phase !== 'aq8' &&
    (value.generation === undefined ||
      value.generation.kind === 'empty' ||
      value.generation.kind === 'tool_marker')
  ) {
    return undefined;
  }
  return value as unknown as LiveIsolatedTransportResultFrameV1;
}

export function encodeLiveIsolatedTransportFrameV1(value: unknown): string | undefined {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength === 0 || bytes.byteLength > LIVE_ISOLATED_TRANSPORT_MAX_FRAME_BYTES_V1) {
      return undefined;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

export function parseLiveIsolatedTransportFrameLineV1(line: string): unknown | undefined {
  if (
    new TextEncoder().encode(line).byteLength === 0 ||
    new TextEncoder().encode(line).byteLength > LIVE_ISOLATED_TRANSPORT_MAX_FRAME_BYTES_V1
  ) {
    return undefined;
  }
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
