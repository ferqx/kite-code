import { digestCapability } from '@/core/capabilities/catalog';
import { computeExecutionBoundaryDigestV1 } from '@/core/config/index';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { DescendantResourceAdmissionError } from '@/core/runtime/resource-budget-admission';
import { createToolRecoveryJournalV1 } from '@/core/runtime/tool-recovery-journal';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import type {
  SubagentDelegationGrantV1,
  SubagentResumeGrantV1,
} from '@/protocol/subagent-provider';
import {
  serializeSubagentContinuation,
  subagentContinuationCursorIdV1,
} from './continuation-codec';
import type { LocalSubagentDriverResultV1, LocalSubagentLifecycleDriverV1 } from './local-provider';
import { subagentReplayContextDigestV1 } from './replay-context';
import { resumeSubAgent, runSubAgent } from './runner';
import type { RestoredSubAgentContinuation, SubAgentResult, SubAgentRunnerInput } from './types';

interface StartRegistrationV1 {
  input: SubAgentRunnerInput;
}

interface ResumeRegistrationV1 {
  input: SubAgentRunnerInput;
  continuation: RestoredSubAgentContinuation;
  toolResult: { toolCallId: string; toolName: string; result: ToolExecutionResult };
}

/** Governed child execution layer. Provider implementations never import this class. */
export class ChildRuntimeDriverV1 implements LocalSubagentLifecycleDriverV1 {
  readonly #starts = new Map<string, StartRegistrationV1>();
  readonly #resumes = new Map<string, ResumeRegistrationV1>();

  registerStart(grantId: string, registration: StartRegistrationV1): void {
    if (this.#starts.has(grantId) || this.#resumes.has(grantId)) {
      throw new Error('Child Runtime grant registration collided.');
    }
    this.#starts.set(grantId, registration);
  }

  registerResume(grantId: string, registration: ResumeRegistrationV1): void {
    if (this.#starts.has(grantId) || this.#resumes.has(grantId)) {
      throw new Error('Child Runtime grant registration collided.');
    }
    this.#resumes.set(grantId, registration);
  }

  async start(grant: Readonly<SubagentDelegationGrantV1>, signal: AbortSignal) {
    const registered = this.#starts.get(grant.grantId);
    this.#starts.delete(grant.grantId);
    if (!registered) throw new Error('Child Runtime start context is unavailable.');
    const input = exactInput(registered.input, grant, signal);
    const result = await governedRun(() => runSubAgent(input), input);
    return this.#publish(grant.childInvocationId, result);
  }

  async resume(grant: Readonly<SubagentResumeGrantV1>, signal: AbortSignal) {
    const registered = this.#resumes.get(grant.grantId);
    this.#resumes.delete(grant.grantId);
    if (!registered) {
      throw new Error('Child Runtime resume context is stale.');
    }
    const snapshot = serializeSubagentContinuation(
      registered.continuation,
      registered.continuation.blockedTool,
    );
    if (
      grant.continuationId !== subagentContinuationCursorIdV1(snapshot) ||
      grant.continuationDigest !==
        digestCapability({ schema: 'kite.subagent-continuation.v1', snapshot }) ||
      grant.blockedToolCallId !== registered.continuation.blockedTool.toolCallId ||
      grant.blockedRuntimeToolCallId !== registered.continuation.blockedTool.runtimeToolCallId ||
      grant.blockedToolCallId !== registered.toolResult.toolCallId ||
      grant.resumeAttempt !== registered.input.subagentGrantContext?.attempt
    ) {
      throw new Error('Child Runtime resume grant does not match its durable continuation.');
    }
    const input = exactInput(registered.input, grant, signal);
    const result = await governedRun(
      () => resumeSubAgent(input, registered.continuation, registered.toolResult),
      input,
    );
    return this.#publish(grant.childInvocationId, result);
  }

