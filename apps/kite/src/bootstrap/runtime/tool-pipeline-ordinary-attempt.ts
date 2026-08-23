import {
  type BuiltinOperationExecutionValue,
  type BuiltinShellExecutionResult,
  createBuiltinPreparedToolDispatchAdapter,
} from '@kite/builtin-runtime';
import {
  type BuiltinWorkspaceFilesystemActorIdentity,
  type BuiltinWorkspaceFilesystemRewindProjection,
  type BuiltinWorkspaceFilesystemRuntime,
  createBuiltinWorkspaceFilesystemMutationDispatcher,
  createBuiltinWorkspaceFilesystemReadDispatcher,
} from '@kite/builtin-runtime/filesystem';
import type {
  ProtectedPathEvaluator,
  SandboxPreparationArtifactStore,
} from '@kite/builtin-runtime/sandbox';
import type {
  RuntimeHostCommittedToolInvocationAuthority,
  RuntimeHostRetryableToolInvocationAuthority,
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
  ToolPipelinePlanReviewRequestedEvent,
  ToolPipelineResolutionContext,
  ToolPipelineStageFailure,
} from '@kite/runtime-spi';
import { TOOL_PIPELINE_STAGE_SCHEMA_ } from '@kite/runtime-spi';
import type { AppStateToolPipelinePersistence } from '../../runtime/tool-persistence';
import type { AppPreparedShellExecutionPort } from '../../sandbox/prepared-tool-pipeline';
import {
  type AppBuiltinPreassembledMechanismResolverInput,
  createAppBuiltinMechanismResolver,
} from './builtin-mechanism-resolver';
import {
  createAppBuiltinPreparedDispatchPort,
  createAppDynamicMcpPreparedDispatchAdapter,
} from './builtin-prepared-dispatch-port';
import {
  type AppToolPipelineAttemptComposition,
  createAppToolPipelineAttemptComposition,
} from './tool-pipeline-attempt-composition';
import type { AppToolPipelineAttemptRouter } from './tool-pipeline-attempt-router';
import { createAppToolPipelineAttemptRouter } from './tool-pipeline-attempt-router';
import type { AppToolPipelineTurnComposition } from './tool-pipeline-composition';
import {
  APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
  createAppPreparedToolInvocation,
} from './tool-pipeline-prepared';

export const APP_ORDINARY_TOOL_PIPELINE_ATTEMPT_SCHEMA_ =
  'kite.app.ordinary-tool-pipeline-attempt.v1' as const;

/**
 * The first production-safe tranche. Expanding this list requires the exact
 * mechanism/evidence owner to be complete; it is routing state, never a
 * schema, parser, effects, or availability authority.
 */
export const APP_ORDINARY_TOOL_PIPELINE_OPERATION_IDS_ = Object.freeze([
  'builtin:git_inspect',
  'builtin:read_file',
  'builtin:search_files',
  'builtin:search_content',
  'builtin:write_file',
  'builtin:edit_file',
  'builtin:list_mcp_resources',
  'builtin:list_mcp_tools',
  'builtin:read_mcp_resource',
  'builtin:ask_user',
  'builtin:write_plan',
  'builtin:read_plan',
  'builtin:read_skill_reference',
  'builtin:complete_skill',
  'builtin:tool_search',
  'builtin:update_plan',
  'builtin:web_fetch',
  'builtin:shell_execute',
  'builtin:activate_skill',
] as const);

type AppOrdinaryToolPipelineOperationId =
  (typeof APP_ORDINARY_TOOL_PIPELINE_OPERATION_IDS_)[number];

type GovernanceInputWithoutClassified = Omit<
  RuntimeHostStateToolGovernanceAuthorizationInput,
  'classified'
>;
type GovernanceAdmission = Parameters<AppToolPipelineTurnComposition['governance']['project']>[1];
type MechanismResources = Omit<
  AppBuiltinPreassembledMechanismResolverInput,
  | 'executionMechanism'
  | 'canonicalArguments'
  | 'grantUsed'
  | 'authorizationKind'
  | 'policyEffects'
  | 'signal'
  | 'filesystemRuntime'
>;

export interface AppOrdinaryWorkspaceFilesystemComposition {
  readonly runtime: Readonly<BuiltinWorkspaceFilesystemRuntime>;
  readonly protectedPathEvaluator: ProtectedPathEvaluator;
  readonly protectedPathRevision: string;
  readonly actorIdentity: Readonly<BuiltinWorkspaceFilesystemActorIdentity>;
  readonly rewindProjection?: Readonly<BuiltinWorkspaceFilesystemRewindProjection>;
  readonly now?: () => Date;
}

