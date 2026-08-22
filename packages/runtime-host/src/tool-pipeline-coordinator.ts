import type {
  CapabilityToolTerminalResultV1,
  PreparedToolInvocationIdentityV1,
  PreparedToolInvocationInputV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineAttemptAcknowledgementV1,
  ToolPipelineDispatchOutcomeV1,
  ToolPipelineOutcomeDispatchV1,
  ToolPipelinePersistenceV1,
  ToolPipelineSuspensionV1,
} from '@kite/runtime-spi';

/**
 * This is the Host's attempt/ack/dispatch seam. Resolution, validation,
 * classification, policy, and domain result projection remain outside this
 * file. The injected persistence callbacks own the durable receipt boundary;
 * Host owns their ordering and the post-ack uncertainty transition.
 */
export const RUNTIME_HOST_TOOL_PIPELINE_ATTEMPT_COORDINATOR_SCHEMA_V1 =
  'kite.runtime-host.tool-pipeline-attempt-coordinator.v1' as const;

export type RuntimeHostToolPipelineAttemptCoordinatorFailureCodeV1 =
  | 'invalid_prepared_input'
  | 'identity_mismatch'
  | 'duplicate_attempt'
  | 'persistence_unavailable'
  | 'acknowledgement_failed'
  | 'verification_failed'
  | 'unknown_persistence_failed'
  | 'committed_authority_invalid'
  | 'suspended_authority_invalid'
  | 'retryable_authority_invalid'
  | 'unknown_outcome';

/**
 * Public errors intentionally use bounded, owner-neutral messages. Verifier,
 * provider, and result diagnostics never cross this error boundary.
 */
export class RuntimeHostToolPipelineAttemptCoordinatorErrorV1 extends Error {
  readonly code: RuntimeHostToolPipelineAttemptCoordinatorFailureCodeV1;

  constructor(code: RuntimeHostToolPipelineAttemptCoordinatorFailureCodeV1) {
    super(runtimeHostToolPipelineAttemptCoordinatorMessageV1(code));
    this.name = 'RuntimeHostToolPipelineAttemptCoordinatorErrorV1';
    this.code = code;
  }
}

export type RuntimeHostPreparedToolInvocationAuthorityV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = Readonly<PreparedToolInvocationV1<TArguments, TRequest>>;

/** Process-local proof that this coordinator durably committed the result. */
export interface RuntimeHostCommittedToolInvocationAuthorityV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly result: Readonly<CapabilityToolTerminalResultV1<TValue>>;
}

/** Process-local proof that this coordinator durably committed a non-terminal suspension. */
export interface RuntimeHostSuspendedToolInvocationAuthorityV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly suspension: Readonly<ToolPipelineSuspensionV1>;
  readonly result: Readonly<
    Extract<ToolPipelineDispatchOutcomeV1<TValue>, { readonly kind: 'suspended' }>['result']
  >;
}

/** Process-local proof that Kernel/App durably admitted one safe-read retry. */
export interface RuntimeHostRetryableToolInvocationAuthorityV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
  readonly replaySafety: 'safe_read';
  readonly result: Readonly<CapabilityToolTerminalResultV1<TValue>>;
}

export type RuntimeHostToolInvocationOutcomeAuthorityV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> =
  | ({ readonly kind: 'committed' } & RuntimeHostCommittedToolInvocationAuthorityV1<TValue>)
  | ({ readonly kind: 'suspended' } & RuntimeHostSuspendedToolInvocationAuthorityV1<TValue>)
  | ({ readonly kind: 'retryable' } & RuntimeHostRetryableToolInvocationAuthorityV1<TValue>);

export interface RuntimeHostToolPipelineAttemptCoordinatorOptionsV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly persistence: ToolPipelinePersistenceV1<TValue>;
  readonly dispatch: ToolPipelineOutcomeDispatchV1<TArguments, TValue>;
}

/**
 * The coordinator owns process-local prepared authenticity, exact-once claim,
 * acknowledgement ordering, and post-ack uncertainty. It does not own a
 * Store, registry, executor, or Builtin/domain receipt semantics.
 */
export interface RuntimeHostToolPipelineAttemptCoordinatorV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly prepare: <
    TPreparedArguments extends TArguments = TArguments,
    TPreparedRequest extends TRequest = TRequest,
  >(
    identity: Readonly<PreparedToolInvocationIdentityV1>,
    input: Readonly<PreparedToolInvocationInputV1<TPreparedArguments, TPreparedRequest>>,
  ) => RuntimeHostPreparedToolInvocationAuthorityV1<TPreparedArguments, TPreparedRequest>;
  readonly execute: <
    TPreparedArguments extends TArguments = TArguments,
    TPreparedRequest extends TRequest = TRequest,
  >(
    prepared: Readonly<PreparedToolInvocationV1<TPreparedArguments, TPreparedRequest>>,
  ) => Promise<Readonly<RuntimeHostToolInvocationOutcomeAuthorityV1<TValue>>>;
  readonly assertCommitted: (
    value: unknown,
  ) => asserts value is Readonly<RuntimeHostCommittedToolInvocationAuthorityV1<TValue>>;
  readonly assertSuspended: (
    value: unknown,
  ) => asserts value is Readonly<RuntimeHostSuspendedToolInvocationAuthorityV1<TValue>>;
  readonly assertRetryable: (
    value: unknown,
  ) => asserts value is Readonly<RuntimeHostRetryableToolInvocationAuthorityV1<TValue>>;
}

