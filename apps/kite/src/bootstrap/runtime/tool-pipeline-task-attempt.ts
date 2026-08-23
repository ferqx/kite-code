import {
  type BuiltinOperationExecutionValue,
  createBuiltinPreparedTaskDispatchAdapter,
} from '@kite/builtin-runtime';
import type {
  RuntimeHostCommittedToolInvocationAuthority,
  RuntimeHostSuspendedToolInvocationAuthority,
} from '@kite/runtime-host';
import type { RuntimeHostStateToolGovernanceAuthorizationInput } from '@kite/runtime-host/kernel-adapter';
import type {
  CapabilityExecutionPort,
  CapabilityToolTerminalResult,
  ClassifiedInvocation,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolCallSnapshot,
  ToolPipelineDispatchOutcome,
  ToolPipelineResolutionContext,
  ToolPipelineStageFailure,
  ToolPipelineTaskSubagentSuspension,
} from '@kite/runtime-spi';
import type { AppStateToolPipelinePersistence } from '../../runtime/tool-persistence';
import {
  type CreateAppBuiltinPreparedDispatchPortInput,
  createAppBuiltinPreparedTaskDispatchPort,
} from './builtin-prepared-dispatch-port';
import type { AppToolPipelineAttemptComposition } from './tool-pipeline-attempt-composition';
import type { AppToolPipelineTurnComposition } from './tool-pipeline-composition';
import type { AppToolPipelineAttemptScope } from './tool-pipeline-ordinary-attempt';
import {
  APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
  createAppPreparedToolInvocation,
} from './tool-pipeline-prepared';

export const APP_TASK_TOOL_PIPELINE_ATTEMPT_SCHEMA_ =
  'kite.app.task-tool-pipeline-attempt.v1' as const;

type GovernanceInputWithoutClassified = Omit<
  RuntimeHostStateToolGovernanceAuthorizationInput,
  'classified'
>;
type GovernanceAdmission = Parameters<AppToolPipelineTurnComposition['governance']['project']>[1];

export interface AppTaskToolPipelineAttemptInput {
  readonly turn: Readonly<AppToolPipelineTurnComposition>;
  /** Must be the private `task` snapshot produced by the App child route. */
  readonly snapshot: Readonly<ToolCallSnapshot>;
  readonly resolution: Readonly<ToolPipelineResolutionContext>;
  readonly governance: Readonly<GovernanceInputWithoutClassified>;
  readonly admission: Readonly<GovernanceAdmission>;
  readonly threadId: string;
  readonly attempt: number;
  readonly taskId: string | null;
  readonly planId: string | null;
  readonly planStepId: string | null;
  readonly capabilityRequestFacts: RuntimeJsonValue | null;
  readonly capabilityExecution: CapabilityExecutionPort;
  readonly signal: AbortSignal;
  readonly workspace: string;
  readonly phase: 'planning' | 'building';
  readonly executionMode: 'start' | 'resume';
  /** The only child-runtime semantic callback for this prepared Task. */
  readonly executeTask: (input: {
    readonly executionMode: 'start' | 'resume';
    readonly prepared: Readonly<PreparedToolInvocation>;
    readonly arguments: Readonly<RuntimeJsonValue>;
    readonly signal: AbortSignal;
  }) => Promise<Readonly<Record<string, unknown>>>;
  /**
   * App projects a blocked Builtin result into the neutral task suspension
   * branch. It owns no persistence, continuation bytes, or reviewer logic.
   */
  readonly projectSuspension: (input: {
    readonly executionMode: 'start' | 'resume';
    readonly prepared: Readonly<PreparedToolInvocation>;
    readonly terminal: Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>;
  }) => Readonly<ToolPipelineTaskSubagentSuspension> | null;
}

