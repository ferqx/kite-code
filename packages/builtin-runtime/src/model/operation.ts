import type {
  ModelAttemptOutcomeV1,
  ModelInvocationPurposeV1,
  RuntimeJsonValueV1,
  Sha256DigestV1,
} from '@kite/runtime-spi';

export const BUILTIN_MODEL_OPERATION_IDS_V1 = Object.freeze([
  'model:primary',
  'model:compaction',
  'model:auto_review',
  'model:verification_review',
  'model:subagent',
] as const);

export type BuiltinModelOperationIdV1 = (typeof BUILTIN_MODEL_OPERATION_IDS_V1)[number];

export const BUILTIN_MODEL_OPERATION_BY_PURPOSE_V1 = Object.freeze({
  primary_agent: 'model:primary',
  context_compaction: 'model:compaction',
  auto_review: 'model:auto_review',
  verification_review: 'model:verification_review',
  subagent: 'model:subagent',
} as const satisfies Readonly<Record<ModelInvocationPurposeV1, BuiltinModelOperationIdV1>>);

export interface BuiltinModelOperationAttemptV1 {
  readonly operationId: BuiltinModelOperationIdV1;
  readonly purpose: ModelInvocationPurposeV1;
  readonly invocationId: string;
  readonly attemptOrdinal: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly stateRevision: number;
  readonly surfaceDigest: Sha256DigestV1;
  readonly input: Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly signal: AbortSignal;
  /** The selected App/Host mechanism for exactly one already-acknowledged attempt. */
  attempt(): Promise<ModelAttemptOutcomeV1>;
}

/**
 * App-composed port that re-enters the Host capability registry before any
 * live Model response source is called. Builtin owns the
 * purpose-to-operation mapping; the port owns no Model semantics.
 */
export interface BuiltinModelOperationExecutionPortV1 {
  execute(input: BuiltinModelOperationAttemptV1): Promise<ModelAttemptOutcomeV1>;
}
