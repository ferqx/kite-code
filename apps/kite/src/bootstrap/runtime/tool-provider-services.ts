import type { SkillActivationContext } from '@kite/builtin-runtime';
import type { NetworkBoundaryPolicy } from '@kite/builtin-runtime/sandbox';
import {
  createNetworkBoundaryFetch,
  type NetworkDecisionRecorder,
} from '@kite/builtin-runtime/sandbox';
import type {
  BuiltinSkillExecutionMechanism,
  BuiltinWebExecutionMechanism,
} from '#builtin-runtime';

export function createSkillMechanismPort(
  runtime: SkillActivationContext | undefined,
): BuiltinSkillExecutionMechanism | undefined {
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
            skillActivation: runtime.flags.skillActivation,
            skillWorkflow: runtime.flags.skillWorkflow,
          }),
        }
      : {}),
    verificationEnabled: runtime.verificationEnabled,
    ...(runtime.runFork ? { runFork: runtime.runFork } : {}),
  });
}

export function createWebMechanismPort(input: {
  readonly toolCallId?: string;
  readonly networkBoundaryPolicy?: NetworkBoundaryPolicy;
  readonly recordNetworkDecision?: NetworkDecisionRecorder;
}): BuiltinWebExecutionMechanism {
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
  const fetch = createNetworkBoundaryFetch(boundary, {
    toolCallId: input.toolCallId,
    recordDecision: async (decision) => {
      await input.recordNetworkDecision!(decision);
      admissionDigests.push(decision.receiptDigest);
    },
  });
  return Object.freeze({ fetch, networkBoundary });
}