export interface AppOrdinaryShellComposition {
  readonly execution: Readonly<AppPreparedShellExecutionPort>;
  readonly artifacts: SandboxPreparationArtifactStore;
}

export interface AppOrdinaryToolPipelineAttemptLifecycle {
  /** Called only after Kernel authorization allows the operation and before admission. */
  readonly prepareAdmission?: (
    classified: Readonly<ClassifiedInvocation>,
  ) => Promise<Readonly<GovernanceAdmission>>;
  /** Runs inside Host dispatch, therefore strictly after the durable attempt acknowledgement. */
  readonly beforeDispatch?: (attempt: number) => Promise<void>;
  /** Runs after Host has durably acknowledged the attempt and before Builtin dispatch. */
  readonly afterAcknowledgement?: (input: {
    readonly attempt: number;
    readonly prepared: Readonly<PreparedToolInvocation>;
  }) => Promise<void>;
  /** Settles one acknowledged dispatch exactly once; errors remain post-ack unknown. */
  readonly afterDispatch?: (input: {
    readonly attempt: number;
    readonly result?: Readonly<BuiltinOperationExecutionValue>;
    readonly error?: unknown;
  }) => Promise<void>;
}

export interface AppOrdinaryToolPipelineAttemptInput {
  readonly turn: Readonly<AppToolPipelineTurnComposition>;
  readonly snapshot: Readonly<ToolCallSnapshot>;
  readonly resolution: Readonly<ToolPipelineResolutionContext>;
  readonly governance: Readonly<GovernanceInputWithoutClassified>;
  readonly admission: Readonly<GovernanceAdmission>;
  readonly threadId: string;
  readonly attempt: number;
  /** Allows at most one new attempt after State durably admits safe-read evidence. */
  readonly allowSafeReadRetry?: boolean;
  readonly taskId: string | null;
  readonly planId: string | null;
  readonly planStepId: string | null;
  readonly capabilityRequestFacts: RuntimeJsonValue | null;
  readonly capabilityExecution: CapabilityExecutionPort;
  readonly signal: AbortSignal;
  readonly mechanismResources: Readonly<MechanismResources>;
  /**
   * Dynamic MCP preflight hook. It runs after Kernel admission but before the
   * Host attempt acknowledgement, so readiness/egress facts cannot be
   * discovered after an external attempt has already been claimed.
   */
  readonly prepareMechanism?: (input: {
    readonly classified: Readonly<ClassifiedInvocation>;
    readonly canonicalArguments: RuntimeJsonValue;
  }) => Promise<Readonly<MechanismResources>>;
  /** App facts used to compose the Builtin read-only filesystem owner after Host preparation. */
  readonly workspaceFilesystem?: Readonly<AppOrdinaryWorkspaceFilesystemComposition>;
  /** App-selected Shell Provider/process composition; it owns no Tool policy facts. */
  readonly shell?: Readonly<AppOrdinaryShellComposition>;
  /** Optional child-attempt lifecycle; it never parses or authorizes tool semantics. */
  readonly lifecycle?: Readonly<AppOrdinaryToolPipelineAttemptLifecycle>;
}

type StageFailure = ToolPipelineStageFailure<'resolve' | 'validate' | 'classify', string>;

export type AppOrdinaryToolPipelineAttemptResult =
  | {
      readonly kind: 'stage_failure';
      readonly failure: Readonly<StageFailure>;
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
    }
  | {
      readonly kind: 'retryable';
      readonly classified: Readonly<ClassifiedInvocation>;
      readonly retryable: Readonly<
        RuntimeHostRetryableToolInvocationAuthority<BuiltinOperationExecutionValue>
      >;
    };

export interface AppOrdinaryToolPipelineAttemptRuntime {
  readonly schema: typeof APP_ORDINARY_TOOL_PIPELINE_ATTEMPT_SCHEMA_;
  readonly execute: (
    input: Readonly<AppOrdinaryToolPipelineAttemptInput>,
  ) => Promise<Readonly<AppOrdinaryToolPipelineAttemptResult>>;
}

/**
 * Effect-scoped attempt authority shared by every App route in one turn.
 *
 * Task is deliberately not an ordinary operation, but it must still enter
 * the exact same Host coordinator and process-local router.  Keeping this
 * scope explicit lets the composition root hand one object to ordinary and
 * task runtimes without allowing either route to create a second coordinator.
 */
