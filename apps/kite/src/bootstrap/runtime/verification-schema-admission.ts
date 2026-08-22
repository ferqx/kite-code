import { compileCapabilitySchemaV1 } from '@kite/builtin-runtime';
import {
  type RuntimeHostState26VerificationSchemaAdmissionsV1,
  runtimeHostState26VerificationSchemaAdmissionDigestV1,
} from '@kite/runtime-host';
import type { RuntimeEvent } from './state26-runtime';

/**
 * Temporary State 25 Host adapter for VerificationSpec schema admission.
 * Builtin remains the only schema compiler; Kernel receives only canonical,
 * digest-bound facts and never imports execution/schema implementation.
 */
export function projectVerificationSchemaAdmissionsV1(
  event: RuntimeEvent,
): RuntimeHostState26VerificationSchemaAdmissionsV1 {
  if (event.type !== 'verification.requested') return undefined;
  let hasSchema = false;
  const admissions = event.spec.checks.map((check) => {
    if (check.type === 'schema') {
      hasSchema = true;
      const compiled = compileCapabilitySchemaV1(check.schema);
      return {
        schemaDigest: runtimeHostState26VerificationSchemaAdmissionDigestV1(check.schema),
        schemaDiagnostic: compiled.ok ? null : compiled.diagnostic,
      };
    }
    if (check.type === 'mcp_read_after_write' && check.outputSchema) {
      hasSchema = true;
      const compiled = compileCapabilitySchemaV1(check.outputSchema);
      return {
        outputSchemaDigest: runtimeHostState26VerificationSchemaAdmissionDigestV1(
          check.outputSchema,
        ),
        outputSchemaDiagnostic: compiled.ok ? null : compiled.diagnostic,
      };
    }
    return null;
  });
  return hasSchema ? admissions : undefined;
}
