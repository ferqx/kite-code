import {
  type BuiltinOperationExecutionValueV1,
  createBuiltinPreparedTaskDispatchAdapterV1,
} from '@kite/builtin-runtime';
import type {
  RuntimeHostCommittedToolInvocationAuthorityV1,
  RuntimeHostState25ToolGovernanceAuthorizationInputV1,
  RuntimeHostSuspendedToolInvocationAuthorityV1,
} from '@kite/runtime-host';
import type {
  CapabilityExecutionPortV1,
  CapabilityToolTerminalResultV1,
  ClassifiedInvocationV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolCallSnapshotV1,
  ToolPipelineDispatchOutcomeV1,
  ToolPipelineResolutionContextV1,
  ToolPipelineStageFailureV1,
  ToolPipelineTaskSubagentSuspensionV1,
} from '@kite/runtime-spi';
import {
  type CreateAppBuiltinPreparedDispatchPortInputV1,
  createAppBuiltinPreparedTaskDispatchPortV1,
} from './builtin-prepared-dispatch-port';
import type { AppToolPipelineAttemptCompositionV1 } from './tool-pipeline-attempt-composition';
import type { AppToolPipelineTurnCompositionV1 } from './tool-pipeline-composition';
import type { AppToolPipelineAttemptScopeV1 } from './tool-pipeline-ordinary-attempt';
import {
  APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_V1,
  createAppPreparedToolInvocationV1,
} from './tool-pipeline-prepared';
import type { AppState25ToolPipelinePersistenceV1 } from './tool-pipeline-state25-persistence';

export const APP_TASK_TOOL_PIPELINE_ATTEMPT_SCHEMA_V1 =
  'kite.app.task-tool-pipeline-attempt.v1' as const;

type GovernanceInputWithoutClassifiedV1 = Omit<
  RuntimeHostState25ToolGovernanceAuthorizationInputV1,
  'classified'
>;
type GovernanceAdmissionV1 = Parameters<
  AppToolPipelineTurnCompositionV1['governance']['project']
>[1];

export interface AppTaskToolPipelineAttemptInputV1 {
  readonly turn: Readonly<AppToolPipelineTurnCompositionV1>;
  /** Must be the private `task` snapshot produced by the App child route. */
  readonly snapshot: Readonly<ToolCallSnapshotV1>;
  readonly resolution: Readonly<ToolPipelineResolutionContextV1>;
  readonly governance: Readonly<GovernanceInputWithoutClassifiedV1>;
  readonly admission: Readonly<GovernanceAdmissionV1>;
  readonly threadId: string;
  readonly attempt: number;
  readonly taskId: string | null;
  readonly planId: string | null;
  readonly planStepId: string | null;
  readonly capabilityRequestFacts: RuntimeJsonValueV1 | null;
  readonly capabilityExecution: CapabilityExecutionPortV1;
  readonly signal: AbortSignal;
  readonly workspace: string;
  readonly phase: 'planning' | 'building';
  readonly executionMode: 'start' | 'resume';
  /** The only child-runtime semantic callback for this prepared Task. */
  readonly executeTask: (input: {
    readonly executionMode: 'start' | 'resume';
    readonly prepared: Readonly<PreparedToolInvocationV1>;
    readonly arguments: Readonly<RuntimeJsonValueV1>;
    readonly signal: AbortSignal;
  }) => Promise<Readonly<Record<string, unknown>>>;
  /**
   * App projects a blocked Builtin result into the neutral task suspension
   * branch. It owns no persistence, continuation bytes, or reviewer logic.
   */
  readonly projectSuspension: (input: {
    readonly executionMode: 'start' | 'resume';
    readonly prepared: Readonly<PreparedToolInvocationV1>;
    readonly terminal: Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>>;
  }) => Readonly<ToolPipelineTaskSubagentSuspensionV1> | null;
}

export type AppTaskToolPipelineAttemptResultV1 =
  | {
      readonly kind: 'stage_failure';
      readonly failure: Readonly<
        ToolPipelineStageFailureV1<'resolve' | 'validate' | 'classify', string>
      >;
    }
  | {
      readonly kind: 'governance_failure';
      readonly code: string;
      readonly diagnostic: string;
    }
  | {
      readonly kind: 'governance_terminal';
      readonly classified: Readonly<ClassifiedInvocationV1>;
      readonly facts: Readonly<
        Extract<
          ReturnType<AppToolPipelineTurnCompositionV1['governance']['project']>,
          { readonly ok: true }
        >['value']
      >;
      readonly decision: Readonly<
        Exclude<
          Extract<
            ReturnType<AppToolPipelineTurnCompositionV1['governance']['decide']>,
            { readonly ok: true }
          >['value'],
          { readonly kind: 'allow' }
        >
      >;
    }
  | {
      readonly kind: 'committed';
      readonly classified: Readonly<ClassifiedInvocationV1>;
      readonly committed: Readonly<
        RuntimeHostCommittedToolInvocationAuthorityV1<BuiltinOperationExecutionValueV1>
      >;
    }
  | {
      readonly kind: 'suspended';
      readonly classified: Readonly<ClassifiedInvocationV1>;
      readonly suspended: Readonly<
        RuntimeHostSuspendedToolInvocationAuthorityV1<BuiltinOperationExecutionValueV1>
      >;
    };

export interface AppTaskToolPipelineAttemptRuntimeV1 {
  readonly schema: typeof APP_TASK_TOOL_PIPELINE_ATTEMPT_SCHEMA_V1;
  readonly execute: (
    input: Readonly<AppTaskToolPipelineAttemptInputV1>,
  ) => Promise<Readonly<AppTaskToolPipelineAttemptResultV1>>;
}