export interface AppToolPipelineAttemptScope {
  readonly persistence: AppStateToolPipelinePersistence;
  readonly router: AppToolPipelineAttemptRouter<RuntimeJsonValue, BuiltinOperationExecutionValue>;
  readonly attempts: AppToolPipelineAttemptComposition<
    RuntimeJsonValue,
    RuntimeJsonValue,
    BuiltinOperationExecutionValue
  >;
}

export function createAppToolPipelineAttemptScope(input: {
  readonly persistence: AppStateToolPipelinePersistence;
}): AppToolPipelineAttemptScope {
  const router = createAppToolPipelineAttemptRouter<
    RuntimeJsonValue,
    BuiltinOperationExecutionValue
  >();
  const attempts: AppToolPipelineAttemptComposition<
    RuntimeJsonValue,
    RuntimeJsonValue,
    BuiltinOperationExecutionValue
  > = createAppToolPipelineAttemptComposition({
    persistence: input.persistence,
    dispatch: router.dispatch,
  });
  return Object.freeze({ persistence: input.persistence, router, attempts });
}

/**
 * Create one ordinary attempt runtime for one run_tools effect. The router and
 * Host coordinator are intentionally shared by every call in that effect.
 */
export function createAppOrdinaryToolPipelineAttemptRuntime(input: {
  readonly persistence: AppStateToolPipelinePersistence;
  /** Optional shared effect scope; task and ordinary routes must share it. */
  readonly scope?: Readonly<AppToolPipelineAttemptScope>;
}): AppOrdinaryToolPipelineAttemptRuntime {
  const scope = input.scope ?? createAppToolPipelineAttemptScope(input);
  if (scope.persistence !== input.persistence) {
    throw new Error('App Tool Pipeline attempt scope persistence is not exact.');
  }
  const router = scope.router;
  const attempts: AppToolPipelineAttemptComposition<
    RuntimeJsonValue,
    RuntimeJsonValue,
    BuiltinOperationExecutionValue
  > = scope.attempts;
  const resolveMechanism = createAppBuiltinMechanismResolver();

  const execute = async (
    attemptInput: Readonly<AppOrdinaryToolPipelineAttemptInput>,
  ): Promise<Readonly<AppOrdinaryToolPipelineAttemptResult>> => {
    const turn = attemptInput.turn;
    if (
      attemptInput.resolution.builtinProjectionRevision !== turn.projection.revision ||
      attemptInput.governance.threadId !== attemptInput.threadId
    ) {
      return stageFailure('resolve', 'resolution_context_invalid', attemptInput.snapshot);
    }

    const resolved = turn.callbacks.resolve(attemptInput.snapshot, attemptInput.resolution);
    if (!resolved.ok) return Object.freeze({ kind: 'stage_failure', failure: resolved.failure });
    const target = resolved.value.target;
    if (
      (!target.isDynamicMcp && !isAppOrdinaryToolPipelineOperationId(target.operationId)) ||
      target.executionMechanism === 'subagent'
    ) {
      return stageFailure('resolve', 'unsupported_operation', attemptInput.snapshot);
    }

    const validated = turn.callbacks.validate(resolved.value);
    if (!validated.ok) return Object.freeze({ kind: 'stage_failure', failure: validated.failure });
    const classified = turn.callbacks.classify(validated.value);
    if (!classified.ok) {
      return Object.freeze({ kind: 'stage_failure', failure: classified.failure });
    }
    const classifiedValue = classified.value;
    const governanceInput = Object.freeze({
      ...attemptInput.governance,
      classified: classifiedValue,
    });
    const authorization = turn.governance.authorize(governanceInput);
    if (!authorization.ok) {
      return Object.freeze({
        kind: 'governance_failure',
        code: authorization.failure.code,
        diagnostic: authorization.failure.diagnostic,
      });
    }
    const admission =
      authorization.value.kind === 'authorized' && attemptInput.lifecycle?.prepareAdmission
        ? await attemptInput.lifecycle.prepareAdmission(classifiedValue)
        : attemptInput.admission;
    const facts = turn.governance.project(governanceInput, admission);
    if (!facts.ok) {
      return Object.freeze({
        kind: 'governance_failure',
        code: facts.failure.code,
        diagnostic: facts.failure.diagnostic,
      });
    }
    const decision = turn.governance.admit(governanceInput, authorization.value, admission);
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
    if (target.executionMechanism === 'user_input') {
      return Object.freeze({
        kind: 'governance_failure',
        code: 'interrupt_authorization_invalid',
        diagnostic: 'A user-input interrupt cannot be admitted for capability dispatch.',
      });
    }
    const allowDecision = decision.value;
    const grantUsed = allowDecision.grantUsed;
    if (!isPreparedGrantUsed(grantUsed)) {
      return Object.freeze({
        kind: 'governance_failure',
        code: 'unsupported_grant',
        diagnostic: 'Ordinary Tool Pipeline does not accept a transient approval grant.',
      });
    }

    const request = Object.freeze({
      schema: APP_TOOL_PIPELINE_PREPARED_REQUEST_SCHEMA_,
      authorizationKind: allowDecision.authorizationKind,
      grantUsed,
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
      decision: allowDecision,
      threadId: attemptInput.threadId,
      attempt: attemptInput.attempt,
      preparedArguments: classifiedValue.validated.request.arguments,
      request,
      binding: classifiedValue.validated.resolved.target.binding,
    });
    const prepared = attempts.prepare(built.prepared.identity, built.prepared.input);
    let mechanismResources = attemptInput.mechanismResources;
    if (attemptInput.prepareMechanism && target.isDynamicMcp) {
      mechanismResources = await attemptInput.prepareMechanism({
        classified: classifiedValue,
        canonicalArguments: built.prepared.input.arguments,
      });
    }
    let mechanisms: ReturnType<typeof resolveMechanism>;
    try {
      const filesystemRuntime =
        target.executionMechanism === 'filesystem'
          ? createFilesystemDispatcher({
              composition: attemptInput.workspaceFilesystem,
              persistence: input.persistence,
              prepared,
              verifyPreparedIdentity: turn.callbacks.verifyPreparedIdentity,
              operationId: target.operationId,
              signal: attemptInput.signal,
            })
          : undefined;
      const shellExecutor =
        target.executionMechanism === 'shell'
          ? createShellExecutor({
              composition: attemptInput.shell,
              persistence: input.persistence,
              prepared,
              operationId: target.operationId,
              attempt: attemptInput.attempt,
              signal: attemptInput.signal,
            })
          : undefined;
      mechanisms = resolveMechanism({
        ...mechanismResources,
        ...(filesystemRuntime ? { filesystemRuntime } : {}),
        ...(shellExecutor ? { shellExecutor } : {}),
        executionMechanism: target.executionMechanism,
        canonicalArguments: built.prepared.input.arguments,
        grantUsed,
        authorizationKind: allowDecision.authorizationKind,
        policyEffects: request.policyEffects,
        signal: attemptInput.signal,
      });
    } catch {
      return Object.freeze({
        kind: 'governance_failure',
        code: 'mechanism_unavailable',
        diagnostic: 'The admitted Builtin execution mechanism is unavailable.',
      });
    }
    const port = createAppBuiltinPreparedDispatchPort({
      projection: turn.projection,
      capabilityExecution: attemptInput.capabilityExecution,
      signal: attemptInput.signal,
      resolveMechanisms: (mechanismInput) => {
        if (mechanismInput.prepared !== prepared) {
          throw new Error('Builtin mechanism request is not bound to this Host authority.');
        }
        if (mechanismInput.executionMechanism !== target.executionMechanism) {
          throw new Error('Builtin mechanism request changed after preparation.');
        }
        return mechanisms;
      },
    });
    const dispatch = target.isDynamicMcp
      ? createAppDynamicMcpPreparedDispatchAdapter({
          projection: turn.projection,
          capabilityExecution: attemptInput.capabilityExecution,
          resolveMechanisms: (mechanismInput) => {
            if (mechanismInput.prepared !== prepared) {
              throw new Error('Builtin mechanism request is not bound to this Host authority.');
            }
            if (mechanismInput.executionMechanism !== target.executionMechanism) {
              throw new Error('Builtin mechanism request changed after preparation.');
            }
            return mechanisms;
          },
          signal: attemptInput.signal,
          verifyPreparedIdentity: turn.callbacks.verifyPreparedIdentity,
        })
      : createBuiltinPreparedToolDispatchAdapter({
          projection: turn.projection,
          verifyPreparedIdentity: turn.callbacks.verifyPreparedIdentity,
          port,
        });
    router.bind(
      prepared,
      Object.freeze({
        verifyPreparedIdentity: dispatch.verifyPreparedIdentity,
        dispatch: async (value: Parameters<typeof dispatch.dispatch>[0]) => {
          const attempt = attemptInput.attempt;
          let terminal: Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>;
          let projected: Readonly<ToolPipelineDispatchOutcome<BuiltinOperationExecutionValue>>;
          try {
            await attemptInput.lifecycle?.beforeDispatch?.(attempt);
            await attemptInput.lifecycle?.afterAcknowledgement?.({ attempt, prepared });
            terminal = await dispatch.dispatch(value);
            projected = projectBuiltinToolDispatchOutcome({
              operationId: target.operationId,
              retryEligibility: request.retryEligibility,
              allowSafeReadRetry: attemptInput.allowSafeReadRetry === true,
              terminal,
            });
          } catch (error) {
            await attemptInput.lifecycle?.afterDispatch?.({ attempt, error });
            throw error;
          }
          await attemptInput.lifecycle?.afterDispatch?.({
            attempt,
            ...(projected.kind === 'retryable'
              ? { error: new Error('State admitted a new safe-read Tool attempt.') }
              : terminal.structuredContent === undefined
                ? {}
                : { result: terminal.structuredContent }),
          });
          return projected;
        },
      }),
    );
    const outcome = await attempts.execute(prepared);
    if (outcome.kind === 'suspended') {
      attempts.assertSuspended(outcome);
      return Object.freeze({ kind: 'suspended', classified: classifiedValue, suspended: outcome });
    }
    if (outcome.kind === 'retryable') {
      attempts.assertRetryable(outcome);
      return Object.freeze({ kind: 'retryable', classified: classifiedValue, retryable: outcome });
    }
    attempts.assertCommitted(outcome);
    return Object.freeze({ kind: 'committed', classified: classifiedValue, committed: outcome });
  };

  return Object.freeze({
    schema: APP_ORDINARY_TOOL_PIPELINE_ATTEMPT_SCHEMA_,
    execute,
  });
}

