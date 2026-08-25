import type {
  CapabilityToolTerminalResult,
  PreparedToolInvocation,
  PreparedToolInvocationIdentity,
  PreparedToolInvocationInput,
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineDispatchOutcome,
  ToolPipelineOutcomeDispatch,
  ToolPipelinePersistence,
  ToolPipelineSuspension,
} from '@kite-ai/runtime-spi';

/**
 * This is the Host's attempt/ack/dispatch seam. Resolution, validation,
 * classification, policy, and domain result projection remain outside this
 * file. The injected persistence callbacks own the durable receipt boundary;
 * Host owns their ordering and the post-ack uncertainty transition.
 */
export const RUNTIME_HOST_TOOL_PIPELINE_ATTEMPT_COORDINATOR_SCHEMA_ =
  'kite.runtime-host.tool-pipeline-attempt-coordinator.v1' as const;

export type RuntimeHostToolPipelineAttemptCoordinatorFailureCode =
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
export class RuntimeHostToolPipelineAttemptCoordinatorError extends Error {
  readonly code: RuntimeHostToolPipelineAttemptCoordinatorFailureCode;

  constructor(code: RuntimeHostToolPipelineAttemptCoordinatorFailureCode) {
    super(runtimeHostToolPipelineAttemptCoordinatorMessage(code));
    this.name = 'RuntimeHostToolPipelineAttemptCoordinatorError';
    this.code = code;
  }
}

export type RuntimeHostPreparedToolInvocationAuthority<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> = Readonly<PreparedToolInvocation<TArguments, TRequest>>;

/** Process-local proof that this coordinator durably committed the result. */
export interface RuntimeHostCommittedToolInvocationAuthority<
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly result: Readonly<CapabilityToolTerminalResult<TValue>>;
}

/** Process-local proof that this coordinator durably committed a non-terminal suspension. */
export interface RuntimeHostSuspendedToolInvocationAuthority<
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly suspension: Readonly<ToolPipelineSuspension>;
  readonly result: Readonly<
    Extract<ToolPipelineDispatchOutcome<TValue>, { readonly kind: 'suspended' }>['result']
  >;
}

/** Process-local proof that Kernel/App durably admitted one safe-read retry. */
export interface RuntimeHostRetryableToolInvocationAuthority<
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
  readonly replaySafety: 'safe_read';
  readonly result: Readonly<CapabilityToolTerminalResult<TValue>>;
}

export type RuntimeHostToolInvocationOutcomeAuthority<
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> =
  | ({ readonly kind: 'committed' } & RuntimeHostCommittedToolInvocationAuthority<TValue>)
  | ({ readonly kind: 'suspended' } & RuntimeHostSuspendedToolInvocationAuthority<TValue>)
  | ({ readonly kind: 'retryable' } & RuntimeHostRetryableToolInvocationAuthority<TValue>);

export interface RuntimeHostToolPipelineAttemptCoordinatorOptions<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly persistence: ToolPipelinePersistence<TValue>;
  readonly dispatch: ToolPipelineOutcomeDispatch<TArguments, TValue>;
}

/**
 * The coordinator owns process-local prepared authenticity, exact-once claim,
 * acknowledgement ordering, and post-ack uncertainty. It does not own a
 * Store, registry, executor, or Builtin/domain receipt semantics.
 */
export interface RuntimeHostToolPipelineAttemptCoordinator<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly prepare: <
    TPreparedArguments extends TArguments = TArguments,
    TPreparedRequest extends TRequest = TRequest,
  >(
    identity: Readonly<PreparedToolInvocationIdentity>,
    input: Readonly<PreparedToolInvocationInput<TPreparedArguments, TPreparedRequest>>,
  ) => RuntimeHostPreparedToolInvocationAuthority<TPreparedArguments, TPreparedRequest>;
  readonly execute: <
    TPreparedArguments extends TArguments = TArguments,
    TPreparedRequest extends TRequest = TRequest,
  >(
    prepared: Readonly<PreparedToolInvocation<TPreparedArguments, TPreparedRequest>>,
  ) => Promise<Readonly<RuntimeHostToolInvocationOutcomeAuthority<TValue>>>;
  readonly assertCommitted: (
    value: unknown,
  ) => asserts value is Readonly<RuntimeHostCommittedToolInvocationAuthority<TValue>>;
  readonly assertSuspended: (
    value: unknown,
  ) => asserts value is Readonly<RuntimeHostSuspendedToolInvocationAuthority<TValue>>;
  readonly assertRetryable: (
    value: unknown,
  ) => asserts value is Readonly<RuntimeHostRetryableToolInvocationAuthority<TValue>>;
}

