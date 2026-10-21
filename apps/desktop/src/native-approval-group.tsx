import type { Interaction } from '@kite-ai/client';
import { ApprovalHeader } from '@kite-ai/ui/desktop';
import { type ReactNode, useEffect, useState } from 'react';

export interface NativeApprovalOwner {
  storeId: string;
  sessionId: string;
  runId: string;
  title: string;
}

/** MCP source decisions keep their own form and scope, outside ordinary tool approvals. */
export function isOrdinaryNativeApproval(interaction: Interaction) {
  if (interaction.kind !== 'approval') return false;
  const request = interaction.request;
  const kind =
    request && typeof request === 'object' && !Array.isArray(request) ? request.kind : undefined;
  return kind !== 'mcp_source_approval' && kind !== 'mcp_credential_binding';
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

/** One presentation surface; every item retains its original answer and attachment authority. */
export function NativeApprovalGroup({
  interactions,
  storeId,
  rootSessionId,
  owners = [],
  renderInteraction,
}: {
  interactions: readonly Interaction[];
  storeId: string;
  rootSessionId: string;
  owners?: readonly NativeApprovalOwner[];
  renderInteraction: (interaction: Interaction, embedded: boolean) => ReactNode;
}) {
  const approvals = interactions.filter(isOrdinaryNativeApproval);
  const key = (interaction: Interaction) =>
    JSON.stringify([interaction.originStoreId, interaction.id]);
  const scope = JSON.stringify([storeId, rootSessionId]);
  const [selected, setSelected] = useState<{ scope: string; key: string; index: number }>();
  const found =
    selected?.scope === scope ? approvals.findIndex((item) => key(item) === selected.key) : -1;
  const index =
    found >= 0
      ? found
      : Math.min(selected?.scope === scope ? selected.index : 0, Math.max(0, approvals.length - 1));
  const current = approvals[index];
  const currentKey = current && key(current);
  useEffect(() => {
    if (currentKey)
      setSelected((previous) =>
        previous?.scope === scope && previous.key === currentKey && previous.index === index
          ? previous
          : { scope, key: currentKey, index },
      );
  }, [scope, currentKey, index]);
  const move = (direction: number) => {
    if (!approvals.length) return;
    const nextIndex = (index + direction + approvals.length) % approvals.length;
    setSelected({ scope, key: key(approvals[nextIndex]!), index: nextIndex });
  };
  return (
    <>
      {current && (
        <section className="native-approval-group" aria-label="需要人工审批">
          <ApprovalHeader
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
          <div key={JSON.stringify([key(current), current.revision])}>
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
