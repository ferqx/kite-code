import {
  type Conversation,
  type Message as DesktopMessage,
  ToolActivity,
} from '@kite-ai/ui/desktop';
import { type ComponentProps, Fragment, type ReactNode } from 'react';
import type { NativeFileChange } from './file-changes-bridge';
import type { liveToolMessages } from './native-tool-messages';
import type { NativeToolMessageFact } from './tool-messages-bridge';

export type NativeToolRenderer = NonNullable<
  ComponentProps<typeof Conversation>['renderToolActivity']
>;
type Options = {
  tools: readonly NativeToolMessageFact[];
  retainedFact: (message: DesktopMessage) => NativeToolMessageFact | undefined;
  targets?: readonly NativeFileChange[];
  liveTools: ReturnType<typeof liveToolMessages>;
  executionUnconfirmed: boolean;
  observationUnavailable: boolean;
  diagnostics: boolean;
  metadataPending?: ReadonlySet<string>;
  renderSearch?: (model: DesktopMessage, executionId: string, live: boolean) => ReactNode;
  renderOriginal: (message: DesktopMessage, open: boolean) => ReactNode;
  hasDeferredText?: (message: DesktopMessage) => boolean;
  agentProps?: (
    message: DesktopMessage,
    fact: NativeToolMessageFact | undefined,
  ) => Pick<ComponentProps<typeof ToolActivity>, 'childAgent' | 'childDetail'>;
  renderImages?: (message: DesktopMessage, fact: NativeToolMessageFact | undefined) => ReactNode;
  renderFileChange?: (
    entry: NativeFileChange,
    open: boolean,
    openFile?: (path: string) => void,
  ) => ReactNode;
  openFileForTarget?: (entry: NativeFileChange) => ((path: string) => void) | undefined;
};

