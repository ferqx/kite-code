import type { RuntimePlanReviewInteraction } from '@kite-ai/runtime-contract';
import type { RuntimeEvent } from '../bootstrap/runtime/state-runtime';
import { projectRuntimeClientText } from './safe-text';

/** Both live projection and durable history show the same reviewed body and steps. */
export function projectPlanReview(
  plan: Extract<RuntimeEvent, { type: 'plan.review_requested' }>['plan'],
): NonNullable<RuntimePlanReviewInteraction['review']> {
  const source = [
    plan.name,
    plan.description,
    ...plan.steps.map(
      (step, index) => `${index + 1}. ${step.step}${step.note ? `\n${step.note}` : ''}`,
    ),
  ].join('\n\n');
  const safe = projectRuntimeClientText(source, Number.MAX_SAFE_INTEGER);
  return { text: projectRuntimeClientText(safe, 65_536), truncated: safe.length > 65_536 };
}
