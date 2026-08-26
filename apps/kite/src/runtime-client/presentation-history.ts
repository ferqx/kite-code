import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import type { StateRuntimeEvent } from '@kite-ai/runtime-host';
import { projectRuntimeClientEvent } from './event-projector';

/**
 * Reuse the single App safety projector when State history is rendered by the
 * TUI. Historical interactions never regain live settlement authority.
 */
export function projectStateRuntimeEventForPresentation(
  event: StateRuntimeEvent,
  input: { readonly historical?: boolean } = {},
): RuntimeClientEvent | undefined {
  const projected = projectRuntimeClientEvent(event, { sessionRevision: 0 });
  if (!projected) return undefined;
  if (
    input.historical &&
    (projected.type === 'approval.queued' ||
      projected.type === 'input.requested' ||
      projected.type === 'plan.review_requested' ||
      projected.type === 'provider.action' ||
      projected.type === 'verification.status')
  ) {
    return { type: 'unavailable', reason: 'redacted' };
  }
  return projected;
}
