import { sha256Hex } from './hash';

/** Builtin-compiled admission result carried by Host and bound to one exact VerificationSpec. */
export interface VerificationSchemaAdmissionFact {
  readonly schemaDigest?: string;
  /** null means the injected Builtin compiler admitted the schema. */
  readonly schemaDiagnostic?: string | null;
  readonly outputSchemaDigest?: string;
  /** null means the injected Builtin compiler admitted the output schema. */
  readonly outputSchemaDiagnostic?: string | null;
}

/** Bind a transient admission fact to the exact schema bytes in its KernelEvent. */
export function verificationSchemaAdmissionDigest(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Verification schema cannot be serialized.');
  return sha256Hex(serialized);
}
