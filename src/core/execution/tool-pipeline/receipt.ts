import { digestCapability } from '@/core/capabilities/catalog';
import type { CapabilityArtifactWriterV1 } from '@/core/persistence/capability-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import type { CapabilityResult } from '@/protocol/capabilities';
import {
  type DispatchedOutcomeV1,
  type NormalizedOutcomeV1,
  type ReceiptCommittedOutcomeV1,
  TOOL_PIPELINE_STAGE_SCHEMA_V1,
} from './types';

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
  const capabilityResult = dispatched.result.capabilityResult
    ? cloneCapabilityResult(dispatched.result.capabilityResult)
    : capabilityResultFromToolResult(dispatched.result);
  return deepFreeze({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'normalized' as const,
    dispatched,
    capabilityResult,
  } satisfies NormalizedOutcomeV1);
}

export function commitNormalizedToolReceiptV1(
  normalized: Readonly<NormalizedOutcomeV1>,
  artifactStore: CapabilityArtifactWriterV1,
  finishedAt = new Date().toISOString(),
): Readonly<ReceiptCommittedOutcomeV1> {
  if (normalized.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 || normalized.stage !== 'normalized') {
    throw new Error('Invalid normalized Tool outcome.');
  }
  const recorded = recordNormalizedToolResultV1(normalized, artifactStore, finishedAt);
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
  return deepFreeze({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'receipt_committed' as const,
    normalized,
    artifact: recorded.artifact,
    terminalEvents: [terminal],
  } satisfies ReceiptCommittedOutcomeV1);
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
    resultDigest: digestCapability(normalized.capabilityResult),
    evidenceDigest: digestCapability({
      content: normalized.capabilityResult.content,
      structuredContent: normalized.capabilityResult.structuredContent ?? null,
    }),
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
