import { createHash } from 'node:crypto';
import {
  type CapabilityArtifactWriterV1,
  capabilityResultDigestV1,
  capabilityResultEvidenceDigestV1,
} from '@/core/persistence/capability-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import { toolExecutionModelContentV1 } from '@/core/runtime/tool-model-content';
import type { CapabilityResult } from '@/protocol/capabilities';
import { assertAuthenticDispatchedOutcomeV1 } from './dispatch-authority';
import { assertWorkspaceFilesystemObservationAuthorityV1 } from './filesystem-observation-authority';
import {
  type DispatchedOutcomeV1,
  type NormalizedOutcomeV1,
  type ReceiptCommittedOutcomeV1,
  TOOL_PIPELINE_STAGE_SCHEMA_V1,
} from './types';

const committedReceipts = new WeakSet<object>();
const normalizedOutcomes = new WeakSet<object>();

export class ToolReceiptPersistenceErrorV1 extends Error {
  readonly normalized: Readonly<NormalizedOutcomeV1>;

  constructor(normalized: Readonly<NormalizedOutcomeV1>) {
    super('Tool result Artifact could not be durably persisted after dispatch.');
    this.name = 'ToolReceiptPersistenceErrorV1';
    this.normalized = normalized;
  }
}

export function normalizeDispatchedToolOutcomeV1(
  dispatched: Readonly<DispatchedOutcomeV1>,
): Readonly<NormalizedOutcomeV1> {
  if (dispatched.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || dispatched.stage !== 'dispatched') {
    throw new Error('Invalid dispatched Tool outcome.');
  }
  assertAuthenticDispatchedOutcomeV1(dispatched);
  const baseCapabilityResult = dispatched.result.capabilityResult
    ? cloneCapabilityResult(dispatched.result.capabilityResult)
    : capabilityResultFromToolResult(dispatched.result);
  assertFilesystemObservationAuthority(dispatched, baseCapabilityResult);
  const capabilityResult = withFilesystemObservation(
    baseCapabilityResult,
    dispatched.result.filesystemObservation,
  );
  if (dispatched.result.filesystemObservation) {
    const normalizedObservation = filesystemObservationFromCapabilityResultV1(capabilityResult);
    if (
      !sameFilesystemObservation(dispatched.result.filesystemObservation, normalizedObservation)
    ) {
      throw new Error('Filesystem observation does not match canonical capability evidence.');
    }
  }
  const normalized = deepFreeze({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'normalized' as const,
    dispatched,
    capabilityResult,
  } satisfies NormalizedOutcomeV1);
  normalizedOutcomes.add(normalized);
  return normalized;
}

export function commitNormalizedToolReceiptV1(
  normalized: Readonly<NormalizedOutcomeV1>,
  artifactStore: CapabilityArtifactWriterV1,
  finishedAt = new Date().toISOString(),
): Readonly<ReceiptCommittedOutcomeV1> {
  if (normalized.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || normalized.stage !== 'normalized') {
    throw new Error('Invalid normalized Tool outcome.');
  }
  if (!normalizedOutcomes.has(normalized)) {
    throw new Error('Tool receipt requires an authentic normalized Pipeline outcome.');
  }
  assertAuthenticDispatchedOutcomeV1(normalized.dispatched);
  const recorded = recordNormalizedToolResultV1(normalized, artifactStore, finishedAt);
  const filesystemObservation = filesystemObservationFromCapabilityResultV1(
    normalized.capabilityResult,
  );
  if (
    normalized.dispatched.result.filesystemObservation &&
    !sameFilesystemObservation(
      normalized.dispatched.result.filesystemObservation,
      filesystemObservation,
    )
  ) {
    throw new Error('Filesystem observation does not match canonical capability evidence.');
  }
  const succeeded =
    normalized.dispatched.result.ok !== false && normalized.capabilityResult.status === 'success';
  const terminal: RuntimeEvent = succeeded
    ? {
        type: 'capability.execution_succeeded',
        invocationId: recorded.invocationId,
        resultDigest: recorded.resultDigest,
        evidenceDigest: recorded.evidenceDigest,
        finishedAt,
        artifact: recorded.artifact,
        ...(recorded.externalReferences ? { externalReferences: recorded.externalReferences } : {}),
        ...(filesystemObservation ? { filesystemObservation } : {}),
      }
    : {
        type: 'capability.execution_failed',
        invocationId: recorded.invocationId,
        error:
          normalized.capabilityResult.error?.message ??
          normalized.dispatched.result.stderr ??
          'Tool adapter did not produce a successful result.',
        resultDigest: recorded.resultDigest,
        evidenceDigest: recorded.evidenceDigest,
        finishedAt,
        artifact: recorded.artifact,
      };
  const committed = deepFreeze({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'receipt_committed' as const,
    normalized,
    artifact: recorded.artifact,
    terminalEvents: [terminal],
  } satisfies ReceiptCommittedOutcomeV1);
  committedReceipts.add(committed);
  return committed;
}

