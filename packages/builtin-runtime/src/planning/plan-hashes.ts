import { createHash } from 'node:crypto';
import type { PlanDocument } from '@kite/runtime-contract';

/**
 * Compute the structural digest of a PlanDocument, excluding mutable step
 * status and notes. This is the sole planning-domain digest authority used by
 * PlanDocument validation and Plan Artifact persistence.
 */
export function computePlanStructuralDigest(
  doc: Pick<PlanDocument, 'title' | 'bodyMarkdown' | 'steps'>,
): string {
  const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();
  const input = JSON.stringify({
    title: normalize(doc.title),
    bodyMarkdown: normalize(doc.bodyMarkdown),
    steps: doc.steps.map(({ id, title }) => ({ id, title: normalize(title) })),
  });
  return createHash('sha256').update(input).digest('hex');
}
