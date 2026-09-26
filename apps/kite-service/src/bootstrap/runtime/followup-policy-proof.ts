import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import type { SkillCatalogSnapshot } from '@kite-ai/builtin-runtime/skills';
import { createCapabilitySnapshot } from '@kite-ai/builtin-runtime/skills';
import type { CapabilitySnapshot, InteractionMode } from '@kite-ai/runtime-contract';
import { getAgentPhase } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateActivePlanning,
  runtimeHostStateActiveSkillFrames,
  runtimeHostStateEffectiveInteractionMode,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  CapabilityEffects,
  CapabilityPolicyEffects,
  ClassifiedInvocation,
  ToolCallSnapshot,
} from '@kite-ai/runtime-spi';
import type { AgentConfig } from '#kite-service/config';
import { getFeatureFlags } from '#kite-service/config/features';
import type { RootFollowupPolicyEvidence } from './agent-mailbox-port';
import type { RuntimeState } from './state-runtime';
import type { AppToolPipelineComposition } from './tool-pipeline-composition';
import { createAppToolTurnContext } from './tool-turn-context';

/** Read-only inputs supplied by the source owner, never by a model or target Session. */
export interface CurrentSourceFollowupPolicyInput {
  readonly state: Readonly<RuntimeState>;
  readonly settledCall: Readonly<ToolCallSnapshot>;
  readonly admitted: Readonly<RootFollowupPolicyEvidence>;
  readonly config: Readonly<AgentConfig>;
  readonly pipeline: Readonly<AppToolPipelineComposition>;
  /** Null means the owner has confirmed no current MCP provider, not a read failure. */
  readonly mcpSnapshot: Readonly<CapabilitySnapshot> | null;
  /** Null means the owner has confirmed no current Skill catalog. */
  readonly skillCatalog: Readonly<SkillCatalogSnapshot> | null;
  /** Exact ordinary Router availability facts for this source Tool call. */
  readonly agentMailboxPortAvailable: boolean;
  readonly agentMailboxQueueOnlyAvailable: boolean;
  /** The Router's trusted override; null means use the current State mode. */
  readonly interactionModeOverride: InteractionMode | null;
}

export type CurrentFollowupProofFailure =
  | 'original_evidence_missing'
  | 'original_identity_mismatch'
  | 'current_catalog_mismatch'
  | 'current_catalog_unavailable'
  | 'current_workspace_mismatch'
  | 'current_mode_or_phase_mismatch'
  | 'current_tool_unavailable'
  | 'current_schema_mismatch'
  | 'current_policy_exceeds_admission';

export type CurrentFollowupClassification =
  | { readonly ok: false; readonly code: CurrentFollowupProofFailure }
  | { readonly ok: true; readonly classified: Readonly<ClassifiedInvocation> };

export type CurrentSourceFollowupPolicyResult =
  | { readonly ok: false; readonly code: CurrentFollowupProofFailure }
  | {
      readonly ok: true;
      readonly proof: Readonly<{
        invocationId: string;
        capabilityId: string;
        capabilityRevision: string;
        catalogRevision: string;
        policyEffects: Readonly<CapabilityPolicyEffects>;
        effectiveEffects: Readonly<CapabilityEffects>;
        /** Audit digest of the current pure compilation, not a Host approval binding. */
        policyCompilationDigest: string;
        interactionMode: 'auto' | 'accept_edits' | 'full';
        phase: 'planning' | 'building';
      }>;
    };

const fail = (code: CurrentFollowupProofFailure): CurrentFollowupClassification => ({
  ok: false,
  code,
});

