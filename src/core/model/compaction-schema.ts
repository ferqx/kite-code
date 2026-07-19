import { z } from 'zod';

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
        text: z.string(),
        evidenceMessageIds: z.array(z.string().min(1)),
      })
      .strict(),
    userRequests: z.array(
      z
        .object({
          summary: z.string().min(1),
          evidenceMessageIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    userConstraints: z.array(evidenceFactSchema),
    decisions: z.array(
      z
        .object({
          factId: z.string().min(1).optional(),
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
          factId: z.string().min(1).optional(),
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
          factId: z.string().min(1).optional(),
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

// ── Fact ID extraction ──

export function summaryFactIds(
  summary: StructuredContextSummaryV1 | StructuredContextSummaryV2,
): Set<string> {
  if (summary.version === 2) {
    return new Set(
      [
        ...summary.userConstraints,
        ...summary.decisions,
        ...summary.completedEffects,
        ...summary.observations,
        ...summary.failures,
        ...summary.pendingWork,
      ].flatMap((entry) => (entry.factId ? [entry.factId] : [])),
    );
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
