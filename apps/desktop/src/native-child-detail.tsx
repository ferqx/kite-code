import type { ModelOutputSnapshot } from '@kite-ai/client';
import { Conversation, ConversationActivityContext, ReadingStateCache } from '@kite-ai/ui/desktop';
import { type ComponentProps, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeFileChangeDetail } from './file-changes-bridge';
import type { NativeBridge } from './native-bridge';
import { useNativeDiagnostics } from './native-diagnostics';
import { NativeDisplayCache } from './native-display-cache';
import { nativeChildActivity, type useNativeEnvironment } from './native-environment';
import { NativeOperationDiff } from './native-file-changes';
import type { NativeImagePreviews } from './native-image-previews';
import { NativeMessageText } from './native-message-text';
import { NativeModelOutputMessage } from './native-model-output-message';
import { type NativeReasoningBody, renderNativeReasoning } from './native-reasoning';
import {
  groupNativeToolMessages,
  liveToolMessages,
  NativeToolPresentation,
} from './native-tool-messages';
import { type NativeToolRenderer, renderNativeToolGroup } from './native-tool-renderer';
import { desktopTranscript, nativeReplyKey } from './native-transcript';
import { NativeUserImages } from './native-user-images';
import type { NativeToolMessageFact } from './tool-messages-bridge';

export interface NativeChildDetailProps {
  child: ReturnType<typeof useNativeEnvironment>['child'];
  bridge?: NativeBridge;
  imagePreviews?: NativeImagePreviews;
  generation: number;
  storeId: string;
  sessionId: string;
  executionId?: string;
  executionUnconfirmed?: boolean;
  readActive: boolean;
  writeClipboardText?: (text: string) => Promise<void>;
  renderTurnOutputs?: ComponentProps<typeof Conversation>['renderTurnOutputs'];
  onTitleChange: (title: string) => void;
  /** Owned by the parent so switching tabs retains bounded reading data, without hidden readers. */
  readingCache?: ReadingStateCache;
}

