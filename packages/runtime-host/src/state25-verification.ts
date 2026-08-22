import { type AgentReducerFactsV1, verificationSchemaAdmissionDigestV1 } from '@kite/agent-kernel';

export type RuntimeHostState25VerificationSchemaAdmissionsV1 =
  AgentReducerFactsV1['verificationSchemaAdmissions'];

/** Kernel-owned canonical digest exposed through the Host State25 boundary. */
export function runtimeHostState25VerificationSchemaAdmissionDigestV1(value: unknown): string {
  return verificationSchemaAdmissionDigestV1(value);
}
