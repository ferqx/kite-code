import type { Interaction } from '@kite-ai/client';
import { ApprovalHeader } from '@kite-ai/ui/desktop';
import { type ReactNode, type SyntheticEvent, useEffect, useState } from 'react';
import { isOrdinaryNativeApproval } from './native-approval-priority';

export interface NativeApprovalOwner {
  storeId: string;
  sessionId: string;
  runId: string;
  title: string;
}

export function nativeApprovalOwnerLabel(
  interaction: Interaction,
  storeId: string,
  rootSessionId: string,
  owners: readonly NativeApprovalOwner[],
) {
  if (interaction.originStoreId === storeId && interaction.sessionId === rootSessionId)
    return '主 Agent';
  const matches = owners.filter(
    (owner) =>
      owner.storeId === interaction.originStoreId &&
      owner.storeId === storeId &&
      owner.sessionId === interaction.sessionId &&
      owner.runId === interaction.runId,
  );
  const title = matches.length === 1 ? matches[0]!.title.trim() : '';
  return title &&
    title !== interaction.sessionId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title)
    ? title
    : '子 Agent';
}

/** The runtime writes this display hint outside the nested policy and input. */
function approvalTitle(card: Interaction) {
  const request = card.request;
  return request &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    request.approvalPresentation === 'reviewer_handoff'
    ? '自动审核转人工'
    : undefined;
}

/** One presentation surface; every item retains its original answer and attachment authority. */
export function NativeApprovalGroup({
  interactions,
  storeId,
  rootSessionId,
  owners = [],
  priority,
  renderInteraction,
}: {
  interactions: readonly Interaction[];
  storeId: string;
  rootSessionId: string;
  owners?: readonly NativeApprovalOwner[];
  priority?: {
    current: (interaction: Interaction) => boolean;
    earlier: (interaction: Interaction) => boolean;
  };
  renderInteraction: (interaction: Interaction, embedded: boolean) => ReactNode;
}) {
  const approvals = interactions.filter(
    (interaction) => interaction.state === 'pending' && isOrdinaryNativeApproval(interaction),
  );
  const key = (interaction: Interaction) =>
    JSON.stringify([interaction.originStoreId, interaction.id]);
  const scope = JSON.stringify([storeId, rootSessionId]);
  const [selected, setSelected] = useState<{
    scope: string;
    key: string;
    index: number;
    explicit: boolean;
  }>();
  const found =
    selected?.scope === scope ? approvals.findIndex((item) => key(item) === selected.key) : -1;
  const preferred = priority ? approvals.findIndex(priority.current) : -1;
  const keep = found >= 0 && (selected?.explicit || priority?.current(approvals[found]!));
  const index =
    preferred >= 0 && !keep
      ? preferred
      : found >= 0
        ? found
        : Math.min(
            selected?.scope === scope ? selected.index : 0,
            Math.max(0, approvals.length - 1),
          );
  const current = approvals[index];
  const currentKey = current && key(current);
  useEffect(() => {
    if (currentKey)
      setSelected((previous) =>
        previous?.scope === scope && previous.key === currentKey && previous.index === index
          ? previous
          : {
              scope,
              key: currentKey,
              index,
              explicit:
                previous?.scope === scope && previous.key === currentKey && previous.explicit,
            },
      );
  }, [scope, currentKey, index]);
  const move = (direction: number) => {
    if (!approvals.length) return;
    const nextIndex = (index + direction + approvals.length) % approvals.length;
    setSelected({ scope, key: key(approvals[nextIndex]!), index: nextIndex, explicit: true });
  };
  const retain = (event: SyntheticEvent<HTMLDivElement>) => {
    // Focus moving into a portalled menu does not change which card owns it.
    if (
      !currentKey ||
      !event.currentTarget.contains(event.target as Node) ||
      (selected?.scope === scope && selected.key === currentKey && selected.explicit)
    )
      return;
    setSelected({ scope, key: currentKey, index, explicit: true });
  };
  return (
    <>
      {current && (
        <section
          className="native-approval-group"
          aria-label="需要人工审批"
          onClickCapture={(event) => {
            // A double click must not answer the next card occupying the same button position.
            if (event.detail > 1) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyDownCapture={(event) => {
            if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <ApprovalHeader
            title={approvalTitle(current)}
            scopeLabel={priority?.earlier(current) ? '较早轮次' : undefined}
            child={
              current.originStoreId === storeId && current.sessionId === rootSessionId
                ? undefined
                : {
                    identity: JSON.stringify([current.originStoreId, current.sessionId]),
                    name: nativeApprovalOwnerLabel(current, storeId, rootSessionId, owners),
                  }
            }
            index={index}
            count={approvals.length}
            onPrevious={() => move(-1)}
            onNext={() => move(1)}
          />
          <div
            key={JSON.stringify([key(current), current.revision])}
            onClickCapture={retain}
            onFocusCapture={retain}
          >
            {renderInteraction(current, true)}
          </div>
        </section>
      )}
      {interactions
        .filter((interaction) => !isOrdinaryNativeApproval(interaction))
        .map((interaction) => (
          <div
            key={JSON.stringify([interaction.originStoreId, interaction.id, interaction.revision])}
          >
            {renderInteraction(interaction, false)}
          </div>
        ))}
    </>
  );
}