export function createRuntimeHostToolPipelineAttemptCoordinatorV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
>(
  options: RuntimeHostToolPipelineAttemptCoordinatorOptionsV1<TArguments, TValue>,
): RuntimeHostToolPipelineAttemptCoordinatorV1<TArguments, TRequest, TValue> {
  const { persistence, dispatch } = options;

  const authenticPrepared = new WeakSet<object>();
  const authenticCommitted = new WeakSet<object>();
  const authenticSuspended = new WeakSet<object>();
  const authenticRetryable = new WeakSet<object>();
  const claimedPrepared = new WeakSet<object>();
  const claimedAttemptKeys = new Set<string>();

  function prepare<TPreparedArguments extends TArguments, TPreparedRequest extends TRequest>(
    identity: Readonly<PreparedToolInvocationIdentityV1>,
    input: Readonly<PreparedToolInvocationInputV1<TPreparedArguments, TPreparedRequest>>,
  ): RuntimeHostPreparedToolInvocationAuthorityV1<TPreparedArguments, TPreparedRequest> {
    try {
      if (!isRecordObjectV1(identity) || !isRecordObjectV1(input)) {
        throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('invalid_prepared_input');
      }

      const candidate = {
        identity,
        input,
      } as Readonly<PreparedToolInvocationV1<TPreparedArguments, TPreparedRequest>>;

      deepFreezeV1(candidate.identity);
      deepFreezeV1(candidate.input);
      deepFreezeV1(candidate);

      const authority = candidate as RuntimeHostPreparedToolInvocationAuthorityV1<
        TPreparedArguments,
        TPreparedRequest
      >;
      authenticPrepared.add(authority);
      return authority;
    } catch (error) {
      if (error instanceof RuntimeHostToolPipelineAttemptCoordinatorErrorV1) throw error;
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('invalid_prepared_input');
    }
  }

  async function execute<TPreparedArguments extends TArguments, TPreparedRequest extends TRequest>(
    prepared: Readonly<PreparedToolInvocationV1<TPreparedArguments, TPreparedRequest>>,
  ): Promise<Readonly<RuntimeHostToolInvocationOutcomeAuthorityV1<TValue>>> {
    assertAuthenticPreparedV1(prepared, authenticPrepared);

    try {
      assertPreparedShapeV1(prepared);
      assertPreparedIdentityWithInputV1(prepared);
    } catch (error) {
      if (error instanceof RuntimeHostToolPipelineAttemptCoordinatorErrorV1) throw error;
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('invalid_prepared_input');
    }

    const claimKey = JSON.stringify([
      prepared.identity.invocationId,
      prepared.identity.attemptId,
      prepared.identity.turnId,
      prepared.identity.modelMessageId,
    ]);
    if (claimedPrepared.has(prepared) || claimedAttemptKeys.has(claimKey)) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('duplicate_attempt');
    }

    let verification: unknown;
    try {
      verification = dispatch.verifyPreparedIdentity(prepared);
    } catch {
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('verification_failed');
    }
    if (!isVerificationAcceptedV1(verification)) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('verification_failed');
    }

    // Claim before the first await. No persistence or dispatch failure may
    // clear either mark: this Host process never replays the attempt.
    claimedPrepared.add(prepared);
    claimedAttemptKeys.add(claimKey);

    let acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>;
    try {
      acknowledgement = await persistence.recordAttempt(prepared);
    } catch {
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('persistence_unavailable');
    }

    if (!isAcknowledgementForPreparedV1(acknowledgement, prepared.identity)) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('acknowledgement_failed');
    }

    let outcome: Readonly<ToolPipelineDispatchOutcomeV1<TValue>>;
    try {
      outcome = await dispatch.dispatch(prepared);
    } catch {
      await recordUnknownOrThrowV1(persistence, acknowledgement, 'dispatch_failed');
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('unknown_outcome');
    }

    let dispatchOutcomeValid = false;
    try {
      dispatchOutcomeValid = isValidDispatchOutcomeV1(outcome, acknowledgement);
    } catch {
      dispatchOutcomeValid = false;
    }
    if (!dispatchOutcomeValid) {
      await recordUnknownOrThrowV1(persistence, acknowledgement, 'dispatch_result_invalid');
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('unknown_outcome');
    }

    if (outcome.kind === 'retryable') {
      try {
        if (!persistence.commitRetryable) {
          throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('persistence_unavailable');
        }
        deepFreezeV1(outcome.result);
        await persistence.commitRetryable({
          acknowledgement,
          replaySafety: outcome.replaySafety,
          result: outcome.result,
        });
      } catch {
        await recordUnknownOrThrowV1(persistence, acknowledgement, 'retryable_commit_failed');
        throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('unknown_outcome');
      }
      const retryable = deepFreezeV1({
        kind: 'retryable' as const,
        acknowledgement,
        replaySafety: outcome.replaySafety,
        result: outcome.result,
      });
      authenticRetryable.add(retryable);
      return retryable;
    }

    if (outcome.kind === 'suspended') {
      try {
        deepFreezeV1(outcome.suspension);
        deepFreezeV1(outcome.result);
        await persistence.commitSuspension({
          acknowledgement,
          suspension: outcome.suspension,
          result: outcome.result,
        });
      } catch {
        await recordUnknownOrThrowV1(persistence, acknowledgement, 'suspension_commit_failed');
        throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('unknown_outcome');
      }
      const suspended = deepFreezeV1({
        kind: 'suspended' as const,
        acknowledgement,
        suspension: outcome.suspension,
        result: outcome.result,
      });
      authenticSuspended.add(suspended);
      return suspended;
    }

    const result = outcome.terminal;
    try {
      deepFreezeV1(result);
      await persistence.commitTerminal({ acknowledgement, result });
    } catch {
      await recordUnknownOrThrowV1(persistence, acknowledgement, 'terminal_commit_failed');
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('unknown_outcome');
    }

    const committed = deepFreezeV1({ kind: 'committed' as const, acknowledgement, result });
    authenticCommitted.add(committed);
    return committed;
  }

  function assertSuspended(
    value: unknown,
  ): asserts value is Readonly<RuntimeHostSuspendedToolInvocationAuthorityV1<TValue>> {
    if (
      !isRecordObjectV1(value) ||
      value.kind !== 'suspended' ||
      !authenticSuspended.has(value) ||
      !isDeepFrozenV1(value) ||
      !isDeepFrozenV1(value.acknowledgement) ||
      !isDeepFrozenV1(value.suspension) ||
      !isDeepFrozenV1(value.result)
    ) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('suspended_authority_invalid');
    }
  }

  function assertCommitted(
    value: unknown,
  ): asserts value is Readonly<RuntimeHostCommittedToolInvocationAuthorityV1<TValue>> {
    if (
      !isRecordObjectV1(value) ||
      !authenticCommitted.has(value) ||
      !isDeepFrozenV1(value) ||
      !isDeepFrozenV1(value.acknowledgement) ||
      !isDeepFrozenV1(value.result)
    ) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('retryable_authority_invalid');
    }
  }

  function assertRetryable(
    value: unknown,
  ): asserts value is Readonly<RuntimeHostRetryableToolInvocationAuthorityV1<TValue>> {
    if (
      !isRecordObjectV1(value) ||
      value.kind !== 'retryable' ||
      !authenticRetryable.has(value) ||
      !isDeepFrozenV1(value) ||
      !isDeepFrozenV1(value.acknowledgement) ||
      !isDeepFrozenV1(value.result) ||
      value.replaySafety !== 'safe_read'
    ) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('committed_authority_invalid');
    }
  }

  const coordinator: RuntimeHostToolPipelineAttemptCoordinatorV1<TArguments, TRequest, TValue> = {
    prepare,
    execute,
    assertCommitted,
    assertSuspended,
    assertRetryable,
  };
  return Object.freeze(coordinator);
}

