import type { ModelOutputSnapshot } from '@kite-ai/client';
import {
  Button,
  Conversation,
  ConversationActivityContext,
  ReadingStateCache,
  ToolActivity,
} from '@kite-ai/ui/desktop';
import { type ComponentProps, useEffect, useMemo, useRef, useState } from 'react';
import { useNativeDiagnostics } from './native-diagnostics';
import { nativeChildActivity, type useNativeEnvironment } from './native-environment';
import { NativeModelOutputMessage } from './native-model-output-message';
import { groupNativeToolMessages, liveToolMessages } from './native-tool-messages';
import { desktopTranscript, nativeReplyKey } from './native-transcript';

export interface NativeChildDetailProps {
  child: ReturnType<typeof useNativeEnvironment>['child'];
  generation: number;
  storeId: string;
  sessionId: string;
  executionId?: string;
  executionUnconfirmed?: boolean;
  readActive: boolean;
  onRefresh: () => void;
  writeClipboardText?: (text: string) => Promise<void>;
  onTitleChange: (title: string) => void;
  /** Owned by the parent so switching tabs retains bounded reading data, without hidden readers. */
  readingCache?: ReadingStateCache;
}

/** Presents only the exact admitted child; all bridge reads remain owned by the environment. */
export function NativeChildDetail({
  child,
  generation,
  storeId,
  sessionId,
  executionId,
  executionUnconfirmed = false,
  readActive,
  onRefresh,
  writeClipboardText,
  onTitleChange,
  readingCache,
}: NativeChildDetailProps) {
  const diagnostics = useNativeDiagnostics();
  const localReadings = useRef<ReadingStateCache | undefined>(undefined);
  localReadings.current ??= new ReadingStateCache();
  const readings = readingCache ?? localReadings.current;
  const detail =
    child?.sessionId === sessionId &&
    (executionId === undefined || child.executionId === executionId)
      ? child
      : undefined;
  const facts =
    detail?.facts?.session.id === sessionId &&
    detail.facts.item.execution.childSessionId === sessionId &&
    (executionId === undefined || detail.facts.item.execution.id === executionId)
      ? detail.facts
      : undefined;
  const title = facts?.session.title ?? detail?.title;
  const activity = useMemo(
    () => ({ readActive: readActive && !!facts && !detail?.loading, resume: 0 }),
    [readActive, facts, detail?.loading],
  );
  useEffect(() => {
    if (title) onTitleChange(title);
  }, [title, onTitleChange]);
  const readingKey = JSON.stringify([generation, storeId, sessionId, executionId]);
  const messages = useMemo(() => facts?.messages ?? [], [facts]);
  const originals = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const outputs = useMemo(
    () => new Map(facts?.modelOutputs.map((output) => [output.messageId, output.snapshot])),
    [facts],
  );
  // Snapshot availability is not display admission: a closed reader shows only its preview.
  const [displayedReplies, setDisplayedReplies] = useState(
    () => new Map<string, { identity: string; snapshot: ModelOutputSnapshot; text: string }>(),
  );
  const currentReplies = useRef({
    readingKey,
    originals,
    outputs,
    readActive: activity.readActive,
  });
  currentReplies.current = { readingKey, originals, outputs, readActive: activity.readActive };
  const liveTools = useMemo(
    () =>
      liveToolMessages(
        facts?.presentation
          ? { storeId, session: facts.session, ...facts.presentation }
          : undefined,
        messages,
        executionUnconfirmed,
      ),
    [facts, storeId, messages, executionUnconfirmed],
  );
  const transcript = useMemo(
    () =>
      desktopTranscript({
        messages,
        runs: facts?.presentation?.runs ?? [],
        tools: facts?.presentation?.tools ?? [],
        executions: facts?.presentation?.executions,
        storeId,
        sessionId,
        fullReply: (message) => {
          const displayed = displayedReplies.get(message.id);
          return displayed?.identity === nativeReplyKey(readingKey, message) &&
            displayed.snapshot === outputs.get(message.id)
            ? displayed.text
            : undefined;
        },
      }),
    [facts, messages, storeId, sessionId, outputs, readingKey, displayedReplies],
  );
  const models = useMemo(
    () =>
      groupNativeToolMessages([...transcript.messages, ...liveTools.map((entry) => entry.message)]),
    [transcript.messages, liveTools],
  );
  const renderMessage: NonNullable<ComponentProps<typeof Conversation>['renderMessageContent']> = (
    model,
  ) => {
    const message = originals.get(model.id);
    if (!message) return null;
    const snapshot = outputs.get(model.id);
    const identity = nativeReplyKey(readingKey, message);
    const publishDisplayed = (text: string | undefined, explicitClose = false) => {
      setDisplayedReplies((previous) => {
        const current = currentReplies.current;
        const original = current.originals.get(message.id);
        if (
          current.readingKey !== readingKey ||
          !original ||
          nativeReplyKey(readingKey, original) !== identity ||
          current.outputs.get(message.id) !== snapshot
        )
          return previous;
        // Pausing retains the verified display; explicit dismissal must still revoke it.
        if (text === undefined && !current.readActive && !explicitClose) return previous;
        const next = new Map(
          [...previous].filter(([id, entry]) => {
            const owner = current.originals.get(id);
            return (
              owner &&
              entry.identity === nativeReplyKey(readingKey, owner) &&
              entry.snapshot === current.outputs.get(id)
            );
          }),
        );
        if (text === undefined || !snapshot) next.delete(message.id);
        else next.set(message.id, { identity, snapshot, text });
        if (
          next.size === previous.size &&
          [...next].every(([id, entry]) => {
            const before = previous.get(id);
            return (
              before?.identity === entry.identity &&
              before.snapshot === entry.snapshot &&
              before.text === entry.text
            );
          })
        )
          return previous;
        return next;
      });
    };
    return (
      <NativeModelOutputMessage
        key={JSON.stringify([generation, storeId, sessionId, message.id])}
        message={message}
        storeId={storeId}
        canReadRestoredOrigin
        verifiedSnapshot={snapshot}
        onContent={publishDisplayed}
        onClose={() => publishDisplayed(undefined, true)}
        onRead={
          snapshot
            ? async ({ signal }) => {
                signal.throwIfAborted();
                return snapshot;
              }
            : undefined
        }
      />
    );
  };
  const renderTools: NonNullable<ComponentProps<typeof Conversation>['renderToolActivity']> = (
    group,
    controls,
  ) => {
    const unverified = new Set(
      group
        .filter(
          (model) =>
            !facts?.presentation?.tools.some((entry) => entry.messageId === model.id) &&
            !liveTools.some((entry) => entry.message.id === model.id),
        )
        .map((model) => model.id),
    );
    const originalTool = (
      model: (typeof group)[number],
      expanded: boolean | undefined,
      onToggle: (open: boolean) => void,
    ) => (
      <ToolActivity
        unverified
        messages={[{ ...model, toolName: undefined, title: model.title ?? '工具结果', text: '' }]}
        expanded={expanded}
        onToggle={onToggle}
        activityId={group.length === 1 ? controls.activityId : model.id}
        restoredExpanded={controls.restoredExpanded}
        renderChildren={() => renderMessage(model)}
      />
    );
    return (
      <>
        {unverified.size && group.length === 1 ? (
          originalTool(group[0]!, controls.expanded, controls.onToggle)
        ) : (
          <ToolActivity
            {...controls}
            unverified={unverified.size > 0}
            messages={group.map((model) =>
              unverified.has(model.id)
                ? { ...model, title: model.title ?? '工具结果', text: '' }
                : model,
            )}
            renderItem={(model) =>
              unverified.has(model.id)
                ? originalTool(
                    group.find((original) => original.id === model.id)!,
                    controls.expandedItems[model.id],
                    (open) => controls.onToggleItem(model.id, open),
                  )
                : undefined
            }
            renderChildren={() => null}
          />
        )}
        {group.map((model) => {
          const live = liveTools.find((entry) => entry.message.id === model.id);
          const notice =
            !live || executionUnconfirmed
              ? undefined
              : detail?.error
                ? '上次确认状态'
                : live.execution.cancelRequestedAt !== null
                  ? '已请求停止，等待执行结果。'
                  : undefined;
          return notice ? (
            <p key={model.id} role="status">
              {notice}
            </p>
          ) : null;
        })}
      </>
    );
  };
  return (
    <section className="native-child-detail" aria-label="子 Agent 详情">
      <div className="native-child-detail-heading">
        <Button className="ghost" onClick={onRefresh} disabled={!detail || detail.loading}>
          刷新子日志
        </Button>
        <span>子 Agent 会话仅供查看。</span>
      </div>
      {facts?.presentation?.unavailable && (
        <p role="alert">无法核对子会话轮次或工具状态，已保留原消息；可刷新子日志重新核对。</p>
      )}
      {detail?.error && (
        <p role="alert">
          子日志读取失败：{detail.error}。{facts ? '保留上次完整内容。' : '尚未取得完整内容。'}
        </p>
      )}
      {diagnostics && facts && (
        <p>
          已完整读取子日志至固定序号 {facts.upperSeq}，原子轮次{' '}
          {facts.item.childRun?.id ?? '尚未确认'}。
          {!executionUnconfirmed &&
            !detail?.loading &&
            !detail?.error &&
            nativeChildActivity(facts)}
        </p>
      )}
      <ConversationActivityContext value={activity}>
        <Conversation
          key={readingKey}
          messages={models}
          turnActivity={
            transcript.turnActivity
              ? {
                  ...transcript.turnActivity,
                  executionUnconfirmed,
                  unavailable: !!detail?.error || facts?.presentation?.unavailable,
                }
              : undefined
          }
          loading={!facts && (!detail || detail.loading)}
          selected
          connected
          initialReading={readings.get(readingKey)}
          saveReading={(state) => readings.save(readingKey, state)}
          renderMessageContent={renderMessage}
          renderToolActivity={renderTools}
          writeClipboardText={writeClipboardText}
        />
      </ConversationActivityContext>
    </section>
  );
}
