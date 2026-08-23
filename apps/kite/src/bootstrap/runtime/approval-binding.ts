import { digestCapabilityValue } from '@kite/builtin-runtime';
import type { ToolApprovalPayload } from '@kite/runtime-contract';
import {
  runtimeHostStateVerifyApprovalBindingDigest,
  type StateToolGovernanceInvocationFact,
  type StateToolGovernancePolicyFact,
} from '@kite/runtime-host';

export const APP_APPROVAL_BINDING_SCHEMA_ = 'kite.app-approval-binding.v1' as const;

/**
 * App-only transport wrapper for Kernel governance facts.  App may carry this
 * value across a private child continuation, but it never computes policy or
 * changes either Kernel fact.
 */
export interface AppApprovalBinding {
  readonly schema: typeof APP_APPROVAL_BINDING_SCHEMA_;
  readonly digest: string;
  readonly invocationFact: Readonly<StateToolGovernanceInvocationFact>;
  readonly policyFact: Readonly<StateToolGovernancePolicyFact>;
  readonly childToolCallId?: string;
  readonly runtimeToolCallId?: string;
}

const approvalBindings = new WeakMap<object, AppApprovalBinding>();

export function bindAppApprovalBinding(
  presentation: ToolApprovalPayload,
  input: Omit<AppApprovalBinding, 'schema'>,
): void {
  approvalBindings.set(
    presentation,
    Object.freeze({ schema: APP_APPROVAL_BINDING_SCHEMA_, ...input }),
  );
}

export function appApprovalBindingForPresentation(
  presentation: ToolApprovalPayload,
): AppApprovalBinding | undefined {
  return approvalBindings.get(presentation);
}

/**
 * Decode the opaque continuation payload back into the App binding shape.
 * Kernel validates the complete invocation/policy fact pair; this boundary
 * only owns the App transport envelope and rejects unknown fields before any
 * caller can treat an untrusted JSON object as a binding.
 */
export function decodeAppApprovalBinding(value: unknown): AppApprovalBinding | undefined {
  if (!plainRecord(value)) return undefined;
  const childToolCallId = value.childToolCallId;
  const runtimeToolCallId = value.runtimeToolCallId;
  const verifiedInput = {
    digest: value.digest,
    invocationFact: value.invocationFact,
    policyFact: value.policyFact,
  };
  if (
    !exactKeys(
      value,
      ['schema', 'digest', 'invocationFact', 'policyFact'],
      ['childToolCallId', 'runtimeToolCallId'],
    ) ||
    value.schema !== APP_APPROVAL_BINDING_SCHEMA_ ||
    (childToolCallId !== undefined && !nonEmptyString(childToolCallId)) ||
    (runtimeToolCallId !== undefined && !nonEmptyString(runtimeToolCallId)) ||
    !runtimeHostStateVerifyApprovalBindingDigest(verifiedInput)
  ) {
    return undefined;
  }

  const { digest, invocationFact, policyFact } = verifiedInput;
  return Object.freeze({
    schema: APP_APPROVAL_BINDING_SCHEMA_,
    digest,
    invocationFact: Object.freeze({ ...invocationFact }),
    policyFact: Object.freeze({
      ...policyFact,
      ...(policyFact.effects ? { effects: Object.freeze({ ...policyFact.effects }) } : {}),
      expectedEffects: Object.freeze([...policyFact.expectedEffects]),
    }),
    ...(childToolCallId === undefined ? {} : { childToolCallId }),
    ...(runtimeToolCallId === undefined ? {} : { runtimeToolCallId }),
  });
}

/** Validate the exact Kernel facts and child identity before any interaction. */
export function isAuthenticAppApprovalBinding(input: {
  readonly binding: AppApprovalBinding;
  readonly blocked: {
    readonly toolCallId: string;
    readonly runtimeToolCallId?: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
  };
}): boolean {
  const { blocked } = input;
  const binding = decodeAppApprovalBinding(input.binding);
  if (!binding) return false;
  if (
    binding.childToolCallId !== blocked.toolCallId ||
    binding.runtimeToolCallId !== blocked.runtimeToolCallId ||
    binding.invocationFact.exposedToolName !== blocked.toolName ||
    binding.invocationFact.argumentsDigest !== digestCapabilityValue(blocked.args)
  ) {
    return false;
  }
  if (
    binding.runtimeToolCallId !== undefined &&
    binding.invocationFact.toolCallId !== binding.runtimeToolCallId
  ) {
    return false;
  }
  return true;
}

type PlainRecord = Record<string, unknown>;

function plainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => 'value' in descriptor && descriptor.enumerable,
    )
  );
}

function exactKeys(
  value: PlainRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