async function recordUnknownOrThrowV1<TValue extends RuntimeJsonValueV1>(
  persistence: ToolPipelinePersistenceV1<TValue>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
  code:
    | 'dispatch_failed'
    | 'dispatch_result_invalid'
    | 'retryable_commit_failed'
    | 'terminal_commit_failed'
    | 'suspension_commit_failed',
): Promise<void> {
  try {
    await persistence.recordUnknown({ acknowledgement, code });
  } catch {
    // The attempt was already claimed and an external effect may have
    // happened. A failed unknown write must remain a distinct bounded Host
    // failure; it must never be converted into success or a replayable retry.
    throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('unknown_persistence_failed');
  }
}

function runtimeHostToolPipelineAttemptCoordinatorMessageV1(
  code: RuntimeHostToolPipelineAttemptCoordinatorFailureCodeV1,
): string {
  switch (code) {
    case 'invalid_prepared_input':
      return 'Runtime Host prepared tool input is invalid.';
    case 'identity_mismatch':
      return 'Runtime Host tool attempt identity does not match the prepared authority.';
    case 'duplicate_attempt':
      return 'Runtime Host tool attempt has already been claimed.';
    case 'persistence_unavailable':
      return 'Runtime Host tool attempt acknowledgement was not persisted.';
    case 'acknowledgement_failed':
      return 'Runtime Host tool attempt acknowledgement is invalid.';
    case 'verification_failed':
      return 'Runtime Host prepared tool identity verification failed.';
    case 'unknown_persistence_failed':
      return 'Runtime Host could not durably record the acknowledged unknown outcome.';
    case 'committed_authority_invalid':
      return 'Runtime Host committed tool authority is invalid.';
    case 'suspended_authority_invalid':
      return 'Runtime Host suspended tool authority is invalid.';
    case 'retryable_authority_invalid':
      return 'Runtime Host retryable tool authority is invalid.';
    case 'unknown_outcome':
      return 'Runtime Host tool dispatch outcome is unknown; the attempt is not replayable.';
  }
}

function isRecordObjectV1(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedIdentityStringV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function deepFreezeV1<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) throw new TypeError('Prepared DTO accessors are not supported.');
    deepFreezeV1(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function isDeepFrozenV1(value: unknown, seen = new WeakSet<object>()): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return true;
  const object = value as object;
  if (seen.has(object)) return true;
  if (!Object.isFrozen(object)) return false;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor) || !isDeepFrozenV1(descriptor.value, seen)) {
      return false;
    }
  }
  return true;
}

function isJsonValueV1(
  value: unknown,
  active = new WeakSet<object>(),
): value is RuntimeJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;

  if (active.has(value)) return false;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      const lengthDescriptor = ownDataDescriptorV1(value, 'length');
      const length = lengthDescriptor?.value;
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        ownKeys.length !== length + 1
      ) {
        return false;
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownDataDescriptorV1(value, String(index));
        if (!descriptor || !isJsonValueV1(descriptor.value, active)) {
          return false;
        }
      }
      if (
        ownKeys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)),
        )
      ) {
        return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !isJsonValueV1(descriptor.value, active)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    active.delete(value);
  }
}

function assertAuthenticPreparedV1<
  TArguments extends RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1,
>(
  prepared: unknown,
  authenticPrepared: WeakSet<object>,
): asserts prepared is Readonly<PreparedToolInvocationV1<TArguments, TRequest>> {
  if (!isRecordObjectV1(prepared) || !authenticPrepared.has(prepared)) {
    throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('invalid_prepared_input');
  }
}

function assertPreparedShapeV1<
  TArguments extends RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1,
>(prepared: Readonly<PreparedToolInvocationV1<TArguments, TRequest>>): void {
  if (
    !isDeepFrozenV1(prepared) ||
    !isRecordObjectV1(prepared.identity) ||
    !isRecordObjectV1(prepared.input) ||
    !isDeepFrozenV1(prepared.identity) ||
    !isDeepFrozenV1(prepared.input) ||
    !isDeepFrozenV1(prepared.input.arguments) ||
    !isJsonValueV1(prepared.input.arguments) ||
    (prepared.input.request !== undefined &&
      (!isDeepFrozenV1(prepared.input.request) || !isJsonValueV1(prepared.input.request))) ||
    (prepared.input.facts !== undefined &&
      (!isDeepFrozenV1(prepared.input.facts) || !isJsonValueV1(prepared.input.facts))) ||
    (prepared.input.binding !== null &&
      (!isRecordObjectV1(prepared.input.binding) || !isDeepFrozenV1(prepared.input.binding)))
  ) {
    throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('invalid_prepared_input');
  }
  assertPreparedGenericShapeV1(prepared);
}

function assertPreparedGenericShapeV1<
  TArguments extends RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1,
