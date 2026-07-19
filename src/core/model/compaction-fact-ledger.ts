import { createHash } from 'node:crypto';
import type { RuntimeState, TranscriptMessage } from '@/core/runtime/state';

export type CompactionFactKind =
  | 'objective'
  | 'user_constraint'
  | 'completed_work'
  | 'observation'
  | 'failure'
  | 'verification'
  | 'plan'
  | 'pending_work';

export interface CompactionFact {
  factId: string;
  kind: CompactionFactKind;
  text: string;
  mandatory: boolean;
  evidenceMessageIds: string[];
  path?: string;
  resource?: string;
  revision?: string;
  digest?: string;
}

export interface DeterministicFactLedger {
  objective: string;
  facts: CompactionFact[];
  mandatoryFactIds: string[];
  /** All user message IDs in the covered range — used for coverage validation. */
  coveredUserMessageIds: string[];
}

function factId(kind: CompactionFactKind, identity: string): string {
  return `${kind}:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function messageId(message: TranscriptMessage | undefined): string[] {
  return message?.messageId ? [message.messageId] : [];
}

/** Extract facts whose retention cannot be delegated to the summary model. */
export function buildDeterministicFactLedger(
  state: Readonly<RuntimeState>,
  coveredMessages: TranscriptMessage[],
): DeterministicFactLedger {
  const coveredIds = new Set(coveredMessages.flatMap((message) => messageId(message)));
  const facts: CompactionFact[] = [];
  const activeTask = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
  const latestUser = [...coveredMessages].reverse().find((message) => message.kind === 'user');
  const objective = activeTask?.userGoal || latestUser?.content || '';
  if (objective) {
    facts.push({
      factId: factId('objective', activeTask?.taskId ?? objective),
      kind: 'objective',
      text: objective,
      mandatory: true,
      evidenceMessageIds: messageId(latestUser),
    });
  }

  for (const message of coveredMessages) {
    if (message.kind !== 'user' || message.content === objective) continue;
    if (!/\b(must|should|never|required|constraint)\b|必须|不得|不要|只允许/i.test(message.content))
      continue;
    facts.push({
      factId: factId('user_constraint', message.messageId ?? message.content),
      kind: 'user_constraint',
      text: message.content.slice(0, 1_000),
      mandatory: true,
      evidenceMessageIds: messageId(message),
    });
  }

  for (const call of Object.values(state.tools.calls)) {
    if (call.modelMessageId && !coveredIds.has(call.modelMessageId)) continue;
    const evidence = [
      call.modelMessageId,
      ...coveredMessages
        .filter((message) => message.kind === 'tool' && message.toolCallId === call.toolCallId)
        .flatMap((message) => messageId(message)),
    ].filter(Boolean);

    // completedEffect: only workspace_write, external_side_effect, or explicit sideEffect.
    // read_only results (read_file, search, etc.) must NOT enter completed_work;
    // they belong in observations only.
    const isCompletedEffect =
      call.status === 'succeeded' &&
      (call.effectClass === 'workspace_write' ||
        call.effectClass === 'external_side_effect' ||
        call.sideEffect === true);

    if (isCompletedEffect) {
      const meta = call.result?.resultMeta;
      facts.push({
        factId: factId('completed_work', call.toolCallId),
        kind: 'completed_work',
        text: `${call.name}: ${call.result?.summary ?? 'completed'}`,
        mandatory: true,
        evidenceMessageIds: evidence,
        ...(meta?.path ? { path: meta.path } : {}),
        ...(meta?.contentDigest ? { digest: meta.contentDigest } : {}),
      });
    } else if (call.status === 'succeeded') {
      // Read-only or unknown-effect success — do not enter completed_work.
      // Observations are captured separately below.
    } else if (['failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status)) {
      facts.push({
        factId: factId('failure', call.toolCallId),
        kind: 'failure',
        text: `${call.name}: ${call.error ?? call.failure?.message ?? call.status}`,
        mandatory: true,
        evidenceMessageIds: evidence,
      });
    } else {
      facts.push({
        factId: factId('pending_work', call.toolCallId),
        kind: 'pending_work',
        text: `${call.name} is ${call.status}`,
        mandatory: true,
        evidenceMessageIds: evidence,
      });
    }
  }

  for (const record of Object.values(state.verification.records)) {
    facts.push({
      factId: factId('verification', record.verificationId),
      kind: 'verification',
      text: `Verification ${record.verificationId}: ${record.status}`,
      mandatory: true,
      evidenceMessageIds: [],
    });
  }
  for (const invocation of Object.values(state.capabilities.invocations)) {
    const kind = invocation.status === 'succeeded' ? 'completed_work' : 'failure';
    facts.push({
      factId: factId(kind, invocation.invocationId),
      kind,
      text:
        invocation.status === 'succeeded'
          ? `${invocation.capabilityId} succeeded (${invocation.resultDigest ?? 'no result digest'})`
          : `${invocation.capabilityId}: ${invocation.error ?? invocation.status}`,
      mandatory: true,
      evidenceMessageIds: coveredMessages
        .filter(
          (message) => message.kind === 'tool' && message.toolCallId === invocation.toolCallId,
        )
        .flatMap((message) => messageId(message)),
      ...(invocation.resultDigest ? { digest: invocation.resultDigest } : {}),
    });
  }
  for (const task of Object.values(state.tasks)) {
    for (const plan of task.planHistory) {
      facts.push({
        factId: factId('plan', `${task.taskId}:${plan.version}`),
        kind: 'plan',
        text: `Plan ${task.taskId} version ${plan.version}: ${plan.structuralDigest}`,
        mandatory: true,
        evidenceMessageIds: [],
      });
    }
  }

  const latestObservations = new Map<string, CompactionFact>();
  for (const message of coveredMessages) {
    if (message.kind !== 'tool' || !message.ok || !message.resultMeta) continue;
    const meta = message.resultMeta;
    const resource = meta.path ?? meta.command;
    if (!resource || (!meta.resourceRevision && !meta.contentDigest)) continue;
    latestObservations.set(resource, {
      factId: factId('observation', `${resource}:${meta.resourceRevision ?? meta.contentDigest}`),
      kind: 'observation',
      text: `${message.name} observed ${resource}`,
      mandatory: true,
      evidenceMessageIds: messageId(message),
      resource,
      ...(meta.resourceRevision ? { revision: meta.resourceRevision } : {}),
      ...(meta.contentDigest ? { digest: meta.contentDigest } : {}),
    });
  }
  facts.push(...latestObservations.values());

  const unique = [...new Map(facts.map((fact) => [fact.factId, fact])).values()];
  const coveredUserMessageIds = coveredMessages
    .filter((m) => m.kind === 'user')
    .map((m) => m.messageId)
    .filter((id): id is string => !!id);
  return {
    objective,
    facts: unique,
    mandatoryFactIds: unique.filter((fact) => fact.mandatory).map((fact) => fact.factId),
    coveredUserMessageIds,
  };
}