function createShellExecutor(input: {
  readonly composition: Readonly<AppOrdinaryShellComposition> | undefined;
  readonly persistence: AppStateToolPipelinePersistence;
  readonly prepared: Readonly<PreparedToolInvocation>;
  readonly operationId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}) {
  const composition = input.composition;
  const identity = input.prepared.identity;
  if (
    !composition ||
    input.operationId !== 'builtin:shell_execute' ||
    identity.isDynamicMcp ||
    identity.operationId !== 'builtin:shell_execute' ||
    identity.executionMechanism !== 'shell' ||
    identity.admissionDigest === null
  ) {
    throw new Error('Prepared Shell composition is unavailable or cross-bound.');
  }
  const admissionDigest = identity.admissionDigest;
  return Object.freeze({
    execute: async (
      shellInput: Readonly<{
        readonly workspace: string;
        readonly command: string;
        readonly timeoutMs: number;
        readonly signal: AbortSignal;
        readonly readOnly: boolean;
        readonly networkAccess: 'none' | 'approved';
        readonly filesystemAccess: 'workspace_only' | 'external_read' | 'approved_external';
        readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
      }>,
    ): Promise<Readonly<BuiltinShellExecutionResult>> => {
      if (
        shellInput.signal !== input.signal ||
        shellInput.command !==
          (input.prepared.input.arguments as Readonly<Record<string, unknown>>).command
      ) {
        throw new Error('Prepared Shell invocation changed before execution.');
      }
      const lifecycle = input.persistence.createSandboxLifecycle({
        prepared: input.prepared,
        artifacts: composition.artifacts,
      });
      return composition.execution.execute({
        identity: Object.freeze({
          toolCallId: identity.toolCallId,
          capabilityId: identity.capabilityId,
          capabilityRevision: identity.capabilityRevision,
          invocationId: identity.invocationId,
          attempt: input.attempt,
          effectiveEffectsDigest: identity.effectiveEffectsDigest,
          admissionDigest,
          cancellationCorrelation: identity.attemptId,
        }),
        workspace: shellInput.workspace,
        command: shellInput.command,
        timeoutMs: shellInput.timeoutMs,
        signal: shellInput.signal,
        filesystemMode:
          shellInput.filesystemAccess === 'approved_external' ? 'allow_all' : 'workspace_only',
        networkMode: shellInput.networkAccess === 'approved' ? 'allow_all' : 'disabled',
        ...(shellInput.readOnly ? { executionTrust: 'policy_proven_read_only' as const } : {}),
        ...(shellInput.onProgress ? { onProgress: shellInput.onProgress } : {}),
        lifecycle,
      });
    },
  });
}

