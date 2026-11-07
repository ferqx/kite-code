import { toolBehaviorBinding } from './authorization-check-output';
import type { AuthorizationRequest, Json, PermissionDecision, Permissions } from './extensions';
import { canonicalJson, semanticDigest } from './json';
import type { CapabilityBinding } from './permission-grants';
import { AgentError } from './storage/types';
import type { ToolBehaviorBinding } from './tool-behavior';

/** A closed, exact internal operation. Keys are the original operations.ensure keys. */
export interface ConfirmedExecutionStep {
  readonly key: string;
  readonly capability: CapabilityBinding;
  readonly input: Json;
}
/** Trusted definition owner declaration; never supplied by Model input or a Tool result. */
export interface ExecutionConfirmationDeclaration {
  readonly request: Json;
  readonly steps?: readonly ConfirmedExecutionStep[];
}
export interface ExecutionConfirmationBinding {
  readonly owner: ToolBehaviorBinding;
  readonly executionId: string;
  readonly attempt: number;
  readonly inputDigest: string;
  readonly requestDigest: string;
  readonly steps: readonly {
    readonly key: string;
    readonly capability: CapabilityBinding;
    readonly inputDigest: string;
  }[];
}
export interface ExecutionConfirmationProof {
  readonly binding: ExecutionConfirmationBinding;
  readonly interactionId: string;
  readonly decisionRevision: string;
  readonly stepKey?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function executionConfirmationBinding(value: unknown): ExecutionConfirmationBinding {
  const owner = object(value) ? toolBehaviorBinding(value.owner) : null;
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !['owner', 'executionId', 'attempt', 'inputDigest', 'requestDigest', 'steps'].includes(key),
    ) ||
    !owner ||
    !['tool', 'job'].includes(owner.capability.kind) ||
    !text(value.executionId) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    !hash(value.inputDigest) ||
    !hash(value.requestDigest) ||
    !Array.isArray(value.steps) ||
    value.steps.length > 16
  )
    throw new AgentError('execution_confirmation_invalid');
  const keys = new Set<string>();
  for (const step of value.steps) {
    if (
      !object(step) ||
      Object.keys(step).some((key) => !['key', 'capability', 'inputDigest'].includes(key)) ||
      !text(step.key) ||
      keys.has(step.key) ||
      !object(step.capability) ||
      Object.keys(step.capability).some(
        (key) => !['kind', 'definitionId', 'definitionVersion'].includes(key),
      ) ||
      step.capability.kind !== 'job' ||
      !text(step.capability.definitionId) ||
      !text(step.capability.definitionVersion) ||
      !hash(step.inputDigest)
    )
      throw new AgentError('execution_confirmation_invalid');
    keys.add(step.key);
  }
  return structuredClone(value) as unknown as ExecutionConfirmationBinding;
}
export async function bindExecutionConfirmation(
  owner: ToolBehaviorBinding,
  request: AuthorizationRequest,
  attempt: number,
  declaration: ExecutionConfirmationDeclaration,
): Promise<ExecutionConfirmationBinding> {
  return executionConfirmationBinding({
    owner,
    executionId: request.executionId,
    attempt,
    inputDigest: await semanticDigest(request.input),
    requestDigest: await semanticDigest(declaration.request),
    steps: await Promise.all(
      (declaration.steps ?? []).map(async (step) => ({
        key: step.key,
        capability: step.capability,
        inputDigest: await semanticDigest(step.input),
      })),
    ),
  });
}
/** Each policy explicitly consumes only its own soft challenge. A callback is no grant. */
export async function consumesExecutionConfirmation(
  permissions: Permissions,
  request: AuthorizationRequest,
  decision: PermissionDecision,
  binding: ToolBehaviorBinding,
): Promise<boolean> {
  if (decision.allowed) return true;
  if (!decision.approval && !decision.check) return false;
  return (await permissions.consumesExecutionConfirmation?.(request, decision, binding)) === true;
}
export function sameExecutionConfirmation(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left as Json) === canonicalJson(right as Json);
  } catch {
    return false;
  }
}

export type PreparedExecutionConfirmation =
  | {
      readonly binding: ExecutionConfirmationBinding;
      readonly declaration: ExecutionConfirmationDeclaration;
    }
  | { readonly proof: ExecutionConfirmationProof };
