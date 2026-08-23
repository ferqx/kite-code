import { compileCapabilitySchema } from '@kite/builtin-runtime/skills';
import {
  type RuntimeHostStateVerificationSchemaAdmissions,
  runtimeHostStateVerificationSchemaAdmissionDigest,
} from '@kite/runtime-host/kernel-adapter';
import type { RuntimeEvent } from './state-runtime';

/**
 * Temporary State 25 Host adapter for VerificationSpec schema admission.
 * Builtin remains the only schema compiler; Kernel receives only canonical,
 * digest-bound facts and never imports execution/schema implementation.
 */
export function projectVerificationSchemaAdmissions(
  event: RuntimeEvent,
): RuntimeHostStateVerificationSchemaAdmissions {
  if (event.type !== 'verification.requested') return undefined;
  let hasSchema = false;
  const admissions = event.spec.checks.map((check) => {
    if (check.type === 'schema') {
      hasSchema = true;
      const compiled = compileCapabilitySchema(check.schema);
      return {
        schemaDigest: runtimeHostStateVerificationSchemaAdmissionDigest(check.schema),
        schemaDiagnostic: compiled.ok ? null : compiled.diagnostic,
      };
    }
    if (check.type === 'mcp_read_after_write' && check.outputSchema) {
      hasSchema = true;
      const compiled = compileCapabilitySchema(check.outputSchema);
      return {
        outputSchemaDigest: runtimeHostStateVerificationSchemaAdmissionDigest(check.outputSchema),
        outputSchemaDiagnostic: compiled.ok ? null : compiled.diagnostic,
      };
    }
    return null;
  });
  return hasSchema ? admissions : undefined;
}
