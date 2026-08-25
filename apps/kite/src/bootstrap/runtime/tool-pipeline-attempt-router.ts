import type {
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineDispatchOutcome,
  ToolPipelineOutcomeDispatch,
  ToolPipelinePreparedIdentityVerificationResult,
} from '@kite-ai/runtime-spi';

export const APP_TOOL_PIPELINE_ATTEMPT_ROUTER_SCHEMA_ =
  'kite.app.tool-pipeline-attempt-router.v1' as const;

export type AppToolPipelineAttemptRouterFailureCode =
  | 'invalid_binding'
  | 'duplicate_binding'
  | 'unbound_prepared'
  | 'unverified_dispatch'
  | 'duplicate_dispatch';

export class AppToolPipelineAttemptRouterError extends Error {
  readonly code: AppToolPipelineAttemptRouterFailureCode;

  constructor(code: AppToolPipelineAttemptRouterFailureCode) {
    super(`App Tool Pipeline attempt router failed closed: ${code}.`);
    this.name = 'AppToolPipelineAttemptRouterError';
    this.code = code;
  }
}

export interface AppToolPipelineAttemptRouter<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly schema: typeof APP_TOOL_PIPELINE_ATTEMPT_ROUTER_SCHEMA_;
  /** The one callback bundle supplied to the effect-scoped Host coordinator. */
  readonly dispatch: ToolPipelineOutcomeDispatch<TArguments, TValue>;
  /** Bind one Host-issued prepared authority to its exact turn-local Builtin callback bundle. */
  readonly bind: (
    prepared: Readonly<PreparedToolInvocation<TArguments>>,
    dispatch: ToolPipelineOutcomeDispatch<TArguments, TValue>,
  ) => void;
}

interface BoundDispatch<TArguments extends RuntimeJsonValue, TValue extends RuntimeJsonValue> {
  readonly dispatch: ToolPipelineOutcomeDispatch<TArguments, TValue>;
  verified: boolean;
  dispatched: boolean;
}

/**
 * Create one process-local router for one run_tools effect.
 *
 * The router owns no registry, parser, policy, persistence, or executor. It
 * only preserves the exact association between a Host-issued prepared object
 * and the turn-local Builtin verifier/dispatch bundle selected by App
 * composition. The binding is single-use and is consumed before the first
 * dispatch await, so no thrown callback can activate a fallback.
 */
export function createAppToolPipelineAttemptRouter<
  TArguments extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
>(): AppToolPipelineAttemptRouter<TArguments, TValue> {
  const bindings = new WeakMap<object, BoundDispatch<TArguments, TValue>>();

  const bind = (
    prepared: Readonly<PreparedToolInvocation<TArguments>>,
    dispatch: ToolPipelineOutcomeDispatch<TArguments, TValue>,
  ): void => {
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      !Object.isFrozen(prepared) ||
      !Object.isFrozen(prepared.identity) ||
      !Object.isFrozen(prepared.input) ||
      !dispatch ||
      typeof dispatch.verifyPreparedIdentity !== 'function' ||
      typeof dispatch.dispatch !== 'function'
    ) {
      throw new AppToolPipelineAttemptRouterError('invalid_binding');
    }
    if (bindings.has(prepared)) {
      throw new AppToolPipelineAttemptRouterError('duplicate_binding');
    }
    bindings.set(prepared, { dispatch, verified: false, dispatched: false });
  };

  const verifyPreparedIdentity = (
    prepared: Readonly<PreparedToolInvocation<TArguments>>,
  ): boolean | ToolPipelinePreparedIdentityVerificationResult => {
    const bound = bindings.get(prepared);
    if (!bound || bound.dispatched) return invalidIdentity();
    const verification = bound.dispatch.verifyPreparedIdentity(prepared);
    if (verification === true || (verification !== false && verification.valid === true)) {
      bound.verified = true;
    }
    return verification;
  };

  const dispatchPrepared = async (
    prepared: Readonly<PreparedToolInvocation<TArguments>>,
  ): Promise<Readonly<ToolPipelineDispatchOutcome<TValue>>> => {
    const bound = bindings.get(prepared);
    if (!bound) throw new AppToolPipelineAttemptRouterError('unbound_prepared');
    if (!bound.verified) {
      throw new AppToolPipelineAttemptRouterError('unverified_dispatch');
    }
    if (bound.dispatched) {
      throw new AppToolPipelineAttemptRouterError('duplicate_dispatch');
    }
    bound.dispatched = true;
    return bound.dispatch.dispatch(prepared);
  };

  return Object.freeze({
    schema: APP_TOOL_PIPELINE_ATTEMPT_ROUTER_SCHEMA_,
    dispatch: Object.freeze({ verifyPreparedIdentity, dispatch: dispatchPrepared }),
    bind,
  });
}

function invalidIdentity(): ToolPipelinePreparedIdentityVerificationResult {
  return Object.freeze({ valid: false, code: 'identity_mismatch' });
}
