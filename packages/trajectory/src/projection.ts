import { type Decimal64, parseDecimal64 } from './cursor';
import type { TrajectoryDisplay } from './display';
import { type KnownTrajectoryPhase, type TrajectoryEvent, trajectoryEventSchema } from './events';
import type { TrajectoryIntegrity } from './integrity';

export const TRAJECTORY_PROJECTOR_VERSION = 1;
export interface TrajectoryStep {
  stepId: string;
  kind: TrajectoryEvent['kind'];
  sourceEventType?: string;
  identityConfidence?: TrajectoryEvent['identityConfidence'];
  phase: KnownTrajectoryPhase;
  recordedStatus: string | null;
  sessionId: string;
  workspaceId: string;
  originStoreId?: string;
  runId?: string;
  runOriginStoreId?: string;
  childSessionId?: string;
  childRunId?: string;
  carrierExecutionId?: string;
  executionId?: string;
  executionOriginStoreId?: string;
  parentExecutionId?: string;
  parentExecutionOriginStoreId?: string;
  operationId?: string;
  operationOriginStoreId?: string;
  definitionId?: string;
  definitionVersion?: string;
  display?: TrajectoryDisplay;
  usage?: Extract<TrajectoryEvent, { kind: 'model' }>['attributes']['usage'];
  compression?: Extract<TrajectoryEvent, { kind: 'model' }>['attributes']['compression'];
  commandId?: string;
  commandType?: string;
  messageId?: string;
  messageOriginStoreId?: string;
  messageRole?: 'user' | 'assistant';
  messageSeq?: Decimal64;
  messageRevision?: Decimal64;
  messageStatus?: 'complete' | 'incomplete';
  interactionKind?: 'approval' | 'question' | 'plan_review';
  compressionId?: string;
  compressionTrigger?: 'automatic' | 'manual';
  previousExecutionId?: string;
  previousExecutionOriginStoreId?: string;
  attempt?: number;
  firstSequence: Decimal64;
  lastSequence: Decimal64;
  sourceEventIds: string[];
  sourceEvidenceIds: string[];
  anomalous: boolean;
}
export interface TrajectoryProjection {
  projectorVersion: 1;
  atCursor: Decimal64;
  steps: TrajectoryStep[];
  sourceEventIds: string[];
  openStepIds: string[];
  integrity: TrajectoryIntegrity;
  /** Safe canonical facts only; no private bindings or material bodies. Optional for old indexes. */
  eventIndex?: TrajectoryEvent[];
  completePrefix?: boolean;
}
export interface TrajectoryProjectionOptions {
  atCursor: Decimal64;
  integrity?: TrajectoryIntegrity;
  completePrefix?: boolean;
}
/** Applies ordered pages without retaining raw event bodies. One instance belongs to one fixed prefix. */
export class TrajectoryProjector {
  private readonly options: TrajectoryProjectionOptions;
  private readonly at: bigint;
  private readonly seen = new Set<string>();
  private readonly steps = new Map<string, TrajectoryStep>();
  private readonly sourceEventIds: string[] = [];
  private readonly eventIndex: TrajectoryEvent[] = [];
  private readonly evidenceByStep = new Map<string, Set<string>>();
  private readonly stepIdentities = new Map<string, string>();
  private previous = -1n;
  private unknown = false;
  private legacy = false;
  constructor(options: TrajectoryProjectionOptions) {
    this.options = structuredClone(options);
    this.at = parseDecimal64(options.atCursor);
  }
  apply(events: readonly TrajectoryEvent[]): void {
    for (const value of events) {
      const event = trajectoryEventSchema.parse(value);
      const sequence = parseDecimal64(event.sequence);
      if (this.seen.has(event.eventId)) throw new Error('trajectory_event_duplicate');
      if (sequence <= this.previous) throw new Error('trajectory_event_order_invalid');
      this.previous = sequence;
      this.seen.add(event.eventId);
      if (sequence > this.at) continue;
      this.sourceEventIds.push(event.eventId);
      this.eventIndex.push(event);
      this.unknown ||= event.kind === 'unknown';
      this.legacy ||= event.identityConfidence === 'legacy_local';
      // Only explicit stored identity links observations. Similar names/times never merge attempts.
      const baseId =
        ['model', 'tool', 'job'].includes(event.kind) && event.executionId
          ? `execution:${event.executionId}`
          : event.kind === 'run' && event.runId
            ? `run:${event.runId}`
            : event.kind === 'message'
              ? `message:${event.attributes.messageId}`
              : event.kind === 'command'
                ? `command:${event.attributes.commandId}`
                : event.kind === 'interaction'
                  ? `interaction:${event.attributes.interactionId}`
                  : event.kind === 'child'
                    ? `child:${event.attributes.carrierExecutionId}:${event.attributes.childSessionId}`
                    : event.kind === 'verification'
                      ? `verification:${event.attributes.verificationId}`
                      : event.kind === 'artifact'
                        ? `artifact:${event.attributes.artifactId}`
                        : `event:${event.eventId}`;
      const identityOrigin =
        ['model', 'tool', 'job'].includes(event.kind) && event.executionId
          ? (event.executionOriginStoreId ?? event.origin.storeId)
          : event.kind === 'run'
            ? (event.runOriginStoreId ?? event.origin.storeId)
            : event.kind === 'message'
              ? (event.messageOriginStoreId ?? event.origin.storeId)
              : event.origin.storeId;
      const key = JSON.stringify([
        identityOrigin,
        event.sessionId,
        baseId,
        ...(event.kind === 'child'
          ? [event.attributes.carrierExecutionId, event.attributes.childSessionId]
          : []),
      ]);
      const old = this.steps.get(key);
      // Keep existing presentation keys stable in the ordinary single-scope case. A colliding
      // local ID from another original Store/Session is a different object, never a new state.
      let stepId = old?.stepId ?? baseId;
      if (!old) {
        let suffix = 0;
        while (this.stepIdentities.has(stepId)) {
          stepId = `${baseId}:${JSON.stringify([identityOrigin, event.sessionId, suffix++])}`;
        }
        this.stepIdentities.set(stepId, key);
      }
      const sourceEventIds = old?.sourceEventIds ?? [];
      sourceEventIds.push(event.eventId);
      const sourceEvidenceIds = old?.sourceEvidenceIds ?? [];
      const evidence = this.evidenceByStep.get(key) ?? new Set<string>();
      for (const reference of event.evidenceRefs)
        if (!evidence.has(reference.evidenceId)) {
          evidence.add(reference.evidenceId);
          sourceEvidenceIds.push(reference.evidenceId);
        }
      this.evidenceByStep.set(key, evidence);
      const anomalous =
        ['failed', 'cancelled', 'outcome_unknown'].includes(event.phase) ||
        event.kind === 'unknown' ||
        (event.kind === 'verification' && event.attributes.outcome !== 'passed');
      let retained = old;
      if (event.kind === 'message' && old) {
        // Message association is a sealed observation, not an immutable Execution identity.
        // A later multi-source or unbound revision must not inherit a formerly unique parent.
        retained = { ...old };
        delete retained.runId;
        delete retained.runOriginStoreId;
        delete retained.executionId;
        delete retained.executionOriginStoreId;
        delete retained.parentExecutionId;
        delete retained.parentExecutionOriginStoreId;
        delete retained.operationId;
        delete retained.operationOriginStoreId;
        delete retained.display;
      }
      this.steps.set(key, {
        ...retained,
        stepId,
        kind: event.kind,
        sourceEventType: event.sourceEventType,
        identityConfidence: event.identityConfidence,
        phase: event.phase,
        recordedStatus: event.recordedStatus,
        sessionId: event.sessionId,
        workspaceId: event.workspaceId,
        originStoreId: event.origin.storeId,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.runId === undefined
          ? {}
          : { runOriginStoreId: event.runOriginStoreId ?? event.origin.storeId }),
        ...((event.kind === 'child' || event.kind === 'job') && event.attributes.childSessionId
          ? { childSessionId: event.attributes.childSessionId }
          : {}),
        ...(event.kind === 'child'
          ? {
              carrierExecutionId: event.attributes.carrierExecutionId,
              ...(event.attributes.childRunId === undefined
                ? {}
                : { childRunId: event.attributes.childRunId }),
            }
          : {}),
        ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
        ...(event.executionId === undefined
          ? {}
          : { executionOriginStoreId: event.executionOriginStoreId ?? event.origin.storeId }),
        ...(event.parentExecutionId === undefined
          ? {}
          : {
              parentExecutionId: event.parentExecutionId,
              parentExecutionOriginStoreId:
                event.parentExecutionOriginStoreId ?? event.origin.storeId,
            }),
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        ...(event.operationId === undefined
          ? {}
          : { operationOriginStoreId: event.operationOriginStoreId ?? event.origin.storeId }),
        ...('definitionId' in event.attributes && event.attributes.definitionId !== undefined
          ? { definitionId: event.attributes.definitionId }
          : {}),
        ...('definitionVersion' in event.attributes &&
        event.attributes.definitionVersion !== undefined
          ? { definitionVersion: event.attributes.definitionVersion }
          : {}),
        ...(event.kind === 'model' && event.attributes.usage
          ? { usage: { ...event.attributes.usage } }
          : {}),
        ...('display' in event.attributes && event.attributes.display
          ? { display: structuredClone(event.attributes.display) }
          : {}),
        ...((event.kind === 'model' || event.kind === 'context') && event.attributes.compression
          ? { compression: structuredClone(event.attributes.compression) }
          : {}),
        ...('commandId' in event.attributes && event.attributes.commandId !== undefined
          ? { commandId: event.attributes.commandId }
          : {}),
        ...(event.kind === 'command' && event.attributes.commandType !== undefined
          ? { commandType: event.attributes.commandType }
          : {}),
        ...(event.kind === 'message'
          ? {
              messageId: event.attributes.messageId,
              ...(event.messageOriginStoreId === undefined
                ? {}
                : { messageOriginStoreId: event.messageOriginStoreId }),
              messageRole: event.attributes.role,
              messageSeq: event.attributes.messageSeq,
              messageRevision: event.attributes.revision,
              messageStatus: event.attributes.status,
            }
          : {}),
        ...('interactionKind' in event.attributes &&
        (event.attributes.interactionKind === 'approval' ||
          event.attributes.interactionKind === 'question' ||
          event.attributes.interactionKind === 'plan_review')
          ? { interactionKind: event.attributes.interactionKind }
          : {}),
        ...('compressionId' in event.attributes &&
        typeof event.attributes.compressionId === 'string'
          ? { compressionId: event.attributes.compressionId }
          : {}),
        ...('compressionTrigger' in event.attributes &&
        (event.attributes.compressionTrigger === 'automatic' ||
          event.attributes.compressionTrigger === 'manual')
          ? { compressionTrigger: event.attributes.compressionTrigger }
          : {}),
        ...(event.kind === 'model'
          ? {
              ...(event.attributes.previousExecutionId === undefined
                ? {}
                : { previousExecutionId: event.attributes.previousExecutionId }),
              ...(event.attributes.previousExecutionOriginStoreId === undefined
                ? {}
                : {
                    previousExecutionOriginStoreId: event.attributes.previousExecutionOriginStoreId,
                  }),
            }
          : {}),
        ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
        firstSequence: old?.firstSequence ?? event.sequence,
        lastSequence: event.sequence,
        sourceEventIds,
        sourceEvidenceIds,
        anomalous: (old?.anomalous ?? false) || anomalous,
      });
    }
  }
  project(): TrajectoryProjection {
    const integrity: TrajectoryIntegrity = this.options.integrity
      ? { ...this.options.integrity, reasons: [...this.options.integrity.reasons] }
      : {
          facts: this.options.completePrefix === true ? 'complete' : 'unknown',
          identityConfidence: 'verified_origin',
          reasons: this.options.completePrefix === true ? [] : ['incomplete_prefix'],
        };
    if (this.options.completePrefix !== true && !integrity.reasons.includes('incomplete_prefix')) {
      integrity.reasons.push('incomplete_prefix');
      if (integrity.facts === 'complete') integrity.facts = 'partial';
    }
    if (this.unknown) {
      integrity.facts = 'partial';
      if (!integrity.reasons.includes('unknown_event')) integrity.reasons.push('unknown_event');
    }
    if (this.legacy) {
      integrity.identityConfidence = 'legacy_local';
      if (!integrity.reasons.includes('identity_unverified'))
        integrity.reasons.push('identity_unverified');
    }
    const values = [...this.steps.values()];
    return {
      projectorVersion: TRAJECTORY_PROJECTOR_VERSION,
      atCursor: this.options.atCursor,
      steps: values.map((step) => ({
        ...step,
        sourceEventIds: [...step.sourceEventIds],
        sourceEvidenceIds: [...step.sourceEvidenceIds],
        ...(step.usage ? { usage: { ...step.usage } } : {}),
        ...(step.display ? { display: structuredClone(step.display) } : {}),
        ...(step.compression ? { compression: structuredClone(step.compression) } : {}),
      })),
      sourceEventIds: [...this.sourceEventIds],
      eventIndex: structuredClone(this.eventIndex),
      completePrefix: this.options.completePrefix === true,
      openStepIds: values
        .filter((step) =>
          [
            'planned',
            'dispatching',
            'running',
            'waiting_interaction',
            'waiting_execution',
            'cancelling',
            'outcome_unknown',
          ].includes(step.phase),
        )
        .map((step) => step.stepId),
      integrity,
    };
  }
}
/** Pure as-of projection. It neither fetches missing inputs nor infers a terminal outcome. */
export function projectTrajectory(
  events: readonly TrajectoryEvent[],
  options: TrajectoryProjectionOptions,
): TrajectoryProjection {
  const projector = new TrajectoryProjector(options);
  projector.apply(events);
  return projector.project();
}
