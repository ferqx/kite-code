import type { TrajectoryOutputPresence } from '@kite-ai/trajectory';
import type { WorkbenchOperationMember, WorkbenchRow } from './workbench';
import type { TrajectoryMaterialTarget } from './workbench-details';

const active = new Set(['planned', 'dispatching', 'running']);
export type OutputState = 'text' | 'tool_only' | 'empty' | 'generating_empty' | 'unknown';

/** A presence belongs to this exact public material, never a later Step snapshot or loaded body. */
export function trajectoryOutputPresence(
  target: TrajectoryMaterialTarget | undefined,
): TrajectoryOutputPresence | undefined {
  if (
    target?.event.identityConfidence !== 'verified_origin' ||
    !['available', 'partial'].includes(target.reference.availability)
  )
    return;
  const event = target.event;
  if (
    event.kind !== 'model' &&
    !(event.kind === 'message' && event.attributes.role === 'assistant')
  )
    return;
  if (target.reference.kind !== (event.kind === 'model' ? 'model_output' : 'message')) return;
  const presence = event.attributes.display?.outputPresence;
  return presence?.evidenceId === target.reference.evidenceId &&
    presence.contentVersion === target.reference.contentVersion
    ? presence
    : undefined;
}

export function trajectoryModelOutputTarget(
  member: WorkbenchOperationMember | WorkbenchRow,
): TrajectoryMaterialTarget | undefined {
  let target: TrajectoryMaterialTarget | undefined;
  for (const event of member.events)
    if (event.kind === 'model')
      for (const reference of event.evidenceRefs)
        if (reference.kind === 'model_output') target = { event, reference };
  return target;
}

export function trajectoryOutputState(
  member: WorkbenchOperationMember | WorkbenchRow,
  target = trajectoryModelOutputTarget(member),
): OutputState {
  const presence = trajectoryOutputPresence(target);
  const origin = member.step?.executionOriginStoreId ?? member.step?.originStoreId;
  if (
    !presence ||
    !target ||
    target.event.kind !== 'model' ||
    !origin ||
    member.step?.identityConfidence !== 'verified_origin' ||
    member.step.executionId !== target.event.executionId ||
    member.step.sessionId !== target.event.sessionId ||
    origin !== (target.event.executionOriginStoreId ?? target.event.origin.storeId)
  )
    return 'unknown';
  if (presence.hasText) return 'text';
  if (
    member.phase === 'completed' &&
    member.step?.recordedStatus === 'succeeded' &&
    target.reference.availability === 'available' &&
    target.event.phase === 'completed' &&
    target.event.recordedStatus === 'succeeded' &&
    presence.complete
  )
    return presence.toolCallCount > 0 ? 'tool_only' : 'empty';
  if (active.has(member.phase ?? '') && active.has(target.event.phase) && !presence.complete)
    return 'generating_empty';
  return 'unknown';
}

export function trajectoryMessageOutputState(
  row: WorkbenchRow,
  owner: WorkbenchRow | undefined,
): OutputState {
  if (
    row.kind !== 'message' ||
    row.step?.messageRole !== 'assistant' ||
    row.step.identityConfidence !== 'verified_origin' ||
    !owner
  )
    return 'unknown';
  const origin = row.step.executionOriginStoreId ?? row.step.originStoreId;
  if (!origin) return 'unknown';
  const member = (owner.operation?.members ?? [owner]).find(
    (candidate) =>
      candidate.kind === 'model' &&
      candidate.step?.executionId === row.step?.executionId &&
      candidate.step?.sessionId === row.step?.sessionId &&
      (candidate.step?.executionOriginStoreId ?? candidate.step?.originStoreId) === origin,
  );
  if (member?.step?.identityConfidence !== 'verified_origin') return 'unknown';
  const event = row.events.at(-1);
  if (
    event?.kind !== 'message' ||
    event.sessionId !== row.step.sessionId ||
    event.executionId !== row.step.executionId ||
    (event.executionOriginStoreId ?? event.origin.storeId) !== origin ||
    event.attributes.messageId !== row.step.messageId
  )
    return 'unknown';
  const reference = event.evidenceRefs.find((value) => value.kind === 'message');
  const presence = reference ? trajectoryOutputPresence({ event, reference }) : undefined;
  if (!presence) return 'unknown';
  if (presence.hasText) return 'text';
  if (
    reference?.availability === 'available' &&
    presence.complete &&
    event.attributes.status === 'complete' &&
    member.phase === 'completed' &&
    member.step.recordedStatus === 'succeeded'
  )
    return presence.toolCallCount > 0 ? 'tool_only' : 'empty';
  if (
    !presence.complete &&
    event.attributes.status === 'incomplete' &&
    active.has(member.phase ?? '')
  )
    return 'generating_empty';
  return 'unknown';
}
