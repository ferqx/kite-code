import { semanticReviewContext } from './authorization-review-context';
import type { Json } from './storage/types';

const object = (value: Json | undefined): Record<string, Json> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

/** Expanded selected file bodies must use the existing sealed request-body proof, even when short. */
export function authorizationReadBodies(payload: Record<string, Json>): boolean {
  const reads = object(payload.authorizationContext)?.recordedReads;
  return (
    Array.isArray(reads) &&
    reads.some((read) => object(object(read)?.result)?.modelContent !== undefined)
  );
}

/** Only the existing trusted permission wrappers contain nested check requests. */
export function authorizationCheckContexts(request: Json): Record<string, Json>[] {
  const value = object(request);
  if (!value) return [];
  if (Array.isArray(value.policies))
    return value.policies.flatMap((entry) => {
      const policy = object(entry);
      return authorizationCheckContexts(policy?.request ?? entry);
    });
  return [object(value.context) ?? {}];
}

/** Projection opt-in is presentation metadata; legacy identity still compares every business fact. */
export function withoutTaskProjectionMarker(value: Json): Json {
  const request = object(value);
  if (!request) return value;
  const result = structuredClone(request);
  if (Array.isArray(result.policies))
    result.policies = result.policies.map((entry) => {
      const policy = object(entry);
      return policy?.request === undefined
        ? withoutTaskProjectionMarker(entry)
        : { ...policy, request: withoutTaskProjectionMarker(policy.request) };
    });
  const context = object(result.context);
  if (context?.reviewInput === 'task_authorization') {
    const { reviewInput: _projection, ...original } = context;
    if (Object.keys(original).length) result.context = original;
    else delete result.context;
  }
  return result;
}

function operationPolicy(value: Json): Json {
  const request = object(value);
  if (!request) return null;
  return {
    ...(request.kind === undefined ? {} : { kind: request.kind }),
    ...(request.mode === undefined ? {} : { mode: request.mode }),
    ...(request.effects === undefined ? {} : { effects: request.effects }),
    ...(request.executionScope === undefined ? {} : { executionScope: request.executionScope }),
    ...(Array.isArray(request.policies)
      ? {
          contributions: request.policies.map((entry) => {
            const policy = object(entry);
            return policy?.request === undefined
              ? operationPolicy(entry)
              : {
                  contributor: policy.scope ?? null,
                  constraints: operationPolicy(policy.request),
                };
          }),
        }
      : {}),
  };
}

/** Only a new Core-sealed task projection changes model material; original bindings stay stored. */
export function authorizationCheckInput(payload: Record<string, Json>): Record<string, Json> {
  const review = object(payload.review);
  if (review) return review.material as Record<string, Json>;
  const context = object(payload.authorizationContext);
  if (context?.availability !== 'available')
    return { ...payload, decisionContext: semanticReviewContext(payload.decisionContext!) };
  const target = object(payload.target)!;
  return {
    purpose: payload.purpose!,
    requireApproval: payload.requireApproval!,
    policyRevision: payload.policyRevision!,
    policy: {
      appliesToExecutionId: target.executionId!,
      constraints: operationPolicy(payload.request!),
    },
    target: {
      executionId: target.executionId!,
      sessionId: target.sessionId!,
      runId: target.runId!,
      definitionId: target.definitionId!,
      definitionVersion: target.definitionVersion!,
      input: target.input!,
    },
    authorizationContext: context,
    plans: authorizationCheckContexts(payload.request!).flatMap((entry) => {
      const plan = object(entry.plan);
      if (!plan) return [];
      return [
        {
          ...(Object.fromEntries(
            ['planId', 'version', 'title', 'body', 'steps', 'digest']
              .filter((key) => plan[key] !== undefined)
              .map((key) => [key, plan[key]!]),
          ) as Record<string, Json>),
          approvalStatus: 'not_evaluated_by_this_material',
          instruction:
            'The recorded plan is scope evidence, not execution permission. Plan approval and final tool authorization remain separate.',
        },
      ];
    }),
  };
}