/**
 * Compose the private Task attempt against an existing effect scope. The
 * scope is required deliberately: production cannot accidentally create a
 * second Host coordinator or router for the Task route.
 */
export function createAppTaskToolPipelineAttemptRuntimeV1(input: {
  readonly persistence: AppState25ToolPipelinePersistenceV1;
  readonly scope: Readonly<AppToolPipelineAttemptScopeV1>;
}): AppTaskToolPipelineAttemptRuntimeV1 {
  const scope = input.scope;
  if (scope.persistence !== input.persistence) {
    throw new Error('App Task Tool Pipeline attempt scope persistence is not exact.');
  }
  const attempts: AppToolPipelineAttemptCompositionV1<
    RuntimeJsonValueV1,
    RuntimeJsonValueV1,
    BuiltinOperationExecutionValueV1
  > = scope.attempts;

  const execute = async (
    attemptInput: Readonly<AppTaskToolPipelineAttemptInputV1>,
  ): Promise<Readonly<AppTaskToolPipelineAttemptResultV1>> => {
    if (attemptInput.workspace.length === 0 || !attemptInput.projectSuspension) {
      return stageFailureV1('resolve', 'task_composition_invalid', attemptInput.snapshot);
    }
    if (!isPrivateTaskSnapshotV1(attemptInput.snapshot)) {
      return stageFailureV1('resolve', 'task_runtime_private_required', attemptInput.snapshot);
    }
    if (
      attemptInput.resolution.builtinProjectionRevision !== attemptInput.turn.projection.revision ||
      attemptInput.resolution.dynamicCatalogRevision !== null ||
      attemptInput.governance.threadId !== attemptInput.threadId
    ) {
      return stageFailureV1('resolve', 'resolution_context_invalid', attemptInput.snapshot);
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
      return stageFailureV1('resolve', 'task_identity_mismatch', attemptInput.snapshot);
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
    if (!isPreparedGrantUsedV1(decision.value.grantUsed)) {
      return Object.freeze({
        kind: 'governance_failure',
        code: 'unsupported_grant',
        diagnostic: 'Task Tool Pipeline does not accept a transient approval grant.',
      });
    }

    const request = Object.freeze({
      schema: APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_V1,
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
    const built = createAppPreparedToolInvocationV1({
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
    const portInput: CreateAppBuiltinPreparedDispatchPortInputV1 = {
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
    const port = createAppBuiltinPreparedTaskDispatchPortV1(portInput);
    const dispatch = createBuiltinPreparedTaskDispatchAdapterV1({
      projection: attemptInput.turn.projection,
      verifyPreparedIdentity: attemptInput.turn.callbacks.verifyPreparedIdentity,
      port,
    });
    const outcomeDispatch = Object.freeze({
      verifyPreparedIdentity: dispatch.verifyPreparedIdentity,
      dispatch: async (
        candidate: Readonly<PreparedToolInvocationV1>,
      ): Promise<Readonly<ToolPipelineDispatchOutcomeV1<BuiltinOperationExecutionValueV1>>> => {
        const terminal = await dispatch.dispatch(candidate);
        if (hasTaskBlockedMarkerV1(terminal)) {
          if (!isBlockedTaskTerminalV1(terminal)) {
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

  return Object.freeze({ schema: APP_TASK_TOOL_PIPELINE_ATTEMPT_SCHEMA_V1, execute });
}

function isPrivateTaskSnapshotV1(snapshot: Readonly<ToolCallSnapshotV1>): boolean {
  if (
    snapshot.name !== 'task' ||
    snapshot.argumentOrigin !== 'runtime_private' ||
    snapshot.capabilityId !== null ||
    snapshot.capabilityRevision !== null ||
    snapshot.bindingId !== null ||
    !isRecordV1(snapshot.rawArguments) ||
    !Object.hasOwn(snapshot.rawArguments, 'taskArtifact')
  ) {
    return false;
  }
  const artifact = snapshot.rawArguments.taskArtifact;
  return isRecordV1(artifact);
}

function isBlockedTaskTerminalV1(
  terminal: Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>>,
): terminal is Readonly<
  CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1> & {
    readonly structuredContent: BuiltinOperationExecutionValueV1;
  }
> {
  const value = terminal.structuredContent;
  if (
    terminal.status !== 'error' ||
    terminal.failure?.code !== 'rejected' ||
    terminal.failure.retryable !== false ||
    !value ||
    value.ok !== false ||
    !isRecordV1(value.subagentResult) ||
    value.subagentResult.blocked === undefined
  ) {
    return false;
  }
  return isRecordV1(value.subagentResult.blocked);
}

function hasTaskBlockedMarkerV1(
  terminal: Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>>,
): boolean {
  const value = terminal.structuredContent;
  return (
    terminal.status === 'error' &&
    terminal.failure?.code === 'rejected' &&
    terminal.failure.retryable === false &&
    isRecordV1(value) &&
    value.ok === false &&
    isRecordV1(value.subagentResult) &&
    Object.hasOwn(value.subagentResult, 'blocked')
  );
}

function isRecordV1(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isPreparedGrantUsedV1(
  value: string,
): value is 'none' | 'approve_once' | 'same_command' | 'full_access' {
  return (
    value === 'none' ||
    value === 'approve_once' ||
    value === 'same_command' ||
    value === 'full_access'
  );
}

function stageFailureV1(
  stage: 'resolve' | 'validate' | 'classify',
  code: string,
  snapshot: Readonly<ToolCallSnapshotV1>,
): Readonly<AppTaskToolPipelineAttemptResultV1> {
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