  #publish(childInvocationId: string, result: SubAgentResult): LocalSubagentDriverResultV1 {
    const privatePayload = toPrivatePayload(result);
    return {
      childInvocationId,
      status: result.blocked
        ? 'blocked'
        : result.terminalStatus === 'cancelled'
          ? 'cancelled'
          : result.terminalStatus === 'exhausted'
            ? 'exhausted'
            : result.ok
              ? 'completed'
              : 'failed',
      summary: result.summary,
      toolCallCount: result.toolCallCount,
      durationMs: result.durationMs,
      privatePayload,
    };
  }
}

function exactInput(
  input: SubAgentRunnerInput,
  grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>,
  signal: AbortSignal,
): SubAgentRunnerInput {
  if (
    input.role.role !== grant.role ||
    input.task.length === 0 ||
    input.modelInvocationParentId !== grant.model.parentModelInvocationId ||
    input.modelInvocationParentToolCallId !== grant.parentToolCallId ||
    (input.modelInvocationParentReservationId ?? null) !== grant.resource.parentReservationId
  ) {
    throw new Error('Child Runtime execution context does not match its sealed grant.');
  }
  const allowedTools = [...(input.role.allowedTools ?? [])].sort();
  const bindingIds = (input.mcpBindings ?? []).map(({ binding }) => binding.bindingId).sort();
  const taskDigest = digestCapability({ schema: 'kite.subagent-task.v1', task: input.task });
  const boundaryDigest = input.config.executionBoundary
    ? computeExecutionBoundaryDigestV1(input.config.executionBoundary)
    : digestCapability({ schema: 'kite.execution-boundary.unconfigured.v1' });
  const responseSourceMode = input.modelInvocationGateway?.responseSourceModeV1();
  const expectedBudgetDigest = digestCapability({
    schema: 'kite.subagent-resource-budget.v1',
    budget: stableBudgetCeiling(input.modelInvocationPersistence?.getState().resourceBudget),
  });
  const expectedBindingRevision = digestCapability({
    schema: 'kite.subagent-binding-revision.v1',
    bindings: (input.mcpBindings ?? []).map(({ binding }) => binding),
  });
  const expectedCeilingDigest = digestCapability({
    schema: 'kite.subagent-capability-ceiling.v1',
    allowedTools,
    bindingIds,
    role: input.role.role,
  });
  if (
    taskDigest !== grant.taskDigest ||
    grant.taskArtifact.digest !== taskDigest ||
    grant.taskArtifact.byteLength !== Buffer.byteLength(input.task) ||
    JSON.stringify(grant.capabilityCeiling.allowedTools) !== JSON.stringify(allowedTools) ||
    JSON.stringify(grant.capabilityCeiling.bindingIds) !== JSON.stringify(bindingIds) ||
    grant.capabilityCeiling.bindingRevision !== expectedBindingRevision ||
    grant.capabilityCeiling.ceilingDigest !== expectedCeilingDigest ||
    grant.authorization.interactionMode !== (input.interactionMode ?? 'accept_edits') ||
    grant.authorization.phase !== (input.phase ?? 'building') ||
    grant.authorization.workspaceAccess !== (input.workspaceAccess ?? 'write') ||
    grant.executionBoundary.canonicalWorkspace !== canonicalPathForComparison(input.workspace) ||
    grant.executionBoundary.executionBoundaryDigest !== boundaryDigest ||
    grant.resource.budgetDigest !== expectedBudgetDigest ||
    grant.cancellationCorrelation !== grant.parentToolCallId ||
    grant.model.parentToolCallId !== grant.parentToolCallId ||
    grant.model.responseSourceMode !== responseSourceMode ||
    (responseSourceMode !== 'live' && !input.modelReplayBinding)
  ) {
    throw new Error('Child Runtime grant facts do not match the registered execution context.');
  }
  if (
    input.subagentGrantContext?.parentInvocationId !== grant.parentInvocationId ||
    input.subagentGrantContext.authorizationDigest !== grant.authorization.authorizationDigest ||
    input.subagentGrantContext.replayContextDigest !== grant.model.replayContextDigest ||
    input.subagentGrantContext.attempt !== grant.parentAttempt ||
    input.subagentGrantContext.capabilityRevision !== grant.capabilityRevision ||
    input.subagentGrantContext.admissionDigest !== grant.admissionDigest ||
    input.subagentGrantContext.effectiveEffectsDigest !== grant.effectiveEffectsDigest
  ) {
    throw new Error('Child Runtime parent authorization or replay binding is stale.');
  }
  const originalReplayBinding = input.modelReplayBinding;
  return {
    ...input,
    childInvocationId: grant.childInvocationId,
    signal,
    ...(originalReplayBinding
      ? {
          modelReplayBinding: (ordinal: number) => {
            const binding = originalReplayBinding(ordinal);
            const expectedContinuationId = grant.purpose === 'resume' ? grant.continuationId : null;
            if (
              binding.logicalInvocationOrdinal !== ordinal ||
              binding.actor.kind !== 'subagent' ||
              binding.actor.parentToolCallId !== grant.parentToolCallId ||
              binding.actor.subagentId !== grant.childInvocationId ||
              binding.actor.continuationId !== expectedContinuationId
            ) {
              throw new Error('Subagent replay actor cursor does not match its sealed grant.');
            }
            if (
              subagentReplayContextDigestV1(grant.model.responseSourceMode, binding) !==
              grant.model.replayContextDigest
            ) {
              throw new Error('Subagent replay suite authority does not match its sealed grant.');
            }
            return binding;
          },
        }
      : {}),
  };
}

