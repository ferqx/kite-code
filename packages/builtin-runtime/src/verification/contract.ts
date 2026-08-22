import type { VerificationCheck, VerificationSpecV1 } from '@kite/runtime-spi';
import { compileCapabilitySchemaV1, digestCapabilityValueV1 } from '../skills/capability-domain';

const VERIFICATION_CHECK_TYPES_V1 = new Set<VerificationCheck['type']>([
  'file_assertion',
  'command',
  'schema',
  'mcp_read_after_write',
  'external_reference',
  'reviewer',
]);

export function validateBuiltinVerificationSpecV1(spec: VerificationSpecV1): string[] {
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
    if (!VERIFICATION_CHECK_TYPES_V1.has(check.type)) {
      diagnostics.push(`Unsupported check type '${check.type}'.`);
    }
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
      const compiled = compileCapabilitySchemaV1(check.schema);
      if (!compiled.ok) diagnostics.push(`${check.checkId}: ${compiled.diagnostic}`);
    }
    if (check.type === 'mcp_read_after_write') {
      if (!check.invocationId || !check.capabilityId || !check.capabilityRevision) {
        diagnostics.push(`${check.checkId}: invocation and capability identity are required.`);
      }
      if (check.outputSchema) {
        const compiled = compileCapabilitySchemaV1(check.outputSchema);
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

export interface BuiltinCapabilityVerificationRequestV1 {
  readonly type: 'verification.requested';
  readonly verificationId: string;
  readonly taskId?: string;
  readonly mode: 'best_effort' | 'required';
  readonly spec: VerificationSpecV1;
  readonly requestedAt: string;
}

/** Build concrete verification semantics from a Kernel-selected requirement. */
export function createBuiltinCapabilityVerificationRequestV1(input: {
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly mode: 'best_effort' | 'required';
  readonly taskId?: string;
  readonly externalReferences?: readonly string[];
  readonly requestedAt: string;
}): BuiltinCapabilityVerificationRequestV1 {
  const verificationId = digestCapabilityValueV1({
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
    checkId: 'independent-review',
    type: 'reviewer',
    description: 'Review the original execution receipt and immutable evidence.',
    invocationIds: [input.invocationId],
    instructions: `Determine whether ${input.capabilityId} achieved its externally visible outcome.`,
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