export type AppTaskToolPipelineAttemptResult =
  | {
      readonly kind: 'stage_failure';
      readonly failure: Readonly<
        ToolPipelineStageFailure<'resolve' | 'validate' | 'classify', string>
      >;
    }
  | {
      readonly kind: 'governance_failure';
      readonly code: string;
      readonly diagnostic: string;
    }
  | {
      readonly kind: 'governance_terminal';
      readonly classified: Readonly<ClassifiedInvocation>;
      readonly facts: Readonly<
        Extract<
          ReturnType<AppToolPipelineTurnComposition['governance']['project']>,
          { readonly ok: true }
        >['value']
      >;
      readonly decision: Readonly<
        Exclude<
          Extract<
            ReturnType<AppToolPipelineTurnComposition['governance']['decide']>,
            { readonly ok: true }
          >['value'],
          { readonly kind: 'allow' }
        >
      >;
    }
  | {
      readonly kind: 'committed';
      readonly classified: Readonly<ClassifiedInvocation>;
      readonly committed: Readonly<
        RuntimeHostCommittedToolInvocationAuthority<BuiltinOperationExecutionValue>
      >;
    }
  | {
      readonly kind: 'suspended';
      readonly classified: Readonly<ClassifiedInvocation>;
      readonly suspended: Readonly<
        RuntimeHostSuspendedToolInvocationAuthority<BuiltinOperationExecutionValue>
      >;
    };

export interface AppTaskToolPipelineAttemptRuntime {
  readonly schema: typeof APP_TASK_TOOL_PIPELINE_ATTEMPT_SCHEMA_;
  readonly execute: (
    input: Readonly<AppTaskToolPipelineAttemptInput>,
  ) => Promise<Readonly<AppTaskToolPipelineAttemptResult>>;
}

/**
 * Compose the private Task attempt against an existing effect scope. The
 * scope is required deliberately: production cannot accidentally create a
 * second Host coordinator or router for the Task route.
 */
