import { digestCapabilityValueV1 } from '@kite/builtin-runtime';
import type { ToolApprovalPayload } from '@kite/runtime-contract';
import {
  runtimeHostState25VerifyApprovalBindingDigestV1,
  type State25ToolGovernanceInvocationFactV1,
  type State25ToolGovernancePolicyFactV1,
} from '@kite/runtime-host';

export const APP_APPROVAL_BINDING_SCHEMA_V1 = 'kite.app-approval-binding.v1' as const;

/**
 * App-only transport wrapper for Kernel governance facts.  App may carry this
 * value across a private child continuation, but it never computes policy or
 * changes either Kernel fact.
 */
export interface AppApprovalBindingV1 {
  readonly schema: typeof APP_APPROVAL_BINDING_SCHEMA_V1;
  readonly digest: string;
  readonly invocationFact: Readonly<State25ToolGovernanceInvocationFactV1>;
  readonly policyFact: Readonly<State25ToolGovernancePolicyFactV1>;
  readonly childToolCallId?: string;
  readonly runtimeToolCallId?: string;
}

const approvalBindings = new WeakMap<object, AppApprovalBindingV1>();

export function bindAppApprovalBindingV1(
  presentation: ToolApprovalPayload,
  input: Omit<AppApprovalBindingV1, 'schema'>,
): void {
  approvalBindings.set(
    presentation,
    Object.freeze({ schema: APP_APPROVAL_BINDING_SCHEMA_V1, ...input }),
  );
}

export function appApprovalBindingForPresentationV1(
  presentation: ToolApprovalPayload,
): AppApprovalBindingV1 | undefined {
  return approvalBindings.get(presentation);
}

/**
 * Decode the opaque continuation payload back into the App binding shape.
 * Kernel validates the complete invocation/policy fact pair; this boundary
 * only owns the App transport envelope and rejects unknown fields before any
 * caller can treat an untrusted JSON object as a binding.
 */
export function decodeAppApprovalBindingV1(value: unknown): AppApprovalBindingV1 | undefined {
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
    value.schema !== APP_APPROVAL_BINDING_SCHEMA_V1 ||
    (childToolCallId !== undefined && !nonEmptyString(childToolCallId)) ||
    (runtimeToolCallId !== undefined && !nonEmptyString(runtimeToolCallId)) ||
    !runtimeHostState25VerifyApprovalBindingDigestV1(verifiedInput)
  ) {
    return undefined;
  }

  const { digest, invocationFact, policyFact } = verifiedInput;
  return Object.freeze({
    schema: APP_APPROVAL_BINDING_SCHEMA_V1,
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
export function isAuthenticAppApprovalBindingV1(input: {
  readonly binding: AppApprovalBindingV1;
  readonly blocked: {
    readonly toolCallId: string;
    readonly runtimeToolCallId?: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
  };
}): boolean {
  const { blocked } = input;
  const binding = decodeAppApprovalBindingV1(input.binding);
  if (!binding) return false;
  if (
    binding.childToolCallId !== blocked.toolCallId ||
    binding.runtimeToolCallId !== blocked.runtimeToolCallId ||
    binding.invocationFact.exposedToolName !== blocked.toolName ||
    binding.invocationFact.argumentsDigest !== digestCapabilityValueV1(blocked.args)
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