export function createRuntimeHostToolPipelineAttemptCoordinator<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
>(
  options: RuntimeHostToolPipelineAttemptCoordinatorOptions<TArguments, TValue>,
): RuntimeHostToolPipelineAttemptCoordinator<TArguments, TRequest, TValue> {
  const { persistence, dispatch } = options;

  const authenticPrepared = new WeakSet<object>();
  const authenticCommitted = new WeakSet<object>();
  const authenticSuspended = new WeakSet<object>();
  const authenticRetryable = new WeakSet<object>();
  const claimedPrepared = new WeakSet<object>();
  const claimedAttemptKeys = new Set<string>();

  function prepare<TPreparedArguments extends TArguments, TPreparedRequest extends TRequest>(
    identity: Readonly<PreparedToolInvocationIdentity>,
    input: Readonly<PreparedToolInvocationInput<TPreparedArguments, TPreparedRequest>>,
  ): RuntimeHostPreparedToolInvocationAuthority<TPreparedArguments, TPreparedRequest> {
    try {
      if (!isRecordObject(identity) || !isRecordObject(input)) {
        throw new RuntimeHostToolPipelineAttemptCoordinatorError('invalid_prepared_input');
      }

      const candidate = {
        identity,
        input,
      } as Readonly<PreparedToolInvocation<TPreparedArguments, TPreparedRequest>>;

      deepFreeze(candidate.identity);
      deepFreeze(candidate.input);
      deepFreeze(candidate);

      const authority = candidate as RuntimeHostPreparedToolInvocationAuthority<
        TPreparedArguments,
        TPreparedRequest
      >;
      authenticPrepared.add(authority);
      return authority;
    } catch (error) {
      if (error instanceof RuntimeHostToolPipelineAttemptCoordinatorError) throw error;
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('invalid_prepared_input');
    }
  }

  async function execute<TPreparedArguments extends TArguments, TPreparedRequest extends TRequest>(
    prepared: Readonly<PreparedToolInvocation<TPreparedArguments, TPreparedRequest>>,
  ): Promise<Readonly<RuntimeHostToolInvocationOutcomeAuthority<TValue>>> {
    assertAuthenticPrepared(prepared, authenticPrepared);

    try {
      assertPreparedShape(prepared);
      assertPreparedIdentityWithInput(prepared);
    } catch (error) {
      if (error instanceof RuntimeHostToolPipelineAttemptCoordinatorError) throw error;
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('invalid_prepared_input');
    }

    const claimKey = JSON.stringify([
      prepared.identity.invocationId,
      prepared.identity.attemptId,
      prepared.identity.turnId,
      prepared.identity.modelMessageId,
    ]);
    if (claimedPrepared.has(prepared) || claimedAttemptKeys.has(claimKey)) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('duplicate_attempt');
    }

    let verification: unknown;
    try {
      verification = dispatch.verifyPreparedIdentity(prepared);
    } catch {
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('verification_failed');
    }
    if (!isVerificationAccepted(verification)) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('verification_failed');
    }

    // Claim before the first await. No persistence or dispatch failure may
    // clear either mark: this Host process never replays the attempt.
    claimedPrepared.add(prepared);
    claimedAttemptKeys.add(claimKey);

    let acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>;
    try {
      acknowledgement = await persistence.recordAttempt(prepared);
    } catch {
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('persistence_unavailable');
    }

    if (!isAcknowledgementForPrepared(acknowledgement, prepared.identity)) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('acknowledgement_failed');
    }

    let outcome: Readonly<ToolPipelineDispatchOutcome<TValue>>;
    try {
      outcome = await dispatch.dispatch(prepared);
    } catch {
      await recordUnknownOrThrow(persistence, acknowledgement, 'dispatch_failed');
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('unknown_outcome');
    }

    let dispatchOutcomeValid = false;
    try {
      dispatchOutcomeValid = isValidDispatchOutcome(outcome, acknowledgement);
    } catch {
      dispatchOutcomeValid = false;
    }
    if (!dispatchOutcomeValid) {
      await recordUnknownOrThrow(persistence, acknowledgement, 'dispatch_result_invalid');
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('unknown_outcome');
    }

    if (outcome.kind === 'retryable') {
      try {
        if (!persistence.commitRetryable) {
          throw new RuntimeHostToolPipelineAttemptCoordinatorError('persistence_unavailable');
        }
        deepFreeze(outcome.result);
        await persistence.commitRetryable({
          acknowledgement,
          replaySafety: outcome.replaySafety,
          result: outcome.result,
        });
      } catch {
        await recordUnknownOrThrow(persistence, acknowledgement, 'retryable_commit_failed');
        throw new RuntimeHostToolPipelineAttemptCoordinatorError('unknown_outcome');
      }
      const retryable = deepFreeze({
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
        deepFreeze(outcome.suspension);
        deepFreeze(outcome.result);
        await persistence.commitSuspension({
          acknowledgement,
          suspension: outcome.suspension,
          result: outcome.result,
        });
      } catch {
        await recordUnknownOrThrow(persistence, acknowledgement, 'suspension_commit_failed');
        throw new RuntimeHostToolPipelineAttemptCoordinatorError('unknown_outcome');
      }
      const suspended = deepFreeze({
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
      deepFreeze(result);
      await persistence.commitTerminal({ acknowledgement, result });
    } catch {
      await recordUnknownOrThrow(persistence, acknowledgement, 'terminal_commit_failed');
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('unknown_outcome');
    }

    const committed = deepFreeze({ kind: 'committed' as const, acknowledgement, result });
    authenticCommitted.add(committed);
    return committed;
  }

  function assertSuspended(
    value: unknown,
  ): asserts value is Readonly<RuntimeHostSuspendedToolInvocationAuthority<TValue>> {
    if (
      !isRecordObject(value) ||
      value.kind !== 'suspended' ||
      !authenticSuspended.has(value) ||
      !isDeepFrozen(value) ||
      !isDeepFrozen(value.acknowledgement) ||
      !isDeepFrozen(value.suspension) ||
      !isDeepFrozen(value.result)
    ) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('suspended_authority_invalid');
    }
  }

  function assertCommitted(
    value: unknown,
  ): asserts value is Readonly<RuntimeHostCommittedToolInvocationAuthority<TValue>> {
    if (
      !isRecordObject(value) ||
      !authenticCommitted.has(value) ||
      !isDeepFrozen(value) ||
      !isDeepFrozen(value.acknowledgement) ||
      !isDeepFrozen(value.result)
    ) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('retryable_authority_invalid');
    }
  }

  function assertRetryable(
    value: unknown,
  ): asserts value is Readonly<RuntimeHostRetryableToolInvocationAuthority<TValue>> {
    if (
      !isRecordObject(value) ||
      value.kind !== 'retryable' ||
      !authenticRetryable.has(value) ||
      !isDeepFrozen(value) ||
      !isDeepFrozen(value.acknowledgement) ||
      !isDeepFrozen(value.result) ||
      value.replaySafety !== 'safe_read'
    ) {
      throw new RuntimeHostToolPipelineAttemptCoordinatorError('committed_authority_invalid');
    }
  }

  const coordinator: RuntimeHostToolPipelineAttemptCoordinator<TArguments, TRequest, TValue> = {
    prepare,
    execute,
    assertCommitted,
    assertSuspended,
    assertRetryable,
  };
  return Object.freeze(coordinator);
}