>(prepared: Readonly<PreparedToolInvocationV1<TArguments, TRequest>>): void {
  const identity = prepared.identity as unknown as Record<string, unknown>;
  const identityStringKeys = [
    'invocationId',
    'attemptId',
    'toolCallId',
    'turnId',
    'modelMessageId',
    'providerId',
    'operationId',
    'capabilityId',
    'capabilityRevision',
    'descriptorRevision',
    'argumentsDigest',
    'schemaDigest',
    'effectiveEffectsDigest',
    'executionFamily',
    'executionMechanism',
    'visibility',
  ] as const;
  const nullableIdentityStringKeys = [
    'parserRevision',
    'executorRevision',
    'policyDigest',
    'authorizationDigest',
    'admissionDigest',
    'idempotencyKeyArgument',
    'idempotencyKey',
    'bindingId',
    'builtinProjectionRevision',
    'dynamicCatalogRevision',
  ] as const;
  if (
    !identityStringKeys.every((key) => isBoundedIdentityStringV1(identity[key])) ||
    (identity.argumentOrigin !== 'model_public' && identity.argumentOrigin !== 'runtime_private') ||
    !nullableIdentityStringKeys.every(
      (key) => identity[key] === null || isBoundedIdentityStringV1(identity[key]),
    ) ||
    typeof identity.modelVisible !== 'boolean' ||
    typeof identity.isDynamicMcp !== 'boolean' ||
    (identity.isDynamicMcp === true &&
      (identity.operationId !== 'mcp:dynamic_tool' ||
        identity.executionFamily !== 'mcp' ||
        identity.executionMechanism !== 'mcp' ||
        identity.executorRevision !== null ||
        identity.visibility !== 'internal' ||
        identity.modelVisible !== false ||
        identity.exposedToolName !== null ||
        identity.builtinProjectionRevision !== null ||
        !isBoundedIdentityStringV1(identity.dynamicCatalogRevision) ||
        !isDynamicSubjectShapeV1(identity.subject) ||
        !isDynamicWrapperShapeV1(identity.runtimeWrapper) ||
        !isDynamicIdentityRelationV1(identity))) ||
    (identity.isDynamicMcp === false &&
      (identity.operationId === 'mcp:dynamic_tool' ||
        (identity.executionFamily !== 'builtin' &&
          identity.executionFamily !== 'skill' &&
          identity.executionFamily !== 'subagent') ||
        identity.visibility !== 'model' ||
        identity.modelVisible !== true ||
        !isBoundedIdentityStringV1(identity.exposedToolName) ||
        (identity.toolKind !== 'computer' &&
          identity.toolKind !== 'coordination' &&
          identity.toolKind !== 'runtime_action' &&
          identity.toolKind !== 'interrupt') ||
        !isBoundedIdentityStringV1(identity.builtinProjectionRevision) ||
        (identity.dynamicCatalogRevision !== null &&
          !isBoundedIdentityStringV1(identity.dynamicCatalogRevision)))) ||
    !isBoundedIdentityStringV1(prepared.input.invocationId) ||
    !isBoundedIdentityStringV1(prepared.input.attemptId) ||
    !isBoundedIdentityStringV1(prepared.input.toolCallId) ||
    !Object.hasOwn(prepared.input, 'arguments') ||
    !Object.hasOwn(prepared.input, 'binding') ||
    (prepared.input.binding !== null && !isRecordObjectV1(prepared.input.binding))
  ) {
    throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('invalid_prepared_input');
  }
}

function assertPreparedIdentityWithInputV1<
  TArguments extends RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1,
>(prepared: Readonly<PreparedToolInvocationV1<TArguments, TRequest>>): void {
  const binding = prepared.input.binding;
  const bindingCapabilityId = prepared.identity.capabilityId;
  const bindingCapabilityRevision = prepared.identity.capabilityRevision;
  const bindingSchemaDigest = prepared.identity.schemaDigest;
  const bindingExposedToolName = prepared.identity.isDynamicMcp
    ? prepared.identity.subject.exposedToolName
    : prepared.identity.exposedToolName;
  if (
    prepared.input.invocationId !== prepared.identity.invocationId ||
    prepared.input.attemptId !== prepared.identity.attemptId ||
    prepared.input.toolCallId !== prepared.identity.toolCallId ||
    (binding === null) !== (prepared.identity.bindingId === null) ||
    (binding !== null &&
      (!isBoundedIdentityStringV1(binding.bindingId) ||
        !isBoundedIdentityStringV1(binding.capabilityId) ||
        !isBoundedIdentityStringV1(binding.capabilityRevision) ||
        !isBoundedIdentityStringV1(binding.schemaDigest) ||
        !isBoundedIdentityStringV1(binding.exposedToolName) ||
        !isBoundedIdentityStringV1(binding.issuedForTurnId) ||
        binding.bindingId !== prepared.identity.bindingId ||
        binding.capabilityId !== bindingCapabilityId ||
        binding.capabilityRevision !== bindingCapabilityRevision ||
        binding.schemaDigest !== bindingSchemaDigest ||
        binding.exposedToolName !== bindingExposedToolName ||
        binding.issuedForTurnId !== prepared.identity.turnId))
  ) {
    throw new RuntimeHostToolPipelineAttemptCoordinatorErrorV1('identity_mismatch');
  }
}

function isDynamicSubjectShapeV1(value: unknown): boolean {
  if (!isRecordObjectV1(value)) return false;
  const subject = value as Record<string, unknown>;
  return (
    isBoundedIdentityStringV1(subject.capabilityId) &&
    isBoundedIdentityStringV1(subject.capabilityRevision) &&
    isBoundedIdentityStringV1(subject.descriptorRevision) &&
    isBoundedIdentityStringV1(subject.providerId) &&
    isBoundedIdentityStringV1(subject.exposedToolName) &&
    subject.exposedToolName.startsWith('mcp__') &&
    isBoundedIdentityStringV1(subject.dynamicCatalogRevision) &&
    (subject.bindingId === null || isBoundedIdentityStringV1(subject.bindingId))
  );
}

function isDynamicWrapperShapeV1(value: unknown): boolean {
  if (!isRecordObjectV1(value)) return false;
  const wrapper = value as Record<string, unknown>;
  return (
    wrapper.operationId === 'mcp:dynamic_tool' &&
    wrapper.capabilityId === 'mcp:dynamic_tool' &&
    isBoundedIdentityStringV1(wrapper.providerId) &&
    isBoundedIdentityStringV1(wrapper.capabilityRevision) &&
    isBoundedIdentityStringV1(wrapper.executorRevision) &&
    isBoundedIdentityStringV1(wrapper.schemaDigest) &&
    isBoundedIdentityStringV1(wrapper.builtinProjectionRevision)
  );
}

function isDynamicIdentityRelationV1(identity: Record<string, unknown>): boolean {
  if (
    !isDynamicSubjectShapeV1(identity.subject) ||
    !isDynamicWrapperShapeV1(identity.runtimeWrapper)
  ) {
    return false;
  }
  const subject = identity.subject as Record<string, unknown>;
  const wrapper = identity.runtimeWrapper as Record<string, unknown>;
  return (
    subject.capabilityId === identity.capabilityId &&
    subject.capabilityRevision === identity.capabilityRevision &&
    subject.descriptorRevision === identity.descriptorRevision &&
    subject.providerId === identity.providerId &&
    subject.dynamicCatalogRevision === identity.dynamicCatalogRevision &&
    subject.bindingId === identity.bindingId &&
    wrapper.operationId === identity.operationId
  );
}

