import { digestCapability } from '@/core/capabilities/catalog';
import {
  completedTaskExecutionResult,
  type GovernedToolInvocationInput,
  invokeGovernedTool,
} from '@/core/harness/tool-runner';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import {
  rejectShellOutsideSubAgentRoleCeiling,
  resolveSubAgentShellExecutor,
  resumeSubAgent,
} from '@/core/subagent/runner';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import {
  type AdmittedInvocationV1,
  type DispatchedOutcomeV1,
  type RecordedInvocationV1,
  TOOL_PIPELINE_STAGE_SCHEMA_V1,
} from './types';

const acknowledgedInvocations = new WeakSet<object>();

export interface ToolInvocationPersistenceV1 {
  getState(): Readonly<RuntimeState>;
  persistEvents(events: RuntimeEvent[]): Promise<boolean>;
}

export interface ToolInvocationRecordContextV1 {
  threadId: string;
  toolCallId: string;
  taskId?: string;
  planId?: string;
  planStepId?: string;
  now?: () => Date;
  persistence: ToolInvocationPersistenceV1;
}

export interface ToolInvocationDispatchAdapterV1 {
  dispatch(
    input: GovernedToolInvocationInput,
  ): Promise<import('@/core/harness/tool-result').ToolExecutionResult>;
}

export type ToolInvocationDispatchOutcomeV1 =
  | {
      readonly kind: 'not_dispatched';
      readonly result: import('@/core/harness/tool-result').ToolExecutionResult;
    }
  | { readonly kind: 'dispatched'; readonly value: Readonly<DispatchedOutcomeV1> };

export class ToolInvocationPersistenceErrorV1 extends Error {
  readonly code = 'tool_invocation_persistence_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'ToolInvocationPersistenceErrorV1';
  }
}

export class ToolInvocationDispatchErrorV1 extends Error {
  readonly recorded: Readonly<RecordedInvocationV1> | null;
  readonly causeValue: unknown;

  constructor(causeValue: unknown, recorded: Readonly<RecordedInvocationV1> | null) {
    super(causeValue instanceof Error ? causeValue.message : 'Tool dispatch failed.');
    this.name = 'ToolInvocationDispatchErrorV1';
    this.recorded = recorded;
    this.causeValue = causeValue;
  }
}

const productionAdapter: ToolInvocationDispatchAdapterV1 = Object.freeze({
  dispatch: invokeGovernedTool,
});

/** Concrete Subagent adapter exports kept behind the Tool Pipeline boundary. */
export const completedSubagentToolResultV1 = completedTaskExecutionResult;
export const rejectSubagentShellOutsideRoleCeilingV1 = rejectShellOutsideSubAgentRoleCeiling;
export const resolveSubagentShellExecutorV1 = resolveSubAgentShellExecutor;
export const resumeSubagentAdapterV1 = resumeSubAgent;
export const dispatchSubagentForkAdapterV1 = runTaskSubAgent;

/**
 * The only production entry into builtin, MCP, Skill, and Subagent adapters.
 * The adapter's beforeDispatch hook cannot return until intent and attempt have
 * both been durably acknowledged by the execution context.
 */
export async function dispatchAdmittedToolInvocationV1(
  admitted: Readonly<AdmittedInvocationV1>,
  input: GovernedToolInvocationInput,
  context: ToolInvocationRecordContextV1,
  adapter: ToolInvocationDispatchAdapterV1 = productionAdapter,
): Promise<ToolInvocationDispatchOutcomeV1> {
  assertAdmitted(admitted, context.toolCallId);
  const identity = invocationIdentity(admitted, context);
  const existingBeforeDispatch = input.beforeDispatch;
  let recorded: Readonly<RecordedInvocationV1> | null = null;
  const request = withIdempotencyKey(input.request, admitted, identity.invocationId);
  try {
    const result = await adapter.dispatch({
      ...input,
      request,
      beforeDispatch: async () => {
        await existingBeforeDispatch?.();
        if (recorded) {
          throw new ToolInvocationPersistenceErrorV1(
            'A governed Tool adapter attempted to enter dispatch more than once.',
          );
        }
        recorded = await recordAttempt(admitted, context, identity);
      },
    });
    if (!recorded) return { kind: 'not_dispatched', result };
    if (!acknowledgedInvocations.has(recorded)) {
      throw new ToolInvocationPersistenceErrorV1(
        'Tool invocation acknowledgement token is unavailable.',
      );
    }
    return {
      kind: 'dispatched',
      value: Object.freeze({
        schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
        stage: 'dispatched' as const,
        recorded,
        result,
      }),
    };
  } catch (error) {
    if (error instanceof ToolInvocationPersistenceErrorV1) throw error;
    throw new ToolInvocationDispatchErrorV1(error, recorded);
  }
}