async function recordUnknownOrThrow<TValue extends RuntimeJsonValue>(
  persistence: ToolPipelinePersistence<TValue>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
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
    throw new RuntimeHostToolPipelineAttemptCoordinatorError('unknown_persistence_failed');
  }
}

function runtimeHostToolPipelineAttemptCoordinatorMessage(
  code: RuntimeHostToolPipelineAttemptCoordinatorFailureCode,
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

function isRecordObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedIdentityString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) throw new TypeError('Prepared DTO accessors are not supported.');
    deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return true;
  const object = value as object;
  if (seen.has(object)) return true;
  if (!Object.isFrozen(object)) return false;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor) || !isDeepFrozen(descriptor.value, seen)) {
      return false;
    }
  }
  return true;
}

function isJsonValue(value: unknown, active = new WeakSet<object>()): value is RuntimeJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;

  if (active.has(value)) return false;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      const lengthDescriptor = ownDataDescriptor(value, 'length');
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
        const descriptor = ownDataDescriptor(value, String(index));
        if (!descriptor || !isJsonValue(descriptor.value, active)) {
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
      if (!descriptor || !('value' in descriptor) || !isJsonValue(descriptor.value, active)) {
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

function assertAuthenticPrepared<
  TArguments extends RuntimeJsonValue,
  TRequest extends RuntimeJsonValue,
>(
  prepared: unknown,
  authenticPrepared: WeakSet<object>,
): asserts prepared is Readonly<PreparedToolInvocation<TArguments, TRequest>> {
  if (!isRecordObject(prepared) || !authenticPrepared.has(prepared)) {
    throw new RuntimeHostToolPipelineAttemptCoordinatorError('invalid_prepared_input');
  }
}

function assertPreparedShape<
  TArguments extends RuntimeJsonValue,
  TRequest extends RuntimeJsonValue,
>(prepared: Readonly<PreparedToolInvocation<TArguments, TRequest>>): void {
  if (
    !isDeepFrozen(prepared) ||
    !isRecordObject(prepared.identity) ||
    !isRecordObject(prepared.input) ||
    !isDeepFrozen(prepared.identity) ||
    !isDeepFrozen(prepared.input) ||
    !isDeepFrozen(prepared.input.arguments) ||
    !isJsonValue(prepared.input.arguments) ||
    (prepared.input.request !== undefined &&
      (!isDeepFrozen(prepared.input.request) || !isJsonValue(prepared.input.request))) ||
    (prepared.input.facts !== undefined &&
      (!isDeepFrozen(prepared.input.facts) || !isJsonValue(prepared.input.facts))) ||
    (prepared.input.binding !== null &&
      (!isRecordObject(prepared.input.binding) || !isDeepFrozen(prepared.input.binding)))
  ) {
    throw new RuntimeHostToolPipelineAttemptCoordinatorError('invalid_prepared_input');
  }
  assertPreparedGenericShape(prepared);
}

function assertPreparedGenericShape<
  TArguments extends RuntimeJsonValue,
  TRequest extends RuntimeJsonValue,
>(prepared: Readonly<PreparedToolInvocation<TArguments, TRequest>>): void {
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
    !identityStringKeys.every((key) => isBoundedIdentityString(identity[key])) ||
    (identity.argumentOrigin !== 'model_public' && identity.argumentOrigin !== 'runtime_private') ||
    !nullableIdentityStringKeys.every(
      (key) => identity[key] === null || isBoundedIdentityString(identity[key]),
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
        !isBoundedIdentityString(identity.dynamicCatalogRevision) ||
        !isDynamicSubjectShape(identity.subject) ||
        !isDynamicWrapperShape(identity.runtimeWrapper) ||
        !isDynamicIdentityRelation(identity))) ||
    (identity.isDynamicMcp === false &&
      (identity.operationId === 'mcp:dynamic_tool' ||
        (identity.executionFamily !== 'builtin' &&
          identity.executionFamily !== 'skill' &&
          identity.executionFamily !== 'subagent') ||
        identity.visibility !== 'model' ||
        identity.modelVisible !== true ||
        !isBoundedIdentityString(identity.exposedToolName) ||
        (identity.toolKind !== 'computer' &&
          identity.toolKind !== 'coordination' &&
          identity.toolKind !== 'runtime_action' &&
          identity.toolKind !== 'interrupt') ||
        !isBoundedIdentityString(identity.builtinProjectionRevision) ||
        (identity.dynamicCatalogRevision !== null &&
          !isBoundedIdentityString(identity.dynamicCatalogRevision)))) ||
    !isBoundedIdentityString(prepared.input.invocationId) ||
    !isBoundedIdentityString(prepared.input.attemptId) ||
    !isBoundedIdentityString(prepared.input.toolCallId) ||
    !Object.hasOwn(prepared.input, 'arguments') ||
    !Object.hasOwn(prepared.input, 'binding') ||
    (prepared.input.binding !== null && !isRecordObject(prepared.input.binding))
  ) {
    throw new RuntimeHostToolPipelineAttemptCoordinatorError('invalid_prepared_input');
  }
}

