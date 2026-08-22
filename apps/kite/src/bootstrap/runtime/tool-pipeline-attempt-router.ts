import type {
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineDispatchOutcomeV1,
  ToolPipelineOutcomeDispatchV1,
  ToolPipelinePreparedIdentityVerificationResultV1,
} from '@kite/runtime-spi';

export const APP_TOOL_PIPELINE_ATTEMPT_ROUTER_SCHEMA_V1 =
  'kite.app.tool-pipeline-attempt-router.v1' as const;

export type AppToolPipelineAttemptRouterFailureCodeV1 =
  | 'invalid_binding'
  | 'duplicate_binding'
  | 'unbound_prepared'
  | 'unverified_dispatch'
  | 'duplicate_dispatch';

export class AppToolPipelineAttemptRouterErrorV1 extends Error {
  readonly code: AppToolPipelineAttemptRouterFailureCodeV1;

  constructor(code: AppToolPipelineAttemptRouterFailureCodeV1) {
    super(`App Tool Pipeline attempt router failed closed: ${code}.`);
    this.name = 'AppToolPipelineAttemptRouterErrorV1';
    this.code = code;
  }
}

export interface AppToolPipelineAttemptRouterV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
> {
  readonly schema: typeof APP_TOOL_PIPELINE_ATTEMPT_ROUTER_SCHEMA_V1;
  /** The one callback bundle supplied to the effect-scoped Host coordinator. */
  readonly dispatch: ToolPipelineOutcomeDispatchV1<TArguments, TValue>;
  /** Bind one Host-issued prepared authority to its exact turn-local Builtin callback bundle. */
  readonly bind: (
    prepared: Readonly<PreparedToolInvocationV1<TArguments>>,
    dispatch: ToolPipelineOutcomeDispatchV1<TArguments, TValue>,
  ) => void;
}

interface BoundDispatchV1<
  TArguments extends RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1,
> {
  readonly dispatch: ToolPipelineOutcomeDispatchV1<TArguments, TValue>;
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
export function createAppToolPipelineAttemptRouterV1<
  TArguments extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
  TValue extends RuntimeJsonValueV1 = RuntimeJsonValueV1,
>(): AppToolPipelineAttemptRouterV1<TArguments, TValue> {
  const bindings = new WeakMap<object, BoundDispatchV1<TArguments, TValue>>();

  const bind = (
    prepared: Readonly<PreparedToolInvocationV1<TArguments>>,
    dispatch: ToolPipelineOutcomeDispatchV1<TArguments, TValue>,
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
      throw new AppToolPipelineAttemptRouterErrorV1('invalid_binding');
    }
    if (bindings.has(prepared)) {
      throw new AppToolPipelineAttemptRouterErrorV1('duplicate_binding');
    }
    bindings.set(prepared, { dispatch, verified: false, dispatched: false });
  };

  const verifyPreparedIdentity = (
    prepared: Readonly<PreparedToolInvocationV1<TArguments>>,
  ): boolean | ToolPipelinePreparedIdentityVerificationResultV1 => {
    const bound = bindings.get(prepared);
    if (!bound || bound.dispatched) return invalidIdentityV1();
    const verification = bound.dispatch.verifyPreparedIdentity(prepared);
    if (verification === true || (verification !== false && verification.valid === true)) {
      bound.verified = true;
    }
    return verification;
  };

  const dispatchPrepared = async (
    prepared: Readonly<PreparedToolInvocationV1<TArguments>>,
  ): Promise<Readonly<ToolPipelineDispatchOutcomeV1<TValue>>> => {
    const bound = bindings.get(prepared);
    if (!bound) throw new AppToolPipelineAttemptRouterErrorV1('unbound_prepared');
    if (!bound.verified) {
      throw new AppToolPipelineAttemptRouterErrorV1('unverified_dispatch');
    }
    if (bound.dispatched) {
      throw new AppToolPipelineAttemptRouterErrorV1('duplicate_dispatch');
    }
    bound.dispatched = true;
    return bound.dispatch.dispatch(prepared);
  };

  return Object.freeze({
    schema: APP_TOOL_PIPELINE_ATTEMPT_ROUTER_SCHEMA_V1,
    dispatch: Object.freeze({ verifyPreparedIdentity, dispatch: dispatchPrepared }),
    bind,
  });
}

function invalidIdentityV1(): ToolPipelinePreparedIdentityVerificationResultV1 {
  return Object.freeze({ valid: false, code: 'identity_mismatch' });
}
