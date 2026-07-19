import { z } from 'zod';

const factTextSchema = z.object({ factId: z.string().min(1), text: z.string().min(1) }).strict();

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

export function parseStructuredContextSummaryV1(value: unknown): StructuredContextSummaryV1 {
  const candidate =
    typeof value === 'string' ? JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, '')) : value;
  return structuredContextSummaryV1Schema.parse(candidate);
}

export function summaryFactIds(summary: StructuredContextSummaryV1): Set<string> {
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
