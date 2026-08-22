import type { KernelEvent } from '../../events';
import type { AgentReducerFactsV1 } from '../../reducer';
import {
  asJsonObject,
  eventRecord,
  nonEmptyStringField,
  numberField,
  recordField,
  stringField,
} from '../../reducer-utils';
import type { AgentState } from '../../state';
import { verificationSchemaAdmissionDigestV1 } from '../../verification-schema-facts';

const EPOCH_CREATED_AT = '1970-01-01T00:00:00.000Z';

function recordsFor(state: AgentState) {
  return recordField(state.verification, 'records') ?? {};
}

function withRecord(state: AgentState, verificationId: string, record: object): AgentState {
  return {
    ...state,
    verification: asJsonObject({
      ...state.verification,
      records: { ...recordsFor(state), [verificationId]: asJsonObject(record) },
    }),
  };
}

function appendInstruction(
  state: AgentState,
  verificationId: string,
  instruction: string,
): AgentState {
  return {
    ...state,
    transcript: {
      ...state.transcript,
      final: undefined,
      messages: [
        ...state.transcript.messages,
        asJsonObject({
          kind: 'runtime',
          messageId: `verification-${verificationId}-${state.revision}`,
          turnId: state.turn.turnId,
          ordinal: state.transcript.messages.length,
          createdAt: EPOCH_CREATED_AT,
          content: instruction,
        }),
      ],
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keep the State25 verification admission diagnostics equivalent to the
 * Runtime validator. The event codec owns required top-level fields; this
 * function deliberately reads repair/checks directly so malformed legacy
 * payloads fail with the same deterministic TypeError as the Runtime owner.
 */
function schemaAdmissionDiagnostic(
  facts: AgentReducerFactsV1,
  checkIndex: number,
  schema: unknown,
  target: 'schema' | 'outputSchema',
): string | null {
  const admission = facts.verificationSchemaAdmissions?.[checkIndex];
  const digestKey = target === 'schema' ? 'schemaDigest' : 'outputSchemaDigest';
  const diagnosticKey = target === 'schema' ? 'schemaDiagnostic' : 'outputSchemaDiagnostic';
  if (
    !admission ||
    !Object.hasOwn(admission, digestKey) ||
    !Object.hasOwn(admission, diagnosticKey)
  ) {
    return `Host admission fact is missing for VerificationSpec ${target}.`;
  }
  if (admission[digestKey] !== verificationSchemaAdmissionDigestV1(schema)) {
    return `Host admission fact identity mismatches VerificationSpec ${target}.`;
  }
  const diagnostic = admission[diagnosticKey];
  return typeof diagnostic === 'string' ? diagnostic : null;
}

function validateVerificationSpec(
  specValue: unknown,
  facts: AgentReducerFactsV1,
): readonly string[] {
  const spec = specValue as Readonly<Record<string, unknown>>;
  const diagnostics: string[] = [];
  if (spec.schemaVersion !== 1) diagnostics.push('Unsupported VerificationSpec schema version.');
  if (!spec.verificationId) diagnostics.push('verificationId is required.');
  if (!spec.subject) diagnostics.push('subject is required.');

  const repair = spec.repair as Readonly<Record<string, unknown>>;
  const maxAttempts = repair.maxAttempts;
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 0) {
    diagnostics.push('repair.maxAttempts must be a non-negative integer.');
  }
  const checks = spec.checks as readonly unknown[];
  if (checks.length === 0) diagnostics.push('At least one verification check is required.');
  const ids = new Set<string>();
  let reviewerSeen = false;
  for (const [checkIndex, candidate] of checks.entries()) {
    const check = isRecord(candidate) ? candidate : {};
    const checkId = typeof check.checkId === 'string' ? check.checkId : '';
    if (!checkId) diagnostics.push('Every verification check requires checkId.');
    if (ids.has(checkId)) diagnostics.push(`Duplicate verification check '${checkId}'.`);
    ids.add(checkId);
    const type = typeof check.type === 'string' ? check.type : '';
    if (
      ![
        'file_assertion',
        'command',
        'schema',
        'mcp_read_after_write',
        'external_reference',
        'reviewer',
      ].includes(type)
    ) {
      diagnostics.push(`Unsupported check type '${type}'.`);
    }
    if (reviewerSeen && type !== 'reviewer') {
      diagnostics.push(`${checkId}: deterministic checks must run before reviewer checks.`);
    }
    reviewerSeen ||= type === 'reviewer';
    if (type === 'file_assertion') {
      if (!check.path) diagnostics.push(`${checkId}: path is required.`);
      if (check.assertion === 'sha256_equals' && !check.expectedDigest) {
        diagnostics.push(`${checkId}: expectedDigest is required.`);
      }
    }
    if (type === 'command' && !check.command) diagnostics.push(`${checkId}: command is required.`);
    if (type === 'schema') {
      const diagnostic = schemaAdmissionDiagnostic(facts, checkIndex, check.schema, 'schema');
      if (diagnostic) diagnostics.push(`${checkId}: ${diagnostic}`);
    }
    if (type === 'mcp_read_after_write') {
      if (!check.invocationId || !check.capabilityId || !check.capabilityRevision) {
        diagnostics.push(`${checkId}: invocation and capability identity are required.`);
      }
      if (check.outputSchema) {
        const diagnostic = schemaAdmissionDiagnostic(
          facts,
          checkIndex,
          check.outputSchema,
          'outputSchema',
        );
        if (diagnostic) diagnostics.push(`${checkId}: ${diagnostic}`);
      }
    }
    if (type === 'external_reference' && !check.invocationId) {
      diagnostics.push(`${checkId}: invocationId is required.`);
    }
    if (type === 'reviewer' && !check.instructions) {
      diagnostics.push(`${checkId}: reviewer instructions are required.`);
    }
  }
  return diagnostics;
}

/** Verification evidence is recorded here; completion policy remains in core/completion. */
export function reduceVerificationState(
  state: AgentState,
  event: KernelEvent,
  facts: AgentReducerFactsV1 = {},
): AgentState {
  switch (event.type) {
    case 'verification.requested':
    case 'verification.started':
    case 'verification.check_completed':
    case 'verification.completed':
    case 'verification.repair_requested':
    case 'verification.replan_requested':
    case 'verification.waived':
    case 'verification.compensation_requested':
    case 'verification.compensation_completed':
      break;
    default:
      return state;
  }

  const payload = eventRecord(event);
  const verificationId = nonEmptyStringField(payload, 'verificationId');
  if (!verificationId) return state;
  const records = recordsFor(state);
  const current = records[verificationId];

  switch (event.type) {
    case 'verification.requested': {
      if (current) return state;
      const taskId = nonEmptyStringField(payload, 'taskId');
      if (taskId && taskId !== state.activeTaskId) return state;
      const mode = payload.mode as 'not_required' | 'best_effort' | 'required';
      const spec = payload.spec;
      const diagnostics = validateVerificationSpec(spec, facts);
      return withRecord(state, verificationId, {
        verificationId,
        ...(taskId ? { taskId } : {}),
        mode,
        status:
          mode === 'not_required'
            ? 'passed'
            : diagnostics.length > 0
              ? 'budget_exhausted'
              : 'pending',
        spec: asJsonObject(spec as object),
        requestedAt: stringField(payload, 'requestedAt'),
        attempts: 0,
        repairAttempts: 0,
        checkResults: {},
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      });
    }
    case 'verification.started': {
      if (!current) return state;
      const status = stringField(current, 'status');
      if (status !== 'pending' && status !== 'running' && status !== 'repair_pending') return state;
      const attempt = numberField(payload, 'attempt');
      if (attempt === undefined || !Number.isSafeInteger(attempt) || attempt < 0) return state;
      return withRecord(state, verificationId, {
        ...current,
        status: 'running',
        attempts: Math.max(numberField(current, 'attempts') ?? 0, attempt),
        checkResults: {},
        completedAt: undefined,
      });
    }
    case 'verification.check_completed': {
      if (!current || stringField(current, 'status') !== 'running') return state;
      const result = recordField(payload, 'result');
      const checkId = result && nonEmptyStringField(result, 'checkId');
      if (!result || !checkId) return state;
      const checkResults = recordField(current, 'checkResults') ?? {};
      return withRecord(state, verificationId, {
        ...current,
        checkResults: { ...checkResults, [checkId]: asJsonObject(result) },
      });
    }
    case 'verification.completed': {
      if (!current || stringField(current, 'status') !== 'running') return state;
      const outcome = stringField(payload, 'outcome');
      if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'inconclusive') return state;
      const mode = stringField(current, 'mode');
      const repairAttempts = numberField(current, 'repairAttempts') ?? 0;
      const spec = recordField(current, 'spec');
      const repair = spec && recordField(spec, 'repair');
      const maxAttempts = repair ? numberField(repair, 'maxAttempts') : undefined;
      const status =
        outcome === 'passed'
          ? 'passed'
          : mode === 'required' && maxAttempts !== undefined && repairAttempts >= maxAttempts
            ? 'budget_exhausted'
            : outcome === 'failed'
              ? 'failed'
              : 'inconclusive';
      return withRecord(state, verificationId, {
        ...current,
        status,
        completedAt: stringField(payload, 'completedAt'),
      });
    }
    case 'verification.repair_requested': {
      const status = stringField(current ?? {}, 'status');
      if (!current || (status !== 'failed' && status !== 'inconclusive')) return state;
      const repairAttempt = numberField(payload, 'repairAttempt');
      const instruction = stringField(payload, 'instruction');
      if (
        repairAttempt === undefined ||
        !Number.isSafeInteger(repairAttempt) ||
        repairAttempt < 0 ||
        instruction === undefined
      )
        return state;
      const next = withRecord(state, verificationId, {
        ...current,
        status: 'repair_pending',
        repairAttempts: Math.max(numberField(current, 'repairAttempts') ?? 0, repairAttempt),
      });
      return appendInstruction(next, verificationId, instruction);
    }
    case 'verification.replan_requested': {
      const status = stringField(current ?? {}, 'status');
      const instruction = stringField(payload, 'instruction');
      if (!current || status === 'passed' || status === 'waived' || instruction === undefined)
        return state;
      const next = withRecord(state, verificationId, {
        ...current,
        status: 'repair_pending',
        repairAttempts: 0,
      });
      return appendInstruction(next, verificationId, instruction);
    }
    case 'verification.waived': {
      const actor = stringField(payload, 'actor');
      const reason = stringField(payload, 'reason');
      const waivedAt = stringField(payload, 'waivedAt');
      if (
        !current ||
        stringField(current, 'status') === 'passed' ||
        actor !== 'user' ||
        !reason ||
        !waivedAt
      )
        return state;
      return withRecord(state, verificationId, {
        ...current,
        status: 'waived',
        waiver: { actor: 'user', reason, waivedAt },
      });
    }
    case 'verification.compensation_requested': {
      const status = stringField(current ?? {}, 'status');
      const spec = current && recordField(current, 'spec');
      if (
        !current ||
        !spec ||
        !recordField(spec, 'compensation') ||
        !['failed', 'inconclusive', 'budget_exhausted'].includes(status ?? '')
      )
        return state;
      return withRecord(state, verificationId, { ...current, status: 'compensating' });
    }
    case 'verification.compensation_completed': {
      const outcome = stringField(payload, 'outcome');
      const summary = stringField(payload, 'summary');
      const completedAt = stringField(payload, 'completedAt');
      if (
        !current ||
        stringField(current, 'status') !== 'compensating' ||
        (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'inconclusive') ||
        summary === undefined ||
        completedAt === undefined
      )
        return state;
      return withRecord(state, verificationId, {
        ...current,
        status: 'compensated',
        compensation: { outcome, summary, completedAt },
      });
    }
  }
}