function createFilesystemDispatcher(input: {
  readonly composition: Readonly<AppOrdinaryWorkspaceFilesystemComposition> | undefined;
  readonly persistence: AppStateToolPipelinePersistence;
  readonly prepared: Parameters<
    typeof createBuiltinWorkspaceFilesystemReadDispatcher
  >[0]['prepared'];
  readonly verifyPreparedIdentity: Parameters<
    typeof createBuiltinWorkspaceFilesystemReadDispatcher
  >[0]['verifyPreparedIdentity'];
  readonly operationId: string;
  readonly signal: AbortSignal;
}) {
  const composition = input.composition;
  if (!composition) throw new Error('Workspace filesystem composition is unavailable.');
  if (input.operationId === 'builtin:write_file' || input.operationId === 'builtin:edit_file') {
    return createBuiltinWorkspaceFilesystemMutationDispatcher({
      prepared: input.prepared,
      verifyPreparedIdentity: input.verifyPreparedIdentity,
      runtime: composition.runtime,
      durableEvidence: input.persistence.workspaceFilesystemMutationEvidence,
      editObservation: input.persistence.workspaceFilesystemEditObservation,
      protectedPathEvaluator: composition.protectedPathEvaluator,
      protectedPathRevision: composition.protectedPathRevision,
      actorIdentity: composition.actorIdentity,
      signal: input.signal,
      ...(composition.rewindProjection ? { rewindProjection: composition.rewindProjection } : {}),
      ...(composition.now ? { now: composition.now } : {}),
    });
  }
  return createBuiltinWorkspaceFilesystemReadDispatcher({
    prepared: input.prepared,
    verifyPreparedIdentity: input.verifyPreparedIdentity,
    runtime: composition.runtime,
    durableEvidence: input.persistence.workspaceFilesystemEvidence,
    protectedPathEvaluator: composition.protectedPathEvaluator,
    protectedPathRevision: composition.protectedPathRevision,
    actorIdentity: composition.actorIdentity,
    signal: input.signal,
    ...(composition.now ? { now: composition.now } : {}),
  });
}

