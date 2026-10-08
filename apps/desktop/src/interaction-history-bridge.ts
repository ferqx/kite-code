import type { Interaction, InteractionPage } from '@kite-ai/client';
import type { NativeSkillsScope } from './skills-bridge';

export type NativeInteractionHistoryScope = NativeSkillsScope;
export type NativeInteractionHistoryPage = {
  kind: 'interactionHistory.page';
  readId: string;
  scope: NativeInteractionHistoryScope;
  page: InteractionPage;
};
export type NativeInteractionHistoryRequest =
  | {
      method: 'interactionHistory.open';
      generation: number;
      readId: string;
      viewSelection: number;
      historyEpoch: number;
    }
  | {
      method: 'interactionHistory.next' | 'interactionHistory.close';
      generation: number;
      readId: string;
    }
  | {
      method: 'interactionHistory.attachment.open';
      generation: number;
      readId: string;
      key: string;
    }
  | {
      method: 'interactionHistory.attachment.read';
      generation: number;
      readId: string;
      offset: number;
      limit: number;
    }
  | {
      method: 'interactionHistory.attachment.close';
      generation: number;
      readId: string;
    };

/** Same observation on every page. A changing directory must be explicitly read again. */
export function verifyInteractionHistoryPage(
  page: InteractionPage,
  scope: NativeInteractionHistoryScope,
  previous?: { cursor: string; afterId?: string },
) {
  if (
    !/^(0|[1-9][0-9]{0,19})$/.test(page.snapshotCursor) ||
    BigInt(page.snapshotCursor) > 9223372036854775807n ||
    (previous && page.snapshotCursor !== previous.cursor)
  )
    throw Error('interaction_history_changed');
  let after = previous?.afterId ?? '';
  for (const card of page.interactions) {
    if (
      card.originStoreId !== scope.storeId ||
      (card.sessionId !== scope.sessionId && card.presentationSessionId !== scope.sessionId) ||
      card.ancestry[0] !== card.sessionId ||
      card.ancestry.at(-1) !== card.presentationSessionId ||
      new Set(card.ancestry).size !== card.ancestry.length ||
      card.id <= after
    )
      throw Error('interaction_history_identity_mismatch');
    after = card.id;
  }
  if (
    page.interactions.length > 20 ||
    (page.nextAfterId !== null && (!page.interactions.length || page.nextAfterId !== after))
  )
    throw Error('interaction_history_page_invalid');
}

export function interactionHistoryLabel(card: Interaction) {
  return `${card.kind === 'question' ? '问题' : card.kind === 'plan_review' ? '计划审核' : '审批'} · ${card.state === 'pending' ? '待回答' : card.state === 'cancelled' ? '已取消' : '已保存回答'}`;
}