function assertPreparedIdentityWithInput<
  TArguments extends RuntimeJsonValue,
  TRequest extends RuntimeJsonValue,
>(prepared: Readonly<PreparedToolInvocation<TArguments, TRequest>>): void {
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
      (!isBoundedIdentityString(binding.bindingId) ||
        !isBoundedIdentityString(binding.capabilityId) ||
        !isBoundedIdentityString(binding.capabilityRevision) ||
        !isBoundedIdentityString(binding.schemaDigest) ||
        !isBoundedIdentityString(binding.exposedToolName) ||
        !isBoundedIdentityString(binding.issuedForTurnId) ||
        binding.bindingId !== prepared.identity.bindingId ||
        binding.capabilityId !== bindingCapabilityId ||
        binding.capabilityRevision !== bindingCapabilityRevision ||
        binding.schemaDigest !== bindingSchemaDigest ||
        binding.exposedToolName !== bindingExposedToolName ||
        binding.issuedForTurnId !== prepared.identity.turnId))
  ) {
    throw new RuntimeHostToolPipelineAttemptCoordinatorError('identity_mismatch');
  }
}

function isDynamicSubjectShape(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  const subject = value as Record<string, unknown>;
  return (
    isBoundedIdentityString(subject.capabilityId) &&
    isBoundedIdentityString(subject.capabilityRevision) &&
    isBoundedIdentityString(subject.descriptorRevision) &&
    isBoundedIdentityString(subject.providerId) &&
    isBoundedIdentityString(subject.exposedToolName) &&
    subject.exposedToolName.startsWith('mcp__') &&
    isBoundedIdentityString(subject.dynamicCatalogRevision) &&
    (subject.bindingId === null || isBoundedIdentityString(subject.bindingId))
  );
}

function isDynamicWrapperShape(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  const wrapper = value as Record<string, unknown>;
  return (
    wrapper.operationId === 'mcp:dynamic_tool' &&
    wrapper.capabilityId === 'mcp:dynamic_tool' &&
    isBoundedIdentityString(wrapper.providerId) &&
    isBoundedIdentityString(wrapper.capabilityRevision) &&
    isBoundedIdentityString(wrapper.executorRevision) &&
    isBoundedIdentityString(wrapper.schemaDigest) &&
    isBoundedIdentityString(wrapper.builtinProjectionRevision)
  );
}

