import {
  createToolApprovalBindingDigest,
  isValidToolApprovalBindingFacts,
  type ToolGovernanceInvocationFact,
  type ToolGovernancePolicyFact,
} from '@kite/agent-kernel';

export type StateToolGovernanceInvocationFact = ToolGovernanceInvocationFact;
export type StateToolGovernancePolicyFact = ToolGovernancePolicyFact;

export interface RuntimeHostStateVerifiedApprovalBindingInput {
  readonly digest: string;
  readonly invocationFact: Readonly<ToolGovernanceInvocationFact>;
  readonly policyFact: Readonly<ToolGovernancePolicyFact>;
}

/** Sole State 25 verifier for a transported Kernel approval binding. */
export function runtimeHostStateVerifyApprovalBindingDigest(input: {
  readonly digest: unknown;
  readonly invocationFact: unknown;
  readonly policyFact: unknown;
}): input is RuntimeHostStateVerifiedApprovalBindingInput {
  const facts = {
    invocation: input.invocationFact,
    policy: input.policyFact,
  };
  if (
    typeof input.digest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.digest) ||
    !isValidToolApprovalBindingFacts(facts)
  ) {
    return false;
  }
  return createToolApprovalBindingDigest(facts.invocation, facts.policy) === input.digest;
}

export function runtimeHostStateCreateApprovalBindingDigest(
  invocationFact: Readonly<ToolGovernanceInvocationFact>,
  policyFact: Readonly<ToolGovernancePolicyFact>,
): string {
  return createToolApprovalBindingDigest(invocationFact, policyFact);
}
