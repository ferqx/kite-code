import { createHash } from 'node:crypto';
import type { RuntimeState, TranscriptMessage } from '@/core/runtime/state';
import type { StructuredContextSummaryV2 } from './compaction-schema';
import { ResourceObservationTracker } from './resource-observation-tracker';

export type CompactionFactKind =
  | 'objective'
  | 'user_request'
  | 'user_constraint'
  | 'decision'
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
  canonicalText?: string;
  operation?: string;
  outcome?: string;
  error?: string;
  consequence?: string;
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
  /** All message IDs (user, assistant, tool) in the covered range — used for evidence validation. */
  coveredMessageIds: string[];
}

function factId(kind: CompactionFactKind, identity: string): string {
  return `${kind}:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function messageId(message: TranscriptMessage | undefined): string[] {
  return message?.messageId ? [message.messageId] : [];
}

/**
 * Extract deterministic facts from covered transcript messages.
 *
 * PR 3 refactoring rules:
 * - Objective comes from the first user message in covered range, not from active task state.
 * - Every user message generates at least one `user_request` fact (replaces keyword-based
 *   constraint regex). The summary model can refine these into objectives, constraints,
 *   decisions, etc. — but cannot omit them entirely.
 * - Verification / capability / plan current state is NOT scanned. Only facts with
 *   covered transcript evidence (tool results in the covered range) enter the ledger.
 * - Tool calls are classified by effectClass: only workspace_write / external_side_effect
 *   enter completed_work; read_only results enter observations only.
 */
export function buildDeterministicFactLedger(
  state: Readonly<RuntimeState>,
  coveredMessages: TranscriptMessage[],
  options?: { includeObjective?: boolean },
): DeterministicFactLedger {
  const includeObjective = options?.includeObjective ?? true;
  const coveredIds = new Set(coveredMessages.flatMap((message) => messageId(message)));
  const facts: CompactionFact[] = [];

  // ── Objective: from the first user message in covered range ──
  // P0-4: skip objective generation during incremental compaction (base already has it).
  const firstUser = coveredMessages.find((message) => message.kind === 'user');
  const objective = firstUser?.content ?? '';
  if (includeObjective && objective) {
    facts.push({
      factId: factId('objective', objective),
      kind: 'objective',
      text: objective,
      canonicalText: objective,
      mandatory: true,
      evidenceMessageIds: messageId(firstUser),
    });
  }

  // ── Every user message → user_request fact (model can refine, cannot omit) ──
  for (const message of coveredMessages) {
    if (message.kind !== 'user') continue;
    facts.push({
      factId: factId('user_request', message.messageId ?? message.content),
      kind: 'user_request',
      text: message.content.slice(0, 2_000),
      canonicalText: message.content.slice(0, 2_000),
      mandatory: true,
      evidenceMessageIds: messageId(message),
    });
  }

  // ── Tool calls in covered range → completed_work / failure / pending_work ──
  // P0-5: require real covered assistant or tool transcript evidence.
  // modelMessageId may be empty in some edge cases — must also check for a covered tool result.
  const coveredToolMessages = coveredMessages.filter(
    (message): message is Extract<TranscriptMessage, { kind: 'tool' }> => message.kind === 'tool',
  );
  for (const call of Object.values(state.tools.calls)) {
    const coveredAssistant =
      call.modelMessageId != null &&
      call.modelMessageId !== '' &&
      coveredIds.has(call.modelMessageId);

    const coveredToolResults = coveredToolMessages.filter(
      (message) => message.toolCallId === call.toolCallId,
    );

    if (!coveredAssistant && coveredToolResults.length === 0) continue;

    const evidence = [
      ...(coveredAssistant ? [call.modelMessageId!] : []),
      ...coveredToolResults.flatMap((message) => messageId(message)),
    ].filter(Boolean);

    if (evidence.length === 0) continue;

    // completedEffect: only workspace_write, external_side_effect, or explicit sideEffect.
    // read_only results must NOT enter completed_work (observations only).
    // unknown + sideEffect=false → not completed_work.
    // unknown + sideEffect=true → completed effect, but mark uncertain classification.
    // plan_only → not completed external effect.
    const isCompletedEffect =
      call.status === 'succeeded' &&
      (call.effectClass === 'workspace_write' ||
        call.effectClass === 'external_side_effect' ||
        call.sideEffect === true);

    if (isCompletedEffect) {
      const meta = call.result?.resultMeta;
      const isUncertain = !call.effectClass || call.effectClass === 'unknown';
      const operation = call.name;
      const outcome = `${call.result?.summary ?? 'completed'}${isUncertain ? ' (uncertain classification)' : ''}`;
      facts.push({
        factId: factId('completed_work', call.toolCallId),
        kind: 'completed_work',
        text: `${operation}: ${outcome}`,
        operation,
        outcome,
        mandatory: true,
        evidenceMessageIds: evidence,
        ...(meta?.path ? { path: meta.path } : {}),
        ...(meta?.rawResultDigest ? { digest: meta.rawResultDigest } : {}),
      });
    } else if (call.status === 'succeeded') {
      // Read-only, unknown without sideEffect, or plan_only — not completed_work.
    } else if (['failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status)) {
      const error = call.error ?? call.failure?.message ?? call.status;
      facts.push({
        factId: factId('failure', call.toolCallId),
        kind: 'failure',
        text: `${call.name}: ${error}`,
        operation: call.name,
        error,
        consequence: '',
        mandatory: true,
        evidenceMessageIds: evidence,
      });
    } else {
      facts.push({
        factId: factId('pending_work', call.toolCallId),
        kind: 'pending_work',
        text: `${call.name} is ${call.status}`,
        canonicalText: `${call.name} is ${call.status}`,
        mandatory: true,
        evidenceMessageIds: evidence,
      });
    }
  }

  // ── Observations: latest reliable resource state from covered tool messages ──
  const observationTracker = new ResourceObservationTracker();
  for (const message of coveredMessages) {
    if (message.kind !== 'tool') continue;
    const meta = message.resultMeta;
    const call = state.tools.calls[message.toolCallId];
    observationTracker.applyToolResult({
      toolCallId: message.toolCallId,
      messageId: message.messageId ?? message.toolCallId,
      name: message.name,
      ok: message.ok,
      effectClass: call?.effectClass ?? 'unknown',
      content: message.content,
      resource: meta?.path ?? meta?.command,
      revision: meta?.resourceRevision,
      rawDigest: meta?.rawResultDigest,
      modelDigest: meta?.modelContentDigest ?? meta?.contentDigest,
      truncated: meta?.truncated,
      mutationScope: meta?.workspaceMutationScope,
      digestScope: meta?.digestScope,
    });
  }
  for (const observation of observationTracker.allReliable()) {
    facts.push({
      factId: factId('observation', `${observation.resource}:${observation.revision}`),
      kind: 'observation',
      text: `Observed ${observation.resource}`,
      mandatory: true,
      evidenceMessageIds: [observation.messageId],
      resource: observation.resource,
      revision: observation.revision,
      ...(observation.rawDigest ? { digest: observation.rawDigest } : {}),
    });
  }

  const unique = [...new Map(facts.map((fact) => [fact.factId, fact])).values()];
  const coveredUserMessageIds = coveredMessages
    .filter((m) => m.kind === 'user')
    .map((m) => m.messageId)
    .filter((id): id is string => !!id);
  const coveredMessageIds = coveredMessages
    .map((m) => m.messageId)
    .filter((id): id is string => !!id);
  return {
    objective,
    facts: unique,
    mandatoryFactIds: unique.filter((fact) => fact.mandatory).map((fact) => fact.factId),
    coveredUserMessageIds,
    coveredMessageIds,
  };
}

// ── PR 2: Incremental checkpoint fact inheritance ──

/**
 * Build a deterministic fact ledger from a validated V2 base summary.
 * Extracts mandatory facts (objective, constraints, decisions, completed effects,
 * failures, pending work, user requests) that must survive incremental merge.
 * Observations are included conditionally — they can be invalidated by later writes.
 */
export function buildLedgerFromBaseSummary(
  summary: StructuredContextSummaryV2,
): DeterministicFactLedger {
  const facts: CompactionFact[] = [];

  // objective → mandatory (uses summary.objective.factId)
  facts.push({
    factId: summary.objective.factId,
    kind: 'objective',
    text: summary.objective.text,
    canonicalText: summary.objective.text,
    mandatory: true,
    evidenceMessageIds: summary.objective.evidenceMessageIds,
  });

  // userRequests → mandatory (uses summary.userRequests[].factId)
  for (const req of summary.userRequests) {
    facts.push({
      factId: req.factId,
      kind: 'user_request',
      text: req.summary,
      canonicalText: req.summary,
      mandatory: true,
      evidenceMessageIds: req.evidenceMessageIds,
    });
  }

  // userConstraints → mandatory
  for (const c of summary.userConstraints) {
    for (const sourceFactId of c.sourceFactIds ?? [c.factId]) {
      facts.push({
        factId: sourceFactId,
        kind: 'user_constraint',
        text: c.text,
        canonicalText: c.text,
        mandatory: true,
        evidenceMessageIds: c.evidenceMessageIds,
      });
    }
  }

  // decisions → mandatory
  for (const d of summary.decisions) {
    for (const sourceFactId of d.sourceFactIds ?? [d.factId]) {
      facts.push({
        factId: sourceFactId,
        kind: 'decision',
        text: `${d.decision}${d.rationale ? ` (rationale: ${d.rationale})` : ''}`,
        canonicalText: d.decision,
        ...(d.rationale ? { consequence: d.rationale } : {}),
        mandatory: true,
        evidenceMessageIds: d.evidenceMessageIds,
      });
    }
  }

  // completedEffects → mandatory
  for (const ce of summary.completedEffects) {
    facts.push({
      factId: ce.factId,
      kind: 'completed_work',
      text: `${ce.operation}: ${ce.outcome}`,
      operation: ce.operation,
      outcome: ce.outcome,
      mandatory: true,
      evidenceMessageIds: ce.evidenceMessageIds,
      ...(ce.path ? { path: ce.path } : {}),
      ...(ce.rawResultDigest ? { digest: ce.rawResultDigest } : {}),
    });
  }

  // failures → mandatory
  for (const f of summary.failures) {
    facts.push({
      factId: f.factId,
      kind: 'failure',
      text: `${f.operation}: ${f.error}${f.consequence ? ` (${f.consequence})` : ''}`,
      operation: f.operation,
      error: f.error,
      consequence: f.consequence,
      mandatory: true,
      evidenceMessageIds: f.evidenceMessageIds,
    });
  }

  // pendingWork → mandatory
  for (const pw of summary.pendingWork) {
    facts.push({
      factId: pw.factId,
      kind: 'pending_work',
      text: pw.text,
      canonicalText: pw.text,
      mandatory: true,
      evidenceMessageIds: pw.evidenceMessageIds,
      ...(pw.blockedBy ? { resource: pw.blockedBy } : {}),
    });
  }

  // observations → conditional (can be invalidated by later writes)
  for (const obs of summary.observations) {
    facts.push({
      factId: obs.factId,
      kind: 'observation',
      text: `Observed ${obs.resource}${obs.revision ? ` at ${obs.revision}` : ''}`,
      mandatory: false, // conditional — can be invalidated
      evidenceMessageIds: obs.evidenceMessageIds,
      resource: obs.resource,
      ...(obs.revision ? { revision: obs.revision } : {}),
      ...(obs.digest ? { digest: obs.digest } : {}),
    });
  }

  const unique = [...new Map(facts.map((f) => [f.factId, f])).values()];
  // P0-3: include evidence from all summary sections, not just ledger facts.
  // unresolvedQuestions evidence may reference messages not attached to any ledger fact.
  const coveredMessageIds = [
    ...new Set([
      ...unique.flatMap((f) => f.evidenceMessageIds),
      ...summary.unresolvedQuestions.flatMap((q) => q.evidenceMessageIds),
    ]),
  ];
  return {
    objective: summary.objective.text,
    facts: unique,
    mandatoryFactIds: unique.filter((f) => f.mandatory).map((f) => f.factId),
    coveredUserMessageIds: summary.provenance.coveredUserMessageIds,
    coveredMessageIds,
  };
}

/**
 * Merge a base ledger (from previous checkpoint) with a tail ledger (from new messages).
 *
 * Rules:
 * - Same factId in tail replaces base (update).
 * - Mandatory facts from base survive unless explicitly superseded by tail.
 * - Observation facts from base can be dropped when invalidated by tail writes.
 * - Pending work in base can transition to completed_work in tail.
 * - Immutable fields (path, digest, revision) from base must not be modified
 *   unless the tail explicitly overwrites them with new evidence.
 */
export function mergeCompactionLedgers(
  base: DeterministicFactLedger | undefined,
  tail: DeterministicFactLedger,
): DeterministicFactLedger {
  if (!base) return tail;

  const merged = new Map<string, CompactionFact>();

  // Start with base facts
  for (const fact of base.facts) {
    merged.set(fact.factId, fact);
  }

  // Tail facts that are singleton by kind replace ALL base facts of the same kind.
  // objective: only one objective exists at a time — the tail's is more recent.
  const singletonKinds = new Set<CompactionFactKind>(['objective']);
  for (const fact of tail.facts) {
    if (singletonKinds.has(fact.kind)) {
      // Remove all base facts of this singleton kind before inserting the tail fact.
      for (const [id, baseFact] of merged) {
        if (baseFact.kind === fact.kind) merged.delete(id);
      }
    }
    merged.set(fact.factId, fact);
  }

  const mergedFacts = [...merged.values()];

  const tailWrites = tail.facts.filter((fact) => fact.kind === 'completed_work');
  const invalidatesAllObservations = tailWrites.some((fact) => !fact.path);

  // Pending work in base that became completed_work in tail:
  // remove the pending_work fact from merged when tail has a matching completed_work.
  const tailCompletedPaths = new Set(
    tail.facts.filter((f) => f.kind === 'completed_work' && f.path).map((f) => f.path!),
  );
  const basePendingToRemove = base.facts
    .filter((f) => f.kind === 'pending_work')
    .filter((f) => {
      // If tail has a completed_work with a matching path, the pending work is done.
      if (f.path && tailCompletedPaths.has(f.path)) return true;
      // If any tail fact has the same factId and is now completed_work, remove pending.
      const tailOverride = tail.facts.find((tf) => tf.factId === f.factId);
      return tailOverride?.kind === 'completed_work';
    })
    .map((f) => f.factId);

  const finalFacts = mergedFacts.filter((f) => {
    if (basePendingToRemove.includes(f.factId)) return false;
    if (f.kind !== 'observation' || !base.facts.some((baseFact) => baseFact.factId === f.factId)) {
      return true;
    }
    if (invalidatesAllObservations) return false;
    return !tailWrites.some(
      (write) =>
        write.path &&
        f.resource &&
        (f.resource === write.path || f.resource.startsWith(`${write.path}/`)),
    );
  });

  const finalMandatoryIds = [
    ...new Set([...(base.mandatoryFactIds ?? []), ...tail.mandatoryFactIds]),
  ].filter((id) => {
    // Remove mandatory IDs for facts that were dropped (e.g., pending → completed transition)
    const fact = finalFacts.find((f) => f.factId === id);
    return fact != null;
  });

  return {
    objective: base?.objective || tail.objective || '',
    facts: finalFacts,
    mandatoryFactIds: finalMandatoryIds,
    coveredUserMessageIds: [
      ...new Set([...(base.coveredUserMessageIds ?? []), ...tail.coveredUserMessageIds]),
    ],
    coveredMessageIds: [...new Set([...(base.coveredMessageIds ?? []), ...tail.coveredMessageIds])],
  };
}