export function isCommittedToolReceiptV1(receipt: Readonly<ReceiptCommittedOutcomeV1>): boolean {
  return committedReceipts.has(receipt);
}

/** Canonical ToolExecutionResult projection into the sole reducer terminal event. */
export function toolFinishedEventV1(input: {
  toolCallId: string;
  name: string;
  result: DispatchedOutcomeV1['result'];
  command?: string;
}): RuntimeEvent {
  const { result } = input;
  const ok = result.ok !== false;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.exitCode ?? 0;
  return {
    type: 'tool.finished',
    toolCallId: input.toolCallId,
    name: input.name,
    result: {
      ok,
      command: result.command ?? input.command ?? input.name,
      exitCode,
      stdout,
      stderr,
      ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
      resultMeta: {
        ...result.resultMeta,
        ...(result.path ? { path: result.path } : {}),
        ...(result.totalLines != null ? { totalLines: result.totalLines } : {}),
        ...(result.action?.intent ? { intent: result.action.intent } : {}),
        ...(result.processCleanup
          ? {
              processCleanupConfirmed: result.processCleanup.confirmedExited,
              unconfirmedDescendantCount: result.processCleanup.unconfirmedDescendantCount,
            }
          : {}),
        ...computeToolResultDigest({
          ok,
          stdout,
          stderr,
          exitCode,
          status: result.status,
          rawResultDigest: result.resultMeta?.rawResultDigest,
          truncated: result.resultMeta?.truncated,
        }),
      },
      status:
        result.status === 'exhausted' ? 'exhausted' : result.ok === false ? 'error' : 'success',
    },
    ...(result.classifierAdviceV1 ? { classifierAdviceV1: result.classifierAdviceV1 } : {}),
    ...(result.classifierDiagnostic ? { classifierDiagnostic: result.classifierDiagnostic } : {}),
  };
}

/** Persist a canonical adapter result without terminalizing its suspended Tool call. */
export function recordNormalizedToolResultV1(
  normalized: Readonly<NormalizedOutcomeV1>,
  artifactStore: CapabilityArtifactWriterV1,
  recordedAt = new Date().toISOString(),
): Extract<RuntimeEvent, { type: 'capability.execution_result_recorded' }> {
  if (normalized.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || normalized.stage !== 'normalized') {
    throw new Error('Invalid normalized Tool outcome.');
  }
  if (!normalizedOutcomes.has(normalized)) {
    throw new Error('Tool result recording requires an authentic normalized Pipeline outcome.');
  }
  assertAuthenticDispatchedOutcomeV1(normalized.dispatched);
  let artifact: ReturnType<CapabilityArtifactWriterV1['write']>;
  try {
    artifact = artifactStore.write(
      normalized.dispatched.recorded.invocationId,
      normalized.capabilityResult,
    );
  } catch {
    throw new ToolReceiptPersistenceErrorV1(normalized);
  }
  const externalReferences = externalReferencesFromResult(normalized.capabilityResult);
  return {
    type: 'capability.execution_result_recorded',
    invocationId: normalized.dispatched.recorded.invocationId,
    resultDigest: capabilityResultDigestV1(normalized.capabilityResult),
    evidenceDigest: capabilityResultEvidenceDigestV1(normalized.capabilityResult),
    recordedAt,
    artifact,
    ...(externalReferences.length > 0 ? { externalReferences } : {}),
  };
}

export function receiptPersistenceUnknownEventV1(
  error: ToolReceiptPersistenceErrorV1,
  finishedAt = new Date().toISOString(),
): Extract<RuntimeEvent, { type: 'capability.execution_unknown' }> {
  return {
    type: 'capability.execution_unknown',
    invocationId: error.normalized.dispatched.recorded.invocationId,
    reason: 'Tool result Artifact persistence failed after dispatch; external effects are unknown.',
    finishedAt,
  };
}

function capabilityResultFromToolResult(result: DispatchedOutcomeV1['result']): CapabilityResult {
  const status: CapabilityResult['status'] =
    result.ok !== false
      ? 'success'
      : result.terminationReason === 'cancelled'
        ? 'cancelled'
        : 'error';
  const text = result.ok !== false ? result.stdout : result.stderr || result.stdout;
  const failure =
    status === 'success'
      ? undefined
      : classifyFailure('tool_runtime_error', text || 'Tool adapter reported failure.');
  return {
    status,
    content: text ? [{ type: 'text', text }] : [],
    structuredContent: {
      ok: result.ok !== false,
      exitCode: Number.isFinite(result.exitCode) ? result.exitCode : -1,
      status: result.status ?? null,
      terminationReason: result.terminationReason ?? null,
      resultMeta: result.resultMeta ?? null,
    },
    ...(failure ? { error: failure } : {}),
  };
}