export function createAppTaskToolPipelineAttemptRuntime(input: {
  readonly persistence: AppStateToolPipelinePersistence;
  readonly scope: Readonly<AppToolPipelineAttemptScope>;
}): AppTaskToolPipelineAttemptRuntime {
  const scope = input.scope;
  if (scope.persistence !== input.persistence) {
    throw new Error('App Task Tool Pipeline attempt scope persistence is not exact.');
  }
  const attempts: AppToolPipelineAttemptComposition<
    RuntimeJsonValue,
    RuntimeJsonValue,
    BuiltinOperationExecutionValue
  > = scope.attempts;

  const execute = async (
    attemptInput: Readonly<AppTaskToolPipelineAttemptInput>,
  ): Promise<Readonly<AppTaskToolPipelineAttemptResult>> => {
    if (attemptInput.workspace.length === 0 || !attemptInput.projectSuspension) {
      return stageFailure('resolve', 'task_composition_invalid', attemptInput.snapshot);
    }
    if (!isPrivateTaskSnapshot(attemptInput.snapshot)) {
      return stageFailure('resolve', 'task_runtime_private_required', attemptInput.snapshot);
    }
    if (
      attemptInput.resolution.builtinProjectionRevision !== attemptInput.turn.projection.revision ||
      attemptInput.resolution.dynamicCatalogRevision !== null ||
      attemptInput.governance.threadId !== attemptInput.threadId
    ) {
      return stageFailure('resolve', 'resolution_context_invalid', attemptInput.snapshot);
    }
    const resolved = attemptInput.turn.callbacks.resolve(
      attemptInput.snapshot,
      attemptInput.resolution,
    );
    if (!resolved.ok) return Object.freeze({ kind: 'stage_failure', failure: resolved.failure });
    const target = resolved.value.target;
    if (
      target.isDynamicMcp ||
      target.operationId !== 'builtin:task' ||
      target.executionFamily !== 'subagent' ||
      target.executionMechanism !== 'subagent' ||
      resolved.value.call.argumentOrigin !== 'runtime_private'
    ) {
      return stageFailure('resolve', 'task_identity_mismatch', attemptInput.snapshot);
    }

    const validated = attemptInput.turn.callbacks.validate(resolved.value);
    if (!validated.ok) return Object.freeze({ kind: 'stage_failure', failure: validated.failure });
    const classified = attemptInput.turn.callbacks.classify(validated.value);
    if (!classified.ok) {
      return Object.freeze({ kind: 'stage_failure', failure: classified.failure });
    }
    const classifiedValue = classified.value;
    const governanceInput = Object.freeze({
      ...attemptInput.governance,
      classified: classifiedValue,
    });
    const authorization = attemptInput.turn.governance.authorize(governanceInput);
    if (!authorization.ok) {
      return Object.freeze({
        kind: 'governance_failure',
        code: authorization.failure.code,
        diagnostic: authorization.failure.diagnostic,
      });
    }
    const facts = attemptInput.turn.governance.project(governanceInput, attemptInput.admission);
    if (!facts.ok) {
      return Object.freeze({
        kind: 'governance_failure',
        code: facts.failure.code,
        diagnostic: facts.failure.diagnostic,
      });
    }
    const decision = attemptInput.turn.governance.admit(
      governanceInput,
      authorization.value,
      attemptInput.admission,
    );
    if (!decision.ok) {
      return Object.freeze({
        kind: 'governance_failure',
        code: decision.failure.code,
        diagnostic: decision.failure.diagnostic,
      });
    }
    if (decision.value.kind !== 'allow') {
      return Object.freeze({
        kind: 'governance_terminal',
        classified: classifiedValue,
        facts: facts.value,
        decision: decision.value,
      });
    }
    if (!isPreparedGrantUsed(decision.value.grantUsed)) {
      return Object.freeze({
        kind: 'governance_failure',
        code: 'unsupported_grant',
        diagnostic: 'Task Tool Pipeline does not accept a transient approval grant.',
      });
    }

    const request = Object.freeze({
      schema: APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
      authorizationKind: decision.value.authorizationKind,
      grantUsed: decision.value.grantUsed,
      policyEffects: Object.freeze({ ...(classifiedValue.policyCompilation.effects ?? {}) }),
      effectiveEffects: classifiedValue.effectiveEffects,
      receiptRequirement: classifiedValue.requirements.receipt,
      retryEligibility: classifiedValue.requirements.retry,
      taskId: attemptInput.taskId,
      planId: attemptInput.planId,
      planStepId: attemptInput.planStepId,
      capabilityRequestFacts: attemptInput.capabilityRequestFacts,
    });
    const built = createAppPreparedToolInvocation({
      classified: classifiedValue,
      governance: facts.value,
      decision: decision.value,
      threadId: attemptInput.threadId,
      attempt: attemptInput.attempt,
      preparedArguments: classifiedValue.validated.request.arguments,
      request,
      binding: classifiedValue.validated.resolved.target.binding,
    });
    const prepared = scope.attempts.prepare(built.prepared.identity, built.prepared.input);

    let taskExecutionClaimedSuspension = false;
    const taskMechanism = Object.freeze({
      phase: attemptInput.phase,
      executeTask: async () => {
        const result = await attemptInput.executeTask({
          executionMode: attemptInput.executionMode,
          prepared,
          arguments: prepared.input.arguments,
          signal: attemptInput.signal,
        });
        const blocked = Object.getOwnPropertyDescriptor(result, 'blocked');
        const terminalStatus = Object.getOwnPropertyDescriptor(result, 'terminalStatus');
        taskExecutionClaimedSuspension =
          blocked !== undefined ||
          (terminalStatus !== undefined &&
            (!('value' in terminalStatus) || terminalStatus.value === 'suspended'));
        return result;
      },
    });
    const portInput: CreateAppBuiltinPreparedDispatchPortInput = {
      projection: attemptInput.turn.projection,
      capabilityExecution: attemptInput.capabilityExecution,
      signal: attemptInput.signal,
      resolveMechanisms: (mechanismInput) => {
        if (
          mechanismInput.prepared !== prepared ||
          mechanismInput.operationId !== 'builtin:task' ||
          mechanismInput.executionMechanism !== 'subagent' ||
          mechanismInput.signal !== attemptInput.signal
        ) {
          throw new Error('Task mechanism identity changed before dispatch.');
        }
        return Object.freeze({ subagent: taskMechanism });
      },
    };
    const port = createAppBuiltinPreparedTaskDispatchPort(portInput);
    const dispatch = createBuiltinPreparedTaskDispatchAdapter({
      projection: attemptInput.turn.projection,
      verifyPreparedIdentity: attemptInput.turn.callbacks.verifyPreparedIdentity,
      port,
    });
    const outcomeDispatch = Object.freeze({
      verifyPreparedIdentity: dispatch.verifyPreparedIdentity,
      dispatch: async (
        candidate: Readonly<PreparedToolInvocation>,
      ): Promise<Readonly<ToolPipelineDispatchOutcome<BuiltinOperationExecutionValue>>> => {
        const terminal = await dispatch.dispatch(candidate);
        if (hasTaskBlockedMarker(terminal)) {
          if (!isBlockedTaskTerminal(terminal)) {
            throw new Error('Task blocked result is not an exact Builtin suspension envelope.');
          }
          const suspension = attemptInput.projectSuspension({
            executionMode: attemptInput.executionMode,
            prepared,
            terminal,
          });
          if (!suspension) {
            throw new Error('Task suspension projection is unavailable.');
          }
          return Object.freeze({
            kind: 'suspended' as const,
            suspension,
            result: Object.freeze({
              status: 'success' as const,
              content: terminal.content,
              structuredContent: terminal.structuredContent,
              ...(terminal.providerMeta === undefined
                ? {}
                : { providerMeta: terminal.providerMeta }),
            }),
          });
        }
        if (taskExecutionClaimedSuspension) {
          throw new Error('Task suspension result failed the Builtin projection boundary.');
        }
        return Object.freeze({ kind: 'committed' as const, terminal });
      },
    });
    scope.router.bind(prepared, outcomeDispatch);
    const outcome = await attempts.execute(prepared);
    if (outcome.kind === 'suspended') {
      attempts.assertSuspended(outcome);
      return Object.freeze({ kind: 'suspended', classified: classifiedValue, suspended: outcome });
    }
    attempts.assertCommitted(outcome);
    return Object.freeze({ kind: 'committed', classified: classifiedValue, committed: outcome });
  };

  return Object.freeze({ schema: APP_TASK_TOOL_PIPELINE_ATTEMPT_SCHEMA_, execute });
}

