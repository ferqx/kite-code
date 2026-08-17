import type { ToolExecutionResult } from '@/core/harness/tool-result';
import type { DispatchedOutcomeV1, RecordedInvocationV1 } from './types';
import { TOOL_PIPELINE_STAGE_SCHEMA_V1 } from './types';

interface DispatchedOutcomeAuthorityBindingV1 {
  readonly recorded: Readonly<RecordedInvocationV1>;
  readonly result: ToolExecutionResult;
  readonly source: 'adapter_result' | 'confirmed_failure';
}

const acknowledgedRecordedInvocations = new WeakSet<object>();
const dispatchedOutcomeBindings = new WeakMap<object, DispatchedOutcomeAuthorityBindingV1>();
const issuedOutcomeByRecordedInvocation = new WeakSet<object>();

/** Process-local issuer called only after the invocation and attempt batch is durably acknowledged. */
export function issueAcknowledgedRecordedInvocationV1(
  recorded: Readonly<RecordedInvocationV1>,
): Readonly<RecordedInvocationV1> {
  acknowledgedRecordedInvocations.add(recorded);
  return recorded;
}

export function assertAcknowledgedRecordedInvocationV1(
  recorded: Readonly<RecordedInvocationV1>,
): void {
  if (!acknowledgedRecordedInvocations.has(recorded)) {
    throw new Error('Tool dispatch requires an authentic acknowledged recorded invocation.');
  }
}

/** Issue the exact adapter result returned after its acknowledged dispatch hook. */
export function issueAdapterDispatchedOutcomeV1(
  recorded: Readonly<RecordedInvocationV1>,
  result: ToolExecutionResult,
): Readonly<DispatchedOutcomeV1> {
  return issueDispatchedOutcome(recorded, result, 'adapter_result');
}

/** Issue the controller's closed, error-only projection for a confirmed post-ack failure. */
export function issueConfirmedFailureDispatchedOutcomeV1(
  recorded: Readonly<RecordedInvocationV1>,
  result: ToolExecutionResult,
): Readonly<DispatchedOutcomeV1> {
  return issueDispatchedOutcome(recorded, result, 'confirmed_failure');
}

export function assertAuthenticDispatchedOutcomeV1(
  dispatched: Readonly<DispatchedOutcomeV1>,
): void {
  const binding = dispatchedOutcomeBindings.get(dispatched);
  if (
    !binding ||
    binding.recorded !== dispatched.recorded ||
    binding.result !== dispatched.result ||
    !Object.isFrozen(dispatched) ||
    !Object.isFrozen(dispatched.result)
  ) {
    throw new Error('Tool receipt requires an authentic dispatched Pipeline outcome.');
  }
  assertAcknowledgedRecordedInvocationV1(dispatched.recorded);
}

function issueDispatchedOutcome(
  recorded: Readonly<RecordedInvocationV1>,
  result: ToolExecutionResult,
  source: DispatchedOutcomeAuthorityBindingV1['source'],
): Readonly<DispatchedOutcomeV1> {
  assertAcknowledgedRecordedInvocationV1(recorded);
  if (issuedOutcomeByRecordedInvocation.has(recorded)) {
    throw new Error('A recorded Tool attempt can issue only one dispatched outcome.');
  }
  deepFreezeAuthorityValue(result);
  const dispatched = Object.freeze({
    schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
    stage: 'dispatched' as const,
    recorded,
    result,
  } satisfies DispatchedOutcomeV1);
  dispatchedOutcomeBindings.set(dispatched, Object.freeze({ recorded, result, source }));
  issuedOutcomeByRecordedInvocation.add(recorded);
  return dispatched;
}

function deepFreezeAuthorityValue(value: unknown, seen = new WeakSet<object>()): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeAuthorityValue(descriptor.value, seen);
  }
  if (!ArrayBuffer.isView(value)) Object.freeze(value);
}