async function recordAttempt(
  admitted: Readonly<AdmittedInvocationV1>,
  context: ToolInvocationRecordContextV1,
  identity: ReturnType<typeof invocationIdentity>,
): Promise<Readonly<RecordedInvocationV1>> {
  const before = context.persistence.getState();
  const existing = before.capabilities.invocations[identity.invocationId];
  if (existing && existing.toolCallId !== context.toolCallId) {
    throw new ToolInvocationPersistenceErrorV1('Tool invocation identity collided.');
  }
  if (existing && !['recorded', 'running'].includes(existing.status)) {
    throw new ToolInvocationPersistenceErrorV1(
      'A terminal Tool invocation cannot dispatch another attempt.',
    );
  }
  const attempt = (existing?.attemptsStarted ?? 0) + 1;
  const now = context.now?.() ?? new Date();
  const recordedAt = existing?.recordedAt ?? now.toISOString();
  const startedAt = now.toISOString();
  const events: RuntimeEvent[] = [];
  if (!existing) {
    events.push({
      type: 'capability.invocation_recorded',
      invocationId: identity.invocationId,
      toolCallId: context.toolCallId,
      capabilityId: identity.capabilityId,
      capabilityRevision: identity.capabilityRevision,
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.planId ? { planId: context.planId } : {}),
      ...(context.planStepId ? { planStepId: context.planStepId } : {}),
      argumentsDigest: identity.argumentsDigest,
      authorizationDigest: admitted.authorized.authorizationDigest,
      admissionDigest: admitted.admissionDigest,
      effectiveEffectsDigest: identity.effectiveEffectsDigest,
      effectiveEffects: identity.effectiveEffects,
      receiptRequirement: identity.receiptRequirement,
      retryEligibility: identity.retryEligibility,
      recordedAt,
      ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
    });
  }
  events.push({
    type: 'capability.execution_started',
    invocationId: identity.invocationId,
    startedAt,
    attempt,
  });
  let persisted = false;
  try {
    persisted = await context.persistence.persistEvents(events);
  } catch {
    throw new ToolInvocationPersistenceErrorV1(
      'Tool invocation intent could not be durably persisted before dispatch.',
    );
  }
  if (!persisted) {
    throw new ToolInvocationPersistenceErrorV1(
      'Tool invocation intent became stale before durable persistence.',
    );
  }
  const after = context.persistence.getState().capabilities.invocations[identity.invocationId];
  if (
    after?.status !== 'running' ||
    (after.attemptsStarted ?? 0) < attempt ||
    after.argumentsDigest !== identity.argumentsDigest ||
    after.authorizationDigest !== admitted.authorized.authorizationDigest
  ) {
    throw new ToolInvocationPersistenceErrorV1(
      'Tool invocation acknowledgement does not match the dispatched request.',
    );
  }
  const token = Object.freeze({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'recorded' as const,
    admitted,
    invocationId: identity.invocationId,
    attempt,
    idempotencyKey: identity.idempotencyKey,
    recordedAt,
    startedAt,
  } satisfies RecordedInvocationV1);
  acknowledgedInvocations.add(token);
  return token;
}

function invocationIdentity(
  admitted: Readonly<AdmittedInvocationV1>,
  context: ToolInvocationRecordContextV1,
) {
  const classified = admitted.authorized.policy.classified;
  const descriptor = classified.validated.resolved.target.descriptor;
  const argumentsDigest = classified.validated.request.argumentsDigest;
  const invocationId = digestCapability({
    schema: 'kite.tool-invocation-identity.v1',
    threadId: context.threadId,
    toolCallId: context.toolCallId,
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    argumentsDigest,
    authorizationDigest: admitted.authorized.authorizationDigest,
    admissionDigest: admitted.admissionDigest,
  });
  const idempotencyKey =
    classified.requirements.retry === 'idempotency_key_candidate' &&
    classified.requirements.idempotencyKeyArgument
      ? digestCapability({
          schema: 'kite.tool-idempotency-key.v1',
          invocationId,
          capabilityId: descriptor.capabilityId,
        })
      : null;
  return {
    invocationId,
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    argumentsDigest,
    effectiveEffects: classified.effectiveEffects,
    effectiveEffectsDigest: classified.effectiveEffectsDigest,
    receiptRequirement: classified.requirements.receipt,
    retryEligibility: classified.requirements.retry,
    idempotencyKey,
  } as const;
}

function withIdempotencyKey(
  request: GovernedToolInvocationInput['request'],
  admitted: Readonly<AdmittedInvocationV1>,
  invocationId: string,
): GovernedToolInvocationInput['request'] {
  const argument = admitted.authorized.policy.classified.requirements.idempotencyKeyArgument;
  if (!argument) return request;
  return {
    ...request,
    args: {
      ...(request.args as Record<string, unknown>),
      [argument]: digestCapability({
        schema: 'kite.tool-idempotency-key.v1',
        invocationId,
        capabilityId:
          admitted.authorized.policy.classified.validated.resolved.target.descriptor.capabilityId,
      }),
    },
  } as GovernedToolInvocationInput['request'];
}

function assertAdmitted(admitted: Readonly<AdmittedInvocationV1>, toolCallId: string): void {
  if (
    admitted.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 ||
    admitted.stage !== 'admitted' ||
    admitted.authorized.policy.classified.validated.resolved.call.toolCallId !== toolCallId ||
    admitted.authorized.policy.classified.requirements.intent !== 'required_before_dispatch'
  ) {
    throw new ToolInvocationPersistenceErrorV1(
      'Only a matching admitted Tool invocation may enter dispatch.',
    );
  }
}