/** Reclassify the original call with the one frozen Builtin catalog, without preparing it. */
export function classifyCurrentFollowupCeiling(
  input: Readonly<CurrentSourceFollowupPolicyInput>,
): CurrentFollowupClassification {
  const { state, settledCall: call, admitted } = input;
  const original = admitted.preparedTool;
  if (!original || !admitted.policyRevision || !admitted.capabilityDigest) {
    return fail('original_evidence_missing');
  }
  const storedCall = state.tools.calls[original.toolCallId];
  const storedInvocation = state.capabilities.invocations[original.invocationId];
  if (
    original.operationId !== 'builtin:followup_task' ||
    original.bindingId !== null ||
    original.capabilityId.length === 0 ||
    original.capabilityRevision.length === 0 ||
    !original.attemptId.startsWith(`${original.invocationId}:attempt:`) ||
    original.schemaDigest.length === 0 ||
    original.argumentsDigest.length === 0 ||
    original.policyRevision !== admitted.policyRevision ||
    original.authorizationDigest !== admitted.authorizationDigest ||
    original.admissionDigest !== admitted.admissionDigest ||
    original.effectiveEffectsDigest !== admitted.effectiveEffectsDigest ||
    digestCapabilityValue(original.effectiveEffects) !== original.effectiveEffectsDigest ||
    !storedCall ||
    storedCall.status !== 'succeeded' ||
    storedCall.name !== 'followup_task' ||
    storedCall.toolCallId !== original.toolCallId ||
    storedCall.modelMessageId !== original.modelMessageId ||
    storedCall.createdAtTurnId !== original.turnId ||
    !storedInvocation ||
    storedInvocation.status !== 'succeeded' ||
    !storedInvocation.attemptsStarted ||
    Number(original.attemptId.slice(`${original.invocationId}:attempt:`.length)) !==
      storedInvocation.attemptsStarted ||
    storedInvocation.toolCallId !== original.toolCallId ||
    storedInvocation.capabilityId !== original.capabilityId ||
    storedInvocation.capabilityRevision !== original.capabilityRevision ||
    storedInvocation.argumentsDigest !== original.argumentsDigest ||
    storedInvocation.authorizationDigest !== original.authorizationDigest ||
    storedInvocation.admissionDigest !== original.admissionDigest ||
    storedInvocation.effectiveEffectsDigest !== original.effectiveEffectsDigest ||
    call.toolCallId !== original.toolCallId ||
    call.name !== storedCall.name ||
    call.createdAtTurnId !== original.turnId ||
    call.modelMessageId !== original.modelMessageId ||
    call.argumentOrigin !== 'model_public' ||
    call.bindingId !== null ||
    call.capabilityId !== null ||
    call.capabilityRevision !== null ||
    digestCapabilityValue(call.rawArguments) !== digestCapabilityValue(storedCall.args)
  ) {
    return fail('original_identity_mismatch');
  }
  if (
    input.mcpSnapshot === undefined ||
    input.skillCatalog === undefined ||
    (input.mcpSnapshot !== null &&
      createCapabilitySnapshot([...input.mcpSnapshot.descriptors]).revision !==
        input.mcpSnapshot.revision) ||
    (input.skillCatalog !== null &&
      createCapabilitySnapshot([...input.skillCatalog.capabilities.descriptors]).revision !==
        input.skillCatalog.capabilities.revision)
  ) {
    return fail('current_catalog_unavailable');
  }
  // Ordinary Router combines the live MCP snapshot with the current Skill
  // catalog for this non-dynamic Tool. It does not read registry definitions.
  const currentCatalog = createCapabilitySnapshot([
    ...(input.mcpSnapshot?.descriptors ?? []),
    ...(input.skillCatalog?.capabilities.descriptors ?? []),
  ]);
  if (
    currentCatalog.revision !== admitted.capabilityDigest ||
    state.capabilities.catalogRevision !== admitted.capabilityDigest
  ) {
    return fail('current_catalog_mismatch');
  }
  if (
    state.session.canonicalWorkspaceDigest !== admitted.workspaceDigest ||
    state.session.workspace.length === 0
  ) {
    return fail('current_workspace_mismatch');
  }
  const mode = input.interactionModeOverride ?? runtimeHostStateEffectiveInteractionMode(state);
  const phase = getAgentPhase(runtimeHostStateActivePlanning(state));
  if (
    mode !== original.interactionMode ||
    state.interactionModeRevision !== admitted.interactionModeRevision ||
    (admitted.phaseCeiling === 'planning' && phase !== 'planning')
  ) {
    return fail('current_mode_or_phase_mismatch');
  }
  const context = createAppToolTurnContext({
    workspace: state.session.workspace,
    config: input.config,
    threadId: state.session.threadId,
    // The original Turn is identity for read-only resolution, not a new Run.
    turnId: original.turnId,
    modelMessageId: original.modelMessageId,
    toolCallId: original.toolCallId,
    phase,
    interactionMode: mode,
    hasTaskAdapter: true,
    toolSearchEnabled: getFeatureFlags(input.config).toolSearch === true,
    activeTaskId: state.activeTaskId ?? undefined,
    activeSkillFrames: runtimeHostStateActiveSkillFrames(state).filter(
      (frame) => frame.contextMode === 'inline',
    ),
    skillCatalog: input.skillCatalog ?? undefined,
    agentMailboxAvailable: input.agentMailboxPortAvailable && !input.agentMailboxQueueOnlyAvailable,
    agentMailboxQueueOnlyAvailable:
      input.agentMailboxPortAvailable && input.agentMailboxQueueOnlyAvailable,
  });
  const turn = input.pipeline.forTurn(context);
  const resolved = turn.callbacks.resolve(call, {
    currentTurnId: original.turnId,
    availabilityContext: context,
    builtinProjectionRevision: turn.projection.revision,
    dynamicCatalogRevision: currentCatalog.revision,
    bindings: [],
    descriptors: currentCatalog.descriptors,
    disclosures: [],
  });
  if (!resolved.ok) return fail('current_tool_unavailable');
  if (
    resolved.value.target.operationId !== original.operationId ||
    resolved.value.target.capabilityId !== original.capabilityId ||
    resolved.value.target.capabilityRevision !== original.capabilityRevision
  ) {
    return fail('current_catalog_mismatch');
  }
  const validated = turn.callbacks.validate(resolved.value);
  if (!validated.ok) return fail('current_schema_mismatch');
  if (
    validated.value.request.argumentsDigest !== original.argumentsDigest ||
    validated.value.request.schemaDigest !== original.schemaDigest
  ) {
    return fail('current_schema_mismatch');
  }
  const classified = turn.callbacks.classify(validated.value);
  if (!classified.ok) return fail('current_policy_exceeds_admission');
  const verification = turn.callbacks.verifyClassifiedIdentity(classified.value);
  if (verification === false || (typeof verification === 'object' && !verification.valid)) {
    return fail('current_policy_exceeds_admission');
  }
  return { ok: true, classified: classified.value };
}

