import type { Interaction } from '@kite-ai/client';
import { InteractionCard } from '@kite-ai/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  interactionHistoryLabel,
  type NativeInteractionHistoryScope,
  verifyInteractionHistoryPage,
} from './interaction-history-bridge';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { readNativeInteractionAttachment } from './native-interaction-attachment';

export function NativeInteractionHistory({
  bridge,
  generation,
  selection,
  historyEpoch,
}: {
  bridge: NativeBridge;
  generation: number;
  selection: NativeSelection;
  historyEpoch: number;
}) {
  const { storeId, session } = selection;
  const viewSelection = selection.viewSelection ?? selection.viewGeneration;
  const scope: NativeInteractionHistoryScope = useMemo(
    () => ({
      generation,
      storeId,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      viewSelection,
      historyEpoch,
    }),
    [generation, storeId, session.id, session.workspaceId, viewSelection, historyEpoch],
  );
  const identity = JSON.stringify(scope);
  const [revision, setRevision] = useState(0);
  const current = useRef('');
  current.current = `${identity}/${revision}`;
  const [view, setView] = useState<{
    identity: string;
    readId?: string;
    cards?: Interaction[];
    error?: string;
    loading: boolean;
  }>({ identity, loading: true });
  useEffect(() => {
    const readId = crypto.randomUUID(),
      key = `${identity}/${revision}`;
    let active = true;
    const close = () =>
      bridge.request({ method: 'interactionHistory.close', generation, readId }).catch(() => {});
    setView((old) => ({
      identity,
      cards: old.identity === identity ? old.cards : undefined,
      loading: true,
    }));
    void (async () => {
      const cards: Interaction[] = [];
      let previous: { cursor: string; afterId?: string } | undefined;
      for (;;) {
        const result = await bridge.request(
          previous
            ? {
                method: 'interactionHistory.next',
                generation,
                readId,
              }
            : {
                method: 'interactionHistory.open',
                generation,
                readId,
                viewSelection,
                historyEpoch,
              },
        );
        if (!active || current.current !== key) return;
        if (
          !result ||
          !('kind' in result) ||
          !('readId' in result) ||
          !('scope' in result) ||
          !('page' in result) ||
          result.kind !== 'interactionHistory.page' ||
          result.readId !== readId ||
          Object.keys(scope).some(
            (key) =>
              result.scope[key as keyof NativeInteractionHistoryScope] !==
              scope[key as keyof NativeInteractionHistoryScope],
          )
        )
          throw Error('interaction_history_identity_mismatch');
        verifyInteractionHistoryPage(result.page, scope, previous);
        cards.push(...result.page.interactions);
        if (result.page.nextAfterId === null) {
          setView({ identity, readId, cards, loading: false });
          return;
        }
        previous = { cursor: result.page.snapshotCursor, afterId: result.page.nextAfterId };
      }
    })().catch(() => {
      void close();
      if (active && current.current === key)
        setView((old) => ({
          identity,
          cards: old.identity === identity ? old.cards : undefined,
          loading: false,
          error: '交互记录未能完整核实，请重新读取。',
        }));
    });
    return () => {
      active = false;
      void close();
    };
  }, [bridge, generation, viewSelection, historyEpoch, identity, revision, scope]);
  const facts = view.identity === identity ? view : undefined;
  const readId = facts?.readId;
  const attachmentReader = useMemo(
    () =>
      readId
        ? (
            attachment: Parameters<typeof readNativeInteractionAttachment>[0]['attachment'],
            options: { signal: AbortSignal },
          ) =>
            readNativeInteractionAttachment({
              bridge,
              generation,
              viewSelection,
              attachment,
              signal: options.signal,
              surface: 'history',
              isCurrent: () => current.current === `${identity}/${revision}`,
            })
        : undefined,
    [bridge, generation, viewSelection, readId, identity, revision],
  );
  return (
    <section aria-label="交互记录">
      <h2>交互记录</h2>
      <p>这里仅阅读原问题、计划和审批记录；任务状态由执行记录确认。</p>
      <button
        type="button"
        disabled={facts?.loading || selection.viewLoading || selection.permissionUnavailable}
        onClick={() => setRevision((value) => value + 1)}
      >
        重新读取交互记录
      </button>
      {facts?.loading && <p role="status">正在读取交互记录。</p>}
      {facts?.error && <p role="alert">{facts.error}</p>}
      {facts?.cards && (
        <p role="status">
          {facts.loading || facts.error ? '上次读取' : '已完整读取'} {facts.cards.length}{' '}
          项交互记录。
        </p>
      )}
      {facts?.cards?.map((card) => (
        <details key={`${card.id}/${card.revision}`} data-interaction-id={card.id}>
          <summary>
            {interactionHistoryLabel(card)} · {card.definitionId}
          </summary>
          <p>
            {card.acceptedDecisionRevision === card.revision
              ? '本次执行已接收该回答；这不表示执行成功。'
              : card.answer !== null
                ? '回答已保存，尚未确认被执行接收。'
                : '没有已保存的回答。'}
          </p>
          {card.answer !== null && (
            <section aria-label="已保存的回答">
              <pre data-saved-answer>
                {card.answer.kind === 'plan_review' && card.answer.decision === 'revise'
                  ? card.answer.feedback
                  : JSON.stringify(card.answer, null, 2)}
              </pre>
            </section>
          )}
          <InteractionCard interaction={card} onReadAttachment={attachmentReader} />
        </details>
      ))}
    </section>
  );
}