/** Read the digest-only filesystem stamp covered by Capability Artifact/evidence bytes. */
export function filesystemObservationFromCapabilityResultV1(
  result: Readonly<CapabilityResult>,
): import('@/protocol/capabilities').WorkspaceFilesystemObservationRecordV1 | undefined {
  const structured = result.structuredContent;
  if (!isPlainRecord(structured) || structured.filesystemObservation === undefined) {
    return undefined;
  }
  const value = structured.filesystemObservation;
  if (!isPlainRecord(value)) throw new Error('Filesystem observation evidence is invalid.');
  const keys = Object.keys(value).sort();
  const expected = [
    'actorIdentityDigest',
    'canonicalTargetDigest',
    'contentDigest',
    'lexicalTargetDigest',
    'targetIdentityDigest',
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    typeof value.actorIdentityDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.actorIdentityDigest) ||
    expected
      .filter((key) => key !== 'actorIdentityDigest')
      .some((key) => typeof value[key] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value[key]))
  ) {
    throw new Error('Filesystem observation evidence is invalid.');
  }
  return Object.freeze({
    actorIdentityDigest: value.actorIdentityDigest as string,
    lexicalTargetDigest: value.lexicalTargetDigest as string,
    canonicalTargetDigest: value.canonicalTargetDigest as string,
    targetIdentityDigest: value.targetIdentityDigest as string,
    contentDigest: value.contentDigest as string,
  });
}

function withFilesystemObservation(
  result: CapabilityResult,
  observation: import('@/protocol/capabilities').WorkspaceFilesystemObservationRecordV1 | undefined,
): CapabilityResult {
  if (!observation) return result;
  const structured = result.structuredContent;
  if (!isPlainRecord(structured)) {
    throw new Error('Filesystem observation requires structured capability evidence.');
  }
  return {
    ...result,
    structuredContent: {
      ...structured,
      filesystemObservation: structuredClone(observation),
    },
  };
}

function assertFilesystemObservationAuthority(
  dispatched: Readonly<DispatchedOutcomeV1>,
  baseCapabilityResult: Readonly<CapabilityResult>,
): void {
  const structured = baseCapabilityResult.structuredContent;
  if (isPlainRecord(structured) && Object.hasOwn(structured, 'filesystemObservation')) {
    throw new Error(
      'filesystemObservation is reserved for the Workspace filesystem Pipeline dispatcher.',
    );
  }
  if (!dispatched.result.filesystemObservation) return;
  if (dispatched.result.ok === false || baseCapabilityResult.status !== 'success') {
    throw new Error(
      'Filesystem observation requires a successful admitted Workspace filesystem capability.',
    );
  }
  assertWorkspaceFilesystemObservationAuthorityV1({
    observation: dispatched.result.filesystemObservation,
    recorded: dispatched.recorded,
    result: dispatched.result,
  });
}

function sameFilesystemObservation(
  left: import('@/protocol/capabilities').WorkspaceFilesystemObservationRecordV1 | undefined,
  right: import('@/protocol/capabilities').WorkspaceFilesystemObservationRecordV1 | undefined,
): boolean {
  return (
    left === right ||
    (Boolean(left) &&
      Boolean(right) &&
      left!.actorIdentityDigest === right!.actorIdentityDigest &&
      left!.lexicalTargetDigest === right!.lexicalTargetDigest &&
      left!.canonicalTargetDigest === right!.canonicalTargetDigest &&
      left!.targetIdentityDigest === right!.targetIdentityDigest &&
      left!.contentDigest === right!.contentDigest)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function computeToolResultDigest(input: {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  status?: 'success' | 'error' | 'rejected' | 'exhausted';
  rawResultDigest?: string;
  truncated?: boolean;
}): {
  contentDigest: string;
  rawResultDigest?: string;
  modelContentDigest: string;
  digestScope: 'raw' | 'projected';
} {
  const modelContentDigest = createHash('sha256')
    .update(toolExecutionModelContentV1(input))
    .digest('hex');
  const completeResultDigest = createHash('sha256')
    .update(
      JSON.stringify({
        stdout: input.stdout,
        stderr: input.stderr,
        exitCode: input.exitCode,
        status: input.status,
      }),
    )
    .digest('hex');
  const rawResultDigest =
    input.rawResultDigest ?? (input.truncated ? undefined : completeResultDigest);
  const digestScope = input.truncated ? ('projected' as const) : ('raw' as const);
  return {
    contentDigest: modelContentDigest,
    ...(rawResultDigest ? { rawResultDigest } : {}),
    modelContentDigest,
    digestScope,
  };
}

function cloneCapabilityResult(result: CapabilityResult): CapabilityResult {
  return structuredClone(result);
}

function externalReferencesFromResult(result: CapabilityResult): string[] {
  return result.content.flatMap((content) => {
    const uri = typeof content.uri === 'string' ? content.uri : undefined;
    const nestedUri =
      content.resource &&
      typeof content.resource === 'object' &&
      typeof (content.resource as Record<string, unknown>).uri === 'string'
        ? ((content.resource as Record<string, unknown>).uri as string)
        : undefined;
    return [uri, nestedUri].filter((value): value is string => Boolean(value));
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