/** Compare the current, pure policy ceiling with the immutable source admission. */
export function currentSourceFollowupPolicy(
  input: Readonly<CurrentSourceFollowupPolicyInput>,
): CurrentSourceFollowupPolicyResult {
  const result = classifyCurrentFollowupCeiling(input);
  if (!result.ok) return result;
  const original = input.admitted.preparedTool;
  if (!original) return { ok: false, code: 'original_evidence_missing' };
  const current = result.classified;
  const currentEffects = current.policyCompilation.effects ?? {};
  if (
    original.authorizationKind !== 'policy_allow' ||
    original.grantUsed !== 'none' ||
    current.policyCompilation.decision !== 'allow' ||
    current.minimumApproval !== 'none' ||
    !effectsWithin(current.effectiveEffects, original.effectiveEffects) ||
    !policyEffectsWithin(currentEffects, original.policyEffects) ||
    // A different sealed sandbox digest may denote a different path or
    // environment. Its order cannot be inferred from the labels alone.
    (current.policyCompilation.sandboxScope?.digest ?? null) !==
      (original.sandboxScope?.digest ?? null)
  ) {
    return { ok: false, code: 'current_policy_exceeds_admission' };
  }
  return {
    ok: true,
    proof: Object.freeze({
      invocationId: original.invocationId,
      capabilityId: original.capabilityId,
      capabilityRevision: original.capabilityRevision,
      catalogRevision: input.admitted.capabilityDigest,
      policyEffects: currentEffects,
      effectiveEffects: current.effectiveEffects,
      policyCompilationDigest: digestCapabilityValue(current.governance.policy),
      interactionMode: original.interactionMode,
      phase: getAgentPhase(runtimeHostStateActivePlanning(input.state)),
    }),
  };
}

function effectsWithin(
  current: Readonly<CapabilityEffects>,
  original: Readonly<CapabilityEffects>,
) {
  const ranks = { none: 0, read: 1, write: 2, destructive: 3 } as const;
  for (const key of ['filesystem', 'network', 'externalState'] as const) {
    const now = current[key];
    const admitted = original[key];
    if (now === admitted) continue;
    // Unknown is incomparable with concrete effects; it cannot prove a ceiling.
    if (now === 'unknown' || admitted === 'unknown' || ranks[now] > ranks[admitted]) return false;
  }
  return true;
}

function policyEffectsWithin(
  current: Readonly<CapabilityPolicyEffects>,
  original: Readonly<CapabilityPolicyEffects>,
) {
  for (const key of [
    'network',
    'externalRead',
    'externalWrite',
    'uncertainEffects',
    'sensitiveExternalAccess',
  ] as const) {
    if (current[key] === true && original[key] !== true) return false;
  }
  return true;
}
