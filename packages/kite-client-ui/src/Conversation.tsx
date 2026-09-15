import {
  ArrowDown01Icon,
  BulbIcon,
  Copy01Icon,
  CopyCheckIcon,
  CopyXIcon,
  KiteIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ScrollArea } from './components/ui/scroll-area';
import { MessageContent } from './MessageContent';
import { statusLabel } from './status';
import { ToolActivity } from './ToolActivity';
import type { Message } from './types';
import { Button } from './ui';

export interface ReadingState {
  top: number;
  follow: boolean;
  expanded: Record<string, boolean>;
}

function isVisibleTool(message: Message): boolean {
  if (message.role !== 'tool') return false;
  if (message.presentation !== 'hidden') return true;
  if (message.presentationOwner) return false;
  return (
    message.status === 'failed' ||
    message.status === 'rejected' ||
    message.status === 'cancelled' ||
    message.status === 'unknown'
  );
}

function ThinkingLabel({ message }: { message: Message }) {
  const [now, setNow] = useState(Date.now);
  const startedAt = message.thinkingStartedAt;
  useEffect(() => {
    if (message.settled || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [message.settled, startedAt]);
  const end = message.settled ? message.thinkingEndedAt : now;
  const seconds =
    startedAt !== undefined && end !== undefined
      ? Math.max(0, Math.floor((end - startedAt) / 1000))
      : undefined;
  return (
    <span className="tool-label">
      {message.settled ? '已思考' : '思考中'}
      {seconds !== undefined && ` · ${seconds} 秒`}
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
}: {
  message: Message;
  expanded?: boolean;
  showProcess?: boolean;
  inlineProcess?: boolean;
  onToggle: (id: string, open: boolean) => void;
  openFile?: (path: string) => void;
  copyText?: string;
  copyRole?: 'user' | 'assistant';
  writeClipboardText?: (text: string) => Promise<void>;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyLabel =
    copyState === 'copied'
      ? '已复制消息'
      : copyState === 'failed'
        ? '复制失败，请重试'
        : copyRole === 'user'
          ? '复制本轮用户消息'
          : '复制本轮Agent回复';
  const copyMessage = async () => {
    if (!copyText) return;
    try {
      if (writeClipboardText) await writeClipboardText(copyText);
      else await navigator.clipboard.writeText(copyText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  if (message.role === 'thinking')
    return (
      <article
        className={`message tool-activity thinking-activity${!message.settled ? ' is-running' : ''}`}
      >
        <details
          open={expanded}
          onToggle={(event) => onToggle(message.id, event.currentTarget.open)}
        >
          <summary className="tool-activity-summary">
            <HugeiconsIcon className="tool-activity-kind-icon" icon={BulbIcon} />
            <ThinkingLabel message={message} />
            <HugeiconsIcon className="tool-activity-chevron" icon={ArrowDown01Icon} />
          </summary>
          <pre className="tool-output">{message.text.trimEnd()}</pre>
        </details>
      </article>
    );
  if (message.role === 'tool') return null;
  if (message.role === 'subagent') {
    if (!showProcess) return null;
    const steps = (message.steps ?? []).map((step) => (
      <div
        className={`tool-activity-step ${step.status === 'started' ? 'running' : step.status}`}
        key={step.id}
      >
        <span className="tool-step-title tool-label">{step.text}</span>
        <span className="tool-step-status" data-status={step.status}>
          {step.status === 'completed'
            ? ''
            : statusLabel(step.status === 'started' ? 'running' : step.status)}
        </span>
      </div>
    ));
    // Child prose/results belong to the task result; the parent transcript shows tool activity only.
    if (inlineProcess)
      return (
        // biome-ignore lint/a11y/useSemanticElements: this is a group of tool records, not form controls.
        <div
          role="group"
          className="subagent-process"
          aria-label={`${message.title || '子 Agent'}的工具步骤`}
        >
          {steps}
        </div>
      );
    return (
      <ToolActivity
        messages={[
          {
            ...message,
            role: 'tool',
            toolName: 'task',
            title: '运行子 Agent',
            arguments: { name: message.title },
            text: '',
          },
        ]}
        expanded={expanded}
        onToggle={(open) => onToggle(message.id, open)}
        openFile={openFile}
        renderChildren={() => steps}
      />
    );
  }
  if (message.systemKind === 'compaction')
    return (
      <article className={`message context-compacted ${message.status ?? ''}`}>
        <div role="status">
          <span aria-hidden="true" />
          <span className="tool-label">{message.title}</span>
          <span aria-hidden="true" />
        </div>
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
        onToggle={(open) => onToggle(message.id, open)}
        renderChildren={() => null}
      />
    );
  if (message.role === 'system')
    return (
      <article className={`message system ${message.status ?? ''}`}>
        <p>
          {message.title}
          {message.status && <span className="message-status">{statusLabel(message.status)}</span>}
        </p>
        {message.text && <pre>{message.text}</pre>}
      </article>
    );
  return (
    <article
      className={`message ${message.role}${message.delivery ? ` ${message.delivery}` : ''}${
        message.role === 'assistant' && !message.settled ? ' responding' : ''
      }`}
      data-final-reply={message.role === 'assistant' ? Boolean(message.finalReply) : undefined}
      aria-label={message.role === 'user' ? '用户消息' : '助手消息'}
    >
      {message.role === 'assistant' ? (
        <>
          {message.text && <MessageContent text={message.text} openFile={openFile} />}
          {!message.settled && (
            <small className="response-status" role="status">
              正在回复…
            </small>
          )}
        </>
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
      {copyText && (
        <Button
          className="message-copy"
          variant="ghost"
          size="icon-xs"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={copyMessage}
        >
          <HugeiconsIcon
            icon={
              copyState === 'copied'
                ? CopyCheckIcon
                : copyState === 'failed'
                  ? CopyXIcon
                  : Copy01Icon
            }
          />
        </Button>
      )}
    </article>
  );
});

export function Conversation({
  messages,
  loading,
  selected,
  connected,
  initialReading,
  saveReading,
  openFile,
  writeClipboardText,
  emptyState,
}: {
  messages: readonly Message[];
  loading: boolean;
  selected: boolean;
  connected: boolean;
  initialReading?: ReadingState;
  saveReading: (state: ReadingState) => void;
  openFile?: (path: string) => void;
  writeClipboardText?: (text: string) => Promise<void>;
  emptyState?: { title: string; detail: string };
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const reading = useRef<ReadingState>(initialReading ?? { top: 0, follow: true, expanded: {} });
  const restore = useRef(true);
  const [following, setFollowing] = useState(reading.current.follow);
  const [expanded, setExpanded] = useState(reading.current.expanded);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const document = element.ownerDocument;
    const selectMessages = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'a'
      )
        return;
      const target = event.target instanceof document.defaultView!.Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])'))
        return;
      if (element.closest('[hidden]') || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      const column = element.querySelector('.reading-column');
      const selection = document.getSelection();
      if (!column || !selection) return;
      const walker = document.createTreeWalker(column, 4 /* SHOW_TEXT */);
      let first: Text | undefined;
      let last: Text | undefined;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (
          !node.textContent?.trim() ||
          !parent?.closest('.message') ||
          parent.closest(
            'button, summary, .message-label, .message-status, [hidden], details:not([open])',
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
  useLayoutEffect(() => () => save.current(reading.current), []);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || loading || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!reading.current.follow || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (reading.current.follow) element.scrollTop = element.scrollHeight;
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [loading]);
  // After each content/layout commit, follow only while the reader is at the bottom.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || loading) {
      restore.current = true;
      return;
    }
    if (restore.current || reading.current.follow) {
      element.scrollTop = reading.current.follow ? element.scrollHeight : reading.current.top;
      restore.current = false;
    }
  });
  const onToggle = useRef((id: string, open: boolean) => {
    setExpanded((values) => (values[id] === open ? values : { ...values, [id]: open }));
  }).current;
  const visibleToolIds = new Set(
    messages.filter(isVisibleTool).map((message) => message.id.slice(5)),
  );
  const allToolIds = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.id.slice(5)),
  );
  const children = new Map<string, Message[]>();
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
  for (const message of messages) {
    if (
      message.role !== 'tool' ||
      message.presentation !== 'hidden' ||
      !message.presentationOwner ||
      !visibleToolIds.has(message.presentationOwner.parentToolCallId)
    )
      continue;
    const owner = message.presentationOwner.parentToolCallId;
    children.set(owner, [...(children.get(owner) ?? []), message]);
  }
  const askToolIds = new Set(
    messages
      .filter((message) => message.systemKind === 'ask')
      .map((message) => message.ask?.toolCallId)
      .filter(Boolean),
  );
  const shown = messages.filter((message) => {
    if (message.role === 'tool' && askToolIds.has(message.id.slice(5))) return false;
    if (message.role === 'system') return message.settled || !!message.status;
    if (message.role === 'tool')
      return (
        isVisibleTool(message) ||
        (!!message.presentationOwner &&
          !visibleToolIds.has(message.presentationOwner.parentToolCallId))
      );
    if (message.role === 'subagent')
      return !message.parentToolCallId || !visibleToolIds.has(message.parentToolCallId);
    return !message.settled || !!message.text;
  });
  const finalReplyByTurn = new Map<string, Message>();
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
    [...finalReplyByTurn.values()].map((message) => [message.id, message.text]),
  );
  // Contiguous tool calls share one visual activity without rewriting runtime facts.
  const groups: Message[][] = [];
  for (const message of shown) {
    const previous = groups.at(-1);
    if (
      message.role === 'tool' &&
      message.presentation === 'exploration' &&
      message.presentationGroupId &&
      previous?.[0]?.role === 'tool' &&
      previous[0].presentation === 'exploration' &&
      previous[0].presentationGroupId === message.presentationGroupId &&
      previous[0].turnId === message.turnId
    )
      previous.push(message);
    else groups.push([message]);
  }
  return (
    <div className="conversation-container">
      <ScrollArea
        className="conversation"
        viewportRef={viewport}
        viewportClassName="conversation-viewport"
        viewportProps={{
          role: 'region',
          'aria-label': '会话消息',
          'aria-busy':
            loading ||
            messages.some(
              (message) =>
                message.delivery === 'sending' ||
                ((message.role === 'assistant' ||
                  message.role === 'tool' ||
                  message.role === 'subagent' ||
                  message.role === 'thinking' ||
                  message.role === 'system') &&
                  !message.settled),
            ),
          onScroll: () => {
            const element = viewport.current;
            if (!element || loading || restore.current) return;
            const follow = element.scrollHeight - element.clientHeight - element.scrollTop < 48;
            reading.current = {
              top: element.scrollTop,
              follow,
              expanded: reading.current.expanded,
            };
            setFollowing(follow);
          },
        }}
      >
        <div className="reading-column">
          {!loading &&
            (!shown.length ? (
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
              groups.map((group) => {
                const message = group[0]!;
                const activityKey = `activity:${message.id}`;
                return message.role === 'tool' ? (
                  <ToolActivity
                    key={activityKey}
                    messages={group}
                    expanded={expanded[activityKey]}
                    expandedItems={expanded}
                    onToggleItem={onToggle}
                    onToggle={(open) => onToggle(activityKey, open)}
                    openFile={openFile}
                    renderChildren={(toolCallId, taskExpanded) =>
                      children.get(toolCallId)?.map((child) =>
                        child.role === 'tool' ? (
                          <ToolActivity
                            key={child.id}
                            messages={[child]}
                            expanded={expanded[child.id]}
                            onToggle={(open) => onToggle(child.id, open)}
                            openFile={openFile}
                            renderChildren={() => null}
                          />
                        ) : (
                          <MessageItem
                            key={child.id}
                            message={{
                              ...child,
                              steps: child.steps?.filter(
                                (step) =>
                                  !step.toolCallId ||
                                  !messages.some(
                                    (tool) =>
                                      tool.role === 'tool' &&
                                      tool.id === `tool:${step.toolCallId}` &&
                                      tool.presentationOwner?.parentToolCallId === toolCallId,
                                  ),
                              ),
                            }}
                            inlineProcess
                            expanded={expanded[child.id]}
                            showProcess={taskExpanded}
                            onToggle={onToggle}
                            openFile={openFile}
                          />
                        ),
                      )
                    }
                  />
                ) : (
                  <div key={message.id} className="message-group">
                    <MessageItem
                      message={message}
                      expanded={expanded[message.id]}
                      onToggle={onToggle}
                      openFile={openFile}
                      writeClipboardText={writeClipboardText}
                      copyText={
                        message.role === 'user' &&
                        message.settled &&
                        !message.delivery &&
                        message.text
                          ? message.text
                          : assistantTurnCopies.get(message.id)
                      }
                      copyRole={message.role === 'user' ? 'user' : 'assistant'}
                    />
                  </div>
                );
              })
            ))}
        </div>
      </ScrollArea>
      {loading && (
        <div className="conversation-loading" role="status" aria-label="正在加载聊天">
          <HugeiconsIcon aria-hidden="true" data-icon="kite-loading" icon={KiteIcon} />
        </div>
      )}
      {!following && !loading && (
        <Button
          className="jump-latest"
          onClick={() => {
            const element = viewport.current;
            if (!element) return;
            element.scrollTop = element.scrollHeight;
            reading.current = { ...reading.current, follow: true, top: element.scrollTop };
            setFollowing(true);
          }}
        >
          回到最新消息
        </Button>
      )}
    </div>
  );
}
