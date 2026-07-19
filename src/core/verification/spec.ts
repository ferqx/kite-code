import { compileCapabilitySchema } from '@/core/capabilities/schema';
import type { VerificationCheck, VerificationSpecV1 } from '@/protocol/verification';

const CHECK_TYPES = new Set<VerificationCheck['type']>([
  'file_assertion',
  'command',
  'schema',
  'mcp_read_after_write',
  'external_reference',
  'reviewer',
]);

export function validateVerificationSpec(spec: VerificationSpecV1): string[] {
  const diagnostics: string[] = [];
  if (spec.schemaVersion !== 1) diagnostics.push('Unsupported VerificationSpec schema version.');
  if (!spec.verificationId) diagnostics.push('verificationId is required.');
  if (!spec.subject) diagnostics.push('subject is required.');
  if (!Number.isInteger(spec.repair.maxAttempts) || spec.repair.maxAttempts < 0) {
    diagnostics.push('repair.maxAttempts must be a non-negative integer.');
  }
  if (spec.checks.length === 0) diagnostics.push('At least one verification check is required.');
  const ids = new Set<string>();
  let reviewerSeen = false;
  for (const check of spec.checks) {
    if (!check.checkId) diagnostics.push('Every verification check requires checkId.');
    if (ids.has(check.checkId))
      diagnostics.push(`Duplicate verification check '${check.checkId}'.`);
    ids.add(check.checkId);
    if (!CHECK_TYPES.has(check.type)) diagnostics.push(`Unsupported check type '${check.type}'.`);
    if (reviewerSeen && check.type !== 'reviewer') {
      diagnostics.push(`${check.checkId}: deterministic checks must run before reviewer checks.`);
    }
    reviewerSeen ||= check.type === 'reviewer';
    if (check.type === 'file_assertion') {
      if (!check.path) diagnostics.push(`${check.checkId}: path is required.`);
      if (check.assertion === 'sha256_equals' && !check.expectedDigest) {
        diagnostics.push(`${check.checkId}: expectedDigest is required.`);
      }
    }
    if (check.type === 'command' && !check.command) {
      diagnostics.push(`${check.checkId}: command is required.`);
    }
    if (check.type === 'schema') {
      const compiled = compileCapabilitySchema(check.schema);
      if (!compiled.ok) diagnostics.push(`${check.checkId}: ${compiled.diagnostic}`);
    }
    if (check.type === 'mcp_read_after_write') {
      if (!check.invocationId || !check.capabilityId || !check.capabilityRevision) {
        diagnostics.push(`${check.checkId}: invocation and capability identity are required.`);
      }
      if (check.outputSchema) {
        const compiled = compileCapabilitySchema(check.outputSchema);
        if (!compiled.ok) diagnostics.push(`${check.checkId}: ${compiled.diagnostic}`);
      }
    }
    if (check.type === 'external_reference' && !check.invocationId) {
      diagnostics.push(`${check.checkId}: invocationId is required.`);
    }
    if (check.type === 'reviewer' && !check.instructions) {
      diagnostics.push(`${check.checkId}: reviewer instructions are required.`);
    }
  }
  return diagnostics;
}