function isDynamicIdentityRelation(identity: Record<string, unknown>): boolean {
  if (!isDynamicSubjectShape(identity.subject) || !isDynamicWrapperShape(identity.runtimeWrapper)) {
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

function isAcknowledgementForPrepared(
  value: unknown,
  identity: Readonly<PreparedToolInvocationIdentity>,
): value is Readonly<ToolPipelineAttemptAcknowledgement> {
  try {
    if (
      !isRecordObject(value) ||
      !hasOwnDataProperty(value, 'acknowledged') ||
      !hasOwnDataProperty(value, 'attempt') ||
      value.acknowledged !== true ||
      !isRecordObject(value.attempt) ||
      !isValidAttemptShape(value.attempt)
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

    deepFreeze(value);
    return true;
  } catch {
    return false;
  }
}

function isValidAttemptShape(value: Record<PropertyKey, unknown>): boolean {
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
      (key) => hasOwnDataProperty(attempt, key) && isBoundedIdentityString(attempt[key]),
    ) &&
    (attempt.argumentOrigin === 'model_public' || attempt.argumentOrigin === 'runtime_private') &&
    nullableStringKeys.every(
      (key) =>
        hasOwnDataProperty(attempt, key) &&
        (attempt[key] === null || isBoundedIdentityString(attempt[key])),
    ) &&
    hasOwnDataProperty(attempt, 'attempt') &&
    typeof attempt.attempt === 'number' &&
    Number.isSafeInteger(attempt.attempt) &&
    attempt.attempt >= 1
  );
}

function isVerificationAccepted(value: unknown): boolean {
  if (value === true) return true;
  return isRecordObject(value) && value.valid === true;
}

function hasOwnDataProperty(value: object, key: PropertyKey): boolean {
  return ownDataDescriptor(value, key) !== null;
}

function ownDataDescriptor(
  value: object,
  key: PropertyKey,
): (PropertyDescriptor & { readonly value: unknown }) | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor
    ? { ...descriptor, value: descriptor.value }
    : null;
}

