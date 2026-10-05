import type { Interaction } from '@kite-ai/client';

/** Presentation identity is never an answer target inferred from the active Run. */
export function interactionKey(card: Interaction): string {
  return JSON.stringify([
    card.originStoreId,
    card.sessionId,
    card.presentationSessionId,
    card.id,
    card.revision,
  ]);
}
