import { describe, expect, test } from 'bun:test';
import type {
  NonDynamicOperationId,
  NonDynamicPreparedToolInvocationIdentity,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineOutcomeDispatch,
} from '@kite-ai/runtime-spi';
import {
  APP_TOOL_PIPELINE_ATTEMPT_ROUTER_SCHEMA_,
  AppToolPipelineAttemptRouterError,
  createAppToolPipelineAttemptRouter,
} from '#app/bootstrap/runtime/tool-pipeline-attempt-router';

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function prepared(id: string): Readonly<PreparedToolInvocation> {
  const identity: NonDynamicPreparedToolInvocationIdentity = {
    invocationId: `invocation-${id}`,
    attemptId: `invocation-${id}:attempt:1`,
    toolCallId: `call-${id}`,
    turnId: 'turn-1',
    modelMessageId: 'message-1',
    argumentOrigin: 'model_public',
    providerId: 'builtin-runtime',
    operationId: 'builtin:read_plan' as NonDynamicOperationId,
    executionFamily: 'builtin',
    executionMechanism: 'planning',
    capabilityId: 'builtin:read_plan',
    capabilityRevision: 'capability-1',
    descriptorRevision: 'descriptor-1',
    parserRevision: 'parser-1',
    executorRevision: 'executor-1',
    argumentsDigest: 'arguments-1',
    schemaDigest: 'schema-1',
    effectiveEffectsDigest: 'effects-1',
    policyDigest: 'policy-1',
    authorizationDigest: 'authorization-1',
    admissionDigest: 'admission-1',
    idempotencyKeyArgument: null,
    idempotencyKey: null,
    bindingId: null,
    visibility: 'model',
    modelVisible: true,
    exposedToolName: 'read_plan',
    builtinProjectionRevision: 'builtin-1',
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    isDynamicMcp: false,
    toolKind: 'computer',
  };
  return deepFreeze({
    identity,
    input: {
      invocationId: identity.invocationId,
      attemptId: identity.attemptId,
      toolCallId: identity.toolCallId,
      arguments: {},
      binding: null,
      facts: {},
    },
  });
}

function exactDispatch(calls: string[], id: string): ToolPipelineOutcomeDispatch {
  return Object.freeze({
    verifyPreparedIdentity: (candidate: Readonly<PreparedToolInvocation>) => {
      calls.push(`verify:${id}`);
      return candidate.identity.invocationId === `invocation-${id}`;
    },
    dispatch: async () => {
      calls.push(`dispatch:${id}`);
      return Object.freeze({
        kind: 'committed' as const,
        terminal: Object.freeze({
          status: 'success' as const,
          content: Object.freeze([] as RuntimeJsonValue[]),
          structuredContent: Object.freeze({ id }),
        }),
      });
    },
  });
}

describe('App Tool Pipeline effect-scoped attempt router', () => {
  test('binds two prepared authorities to their exact callbacks without cross-routing', async () => {
    const calls: string[] = [];
    const router = createAppToolPipelineAttemptRouter();
    const first = prepared('one');
    const second = prepared('two');
    router.bind(first, exactDispatch(calls, 'one'));
    router.bind(second, exactDispatch(calls, 'two'));

    expect(router.schema).toBe(APP_TOOL_PIPELINE_ATTEMPT_ROUTER_SCHEMA_);
    expect(router.dispatch.verifyPreparedIdentity(first)).toBe(true);
    expect(router.dispatch.verifyPreparedIdentity(second)).toBe(true);
    const firstOutcome = await router.dispatch.dispatch(first);
    const secondOutcome = await router.dispatch.dispatch(second);
    expect(firstOutcome.kind === 'committed' && firstOutcome.terminal.structuredContent).toEqual({
      id: 'one',
    });
    expect(secondOutcome.kind === 'committed' && secondOutcome.terminal.structuredContent).toEqual({
      id: 'two',
    });
    expect(calls).toEqual(['verify:one', 'verify:two', 'dispatch:one', 'dispatch:two']);
  });

  test('fails closed for unbound, duplicate, unverified, and post-dispatch use', async () => {
    const calls: string[] = [];
    const router = createAppToolPipelineAttemptRouter();
    const authority = prepared('one');
    const dispatch = exactDispatch(calls, 'one');
    expect(router.dispatch.verifyPreparedIdentity(authority)).toEqual({
      valid: false,
      code: 'identity_mismatch',
    });
    await expect(router.dispatch.dispatch(authority)).rejects.toMatchObject({
      code: 'unbound_prepared',
    });

    router.bind(authority, dispatch);
    expect(() => router.bind(authority, dispatch)).toThrow(AppToolPipelineAttemptRouterError);
    await expect(router.dispatch.dispatch(authority)).rejects.toMatchObject({
      code: 'unverified_dispatch',
    });
    expect(router.dispatch.verifyPreparedIdentity(authority)).toBe(true);
    await router.dispatch.dispatch(authority);
    expect(router.dispatch.verifyPreparedIdentity(authority)).toEqual({
      valid: false,
      code: 'identity_mismatch',
    });
    await expect(router.dispatch.dispatch(authority)).rejects.toMatchObject({
      code: 'duplicate_dispatch',
    });
    expect(calls).toEqual(['verify:one', 'dispatch:one']);
  });

  test('rejects mutable prepared packets and never invokes an alternate callback after throw', async () => {
    const router = createAppToolPipelineAttemptRouter();
    expect(() =>
      router.bind(
        {
          identity: prepared('one').identity,
          input: prepared('one').input,
        },
        exactDispatch([], 'one'),
      ),
    ).toThrow(AppToolPipelineAttemptRouterError);

    const calls: string[] = [];
    const authority = prepared('one');
    router.bind(authority, {
      verifyPreparedIdentity: () => true,
      dispatch: async () => {
        calls.push('throw');
        throw new Error('provider failed');
      },
    });
    expect(router.dispatch.verifyPreparedIdentity(authority)).toBe(true);
    await expect(router.dispatch.dispatch(authority)).rejects.toThrow('provider failed');
    await expect(router.dispatch.dispatch(authority)).rejects.toMatchObject({
      code: 'duplicate_dispatch',
    });
    expect(calls).toEqual(['throw']);
  });
});