function isAcknowledgementForPreparedV1(
  value: unknown,
  identity: Readonly<PreparedToolInvocationIdentityV1>,
): value is Readonly<ToolPipelineAttemptAcknowledgementV1> {
  try {
    if (
      !isRecordObjectV1(value) ||
      !hasOwnDataPropertyV1(value, 'acknowledged') ||
      !hasOwnDataPropertyV1(value, 'attempt') ||
      value.acknowledged !== true ||
      !isRecordObjectV1(value.attempt) ||
      !isValidAttemptShapeV1(value.attempt)
    ) {
      return false;
    }

    const attempt = value.attempt as unknown as Record<string, unknown>;
    const expected = identity as unknown as Record<string, unknown>;
    const wrapper = identity.isDynamicMcp ? identity.runtimeWrapper : null;
    const expectedWrapperIdentity = {
      runtimeWrapperProviderId: wrapper?.providerId ?? null,
      runtimeWrapperCapabilityRevision: wrapper?.capabilityRevision ?? null,
      runtimeWrapperExecutorRevision: wrapper?.executorRevision ?? null,
      runtimeWrapperSchemaDigest: wrapper?.schemaDigest ?? null,
      runtimeWrapperBuiltinProjectionRevision: wrapper?.builtinProjectionRevision ?? null,
    } as const;
    const comparableKeys = [
      'invocationId',
      'attemptId',
      'toolCallId',
      'turnId',
      'modelMessageId',
      'argumentOrigin',
      'providerId',
      'operationId',
      'capabilityId',
      'capabilityRevision',
      'descriptorRevision',
      'parserRevision',
      'executorRevision',
      'argumentsDigest',
      'schemaDigest',
      'effectiveEffectsDigest',
      'builtinProjectionRevision',
      'dynamicCatalogRevision',
      'policyDigest',
      'authorizationDigest',
      'admissionDigest',
      'idempotencyKey',
      'runtimeWrapperProviderId',
      'runtimeWrapperCapabilityRevision',
      'runtimeWrapperExecutorRevision',
      'runtimeWrapperSchemaDigest',
      'runtimeWrapperBuiltinProjectionRevision',
    ] as const;
    if (
      !comparableKeys.every((key) =>
        key in expectedWrapperIdentity
          ? expectedWrapperIdentity[key as keyof typeof expectedWrapperIdentity] === attempt[key]
          : expected[key] === attempt[key],
      )
    ) {
      return false;
    }

    deepFreezeV1(value);
    return true;
  } catch {
    return false;
  }
}

function isValidAttemptShapeV1(value: Record<PropertyKey, unknown>): boolean {
  const attempt = value as Record<string, unknown>;
  const requiredStringKeys = [
    'invocationId',
    'attemptId',
    'toolCallId',
    'turnId',
    'modelMessageId',
    'argumentOrigin',
    'providerId',
    'operationId',
    'capabilityId',
    'capabilityRevision',
    'descriptorRevision',
    'argumentsDigest',
    'schemaDigest',
    'effectiveEffectsDigest',
    'recordedAt',
    'startedAt',
  ] as const;
  const nullableStringKeys = [
    'parserRevision',
    'executorRevision',
    'builtinProjectionRevision',
    'dynamicCatalogRevision',
    'policyDigest',
    'authorizationDigest',
    'admissionDigest',
    'idempotencyKey',
    'runtimeWrapperProviderId',
    'runtimeWrapperCapabilityRevision',
    'runtimeWrapperExecutorRevision',
    'runtimeWrapperSchemaDigest',
    'runtimeWrapperBuiltinProjectionRevision',
  ] as const;
  return (
    requiredStringKeys.every(
      (key) => hasOwnDataPropertyV1(attempt, key) && isBoundedIdentityStringV1(attempt[key]),
    ) &&
    (attempt.argumentOrigin === 'model_public' || attempt.argumentOrigin === 'runtime_private') &&
    nullableStringKeys.every(
      (key) =>
        hasOwnDataPropertyV1(attempt, key) &&
        (attempt[key] === null || isBoundedIdentityStringV1(attempt[key])),
    ) &&
    hasOwnDataPropertyV1(attempt, 'attempt') &&
    typeof attempt.attempt === 'number' &&
    Number.isSafeInteger(attempt.attempt) &&
    attempt.attempt >= 1
  );
}

function isVerificationAcceptedV1(value: unknown): boolean {
  if (value === true) return true;
  return isRecordObjectV1(value) && value.valid === true;
}

function hasOwnDataPropertyV1(value: object, key: PropertyKey): boolean {
  return ownDataDescriptorV1(value, key) !== null;
}

function ownDataDescriptorV1(
  value: object,
  key: PropertyKey,
): (PropertyDescriptor & { readonly value: unknown }) | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor
    ? { ...descriptor, value: descriptor.value }
    : null;
}

