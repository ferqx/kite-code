import { randomUUID } from 'node:crypto';
import { validateCapabilityArguments } from './capability-domain';
import { findSkillCatalogEntry, type SkillCatalogSnapshot } from './catalog';
import type {
  SkillFeatureFlags as FeatureFlags,
  SkillRuntimeEvent as RuntimeEvent,
  SkillRuntimeStateView as RuntimeState,
  SkillActivation,
} from './runtime-domain';

export interface SkillActivationRequest {
  skillId: string;
  input: unknown;
  requestedBy: 'user' | 'model';
  /** Model requests are implicit unless the user has explicitly started the activation. */
  implicit: boolean;
}

export type SkillActivationEvaluation =
  | { ok: true; activation: SkillActivation; events: RuntimeEvent[] }
  | { ok: false; reason: string };

/**
 * Validates a Skill activation against the catalog snapshot and creates only
 * durable Runtime facts. It deliberately does not execute the instruction
 * body: Runtime is still responsible for binding every capability in the
 * frame and for applying the normal policy/approval gateway to each call.
 */
export function evaluateSkillActivation(input: {
  state: Readonly<RuntimeState>;
  catalog: SkillCatalogSnapshot;
  request: SkillActivationRequest;
  flags: FeatureFlags;
  now?: Date;
  /** Command planners inject a deterministic content-free identity. */
  activationId?: string;
}): SkillActivationEvaluation {
  if (!input.flags.skillWorkflow || !input.flags.skillActivation) {
    return { ok: false, reason: 'Skill Workflow activation is disabled by feature flag.' };
  }
  const taskId = input.state.activeTaskId;
  if (!taskId) return { ok: false, reason: 'Skill activation requires an active Runtime task.' };
  const entry = findSkillCatalogEntry(input.catalog, input.request.skillId);
  if (!entry?.contract || entry.descriptor.availability !== 'available') {
    return { ok: false, reason: `Skill '${input.request.skillId}' is unavailable or invalid.` };
  }
  if (input.request.implicit && !entry.contract.invocation.allowImplicit) {
    return {
      ok: false,
      reason: `Skill '${entry.contract.name}' requires explicit user activation.`,
    };
  }
  if (!input.request.implicit && !entry.contract.invocation.allowManual) {
    return {
      ok: false,
      reason: `Skill '${entry.contract.name}' does not permit manual activation.`,
    };
  }
  if (
    !input.request.input ||
    typeof input.request.input !== 'object' ||
    Array.isArray(input.request.input)
  ) {
    return { ok: false, reason: 'Skill activation input must be an object.' };
  }
  const inputError = validateCapabilityArguments(
    entry.contract.inputSchema,
    input.request.input as Record<string, unknown>,
  );
  if (inputError) return { ok: false, reason: inputError };
  if (
    input.activationId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.activationId)
  ) {
    return { ok: false, reason: 'Skill activation identifier is invalid.' };
  }

  const activation: SkillActivation = {
    activationId: input.activationId ?? randomUUID(),
    skillId: entry.descriptor.capabilityId,
    skillRevision: entry.descriptor.revision,
    taskId,
    input: input.request.input,
    contextMode: entry.contract.context.mode,
    agent: entry.contract.context.agent,
    capabilityCeiling: entry.contract.effectiveCapabilityCeiling,
    verificationMode: entry.contract.verification.mode,
    requestedBy: input.request.requestedBy,
    activatedAt: (input.now ?? new Date()).toISOString(),
  };
  const events: RuntimeEvent[] = [
    ...(input.state.skills.catalogRevision === input.catalog.revision
      ? []
      : [{ type: 'skill.catalog_refreshed' as const, catalogRevision: input.catalog.revision }]),
    { type: 'skill.activation_started', activation },
  ];
  return { ok: true, activation, events };
}

/** A frame becomes unusable as soon as its source or any dependency revision drifts. */
export function skillFrameInvalidationReason(
  frame: SkillActivation,
  catalog: SkillCatalogSnapshot,
): string | null {
  const entry = findSkillCatalogEntry(catalog, frame.skillId);
  if (entry?.descriptor.availability !== 'available' || !entry.contract) {
    return `Skill '${frame.skillId}' is no longer available in the current catalog.`;
  }
  if (entry.descriptor.revision !== frame.skillRevision) {
    return `Skill '${frame.skillId}' changed after activation; start a new activation.`;
  }
  return null;
}
