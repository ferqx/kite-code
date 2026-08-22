import {
  createRuntimeHostToolPipelineAttemptCoordinatorV1,
  type RuntimeHostCommittedToolInvocationAuthorityV1,
  type RuntimeHostPreparedToolInvocationAuthorityV1,
  type RuntimeHostRetryableToolInvocationAuthorityV1,
  type RuntimeHostSuspendedToolInvocationAuthorityV1,
  type RuntimeHostToolPipelineAttemptCoordinatorV1,
} from '@kite/runtime-host';
import type {
  CapabilityToolTerminalResultV1,
  PreparedToolInvocationIdentityV1,
  PreparedToolInvocationInputV1,
  RuntimeJsonValueV1,
  ToolPipelineOutcomeDispatchV1,
  ToolPipelinePersistenceV1,
} from '@kite/runtime-spi';

/**
 * The App-only composition of the Host attempt boundary and injected SPI
 * callbacks.  This seam owns no registry, snapshot, execution port, Store,
 * schema, effect, or policy implementation.
 */
export const APP_TOOL_PIPELINE_ATTEMPT_COMPOSITION_SCHEMA_V1 =
  'kite.app.tool-pipeline-attempt-composition.v1' as const;

export interface AppToolPipelineAttemptCompositionOptionsV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  /** App/Host persistence callbacks; this factory does not create a Store. */
  readonly persistence: ToolPipelinePersistenceV1<TValue>;
  /**
   * One exact Builtin verifier/dispatch bundle. The Host must receive both
   * methods from the same adapter so validation and dispatch cannot name
   * different projection authorities.
   */
  readonly dispatch: ToolPipelineOutcomeDispatchV1<TArguments, TValue>;
}

export interface AppToolPipelineAttemptCompositionV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof APP_TOOL_PIPELINE_ATTEMPT_COMPOSITION_SCHEMA_V1;
  /** The one Host coordinator composed for this App boundary. */
  readonly coordinator: RuntimeHostToolPipelineAttemptCoordinatorV1<TArguments, TRequest, TValue>;
  readonly prepare: RuntimeHostToolPipelineAttemptCoordinatorV1<
    TArguments,
    TRequest,
    TValue
  >['prepare'];
  readonly execute: RuntimeHostToolPipelineAttemptCoordinatorV1<
    TArguments,
    TRequest,
    TValue
  >['execute'];
  readonly assertCommitted: RuntimeHostToolPipelineAttemptCoordinatorV1<
    TArguments,
    TRequest,
    TValue
  >['assertCommitted'];
  readonly assertSuspended: RuntimeHostToolPipelineAttemptCoordinatorV1<
    TArguments,
    TRequest,
    TValue
  >['assertSuspended'];
  readonly assertRetryable: RuntimeHostToolPipelineAttemptCoordinatorV1<
    TArguments,
    TRequest,
    TValue
  >['assertRetryable'];
  /** The exact verifier reference supplied by Builtin, retained for wiring. */
  readonly verifyPreparedIdentity: ToolPipelineOutcomeDispatchV1<
    TArguments,
    TValue
  >['verifyPreparedIdentity'];
}

/**
 * Compose one App attempt seam from the existing Host coordinator.
 *
 * The verifier reference is passed through unchanged.  Host controls only
 * authenticity, acknowledgement ordering, and uncertainty; the opaque
 * dispatch and persistence callbacks remain the injected owners of execution
 * and durable receipts.
 */
export function createAppToolPipelineAttemptCompositionV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
>(
  options: AppToolPipelineAttemptCompositionOptionsV1<TArguments, TValue>,
): AppToolPipelineAttemptCompositionV1<TArguments, TRequest, TValue> {
  if (
    !options ||
    typeof options !== 'object' ||
    !options.persistence ||
    typeof options.persistence.recordAttempt !== 'function' ||
    typeof options.persistence.recordUnknown !== 'function' ||
    typeof options.persistence.commitTerminal !== 'function' ||
    typeof options.persistence.commitSuspension !== 'function' ||
    !options.dispatch ||
    typeof options.dispatch.verifyPreparedIdentity !== 'function' ||
    typeof options.dispatch.dispatch !== 'function'
  ) {
    throw new TypeError('App Tool Pipeline attempt composition inputs are invalid.');
  }

  const verifyPreparedIdentity = options.dispatch.verifyPreparedIdentity;
  const coordinator = createRuntimeHostToolPipelineAttemptCoordinatorV1<
    TArguments,
    TRequest,
    TValue
  >({
    persistence: options.persistence,
    // Keep this exact bundle: Host must not reconstruct or reinterpret
    // Builtin identity, and no second verifier may appear at this seam.
    dispatch: options.dispatch,
  });

  return Object.freeze({
    schema: APP_TOOL_PIPELINE_ATTEMPT_COMPOSITION_SCHEMA_V1,
    coordinator,
    prepare: coordinator.prepare,
    execute: coordinator.execute,
    assertCommitted: coordinator.assertCommitted,
    assertSuspended: coordinator.assertSuspended,
    assertRetryable: coordinator.assertRetryable,
    verifyPreparedIdentity,
  });
}

export type AppToolPipelinePreparedAuthorityV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = RuntimeHostPreparedToolInvocationAuthorityV1<TArguments, TRequest>;

export type AppToolPipelineCommittedAuthorityV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = RuntimeHostCommittedToolInvocationAuthorityV1<TValue>;

export type AppToolPipelineSuspendedAuthorityV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = RuntimeHostSuspendedToolInvocationAuthorityV1<TValue>;

export type AppToolPipelineRetryableAuthorityV1<
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = RuntimeHostRetryableToolInvocationAuthorityV1<TValue>;

export type AppToolPipelineAttemptInputV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TRequest extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = Readonly<PreparedToolInvocationInputV1<TArguments, TRequest>>;

export type AppToolPipelineAttemptIdentityV1 = Readonly<PreparedToolInvocationIdentityV1>;

export type AppToolPipelineAttemptResultV1<TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1> =
  Readonly<CapabilityToolTerminalResultV1<TValue>>;

export type AppToolPipelineAttemptDispatchV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> = ToolPipelineOutcomeDispatchV1<TArguments, TValue>['dispatch'];
