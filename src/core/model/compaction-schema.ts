import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Stable deterministic fact ID generator (mirrors compaction-fact-ledger). */
function factId(kind: string, identity: string): string {
  return `${kind}:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

const factTextSchema = z.object({ factId: z.string().min(1), text: z.string().min(1) }).strict();

// ── V1 schema (backward compatible, still readable) ──

export const structuredContextSummaryV1Schema = z
  .object({
    version: z.literal(1),
    objective: z.string(),
    userConstraints: z.array(factTextSchema),
    decisions: z.array(
      z
        .object({
          factId: z.string().min(1).optional(),
          decision: z.string().min(1),
          rationale: z.string().optional(),
        })
        .strict(),
    ),
    completedWork: z.array(
      z
        .object({
          factId: z.string().min(1),
          path: z.string().optional(),
          summary: z.string().min(1),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    observations: z.array(
      z
        .object({
          factId: z.string().min(1).optional(),
          resource: z.string().min(1),
          revision: z.string().optional(),
          digest: z.string().optional(),
          keyFacts: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    failures: z.array(
      z
        .object({
          factId: z.string().min(1),
          operation: z.string().min(1),
          error: z.string().min(1),
          consequence: z.string(),
        })
        .strict(),
    ),
    pendingWork: z.array(
      z.object({ text: z.string().min(1), blockedBy: z.string().optional() }).strict(),
    ),
    unresolvedQuestions: z.array(z.string().min(1)),
    recentUserIntent: z.string(),
    provenance: z
      .object({
        firstMessageId: z.string().min(1),
        lastMessageId: z.string().min(1),
        sourceDigest: z.string().min(1),
        mandatoryFactIds: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

export type StructuredContextSummaryV1 = z.infer<typeof structuredContextSummaryV1Schema>;

// ── V2 schema (current, adds user coverage + evidence provenance) ──

const evidenceFactSchema = z
  .object({
    factId: z.string().min(1),
    text: z.string().min(1),
    evidenceMessageIds: z.array(z.string().min(1)),
  })
  .strict();

export const structuredContextSummaryV2Schema = z
  .object({
    version: z.literal(2),
    objective: z
      .object({
        factId: z.string().min(1),
        text: z.string(),
        evidenceMessageIds: z.array(z.string().min(1)),
      })
      .strict(),
    userRequests: z.array(
      z
        .object({
          factId: z.string().min(1),
          summary: z.string().min(1),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    userConstraints: z.array(evidenceFactSchema),
    decisions: z.array(
      z
        .object({
          factId: z.string().min(1),
          decision: z.string().min(1),
          rationale: z.string().optional(),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    completedEffects: z.array(
      z
        .object({
          factId: z.string().min(1),
          operation: z.string().min(1),
          path: z.string().optional(),
          outcome: z.string().min(1),
          rawResultDigest: z.string().optional(),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    observations: z.array(
      z
        .object({
          factId: z.string().min(1),
          resource: z.string().min(1),
          revision: z.string().optional(),
          digest: z.string().optional(),
          keyFacts: z.array(z.string().min(1)),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    failures: z.array(
      z
        .object({
          factId: z.string().min(1),
          operation: z.string().min(1),
          error: z.string().min(1),
          consequence: z.string(),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    pendingWork: z.array(
      z
        .object({
          factId: z.string().min(1),
          text: z.string().min(1),
          blockedBy: z.string().optional(),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    unresolvedQuestions: z.array(
      z
        .object({
          text: z.string().min(1),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    provenance: z
      .object({
        baseCheckpointId: z.string().optional(),
        firstTailMessageId: z.string().optional(),
        lastMessageId: z.string().min(1),
        sourceDigest: z.string().min(1),
        coveredUserMessageIds: z.array(z.string().min(1)),
        mandatoryFactIds: z.array(z.string().min(1)),
        /** Mandatory fact IDs inherited from a base checkpoint (PR 2). */
        inheritedMandatoryFactIds: z.array(z.string().min(1)).optional(),
        /** Mandatory fact IDs discovered in the tail (PR 2). */
        tailMandatoryFactIds: z.array(z.string().min(1)).optional(),
        policyVersion: z.string(),
      })
      .strict(),
  })
  .strict();

export type StructuredContextSummaryV2 = z.infer<typeof structuredContextSummaryV2Schema>;

/** Union type for checkpoint summaries — V1 is readable, V2 is current. */
export type StructuredContextSummary = StructuredContextSummaryV1 | StructuredContextSummaryV2;

// ── Parsers ──

export function parseStructuredContextSummaryV1(value: unknown): StructuredContextSummaryV1 {
  const candidate =
    typeof value === 'string' ? JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, '')) : value;
  return structuredContextSummaryV1Schema.parse(candidate);
}

export function parseStructuredContextSummaryV2(value: unknown): StructuredContextSummaryV2 {
  const candidate =
    typeof value === 'string' ? JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, '')) : value;
  return structuredContextSummaryV2Schema.parse(candidate);
}

// ── Legacy V2 shape (from commit 5376d1c, before factId was required on
//    objective / userRequests) ──

/** V2 summary shape before objective.factId and userRequests[].factId were required. */
interface LegacyStructuredContextSummaryV2 {
  version: 2;
  objective: { text: string; evidenceMessageIds: string[] };
  userRequests: Array<{ summary: string; evidenceMessageIds: string[] }>;
  userConstraints: Array<{ factId: string; text: string; evidenceMessageIds: string[] }>;
  decisions: Array<{
    factId?: string;
    decision: string;
    rationale?: string;
    evidenceMessageIds: string[];
  }>;
  completedEffects: Array<{
    factId: string;
    operation: string;
    path?: string;
    outcome: string;
    rawResultDigest?: string;
    evidenceMessageIds: string[];
  }>;
  observations: Array<{
    factId?: string;
    resource: string;
    revision?: string;
    digest?: string;
    keyFacts: string[];
    evidenceMessageIds: string[];
  }>;
  failures: Array<{
    factId: string;
    operation: string;
    error: string;
    consequence: string;
    evidenceMessageIds: string[];
  }>;
  pendingWork: Array<{
    factId?: string;
    text: string;
    blockedBy?: string;
    evidenceMessageIds: string[];
  }>;
  unresolvedQuestions: Array<{ text: string; evidenceMessageIds: string[] }>;
  provenance: {
    baseCheckpointId?: string;
    firstTailMessageId?: string;
    lastMessageId: string;
    sourceDigest: string;
    coveredUserMessageIds: string[];
    mandatoryFactIds: string[];
    inheritedMandatoryFactIds?: string[];
    tailMandatoryFactIds?: string[];
    policyVersion: string;
  };
}

/** Upgrade a legacy V2 summary (without objective/userRequest factId) to current V2. */
function migrateLegacyV2Summary(raw: LegacyStructuredContextSummaryV2): StructuredContextSummaryV2 {
  return {
    version: 2,
    objective: {
      factId: factId('objective', raw.objective.text),
      text: raw.objective.text,
      evidenceMessageIds: raw.objective.evidenceMessageIds,
    },
    userRequests: raw.userRequests.map((req, i) => ({
      factId: factId('user_request', req.evidenceMessageIds[0] ?? req.summary ?? `legacy-${i}`),
      summary: req.summary,
      evidenceMessageIds: req.evidenceMessageIds,
    })),
    userConstraints: raw.userConstraints,
    decisions: raw.decisions.map((d) => ({
      ...d,
      factId: d.factId ?? factId('decision', d.decision),
    })),
    completedEffects: raw.completedEffects,
    observations: raw.observations.map((o) => ({
      ...o,
      factId:
        o.factId ?? factId('observation', `${o.resource}:${o.revision ?? o.digest ?? 'legacy'}`),
    })),
    failures: raw.failures,
    pendingWork: raw.pendingWork.map((pw) => ({
      ...pw,
      factId: pw.factId ?? factId('pending_work', pw.text),
    })),
    unresolvedQuestions: raw.unresolvedQuestions,
    provenance: raw.provenance,
  };
}

/**
 * Parse a persisted checkpoint summary for restore or migration.
 * Checks version first — V1 → upgrade, V2 → parse (legacy or current).
 */
export function parsePersistedCheckpointSummary(raw: unknown): StructuredContextSummaryV2 {
  const record = raw as Record<string, unknown> | null | undefined;
  if (!record || typeof record.version !== 'number') {
    throw new Error(`Unsupported checkpoint summary: missing or invalid version field.`);
  }

  if (record.version === 1) {
    const v1 = parseStructuredContextSummaryV1(raw);
    const objectiveFactId = factId('objective', v1.objective);
    return {
      version: 2,
      objective: { factId: objectiveFactId, text: v1.objective, evidenceMessageIds: [] },
      userRequests: [],
      userConstraints: v1.userConstraints.map((c) => ({
        ...c,
        factId: c.factId ?? factId('user_constraint', c.text),
        evidenceMessageIds: [] as string[],
      })),
      decisions: v1.decisions.map((d) => ({
        ...d,
        factId: d.factId ?? factId('decision', d.decision),
        evidenceMessageIds: [] as string[],
      })),
      completedEffects: v1.completedWork.map((cw) => ({
        factId: cw.factId,
        operation: cw.summary,
        path: cw.path,
        outcome: cw.summary,
        evidenceMessageIds: cw.evidenceMessageIds,
      })),
      observations: v1.observations.map((o) => ({
        ...o,
        factId:
          o.factId ?? factId('observation', `${o.resource}:${o.revision ?? o.digest ?? 'v1'}`),
        evidenceMessageIds: [] as string[],
      })),
      failures: v1.failures.map((f) => ({ ...f, evidenceMessageIds: [] as string[] })),
      pendingWork: v1.pendingWork.map((pw) => ({
        text: pw.text,
        blockedBy: pw.blockedBy,
        factId: factId('pending_work', pw.text),
        evidenceMessageIds: [] as string[],
      })),
      unresolvedQuestions: v1.unresolvedQuestions.map((q) => ({
        text: q,
        evidenceMessageIds: [],
      })),
      provenance: {
        lastMessageId: v1.provenance.lastMessageId,
        sourceDigest: v1.provenance.sourceDigest,
        coveredUserMessageIds: [],
        mandatoryFactIds: v1.provenance.mandatoryFactIds,
        policyVersion: '1.0.0',
      },
    };
  }

  if (record.version === 2) {
    // Try current V2 schema first.
    try {
      return parseStructuredContextSummaryV2(raw);
    } catch {
      // Legacy V2 (before objective/userRequest factId was required).
      const legacy = raw as LegacyStructuredContextSummaryV2;
      return migrateLegacyV2Summary(legacy);
    }
  }

  throw new Error(`Unsupported checkpoint summary version: ${record.version}`);
}

/**
 * Parse a freshly-generated summary candidate.
 * V2 only — V1 output from the summary model is rejected.
 */
export function parseGeneratedSummaryCandidate(raw: unknown): StructuredContextSummaryV2 {
  return parseStructuredContextSummaryV2(raw);
}

// ── Fact ID extraction ──

export function summaryFactIds(
  summary: StructuredContextSummaryV1 | StructuredContextSummaryV2,
): Set<string> {
  if (summary.version === 2) {
    return new Set([
      summary.objective.factId,
      ...summary.userRequests.map((r) => r.factId),
      ...summary.userConstraints.map((c) => c.factId),
      ...summary.decisions.map((d) => d.factId),
      ...summary.completedEffects.map((ce) => ce.factId),
      ...summary.observations.map((o) => o.factId),
      ...summary.failures.map((f) => f.factId),
      ...summary.pendingWork.map((pw) => pw.factId),
    ]);
  }
  return new Set(
    [
      ...summary.userConstraints,
      ...summary.decisions,
      ...summary.completedWork,
      ...summary.observations,
      ...summary.failures,
    ].flatMap((entry) => (entry.factId ? [entry.factId] : [])),
  );
}