function isValidTerminalResultV1(
  value: unknown,
): value is Readonly<CapabilityToolTerminalResultV1> {
  try {
    if (!isRecordObjectV1(value)) return false;
    const status = ownDataDescriptorV1(value, 'status');
    const content = ownDataDescriptorV1(value, 'content');
    if (!status || !content) return false;
    if (
      status.value !== 'success' &&
      status.value !== 'partial' &&
      status.value !== 'error' &&
      status.value !== 'cancelled' &&
      status.value !== 'unknown'
    ) {
      return false;
    }
    if (!Array.isArray(content.value) || !isJsonValueV1(content.value)) return false;

    const structuredContent = ownDataDescriptorV1(value, 'structuredContent');
    if (Object.hasOwn(value, 'structuredContent') && !structuredContent) return false;
    if (structuredContent?.value !== undefined && !isJsonValueV1(structuredContent.value)) {
      return false;
    }
    const providerMeta = ownDataDescriptorV1(value, 'providerMeta');
    if (Object.hasOwn(value, 'providerMeta') && !providerMeta) return false;
    if (providerMeta?.value !== undefined && !isJsonValueV1(providerMeta.value)) {
      return false;
    }
    const failure = ownDataDescriptorV1(value, 'failure');
    if (Object.hasOwn(value, 'failure') && !failure) return false;
    if (failure?.value !== undefined && !isValidTerminalFailureV1(failure.value)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isValidDispatchOutcomeV1<TValue extends RuntimeJsonValueV1>(
  value: unknown,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgementV1>,
): value is Readonly<ToolPipelineDispatchOutcomeV1<TValue>> {
  if (!isRecordObjectV1(value)) return false;
  if (value.kind === 'committed') {
    return (
      hasExactOwnDataKeysV1(value, ['kind', 'terminal']) && isValidTerminalResultV1(value.terminal)
    );
  }
  if (value.kind === 'retryable') {
    return (
      hasExactOwnDataKeysV1(value, ['kind', 'replaySafety', 'result']) &&
      value.replaySafety === 'safe_read' &&
      isValidTerminalResultV1(value.result) &&
      value.result.status === 'error' &&
      isRecordObjectV1(value.result.failure) &&
      value.result.failure.retryable === true
    );
  }
  if (value.kind !== 'suspended') return false;
  if (!hasExactOwnDataKeysV1(value, ['kind', 'suspension', 'result'])) return false;
  if (
    !isValidSuspensionV1(
      value.suspension,
      acknowledgement.attempt as unknown as Record<string, unknown>,
    )
  ) {
    return false;
  }
  if (!isValidTerminalResultV1(value.result)) return false;
  return (
    value.result.status === 'success' &&
    hasOwnDataPropertyV1(value.result, 'structuredContent') &&
    !hasOwnDataPropertyV1(value.result, 'failure')
  );
}

function isValidSuspensionV1(value: unknown, acknowledgement: Record<string, unknown>): boolean {
  if (!isRecordObjectV1(value)) return false;
  const kind = ownDataDescriptorV1(value, 'kind')?.value;
  if (kind === 'plan_review') {
    return isValidPlanReviewSuspensionV1(value, acknowledgement.toolCallId);
  }
  if (kind === 'skill_fork') {
    return isValidSkillForkSuspensionV1(value, acknowledgement);
  }
  if (kind === 'task_subagent') {
    return isValidTaskSubagentSuspensionV1(value, acknowledgement);
  }
  return false;
}

function isValidPlanReviewSuspensionV1(
  value: unknown,
  acknowledgedToolCallId: unknown,
): value is Readonly<ToolPipelineSuspensionV1> {
  if (
    !isRecordObjectV1(value) ||
    !hasExactOwnDataKeysV1(value, ['schema', 'kind', 'toolCallId', 'event']) ||
    value.schema !== 'kite.tool-pipeline-stage.v1' ||
    value.kind !== 'plan_review' ||
    value.toolCallId !== acknowledgedToolCallId ||
    !isRecordObjectV1(value.event)
  ) {
    return false;
  }
  const event = value.event;
  const eventKeys = [
    'type',
    'interactionId',
    'toolCallId',
    'taskId',
    'plan',
    'planSummary',
    'planId',
    'version',
    'structuralDigest',
    'artifact',
  ] as const;
  return (
    hasExactOwnDataKeysV1(event, eventKeys) &&
    event.type === 'plan.review_requested' &&
    event.toolCallId === acknowledgedToolCallId &&
    isBoundedIdentityStringV1(event.interactionId) &&
    isBoundedIdentityStringV1(event.taskId) &&
    isBoundedIdentityStringV1(event.planId) &&
    isBoundedIdentityStringV1(event.structuralDigest) &&
    typeof event.planSummary === 'string' &&
    event.planSummary.length > 0 &&
    event.planSummary.length <= 65_536 &&
    Number.isSafeInteger(event.version) &&
    (event.version as number) > 0 &&
    isJsonValueV1(event.plan) &&
    isJsonValueV1(event.artifact)
  );
}

function isValidSkillForkSuspensionV1(
  value: Record<PropertyKey, unknown>,
  acknowledgement: Record<string, unknown>,
): boolean {
  if (
    !hasExactOwnDataKeysV1(value, [
      'schema',
      'kind',
      'operationId',
      'toolCallId',
      'parent',
      'activation',
      'subagent',
      'blockedTool',
      'event',
    ]) ||
    value.schema !== 'kite.tool-pipeline-stage.v1' ||
    value.kind !== 'skill_fork' ||
    value.operationId !== 'builtin:activate_skill' ||
    value.toolCallId !== acknowledgement.toolCallId ||
    acknowledgement.operationId !== 'builtin:activate_skill' ||
    !isBoundedIdentityStringV1(value.toolCallId)
  ) {
    return false;
  }

  const parent = value.parent;
  if (
    !isRecordObjectV1(parent) ||
    !hasExactOwnDataKeysV1(parent, ['toolCallId', 'invocationId', 'attemptId', 'attempt']) ||
    !isBoundedIdentityStringV1(parent.toolCallId) ||
    !isBoundedIdentityStringV1(parent.invocationId) ||
    !isBoundedIdentityStringV1(parent.attemptId) ||
    !isPositiveSafeIntegerV1(parent.attempt) ||
    parent.toolCallId !== acknowledgement.toolCallId ||
    parent.invocationId !== acknowledgement.invocationId ||
    parent.attemptId !== acknowledgement.attemptId ||
    parent.attempt !== acknowledgement.attempt
  ) {
    return false;
  }

  const activation = value.activation;
  if (
    !isRecordObjectV1(activation) ||
    !hasExactOwnDataKeysV1(activation, [
      'activationId',
      'skillId',
      'skillRevision',
      'taskId',
      'contextMode',
    ]) ||
    !isBoundedIdentityStringV1(activation.activationId) ||
    !isBoundedIdentityStringV1(activation.skillId) ||
    !isBoundedIdentityStringV1(activation.skillRevision) ||
    !isBoundedIdentityStringV1(activation.taskId) ||
    activation.contextMode !== 'fork'
  ) {
    return false;
  }

  if (!isValidPrivateSuspendedSubagentRecordV1(value.subagent, parent)) return false;
  if (!isValidSubagentBlockedToolIdentityV1(value.blockedTool)) return false;

  const blockedTool = value.blockedTool as Record<string, unknown>;
  const subagent = value.subagent as Record<string, unknown>;
  const subagentBlockedTool = subagent.blockedTool as Record<string, unknown>;
  if (
    subagent.parentInvocationId !== parent.invocationId ||
    subagent.parentAttempt !== parent.attempt ||
    subagentBlockedTool.toolCallId !== blockedTool.toolCallId ||
    (subagentBlockedTool.runtimeToolCallId ?? null) !== blockedTool.runtimeToolCallId ||
    subagentBlockedTool.toolName !== blockedTool.toolName
  ) {
    return false;
  }

  return isValidSubagentSuspensionEventV1(
    value.event,
    value.toolCallId,
    blockedTool,
    subagentBlockedTool.reasonCode,
    blockedTool.toolCallId,
  );
}

function isValidTaskSubagentSuspensionV1(
  value: Record<PropertyKey, unknown>,
  acknowledgement: Record<string, unknown>,
): boolean {
  if (
    !hasExactOwnDataKeysV1(value, [
      'schema',
      'kind',
      'operationId',
      'executionMode',
      'toolCallId',
      'parent',
      'subagent',
      'blockedTool',
      'event',
    ]) ||
    value.schema !== 'kite.tool-pipeline-stage.v1' ||
    value.kind !== 'task_subagent' ||
    value.operationId !== 'builtin:task' ||
    (value.executionMode !== 'start' && value.executionMode !== 'resume') ||
    value.toolCallId !== acknowledgement.toolCallId ||
    acknowledgement.operationId !== 'builtin:task' ||
    !isBoundedIdentityStringV1(value.toolCallId)
  ) {
    return false;
  }

  const parent = value.parent;
  if (!isValidSubagentSuspensionParentV1(parent, acknowledgement)) return false;
  if (!isValidPrivateSuspendedSubagentRecordV1(value.subagent, parent)) return false;
  if (!isValidSubagentBlockedToolIdentityV1(value.blockedTool)) return false;

  const blockedTool = value.blockedTool as Record<string, unknown>;
  const subagent = value.subagent as Record<string, unknown>;
  const subagentBlockedTool = subagent.blockedTool as Record<string, unknown>;
  if (
    subagent.parentInvocationId !== parent.invocationId ||
    subagent.parentAttempt !== parent.attempt ||
    subagentBlockedTool.toolCallId !== blockedTool.toolCallId ||
    (subagentBlockedTool.runtimeToolCallId ?? null) !== blockedTool.runtimeToolCallId ||
    subagentBlockedTool.toolName !== blockedTool.toolName
  ) {
    return false;
  }

  return isValidSubagentSuspensionEventV1(
    value.event,
    value.toolCallId,
    blockedTool,
    subagentBlockedTool.reasonCode,
    blockedTool.runtimeToolCallId ?? blockedTool.toolCallId,
  );
}

function isValidSubagentSuspensionParentV1(
  value: unknown,
  acknowledgement: Record<string, unknown>,
): value is Record<PropertyKey, unknown> {
  return (
    isRecordObjectV1(value) &&
    hasExactOwnDataKeysV1(value, ['toolCallId', 'invocationId', 'attemptId', 'attempt']) &&
    isBoundedIdentityStringV1(value.toolCallId) &&
    isBoundedIdentityStringV1(value.invocationId) &&
    isBoundedIdentityStringV1(value.attemptId) &&
    isPositiveSafeIntegerV1(value.attempt) &&
    value.toolCallId === acknowledgement.toolCallId &&
    value.invocationId === acknowledgement.invocationId &&
    value.attemptId === acknowledgement.attemptId &&
    value.attempt === acknowledgement.attempt
  );
}

function isValidPrivateSuspendedSubagentRecordV1(
  value: unknown,
  parent: Record<PropertyKey, unknown>,
): boolean {
  if (
    !isRecordObjectV1(value) ||
    !hasExactOwnDataKeysV1(value, [
      'storage',
      'subagentId',
      'role',
      'continuationId',
      'modelInvocationOrdinal',
      'continuationArtifact',
      'parentInvocationId',
      'parentAttempt',
      'blockedTool',
    ]) ||
    value.storage !== 'private_artifact_v1' ||
    !isBoundedIdentityStringV1(value.subagentId) ||
    (value.role !== 'explore' &&
      value.role !== 'plan' &&
      value.role !== 'code' &&
      value.role !== 'review') ||
    !isBoundedIdentityStringV1(value.continuationId) ||
    !isNonNegativeSafeIntegerV1(value.modelInvocationOrdinal) ||
    !isValidSubagentContinuationArtifactV1(value.continuationArtifact) ||
    value.parentInvocationId !== parent.invocationId ||
    value.parentAttempt !== parent.attempt ||
    !isValidPrivateSuspendedSubagentBlockedToolV1(value.blockedTool)
  ) {
    return false;
  }
  return true;
}

function isValidSubagentContinuationArtifactV1(value: unknown): boolean {
  if (
    !isRecordObjectV1(value) ||
    !hasExactOwnDataKeysV1(value, ['artifactId', 'kind', 'integrityIdentifier', 'byteLength'])
  ) {
    return false;
  }
  return (
    isBoundedIdentityStringV1(value.artifactId) &&
    value.kind === 'subagent_continuation' &&
    isBoundedIdentityStringV1(value.integrityIdentifier) &&
    isPositiveSafeIntegerV1(value.byteLength)
  );
}

function isValidPrivateSuspendedSubagentBlockedToolV1(value: unknown): boolean {
  if (!isRecordObjectV1(value)) return false;
  const keys = Reflect.ownKeys(value);
  const hasRuntimeToolCallId = Object.hasOwn(value, 'runtimeToolCallId');
  const expectedKeys = [
    'reasonCode',
    'toolCallId',
    'toolName',
    ...(hasRuntimeToolCallId ? ['runtimeToolCallId'] : []),
  ];
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => hasOwnDataPropertyV1(value, key)) ||
    (value.reasonCode !== 'SUBAGENT_TOOL_REQUIRES_APPROVAL' &&
      value.reasonCode !== 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW') ||
    !isBoundedIdentityStringV1(value.toolCallId) ||
    !isBoundedIdentityStringV1(value.toolName)
  ) {
    return false;
  }
  return !hasRuntimeToolCallId || isBoundedIdentityStringV1(value.runtimeToolCallId);
}

function isValidSubagentBlockedToolIdentityV1(value: unknown): boolean {
  if (
    !isRecordObjectV1(value) ||
    !hasExactOwnDataKeysV1(value, [
      'toolCallId',
      'runtimeToolCallId',
      'toolName',
      'argumentsDigest',
      'commandDigest',
    ]) ||
    !isBoundedIdentityStringV1(value.toolCallId) ||
    (value.runtimeToolCallId !== null && !isBoundedIdentityStringV1(value.runtimeToolCallId)) ||
    !isBoundedIdentityStringV1(value.toolName) ||
    !isBoundedIdentityStringV1(value.argumentsDigest) ||
    (value.commandDigest !== null && !isBoundedIdentityStringV1(value.commandDigest))
  ) {
    return false;
  }
  return true;
}

function isValidSubagentSuspensionEventV1(
  value: unknown,
  parentToolCallId: unknown,
  blockedTool: Record<string, unknown>,
  subagentBlockedReasonCode: unknown,
  expectedApprovalCallId = blockedTool.toolCallId,
): boolean {
  if (!isRecordObjectV1(value)) return false;
  const type = ownDataDescriptorV1(value, 'type')?.value;
  if (type === 'approval.requested') {
    if (
      !hasExactOptionalDataKeysV1(
        value,
        ['type', 'interactionId', 'toolCallId', 'approval'],
        ['createdAt'],
      ) ||
      value.toolCallId !== parentToolCallId ||
      !isBoundedIdentityStringV1(value.interactionId) ||
      (Object.hasOwn(value, 'createdAt') && !isBoundedTextStringV1(value.createdAt))
    ) {
      return false;
    }
    return (
      subagentBlockedReasonCode === 'SUBAGENT_TOOL_REQUIRES_APPROVAL' &&
      isValidSubagentApprovalV1(value.approval, blockedTool, expectedApprovalCallId)
    );
  }
  if (value.type !== 'auto_review.requested') return false;
  if (
    !hasExactOptionalDataKeysV1(
      value,
      ['type', 'reviewId', 'toolCallId', 'toolName', 'reason', 'approval'],
      ['requestFingerprint', 'createdAt'],
    ) ||
    value.toolCallId !== parentToolCallId ||
    !isBoundedIdentityStringV1(value.reviewId) ||
    !isBoundedIdentityStringV1(value.toolName) ||
    value.toolName !== blockedTool.toolName ||
    !isBoundedTextStringV1(value.reason) ||
    (Object.hasOwn(value, 'requestFingerprint') &&
      !isBoundedIdentityStringV1(value.requestFingerprint)) ||
    (Object.hasOwn(value, 'createdAt') && !isBoundedTextStringV1(value.createdAt))
  ) {
    return false;
  }
  return (
    subagentBlockedReasonCode === 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' &&
    isValidSubagentApprovalV1(value.approval, blockedTool, expectedApprovalCallId)
  );
}

function isValidSubagentApprovalV1(
  value: unknown,
  blockedTool: Record<string, unknown>,
  expectedCallId = blockedTool.toolCallId,
): boolean {
  if (
    !isRecordObjectV1(value) ||
    !hasExactOptionalDataKeysV1(
      value,
      [
        'scope',
        'callId',
        'cwd',
        'threadId',
        'tool',
        'command',
        'risk',
        'approvalHash',
        'summary',
        'reason',
        'expectedEffects',
        'grantOptions',
        'recommendedGrant',
      ],
      ['plan', 'subagentId', 'reviewFailure'],
    ) ||
    value.scope !== 'once' ||
    value.callId !== expectedCallId ||
    !isBoundedTextStringV1(value.cwd, 4_096) ||
    !isBoundedIdentityStringV1(value.threadId) ||
    !isBoundedTextStringV1(value.tool) ||
    value.tool !== blockedTool.toolName ||
    !isBoundedTextStringV1(value.command, 65_536) ||
    !isValidApprovalRiskV1(value.risk) ||
    !isBoundedIdentityStringV1(value.approvalHash) ||
    !isBoundedTextStringV1(value.summary) ||
    !isBoundedTextStringV1(value.reason) ||
    !isBoundedStringArrayV1(value.expectedEffects, 256) ||
    !isValidGrantArrayV1(value.grantOptions) ||
    !isValidGrantV1(value.recommendedGrant) ||
    (Object.hasOwn(value, 'plan') && !isJsonValueV1(value.plan)) ||
    (Object.hasOwn(value, 'subagentId') && !isBoundedIdentityStringV1(value.subagentId)) ||
    (Object.hasOwn(value, 'reviewFailure') && !isBoundedTextStringV1(value.reviewFailure))
  ) {
    return false;
  }
  return true;
}

function hasExactOptionalDataKeysV1(
  value: object,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < requiredKeys.length ||
    keys.length > requiredKeys.length + optionalKeys.length
  ) {
    return false;
  }
  if (!requiredKeys.every((key) => hasOwnDataPropertyV1(value, key))) return false;
  return keys.every(
    (key) =>
      typeof key === 'string' &&
      (requiredKeys.includes(key) || optionalKeys.includes(key)) &&
      hasOwnDataPropertyV1(value, key),
  );
}

function isPositiveSafeIntegerV1(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isNonNegativeSafeIntegerV1(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedTextStringV1(value: unknown, maxLength = 65_536): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isBoundedStringArrayV1(value: unknown, maxLength: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maxLength || !isJsonValueV1(value)) return false;
  return value.every((entry) => isBoundedTextStringV1(entry));
}

function isValidGrantV1(value: unknown): boolean {
  return value === 'approve_once' || value === 'same_command' || value === 'full_access';
}

function isValidApprovalRiskV1(value: unknown): boolean {
  return (
    value === 'read' ||
    value === 'plan' ||
    value === 'write_file' ||
    value === 'execute_code' ||
    value === 'destructive' ||
    value === 'network' ||
    value === 'vcs_mutation' ||
    value === 'mcp' ||
    value === 'unknown'
  );
}

function isValidGrantArrayV1(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3 || !isJsonValueV1(value))
    return false;
  return value.every((entry) => isValidGrantV1(entry));
}

function hasExactOwnDataKeysV1(value: object, expectedKeys: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => hasOwnDataPropertyV1(value, key))
  );
}

