import { parseDecimal64 } from '@kite-ai/trajectory';
import { trajectoryOutputPresence, trajectoryOutputState } from './output-presence';
import type { TrajectoryEvidenceView } from './TrajectoryPanel';
import type { WorkbenchRow } from './workbench';
import {
  type TrajectoryMaterialTarget,
  trajectoryMaterialTargets,
  trajectorySelectedMember,
  trajectorySelectedObservation,
} from './workbench-details';

export const trajectoryRequestTabs = ['overview', 'options', 'usage', 'timing'] as const;
export type TrajectoryRequestTab = (typeof trajectoryRequestTabs)[number];
export function normalizeTrajectoryRequestTab(value?: string | null): TrajectoryRequestTab {
  return trajectoryRequestTabs.includes(value as TrajectoryRequestTab)
    ? (value as TrajectoryRequestTab)
    : 'overview';
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A tab selects exact existing references; it never authorizes or performs a material read. */
export function trajectoryRequestTargets(
  row: WorkbenchRow,
  tab: TrajectoryRequestTab,
  observationId?: string | null,
): TrajectoryMaterialTarget[] {
  if (tab === 'usage' || tab === 'timing' || row.kind !== 'model' || row.virtualPart) return [];
  const member = trajectorySelectedMember(row, observationId);
  const current = trajectorySelectedObservation(row, observationId);
  if (member?.kind !== 'model' || current?.kind !== 'model') return [];
  const latest = new Map<string, TrajectoryMaterialTarget>();
  for (const event of member.events) {
    if (event.kind !== 'model' || parseDecimal64(event.sequence) > parseDecimal64(current.sequence))
      continue;
    for (const reference of event.evidenceRefs)
      if (
        reference.kind === 'model_input' ||
        (tab !== 'options' && reference.kind === 'model_output')
      )
        latest.set(reference.kind, { event, reference });
  }
  return ['model_input', 'model_output'].flatMap((kind) =>
    latest.has(kind) ? [latest.get(kind)!] : [],
  );
}
const targetKey = ({ event, reference }: TrajectoryMaterialTarget) =>
  JSON.stringify([event.eventId, reference.evidenceId, reference.contentVersion]);
export interface RequestMaterial {
  status: TrajectoryEvidenceView['status'] | 'not_saved' | 'unread';
  target?: TrajectoryMaterialTarget;
  data?: Record<string, unknown>;
}
export function trajectoryRequestMaterial(
  row: WorkbenchRow,
  kind: 'model_input' | 'model_output',
  targets: readonly TrajectoryMaterialTarget[],
  materials: readonly TrajectoryEvidenceView[],
  observationId?: string | null,
): RequestMaterial {
  const expected = trajectoryRequestTargets(row, 'overview', observationId).find(
    (target) => target.reference.kind === kind,
  );
  if (!expected) return { status: 'not_saved' };
  const target = targets.find((value) => targetKey(value) === targetKey(expected));
  if (!target) return { status: 'unread', target: expected };
  const availability = target.reference.availability;
  if (!['available', 'partial', 'truncated'].includes(availability))
    return {
      status:
        availability === 'missing'
          ? 'missing'
          : availability === 'redacted'
            ? 'redacted'
            : 'unavailable',
      target,
    };
  const view = materials.find(
    (value) =>
      value.eventId === target.event.eventId &&
      value.evidenceId === target.reference.evidenceId &&
      value.contentVersion === target.reference.contentVersion,
  );
  if (!view) return { status: 'unread', target };
  return {
    status: view.status,
    target,
    data: ['available', 'partial', 'truncated'].includes(view.status)
      ? object(view.data)
      : undefined,
  };
}

/** Only the public prepared adapter's available provider and supported generation settings. */
export function trajectoryRequestOptions(data: unknown) {
  const adapter = object(object(object(data)?.metadata)?.adapter);
  const provider = adapter?.availability === 'available' ? object(adapter.provider) : undefined;
  if (provider?.availability !== 'available') return;
  const settings = object(adapter?.settings);
  const options: Record<string, string | number> = {};
  for (const key of ['reasoningEffort', 'protocol', 'temperature', 'topP', 'maxOutputTokens']) {
    const value = settings?.[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
      options[key] = value;
  }
  return {
    modelName:
      typeof provider.modelId === 'string' && provider.modelId ? provider.modelId : undefined,
    family: typeof provider.family === 'string' && provider.family ? provider.family : undefined,
    settings: options,
  };
}

/** Result navigation retains this attempt's exact output, including an explicitly selected prefix. */
export function trajectoryRequestResult(
  row: WorkbenchRow,
  rowsById: ReadonlyMap<string, WorkbenchRow> | undefined,
  observationId?: string | null,
  admittedOutput?: RequestMaterial,
): string | undefined {
  if (!rowsById) return;
  const current = trajectorySelectedObservation(row, observationId);
  const member = trajectorySelectedMember(row, observationId);
  const output = trajectoryRequestTargets(row, 'overview', observationId).find(
    (target) => target.reference.kind === 'model_output',
  );
  if (!current || !member || !output) return;
  if (['tool_only', 'generating_empty'].includes(trajectoryOutputState(member, output))) return;
  const data =
    admittedOutput?.target &&
    ['available', 'partial', 'truncated'].includes(admittedOutput.status) &&
    targetKey(admittedOutput.target) === targetKey(output)
      ? admittedOutput.data
      : undefined;
  if (typeof data?.content === 'string' && data.content.length === 0) return;
  const hasText =
    trajectoryOutputPresence(output)?.hasText === true ||
    (typeof data?.content === 'string' && data.content.length > 0);
  const reply = rowsById.get(`${row.id}:part:reply`);
  if (
    reply?.virtualPart?.kind === 'reply' &&
    reply.virtualPart.ownerId === row.id &&
    !reply.presentationHidden &&
    !reply.outputSuppressed &&
    (!reply.outputHistory || (!!observationId && hasText)) &&
    trajectoryMaterialTargets(reply, 'content', observationId).some(
      (target) => targetKey(target) === targetKey(output),
    )
  )
    return reply.id;
  const step = member.step;
  const origin = step?.executionOriginStoreId ?? step?.originStoreId;
  if (!origin || !step || step.identityConfidence !== 'verified_origin') return;
  const candidates = [...rowsById.values()].filter(
    (candidate) =>
      candidate.kind === 'message' &&
      !candidate.presentationHidden &&
      !candidate.outputSuppressed &&
      candidate.step?.messageRole === 'assistant' &&
      candidate.step.identityConfidence === 'verified_origin' &&
      candidate.step.executionId === step.executionId &&
      candidate.step.sessionId === step.sessionId &&
      (candidate.step.executionOriginStoreId ?? candidate.step.originStoreId) === origin &&
      [candidate.events.at(-1)].some(
        (event) =>
          event?.kind === 'message' &&
          event.attributes.messageId === candidate.step?.messageId &&
          event.identityConfidence === 'verified_origin' &&
          event.executionId === step.executionId &&
          event.sessionId === step.sessionId &&
          (event.executionOriginStoreId ?? event.origin.storeId) === origin &&
          (!observationId || parseDecimal64(event.sequence) <= parseDecimal64(current.sequence)) &&
          event.evidenceRefs.some(
            (reference) =>
              reference.kind === 'message' &&
              ['available', 'partial', 'truncated'].includes(reference.availability),
          ),
      ),
  );
  const unique = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return unique.size === 1 ? [...unique.keys()][0] : undefined;
}
