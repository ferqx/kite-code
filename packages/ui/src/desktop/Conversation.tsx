import { ArrowDown01Icon, ArrowDown02Icon, KiteIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useConversationActivity } from '../conversation-activity';
import { ClipboardWriteContext, CodeCopyEligibilityContext } from './clipboard';
import {
  AnimatedCollapsibleContent,
  Collapsible,
  CollapsibleTrigger,
} from './components/ui/collapsible';
import { Marker, MarkerContent } from './components/ui/marker';
import { useDesktopDiagnostics } from './diagnostics';
import { cn } from './lib/utils';
import { MessageContent } from './MessageContent';
import { MessageCopyButton } from './MessageCopyButton';
import { formatMessageTime } from './message-time';
import { pruneReadingState } from './reading-state';
import { statusLabel } from './status';
import { ToolActivity } from './ToolActivity';
import { TurnFailure } from './TurnFailure';
import type { Message, TurnActivity } from './types';
import { Button } from './ui';

export interface ReadingState {
  top: number;
  follow: boolean;
  expanded: Record<string, boolean>;
}

export interface ToolActivityState {
  expanded?: boolean;
  activityId: string;
  restoredExpanded: ReadonlySet<string>;
  expandedItems: Readonly<Record<string, boolean>>;
  onToggle: (open: boolean) => void;
  onToggleItem: (id: string, open: boolean) => void;
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
    ['queued', 'running', 'waiting', 'cancelling', 'recovery_required'].includes(activity.status)
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
  showResponseStatus = true,
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
  copyRole?: 'user' | 'assistant';
  writeClipboardText?: (text: string) => Promise<void>;
  childDetail?: { readonly label: string; readonly onOpen: () => void };
  renderContent?: (message: Message) => ReactNode;
  renderAttachments?: (message: Message) => ReactNode;
  showResponseStatus?: boolean;
}) {
  const [metadataNow, setMetadataNow] = useState(() => Date.now());
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
      <section
        key={message.id}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: allow keyboard scrolling of the bounded tool list.
        tabIndex={0}
        className="subagent-process"
        aria-label={`${message.title || '子 Agent'}的工具步骤`}
      >
        {steps}
        {tools}
      </section>
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
  if (message.systemKind === 'compaction')
    return (
      <article className={`message context-compacted ${message.status ?? ''}`}>
        <Marker role="status">
          <MarkerContent className="tool-label">{message.title}</MarkerContent>
        </Marker>
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
  if (message.role === 'system' && !agentResult && !agentMessage)
    return (
      <article className={`message system ${message.status ?? ''}`}>
        <p>
          {message.title}
          {message.status && <span className="message-status">{statusLabel(message.status)}</span>}
        </p>
        {message.text && <pre>{message.text}</pre>}
      </article>
    );
  const timestamp = formatMessageTime(message.createdAtMs, metadataNow);
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
      onPointerEnter={() => setMetadataNow(Date.now())}
      onFocus={() => setMetadataNow(Date.now())}
      data-agent-result-source={agentResult?.sourceId}
      data-agent-message-id={agentMessage?.messageId}
      aria-label={
        agentMessage
          ? `${agentMessage.name} Agent 发送的消息`
          : agentResult
            ? `${agentResult.name} Agent 发送的消息`
            : message.role === 'user'
              ? '用户消息'
              : '助手消息'
      }
    >
      {agentMessage && <p className="message-label">{agentMessage.name} Agent 发送</p>}
      {agentResult && (
        <p className="message-label">
          {agentResult.name} Agent 发送
          {agentResult.outcome !== 'succeeded' && (
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
      {message.role === 'user' && !agentResult && !agentMessage && renderAttachments?.(message)}
      <CodeCopyEligibilityContext.Provider value={Boolean(copyText)}>
        {message.role === 'user' && !agentResult && !agentMessage ? (
          <div className="user-message-body">
            {renderContent ? (
              renderContent(message)
            ) : (
              <>
                {message.text && <p className="user-text">{message.text}</p>}
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
          </div>
        ) : renderContent ? (
          renderContent(message)
        ) : message.role === 'assistant' || agentResult || agentMessage ? (
          message.text && <MessageContent text={message.text} openFile={openFile} />
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
      {agentResult && !agentResult.contentComplete && <p role="status">消息正文未完整展示。</p>}
      {agentMessage && !agentMessage.contentComplete && (
        <p role="status">消息正文暂不可完整读取。</p>
      )}
      {showResponseStatus && message.role === 'assistant' && !message.settled && (
        <small className="response-status" role="status">
          <span className="inline-block shimmer shimmer-color-foreground shimmer-spread-[16px] shimmer-duration-1500">
            正在回复…
          </span>
        </small>
      )}
      <footer className="message-meta">
        {copyText && (
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
        ) : (
          <span className="message-time" title="没有可核实的消息记录时间">
            时间未知
          </span>
        )}
      </footer>
    </article>
  );
});

export function Conversation({
  messages: incomingMessages,
  loading: historyLoading,
  initialPresentationPending = false,
  turnActivity: incomingTurnActivity,
  requiredSubagentWait,
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
  renderToolActivity,
}: {
  messages: readonly Message[];
  loading: boolean;
  /** First mount waits for host-owned grouping; an already readable tree stays live. */
  initialPresentationPending?: boolean;
  turnActivity?: TurnActivity;
  requiredSubagentWait?: boolean;
  selected: boolean;
  connected: boolean;
  initialReading?: ReadingState;
  saveReading: (state: ReadingState) => void;
  openFile?: (path: string) => void;
  writeClipboardText?: (text: string) => Promise<void>;
  emptyState?: { title: string; detail: string };
  childSessionIdsByTaskId?: ReadonlyMap<string, string>;
  onOpenChildSession?: (childSessionId: string) => void;
  /** Public-body hosts supply their verified content reader without fabricating legacy tool facts. */
  renderMessage?: (message: Message) => ReactNode;
  /** Verified body reader within the original message and copy controls. */
  renderMessageContent?: (message: Message) => ReactNode;
  /** Attachment presentation outside the user text bubble, sharing the same message identity. */
  renderMessageAttachments?: (message: Message) => ReactNode;
  /** Host-adapted tool facts within the original grouping and reading state. */
  renderToolActivity?: (messages: readonly Message[], state: ToolActivityState) => ReactNode;
}) {
  const presented = useRef(false);
  useLayoutEffect(() => {
    if (!historyLoading && !initialPresentationPending) presented.current = true;
  }, [historyLoading, initialPresentationPending]);
  const preparing = initialPresentationPending && !presented.current;
  const messages = preparing ? [] : incomingMessages;
  const loading = historyLoading || preparing;
  const turnActivity = preparing ? undefined : incomingTurnActivity;
  const readingActivity = useConversationActivity();
  const diagnostics = useDesktopDiagnostics();
  const previousResume = useRef(readingActivity.resume);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reading = useRef<ReadingState>(initialReading ?? { top: 0, follow: true, expanded: {} });
  const writtenScrollTop = useRef<number | undefined>(undefined);
  const writeScroll = useCallback((element: HTMLDivElement, top: number) => {
    element.scrollTop = top;
    // Use the browser's clamped value, not scrollHeight. The scroll event may
    // arrive after another chunk has changed that height.
    writtenScrollTop.current = element.scrollTop;
    reading.current.top = element.scrollTop;
  }, []);
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
  if (previousResume.current !== readingActivity.resume) {
    previousResume.current = readingActivity.resume;
    restore.current = true;
    for (const [id, open] of Object.entries(expanded)) if (open) restoredExpanded.current.add(id);
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
      if (reading.current.follow) writeScroll(element, element.scrollHeight);
    });
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [loading, writeScroll]);
  // After each content/layout commit, follow only while the reader is at the bottom.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || loading) {
      restore.current = true;
      return;
    }
    if (restore.current || reading.current.follow) {
      writeScroll(element, reading.current.follow ? element.scrollHeight : reading.current.top);
      restore.current = false;
    }
  });
  const onToggle = useRef((id: string, open: boolean) => {
    restoredExpanded.current.delete(id);
    setExpanded((values) => (values[id] === open ? values : { ...values, [id]: open }));
  }).current;
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
    childTools.set(owner, [...(childTools.get(owner) ?? []), message]);
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
    message.role === 'thinking' ||
    message.systemKind === 'turn_timing' ||
    message.systemKind === 'turn_terminal';
  const visible = new Set(
    messages.filter((message) => {
      if (structural(message)) return false;
      if (renderMessage) return true;
      if (message.role === 'tool' && askToolIds.has(message.id.slice(5))) return false;
      if (message.role === 'system')
        return message.systemKind === 'ask' || message.settled || !!message.status;
      if (message.role === 'tool') return isVisibleTool(message);
      if (message.role === 'subagent')
        return !message.parentToolCallId || !visibleToolIds.has(message.parentToolCallId);
      return (
        !message.settled || !!message.text || (message.role === 'user' && !!message.hasAttachments)
      );
    }),
  );
  const visibleTurns = new Set(
    [...visible].filter((message) => message.role !== 'user').map((message) => message.turnId),
  );
  const anchors = new Map<string, Message>();
  for (const message of messages) {
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
  const anchoredTurns = new Set<string>();
  // A hidden-only Turn still needs its status in chronological position. Keep
  // one structural anchor only when no readable message already owns that Turn;
  // hidden reasoning must not split otherwise contiguous exploration tools.
  const shown: Message[] = [];
  for (const message of messages) {
    if (visible.has(message)) {
      shown.push(message);
      const anchor = message.turnId && anchors.get(message.turnId);
      // Native seals timing/terminal markers after all history. The exact user
      // identity keeps a no-output Turn before subsequent conversation rounds.
      if (
        message.role === 'user' &&
        anchor &&
        !visibleTurns.has(message.turnId) &&
        !anchoredTurns.has(message.turnId)
      ) {
        anchoredTurns.add(message.turnId);
        shown.push(anchor);
      }
    } else if (
      structural(message) &&
      message.turnId &&
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
  const timingByTurn = new Map(
    messages
      .filter((message) => message.systemKind === 'turn_timing' && message.turnId)
      .map((message) => [message.turnId!, message]),
  );
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
    )
      finalReplyByTurn.set(message.turnId, message);
  }
  const assistantTurnCopies = new Map(
    [...finalReplyByTurn.values()].map((message) => [
      message.id,
      message.copyText === null ? undefined : (message.copyText ?? message.text),
    ]),
  );
  // Contiguous exploration calls in one explicit Turn share a visual activity,
  // even when separate model responses supplied different presentation groups.
  // Unscoped history still needs the exact presentation group to merge.
  const groups: Message[][] = [];
  for (const message of shown) {
    const previous = groups.at(-1);
    if (
      message.role === 'tool' &&
      message.presentation === 'exploration' &&
      message.presentationGroupId &&
      previous?.[0]?.role === 'tool' &&
      previous[0].presentation === 'exploration' &&
      previous[0].presentationGroupId &&
      previous[0].turnId === message.turnId &&
      (previous[0].presentationGroupId === message.presentationGroupId || !!message.turnId)
    )
      previous.push(message);
    else groups.push([message]);
  }
  // Exact Turn identities bound a process. Unscoped non-user messages between
  // two parts of that same Turn stay in their original order inside it.
  const entries: { key: string; turnId?: string; groups: Message[][] }[] = [];
  const seenTurnIds = new Set<string>();
  const unscoped: Message[][] = [];
  const flushUnscoped = () => {
    for (const group of unscoped) entries.push({ key: group[0]!.id, groups: [group] });
    unscoped.length = 0;
  };
  for (const group of groups) {
    const message = group[0]!;
    // A durable child result is a readable conversation event, including between
    // two phases of the same parent Run. Never absorb it into process collapse.
    if (message.systemKind === 'agent_result') {
      flushUnscoped();
      entries.push({ key: message.id, groups: [group] });
      continue;
    }
    const turnId = message.role === 'user' ? undefined : message.turnId;
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
          ? `turn:${turnId}:after:${message.id}`
          : `turn:${turnId}`
        : message.id,
      turnId,
      groups: [group],
    });
    if (turnId) seenTurnIds.add(turnId);
  }
  flushUnscoped();
  if (
    turnActivity &&
    ['queued', 'running', 'waiting', 'cancelling', 'recovery_required', 'cancelled'].includes(
      turnActivity.status,
    ) &&
    !seenTurnIds.has(turnActivity.turnId)
  ) {
    entries.push({
      key: `turn:${turnActivity.turnId}`,
      turnId: turnActivity.turnId,
      groups: [],
    });
  }
  const lastEntryByTurn = new Map(
    entries.filter((entry) => entry.turnId).map((entry) => [entry.turnId, entry]),
  );
  const renderGroup = (group: Message[], turnScoped = false) => {
    const message = group[0]!;
    if (structural(message)) return null;
    if (renderMessage)
      return (
        <div key={message.id} className="message-group">
          <article className={`message ${message.role}`} aria-label={`${message.role} 消息`}>
            {renderMessage(message)}
          </article>
        </div>
      );
    // A newly formed aggregate must not inherit a single receipt's open reader.
    // Keep its identity stable as more tools join the same aggregate.
    const activityKey =
      group.length > 1
        ? `activity-group:${message.presentationGroupId ?? message.id}`
        : `activity:${message.id}`;
    if (message.role === 'tool' && renderToolActivity)
      return (
        <Fragment key={activityKey}>
          {renderToolActivity(group, {
            expanded: expanded[activityKey],
            activityId: activityKey,
            restoredExpanded: restoredExpanded.current,
            expandedItems: expanded,
            onToggle: (open) => onToggle(activityKey, open),
            onToggleItem: onToggle,
          })}
        </Fragment>
      );
    return message.role === 'tool' ? (
      <ToolActivity
        key={activityKey}
        messages={group}
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
        onToggle={(open) => onToggle(activityKey, open)}
        openFile={openFile}
        childDetail={parentTaskDetail(message, group.length)}
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
      <div key={message.id} className="message-group">
        <MessageItem
          message={childWithUniqueSteps(message)}
          childDetail={childDetail(message)}
          childTools={message.role === 'subagent' ? childTools.get(message.id.slice(9)) : undefined}
          expandedItems={expanded}
          restoredExpanded={restoredExpanded.current}
          expanded={expanded[message.id]}
          onToggle={onToggle}
          openFile={openFile}
          writeClipboardText={writeClipboardText}
          renderContent={renderMessageContent}
          renderAttachments={renderMessageAttachments}
          showResponseStatus={!turnScoped}
          copyText={
            message.role === 'user' && message.settled && !message.delivery && message.text
              ? message.copyText === null
                ? undefined
                : (message.copyText ?? message.text)
              : assistantTurnCopies.get(message.id)
          }
          copyRole={message.role === 'user' ? 'user' : 'assistant'}
        />
      </div>
    );
  };
  const renderEntry = (entry: (typeof entries)[number]) => {
    if (!entry.turnId)
      return <Fragment key={entry.key}>{entry.groups.map((group) => renderGroup(group))}</Fragment>;
    const finalGroup = entry.groups.find(
      ([message]) => message?.role === 'assistant' && message.settled && message.finalReply,
    );
    const failureGroups = entry.groups.filter(([message]) => !!message && isTurnFailure(message));
    const processGroups = entry.groups.filter(
      (group) => group !== finalGroup && !failureGroups.includes(group) && !structural(group[0]!),
    );
    const activity = turnActivity?.turnId === entry.turnId ? turnActivity : undefined;
    const timing = timingByTurn.get(entry.turnId);
    const terminalStatus = terminalByTurn.get(entry.turnId);
    const active =
      !terminalStatus &&
      (activity && !activity.unavailable
        ? isLiveTurn(activity)
        : !turnActivity && entry.groups.some((group) => group.some((message) => !message.settled)));
    const failed =
      activity?.status === 'failed' || terminalStatus === 'failed' || failureGroups.length > 0;
    const cancelled =
      activity?.status === 'cancelled' ||
      terminalStatus === 'cancelled' ||
      processGroups.some((group) =>
        group.some((message) => message.role === 'assistant' && message.status === 'cancelled'),
      );
    const aborted = terminalStatus === 'aborted';
    const runningTool = runningToolTurns.has(entry.turnId);
    const thinking = thinkingTurns.has(entry.turnId);
    const completed =
      !failed &&
      !cancelled &&
      !aborted &&
      (!!finalGroup || terminalStatus === 'completed' || activity?.status === 'completed');
    // The Run owns response activity across model/tool/approval phases. A
    // temporary observation failure is not a terminal fact. Only the last
    // entry for an exact Turn carries its indicator, outside process collapse.
    const lastTurnEntry = entry === lastEntryByTurn.get(entry.turnId);
    const responding =
      lastTurnEntry &&
      !terminalStatus &&
      (activity ? isLiveTurn(activity) : active && !completed && !failed && !cancelled && !aborted);
    const finishedDuration =
      lastTurnEntry && completed
        ? turnElapsedMilliseconds(timing?.turnStartedAtMs, timing?.turnFinishedAtMs)
        : undefined;
    const responseLabel =
      active && thinking && !runningTool && (!activity || activity.status === 'running')
        ? '正在思考…'
        : '正在回复…';
    const label = !lastTurnEntry
      ? '处理过程'
      : diagnostics && !terminalStatus && activity?.executionUnconfirmed && isOngoingTurn(activity)
        ? '执行状态待核实'
        : diagnostics && !terminalStatus && activity?.unavailable
          ? '上次确认状态'
          : failed
            ? '本轮失败'
            : cancelled
              ? '已停止'
              : aborted
                ? '已中断'
                : completed
                  ? finishedDuration === undefined
                    ? '已完成'
                    : '用时'
                  : activity?.status === 'recovery_required'
                    ? '需要恢复'
                    : activity?.status === 'cancelling'
                      ? '正在停止'
                      : activity?.status === 'waiting'
                        ? '正在等待'
                        : activity?.status === 'queued'
                          ? '等待处理'
                          : '处理过程';
    const showProcess = processGroups.length > 0;
    // A settled Turn starts a new reading state even when no final reply was
    // confirmed. Its process closes once, then the reader's choice persists.
    const settled =
      !!terminalStatus ||
      !!finalGroup ||
      failureGroups.length > 0 ||
      ['completed', 'failed', 'cancelled'].includes(activity?.status ?? '');
    // Settlement regroups the final reply outside the process. Start a new
    // container so the old process cannot repaint during its exit animation.
    const turnKey = `turn:${entry.turnId}:${settled ? 'complete' : 'process'}`;
    const open = expanded[turnKey] ?? !settled;
    // Cold history and restored readings start at their full height. Replaying
    // the default-open process moves the transcript for the entire animation.
    // A later user toggle removes this marker and keeps the normal animation.
    if (restore.current && open) restoredExpanded.current.add(turnKey);
    const statusContent = (
      <span
        className="agent-turn-status-label"
        role={active && label !== '处理过程' ? 'status' : undefined}
      >
        {label}
        {lastTurnEntry && (
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
            onOpenChange={(next) => onToggle(turnKey, next)}
          >
            <div
              className="agent-turn-process"
              data-restored-expanded={restoredExpanded.current.has(turnKey) || undefined}
            >
              <div className="agent-turn-summary-row">
                <CollapsibleTrigger asChild>
                  <Button
                    className="agent-turn-summary"
                    variant="ghost"
                    aria-label={`${finishedDuration === undefined ? label : `用时 ${formatTurnElapsed(finishedDuration)}`}，${open ? '收起' : '展开'}本轮处理过程`}
                  >
                    {statusContent}
                    <HugeiconsIcon
                      className="agent-turn-chevron"
                      icon={ArrowDown01Icon}
                      aria-hidden="true"
                      data-icon="inline-end"
                    />
                  </Button>
                </CollapsibleTrigger>
              </div>
              <AnimatedCollapsibleContent className="agent-turn-content">
                <section className="agent-turn-process-messages" aria-label="本轮处理过程">
                  {processGroups.map((group) => renderGroup(group, true))}
                </section>
              </AnimatedCollapsibleContent>
            </div>
          </Collapsible>
        )}
        {!showProcess &&
          (finalGroup || failureGroups.length === 0) &&
          (!responding || label !== '处理过程') && (
            <div className="agent-turn-summary agent-turn-summary-static" role="status">
              {statusContent}
            </div>
          )}
        {finalGroup && <div className="agent-turn-final">{renderGroup(finalGroup, true)}</div>}
        {failureGroups.length > 0 && (
          <div className="agent-turn-failure">
            {failureGroups.map((group) => renderGroup(group, true))}
          </div>
        )}
        {responding && (
          <small className="response-status" role="status">
            <span className="inline-block shimmer shimmer-color-foreground shimmer-spread-[16px] shimmer-duration-1500">
              {responseLabel}
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
  return (
    <ClipboardWriteContext.Provider value={writeClipboardText}>
      <div className="conversation-container">
        <div className="conversation">
          <div
            ref={viewport}
            className="conversation-viewport"
            {...{
              role: 'region',
              'aria-label': '会话消息',
              'aria-busy': loading || busy,
              onScroll: () => {
                const element = viewport.current;
                if (!element || loading || restore.current) return;
                if (
                  writtenScrollTop.current !== undefined &&
                  Math.abs(element.scrollTop - writtenScrollTop.current) < 1
                )
                  return;
                writtenScrollTop.current = undefined;
                // Resume only at the actual bottom. A wider near-bottom zone
                // makes the following-state commit snap a manual scroll to the tail.
                // scrollTop is fractional while the two heights are rounded.
                const follow = element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
                reading.current = {
                  top: element.scrollTop,
                  follow,
                  expanded: reading.current.expanded,
                };
                setFollowing(follow);
              },
            }}
          >
            <div ref={content} className="reading-column">
              {!loading &&
                (!entries.length ? (
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
                  entries.map(renderEntry)
                ))}
              {!loading && selected && requiredSubagentWait && (
                <Marker className="mt-4" role="status">
                  <MarkerContent>正在等待子 Agent 结果</MarkerContent>
                </Marker>
              )}
            </div>
          </div>
        </div>
        {loading && (
          <div className="conversation-loading" role="status" aria-label="正在加载聊天">
            <HugeiconsIcon aria-hidden="true" data-icon="kite-loading" icon={KiteIcon} />
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
