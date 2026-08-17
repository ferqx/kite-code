import { digestCapability } from '@/core/capabilities/catalog';
import { computeExecutionBoundaryDigestV1 } from '@/core/config/index';
import {
  completedTaskExecutionResult,
  type GovernedToolInvocationInput,
  invokeGovernedTool,
} from '@/core/harness/tool-runner';
import { createProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import {
  rejectShellOutsideSubAgentRoleCeiling,
  resolveSubAgentShellExecutor,
  resumeSubAgent,
} from '@/core/subagent/runner';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import {
  assertAcknowledgedRecordedInvocationV1,
  issueAcknowledgedRecordedInvocationV1,
  issueAdapterDispatchedOutcomeV1,
  issueConfirmedFailureDispatchedOutcomeV1,
} from './dispatch-authority';
import { bindWorkspaceFilesystemObservationResultV1 } from './filesystem-observation-authority';
import {
  type AdmittedInvocationV1,
  type DispatchedOutcomeV1,
  type RecordedInvocationV1,
  TOOL_PIPELINE_STAGE_SCHEMA_V1,
} from './types';
import {
  createWorkspaceFilesystemInvocationDispatcherV1,
  type WorkspaceFilesystemRuntimeV1,
} from './workspace-filesystem';

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
  /** Explicit production/test composition; absence makes filesystem tools fail closed. */
  filesystemRuntime?: WorkspaceFilesystemRuntimeV1;
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
    if (recorded) assertAcknowledgedRecordedInvocationV1(recorded);
    this.name = 'ToolInvocationDispatchErrorV1';
    this.recorded = recorded;
    this.causeValue = causeValue;
  }
}

export interface ConfirmedToolDispatchFailureV1 {
  readonly status: 'error';
  readonly command: string;
  readonly failure: Readonly<import('@/core/runtime/failures').ClassifiedFailure>;
}

/**
 * Close a confirmed post-ack adapter failure without exposing a general
 * dispatched-outcome factory to Controller code.
 */
export function confirmedToolDispatchFailureOutcomeV1(
  recorded: Readonly<RecordedInvocationV1>,
  input: Readonly<ConfirmedToolDispatchFailureV1>,
): Readonly<DispatchedOutcomeV1> {
  assertAcknowledgedRecordedInvocationV1(recorded);
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'command' ||
    keys[1] !== 'failure' ||
    keys[2] !== 'status' ||
    input.status !== 'error' ||
    typeof input.command !== 'string' ||
    !isConfirmedFailure(input.failure)
  ) {
    throw new Error('Confirmed Tool dispatch failure requires the closed error-only envelope.');
  }
  const failure = structuredClone(input.failure);
  return issueConfirmedFailureDispatchedOutcomeV1(recorded, {
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: failure.message,
    status: 'error',
    capabilityResult: { status: 'error', content: [], error: failure },
  });
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
  const beforeAttemptDispatch = input.beforeAttemptDispatch;
  const existingAfterDispatch = input.afterAttemptDispatch;
  let recorded: Readonly<RecordedInvocationV1> | null = null;
  let attemptSettled = false;
  const request = withIdempotencyKey(input.request, admitted, identity.invocationId);
  try {
    const result = await adapter.dispatch({
      ...input,
      request,
      workspaceFilesystem: {
        dispatch: async (operation) => {
          if (!recorded) {
            throw new ToolInvocationPersistenceErrorV1(
              'Workspace filesystem Provider cannot run before invocation acknowledgement.',
            );
          }
          if (!context.filesystemRuntime) {
            return {
              ok: false,
              failure: {
                code: 'operation_failed',
                message: 'Workspace filesystem Provider is unavailable.',
              },
            } as const;
          }
          return createWorkspaceFilesystemInvocationDispatcherV1({
            runtime: context.filesystemRuntime,
            recorded,
            persistence: context.persistence,
            protectedPathRevision: input.taskConfig?.executionBoundary
              ? computeExecutionBoundaryDigestV1(input.taskConfig.executionBoundary)
              : 'protected-path-unconfigured-v1',
            protectedPathEvaluator: createProtectedPathEvaluatorV1({
              workspaceRoot:
                input.taskConfig?.executionBoundary?.workspaceRoot ??
                context.filesystemRuntime.canonicalWorkspace,
              mode: input.taskConfig?.executionBoundary?.protectedPathPolicy ?? 'deny',
            }),
            actorIdentity: input.readStateActorId ?? 'parent',
            signal: input.signal,
            now: context.now,
            recordFilePreimage: input.recordFilePreimage,
          }).dispatch(operation);
        },
      },
      beforeDispatch: async () => {
        if (recorded) {
          throw new ToolInvocationPersistenceErrorV1(
            'A governed Tool adapter attempted to enter dispatch more than once.',
          );
        }
        recorded = await recordAttempt(admitted, context, identity);
        await beforeAttemptDispatch?.(recorded.attempt);
        await existingBeforeDispatch?.();
      },
    });
    const completedRecord = recorded as Readonly<RecordedInvocationV1> | null;
    bindWorkspaceFilesystemObservationResultV1(result);
    if (completedRecord && existingAfterDispatch) {
      attemptSettled = true;
      await existingAfterDispatch({ attempt: completedRecord.attempt, result });
    }
    if (!recorded) return { kind: 'not_dispatched', result };
    return {
      kind: 'dispatched',
      value: issueAdapterDispatchedOutcomeV1(recorded, result),
    };
  } catch (error) {
    const failedRecord = recorded as Readonly<RecordedInvocationV1> | null;
    if (failedRecord && existingAfterDispatch && !attemptSettled) {
      attemptSettled = true;
      try {
        await existingAfterDispatch({ attempt: failedRecord.attempt, error });
      } catch (settlementError) {
        throw new ToolInvocationDispatchErrorV1(settlementError, failedRecord);
      }
    }
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
  return issueAcknowledgedRecordedInvocationV1(token);
}

function isConfirmedFailure(
  value: unknown,
): value is import('@/core/runtime/failures').ClassifiedFailure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  const requiredBooleanFields = [
    'retryable',
    'modelFixable',
    'needsUserIntervention',
    'terminatesTurn',
    'journal',
  ];
  return (
    typeof failure.kind === 'string' &&
    failure.kind.length > 0 &&
    typeof failure.message === 'string' &&
    failure.message.length > 0 &&
    requiredBooleanFields.every((field) => typeof failure[field] === 'boolean') &&
    (failure.parseFailureCode === undefined || typeof failure.parseFailureCode === 'string')
  );
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
