import { ArrowDown01Icon, ArrowDown02Icon, ReduceParagraphIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type ComponentProps,
  createContext,
  Fragment,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useConversationActivity } from '../conversation-activity';
import {
  type ConversationMessageMarker,
  ConversationMessageNavigation,
  conversationMessageNavigationTop,
  currentConversationMessage,
} from './ConversationMessageNavigation';
import {
  ConversationTrace,
  isConversationTraceStep,
  isStandaloneTraceTool,
  latestRunningTraceTool,
  traceInteractionTitle,
  traceKey,
} from './ConversationTrace';
import { ClipboardWriteContext, CodeCopyEligibilityContext } from './clipboard';
import { Collapsible, CollapsibleTrigger } from './components/ui/collapsible';
import { ScrollArea } from './components/ui/scroll-area';
import { Spinner } from './components/ui/spinner';
import { TraceIcon, TraceLine, TraceTitle } from './components/ui/trace';
import {
  type ConversationScrollAnchor,
  captureConversationScrollAnchor,
  restoreConversationScrollAnchor,
} from './conversation-window';
import { DeferredProcessContent } from './DeferredProcessContent';
import { useDesktopDiagnostics } from './diagnostics';
import { cn } from './lib/utils';
import { MessageContent } from './MessageContent';
import { MessageCopyButton, type MessageCopyRole } from './MessageCopyButton';
import { ModelConnection } from './ModelConnection';
import { formatMessageTime } from './message-time';
import { PromptMarkdown } from './PromptMarkdown';
import { pruneReadingState } from './reading-state';
import { statusLabel } from './status';
import { completedToolActions, ToolActivity, toolTraceTitle } from './ToolActivity';
import { TurnFailure } from './TurnFailure';
import type { Message, TurnActivity } from './types';
import { Button } from './ui';

export interface ReadingState {
  top: number;
  follow: boolean;
  expanded: Record<string, boolean>;
  anchor?: ConversationScrollAnchor;
}

export interface ToolActivityState {
  aggregate?: boolean;
  inTrace?: boolean;
  directTraceDetails?: boolean;
  traceSummaryTitle?: string;
  parentDisclosureOpen?: boolean;
  expanded?: boolean;
  activityId: string;
  restoredExpanded: ReadonlySet<string>;
  expandedItems: Readonly<Record<string, boolean>>;
  onToggle: (open: boolean) => void;
  onToggleItem: (id: string, open: boolean) => void;
}

type RetainedEntry = {
  facts: readonly unknown[];
  content: ReactNode;
  openTurns: string[];
  traceProcesses: Map<string, boolean>;
};

function sameEntryFacts(before: readonly unknown[], after: readonly unknown[]) {
  return before.length === after.length && before.every((fact, i) => Object.is(fact, after[i]));
}

/** Only confirmed guidance shares its original Turn's process, including local sending. */
function processTurnId(message: Message): string | undefined {
  if (
    message.role === 'user' &&
    (message.inputKind !== 'input.steer' ||
      message.delivery === 'failed' ||
      message.delivery === 'unknown')
  )
    return undefined;
  return message.turnId;
}

function isNavigationMessage(message: Message) {
  return (
    message.role === 'user' && !message.inputKind && !message.agentMessage && !message.agentResult
  );
}

function isTurnFailure(message: Message): boolean {
  return (
    message.role === 'system' &&
    (message.systemKind === 'turn_failure' ||
      (message.status === 'failed' && message.id === `failure:${message.turnId}`))
  );
}

function isOngoingTurn(activity?: TurnActivity): boolean {
  return (
    !!activity &&
    [
      'creating_session',
      'preparing',
      'queued',
      'running',
      'waiting',
      'cancelling',
      'recovery_required',
    ].includes(activity.status)
  );
}

function isLiveTurn(activity?: TurnActivity): boolean {
  return isOngoingTurn(activity) && !activity?.executionUnconfirmed;
}

function isVisibleTool(message: Message): boolean {
  if (message.role !== 'tool') return false;
  if (message.presentationOwner) return false;
  if (message.presentation !== 'hidden') return true;
  return (
    message.status === 'failed' ||
    message.status === 'rejected' ||
    message.status === 'cancelled' ||
    message.status === 'unknown'
  );
}

function formatTurnElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days) return `${days} 天 ${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  if (hours) return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  if (minutes) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function turnElapsedMilliseconds(startedAtMs?: number, endedAtMs?: number): number | undefined {
  if (
    startedAtMs === undefined ||
    endedAtMs === undefined ||
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(endedAtMs) ||
    endedAtMs < startedAtMs
  )
    return undefined;
  return endedAtMs - startedAtMs;
}

const runningTurnLabel = '进行中';

function RunningTurnStatus({ startedAtMs }: { startedAtMs?: number }) {
  const { readActive } = useConversationActivity();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!readActive || startedAtMs === undefined || !Number.isFinite(startedAtMs)) return;
    let timeout: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const elapsed = Math.max(0, current - startedAtMs);
      timeout = setTimeout(tick, 1000 - (elapsed % 1000));
    };
    tick();
    return () => clearTimeout(timeout);
  }, [readActive, startedAtMs]);
  const elapsed = turnElapsedMilliseconds(startedAtMs, Math.max(now, startedAtMs ?? now));
  return (
    <span className="agent-turn-status-label agent-turn-running">
      <span role="status">{runningTurnLabel}</span>
      {elapsed !== undefined && ` ${formatTurnElapsed(elapsed + 1000)}`}
    </span>
  );
}

function TurnElapsed({
  startedAtMs,
  finishedAtMs,
  prefix,
}: {
  startedAtMs?: number;
  finishedAtMs?: number;
  prefix: string;
}) {
  const elapsed = turnElapsedMilliseconds(startedAtMs, finishedAtMs);
  if (elapsed === undefined) return null;
  return (
    <span>
      {prefix}
      {formatTurnElapsed(elapsed)}
    </span>
  );
}

function TurnSummary({
  label,
  open,
  readOnly,
  contentIds,
  children,
}: {
  label: string;
  open: boolean;
  readOnly?: boolean;
  contentIds?: string;
  children: ReactNode;
}) {
  return (
    <div className="agent-turn-summary-row">
      <CollapsibleTrigger asChild>
        <Button
          className="agent-turn-summary"
          variant="ghost"
          readOnly={readOnly}
          aria-label={`${label}，${open ? '收起' : '展开'}本轮处理过程`}
          {...(contentIds ? { 'aria-controls': contentIds } : {})}
        >
          {children}
          <TraceIcon className="agent-turn-chevron" data-icon="inline-end">
            <HugeiconsIcon icon={ArrowDown01Icon} />
          </TraceIcon>
        </Button>
      </CollapsibleTrigger>
    </div>
  );
}

function latestReplyStore() {
  let current: string | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next: string | undefined) {
      if (next === current) return;
      current = next;
      for (const notify of listeners) notify();
    },
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
}

const LatestReplyContext = createContext<ReturnType<typeof latestReplyStore> | undefined>(
  undefined,
);
const noReplySubscription = () => () => {};

function MessageMetadata({ replyId, children }: { replyId?: string; children: ReactNode }) {
  const latestReply = useContext(LatestReplyContext);
  const defaultVisible = () => !!replyId && replyId === latestReply?.get();
  const visible = useSyncExternalStore(
    replyId && latestReply ? latestReply.subscribe : noReplySubscription,
    defaultVisible,
    defaultVisible,
  );
  return (
    <footer className="message-meta" data-default-visible={visible || undefined}>
      {children}
    </footer>
  );
}

const MessageItem = memo(function MessageItem({
  message,
  expanded,
  onToggle,
  openFile,
  copyText,
  copyRole,
  writeClipboardText,
  showProcess = true,
  inlineProcess = false,
  childTools = [],
  expandedItems = {},
  restoredExpanded,
  childDetail,
  renderContent,
  renderAttachments,
  showMetadata = true,
  latestReplyCandidate = false,
  turnOutputs,
  synchronizeTurnOutputs = false,
}: {
  message: Message;
  expanded?: boolean;
  showProcess?: boolean;
  inlineProcess?: boolean;
  childTools?: readonly Message[];
  expandedItems?: Record<string, boolean>;
  restoredExpanded?: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  openFile?: (path: string) => void;
  copyText?: string;
  copyRole?: MessageCopyRole;
  writeClipboardText?: (text: string) => Promise<void>;
  childDetail?: { readonly label: string; readonly onOpen: () => void };
  renderContent?: (message: Message) => ReactNode;
  renderAttachments?: (message: Message) => ReactNode;
  showMetadata?: boolean;
  latestReplyCandidate?: boolean;
  turnOutputs?: ReactNode;
  synchronizeTurnOutputs?: boolean;
}) {
  const [metadataNow, setMetadataNow] = useState(() => Date.now());
  // The first saved snapshot can coordinate with outputs. New replies never wait here.
  const [awaitInitialOutputs, setAwaitInitialOutputs] = useState(
    synchronizeTurnOutputs && message.finalReply === true && !!turnOutputs,
  );
  const releaseInitialOutputs = useCallback(() => setAwaitInitialOutputs(false), []);
  useLayoutEffect(() => {
    if (awaitInitialOutputs && !turnOutputs) releaseInitialOutputs();
  }, [awaitInitialOutputs, releaseInitialOutputs, turnOutputs]);
  // Raw model reasoning is never part of the readable transcript.
  if (message.role === 'thinking') return null;
  if (message.role === 'tool') return null;
  if (message.role === 'subagent') {
    if (!showProcess) return null;
    const taskId = message.id.startsWith('subagent:')
      ? message.id.slice('subagent:'.length)
      : message.id;
    const childEnded =
      message.settled &&
      ['completed', 'failed', 'interrupted', 'cancelled'].includes(message.status ?? '');
    const steps = (message.steps ?? []).map((step) => {
      const id = `subagent-step:${step.id}`;
      const unresolved = childEnded && step.status === 'started';
      return (
        <ToolActivity
          key={id}
          childProcess
          messages={[
            {
              id,
              role: 'tool',
              toolName: step.toolName,
              title: step.text,
              arguments: step.arguments,
              text: step.summary ?? '',
              settled: unresolved || step.status !== 'started',
              status: unresolved ? 'unknown' : step.status === 'started' ? 'running' : step.status,
            },
          ]}
          expanded={expandedItems[id]}
          activityId={id}
          restoredExpanded={restoredExpanded}
          onToggle={(open) => onToggle(id, open)}
          openFile={openFile}
          renderChildren={() => null}
        />
      );
    });
    const tools = childTools.map((tool) => (
      <ToolActivity
        key={tool.id}
        childProcess
        messages={[
          childEnded &&
          !tool.settled &&
          ['creating', 'queued', 'running', 'waiting', 'auto_checking', 'auto_reviewing'].includes(
            tool.status ?? '',
          )
            ? { ...tool, settled: true, status: 'unknown' }
            : tool,
        ]}
        expanded={expandedItems[tool.id]}
        activityId={tool.id}
        restoredExpanded={restoredExpanded}
        onToggle={(open) => onToggle(tool.id, open)}
        openFile={openFile}
        renderChildren={() => null}
      />
    ));
    const process = (
      <ScrollArea
        key={message.id}
        className="subagent-process"
        fade="y"
        chainScroll
        viewportClassName="subagent-process-viewport"
        viewportProps={{
          role: 'region',
          tabIndex: 0,
          'aria-label': `${message.title || '子 Agent'}的工具步骤`,
        }}
      >
        {steps}
        {tools}
      </ScrollArea>
    );
    // Child prose/results belong to the task result; the parent transcript shows tool activity only.
    if (inlineProcess) return process;
    return (
      <ToolActivity
        messages={[
          {
            ...message,
            role: 'tool',
            toolName: 'task',
            title: '运行子 Agent',
            arguments: { name: message.title, task_id: taskId },
            text: '',
          },
        ]}
        expanded={expanded}
        activityId={message.id}
        restoredExpanded={restoredExpanded}
        onToggle={(open) => onToggle(message.id, open)}
        openFile={openFile}
        childDetail={childDetail}
        renderChildren={() => process}
      />
    );
  }
  if (message.systemKind === 'model_connection')
    return (
      <ModelConnection
        message={message}
        expanded={expanded}
        onToggle={(open) => onToggle(message.id, open)}
        restoredExpanded={restoredExpanded?.has(message.id)}
      />
    );
  if (message.systemKind === 'compaction')
    return (
      <article className={`message context-compacted ${message.status ?? ''}`}>
        <TraceLine
          className="conversation-trace-line"
          status={
            message.status === 'running'
              ? 'running'
              : message.status === 'failed'
                ? 'error'
                : undefined
          }
          role="status"
        >
          <TraceIcon>
            <HugeiconsIcon icon={ReduceParagraphIcon} />
          </TraceIcon>
          <TraceTitle>{message.title}</TraceTitle>
        </TraceLine>
        {message.status === 'failed' && message.text && <p>{message.text}</p>}
      </article>
    );
  if (message.systemKind === 'ask')
    return (
      <ToolActivity
        messages={[
          {
            ...message,
            role: 'tool',
            toolName: 'ask_user',
            status: message.status ?? (message.settled ? 'completed' : 'waiting'),
          },
        ]}
        expanded={expanded}
        activityId={message.id}
        restoredExpanded={restoredExpanded}
        onToggle={(open) => onToggle(message.id, open)}
        renderChildren={() => null}
      />
    );
  if (isTurnFailure(message))
    return (
      <TurnFailure
        message={message}
        expanded={expanded}
        onToggle={(open) => onToggle(message.id, open)}
        restoredExpanded={restoredExpanded?.has(message.id)}
      />
    );
  const agentResult = message.systemKind === 'agent_result' ? message.agentResult : undefined;
  const agentMessage = message.systemKind === 'agent_message' ? message.agentMessage : undefined;
  const agentSource = agentResult ?? agentMessage;
  if (message.role === 'system' && !agentSource)
    return (
      <article className={`message system ${message.status ?? ''}`}>
        <p>
          {message.title}
          {message.status && <span className="message-status">{statusLabel(message.status)}</span>}
        </p>
        {message.text && <pre>{message.text}</pre>}
      </article>
    );
  const hasMetadata = showMetadata && (message.role !== 'assistant' || message.settled);
  const timestamp = hasMetadata ? formatMessageTime(message.createdAtMs, metadataNow) : undefined;
  return (
    <article
      className={cn(
        'message',
        agentResult ? 'agent-result' : agentMessage ? 'agent-message' : message.role,
        message.delivery,
        {
          responding: message.role === 'assistant' && !message.settled,
        },
      )}
      data-final-reply={message.role === 'assistant' ? Boolean(message.finalReply) : undefined}
      onPointerEnter={hasMetadata ? () => setMetadataNow(Date.now()) : undefined}
      onFocus={hasMetadata ? () => setMetadataNow(Date.now()) : undefined}
      data-agent-result-source={agentResult?.sourceId}
      data-agent-message-id={agentMessage?.messageId}
      data-input-kind={message.inputKind}
      data-message-id={message.id}
      aria-label={
        agentSource
          ? `${agentSource.name} Agent 发送的消息`
          : message.role === 'user'
            ? '用户消息'
            : '助手消息'
      }
    >
      {message.role === 'user' && !agentSource && renderAttachments?.(message)}
      <CodeCopyEligibilityContext.Provider value={Boolean(copyText)}>
        {message.role === 'user' || agentSource ? (
          <div className="user-message-body">
            {agentSource && (
              <p className="message-label">
                {agentSource.name} Agent 发送
                {agentResult && agentResult.outcome !== 'succeeded' && (
                  <span className="message-status">
                    {
                      {
                        failed: '失败',
                        cancelled: '已取消',
                        outcome_unknown: '结果未知',
                      }[agentResult.outcome]
                    }
                  </span>
                )}
              </p>
            )}
            {renderContent ? (
              renderContent(message)
            ) : agentSource ? (
              message.text && <MessageContent text={message.text} openFile={openFile} />
            ) : (
              <>
                {message.text && <PromptMarkdown text={message.text} openFile={openFile} />}
                {message.delivery && (
                  <small
                    className="delivery-status"
                    role={message.delivery === 'sending' ? 'status' : 'alert'}
                  >
                    {message.delivery === 'sending'
                      ? '正在发送…'
                      : message.delivery === 'failed'
                        ? '发送失败，可在输入框中重试'
                        : '发送结果待确认，请检查会话状态'}
                  </small>
                )}
              </>
            )}
            {agentSource && !agentSource.contentComplete && (
              <p role="status">
                {agentResult ? '消息正文未完整展示。' : '消息正文暂不可完整读取。'}
              </p>
            )}
          </div>
        ) : renderContent ? (
          renderContent(message)
        ) : message.role === 'assistant' ? (
          message.text && (
            <MessageContent text={message.text} openFile={openFile} streaming={!message.settled} />
          )
        ) : (
          <>
            <p className="user-text">{message.text}</p>
            {message.delivery && (
              <small
                className="delivery-status"
                role={message.delivery === 'sending' ? 'status' : 'alert'}
              >
                {message.delivery === 'sending'
                  ? '正在发送…'
                  : message.delivery === 'failed'
                    ? '发送失败，可在输入框中重试'
                    : '发送结果待确认，请检查会话状态'}
              </small>
            )}
          </>
        )}
      </CodeCopyEligibilityContext.Provider>
      <InitialTurnOutputPresentationContext
        value={awaitInitialOutputs ? releaseInitialOutputs : undefined}
      >
        {turnOutputs}
      </InitialTurnOutputPresentationContext>
      {hasMetadata && (
        <MessageMetadata replyId={latestReplyCandidate ? message.id : undefined}>
          {copyText !== undefined && (
            <MessageCopyButton
              text={copyText}
              copyRole={copyRole}
              writeClipboardText={writeClipboardText}
            />
          )}
          {timestamp ? (
            <time className="message-time" dateTime={timestamp.dateTime} title={timestamp.full}>
              <span aria-hidden="true">{timestamp.label}</span>
              <span className="sr-only">{timestamp.full}</span>
            </time>
          ) : message.pendingSave ? null : (
            <span className="message-time" title="没有可核实的消息记录时间">
              时间未知
            </span>
          )}
        </MessageMetadata>
      )}
    </article>
  );
});

export const InitialTurnOutputPresentationContext = createContext<(() => void) | undefined>(
  undefined,
);

export const ConversationTurnElementContext = createContext<
  RefObject<HTMLDivElement | null> | undefined
>(undefined);

const ConversationTurnEntry = memo(function ConversationTurnEntry({
  children,
  ...props
}: ComponentProps<'div'>) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div {...props} ref={ref}>
      <ConversationTurnElementContext value={ref}>{children}</ConversationTurnElementContext>
    </div>
  );
});

export function Conversation({
  messages: incomingMessages,
  loading: historyLoading,
  initialPresentationPending = false,
  onPresentationReady,
  preserveReadingAnchor = false,
  messageNavigation = false,
  turnActivity: incomingTurnActivity,

  selected,
  connected,
  initialReading,
  saveReading,
  openFile,
  writeClipboardText,
  emptyState,
  childSessionIdsByTaskId,
  onOpenChildSession,
  renderMessage,
  renderMessageContent,
  renderMessageAttachments,
  renderTurnOutputs,
  renderTurnDetails,
  focusMessage,
  renderToolActivity,
  traceTurns = false,
  pendingTraceToolTurns,
  renderReasoning,
  historyEntryFacts,
}: {
  messages: readonly Message[];
  loading: boolean;
  /** First mount waits for host-owned grouping; an already readable tree stays live. */
  initialPresentationPending?: boolean;
  /** The initial readable message tree has committed; this never grants read or write authority. */
  onPresentationReady?: () => void;
  /** Retain the visible message identity when the transcript changes size or resumes. */
  preserveReadingAnchor?: boolean;
  messageNavigation?: boolean;
  turnActivity?: TurnActivity;

  selected: boolean;
  connected: boolean;
  initialReading?: ReadingState;
  saveReading: (state: ReadingState) => void;
  openFile?: (path: string) => void;
  writeClipboardText?: (text: string) => Promise<void>;
  emptyState?: { title: string; detail: string } | null;
  childSessionIdsByTaskId?: ReadonlyMap<string, string>;
  onOpenChildSession?: (childSessionId: string) => void;
  /** Public-body hosts supply their verified content reader without fabricating legacy tool facts. */
  renderMessage?: (message: Message) => ReactNode;
  /** Verified body reader within the original message and copy controls. */
  renderMessageContent?: (message: Message) => ReactNode;
  /** Attachment presentation outside the user text bubble, sharing the same message identity. */
  renderMessageAttachments?: (message: Message) => ReactNode;
  renderTurnOutputs?: (target: {
    turnId: string;
    finalMessageId?: string;
    terminalStatus?: Message['turnTerminalStatus'];
  }) => ReactNode;
  renderTurnDetails?: (target: {
    turnId: string;
    terminalStatus: NonNullable<Message['turnTerminalStatus']>;
  }) => ReactNode;
  focusMessage?: {
    presentationKey: string;
    /** Return false while the host's original message body is still being read. */
    reveal: (element: HTMLElement) => boolean;
    onFocused?: () => void;
  };
  /** Host-adapted tool facts within the original grouping and reading state. */
  renderToolActivity?: (messages: readonly Message[], state: ToolActivityState) => ReactNode;
  /** Native conversation: group consecutive reasoning and tools around public prose. */
  traceTurns?: boolean;
  /** Saved Turns with receipts whose first presentation is still being verified. */
  pendingTraceToolTurns?: ReadonlySet<string>;
  renderReasoning?: (message: Message, open: boolean) => ReactNode;
  /** Exact host facts read by a saved entry's renderers, including read authority and output revisions. */
  historyEntryFacts?: (messages: readonly Message[], turnId?: string) => readonly unknown[];
}) {
  const traceContentId = useId();
  const [latestReply] = useState(latestReplyStore);
  const presented = useRef(false);
  // Keep the first large tree interruptible by a later navigation. Once shown,
  // history and streaming changes always reconcile against the current reading.
  const largeHistory = incomingMessages.length > 100;
  const largeTreeReady = useDeferredValue(
    largeHistory && !initialPresentationPending && !historyLoading,
    false,
  );
  const preparing =
    !presented.current && (initialPresentationPending || (largeHistory && !largeTreeReady));
  useLayoutEffect(() => {
    if (!historyLoading && !preparing) presented.current = true;
  }, [historyLoading, preparing]);
  useLayoutEffect(() => {
    if (!historyLoading && !initialPresentationPending && !preparing) onPresentationReady?.();
  });
  const messages = preparing ? [] : incomingMessages;
  const loading = historyLoading || preparing;
  const turnActivity = preparing ? undefined : incomingTurnActivity;
  const readingActivity = useConversationActivity();
  const diagnostics = useDesktopDiagnostics();
  const previousResume = useRef(readingActivity.resume);
  const viewport = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reading = useRef<ReadingState>(initialReading ?? { top: 0, follow: true, expanded: {} });
  // A manual disclosure may grow later when its body reader finishes.
  const traceDisclosure = useRef(false);
  const writtenScrollTop = useRef<number | undefined>(undefined);
  const markerTargets = useRef<HTMLElement[]>([]);
  const jumpedMarker = useRef<string | undefined>(undefined);
  const [activeMarker, setActiveMarker] = useState<string>();
  const [navigationOverflow, setNavigationOverflow] = useState(false);
  const syncMessageNavigation = useCallback((element: HTMLElement) => {
    if (!markerTargets.current.length) return;
    const overflowing = element.clientHeight > 0 && element.scrollHeight > element.clientHeight;
    setNavigationOverflow(overflowing);
    if (!overflowing) return;
    setActiveMarker(
      jumpedMarker.current ??
        currentConversationMessage(markerTargets.current, element, reading.current.follow),
    );
  }, []);
  const writeScroll = useCallback(
    (element: HTMLElement, top: number) => {
      element.scrollTop = top;
      // Use the browser's clamped value, not scrollHeight. The scroll event may
      // arrive after another chunk has changed that height.
      writtenScrollTop.current = element.scrollTop;
      reading.current.top = element.scrollTop;
      syncMessageNavigation(element);
    },
    [syncMessageNavigation],
  );
  const restoredExpanded = useRef(
    new Set(
      Object.entries(initialReading?.expanded ?? {})
        .filter(([, open]) => open)
        .map(([id]) => id),
    ),
  );
  const restore = useRef(true);
  const [following, setFollowing] = useState(reading.current.follow);
  const [expanded, setExpanded] = useState(reading.current.expanded);
  const committedOpenTurns = useRef<readonly string[]>([]);
  const committedTraceProcesses = useRef<ReadonlyMap<string, boolean>>(new Map());
  const committedEntries = useRef<ReadonlyMap<string, RetainedEntry>>(new Map());
  const messageSignatures = useRef(new WeakMap<Message, string>());
  if (previousResume.current !== readingActivity.resume) {
    previousResume.current = readingActivity.resume;
    traceDisclosure.current = false;
    restore.current = true;
    for (const [id, open] of Object.entries(expanded)) if (open) restoredExpanded.current.add(id);
    // Default-open live processes have no explicit expanded entry. Restore their
    // markers too, invalidating the projection only when a marker was missing.
    for (const id of committedOpenTurns.current) restoredExpanded.current.add(id);
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const document = element.ownerDocument;
    const selectMessages = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'a'
      )
        return;
      const target = event.target instanceof document.defaultView!.Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])'))
        return;
      const hidden = '[hidden], [inert], [aria-hidden="true"]';
      if (element.closest(hidden) || document.querySelector('dialog[open]')) return;
      // Parent history and a child tab can both be visible. Resolve one owner before
      // changing the selection, including when the key event originates on document.
      const visibleConversation = (node: Node | null | undefined) => {
        const parent = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
        const conversation = parent?.closest('.conversation-viewport');
        return conversation && !conversation.closest(hidden) ? conversation : undefined;
      };
      const selection = document.getSelection();
      const owner =
        visibleConversation(target) ??
        visibleConversation(document.activeElement) ??
        visibleConversation(selection?.anchorNode) ??
        [...document.querySelectorAll('.conversation-viewport')].find(
          (conversation) => !conversation.closest(hidden),
        );
      if (owner !== element) return;
      const column = element.querySelector('.reading-column');
      if (!column || !selection) return;
      event.preventDefault();
      const walker = document.createTreeWalker(column, 4 /* SHOW_TEXT */);
      let first: Text | undefined;
      let last: Text | undefined;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (
          !node.textContent?.trim() ||
          !parent?.closest('.message') ||
          parent.closest(
            'button, summary, .message-label, .message-status, .message-meta, .message-attachments-navigation, [hidden], details:not([open])',
          )
        )
          continue;
        first ??= node as Text;
        last = node as Text;
      }
      selection.removeAllRanges();
      if (!first || !last) return;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.length);
      selection.addRange(range);
    };
    document.addEventListener('keydown', selectMessages);
    return () => document.removeEventListener('keydown', selectMessages);
  }, []);
  const save = useRef(saveReading);
  save.current = saveReading;
  reading.current.expanded = expanded;
  const currentMessages = useRef<readonly Message[] | undefined>(loading ? undefined : messages);
  if (!loading) currentMessages.current = messages;
  const currentTurn = useRef(turnActivity?.turnId);
  currentTurn.current = turnActivity?.turnId;
  useLayoutEffect(
    () => () => {
      restore.current = true;
      save.current(
        currentMessages.current
          ? pruneReadingState(reading.current, currentMessages.current, currentTurn.current)
          : reading.current,
      );
    },
    [],
  );
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || loading || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // Child-local body reads and collapse animations do not commit Conversation.
      // ResizeObserver runs before paint; delaying this write exposes the old tail for a frame.
      if (
        traceDisclosure.current &&
        reading.current.follow &&
        element.scrollHeight - element.clientHeight - element.scrollTop > 1
      ) {
        traceDisclosure.current = false;
        reading.current.follow = false;
        reading.current.top = element.scrollTop;
        reading.current.anchor = preserveReadingAnchor
          ? captureConversationScrollAnchor(element)
          : undefined;
        setFollowing(false);
      }
      if (reading.current.follow) writeScroll(element, element.scrollHeight);
      else if (
        preserveReadingAnchor &&
        reading.current.anchor &&
        restoreConversationScrollAnchor(element, reading.current.anchor)
      )
        writeScroll(element, element.scrollTop);
      else syncMessageNavigation(element);
    });
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [loading, writeScroll, preserveReadingAnchor, syncMessageNavigation]);
  // Restore identity/window handoffs synchronously. Ordinary content geometry is
  // followed by ResizeObserver before paint, after layout has already completed.
  // Reading scrollHeight on every metadata commit would force that layout early.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || loading) {
      restore.current = true;
      return;
    }
    if (reading.current.follow) {
      if (restore.current || typeof ResizeObserver === 'undefined')
        writeScroll(element, element.scrollHeight);
    } else if (
      preserveReadingAnchor &&
      reading.current.anchor &&
      restoreConversationScrollAnchor(element, reading.current.anchor)
    ) {
      writeScroll(element, element.scrollTop);
    } else if (restore.current) writeScroll(element, reading.current.top);
    restore.current = false;
    if (preserveReadingAnchor && !reading.current.follow && !jumpedMarker.current)
      reading.current.anchor = captureConversationScrollAnchor(element) ?? reading.current.anchor;
  });
  const onToggle = useRef((id: string, open: boolean) => {
    restoredExpanded.current.delete(id);
    setExpanded((values) => (values[id] === open ? values : { ...values, [id]: open }));
  }).current;
  const onTraceToggle = useRef((id: string, open: boolean) => {
    traceDisclosure.current = open && reading.current.follow;
    onToggle(id, open);
  }).current;
  const restoredMarkerSignature = JSON.stringify([...restoredExpanded.current].sort());
  // biome-ignore lint/correctness/useExhaustiveDependencies: Marker ref contents and the loading-driven restore lifecycle both invalidate the retained projection.
  const projection = useMemo(() => {
    const initializingConversation = !presented.current && !loading;
    const visibleToolIds = new Set(
      messages.filter(isVisibleTool).map((message) => message.id.slice(5)),
    );
    const allToolIds = new Set(
      messages.filter((message) => message.role === 'tool').map((message) => message.id.slice(5)),
    );
    const children = new Map<string, Message[]>();
    const childTools = new Map<string, Message[]>();
    for (const message of messages) {
      if (message.role !== 'tool' || !message.presentationOwner) continue;
      const owner = message.presentationOwner.subagentId;
      const group = childTools.get(owner);
      if (group) group.push(message);
      else childTools.set(owner, [message]);
    }
    const childWithUniqueSteps = (child: Message): Message => {
      if (child.role !== 'subagent') return child;
      const toolIds = new Set(childTools.get(child.id.slice(9))?.map((tool) => tool.id));
      return {
        ...child,
        steps: child.steps?.filter(
          (step) => !step.toolCallId || !toolIds.has(`tool:${step.toolCallId}`),
        ),
      };
    };
    for (const message of messages) {
      if (
        message.role !== 'subagent' ||
        !message.parentToolCallId ||
        !allToolIds.has(message.parentToolCallId)
      )
        continue;
      const group = children.get(message.parentToolCallId) ?? [];
      group.push(message);
      children.set(message.parentToolCallId, group);
    }
    const childDetail = (child: Message) => {
      if (child.role !== 'subagent' || !child.id.startsWith('subagent:')) return undefined;
      const childSessionId = childSessionIdsByTaskId?.get(child.id.slice('subagent:'.length));
      if (!childSessionId || !onOpenChildSession) return undefined;
      return {
        label: child.title || '子 Agent',
        onOpen: () => onOpenChildSession(childSessionId),
      };
    };
    const parentTaskDetail = (message: Message, groupSize: number) => {
      if (message.toolName !== 'task' || groupSize !== 1) return undefined;
      const candidates = children.get(message.id.slice(5));
      return candidates?.length === 1 ? childDetail(candidates[0]!) : undefined;
    };
    const askToolIds = new Set(
      messages
        .filter((message) => message.systemKind === 'ask')
        .map((message) => message.ask?.toolCallId)
        .filter(Boolean),
    );
    const structural = (message: Message) =>
      (message.role === 'thinking' && !traceTurns) ||
      message.systemKind === 'turn_timing' ||
      message.systemKind === 'turn_terminal';
    const visible = new Set(
      messages.filter((message) => {
        if (structural(message)) return false;
        if (message.role !== 'tool' && message.presentation === 'hidden') return false;
        if (message.role === 'thinking') return !!message.turnId;
        if (renderMessage) return true;
        if (message.role === 'tool' && askToolIds.has(message.id.slice(5))) return false;
        if (message.role === 'system')
          return message.systemKind === 'ask' || message.settled || !!message.status;
        if (message.role === 'tool') return isVisibleTool(message);
        if (message.role === 'subagent')
          return !message.parentToolCallId || !visibleToolIds.has(message.parentToolCallId);
        return (
          !message.settled ||
          !!message.text ||
          (message.role === 'user' && !!message.hasAttachments)
        );
      }),
    );
    const visibleTurns = new Set([...visible].map(processTurnId).filter(Boolean));
    const anchors = new Map<string, Message>();
    const turnBySubmission = new Map<string, string>();
    if (turnActivity?.presentationKey)
      turnBySubmission.set(turnActivity.presentationKey, turnActivity.turnId);
    for (const message of messages) {
      if (message.systemKind === 'turn_timing' && message.turnId && message.presentationKey)
        turnBySubmission.set(message.presentationKey, message.turnId);
      if (structural(message) && message.turnId && !anchors.has(message.turnId))
        anchors.set(message.turnId, message);
    }
    if (turnActivity && !anchors.has(turnActivity.turnId))
      anchors.set(turnActivity.turnId, {
        id: `activity-anchor:${turnActivity.turnId}`,
        turnId: turnActivity.turnId,
        role: 'system',
        systemKind: 'turn_timing',
        text: '',
        settled: ['completed', 'failed', 'cancelled'].includes(turnActivity.status),
      });
    // A pending original may have only its submission ID when the Run timing
    // arrives. Reserve the structural row for that exact input, not a neighbor.
    const inputTurn = (message: Message) =>
      message.role === 'user' && !message.inputKind
        ? (message.turnId ?? turnBySubmission.get(message.presentationKey ?? message.id))
        : undefined;
    const inputTurns = new Set([...visible].map(inputTurn).filter(Boolean));
    const anchoredTurns = new Set<string>();
    // A hidden-only Turn still needs its status in chronological position. Keep
    // one structural anchor only when no readable message already owns that Turn;
    // hidden reasoning must not split otherwise contiguous exploration tools.
    const shown: Message[] = [];
    for (const message of messages) {
      if (visible.has(message)) {
        shown.push(message);
        const turn = inputTurn(message);
        const anchor = turn && anchors.get(turn);
        if (turn && anchor && !visibleTurns.has(turn) && !anchoredTurns.has(turn)) {
          anchoredTurns.add(turn);
          shown.push(anchor);
        }
      } else if (
        structural(message) &&
        message.turnId &&
        !inputTurns.has(message.turnId) &&
        !visibleTurns.has(message.turnId) &&
        !anchoredTurns.has(message.turnId)
      ) {
        anchoredTurns.add(message.turnId);
        shown.push(message);
      }
    }
    const runningToolTurns = new Set<string>();
    const thinkingTurns = new Set<string>();
    for (const message of messages) {
      if (!message.turnId) continue;
      // An earlier interrupted Model prefix does not own the current attempt's
      // phase. Ordered model messages supersede that Turn's older thought marker.
      if (message.role === 'assistant' || message.role === 'thinking') {
        if (message.role === 'thinking' && !message.settled) thinkingTurns.add(message.turnId);
        else thinkingTurns.delete(message.turnId);
      }
      if (message.settled) continue;
      if (message.role === 'tool') runningToolTurns.add(message.turnId);
    }
    const finalReplyByTurn = new Map<string, Message>();
    let latestFinalReply: Message | undefined;
    const timingByTurn = new Map(
      messages
        .filter((message) => message.systemKind === 'turn_timing' && message.turnId)
        .map((message) => [message.turnId!, message]),
    );
    const turnEntryKey = (turnId: string) => {
      const submission =
        timingByTurn.get(turnId)?.presentationKey ??
        (turnActivity?.turnId === turnId ? turnActivity.presentationKey : undefined);
      return submission ? `turn:submission:${JSON.stringify(submission)}` : `turn:${turnId}`;
    };
    const terminalByTurn = new Map(
      messages
        .filter((message) => message.systemKind === 'turn_terminal' && message.turnId)
        .map((message) => [message.turnId!, message.turnTerminalStatus]),
    );
    for (const message of shown) {
      if (
        message.role === 'assistant' &&
        message.turnId &&
        message.settled &&
        message.finalReply &&
        message.text
      ) {
        finalReplyByTurn.set(message.turnId, message);
        latestFinalReply = message;
      }
    }
    const assistantTurnCopies = new Map(
      [...finalReplyByTurn.values()].map((message) => [
        message.id,
        message.copyText === null ? '' : (message.copyText ?? message.text),
      ]),
    );
    // Contiguous tools share one activity regardless of definition or result
    // metadata. A readable message or different Turn starts another activity.
    const groups: Message[][] = [];
    for (const message of shown) {
      const previous = groups.at(-1);
      const first = previous?.[0];
      if (
        !renderMessage &&
        message.role === 'tool' &&
        first?.role === 'tool' &&
        first.turnId === message.turnId &&
        (!traceTurns ||
          (renderToolActivity &&
            message.turnId &&
            !first.tracePending &&
            !message.tracePending &&
            first.toolName === 'spawn_agent' &&
            message.toolName === 'spawn_agent'))
      )
        previous!.push(message);
      else groups.push([message]);
    }
    // Exact Turn identities bound a process. Unscoped non-user messages between
    // two parts of that same Turn stay in their original order inside it.
    const entries: { key: string; turnId?: string; groups: Message[][] }[] = [];
    const seenTurnIds = new Set<string>();
    const unscoped: Message[][] = [];
    const flushUnscoped = () => {
      for (const group of unscoped)
        entries.push({ key: group[0]!.presentationKey ?? group[0]!.id, groups: [group] });
      unscoped.length = 0;
    };
    for (const group of groups) {
      const message = group[0]!;
      // Documents and child results stay visible when the elapsed process folds.
      if (
        message.systemKind === 'agent_result' ||
        (traceTurns && message.toolName === 'planning.review')
      ) {
        flushUnscoped();
        entries.push({ key: message.presentationKey ?? message.id, groups: [group] });
        continue;
      }
      const turnId = processTurnId(message);
      if (!turnId && message.role !== 'user') {
        unscoped.push(group);
        continue;
      }
      const previous = entries.at(-1);
      if (turnId && previous?.turnId === turnId) {
        previous.groups.push(...unscoped, group);
        unscoped.length = 0;
        continue;
      }
      flushUnscoped();
      entries.push({
        key: turnId
          ? seenTurnIds.has(turnId)
            ? `${turnEntryKey(turnId)}:after:${message.presentationKey ?? message.id}`
            : turnEntryKey(turnId)
          : (message.presentationKey ?? message.id),
        turnId,
        groups: [group],
      });
      if (turnId) seenTurnIds.add(turnId);
    }
    flushUnscoped();
    if (
      turnActivity &&
      (isOngoingTurn(turnActivity) || turnActivity.status === 'cancelled') &&
      !seenTurnIds.has(turnActivity.turnId)
    ) {
      entries.push({
        key: turnEntryKey(turnActivity.turnId),
        turnId: turnActivity.turnId,
        groups: [],
      });
    }
    const lastEntryByTurn = new Map(
      entries.filter((entry) => entry.turnId).map((entry) => [entry.turnId, entry]),
    );
    const renderGroup = (
      group: Message[],
      placement: 'standalone' | 'process' | 'result' | 'trace' = 'standalone',
      {
        directTraceDetails = false,
        traceSummaryTitle,
        parentDisclosureOpen = true,
        turnOutputs,
      }: {
        directTraceDetails?: boolean;
        traceSummaryTitle?: string;
        parentDisclosureOpen?: boolean;
        turnOutputs?: ReactNode;
      } = {},
    ) => {
      const message = group[0]!;
      if (structural(message)) return null;
      const agentResult = message.systemKind === 'agent_result' ? message.agentResult : undefined;
      if (renderMessage)
        return (
          <div key={message.presentationKey ?? message.id} className="message-group">
            <article className={`message ${message.role}`} aria-label={`${message.role} 消息`}>
              {renderMessage(message)}
              {turnOutputs}
            </article>
          </div>
        );
      // A host-provided group starts with its first tool, before metadata arrives.
      // Its disclosure and DOM survive subsequent receipts and additional tools.
      const inTrace = placement === 'trace';
      const aggregate =
        !inTrace &&
        (group.length > 1 ||
          (!!message.presentationGroupId && !(traceTurns && isStandaloneTraceTool(message))));
      const activityKey = aggregate
        ? `activity-group:${message.presentationGroupId ?? message.presentationKey ?? message.id}`
        : `activity:${message.presentationKey ?? message.id}`;
      const toggle = (open: boolean) => (inTrace ? onTraceToggle : onToggle)(activityKey, open);
      if (message.role === 'tool' && renderToolActivity)
        return (
          <Fragment key={activityKey}>
            {renderToolActivity(group, {
              aggregate,
              expanded: expanded[activityKey],
              inTrace,
              directTraceDetails,
              traceSummaryTitle,
              parentDisclosureOpen,
              activityId: activityKey,
              restoredExpanded: restoredExpanded.current,
              expandedItems: expanded,
              onToggle: toggle,
              onToggleItem: inTrace ? onTraceToggle : onToggle,
            })}
          </Fragment>
        );
      return message.role === 'tool' ? (
        <ToolActivity
          key={activityKey}
          messages={group}
          aggregate={aggregate}
          inTrace={inTrace}
          directTraceDetails={directTraceDetails}
          traceSummaryTitle={traceSummaryTitle}
          parentDisclosureOpen={parentDisclosureOpen}
          suppressGenericFailure={
            message.toolName === 'task' &&
            (children.get(message.id.slice(5)) ?? []).some(
              (child) =>
                child.role === 'subagent' &&
                ['failed', 'interrupted', 'cancelled'].includes(child.status ?? '') &&
                !!child.text?.trim(),
            )
          }
          expanded={expanded[activityKey]}
          activityId={activityKey}
          restoredExpanded={restoredExpanded.current}
          expandedItems={expanded}
          onToggleItem={onToggle}
          onToggle={toggle}
          openFile={openFile}
          childDetail={parentTaskDetail(message, group.length)}
          childDetailForMessage={(item) => parentTaskDetail(item, 1)}
          renderChildren={(toolCallId, taskExpanded) =>
            children
              .get(toolCallId)
              ?.map((child) =>
                child.role === 'subagent' ? (
                  <MessageItem
                    key={child.id}
                    message={childWithUniqueSteps(child)}
                    inlineProcess
                    childTools={childTools.get(child.id.slice(9))}
                    expandedItems={expanded}
                    restoredExpanded={restoredExpanded.current}
                    expanded={expanded[child.id]}
                    showProcess={taskExpanded}
                    onToggle={onToggle}
                    openFile={openFile}
                  />
                ) : null,
              )
          }
        />
      ) : (
        <div key={message.presentationKey ?? message.id} className="message-group">
          <MessageItem
            turnOutputs={turnOutputs}
            synchronizeTurnOutputs={initializingConversation}
            message={childWithUniqueSteps(message)}
            childDetail={childDetail(message)}
            childTools={
              message.role === 'subagent' ? childTools.get(message.id.slice(9)) : undefined
            }
            expandedItems={expanded}
            restoredExpanded={restoredExpanded.current}
            expanded={expanded[message.id]}
            onToggle={onToggle}
            openFile={openFile}
            writeClipboardText={writeClipboardText}
            renderContent={renderMessageContent}
            renderAttachments={renderMessageAttachments}
            showMetadata={placement !== 'process' || message.role === 'user'}
            latestReplyCandidate={placement === 'result' && message.finalReply === true}
            copyText={
              agentResult?.contentComplete && placement === 'standalone'
                ? (message.copyText ?? undefined)
                : message.role === 'user' && message.settled && !message.delivery && message.text
                  ? message.copyText === null
                    ? undefined
                    : (message.copyText ?? message.text)
                  : assistantTurnCopies.get(message.id)
            }
            copyRole={agentResult ? 'agent_result' : message.role === 'user' ? 'user' : 'assistant'}
          />
        </div>
      );
    };
    const renderEntry = (
      entry: (typeof entries)[number],
      openTurns: string[],
      traceProcesses: Map<string, boolean>,
    ) => {
      if (!entry.turnId)
        return (
          <Fragment key={entry.key}>{entry.groups.map((group) => renderGroup(group))}</Fragment>
        );
      const finalGroup = entry.groups.find(
        ([message]) => message?.id === finalReplyByTurn.get(entry.turnId!)?.id,
      );
      const failureGroups = entry.groups.filter(([message]) => !!message && isTurnFailure(message));
      const processGroups = entry.groups.filter(
        (group) => group !== finalGroup && !structural(group[0]!),
      );
      const activity = turnActivity?.turnId === entry.turnId ? turnActivity : undefined;
      const timing = timingByTurn.get(entry.turnId);
      const terminalStatus = terminalByTurn.get(entry.turnId);
      const active =
        !terminalStatus &&
        (activity && !activity.unavailable
          ? isLiveTurn(activity)
          : !turnActivity &&
            entry.groups.some((group) => group.some((message) => !message.settled)));
      // A model/tool receipt does not end its owning Turn. A temporarily
      // unavailable activity still retains its last known unfinished lifecycle.
      const ongoing =
        !terminalStatus && failureGroups.length === 0 && (isOngoingTurn(activity) || active);
      const failed = terminalStatus
        ? terminalStatus === 'failed'
        : activity?.status === 'failed' || failureGroups.length > 0;
      const cancelled = terminalStatus
        ? terminalStatus === 'cancelled'
        : activity?.status === 'cancelled' ||
          processGroups.some((group) =>
            group.some((message) => message.role === 'assistant' && message.status === 'cancelled'),
          );
      const aborted = terminalStatus === 'aborted';
      const runningTool = runningToolTurns.has(entry.turnId);
      const waitingForContent = processGroups.length === 0;
      const preparationLabel =
        activity?.status === 'creating_session'
          ? '正在创建会话…'
          : activity?.status === 'preparing'
            ? '正在准备回复…'
            : undefined;
      const thinking =
        thinkingTurns.has(entry.turnId) ||
        (waitingForContent && activity?.responsePhase === 'thinking');
      const completed =
        !failed &&
        !cancelled &&
        !aborted &&
        ((!!finalGroup && !ongoing) ||
          terminalStatus === 'completed' ||
          activity?.status === 'completed');
      // The Run owns response activity across model/tool/approval phases. A
      // temporary observation failure is not a terminal fact. Only the last
      // entry for an exact Turn carries its indicator, outside process collapse.
      const lastTurnEntry = entry === lastEntryByTurn.get(entry.turnId);
      const responding =
        lastTurnEntry &&
        !terminalStatus &&
        !processGroups.some((group) =>
          group.some((message) => message.systemKind === 'model_connection' && !message.settled),
        ) &&
        (activity
          ? isLiveTurn(activity)
          : active && !completed && !failed && !cancelled && !aborted);
      const ended = completed || failed || cancelled || aborted;
      const finishedDuration =
        lastTurnEntry && ended
          ? turnElapsedMilliseconds(timing?.turnStartedAtMs, timing?.turnFinishedAtMs)
          : undefined;
      const finishedLabel =
        finishedDuration === undefined ? '用时未知' : `用时 ${formatTurnElapsed(finishedDuration)}`;
      // The Run can end before its final saved reply replaces the live body.
      const lastProcessMessage = processGroups.at(-1)?.[0];
      const retainingReply =
        completed &&
        !finalReplyByTurn.has(entry.turnId) &&
        lastProcessMessage?.role === 'assistant' &&
        !lastProcessMessage.settled;
      const incompleteFailure = (failed || aborted) && !finalReplyByTurn.has(entry.turnId);
      const trackOpen = (id: string) => {
        openTurns.push(id);
        if (restore.current) restoredExpanded.current.add(id);
      };
      const turnOutputs =
        ((finalGroup && finalGroup[0]?.id === finalReplyByTurn.get(entry.turnId)?.id) ||
          (!finalReplyByTurn.has(entry.turnId) &&
            lastTurnEntry &&
            (ended || failureGroups.length > 0))) &&
        renderTurnOutputs?.({
          turnId: entry.turnId,
          finalMessageId: finalGroup?.[0]?.id,
          terminalStatus,
        });
      if (traceTurns) {
        const messages = processGroups.flat();
        const lastMessage = messages.at(-1);
        const showElapsed = lastTurnEntry && ended;
        const showRunning =
          lastTurnEntry &&
          !ended &&
          activity?.status === 'running' &&
          !activity.executionUnconfirmed &&
          (!activity.unavailable || timing?.turnStartedAtMs !== undefined);
        // Keep the trailing live body and its saved final reply under the same
        // keyed parent, outside the process disclosure.
        const reply =
          finalGroup?.[0] ??
          ((!showElapsed || completed) && lastMessage?.role === 'assistant'
            ? lastMessage
            : undefined);
        const blocks: Message[][] = [];
        for (const group of processGroups) {
          const message = group[0]!;
          const previous = blocks.at(-1);
          if (
            isConversationTraceStep(message) &&
            previous?.[0] &&
            isConversationTraceStep(previous[0])
          )
            previous.push(...group);
          else if (!message.tracePending) blocks.push([...group]);
        }
        const segments: { start: number; blocks: Message[][]; collapsible: boolean }[] = [];
        for (const [index, block] of blocks.entries()) {
          const collapsible = block[0]!.role !== 'assistant';
          const previous = segments.at(-1);
          if (collapsible && previous?.collapsible) previous.blocks.push(block);
          else segments.push({ start: index, blocks: [block], collapsible });
        }
        const waitingLabel = lastTurnEntry
          ? failed && !failureGroups.length
            ? '本轮异常结束'
            : aborted && !failureGroups.length
              ? '本轮执行已中断'
              : cancelled
                ? '你已停止'
                : activity?.status === 'recovery_required'
                  ? '需要恢复'
                  : activity?.status === 'cancelling'
                    ? '正在停止'
                    : activity?.status === 'queued'
                      ? '等待处理'
                      : activity?.status === 'waiting' &&
                          !activity.executionUnconfirmed &&
                          !runningTool
                        ? '正在等待'
                        : !reply &&
                            blocks.length === 0 &&
                            !activity?.executionUnconfirmed &&
                            !activity?.unavailable
                          ? preparationLabel
                          : undefined
          : undefined;
        const turnKey = `turn:${entry.turnId}:complete`;
        const hasProcess =
          lastTurnEntry &&
          (showElapsed || ongoing) &&
          segments.some((segment) => segment.collapsible);
        const open =
          expanded[turnKey] ??
          committedTraceProcesses.current.get(turnKey) ??
          (ongoing || incompleteFailure);
        if (lastTurnEntry && (ongoing || showElapsed)) traceProcesses.set(turnKey, open);
        if (lastTurnEntry && open && (hasProcess || ongoing)) trackOpen(turnKey);
        const processLabel = showElapsed
          ? finishedLabel
          : showRunning
            ? runningTurnLabel
            : (waitingLabel ?? '处理过程');
        const waitingInSummary = hasProcess && !showElapsed && !!waitingLabel && !showRunning;
        const statusContent = showRunning ? (
          <RunningTurnStatus startedAtMs={timing?.turnStartedAtMs} />
        ) : (
          <span className="agent-turn-status-label" role={waitingInSummary ? 'status' : undefined}>
            {processLabel}
          </span>
        );
        const turnActive =
          !ended &&
          !activity?.executionUnconfirmed &&
          (!activity || activity.status === 'running' || activity.status === 'waiting');
        const renderBody = (group: Message[], showReply = false) => {
          const message = group[0]!;
          return (
            <div
              key={message.presentationKey ?? message.id}
              className={cn('agent-turn-body', message.finalReply && 'agent-turn-final')}
            >
              {renderGroup(group, showReply || message.finalReply ? 'result' : 'process', {
                turnOutputs: message.id === finalGroup?.[0]?.id ? turnOutputs : undefined,
              })}
            </div>
          );
        };
        const renderBlock = (block: Message[], index: number) => {
          const first = block[0]!;
          if (!isConversationTraceStep(first)) return renderBody(block, first === reply);
          const steps = block.filter((item) => !item.tracePending);
          const tools = steps.filter((item) => item.role === 'tool');
          const currentTrace =
            ongoing && !ended && lastTurnEntry && !reply && index === blocks.length - 1;
          const interaction = turnActive ? traceInteractionTitle(tools) : undefined;
          const runningTool = turnActive ? latestRunningTraceTool(tools) : undefined;
          const trailing = block.at(-1);
          const activeReasoning =
            turnActive && currentTrace && (!activity || activity.status === 'running')
              ? steps.find(
                  (step) =>
                    step.role === 'thinking' &&
                    !step.settled &&
                    !step.executionUnconfirmed &&
                    (step.reasoningActive ??
                      (step === trailing && (!!step.text.trim() || !!step.reasoningSource))),
                )
              : undefined;
          const latestTool = currentTrace ? tools.at(-1) : undefined;
          const completedSummary =
            !interaction && !runningTool && !activeReasoning && !currentTrace;
          const summary =
            interaction ??
            (runningTool
              ? toolTraceTitle(runningTool)
              : activeReasoning
                ? '思考中'
                : latestTool
                  ? toolTraceTitle(latestTool)
                  : tools.length
                    ? completedToolActions(tools) || '工具执行'
                    : '已思考');
          const boundary = blocks[index - 1]?.[0];
          const id = boundary ? traceKey(boundary) : `trace-turn:${entry.key}`;
          if (open && expanded[id] === true) trackOpen(id);
          return (
            <ConversationTrace
              key={id}
              id={id}
              steps={steps}
              label={summary}
              running={!interaction && (!!runningTool || !!activeReasoning)}
              activeReasoning={activeReasoning}
              interactionTitle={interaction}
              summarizeTools={completedSummary}
              processOpen={!hasProcess || open}
              notice={
                turnActive &&
                block.some((item) => item.toolStopping && !item.executionUnconfirmed) && (
                  <p className="conversation-turn-notice" role="status">
                    已请求停止，等待执行结果。
                  </p>
                )
              }
              expanded={expanded}
              restoredExpanded={restoredExpanded.current}
              onToggle={onTraceToggle}
              renderTool={(item, parentDisclosureOpen, traceSummaryTitle, directTraceDetails) =>
                renderGroup(
                  [
                    steps.length === 1 && !item.settled && activity?.executionUnconfirmed
                      ? { ...item, executionUnconfirmed: true }
                      : item,
                  ],
                  'trace',
                  { parentDisclosureOpen, traceSummaryTitle, directTraceDetails },
                )
              }
              renderReasoning={renderReasoning}
            />
          );
        };
        const processId = (start: number) =>
          `${traceContentId}-${encodeURIComponent(JSON.stringify(entry.key))}-${start}`;
        const process = hasProcess ? (
          <TurnSummary
            label={processLabel}
            open={open}
            readOnly={showElapsed && !open && pendingTraceToolTurns?.has(entry.turnId)}
            contentIds={segments
              .filter((segment) => segment.collapsible)
              .map(({ start }) => processId(start))
              .join(' ')}
          >
            {statusContent}
          </TurnSummary>
        ) : showElapsed || showRunning ? (
          <div key={turnKey} className="agent-turn-summary agent-turn-summary-static">
            {statusContent}
          </div>
        ) : null;
        const content = segments.flatMap(({ start, blocks: section, collapsible }) => {
          const renderSection = () =>
            section.map((block, index) => renderBlock(block, start + index));
          if (!hasProcess || !collapsible) return renderSection();
          const boundary = blocks[start - 1]?.[0];
          return [
            <DeferredProcessContent
              key={boundary ? `process:${traceKey(boundary)}` : turnKey}
              id={processId(start)}
              open={open}
              className="agent-turn-content"
              render={() => <div className="conversation-trace-process">{renderSection()}</div>}
            />,
          ];
        });
        if (lastTurnEntry && terminalStatus && (terminalStatus !== 'completed' || finalGroup))
          content.push(
            <Fragment key="turn-details">
              {renderTurnDetails?.({ turnId: entry.turnId, terminalStatus })}
            </Fragment>,
          );
        if (finalGroup) content.push(renderBody(finalGroup, true));
        return (
          <Collapsible
            asChild
            key={entry.key}
            open={hasProcess && open}
            onOpenChange={(next) => onTraceToggle(turnKey, next)}
          >
            <section
              className={cn(
                'agent-turn conversation-trace-turn',
                hasProcess && 'agent-turn-process',
              )}
              data-instant-open={
                (hasProcess && ongoing && expanded[turnKey] === undefined) || undefined
              }
              data-restored-expanded={
                (hasProcess && restoredExpanded.current.has(turnKey)) || undefined
              }
              data-turn-status={
                terminalStatus ?? activity?.status ?? (completed ? 'completed' : 'unknown')
              }
            >
              {process}
              {content}
              {!finalGroup && turnOutputs}
              {waitingLabel && !waitingInSummary && (
                <small
                  className={cn(
                    'conversation-turn-notice',
                    (failed || aborted || cancelled) && 'conversation-turn-terminal',
                  )}
                  role="status"
                >
                  {waitingLabel}
                </small>
              )}
            </section>
          </Collapsible>
        );
      }
      const liveNote = responding
        ? active && thinking && !runningTool && (!activity || activity.status === 'running')
          ? '正在思考…'
          : waitingForContent
            ? (preparationLabel ??
              (activity?.responsePhase === 'preparing' ? '正在准备回复…' : undefined))
            : undefined
        : undefined;
      const label = !lastTurnEntry
        ? '处理过程'
        : diagnostics &&
            !terminalStatus &&
            activity?.executionUnconfirmed &&
            isOngoingTurn(activity)
          ? '执行状态待核实'
          : diagnostics && !terminalStatus && activity?.unavailable
            ? '上次确认状态'
            : ended
              ? finishedDuration === undefined
                ? '用时未知'
                : '用时'
              : activity?.status === 'recovery_required'
                ? '需要恢复'
                : activity?.status === 'cancelling'
                  ? '正在停止'
                  : activity?.status === 'waiting'
                    ? '正在等待'
                    : activity?.status === 'queued'
                      ? '等待处理'
                      : responding && !liveNote
                        ? runningTurnLabel
                        : '处理过程';
      const showProcess = processGroups.length > 0;
      // Failed/interrupted work without a final reply stays readable by default.
      // Explicit reading choices still win; a final reply preserves normal collapse.
      const settled =
        !!terminalStatus ||
        failureGroups.length > 0 ||
        ['completed', 'failed', 'cancelled'].includes(activity?.status ?? '') ||
        (!!finalGroup && !ongoing);
      // Settlement regroups the final reply outside the process. Start a new
      // container so the old process cannot repaint during its exit animation.
      const turnKey = `turn:${entry.turnId}:${settled && !retainingReply ? 'complete' : 'process'}`;
      const open = !settled || (expanded[turnKey] ?? (incompleteFailure || retainingReply));
      // Cold history and restored readings start at their full height. Replaying
      // the default-open process moves the transcript for the entire animation.
      // A later user toggle removes this marker and keeps the normal animation.
      if (showProcess && open) trackOpen(turnKey);
      const statusContent = (
        <span
          className="agent-turn-status-label"
          role={active && label !== '处理过程' ? 'status' : undefined}
        >
          {label}
          {lastTurnEntry && (!ended || finishedDuration !== undefined) && (
            <TurnElapsed
              startedAtMs={timing?.turnStartedAtMs}
              finishedAtMs={timing?.turnFinishedAtMs}
              prefix={finishedDuration !== undefined ? ' ' : ' · 用时 '}
            />
          )}
        </span>
      );
      return (
        <section
          key={entry.key}
          className="agent-turn"
          data-turn-status={
            failed
              ? 'failed'
              : cancelled
                ? 'cancelled'
                : aborted
                  ? 'aborted'
                  : (terminalStatus ?? activity?.status ?? (active ? 'running' : 'unknown'))
          }
        >
          {showProcess && (
            <Collapsible
              key={turnKey}
              asChild
              open={open}
              disabled={!settled}
              onOpenChange={settled ? (next) => onToggle(turnKey, next) : undefined}
            >
              <div
                className="agent-turn-process"
                data-instant-open={!settled || undefined}
                data-restored-expanded={restoredExpanded.current.has(turnKey) || undefined}
              >
                {settled ? (
                  <TurnSummary
                    label={finishedDuration === undefined ? label : finishedLabel}
                    open={open}
                  >
                    {statusContent}
                  </TurnSummary>
                ) : (
                  <div className="agent-turn-summary-row">
                    <div className="agent-turn-summary agent-turn-summary-static" role="status">
                      {statusContent}
                    </div>
                  </div>
                )}
                <DeferredProcessContent
                  open={open}
                  className="agent-turn-content"
                  render={() => (
                    <section className="agent-turn-process-messages" aria-label="本轮处理过程">
                      {processGroups.map((group) =>
                        renderGroup(group, 'process', { parentDisclosureOpen: open }),
                      )}
                    </section>
                  )}
                />
              </div>
            </Collapsible>
          )}
          {!showProcess &&
            (finalGroup || failureGroups.length === 0) &&
            (!liveNote || label !== '处理过程') && (
              <div className="agent-turn-summary agent-turn-summary-static" role="status">
                {statusContent}
              </div>
            )}
          {finalGroup && (
            <div className="agent-turn-final">
              {renderGroup(finalGroup, 'result', { turnOutputs })}
            </div>
          )}
          {!finalGroup && turnOutputs}
          {liveNote && (
            <small className="response-status" role="status">
              <span className="inline-block shimmer shimmer-color-foreground shimmer-spread-[16px] shimmer-duration-1500">
                {liveNote}
              </span>
            </small>
          )}
        </section>
      );
    };
    const busy =
      isLiveTurn(turnActivity) ||
      messages.some(
        (message) =>
          !message.executionUnconfirmed &&
          !(message.turnId === turnActivity?.turnId && turnActivity?.executionUnconfirmed) &&
          message.systemKind !== 'turn_timing' &&
          (!message.turnId || !terminalByTurn.get(message.turnId)) &&
          (message.delivery === 'sending' ||
            ((message.role === 'assistant' ||
              message.role === 'tool' ||
              message.role === 'subagent' ||
              message.role === 'thinking' ||
              message.role === 'system') &&
              !message.settled)),
      );
    const entryFacts = (entry: (typeof entries)[number]) => {
      if (!historyEntryFacts || !traceTurns || loading) return;
      const { turnId } = entry;
      if (turnId && turnId === turnActivity?.turnId) return;
      const rows = entry.groups.flat();
      const terminal = turnId ? terminalByTurn.get(turnId) : undefined;
      const final = turnId ? finalReplyByTurn.get(turnId) : undefined;
      if (turnId && !terminal && !final) return;
      if (
        !rows.length ||
        rows.some((row) => row.delivery || (!terminal && (!row.settled || row.tracePending)))
      )
        return;

      const timing = turnId ? timingByTurn.get(turnId) : undefined;
      const keys = new Set<string>([`trace-turn:${entry.key}`]);
      if (turnId) keys.add(`turn:${turnId}:complete`);
      const related = rows.flatMap((row) =>
        row.role === 'tool' ? (children.get(row.id.slice(5)) ?? []) : [],
      );
      for (const row of [...rows, ...related]) {
        const key = row.presentationKey ?? row.id;
        for (const id of [
          row.id,
          key,
          traceKey(row),
          `activity:${key}`,
          `activity-group:${row.presentationGroupId ?? key}`,
        ])
          keys.add(id);
        for (const step of row.steps ?? []) keys.add(`subagent-step:${step.id}`);
        if (row.role === 'subagent')
          for (const tool of childTools.get(row.id.slice(9)) ?? []) keys.add(tool.id);
      }
      const messageSignature = (row: Message) => {
        let signature = messageSignatures.current.get(row);
        if (signature === undefined) {
          signature = JSON.stringify(row);
          messageSignatures.current.set(row, signature);
        }
        return signature;
      };
      const hostFacts = historyEntryFacts(rows, turnId);
      const childRows = [...rows, ...related].filter((row) => row.role === 'subagent');
      return [
        diagnostics,
        openFile,
        writeClipboardText,
        onOpenChildSession,
        turnId,
        terminal,
        final?.id,
        timing?.turnStartedAtMs,
        timing?.turnFinishedAtMs,
        lastEntryByTurn.get(turnId ?? '') === entry,
        turnId && pendingTraceToolTurns?.has(turnId),
        runningToolTurns.has(turnId ?? ''),
        thinkingTurns.has(turnId ?? ''),
        entry.groups.length,
        ...entry.groups.flatMap((group) => [group.length, ...group.map(messageSignature)]),
        related.length,
        ...related.map(messageSignature),
        childRows.length,
        ...childRows.flatMap((row) => {
          const id = row.id.slice(9);
          const tools = childTools.get(id) ?? [];
          return [childSessionIdsByTaskId?.get(id), tools.length, ...tools.map(messageSignature)];
        }),
        keys.size,
        ...[...keys].flatMap((key) => [key, expanded[key], restoredExpanded.current.has(key)]),
        ...hostFacts,
      ];
    };
    return {
      entries,
      entryFacts,
      renderEntry,
      latestReplyId: latestFinalReply?.id,
      empty: entries.length === 0,
      busy,
    };
  }, [
    messages,
    turnActivity,
    expanded,
    diagnostics,
    renderMessage,
    renderMessageContent,
    renderMessageAttachments,
    renderTurnOutputs,
    renderTurnDetails,
    renderToolActivity,
    traceTurns,
    pendingTraceToolTurns,
    renderReasoning,
    historyEntryFacts,
    childSessionIdsByTaskId,
    onOpenChildSession,
    openFile,
    writeClipboardText,
    onToggle,
    restoredMarkerSignature,
    loading,
    preserveReadingAnchor,
    traceContentId,
  ]);
  const { empty, busy } = projection;
  useLayoutEffect(
    () => latestReply.set(projection.latestReplyId),
    [latestReply, projection.latestReplyId],
  );
  const { entryContent, openTurns, traceProcesses, markers, retainedEntries } = useMemo(() => {
    const openTurns: string[] = [];
    const traceProcesses = new Map<string, boolean>();
    const markers: ConversationMessageMarker[] = [];
    const retainedEntries = new Map<string, RetainedEntry>();
    const appendReading = (turns: string[], processes: Map<string, boolean>) => {
      openTurns.push(...turns);
      for (const [id, open] of processes) traceProcesses.set(id, open);
    };
    const entryContent = projection.entries.map((entry) => {
      const message = entry.groups[0]?.[0];
      const isMarker = messageNavigation && !loading && message && isNavigationMessage(message);
      if (isMarker)
        markers.push({
          key: entry.key,
          preview:
            message.text.slice(0, 80).replace(/\s+/g, ' ').trim() ||
            (message.hasAttachments ? '附件' : ''),
        });
      const facts = projection.entryFacts(entry);
      const before = committedEntries.current.get(entry.key);
      let body: ReactNode;
      if (facts && before && sameEntryFacts(before.facts, facts)) {
        retainedEntries.set(entry.key, before);
        appendReading(before.openTurns, before.traceProcesses);
        body = before.content;
      } else if (facts) {
        const turns: string[] = [];
        const processes = new Map<string, boolean>();
        body = projection.renderEntry(entry, turns, processes);
        retainedEntries.set(entry.key, {
          facts,
          content: body,
          openTurns: turns,
          traceProcesses: processes,
        });
        appendReading(turns, processes);
      } else {
        body = projection.renderEntry(entry, openTurns, traceProcesses);
      }
      if (!preserveReadingAnchor && !isMarker) return body;
      const Entry = entry.turnId ? ConversationTurnEntry : 'div';
      return (
        <Entry
          key={entry.key}
          className="conversation-entry"
          data-conversation-entry-key={preserveReadingAnchor ? entry.key : undefined}
          data-entry-kind={
            preserveReadingAnchor ? (entry.turnId ? 'turn' : (message?.role ?? 'other')) : undefined
          }
          data-conversation-message-marker={isMarker ? entry.key : undefined}
        >
          {body}
        </Entry>
      );
    });
    return { entryContent, openTurns, traceProcesses, markers, retainedEntries };
  }, [projection, preserveReadingAnchor, messageNavigation, loading]);
  useLayoutEffect(() => {
    committedOpenTurns.current = openTurns;
    committedTraceProcesses.current = traceProcesses;
    committedEntries.current = retainedEntries;
  }, [openTurns, traceProcesses, retainedEntries]);
  const markerKeys = JSON.stringify(markers.map((marker) => marker.key));
  // Refresh the targets when the mounted input identities change or the cached DOM reconnects.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || markerKeys === '[]') {
      jumpedMarker.current = undefined;
      return;
    }
    markerTargets.current = [
      ...element.querySelectorAll<HTMLElement>('[data-conversation-message-marker]'),
    ];
    if (
      jumpedMarker.current &&
      !markerTargets.current.some(
        (target) => target.dataset.conversationMessageMarker === jumpedMarker.current,
      )
    )
      jumpedMarker.current = undefined;
    syncMessageNavigation(element);
    return () => {
      markerTargets.current = [];
    };
  }, [markerKeys, syncMessageNavigation]);
  const jumpToMessage = useCallback(
    (key: string) => {
      const element = viewport.current;
      const target = markerTargets.current.find(
        (candidate) => candidate.dataset.conversationMessageMarker === key,
      );
      if (!element || !target) return;
      const top =
        element.scrollTop +
        target.getBoundingClientRect().top -
        conversationMessageNavigationTop(element);
      if (reading.current.follow && (top >= element.scrollTop - 1 || element.scrollTop <= 1)) {
        setActiveMarker(key);
        return;
      }
      reading.current.follow = false;
      jumpedMarker.current = key;
      traceDisclosure.current = false;
      writeScroll(element, top);
      reading.current.anchor = preserveReadingAnchor
        ? {
            entryKey: key,
            offset: target.getBoundingClientRect().top - element.getBoundingClientRect().top,
          }
        : undefined;
      setFollowing(false);
    },
    [preserveReadingAnchor, writeScroll],
  );
  const focusedMessage = useRef<typeof focusMessage>(undefined);
  const focusTurn =
    focusMessage &&
    messages.find((message) => message.presentationKey === focusMessage.presentationKey)?.turnId;
  useLayoutEffect(() => {
    const element = viewport.current;
    if (
      !element ||
      loading ||
      !selected ||
      !focusMessage ||
      focusedMessage.current === focusMessage
    )
      return;
    const findTarget = () =>
      Array.from(element.querySelectorAll<HTMLElement>('[data-conversation-focus]')).find(
        (candidate) => candidate.dataset.conversationFocus === focusMessage.presentationKey,
      );
    const focus = (target: HTMLElement | undefined) => {
      if (!target || !focusMessage.reveal(target)) return false;
      focusedMessage.current = focusMessage;
      reading.current.follow = false;
      jumpedMarker.current = undefined;
      traceDisclosure.current = false;
      writeScroll(
        element,
        element.scrollTop +
          target.getBoundingClientRect().top -
          conversationMessageNavigationTop(element),
      );
      if (preserveReadingAnchor) reading.current.anchor = captureConversationScrollAnchor(element);
      setFollowing(false);
      target.focus({ preventScroll: true });
      focusMessage.onFocused?.();
      return true;
    };
    const target = findTarget();
    if (focus(target) || typeof MutationObserver === 'undefined') return;
    if (!target && focusTurn) onToggle(`turn:${focusTurn}:complete`, true);
    const observer = new MutationObserver(() => {
      if (focus(findTarget())) observer.disconnect();
    });
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-busy'],
    });
    return () => observer.disconnect();
  }, [focusMessage, focusTurn, loading, selected, onToggle, writeScroll, preserveReadingAnchor]);
  return (
    <ClipboardWriteContext.Provider value={writeClipboardText}>
      <div className="conversation-container">
        <div className="conversation">
          <section
            ref={viewport}
            className="conversation-viewport"
            aria-label="会话消息"
            aria-busy={loading || busy}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Native scroll regions need keyboard scrolling and selection shortcuts.
            tabIndex={0}
            onScroll={() => {
              const element = viewport.current;
              if (!element || loading || restore.current) return;
              if (
                writtenScrollTop.current !== undefined &&
                Math.abs(element.scrollTop - writtenScrollTop.current) < 1
              )
                return;
              writtenScrollTop.current = undefined;
              jumpedMarker.current = undefined;
              traceDisclosure.current = false;
              // Resume only at the actual bottom. A wider near-bottom zone
              // makes the following-state commit snap a manual scroll to the tail.
              // scrollTop is fractional while the two heights are rounded.
              const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
              const follow = remaining <= 1;
              reading.current = {
                ...reading.current,
                top: element.scrollTop,
                follow,
                expanded: reading.current.expanded,
                anchor:
                  preserveReadingAnchor && !follow
                    ? captureConversationScrollAnchor(element)
                    : undefined,
              };
              setFollowing(follow);
              syncMessageNavigation(element);
            }}
          >
            <div
              ref={content}
              className="reading-column"
              data-large-history={largeHistory || undefined}
            >
              {!loading &&
                (empty && !entryContent.length && emptyState !== null ? (
                  <div className="welcome">
                    <h1>{emptyState?.title ?? (selected ? '从一个想法开始' : '继续你的工作')}</h1>
                    <p>
                      {emptyState?.detail ??
                        (selected
                          ? '描述你的目标，或写下需要一起解决的问题。'
                          : connected
                            ? '选择已有会话，或为新的工作创建一个会话。'
                            : '选择本地项目，连接你的模型与工具。')}
                    </p>
                  </div>
                ) : (
                  <LatestReplyContext.Provider value={latestReply}>
                    {entryContent}
                  </LatestReplyContext.Provider>
                ))}
            </div>
          </section>
          {navigationOverflow && markers.length > 0 && (
            <ConversationMessageNavigation
              markers={markers}
              activeKey={activeMarker}
              onJump={jumpToMessage}
            />
          )}
        </div>
        {loading && (
          <div className="conversation-loading" role="status" aria-label="正在加载聊天">
            <Spinner aria-hidden="true" size={16} />
          </div>
        )}
        {!following && !loading && (
          <div className="conversation-jump">
            <Button
              className="jump-latest"
              size="icon"
              aria-label="回到最新消息"
              title="回到最新消息"
              onClick={() => {
                const element = viewport.current;
                if (!element) return;
                reading.current.follow = true;
                traceDisclosure.current = false;
                reading.current.anchor = undefined;
                jumpedMarker.current = undefined;
                writeScroll(element, element.scrollHeight);
                reading.current = { ...reading.current, follow: true, top: element.scrollTop };
                setFollowing(true);
              }}
            >
              {busy ? (
                <span className="jump-latest-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <HugeiconsIcon icon={ArrowDown02Icon} aria-hidden="true" />
              )}
            </Button>
          </div>
        )}
      </div>
    </ClipboardWriteContext.Provider>
  );
}
