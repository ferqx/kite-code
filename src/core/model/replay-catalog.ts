import { createRuntimeSecretDetectorV1 } from '@/core/session-logger/content-inspector';
import {
  type CanonicalModelMessageV1,
  MODEL_ATTEMPT_OUTCOME_SCHEMA_V1,
  MODEL_INVOCATION_CONTEXT_SCHEMA_V1,
  MODEL_INVOCATION_PURPOSES_V1,
  MODEL_REPLAY_CATALOG_SCHEMA_V1,
  type ModelAttemptOutcomeV1,
  type ModelInvocationContextV1,
  type ModelInvocationEnvelopeV1,
  type ModelInvocationPurposeV1,
  type ModelReplayActorIdentityV1,
  type ModelReplayAttemptRecordV1,
  type ModelReplayCatalogV1,
  type Sha256DigestV1,
} from '@/protocol/model-surface';
import {
  assertCanonicalModelMessageV1,
  assertModelAdapterReplayOwnerV1,
  assertModelRouteIdentityV1,
  canonicalModelJsonV1,
  computePrivateModelEvidenceDigestV1,
} from './surface-canonicalizer';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CASSETTE_RESPONSE_ID_PATTERN = /^cassette-response-[A-Za-z0-9._:-]{1,200}$/;
const CASSETTE_TOOL_CALL_ID_PATTERN = /^cassette-tool-call-[A-Za-z0-9._:-]{1,200}$/;
const HOST_PATH_PATTERN = /(?:^|["'\s])(?:\/[Uu]sers\/|\/home\/|[A-Za-z]:\\Users\\)/u;
const REPLAY_RETRY_ALGORITHM_V1 = 'kite.model-gateway-retry.exponential-bounded.v1';
const OUTCOME_DIGEST_DOMAIN_V1 = 'kite.model-attempt-outcome.v1';
const ENVELOPE_REPLAY_DIGEST_DOMAIN_V1 = 'kite.model-envelope-replay.v1';
const secretDetector = createRuntimeSecretDetectorV1({
  environment: {},
  maxInspectionChars: 16 * 1024 * 1024,
});

export type ModelReplayErrorCodeV1 =
  | 'MODEL_REPLAY_MISS'
  | 'MODEL_REPLAY_CORRUPT'
  | 'MODEL_REPLAY_ROUTE_MISMATCH';

export class ModelReplayErrorV1 extends Error {
  readonly code: ModelReplayErrorCodeV1;
  readonly dispatchCertainty = 'none' as const;

  constructor(code: ModelReplayErrorCodeV1) {
    super(code);
    this.name = 'ModelReplayErrorV1';
    this.code = code;
  }
}

export function computeModelAttemptOutcomeDigestV1(outcome: ModelAttemptOutcomeV1): Sha256DigestV1 {
  assertModelAttemptOutcomeV1(outcome, false);
  return computePrivateModelEvidenceDigestV1(OUTCOME_DIGEST_DOMAIN_V1, outcome);
}

export function computeModelEnvelopeReplayDigestV1(
  envelope: ModelInvocationEnvelopeV1,
  purpose: ModelInvocationPurposeV1,
): Sha256DigestV1 {
  return computePrivateModelEvidenceDigestV1(ENVELOPE_REPLAY_DIGEST_DOMAIN_V1, {
    purpose,
    routeIdentityDigest: envelope.admission.routeIdentityDigest,
    providerDataPolicyRevision: envelope.admission.providerDataPolicyRevision,
    payloadClassificationDigest: envelope.admission.payloadClassificationDigest,
    admitted: envelope.admission.admitted,
    promptContractVersion: envelope.provenance.promptContractVersion,
    projectionEnvironmentDigest: envelope.provenance.projectionEnvironmentDigest,
    capabilityBindingDigest: envelope.provenance.capabilityBindingDigest,
    retryAlgorithm: REPLAY_RETRY_ALGORITHM_V1,
    limits: envelope.resource.limits,
  });
}

export function createModelInvocationContextV1(input: {
  envelope: ModelInvocationEnvelopeV1;
  purpose: ModelInvocationPurposeV1;
  route: ModelInvocationContextV1['route'];
  surfaceDigest: Sha256DigestV1;
  replayBinding: ModelInvocationContextV1['replayBinding'];
}): ModelInvocationContextV1 {
  const context: ModelInvocationContextV1 = {
    schema: MODEL_INVOCATION_CONTEXT_SCHEMA_V1,
    purpose: input.purpose,
    route: input.route,
    surfaceDigest: input.surfaceDigest,
    envelopeReplayDigest: computeModelEnvelopeReplayDigestV1(input.envelope, input.purpose),
    replayBinding: input.replayBinding,
  };
  try {
    assertModelInvocationContextV1(context);
  } catch (error) {
    if (input.replayBinding) throw new ModelReplayErrorV1('MODEL_REPLAY_CORRUPT');
    throw error;
  }
  return deepFreeze(structuredClone(context));
}

export function createModelReplayAttemptRecordV1(input: {
  context: ModelInvocationContextV1;
  attemptOrdinal: number;
  outcome: ModelAttemptOutcomeV1;
}): ModelReplayAttemptRecordV1 {
  const binding = input.context.replayBinding;
  if (!binding) throw new ModelReplayErrorV1('MODEL_REPLAY_MISS');
  const record: ModelReplayAttemptRecordV1 = {
    actor: binding.actor,
    purpose: input.context.purpose,
    logicalInvocationOrdinal: binding.logicalInvocationOrdinal,
    attemptOrdinal: input.attemptOrdinal,
    routeFingerprint: input.context.route.routeFingerprint,
    adapterProtocolVersion: input.context.route.adapterProtocolVersion,
    replayOwner: input.context.route.replayOwner,
    surfaceDigest: input.context.surfaceDigest,
    replayDigest: binding.replayDigest,
    envelopeReplayDigest: input.context.envelopeReplayDigest,
    outcome: input.outcome,
    outcomeDigest: computeModelAttemptOutcomeDigestV1(input.outcome),
  };
  assertReplayAttemptRecord(record, true);
  return deepFreeze(structuredClone(record));
}

/** Parse only canonical, UTF-8, privacy-screened and exact-key replay catalogs. */
export function parseModelReplayCatalogV1(input: string | Uint8Array): ModelReplayCatalogV1 {
  try {
    const text = typeof input === 'string' ? input : UTF8_DECODER.decode(input);
    const value = JSON.parse(text) as unknown;
    if (canonicalModelJsonV1(value) !== text) throw new Error('non-canonical catalog');
    if (
      secretDetector({ text, provenance: 'model_visible_answer' }).verdict !== 'clear' ||
      HOST_PATH_PATTERN.test(text)
    ) {
      throw new Error('catalog privacy rejection');
    }
    assertReplayCatalog(value);
    return deepFreeze(value as ModelReplayCatalogV1);
  } catch {
    throw new ModelReplayErrorV1('MODEL_REPLAY_CORRUPT');
  }
}

/** Actor-local, exactly-once catalog cursor. It owns no retry or Provider transport. */
export class StrictModelReplayCatalogV1 {
  readonly #catalog: ModelReplayCatalogV1;
  readonly #records = new Map<string, ModelReplayAttemptRecordV1>();
  readonly #consumed = new Set<string>();

  constructor(catalog: ModelReplayCatalogV1) {
    this.#catalog = parseModelReplayCatalogV1(canonicalModelJsonV1(catalog));
    for (const record of this.#catalog.records) {
      this.#records.set(recordCoordinate(record), record);
    }
  }

  static parse(input: string | Uint8Array): StrictModelReplayCatalogV1 {
    return new StrictModelReplayCatalogV1(parseModelReplayCatalogV1(input));
  }

  lookup(context: ModelInvocationContextV1, attemptOrdinal: number): ModelAttemptOutcomeV1 {
    try {
      assertModelInvocationContextV1(context);
    } catch {
      throw new ModelReplayErrorV1('MODEL_REPLAY_CORRUPT');
    }
    const binding = context.replayBinding;
    if (!binding || !positiveInteger(attemptOrdinal)) {
      throw new ModelReplayErrorV1('MODEL_REPLAY_MISS');
    }
    if (
      binding.suiteId !== this.#catalog.suite.suiteId ||
      binding.suiteRevision !== this.#catalog.suite.suiteRevision ||
      binding.fixtureDigest !== this.#catalog.suite.fixtureDigest
    ) {
      throw new ModelReplayErrorV1('MODEL_REPLAY_MISS');
    }
    const coordinate = invocationCoordinate(
      binding.actor,
      context.purpose,
      binding.logicalInvocationOrdinal,
      attemptOrdinal,
    );
    const record = this.#records.get(coordinate);
    if (!record || this.#consumed.has(coordinate)) {
      throw new ModelReplayErrorV1('MODEL_REPLAY_MISS');
    }
    if (
      record.routeFingerprint !== context.route.routeFingerprint ||
      record.adapterProtocolVersion !== context.route.adapterProtocolVersion ||
      canonicalModelJsonV1(record.replayOwner) !== canonicalModelJsonV1(context.route.replayOwner)
    ) {
      throw new ModelReplayErrorV1('MODEL_REPLAY_ROUTE_MISMATCH');
    }
    const semanticDigestMatches =
      record.replayDigest === null
        ? binding.replayDigest === null && record.surfaceDigest === context.surfaceDigest
        : record.replayDigest === binding.replayDigest;
    if (!semanticDigestMatches || record.envelopeReplayDigest !== context.envelopeReplayDigest) {
      throw new ModelReplayErrorV1('MODEL_REPLAY_MISS');
    }
    if (computeModelAttemptOutcomeDigestV1(record.outcome) !== record.outcomeDigest) {
      throw new ModelReplayErrorV1('MODEL_REPLAY_CORRUPT');
    }
    this.#consumed.add(coordinate);
    return record.outcome;
  }

  assertConsumed(): void {
    if (this.#consumed.size !== this.#records.size) {
      throw new ModelReplayErrorV1('MODEL_REPLAY_MISS');
    }
  }
}

function assertReplayCatalog(value: unknown): asserts value is ModelReplayCatalogV1 {
  exactKeys(value, ['schema', 'catalogRevision', 'suite', 'records']);
  const catalog = value as Record<string, unknown>;
  exactKeys(catalog.schema, ['name', 'canonicalizerVersion', 'version']);
  const schema = catalog.schema as Record<string, unknown>;
  if (
    schema.name !== MODEL_REPLAY_CATALOG_SCHEMA_V1.name ||
    schema.canonicalizerVersion !== MODEL_REPLAY_CATALOG_SCHEMA_V1.canonicalizerVersion ||
    schema.version !== MODEL_REPLAY_CATALOG_SCHEMA_V1.version
  ) {
    throw new Error('unsupported catalog schema');
  }
  safeIdentifier(catalog.catalogRevision);
  exactKeys(catalog.suite, ['suiteId', 'suiteRevision', 'fixtureDigest']);
  const suite = catalog.suite as Record<string, unknown>;
  safeIdentifier(suite.suiteId);
  if (!positiveInteger(suite.suiteRevision)) throw new Error('invalid suite revision');
  digest(suite.fixtureDigest);
  if (!Array.isArray(catalog.records) || catalog.records.length === 0) {
    throw new Error('catalog requires records');
  }
  const coordinates = new Set<string>();
  for (const record of catalog.records) {
    assertReplayAttemptRecord(record, true);
    const coordinate = recordCoordinate(record);
    if (coordinates.has(coordinate)) throw new Error('duplicate replay coordinate');
    coordinates.add(coordinate);
  }
}

function assertReplayAttemptRecord(
  value: unknown,
  replaySafe: boolean,
): asserts value is ModelReplayAttemptRecordV1 {
  exactKeys(value, [
    'actor',
    'purpose',
    'logicalInvocationOrdinal',
    'attemptOrdinal',
    'routeFingerprint',
    'adapterProtocolVersion',
    'replayOwner',
    'surfaceDigest',
    'replayDigest',
    'envelopeReplayDigest',
    'outcome',
    'outcomeDigest',
  ]);
  const record = value as Record<string, unknown>;
  assertActor(record.actor);
  if (!MODEL_INVOCATION_PURPOSES_V1.includes(record.purpose as ModelInvocationPurposeV1)) {
    throw new Error('invalid purpose');
  }
  if (
    !positiveInteger(record.logicalInvocationOrdinal) ||
    !positiveInteger(record.attemptOrdinal)
  ) {
    throw new Error('invalid ordinal');
  }
  digest(record.routeFingerprint);
  safeIdentifier(record.adapterProtocolVersion);
  assertModelAdapterReplayOwnerV1(record.replayOwner);
  digest(record.surfaceDigest);
  if (record.replayDigest !== null) {
    digest(record.replayDigest);
    if (replaySafe) throw new Error('replay digest requires a later approved manifest');
  }
  digest(record.envelopeReplayDigest);
  assertModelAttemptOutcomeV1(record.outcome, replaySafe);
  digest(record.outcomeDigest);
  if (
    computeModelAttemptOutcomeDigestV1(record.outcome as ModelAttemptOutcomeV1) !==
    record.outcomeDigest
  ) {
    throw new Error('outcome digest mismatch');
  }
}

function assertModelInvocationContextV1(value: unknown): asserts value is ModelInvocationContextV1 {
  exactKeys(value, [
    'schema',
    'purpose',
    'route',
    'surfaceDigest',
    'envelopeReplayDigest',
    'replayBinding',
  ]);
  const context = value as Record<string, unknown>;
  exactKeys(context.schema, ['name', 'version']);
  const schema = context.schema as Record<string, unknown>;
  if (
    schema.name !== MODEL_INVOCATION_CONTEXT_SCHEMA_V1.name ||
    schema.version !== MODEL_INVOCATION_CONTEXT_SCHEMA_V1.version
  ) {
    throw new Error('unsupported invocation context schema');
  }
  if (!MODEL_INVOCATION_PURPOSES_V1.includes(context.purpose as ModelInvocationPurposeV1)) {
    throw new Error('invalid purpose');
  }
  assertModelRouteIdentityV1(context.route);
  digest(context.surfaceDigest);
  digest(context.envelopeReplayDigest);
  if (context.replayBinding !== null) assertReplayBinding(context.replayBinding);
}

function assertReplayBinding(value: unknown): void {
  exactKeys(value, [
    'suiteId',
    'suiteRevision',
    'fixtureDigest',
    'actor',
    'logicalInvocationOrdinal',
    'replayDigest',
  ]);
  const binding = value as Record<string, unknown>;
  safeIdentifier(binding.suiteId);
  if (
    !positiveInteger(binding.suiteRevision) ||
    !positiveInteger(binding.logicalInvocationOrdinal)
  ) {
    throw new Error('invalid replay binding ordinal');
  }
  digest(binding.fixtureDigest);
  assertActor(binding.actor);
  if (binding.replayDigest !== null) {
    digest(binding.replayDigest);
    throw new Error('replay digest requires a later approved manifest');
  }
}

function assertActor(value: unknown): asserts value is ModelReplayActorIdentityV1 {
  if (!isObject(value)) throw new Error('invalid actor');
  if (value.kind === 'parent') {
    exactKeys(value, ['kind']);
    return;
  }
  exactKeys(value, ['kind', 'parentToolCallId', 'subagentId', 'continuationId']);
  if (value.kind !== 'subagent') throw new Error('invalid actor kind');
  safeIdentifier(value.parentToolCallId);
  safeIdentifier(value.subagentId);
  if (value.continuationId !== null) safeIdentifier(value.continuationId);
}

function assertModelAttemptOutcomeV1(value: unknown, replaySafe: boolean): void {
  if (!isObject(value)) throw new Error('invalid outcome');
  const common = ['schema', 'kind'];
  exactKeys(value.schema, ['name', 'canonicalizerVersion', 'version']);
  const schema = value.schema as Record<string, unknown>;
  if (
    schema.name !== MODEL_ATTEMPT_OUTCOME_SCHEMA_V1.name ||
    schema.canonicalizerVersion !== MODEL_ATTEMPT_OUTCOME_SCHEMA_V1.canonicalizerVersion ||
    schema.version !== MODEL_ATTEMPT_OUTCOME_SCHEMA_V1.version
  ) {
    throw new Error('unsupported outcome schema');
  }
  if (value.kind === 'success') {
    exactKeys(value, [...common, 'response', 'nativeReplayState']);
    assertSuccessResponse(value.response, replaySafe);
    if (replaySafe && value.nativeReplayState !== null) {
      throw new Error('native replay state requires a future approved codec');
    }
    if (value.nativeReplayState !== null) {
      exactKeys(value.nativeReplayState, ['owner', 'value']);
      const nativeReplayState = value.nativeReplayState as Record<string, unknown>;
      assertModelAdapterReplayOwnerV1(nativeReplayState.owner);
      canonicalModelJsonV1(nativeReplayState.value);
    }
    return;
  }
  if (value.kind === 'retryable_failure') {
    exactKeys(value, [...common, 'classification', 'retryObservation']);
    if (
      ![
        'attempt_timeout',
        'connection_failure',
        'provider_rate_limited',
        'provider_unavailable',
      ].includes(value.classification as string)
    ) {
      throw new Error('invalid retryable classification');
    }
    exactKeys(value.retryObservation, ['providerStatusCode', 'timedOut']);
    const observation = value.retryObservation as Record<string, unknown>;
    statusCodeOrNull(observation.providerStatusCode);
    if (typeof observation.timedOut !== 'boolean') throw new Error('invalid timeout observation');
    return;
  }
  if (value.kind === 'fatal_failure') {
    exactKeys(value, [...common, 'classification', 'providerStatusCode']);
    if (!['provider_rejected', 'provider_failure'].includes(value.classification as string)) {
      throw new Error('invalid fatal classification');
    }
    statusCodeOrNull(value.providerStatusCode);
    return;
  }
  if (value.kind === 'aborted') {
    exactKeys(value, [...common, 'classification']);
    if (!['cancelled', 'transport_aborted'].includes(value.classification as string)) {
      throw new Error('invalid abort classification');
    }
    return;
  }
  throw new Error('invalid outcome kind');
}

function assertSuccessResponse(value: unknown, replaySafe: boolean): void {
  exactKeys(value, ['message', 'finishReason', 'usage', 'providerMetadata']);
  const response = value as Record<string, unknown>;
  assertCanonicalModelMessageV1(response.message);
  const message = response.message as CanonicalModelMessageV1;
  if (message.role !== 'assistant') throw new Error('response must be assistant');
  if (replaySafe) {
    for (const part of message.content) {
      if (
        part.type === 'tool_call' &&
        !CASSETTE_TOOL_CALL_ID_PATTERN.test(String(part.toolCallId))
      ) {
        throw new Error('tool call identity is not cassette-local');
      }
    }
  }
  if (
    !['stop', 'length', 'content_filter', 'tool_calls', 'error', 'other', 'unknown'].includes(
      response.finishReason as string,
    )
  ) {
    throw new Error('invalid finish reason');
  }
  exactKeys(response.usage, ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens']);
  for (const count of Object.values(response.usage as Record<string, unknown>)) {
    if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0)) {
      throw new Error('invalid usage');
    }
  }
  if (!isObject(response.providerMetadata)) throw new Error('invalid provider metadata');
  canonicalModelJsonV1(response.providerMetadata);
  if (replaySafe) {
    exactKeys(response.providerMetadata, ['responseId', 'rawFinishReason']);
    const metadata = response.providerMetadata as Record<string, unknown>;
    if (
      metadata.responseId !== null &&
      (typeof metadata.responseId !== 'string' ||
        !CASSETTE_RESPONSE_ID_PATTERN.test(metadata.responseId))
    ) {
      throw new Error('response identity is not cassette-local');
    }
    if (metadata.rawFinishReason !== null) throw new Error('raw finish reason is forbidden');
  }
}

function recordCoordinate(record: ModelReplayAttemptRecordV1): string {
  return invocationCoordinate(
    record.actor,
    record.purpose,
    record.logicalInvocationOrdinal,
    record.attemptOrdinal,
  );
}

function invocationCoordinate(
  actor: ModelReplayActorIdentityV1,
  purpose: ModelInvocationPurposeV1,
  logicalInvocationOrdinal: number,
  attemptOrdinal: number,
): string {
  return canonicalModelJsonV1({ actor, purpose, logicalInvocationOrdinal, attemptOrdinal });
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (!isObject(value)) throw new Error('expected object');
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new Error('unexpected object fields');
  }
}

function safeIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error('invalid identifier');
  }
}

function digest(value: unknown): asserts value is Sha256DigestV1 {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error('invalid digest');
}

function statusCodeOrNull(value: unknown): void {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 599)
  ) {
    throw new Error('invalid provider status');
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
