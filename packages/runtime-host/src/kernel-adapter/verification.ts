import { type AgentReducerFacts, verificationSchemaAdmissionDigest } from '@kite/agent-kernel';

export type RuntimeHostStateVerificationSchemaAdmissions =
  AgentReducerFacts['verificationSchemaAdmissions'];

/** Kernel-owned canonical digest exposed through the Host State boundary. */
export function runtimeHostStateVerificationSchemaAdmissionDigest(value: unknown): string {
  return verificationSchemaAdmissionDigest(value);
}