function isPrivateTaskSnapshot(snapshot: Readonly<ToolCallSnapshot>): boolean {
  if (
    snapshot.name !== 'task' ||
    snapshot.argumentOrigin !== 'runtime_private' ||
    snapshot.capabilityId !== null ||
    snapshot.capabilityRevision !== null ||
    snapshot.bindingId !== null ||
    !isRecord(snapshot.rawArguments) ||
    !Object.hasOwn(snapshot.rawArguments, 'taskArtifact')
  ) {
    return false;
  }
  const artifact = snapshot.rawArguments.taskArtifact;
  return isRecord(artifact);
}

function isBlockedTaskTerminal(
  terminal: Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>,
): terminal is Readonly<
  CapabilityToolTerminalResult<BuiltinOperationExecutionValue> & {
    readonly structuredContent: BuiltinOperationExecutionValue;
  }
> {
  const value = terminal.structuredContent;
  if (
    terminal.status !== 'error' ||
    terminal.failure?.code !== 'rejected' ||
    terminal.failure.retryable !== false ||
    !value ||
    value.ok !== false ||
    !isRecord(value.subagentResult) ||
    value.subagentResult.blocked === undefined
  ) {
    return false;
  }
  return isRecord(value.subagentResult.blocked);
}

function hasTaskBlockedMarker(
  terminal: Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>,
): boolean {
  const value = terminal.structuredContent;
  return (
    terminal.status === 'error' &&
    terminal.failure?.code === 'rejected' &&
    terminal.failure.retryable === false &&
    isRecord(value) &&
    value.ok === false &&
    isRecord(value.subagentResult) &&
    Object.hasOwn(value.subagentResult, 'blocked')
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isPreparedGrantUsed(
  value: string,
): value is 'none' | 'approve_once' | 'same_command' | 'full_access' {
  return (
    value === 'none' ||
    value === 'approve_once' ||
    value === 'same_command' ||
    value === 'full_access'
  );
}

function stageFailure(
  stage: 'resolve' | 'validate' | 'classify',
  code: string,
  snapshot: Readonly<ToolCallSnapshot>,
): Readonly<AppTaskToolPipelineAttemptResult> {
  return Object.freeze({
    kind: 'stage_failure',
    failure: Object.freeze({
      stage,
      code,
      toolCallId: snapshot.toolCallId,
      toolName: snapshot.name,
    }),
  });
}
