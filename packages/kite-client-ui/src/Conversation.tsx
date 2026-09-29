import {
  ArrowDown01Icon,
  Copy01Icon,
  CopyXIcon,
  KiteIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AnimatedCollapsibleContent,
  Collapsible,
  CollapsibleTrigger,
} from './components/ui/collapsible';
import { Marker, MarkerContent } from './components/ui/marker';
import { ScrollArea } from './components/ui/scroll-area';
import { MessageContent } from './MessageContent';
import { statusLabel } from './status';
import { ToolActivity } from './ToolActivity';
import type { Message, TurnActivity } from './types';
import { Button } from './ui';

export interface ReadingState {
  top: number;
  follow: boolean;
  expanded: Record<string, boolean>;
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
  running,
  prefix,
}: {
  startedAtMs?: number;
  finishedAtMs?: number;
  running: boolean;
  prefix: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAtMs === undefined || finishedAtMs !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAtMs, finishedAtMs]);
  const end = finishedAtMs ?? (running ? now : undefined);
  const elapsed = turnElapsedMilliseconds(startedAtMs, end);
  if (elapsed === undefined) return null;
  return (
    <span aria-hidden={running || undefined}>
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
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyAttempt = useRef(0);
  useEffect(
    () => () => {
      copyAttempt.current++;
      if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
    },
    [],
  );
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
    const attempt = ++copyAttempt.current;
    if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = undefined;
    try {
      if (writeClipboardText) await writeClipboardText(copyText);
      else await navigator.clipboard.writeText(copyText);
      if (attempt !== copyAttempt.current) return;
      setCopyState('copied');
      copyResetTimer.current = setTimeout(() => {
        copyResetTimer.current = undefined;
        setCopyState('idle');
      }, 2000);
    } catch {
      if (attempt === copyAttempt.current) setCopyState('failed');
    }
  };
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
          ['creating', 'queued', 'running', 'waiting', 'auto_reviewing'].includes(tool.status ?? '')
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
        <Marker variant="separator" role="status">
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
          data-copy-state={copyState}
          variant="ghost"
          size="icon-xs"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={copyMessage}
        >
          <HugeiconsIcon
            className={copyState === 'copied' ? 'size-[18px]' : undefined}
            icon={
              copyState === 'copied' ? Tick02Icon : copyState === 'failed' ? CopyXIcon : Copy01Icon
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
  turnActivity,
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
}: {
  messages: readonly Message[];
  loading: boolean;
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
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const reading = useRef<ReadingState>(initialReading ?? { top: 0, follow: true, expanded: {} });
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
  const shown = messages.filter((message) => {
    if (message.role === 'thinking') return false;
    if (message.systemKind === 'turn_timing' || message.systemKind === 'turn_terminal')
      return false;
    if (message.role === 'tool' && askToolIds.has(message.id.slice(5))) return false;
    if (message.role === 'system')
      return message.systemKind === 'ask' || message.settled || !!message.status;
    if (message.role === 'tool') return isVisibleTool(message);
    if (message.role === 'subagent')
      return !message.parentToolCallId || !visibleToolIds.has(message.parentToolCallId);
    return !message.settled || !!message.text;
  });
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
    [...finalReplyByTurn.values()].map((message) => [message.id, message.text]),
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
    ['queued', 'running', 'waiting', 'recovery_required', 'cancelled'].includes(
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
  const renderGroup = (group: Message[]) => {
    const message = group[0]!;
    const activityKey = `activity:${message.id}`;
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
          copyText={
            message.role === 'user' && message.settled && !message.delivery && message.text
              ? message.text
              : assistantTurnCopies.get(message.id)
          }
          copyRole={message.role === 'user' ? 'user' : 'assistant'}
        />
      </div>
    );
  };
  const renderEntry = (entry: (typeof entries)[number]) => {
    if (!entry.turnId) return <Fragment key={entry.key}>{entry.groups.map(renderGroup)}</Fragment>;
    const finalGroup = entry.groups.find(
      ([message]) => message?.role === 'assistant' && message.settled && message.finalReply,
    );
    const processGroups = entry.groups.filter((group) => group !== finalGroup);
    const activity = turnActivity?.turnId === entry.turnId ? turnActivity : undefined;
    const timing = timingByTurn.get(entry.turnId);
    const terminalStatus = terminalByTurn.get(entry.turnId);
    const active =
      !terminalStatus &&
      (activity
        ? ['queued', 'running', 'waiting', 'recovery_required'].includes(activity.status)
        : !turnActivity &&
          processGroups.some((group) => group.some((message) => !message.settled)));
    const failed =
      activity?.status === 'failed' ||
      terminalStatus === 'failed' ||
      processGroups.some((group) =>
        group.some(
          (message) =>
            message.role === 'system' &&
            message.status === 'failed' &&
            message.id === `failure:${entry.turnId}`,
        ),
      );
    const cancelled =
      activity?.status === 'cancelled' ||
      terminalStatus === 'cancelled' ||
      processGroups.some((group) =>
        group.some((message) => message.role === 'assistant' && message.status === 'cancelled'),
      );
    const aborted = terminalStatus === 'aborted';
    const runningTool = messages.some(
      (message) => message.turnId === entry.turnId && message.role === 'tool' && !message.settled,
    );
    const thinking = messages.some(
      (message) =>
        message.turnId === entry.turnId && message.role === 'thinking' && !message.settled,
    );
    const completed =
      !failed &&
      !cancelled &&
      !aborted &&
      (!!finalGroup || terminalStatus === 'completed' || activity?.status === 'completed');
    const finishedDuration = completed
      ? turnElapsedMilliseconds(timing?.turnStartedAtMs, timing?.turnFinishedAtMs)
      : undefined;
    const runningTimer =
      !completed &&
      !terminalStatus &&
      ['running', 'waiting'].includes(activity?.status ?? '') &&
      turnElapsedMilliseconds(timing?.turnStartedAtMs, Date.now()) !== undefined;
    const label = failed
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
              : activity?.status === 'waiting'
                ? '正在等待'
                : activity?.status === 'queued'
                  ? '等待处理'
                  : active && thinking && !runningTool
                    ? '正在思考'
                    : active
                      ? runningTimer
                        ? '已处理'
                        : '正在处理'
                      : '处理过程';
    const showProcess = processGroups.length > 0 || active || cancelled || aborted;
    // A settled Turn starts a new reading state even when no final reply was
    // confirmed. Its process closes once, then the reader's choice persists.
    const settled =
      !!terminalStatus ||
      !!finalGroup ||
      ['completed', 'failed', 'cancelled'].includes(activity?.status ?? '');
    const turnKey = `turn:${entry.turnId}:${settled ? 'complete' : 'process'}`;
    const open = expanded[turnKey] ?? !settled;
    const elapsedPrefix =
      finishedDuration !== undefined || (runningTimer && label === '已处理')
        ? ' '
        : runningTimer
          ? ' · 已处理 '
          : ' · 用时 ';
    const statusContent = (
      <span className="agent-turn-status-label" role={active ? 'status' : undefined}>
        {label}
        <TurnElapsed
          startedAtMs={timing?.turnStartedAtMs}
          finishedAtMs={timing?.turnFinishedAtMs}
          running={runningTimer}
          prefix={elapsedPrefix}
        />
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
          <Collapsible asChild open={open} onOpenChange={(next) => onToggle(turnKey, next)}>
            <div className="agent-turn-process">
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
                  {processGroups.map(renderGroup)}
                </section>
              </AnimatedCollapsibleContent>
            </div>
          </Collapsible>
        )}
        {!showProcess && finalGroup && (
          <div className="agent-turn-summary agent-turn-summary-static" role="status">
            {statusContent}
          </div>
        )}
        {finalGroup && <div className="agent-turn-final">{renderGroup(finalGroup)}</div>}
      </section>
    );
  };
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
            ['queued', 'running', 'waiting'].includes(turnActivity?.status ?? '') ||
            messages.some(
              (message) =>
                message.systemKind !== 'turn_timing' &&
                (message.delivery === 'sending' ||
                  ((message.role === 'assistant' ||
                    message.role === 'tool' ||
                    message.role === 'subagent' ||
                    message.role === 'thinking' ||
                    message.role === 'system') &&
                    !message.settled)),
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
