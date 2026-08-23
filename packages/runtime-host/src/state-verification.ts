import { type AgentReducerFactsV1, verificationSchemaAdmissionDigestV1 } from '@kite/agent-kernel';

export type RuntimeHostStateVerificationSchemaAdmissionsV1 =
  AgentReducerFactsV1['verificationSchemaAdmissions'];

/** Kernel-owned canonical digest exposed through the Host State boundary. */
export function runtimeHostStateVerificationSchemaAdmissionDigestV1(value: unknown): string {
  return verificationSchemaAdmissionDigestV1(value);
}