function isValidTerminalFailureV1(value: unknown): boolean {
  if (!isRecordObjectV1(value)) return false;
  const code = ownDataDescriptorV1(value, 'code');
  const message = ownDataDescriptorV1(value, 'message');
  const retryable = ownDataDescriptorV1(value, 'retryable');
  const modelFixable = ownDataDescriptorV1(value, 'modelFixable');
  const needsUserIntervention = ownDataDescriptorV1(value, 'needsUserIntervention');
  const terminatesTurn = ownDataDescriptorV1(value, 'terminatesTurn');
  const journal = ownDataDescriptorV1(value, 'journal');
  const parseFailureCode = ownDataDescriptorV1(value, 'parseFailureCode');
  const details = ownDataDescriptorV1(value, 'details');
  return (
    typeof code?.value === 'string' &&
    typeof message?.value === 'string' &&
    typeof retryable?.value === 'boolean' &&
    typeof modelFixable?.value === 'boolean' &&
    typeof needsUserIntervention?.value === 'boolean' &&
    typeof terminatesTurn?.value === 'boolean' &&
    typeof journal?.value === 'boolean' &&
    (!Object.hasOwn(value, 'parseFailureCode') ||
      (parseFailureCode !== null &&
        (parseFailureCode.value === undefined || typeof parseFailureCode.value === 'string'))) &&
    (!Object.hasOwn(value, 'details') ||
      (details !== null && (details.value === undefined || isJsonValueV1(details.value))))
  );
}