function stableBudgetCeiling(
  state:
    | ReturnType<
        NonNullable<SubAgentRunnerInput['modelInvocationPersistence']>['getState']
      >['resourceBudget']
    | undefined,
): unknown {
  return state?.status === 'active'
    ? {
        status: state.status,
        runId: state.runId,
        deadlineAt: state.deadlineAt,
        budget: state.budget,
      }
    : (state ?? null);
}

function toPrivatePayload(result: SubAgentResult): import('@/protocol/subagent').JsonObject {
  const payload = {
    ok: result.ok,
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    terminalStatus: result.terminalStatus ?? null,
    error: result.error ?? null,
    resourceAdmissionFailure: result.resourceAdmissionFailure ?? null,
    steps: result.steps ?? [],
    executionJournal: result.executionJournal ?? [],
    exhaustedFingerprints: result.exhaustedFingerprints ?? {},
    toolRecovery: result.toolRecovery ?? {},
    blocked: result.blocked
      ? serializeSubagentContinuation(result.blocked.continuation, {
          reasonCode: result.blocked.reasonCode,
          toolCallId: result.blocked.toolCallId,
          ...(result.blocked.runtimeToolCallId
            ? { runtimeToolCallId: result.blocked.runtimeToolCallId }
            : {}),
          toolName: result.blocked.toolName,
          args: result.blocked.args,
          command: result.blocked.command,
        })
      : null,
  };
  return JSON.parse(JSON.stringify(payload)) as import('@/protocol/subagent').JsonObject;
}

async function governedRun(
  run: () => Promise<SubAgentResult>,
  input: SubAgentRunnerInput,
): Promise<SubAgentResult> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof DescendantResourceAdmissionError)) throw error;
    return {
      ok: false,
      summary: error.message,
      error: error.message,
      terminalStatus: 'failed',
      toolCallCount: 0,
      durationMs: 0,
      steps: [],
      executionJournal: [],
      exhaustedFingerprints: {},
      toolRecovery: createToolRecoveryJournalV1(
        input.recoveryIdentityKey ?? digestCapability({ schema: 'kite.subagent-recovery.v1' }),
      ),
      resourceAdmissionFailure: {
        reason: error.reason,
        message: error.message,
        parentInvocationId: input.subagentGrantContext?.parentInvocationId ?? '',
        parentToolCallId: input.modelInvocationParentToolCallId ?? '',
        childInvocationId: input.childInvocationId ?? '',
      },
    };
  }
}
