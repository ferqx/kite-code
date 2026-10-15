import { createHash } from 'node:crypto';
import type { PlanningState } from '../business/planning';
import type { AuthorizationRequest, Json, PermissionDecision, Permissions } from '../extensions';
import { AgentError } from '../storage/types';
import { type CapabilityDescription, createPermissionPolicy } from './index';

const object = (value: Json | undefined): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const permissionConstraintDigest = (value: Json) =>
  createHash('sha256').update(canonical(value)).digest('hex');
type PlanningRunIdentity = { runId: string; sessionId: string };

const management = new Set([
  'planning.read',
  'planning.write',
  'planning.review',
  'planning.update',
  'validation.define',
  'validation.check',
  'validation.rebind',
]);

/** One ceiling cannot grant a call denied by current policy or widen its grant scope. */
function intersect(
  current: PermissionDecision,
  ceiling: PermissionDecision,
  state: PlanningState,
  identity: PlanningRunIdentity | undefined,
): PermissionDecision {
  const revision = permissionConstraintDigest({
    current: current as unknown as Json,
    ceiling: ceiling as unknown as Json,
    state: state as unknown as Json,
    identity: identity ?? null,
  });
  const proof = {
    ...(current.controlReads === undefined ? {} : { controlReads: current.controlReads }),
    snapshot: {
      namespace: 'builtin.planning.permissions',
      version: '1',
      data: {
        planning: state as unknown as Json,
        originalRun: identity ?? null,
        current: current.snapshot ?? null,
        ceiling: ceiling.snapshot ?? null,
      },
    },
  };
  if (!current.allowed && !current.approval && !current.review)
    return { allowed: false, revision, reason: current.reason, ...proof };
  if (!ceiling.allowed && !ceiling.approval && !ceiling.review)
    return { allowed: false, revision, reason: ceiling.reason, ...proof };
  if (ceiling.allowed) return { ...current, revision, ...proof };
  if (current.allowed) return { ...ceiling, revision, ...proof };
  const decisions = [current, ceiling];
  const approvals = decisions.filter((decision) => decision.approval);
  const reviews = decisions.filter((decision) => decision.review);
  const scopes = decisions.map((decision, index) => ({
    scope: index === 0 ? 'current' : 'plan',
    revision: decision.revision,
    request: decision.approval?.request ?? null,
  }));
  const commandDigest = approvals[0]?.approval?.commandDigest;
  const sameCommand =
    !!commandDigest &&
    approvals.every(
      (decision) =>
        decision.approval?.commandDigest === commandDigest &&
        decision.approval.grants?.includes('same_command'),
    );
  return {
    allowed: false,
    revision,
    reason: 'planning_mode_ceiling',
    ...proof,
    ...(approvals.length
      ? {
          approval: {
            request: { kind: 'planning_mode_ceiling', policies: scopes },
            ...(sameCommand
              ? { grants: ['approve_once', 'same_command'] as const, commandDigest }
              : {}),
          },
        }
      : {}),
    ...(reviews.length
      ? {
          review: {
            request: {
              kind: 'planning_mode_ceiling',
              policies: decisions.map((decision, index) => ({
                scope: index === 0 ? 'current' : 'plan',
                revision: decision.revision,
                request: decision.review?.request ?? null,
              })),
            },
            requireApproval: decisions.some(
              (decision) =>
                decision.review?.requireApproval || (!!decision.approval && !decision.review),
            ),
          },
        }
      : {}),
  };
}

export function createPlanningPermissionPolicy(options: {
  required: boolean;
  readState(
    request: AuthorizationRequest,
    identity: PlanningRunIdentity | undefined,
  ): Promise<PlanningState>;
  run: () => PlanningRunIdentity | undefined;
  current: Permissions;
  describe: (request: AuthorizationRequest) => CapabilityDescription | null;
}): Permissions {
  return {
    toolDispatchOrder: options.current.toolDispatchOrder,
    async authorize(request) {
      request.signal.throwIfAborted();
      const current = await options.current.authorize(request);
      if (!options.required) return current;
      const identity = options.run();
      let state: PlanningState;
      try {
        state = await options.readState(request, identity);
        if (state.status === 'disabled')
          throw new AgentError('planning_run_obligation_unavailable');
      } catch {
        return intersect(
          current,
          {
            allowed: false,
            revision: 'planning-scope-1',
            reason: 'planning_run_scope_unavailable',
          },
          { status: 'pending' },
          identity,
        );
      }
      request.signal.throwIfAborted();
      const description = options.describe(request);
      const beforeApproval =
        request.kind === 'model' ||
        (request.kind === 'tool' &&
          ((request.definitionVersion === '1' && management.has(request.definitionId)) ||
            (!!description?.safeRead && description.effects.every((effect) => effect === 'read'))));
      if (state.status !== 'approved' || beforeApproval)
        return intersect(
          current,
          {
            allowed: beforeApproval,
            revision: 'planning-preapproval-1',
            ...(beforeApproval ? {} : { reason: 'plan_approval_required' }),
          },
          state,
          identity,
        );
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode: state.mode,
          workspaceTrust: true,
          revision: `plan:${state.planId}:${state.version}:${state.digest}`,
          allowed: [
            {
              kind: request.kind,
              definitionId: request.definitionId,
              definitionVersion: request.definitionVersion,
            },
          ],
        }),
        describeCapability: options.describe,
      });
      return intersect(current, await policy.authorize(request), state, identity);
    },
  };
}

/** A trusted workflow minimum may require a human; it cannot relax a hard denial. */
export function requireWorkflowApproval(
  decision: PermissionDecision,
  minimum: Json | undefined,
): PermissionDecision {
  if (minimum && minimum !== 'none' && (decision.allowed || decision.approval || decision.review)) {
    return {
      ...decision,
      allowed: false,
      review: decision.review ? { ...decision.review, requireApproval: true } : undefined,
      approval: decision.approval ?? {
        request: { reason: 'workflow_minimum_approval', minimum },
      },
      reason: 'workflow_minimum_approval',
    };
  }
  return decision;
}

/** Explicit file restoration always uses the original exact human approval contract. */
export function requireFileRestoreApproval(
  request: AuthorizationRequest,
  decision: PermissionDecision,
): PermissionDecision {
  // Restoring files is an explicit human decision, independent of Model/reviewer authority.
  if (
    request.kind === 'job' &&
    request.definitionId === 'builtin.files/files.checkpoint.restore' &&
    request.definitionVersion === '1' &&
    (decision.allowed || decision.approval || decision.review)
  ) {
    return {
      allowed: false,
      reason: 'approval_required',
      revision: createHash('sha256')
        .update(decision.revision)
        .update('files-human-restore-1')
        .digest('hex'),
      ...(decision.controlReads ? { controlReads: decision.controlReads } : {}),
      ...(decision.snapshot ? { snapshot: decision.snapshot } : {}),
      approval: {
        grants: ['approve_once'],
        request: { reason: 'explicit_file_restore', effects: ['workspace_write'] },
      },
    };
  }
  return decision;
}
