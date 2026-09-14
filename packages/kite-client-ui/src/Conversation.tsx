import { Copy01Icon, CopyCheckIcon, CopyXIcon, KiteIcon } from '@hugeicons/core-free-icons';
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

const MessageItem = memo(function MessageItem({
  message,
  expanded,
  onToggle,
  openFile,
  copyText,
  copyRole,
  writeClipboardText,
  showProcess = true,
}: {
  message: Message;
  expanded?: boolean;
  showProcess?: boolean;
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
      <article className="message tool">
        <details
          open={expanded}
          onToggle={(event) => onToggle(message.id, event.currentTarget.open)}
        >
          <summary>
            <span>思考过程</span>
            {!message.settled && (
              <span className="message-status" role="status">
                正在思考
              </span>
            )}
          </summary>
          <pre className="tool-output">{message.text}</pre>
        </details>
      </article>
    );
  if (message.role === 'tool') return null;
  if (message.role === 'subagent')
    return (
      <article className={`message subagent ${message.status ?? ''}`} aria-label="子 Agent 状态">
        <div className="message-label">
          {message.title || '未命名'} · 子 Agent
          <span className="message-status">
            {message.status ? statusLabel(message.status) : ''}
          </span>
        </div>
        {message.text && <MessageContent text={message.text} openFile={openFile} />}
        {showProcess && !!message.steps?.length && (
          <details className="subagent-process" open={expanded ?? false}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native disclosure control; the handler preserves the user's explicit choice while its parent unmounts. */}
            <summary
              aria-label={`${message.title || '子 Agent'}的执行过程`}
              onClick={(event) => {
                event.preventDefault();
                onToggle(message.id, !expanded);
              }}
            >
              执行过程 · {message.steps.length} 项
            </summary>
            <ol
              className="tool-activity-steps"
              aria-label={`${message.title || '子 Agent'}的工具步骤`}
            >
              {message.steps.map((step) => (
                <li className="tool-activity-step" key={step.id}>
                  <div className="tool-step-heading">
                    <span className="tool-step-title">{step.text}</span>
                    <span className="message-status">
                      {statusLabel(step.status === 'started' ? 'running' : step.status)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </details>
        )}
      </article>
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
  const shown = messages.filter((message) => {
    if (message.role === 'system') return message.settled || !!message.status;
    if (message.role === 'tool') return isVisibleTool(message);
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
                    onToggle={(open) => onToggle(activityKey, open)}
                    openFile={openFile}
                    renderChildren={(toolCallId, taskExpanded) =>
                      children
                        .get(toolCallId)
                        ?.map((child) => (
                          <MessageItem
                            key={child.id}
                            message={child}
                            expanded={expanded[child.id]}
                            showProcess={taskExpanded}
                            onToggle={onToggle}
                            openFile={openFile}
                          />
                        ))
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
