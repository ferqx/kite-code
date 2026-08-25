import {
  createRuntimeHostToolPipelineAttemptCoordinator,
  type RuntimeHostCommittedToolInvocationAuthority,
  type RuntimeHostPreparedToolInvocationAuthority,
  type RuntimeHostRetryableToolInvocationAuthority,
  type RuntimeHostSuspendedToolInvocationAuthority,
  type RuntimeHostToolPipelineAttemptCoordinator,
} from '@kite-ai/runtime-host';
import type {
  CapabilityToolTerminalResult,
  PreparedToolInvocationIdentity,
  PreparedToolInvocationInput,
  RuntimeJsonValue,
  ToolPipelineOutcomeDispatch,
  ToolPipelinePersistence,
} from '@kite-ai/runtime-spi';

/**
 * The App-only composition of the Host attempt boundary and injected SPI
 * callbacks.  This seam owns no registry, snapshot, execution port, Store,
 * schema, effect, or policy implementation.
 */
export const APP_TOOL_PIPELINE_ATTEMPT_COMPOSITION_SCHEMA_ =
  'kite.app.tool-pipeline-attempt-composition.v1' as const;

export interface AppToolPipelineAttemptCompositionOptions<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  /** App/Host persistence callbacks; this factory does not create a Store. */
  readonly persistence: ToolPipelinePersistence<TValue>;
  /**
   * One exact Builtin verifier/dispatch bundle. The Host must receive both
   * methods from the same adapter so validation and dispatch cannot name
   * different projection authorities.
   */
  readonly dispatch: ToolPipelineOutcomeDispatch<TArguments, TValue>;
}

export interface AppToolPipelineAttemptComposition<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly schema: typeof APP_TOOL_PIPELINE_ATTEMPT_COMPOSITION_SCHEMA_;
  /** The one Host coordinator composed for this App boundary. */
  readonly coordinator: RuntimeHostToolPipelineAttemptCoordinator<TArguments, TRequest, TValue>;
  readonly prepare: RuntimeHostToolPipelineAttemptCoordinator<
    TArguments,
    TRequest,
    TValue
  >['prepare'];
  readonly execute: RuntimeHostToolPipelineAttemptCoordinator<
    TArguments,
    TRequest,
    TValue
  >['execute'];
  readonly assertCommitted: RuntimeHostToolPipelineAttemptCoordinator<
    TArguments,
    TRequest,
    TValue
  >['assertCommitted'];
  readonly assertSuspended: RuntimeHostToolPipelineAttemptCoordinator<
    TArguments,
    TRequest,
    TValue
  >['assertSuspended'];
  readonly assertRetryable: RuntimeHostToolPipelineAttemptCoordinator<
    TArguments,
    TRequest,
    TValue
  >['assertRetryable'];
  /** The exact verifier reference supplied by Builtin, retained for wiring. */
  readonly verifyPreparedIdentity: ToolPipelineOutcomeDispatch<
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
export function createAppToolPipelineAttemptComposition<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
>(
  options: AppToolPipelineAttemptCompositionOptions<TArguments, TValue>,
): AppToolPipelineAttemptComposition<TArguments, TRequest, TValue> {
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
  const coordinator = createRuntimeHostToolPipelineAttemptCoordinator<TArguments, TRequest, TValue>(
    {
      persistence: options.persistence,
      // Keep this exact bundle: Host must not reconstruct or reinterpret
      // Builtin identity, and no second verifier may appear at this seam.
      dispatch: options.dispatch,
    },
  );

  return Object.freeze({
    schema: APP_TOOL_PIPELINE_ATTEMPT_COMPOSITION_SCHEMA_,
    coordinator,
    prepare: coordinator.prepare,
    execute: coordinator.execute,
    assertCommitted: coordinator.assertCommitted,
    assertSuspended: coordinator.assertSuspended,
    assertRetryable: coordinator.assertRetryable,
    verifyPreparedIdentity,
  });
}

export type AppToolPipelinePreparedAuthority<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> = RuntimeHostPreparedToolInvocationAuthority<TArguments, TRequest>;

export type AppToolPipelineCommittedAuthority<TValue extends RuntimeJsonValue = RuntimeJsonValue> =
  RuntimeHostCommittedToolInvocationAuthority<TValue>;

export type AppToolPipelineSuspendedAuthority<TValue extends RuntimeJsonValue = RuntimeJsonValue> =
  RuntimeHostSuspendedToolInvocationAuthority<TValue>;

export type AppToolPipelineRetryableAuthority<TValue extends RuntimeJsonValue = RuntimeJsonValue> =
  RuntimeHostRetryableToolInvocationAuthority<TValue>;

export type AppToolPipelineAttemptInput<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TRequest extends RuntimeJsonValue = RuntimeJsonValue,
> = Readonly<PreparedToolInvocationInput<TArguments, TRequest>>;

export type AppToolPipelineAttemptIdentity = Readonly<PreparedToolInvocationIdentity>;

export type AppToolPipelineAttemptResult<TValue extends RuntimeJsonValue = RuntimeJsonValue> =
  Readonly<CapabilityToolTerminalResult<TValue>>;

export type AppToolPipelineAttemptDispatch<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> = ToolPipelineOutcomeDispatch<TArguments, TValue>['dispatch'];
