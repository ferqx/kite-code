import type { SkillActivationContext } from '@kite/builtin-runtime';
import type { NetworkBoundaryPolicyV1 } from '@kite/builtin-runtime/sandbox';
import {
  createNetworkBoundaryFetchV1,
  type NetworkDecisionRecorderV1,
} from '@kite/builtin-runtime/sandbox';
import type {
  BuiltinSkillExecutionMechanismV1,
  BuiltinWebExecutionMechanismV1,
} from '#builtin-runtime';

export function createRmv111SkillMechanismPortV1(
  runtime: SkillActivationContext | undefined,
): BuiltinSkillExecutionMechanismV1 | undefined {
  if (!runtime) return undefined;
  const frames = Object.fromEntries(
    Object.entries(runtime.state.skills.frames).map(([activationId, frame]) => [
      activationId,
      Object.freeze({
        activationId: frame.activationId,
        skillId: frame.skillId,
        skillRevision: frame.skillRevision,
        taskId: frame.taskId,
        input: frame.input,
        contextMode: frame.contextMode,
        agent: frame.agent,
        capabilityCeiling: Object.freeze([...frame.capabilityCeiling]),
        verificationMode: frame.verificationMode,
        requestedBy: frame.requestedBy,
        activatedAt: frame.activatedAt,
        status: frame.status,
        ...(frame.closedAt ? { closedAt: frame.closedAt } : {}),
        ...(frame.closeReason ? { closeReason: frame.closeReason } : {}),
        ...(frame.output ? { output: Object.freeze({ ...frame.output }) } : {}),
      }),
    ]),
  );
  return Object.freeze({
    state: Object.freeze({
      activeTaskId: runtime.state.activeTaskId,
      session: Object.freeze({ workspace: runtime.state.session.workspace }),
      skills: Object.freeze({
        catalogRevision: runtime.state.skills.catalogRevision,
        frames: Object.freeze(frames),
      }),
    }),
    ...(runtime.catalog ? { catalog: runtime.catalog } : {}),
    ...(runtime.flags
      ? {
          flags: Object.freeze({
            skillActivationV2: runtime.flags.skillActivationV2,
            skillWorkflowV1: runtime.flags.skillWorkflowV1,
          }),
        }
      : {}),
    verificationEnabled: runtime.verificationEnabled,
    ...(runtime.runFork ? { runFork: runtime.runFork } : {}),
  });
}

export function createRmv111WebMechanismPortV1(input: {
  readonly toolCallId?: string;
  readonly networkBoundaryPolicy?: NetworkBoundaryPolicyV1;
  readonly recordNetworkDecision?: NetworkDecisionRecorderV1;
}): BuiltinWebExecutionMechanismV1 {
  const boundary = input.networkBoundaryPolicy;
  if (!boundary) {
    return Object.freeze({
      unavailable: Object.freeze({
        code: 'network_boundary_unavailable',
        message: 'An explicit network boundary is required for Builtin web execution.',
      }),
    });
  }
  const admissionDigests: string[] = [];
  const networkBoundary = Object.freeze({
    policyRevision: boundary.revision,
    get admissionDigests(): readonly string[] {
      return Object.freeze([...admissionDigests]);
    },
  });
  if (!input.toolCallId || !input.recordNetworkDecision) {
    return Object.freeze({
      networkBoundary,
      unavailable: Object.freeze({
        code: 'controller_unavailable',
        message: 'Durable network decision recording is unavailable.',
      }),
    });
  }
  const fetch = createNetworkBoundaryFetchV1(boundary, {
    toolCallId: input.toolCallId,
    recordDecision: async (decision) => {
      await input.recordNetworkDecision!(decision);
      admissionDigests.push(decision.receiptDigest);
    },
  });
  return Object.freeze({ fetch, networkBoundary });
}
