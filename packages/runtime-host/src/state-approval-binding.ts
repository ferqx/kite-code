import {
  createToolApprovalBindingDigestV1,
  isValidToolApprovalBindingFactsV1,
  type ToolGovernanceInvocationFactV1,
  type ToolGovernancePolicyFactV1,
} from '@kite/agent-kernel';

export type StateToolGovernanceInvocationFactV1 = ToolGovernanceInvocationFactV1;
export type StateToolGovernancePolicyFactV1 = ToolGovernancePolicyFactV1;

export interface RuntimeHostStateVerifiedApprovalBindingInputV1 {
  readonly digest: string;
  readonly invocationFact: Readonly<ToolGovernanceInvocationFactV1>;
  readonly policyFact: Readonly<ToolGovernancePolicyFactV1>;
}

/** Sole State 25 verifier for a transported Kernel approval binding. */
export function runtimeHostStateVerifyApprovalBindingDigestV1(input: {
  readonly digest: unknown;
  readonly invocationFact: unknown;
  readonly policyFact: unknown;
}): input is RuntimeHostStateVerifiedApprovalBindingInputV1 {
  const facts = {
    invocation: input.invocationFact,
    policy: input.policyFact,
  };
  if (
    typeof input.digest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.digest) ||
    !isValidToolApprovalBindingFactsV1(facts)
  ) {
    return false;
  }
  return createToolApprovalBindingDigestV1(facts.invocation, facts.policy) === input.digest;
}

export function runtimeHostStateCreateApprovalBindingDigestV1(
  invocationFact: Readonly<ToolGovernanceInvocationFactV1>,
  policyFact: Readonly<ToolGovernancePolicyFactV1>,
): string {
  return createToolApprovalBindingDigestV1(invocationFact, policyFact);
}
