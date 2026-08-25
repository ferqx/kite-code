import type { VerificationCheck, VerificationSpec } from '@kite-ai/runtime-spi';
import { compileCapabilitySchema, digestCapabilityValue } from '../skills/capability-domain';

const VERIFICATION_CHECK_TYPES_ = new Set<VerificationCheck['type']>([
  'file_assertion',
  'command',
  'schema',
  'mcp_read_after_write',
  'external_reference',
  'receipt',
  'reviewer',
]);

export function validateBuiltinVerificationSpec(spec: VerificationSpec): string[] {
  const diagnostics: string[] = [];
  if (spec.schemaVersion !== 1) diagnostics.push('Unsupported VerificationSpec schema version.');
  if (!spec.verificationId) diagnostics.push('verificationId is required.');
  if (!spec.subject) diagnostics.push('subject is required.');
  if (!Number.isInteger(spec.repair.maxAttempts) || spec.repair.maxAttempts < 0) {
    diagnostics.push('repair.maxAttempts must be a non-negative integer.');
  }
  if (spec.checks.length === 0) diagnostics.push('At least one verification check is required.');
  const ids = new Set<string>();
  for (const check of spec.checks) {
    if (!check.checkId) diagnostics.push('Every verification check requires checkId.');
    if (ids.has(check.checkId))
      diagnostics.push(`Duplicate verification check '${check.checkId}'.`);
    ids.add(check.checkId);
    if (!VERIFICATION_CHECK_TYPES_.has(check.type)) {
      diagnostics.push(`Unsupported check type '${check.type}'.`);
    }
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
    if (check.type === 'receipt' && !check.invocationId) {
      diagnostics.push(`${check.checkId}: invocationId is required.`);
    }
    if (check.type === 'reviewer' && !check.instructions) {
      diagnostics.push(`${check.checkId}: legacy reviewer instructions are required.`);
    }
  }
  return diagnostics;
}

export interface BuiltinCapabilityVerificationRequest {
  readonly type: 'verification.requested';
  readonly verificationId: string;
  readonly taskId?: string;
  readonly mode: 'best_effort' | 'required';
  readonly spec: VerificationSpec;
  readonly requestedAt: string;
}

/** Build concrete verification semantics from a Kernel-selected requirement. */
export function createBuiltinCapabilityVerificationRequest(input: {
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly mode: 'best_effort' | 'required';
  readonly taskId?: string;
  readonly externalReferences?: readonly string[];
  readonly requestedAt: string;
}): BuiltinCapabilityVerificationRequest {
  const verificationId = digestCapabilityValue({
    type: 'capability-verification',
    invocationId: input.invocationId,
  });
  const checks: VerificationCheck[] = [];
  if (input.externalReferences?.length) {
    checks.push({
      checkId: 'external-reference',
      type: 'external_reference',
      description: 'Confirm that execution produced a durable external reference.',
      invocationId: input.invocationId,
    });
  }
  checks.push({
    checkId: 'committed-receipt',
    type: 'receipt',
    description: 'Confirm that the capability invocation has a committed success receipt.',
    invocationId: input.invocationId,
  });
  return Object.freeze({
    type: 'verification.requested',
    verificationId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    mode: input.mode,
    spec: Object.freeze({
      schemaVersion: 1,
      verificationId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      subject: `capability invocation ${input.capabilityId}`,
      checks: Object.freeze(checks),
      repair: Object.freeze({ maxAttempts: 2 }),
    }),
    requestedAt: input.requestedAt,
  });
}