/** Presents only the exact admitted child; all bridge reads remain owned by the environment. */
export function NativeChildDetail({
  child,
  bridge,
  imagePreviews,
  generation,
  storeId,
  sessionId,
  executionId,
  executionUnconfirmed = false,
  readActive,
  writeClipboardText,
  renderTurnOutputs,
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
  const savedMessages = facts?.messages;
  const savedOutputs = facts?.modelOutputs;
  const messages = useMemo(() => savedMessages ?? [], [savedMessages]);
  const originals = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const outputs = useMemo(
    () => new Map(savedOutputs?.map((output) => [output.messageId, output.snapshot])),
    [savedOutputs],
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
        facts?.presentation?.liveTools,
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
        compressionProgress:
          activity.readActive && !executionUnconfirmed
            ? facts?.presentation?.compressionProgress
            : undefined,
        storeId,
        sessionId,
        traceTurns: true,
        fullReply: (message) => {
          const displayed = displayedReplies.get(message.id);
          return displayed?.identity === nativeReplyKey(readingKey, message) &&
            displayed.snapshot === outputs.get(message.id)
            ? displayed.text
            : undefined;
        },
      }),
    [
      facts,
      messages,
      storeId,
      sessionId,
      outputs,
      readingKey,
      displayedReplies,
      activity.readActive,
      executionUnconfirmed,
    ],
  );
  const toolPresentation = useRef(new NativeToolPresentation());
  const reasoningBodies = useRef(new NativeDisplayCache<NativeReasoningBody>());
  const operationDiffs = useRef(new NativeDisplayCache<NativeFileChangeDetail>());
  const renderImages = (id: string, images?: NativeToolMessageFact['images']) => {
    const message = originals.get(id);
    const handle = facts?.presentation?.imageHandles?.find(
      (entry) => entry.messageId === id,
    )?.handle;
    return message && (handle || message.files?.length) && bridge && imagePreviews ? (
      <NativeUserImages
        key={message.id}
        bridge={bridge}
        previews={imagePreviews}
        generation={generation}
        viewSelection={0}
        historyEpoch={0}
        childHandle={handle}
        message={message}
        images={handle ? images : []}
        readAvailable={activity.readActive && !!handle}
      />
    ) : null;
  };
  const models = useMemo(
    () =>
      groupNativeToolMessages(
        toolPresentation.current.project(
          readingKey,
          transcript.messages,
          [...(facts?.presentation?.tools ?? []), ...(facts?.presentation?.liveTools ?? [])],
          liveTools,
        ),
      ),
    [
      readingKey,
      transcript.messages,
      facts?.presentation?.tools,
      facts?.presentation?.liveTools,
      liveTools,
    ],
  );
  const renderMessage = (
    model: Parameters<NonNullable<ComponentProps<typeof Conversation>['renderMessageContent']>>[0],
    open = true,
  ) => {
    const message = originals.get(model.id);
    if (!message) return null;
    if (message.deferredText && (model.shell || model.toolName === 'shell_execute')) return null;
    if (message.deferredText && !model.agentWait && bridge) {
      const handle = facts?.presentation?.textHandles?.find(
        (entry) => entry.messageId === message.id,
      )?.handle;
      if (handle)
        return (
          <NativeMessageText
            key={handle}
            bridge={bridge}
            generation={generation}
            storeId={storeId}
            message={message}
            childHandle={handle}
            available={activity.readActive}
            active={open}
            automatic={message.role !== 'tool' && message.role !== 'user'}
          />
        );
    }
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
  const renderTools: NativeToolRenderer = (group, controls) =>
    renderNativeToolGroup(group, controls, {
      tools: facts?.presentation?.tools ?? [],
      targets: facts?.presentation?.fileTargets,
      renderFileChange: bridge
        ? (entry, open, openFile) => (
            <NativeOperationDiff
              key={entry.changeId}
              bridge={bridge}
              generation={generation}
              entry={entry}
              openFile={openFile}
              editor="vscode"
              open={open}
              cache={operationDiffs.current}
              child
            />
          )
        : undefined,
      retainedFact: (model) => toolPresentation.current.retainedFact(model),
      liveTools,
      executionUnconfirmed,
      observationUnavailable: !!detail?.error,
      diagnostics,
      renderOriginal: renderMessage,
      renderImages: (model, fact) =>
        fact?.images?.length ? renderImages(model.id, fact.images) : null,
      hasDeferredText: (model) => !!originals.get(model.id)?.deferredText,
    });
  return (
    <section className="native-child-detail" aria-label="子 Agent 详情">
      {diagnostics && facts?.presentation?.unavailable && (
        <p role="alert">无法核对子会话轮次或工具状态，已保留原消息；后台将自动重新核对。</p>
      )}
      {diagnostics && detail?.error && (
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
          // A failed first read is still unverified history, not an empty conversation.
          // Retained facts remain readable while the environment retries in the background.
          loading={!facts}
          selected
          connected
          initialReading={readings.get(readingKey)}
          saveReading={(state) => readings.save(readingKey, state)}
          renderMessageContent={renderMessage}
          renderTurnOutputs={renderTurnOutputs}
          renderMessageAttachments={(model) => renderImages(model.id)}
          renderToolActivity={renderTools}
          traceTurns
          preserveReadingAnchor
          renderReasoning={(model, open) => {
            const original = model.reasoningSource
              ? originals.get(model.reasoningSource)
              : undefined;
            const snapshot = original && outputs.get(original.id);
            return renderNativeReasoning({
              scope: readingKey,
              model,
              original,
              open,
              revision: snapshot?.bodyHash,
              cache: reasoningBodies.current,
              read:
                snapshot && activity.readActive
                  ? async (signal) => {
                      signal.throwIfAborted();
                      return snapshot.output.reasoning;
                    }
                  : undefined,
            });
          }}
          writeClipboardText={writeClipboardText}
        />
      </ConversationActivityContext>
    </section>
  );
}
