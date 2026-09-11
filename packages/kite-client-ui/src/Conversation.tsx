import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageContent } from './MessageContent';
import { statusLabel } from './status';
import { isExploration, ToolExploration } from './ToolExploration';
import type { Message } from './types';
import { Button } from './ui';

export interface ReadingState {
  top: number;
  follow: boolean;
  expanded: Record<string, boolean>;
}

const MessageItem = memo(function MessageItem({
  message,
  expanded,
  onToggle,
  openFile,
}: {
  message: Message;
  expanded: boolean;
  onToggle: (id: string, open: boolean) => void;
  openFile?: (path: string) => void;
}) {
  if (message.role === 'thinking')
    return (
      <article className="message tool">
        <details
          open={expanded}
          onToggle={(event) => onToggle(message.id, event.currentTarget.open)}
        >
          <summary>思考过程</summary>
          <pre className="tool-output">{message.text}</pre>
        </details>
      </article>
    );
  if (message.role === 'tool') {
    const path =
      message.changedFile ??
      (message.toolName === 'read_file' && typeof message.arguments?.path === 'string'
        ? message.arguments.path
        : undefined);
    return (
      <article className={`message tool ${message.status ?? ''}`}>
        <details
          open={expanded}
          onToggle={(event) => onToggle(message.id, event.currentTarget.open)}
        >
          <summary>
            <span>{message.title || '工具执行'}</span>
            <span className="message-status">
              {message.status ? statusLabel(message.status) : ''}
            </span>
          </summary>
          {message.arguments && (
            <pre className="tool-arguments">{JSON.stringify(message.arguments, null, 2)}</pre>
          )}
          <pre className="tool-output">
            {message.text || (message.settled ? '无输出' : '正在执行工具…')}
          </pre>
          {message.toolName === 'shell_execute' && message.toolResult?.exitCode !== undefined && (
            <p>退出码 {message.toolResult.exitCode}</p>
          )}
        </details>
        {path && openFile && (
          <Button className="file-link" onClick={() => openFile(path)}>
            {path}
          </Button>
        )}
      </article>
    );
  }
  if (message.role === 'subagent')
    return (
      <article className={`message subagent ${message.status ?? ''}`}>
        <div className="message-label">
          {message.title || '未命名'} · 子 Agent
          <span className="message-status">
            {message.status ? statusLabel(message.status) : ''}
          </span>
        </div>
        {message.text && <MessageContent text={message.text} openFile={openFile} />}
        {!!message.steps?.length && (
          <details
            open={expanded}
            onToggle={(event) => onToggle(message.id, event.currentTarget.open)}
          >
            <summary>执行过程 · {message.steps.length} 项</summary>
            <ol className="subagent-steps">
              {message.steps.map((step) => (
                <li key={step.id}>
                  <span>{step.text}</span>
                  <small>
                    {step.status === 'started'
                      ? '进行中'
                      : step.status === 'completed'
                        ? '已完成'
                        : step.status === 'cancelled'
                          ? '已停止'
                          : '失败'}
                  </small>
                </li>
              ))}
            </ol>
          </details>
        )}
      </article>
    );
  if (message.role === 'system')
    return (
      <article className="message system">
        <p>{message.title}</p>
        {message.text && <pre>{message.text}</pre>}
      </article>
    );
  return (
    <article
      className={`message ${message.role}`}
      aria-label={message.role === 'user' ? '用户消息' : '助手消息'}
    >
      {message.role === 'assistant' ? (
        <MessageContent text={message.text || '正在思考…'} openFile={openFile} />
      ) : (
        <p className="user-text">{message.text}</p>
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
  emptyState,
}: {
  messages: readonly Message[];
  loading: boolean;
  selected: boolean;
  connected: boolean;
  initialReading?: ReadingState;
  saveReading: (state: ReadingState) => void;
  openFile?: (path: string) => void;
  emptyState?: { title: string; detail: string };
}) {
  const viewport = useRef<HTMLElement>(null);
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
  const toolIds = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.id.slice(5)),
  );
  const children = new Map<string, Message[]>();
  for (const message of messages) {
    if (
      message.role !== 'subagent' ||
      !message.parentToolCallId ||
      !toolIds.has(message.parentToolCallId)
    )
      continue;
    const group = children.get(message.parentToolCallId) ?? [];
    group.push(message);
    children.set(message.parentToolCallId, group);
  }
  const shown = messages.filter((message) => {
    if (message.role === 'system') return message.settled;
    if (message.role === 'subagent')
      return !message.parentToolCallId || !toolIds.has(message.parentToolCallId);
    return message.role === 'tool' || !message.settled || !!message.text;
  });
  // Contiguous explicit read-only calls share a display group; never cross a reply,
  // command, or child-owner boundary and never rewrite the underlying messages.
  const groups: Message[][] = [];
  for (const message of shown) {
    const previous = groups.at(-1);
    if (
      isExploration(message) &&
      !children.has(message.id.slice(5)) &&
      previous &&
      isExploration(previous[0]!) &&
      !children.has(previous[0]!.id.slice(5))
    )
      previous.push(message);
    else groups.push([message]);
  }
  return (
    <div className="conversation-container">
      <section
        ref={viewport}
        className="conversation"
        aria-label="会话消息"
        aria-busy={loading}
        onScroll={() => {
          const element = viewport.current;
          if (!element || loading || restore.current) return;
          const follow = element.scrollHeight - element.clientHeight - element.scrollTop < 48;
          reading.current = { top: element.scrollTop, follow, expanded: reading.current.expanded };
          setFollowing(follow);
        }}
      >
        <div className="reading-column">
          {loading ? (
            <p className="empty-list" role="status">
              正在加载会话历史…
            </p>
          ) : !shown.length ? (
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
              const explorationKey = `exploration:${message.id}`;
              return isExploration(message) && !children.has(message.id.slice(5)) ? (
                <ToolExploration
                  key={explorationKey}
                  messages={group}
                  expanded={expanded[explorationKey]}
                  onToggle={(open) => onToggle(explorationKey, open)}
                  openFile={openFile}
                />
              ) : (
                <div key={message.id} className="message-group">
                  <MessageItem
                    message={message}
                    expanded={!!expanded[message.id]}
                    onToggle={onToggle}
                    openFile={openFile}
                  />
                  {message.role === 'tool' &&
                    children
                      .get(message.id.slice(5))
                      ?.map((child) => (
                        <MessageItem
                          key={child.id}
                          message={child}
                          expanded={!!expanded[child.id]}
                          onToggle={onToggle}
                          openFile={openFile}
                        />
                      ))}
                </div>
              );
            })
          )}
        </div>
      </section>
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