function isValidTerminalResult(value: unknown): value is Readonly<CapabilityToolTerminalResult> {
  try {
    if (!isRecordObject(value)) return false;
    const status = ownDataDescriptor(value, 'status');
    const content = ownDataDescriptor(value, 'content');
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
    if (!Array.isArray(content.value) || !isJsonValue(content.value)) return false;

    const structuredContent = ownDataDescriptor(value, 'structuredContent');
    if (Object.hasOwn(value, 'structuredContent') && !structuredContent) return false;
    if (structuredContent?.value !== undefined && !isJsonValue(structuredContent.value)) {
      return false;
    }
    const providerMeta = ownDataDescriptor(value, 'providerMeta');
    if (Object.hasOwn(value, 'providerMeta') && !providerMeta) return false;
    if (providerMeta?.value !== undefined && !isJsonValue(providerMeta.value)) {
      return false;
    }
    const failure = ownDataDescriptor(value, 'failure');
    if (Object.hasOwn(value, 'failure') && !failure) return false;
    if (failure?.value !== undefined && !isValidTerminalFailure(failure.value)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isValidDispatchOutcome<TValue extends RuntimeJsonValue>(
  value: unknown,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
): value is Readonly<ToolPipelineDispatchOutcome<TValue>> {
  if (!isRecordObject(value)) return false;
  if (value.kind === 'committed') {
    return (
      hasExactOwnDataKeys(value, ['kind', 'terminal']) && isValidTerminalResult(value.terminal)
    );
  }
  if (value.kind === 'retryable') {
    return (
      hasExactOwnDataKeys(value, ['kind', 'replaySafety', 'result']) &&
      value.replaySafety === 'safe_read' &&
      isValidTerminalResult(value.result) &&
      value.result.status === 'error' &&
      isRecordObject(value.result.failure) &&
      value.result.failure.retryable === true
    );
  }
  if (value.kind !== 'suspended') return false;
  if (!hasExactOwnDataKeys(value, ['kind', 'suspension', 'result'])) return false;
  if (
    !isValidSuspension(
      value.suspension,
      acknowledgement.attempt as unknown as Record<string, unknown>,
    )
  ) {
    return false;
  }
  if (!isValidTerminalResult(value.result)) return false;
  return (
    value.result.status === 'success' &&
    hasOwnDataProperty(value.result, 'structuredContent') &&
    !hasOwnDataProperty(value.result, 'failure')
  );
}

function isValidSuspension(value: unknown, acknowledgement: Record<string, unknown>): boolean {
  if (!isRecordObject(value)) return false;
  const kind = ownDataDescriptor(value, 'kind')?.value;
  if (kind === 'plan_review') {
    return isValidPlanReviewSuspension(value, acknowledgement.toolCallId);
  }
  if (kind === 'skill_fork') {
    return isValidSkillForkSuspension(value, acknowledgement);
  }
  if (kind === 'task_subagent') {
    return isValidTaskSubagentSuspension(value, acknowledgement);
  }
  return false;
}

function isValidPlanReviewSuspension(
  value: unknown,
  acknowledgedToolCallId: unknown,
): value is Readonly<ToolPipelineSuspension> {
  if (
    !isRecordObject(value) ||
    !hasExactOwnDataKeys(value, ['schema', 'kind', 'toolCallId', 'event']) ||
    value.schema !== 'kite.tool-pipeline-stage.v1' ||
    value.kind !== 'plan_review' ||
    value.toolCallId !== acknowledgedToolCallId ||
    !isRecordObject(value.event)
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
    hasExactOwnDataKeys(event, eventKeys) &&
    event.type === 'plan.review_requested' &&
    event.toolCallId === acknowledgedToolCallId &&
    isBoundedIdentityString(event.interactionId) &&
    isBoundedIdentityString(event.taskId) &&
    isBoundedIdentityString(event.planId) &&
    isBoundedIdentityString(event.structuralDigest) &&
    typeof event.planSummary === 'string' &&
    event.planSummary.length > 0 &&
    event.planSummary.length <= 65_536 &&
    Number.isSafeInteger(event.version) &&
    (event.version as number) > 0 &&
    isJsonValue(event.plan) &&
    isJsonValue(event.artifact)
  );
}

function isValidSkillForkSuspension(
  value: Record<PropertyKey, unknown>,
  acknowledgement: Record<string, unknown>,
): boolean {
  if (
    !hasExactOwnDataKeys(value, [
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
    !isBoundedIdentityString(value.toolCallId)
  ) {
    return false;
  }

  const parent = value.parent;
  if (
    !isRecordObject(parent) ||
    !hasExactOwnDataKeys(parent, ['toolCallId', 'invocationId', 'attemptId', 'attempt']) ||
    !isBoundedIdentityString(parent.toolCallId) ||
    !isBoundedIdentityString(parent.invocationId) ||
    !isBoundedIdentityString(parent.attemptId) ||
    !isPositiveSafeInteger(parent.attempt) ||
    parent.toolCallId !== acknowledgement.toolCallId ||
    parent.invocationId !== acknowledgement.invocationId ||
    parent.attemptId !== acknowledgement.attemptId ||
    parent.attempt !== acknowledgement.attempt
  ) {
    return false;
  }

  const activation = value.activation;
  if (
    !isRecordObject(activation) ||
    !hasExactOwnDataKeys(activation, [
      'activationId',
      'skillId',
      'skillRevision',
      'taskId',
      'contextMode',
    ]) ||
    !isBoundedIdentityString(activation.activationId) ||
    !isBoundedIdentityString(activation.skillId) ||
    !isBoundedIdentityString(activation.skillRevision) ||
    !isBoundedIdentityString(activation.taskId) ||
    activation.contextMode !== 'fork'
  ) {
    return false;
  }

  if (!isValidPrivateSuspendedSubagentRecord(value.subagent, parent)) return false;
  if (!isValidSubagentBlockedToolIdentity(value.blockedTool)) return false;

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

  return isValidSubagentSuspensionEvent(
    value.event,
    value.toolCallId,
    blockedTool,
    subagentBlockedTool.reasonCode,
    blockedTool.toolCallId,
  );
}

function isValidTaskSubagentSuspension(
  value: Record<PropertyKey, unknown>,
  acknowledgement: Record<string, unknown>,
): boolean {
  if (
    !hasExactOwnDataKeys(value, [
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
    !isBoundedIdentityString(value.toolCallId)
  ) {
    return false;
  }

  const parent = value.parent;
  if (!isValidSubagentSuspensionParent(parent, acknowledgement)) return false;
  if (!isValidPrivateSuspendedSubagentRecord(value.subagent, parent)) return false;
  if (!isValidSubagentBlockedToolIdentity(value.blockedTool)) return false;

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

  return isValidSubagentSuspensionEvent(
    value.event,
    value.toolCallId,
    blockedTool,
    subagentBlockedTool.reasonCode,
    blockedTool.runtimeToolCallId ?? blockedTool.toolCallId,
  );
}

function isValidSubagentSuspensionParent(
  value: unknown,
  acknowledgement: Record<string, unknown>,
): value is Record<PropertyKey, unknown> {
  return (
    isRecordObject(value) &&
    hasExactOwnDataKeys(value, ['toolCallId', 'invocationId', 'attemptId', 'attempt']) &&
    isBoundedIdentityString(value.toolCallId) &&
    isBoundedIdentityString(value.invocationId) &&
    isBoundedIdentityString(value.attemptId) &&
    isPositiveSafeInteger(value.attempt) &&
    value.toolCallId === acknowledgement.toolCallId &&
    value.invocationId === acknowledgement.invocationId &&
    value.attemptId === acknowledgement.attemptId &&
    value.attempt === acknowledgement.attempt
  );
}

function isValidPrivateSuspendedSubagentRecord(
  value: unknown,
  parent: Record<PropertyKey, unknown>,
): boolean {
  if (
    !isRecordObject(value) ||
    !hasExactOwnDataKeys(value, [
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
    !isBoundedIdentityString(value.subagentId) ||
    (value.role !== 'explore' &&
      value.role !== 'plan' &&
      value.role !== 'code' &&
      value.role !== 'review') ||
    !isBoundedIdentityString(value.continuationId) ||
    !isNonNegativeSafeInteger(value.modelInvocationOrdinal) ||
    !isValidSubagentContinuationArtifact(value.continuationArtifact) ||
    value.parentInvocationId !== parent.invocationId ||
    value.parentAttempt !== parent.attempt ||
    !isValidPrivateSuspendedSubagentBlockedTool(value.blockedTool)
  ) {
    return false;
  }
  return true;
}

function isValidSubagentContinuationArtifact(value: unknown): boolean {
  if (
    !isRecordObject(value) ||
    !hasExactOwnDataKeys(value, ['artifactId', 'kind', 'integrityIdentifier', 'byteLength'])
  ) {
    return false;
  }
  return (
    isBoundedIdentityString(value.artifactId) &&
    value.kind === 'subagent_continuation' &&
    isBoundedIdentityString(value.integrityIdentifier) &&
    isPositiveSafeInteger(value.byteLength)
  );
}

function isValidPrivateSuspendedSubagentBlockedTool(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
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
    !expectedKeys.every((key) => hasOwnDataProperty(value, key)) ||
    (value.reasonCode !== 'SUBAGENT_TOOL_REQUIRES_APPROVAL' &&
      value.reasonCode !== 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW') ||
    !isBoundedIdentityString(value.toolCallId) ||
    !isBoundedIdentityString(value.toolName)
  ) {
    return false;
  }
  return !hasRuntimeToolCallId || isBoundedIdentityString(value.runtimeToolCallId);
}

function isValidSubagentBlockedToolIdentity(value: unknown): boolean {
  if (
    !isRecordObject(value) ||
    !hasExactOwnDataKeys(value, [
      'toolCallId',
      'runtimeToolCallId',
      'toolName',
      'argumentsDigest',
      'commandDigest',
    ]) ||
    !isBoundedIdentityString(value.toolCallId) ||
    (value.runtimeToolCallId !== null && !isBoundedIdentityString(value.runtimeToolCallId)) ||
    !isBoundedIdentityString(value.toolName) ||
    !isBoundedIdentityString(value.argumentsDigest) ||
    (value.commandDigest !== null && !isBoundedIdentityString(value.commandDigest))
  ) {
    return false;
  }
  return true;
}

function isValidSubagentSuspensionEvent(
  value: unknown,
  parentToolCallId: unknown,
  blockedTool: Record<string, unknown>,
  subagentBlockedReasonCode: unknown,
  expectedApprovalCallId = blockedTool.toolCallId,
): boolean {
  if (!isRecordObject(value)) return false;
  const type = ownDataDescriptor(value, 'type')?.value;
  if (type === 'approval.requested') {
    if (
      !hasExactOptionalDataKeys(
        value,
        [
          'type',
          'interactionId',
          'toolCallId',
          'approval',
          'approvalRoute',
          'fullModeBypassEligible',
          'fullModePolicyBypassAllowed',
          'queueGeneration',
          'queueSequence',
          'parentToolCallId',
          'childSubagentId',
          'bindingDigest',
        ],
        ['runtimeToolCallId', 'commandIdentity', 'createdAt'],
      ) ||
      value.toolCallId !== parentToolCallId ||
      !isBoundedIdentityString(value.interactionId) ||
      value.approvalRoute !== 'user' ||
      typeof value.fullModeBypassEligible !== 'boolean' ||
      typeof value.fullModePolicyBypassAllowed !== 'boolean' ||
      !isNonNegativeSafeInteger(value.queueGeneration) ||
      !isNonNegativeSafeInteger(value.queueSequence) ||
      value.parentToolCallId !== parentToolCallId ||
      !isBoundedIdentityString(value.childSubagentId) ||
      !isBoundedIdentityString(value.bindingDigest) ||
      (Object.hasOwn(value, 'runtimeToolCallId') &&
        !isBoundedIdentityString(value.runtimeToolCallId)) ||
      (Object.hasOwn(value, 'commandIdentity') &&
        !isValidApprovalCommandIdentity(value.commandIdentity)) ||
      (Object.hasOwn(value, 'createdAt') && !isBoundedTextString(value.createdAt))
    ) {
      return false;
    }
    return (
      subagentBlockedReasonCode === 'SUBAGENT_TOOL_REQUIRES_APPROVAL' &&
      isValidSubagentApproval(value.approval, blockedTool, expectedApprovalCallId)
    );
  }
  if (value.type !== 'auto_review.requested') return false;
  if (
    !hasExactOptionalDataKeys(
      value,
      [
        'type',
        'reviewId',
        'toolCallId',
        'toolName',
        'reason',
        'approval',
        'approvalRoute',
        'fullModeBypassEligible',
        'fullModePolicyBypassAllowed',
        'queueGeneration',
        'queueSequence',
        'parentToolCallId',
        'childSubagentId',
        'bindingDigest',
      ],
      ['runtimeToolCallId', 'commandIdentity', 'requestFingerprint', 'createdAt'],
    ) ||
    value.toolCallId !== parentToolCallId ||
    !isBoundedIdentityString(value.reviewId) ||
    !isBoundedIdentityString(value.toolName) ||
    value.toolName !== blockedTool.toolName ||
    !isBoundedTextString(value.reason) ||
    value.approvalRoute !== 'auto' ||
    typeof value.fullModeBypassEligible !== 'boolean' ||
    typeof value.fullModePolicyBypassAllowed !== 'boolean' ||
    !isNonNegativeSafeInteger(value.queueGeneration) ||
    !isNonNegativeSafeInteger(value.queueSequence) ||
    value.parentToolCallId !== parentToolCallId ||
    !isBoundedIdentityString(value.childSubagentId) ||
    !isBoundedIdentityString(value.bindingDigest) ||
    (Object.hasOwn(value, 'runtimeToolCallId') &&
      !isBoundedIdentityString(value.runtimeToolCallId)) ||
    (Object.hasOwn(value, 'commandIdentity') &&
      !isValidApprovalCommandIdentity(value.commandIdentity)) ||
    (Object.hasOwn(value, 'requestFingerprint') &&
      !isBoundedIdentityString(value.requestFingerprint)) ||
    (Object.hasOwn(value, 'createdAt') && !isBoundedTextString(value.createdAt))
  ) {
    return false;
  }
  return (
    subagentBlockedReasonCode === 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' &&
    isValidSubagentApproval(value.approval, blockedTool, expectedApprovalCallId)
  );
}

function isValidSubagentApproval(
  value: unknown,
  blockedTool: Record<string, unknown>,
  expectedCallId = blockedTool.toolCallId,
): boolean {
  if (
    !isRecordObject(value) ||
    !hasExactOptionalDataKeys(
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
      [
        'plan',
        'subagentId',
        'reviewFailure',
        'sandboxScope',
        'approvalRoute',
        'queueSequence',
        'queueGeneration',
        'matchingPendingCount',
        'parentToolCallId',
        'childSubagentId',
        'bindingDigest',
      ],
    ) ||
    value.scope !== 'once' ||
    value.callId !== expectedCallId ||
    !isBoundedTextString(value.cwd, 4_096) ||
    !isBoundedIdentityString(value.threadId) ||
    !isBoundedTextString(value.tool) ||
    value.tool !== blockedTool.toolName ||
    !isBoundedTextString(value.command, 65_536) ||
    !isValidApprovalRisk(value.risk) ||
    !isBoundedIdentityString(value.approvalHash) ||
    !isBoundedTextString(value.summary) ||
    !isBoundedTextString(value.reason) ||
    !isBoundedStringArray(value.expectedEffects, 256) ||
    !isValidGrantArray(value.grantOptions) ||
    !isValidGrant(value.recommendedGrant) ||
    (Object.hasOwn(value, 'plan') && !isJsonValue(value.plan)) ||
    (Object.hasOwn(value, 'subagentId') && !isBoundedIdentityString(value.subagentId)) ||
    (Object.hasOwn(value, 'reviewFailure') && !isBoundedTextString(value.reviewFailure))
  ) {
    return false;
  }
  return true;
}

function isValidApprovalCommandIdentity(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  const required = [
    'sessionId',
    'threadId',
    'workspace',
    'canonicalWorkspaceIdentity',
    'cwd',
    'executor',
    'environment',
    'scope',
    'effects',
    'parserRevision',
    'commandDigest',
  ];
  if (
    !hasExactOptionalDataKeys(value, required, ['executorRevision']) ||
    !required.every((key) => isBoundedTextString(value[key], 4_096))
  ) {
    return false;
  }
  return (
    !Object.hasOwn(value, 'executorRevision') || isBoundedTextString(value.executorRevision, 4_096)
  );
}

function hasExactOptionalDataKeys(
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
  if (!requiredKeys.every((key) => hasOwnDataProperty(value, key))) return false;
  return keys.every(
    (key) =>
      typeof key === 'string' &&
      (requiredKeys.includes(key) || optionalKeys.includes(key)) &&
      hasOwnDataProperty(value, key),
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedTextString(value: unknown, maxLength = 65_536): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isBoundedStringArray(value: unknown, maxLength: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maxLength || !isJsonValue(value)) return false;
  return value.every((entry) => isBoundedTextString(entry));
}

function isValidGrant(value: unknown): boolean {
  return value === 'approve_once' || value === 'same_command';
}

function isValidApprovalRisk(value: unknown): boolean {
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

function isValidGrantArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3 || !isJsonValue(value))
    return false;
  return value.every((entry) => isValidGrant(entry));
}

function hasExactOwnDataKeys(value: object, expectedKeys: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => hasOwnDataProperty(value, key))
  );
}

function isValidTerminalFailure(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  const code = ownDataDescriptor(value, 'code');
  const message = ownDataDescriptor(value, 'message');
  const retryable = ownDataDescriptor(value, 'retryable');
  const modelFixable = ownDataDescriptor(value, 'modelFixable');
  const needsUserIntervention = ownDataDescriptor(value, 'needsUserIntervention');
  const terminatesTurn = ownDataDescriptor(value, 'terminatesTurn');
  const journal = ownDataDescriptor(value, 'journal');
  const parseFailureCode = ownDataDescriptor(value, 'parseFailureCode');
  const details = ownDataDescriptor(value, 'details');
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
      (details !== null && (details.value === undefined || isJsonValue(details.value))))
  );
}