export function renderNativeToolGroup(
  group: Parameters<NativeToolRenderer>[0],
  controls: Parameters<NativeToolRenderer>[1],
  options: Options,
  ordinarySegment = false,
): ReactNode {
  const aggregate = !!controls.aggregate;
  const displayTools = group.flatMap((model) => {
    const fact =
      options.tools.find((entry) => entry.messageId === model.id) ?? options.retainedFact(model);
    return fact ? [fact] : [];
  });
  const displayTargets = options.targets ?? [];
  const agentProps = (model: DesktopMessage) =>
    options.agentProps?.(
      model,
      displayTools.find((fact) => fact.messageId === model.id),
    );
  const childOperation = (model: (typeof group)[number]) =>
    model.toolName === 'spawn_agent' || model.toolName === 'follow_up_agent';
  const agentTool = (model: (typeof group)[number]) => {
    const props = agentProps(model);
    return childOperation(model) ? (
      <ToolActivity
        {...props}
        inTrace={controls.inTrace}
        childAgent={
          props?.childAgent ??
          (model.status === 'completed'
            ? {
                name: '子 Agent',
              }
            : undefined)
        }
        aggregate={false}
        messages={[model]}
        expanded={controls.expandedItems[model.presentationKey ?? model.id]}
        onToggle={(open) => controls.onToggleItem(model.presentationKey ?? model.id, open)}
        activityId={model.presentationKey ?? model.id}
        restoredExpanded={controls.restoredExpanded}
        renderChildren={() => null}
      />
    ) : undefined;
  };
  // A verified child operation is a direct navigation row. Keep it outside
  // ordinary Tool disclosures, preserving the original tool order and the
  // independent expansion identities of ordinary segments on either side.
  // Establish segment owners before a child arrives, so ongoing rows never remount.
  if (!ordinarySegment && controls.inTrace) {
    const agent = group.length === 1 && agentTool(group[0]!);
    if (agent) return agent;
  } else if (!ordinarySegment) {
    const rows: ReactNode[] = [];
    let ordinary: (typeof group)[number][] = [];
    let childBoundary: (typeof group)[number] | undefined;
    let segmentIndex = 0;
    const flush = () => {
      if (!ordinary.length) return;
      const segment = ordinary;
      ordinary = [];
      // Receipts may change the first item. The block and child boundaries own segments.
      const key =
        segmentIndex++ === 0
          ? controls.activityId
          : `activity:${childBoundary!.presentationKey ?? childBoundary!.id}`;
      rows.push(
        <Fragment key={key}>
          {renderNativeToolGroup(
            segment,
            {
              ...controls,
              activityId: key,
              expanded:
                controls.expandedItems[key] ??
                (key === controls.activityId ? controls.expanded : undefined),
              onToggle: (open) => controls.onToggleItem(key, open),
            },
            options,
            true,
          )}
        </Fragment>,
      );
    };
    for (const model of group) {
      const row = agentTool(model);
      if (row) {
        flush();
        rows.push(<Fragment key={model.presentationKey ?? model.id}>{row}</Fragment>);
        childBoundary = model;
      } else ordinary.push(model);
    }
    flush();
    return <>{rows}</>;
  }
  const unverified = new Set(
    group
      .filter(
        (model) =>
          !displayTools.some((entry) => entry.messageId === model.id) &&
          !displayTargets.some((entry) => entry.messageId === model.id) &&
          !options.liveTools.some((entry) => entry.message.id === model.id),
      )
      .map((model) => model.id),
  );
  const liveNotices =
    controls.inTrace && !options.diagnostics
      ? []
      : group.map((model) => {
          const live = options.liveTools.find((entry) => entry.message.id === model.id);
          const status =
            !live || options.executionUnconfirmed
              ? undefined
              : live.execution.cancelRequestedAt !== null
                ? controls.inTrace
                  ? undefined
                  : '已请求停止，等待执行结果。'
                : options.diagnostics && options.observationUnavailable
                  ? '上次确认状态'
                  : undefined;
          return status ? (
            <p key={model.id} role="status">
              {status}
            </p>
          ) : null;
        });
  // Each receipt owns its verification and reader independently. An unknown
  // sibling must not withdraw another tool's verified file actions or output.
  const originalTool = (
    model: (typeof group)[number],
    expanded: boolean | undefined,
    onToggle: (open: boolean) => void,
  ) => (
    <ToolActivity
      aggregate={false}
      inTrace={controls.inTrace}
      directTraceDetails={controls.directTraceDetails}
      traceSummaryTitle={controls.traceSummaryTitle}
      parentDisclosureOpen={controls.parentDisclosureOpen}
      unverified
      metadataPending={options.metadataPending?.has(model.id)}
      messages={[{ ...model, toolName: undefined, title: model.title ?? '工具结果', text: '' }]}
      expanded={expanded}
      onToggle={onToggle}
      activityId={
        !aggregate && group.length === 1 ? controls.activityId : (model.presentationKey ?? model.id)
      }
      restoredExpanded={controls.restoredExpanded}
      renderChildren={(_id, open) => options.renderOriginal(model, open)}
    />
  );
  if (!aggregate && group.length === 1 && unverified.has(group[0]!.id))
    return originalTool(group[0]!, controls.expanded, controls.onToggle);
  const renderToolImages = (model: DesktopMessage) =>
    options.renderImages?.(
      model,
      displayTools.find((fact) => fact.messageId === model.id),
    );
  const models = group.map((model) => {
    if (unverified.has(model.id)) return { ...model, title: model.title ?? '工具结果', text: '' };
    const image = displayTools.find((entry) => entry.messageId === model.id);
    if (image?.definitionId === 'files.view_images' && image.definitionVersion === '1')
      return {
        ...model,
        toolName: 'view_images',
        toolImageCount: image.status === 'succeeded' ? (image.images?.length ?? 0) : 0,
      };
    const target = displayTargets.find((entry) => entry.messageId === model.id);
    return target?.path && target.operation
      ? {
          ...model,
          toolName: { read: 'read_file', write: 'write_file', edit: 'edit_file' }[target.operation],
          target: target.path,
          arguments: { path: target.path },
          status: 'completed' as const,
          settled: true,
          changeConfirmed: target.operation !== 'read',
          fileDiffCounts: target.diffCounts,
        }
      : model;
  });
  return (
    <>
      <ToolActivity
        {...controls}
        {...(!aggregate && group[0] ? agentProps(group[0]) : {})}
        aggregate={aggregate}
        unverified={unverified.size > 0}
        messages={models}
        receiptDetails={
          options.renderSearch
            ? (model) => {
                const fact = displayTools.find((e) => e.messageId === model.id),
                  live = options.liveTools.find((e) => e.message.id === model.id)?.execution,
                  owner = fact ?? live;
                if (owner?.definitionId !== 'web.search' || owner.definitionVersion !== '1') return;
                const id = fact?.executionId ?? live?.id;
                if (!id) return;
                return () =>
                  options.renderSearch!(
                    model,
                    id,
                    !!live &&
                      live.id === id &&
                      live.status === 'running' &&
                      !options.executionUnconfirmed,
                  );
              }
            : undefined
        }
        renderItem={
          aggregate
            ? (model) =>
                unverified.has(model.id)
                  ? originalTool(
                      group.find((original) => original.id === model.id)!,
                      controls.expandedItems[model.presentationKey ?? model.id],
                      (open) => controls.onToggleItem(model.presentationKey ?? model.id, open),
                    )
                  : agentTool(model)
            : undefined
        }
        renderChildren={(_id, open, messageId) => {
          const model = group.find((entry) => entry.id === messageId);
          if (displayTools.some((fact) => fact.messageId === messageId && fact.shellOutputError))
            return (
              <p key={messageId} role="status">
                无法读取已保存的输出。
              </p>
            );
          return model && !model.agentWait && !model.shell && options.hasDeferredText?.(model)
            ? options.renderOriginal(model, open)
            : null;
        }}
        renderImages={renderToolImages}
        renderFileChange={
          options.renderFileChange &&
          ((model, open, openFile) => {
            const target = displayTargets.find((entry) => entry.messageId === model.id);
            return target && options.renderFileChange?.(target, open, openFile);
          })
        }
        openFileForMessage={
          options.openFileForTarget &&
          ((model) => {
            const target = displayTargets.find((entry) => entry.messageId === model.id);
            return target && options.openFileForTarget?.(target);
          })
        }
      />
      {group.map((model) => {
        const image = displayTools.find((entry) => entry.messageId === model.id);
        return image?.definitionId === 'files.view_images' && image.definitionVersion === '1'
          ? null
          : renderToolImages(model);
      })}
      {liveNotices}
    </>
  );
}
