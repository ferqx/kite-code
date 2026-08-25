import type {
  ModelAttemptOutcome,
  ModelInvocationPurpose,
  RuntimeJsonValue,
  Sha256Digest,
} from '@kite-ai/runtime-spi';

export const BUILTIN_MODEL_OPERATION_IDS_ = Object.freeze([
  'model:primary',
  'model:compaction',
  'model:auto_review',
  'model:subagent',
] as const);

export type BuiltinModelOperationId = (typeof BUILTIN_MODEL_OPERATION_IDS_)[number];

export const BUILTIN_MODEL_OPERATION_BY_PURPOSE_ = Object.freeze({
  primary_agent: 'model:primary',
  context_compaction: 'model:compaction',
  auto_review: 'model:auto_review',
  subagent: 'model:subagent',
} as const satisfies Readonly<Record<ModelInvocationPurpose, BuiltinModelOperationId>>);

export interface BuiltinModelOperationAttempt {
  readonly operationId: BuiltinModelOperationId;
  readonly purpose: ModelInvocationPurpose;
  readonly invocationId: string;
  readonly attemptOrdinal: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly stateRevision: number;
  readonly surfaceDigest: Sha256Digest;
  readonly input: Readonly<Record<string, RuntimeJsonValue>>;
  readonly signal: AbortSignal;
  /** The selected App/Host mechanism for exactly one already-acknowledged attempt. */
  attempt(): Promise<ModelAttemptOutcome>;
}

/**
 * App-composed port that re-enters the Host capability registry before any
 * live Model response source is called. Builtin owns the
 * purpose-to-operation mapping; the port owns no Model semantics.
 */
export interface BuiltinModelOperationExecutionPort {
  execute(input: BuiltinModelOperationAttempt): Promise<ModelAttemptOutcome>;
}