function projectBuiltinToolDispatchOutcome(input: {
  readonly operationId: string;
  readonly retryEligibility: string;
  readonly allowSafeReadRetry: boolean;
  readonly terminal: Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>;
}): Readonly<ToolPipelineDispatchOutcome<BuiltinOperationExecutionValue>> {
  const { operationId, terminal } = input;
  if (
    operationId === 'mcp:dynamic_tool' &&
    input.allowSafeReadRetry &&
    input.retryEligibility === 'safe_read_candidate' &&
    terminal.status === 'error' &&
    terminal.failure?.code === 'provider_unavailable' &&
    terminal.failure.retryable === true
  ) {
    return Object.freeze({
      kind: 'retryable' as const,
      replaySafety: 'safe_read' as const,
      result: terminal,
    });
  }
  if (operationId !== 'builtin:write_plan') {
    return Object.freeze({ kind: 'committed' as const, terminal });
  }
  const value = terminal.structuredContent;
  const reviewEvents = value?.runtimeEvents?.filter(
    (event) => event.type === 'plan.review_requested',
  );
  if (!value || !reviewEvents || reviewEvents.length === 0) {
    return Object.freeze({ kind: 'committed' as const, terminal });
  }
  if (
    terminal.status !== 'success' ||
    value.ok !== true ||
    value.runtimeEvents?.length !== 1 ||
    reviewEvents.length !== 1
  ) {
    throw new Error('write_plan returned an ambiguous plan review suspension.');
  }
  const event = reviewEvents[0]!;
  return Object.freeze({
    kind: 'suspended' as const,
    suspension: Object.freeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_,
      kind: 'plan_review' as const,
      toolCallId: event.toolCallId as string,
      event: event as Readonly<ToolPipelinePlanReviewRequestedEvent>,
    }),
    result: Object.freeze({
      status: 'success' as const,
      content: terminal.content,
      structuredContent: value,
      ...(terminal.providerMeta === undefined ? {} : { providerMeta: terminal.providerMeta }),
    }),
  }) satisfies Readonly<ToolPipelineDispatchOutcome<BuiltinOperationExecutionValue>>;
}

export function isAppOrdinaryToolPipelineOperationId(
  value: string,
): value is AppOrdinaryToolPipelineOperationId {
  return APP_ORDINARY_TOOL_PIPELINE_OPERATION_IDS_.some((operationId) => operationId === value);
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
  stage: StageFailure['stage'],
  code: string,
  snapshot: Readonly<ToolCallSnapshot>,
): Readonly<AppOrdinaryToolPipelineAttemptResult> {
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
