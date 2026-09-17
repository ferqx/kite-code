import {
  ArrowDown01Icon,
  BookOpen01Icon,
  BotIcon,
  Edit02Icon,
  File01Icon,
  FileSearchIcon,
  Folder01Icon,
  Globe02Icon,
  Search01Icon,
  TerminalIcon,
  UserQuestion01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
import { Marker, MarkerContent, MarkerIcon } from './components/ui/marker';
import { FileDiff } from './FileChanges';
import { childStatusLabel, statusLabel } from './status';
import type { Message } from './types';
import { Button } from './ui';

const TOOL_LABELS: Record<string, string> = {
  ask_user: '询问用户',
  edit_file: '修改',
  glob: '查找文件',
  list_mcp_resources: '列出 MCP 资源',
  list_mcp_tools: '列出 MCP 工具',
  mcp_tool: '运行 MCP 工具',
  read_file: '读取',
  read_mcp_resource: '读取 MCP 资源',
  request_plan_review: '请求计划审阅',
  search_content: '搜索内容',
  search_files: '搜索文件',
  shell_execute: '运行',
  skill: '使用 Skill',
  task: '运行子 Agent 任务',
  tool_search: '搜索工具',
  update_plan: '更新计划',
  web_fetch: '读取网页',
  write_file: '写入',
  write_plan: '编写计划',
};

function toolTitle(message: Message): string {
  if (
    message.toolName &&
    ['read_file', 'edit_file', 'write_file', 'shell_execute'].includes(message.toolName)
  )
    return TOOL_LABELS[message.toolName]!;
  const title = message.title?.trim();
  if (title && title !== message.toolName) return title;
  return (
    (message.toolName && TOOL_LABELS[message.toolName]) || title || message.toolName || '工具执行'
  );
}

function toolTarget(message: Message): string | undefined {
  const argument = (name: string) =>
    typeof message.arguments?.[name] === 'string' ? message.arguments[name] : undefined;
  if (message.changedFile) return message.changedFile;
  switch (message.toolName) {
    case 'read_file':
    case 'edit_file':
    case 'write_file':
      return argument('path');
    case 'search_content':
    case 'search_files':
    case 'glob':
      return argument('pattern');
    case 'web_fetch':
      return argument('url');
    case 'shell_execute':
      return argument('command');
    case 'write_plan':
    case 'update_plan':
    case 'request_plan_review':
      return argument('title') ?? argument('plan_id');
    case 'ask_user':
      return argument('title') ?? argument('question');
    case 'tool_search':
      return argument('query');
    case 'list_mcp_resources':
      return argument('server');
    case 'list_mcp_tools':
      return argument('provider');
    case 'read_mcp_resource': {
      const server = argument('server');
      const uri = argument('uri');
      return [server, uri].filter(Boolean).join(' · ') || undefined;
    }
    case 'mcp_tool':
      return argument('tool') ?? argument('name') ?? argument('server');
    case 'skill':
      return argument('skill_id') ?? argument('path') ?? argument('activation_id');
    case 'task':
      return argument('name') ?? argument('subagent_type');
    default:
      return undefined;
  }
}

function resultPreview(message: Message, showReadFailure = false): string | undefined {
  if (message.status === 'cancelled') return undefined;
  if (message.approval?.reason && ['rejected', 'awaiting_user'].includes(message.approval.state))
    return message.approval.reason;
  if (message.toolName === 'read_file' && !(showReadFailure && message.status === 'failed'))
    return undefined;
  if (message.toolResult?.terminationReason === 'timed_out') return '执行超时';
  if (message.toolResult?.terminationReason === 'cancelled') return '执行已取消';
  if (message.toolResult?.terminationReason === 'sandbox_denied') return '执行被沙箱拒绝';
  const output = message.toolResult ?? message.toolProgress;
  const source = output
    ? message.status === 'failed'
      ? output.stderr || output.stdout || message.text
      : output.stdout || output.stderr || message.text
    : message.text;
  const line = source
    ?.split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}

function toolIcon(message: Message) {
  switch (message.toolName) {
    case 'read_file':
    case 'read_mcp_resource':
      return BookOpen01Icon;
    case 'search_content':
    case 'tool_search':
    case 'list_mcp_tools':
      return Search01Icon;
    case 'search_files':
    case 'glob':
      return FileSearchIcon;
    case 'shell_execute':
      return TerminalIcon;
    case 'edit_file':
    case 'write_file':
      return Edit02Icon;
    case 'web_fetch':
      return Globe02Icon;
    case 'task':
      return BotIcon;
    case 'ask_user':
      return UserQuestion01Icon;
    case 'list_mcp_resources':
      return Folder01Icon;
    case 'write_plan':
    case 'update_plan':
    case 'request_plan_review':
      return File01Icon;
    default:
      return Wrench01Icon;
  }
}

function activitySummary(messages: readonly Message[]) {
  if (messages.length === 1) return toolTitle(messages[0]!);
  const reads = messages.filter((message) => message.toolName === 'read_file').length;
  const searches = messages.filter(
    (message) => message.toolName === 'search_content' || message.toolName === 'search_files',
  ).length;
  const other = messages.length - reads - searches;
  const parts = [
    reads && `读取 ${reads} 次`,
    searches && `搜索 ${searches} 次`,
    other && `执行 ${other} 项`,
  ].filter(Boolean);
  return parts.join(' · ') || `${messages.length} 项工具操作`;
}

function stoppedDuringAutoReview(message: Message): boolean {
  return (
    message.settled &&
    message.status === 'cancelled' &&
    message.approval?.source === 'auto' &&
    message.approval.state === 'reviewing' &&
    !message.toolProgress &&
    !message.toolResult
  );
}

function approvalLabel(message: Message): string | undefined {
  const approval = message.approval;
  if (!approval) return;
  switch (approval.state) {
    case 'reviewing':
      return message.settled ? '自动审批已停止' : '正在自动审批';
    case 'awaiting_user':
      return message.settled ? undefined : '等待人工审批';
    case 'rejected':
      return approval.source === 'auto' ? '自动审批未通过' : '人工审批已拒绝';
    case 'approved':
      return approval.source === 'auto'
        ? '已自动批准'
        : approval.grant === 'same_command'
          ? '已人工批准 · 本会话相同命令'
          : '已人工批准';
  }
}

function executionLabel(message: Message) {
  if (message.toolName === 'task' && message.childLifecycle)
    return childStatusLabel(message.childLifecycle);
  if (stoppedDuringAutoReview(message)) return '未执行';
  if (message.approval?.state === 'reviewing' && !message.settled) return '';
  if (message.approval?.state === 'awaiting_user' && !message.settled) return '等待人工审批';
  if (message.approval?.state === 'rejected') return '未执行';
  if (message.toolResult?.terminationReason === 'timed_out') return '执行超时';
  return message.status === 'completed'
    ? '成功'
    : message.status === 'queued'
      ? '等待执行'
      : message.status
        ? statusLabel(message.status)
        : '结果未知';
}

function ShellOutput({ message }: { message: Message }) {
  const viewport = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const result = message.toolResult;
  const stdout = result?.stdout ?? message.toolProgress?.stdout;
  const stderr = result?.stderr ?? message.toolProgress?.stderr;
  const streams = [stdout, stderr].filter(Boolean).join('\n');
  const lineCount = (text: string | undefined) =>
    text ? text.replace(/\r?\n$/, '').split('\n').length : 0;
  const truncated =
    result?.totalLines !== undefined && result.totalLines > lineCount(stdout) + lineCount(stderr);
  const stoppedBeforeExecution = stoppedDuringAutoReview(message);
  const reason =
    message.approval?.state === 'rejected' || message.approval?.state === 'awaiting_user'
      ? message.approval.reason
      : undefined;
  const output = stoppedBeforeExecution
    ? '任务在自动审批期间停止，命令未开始执行。'
    : reason ||
      streams ||
      (message.status === 'completed'
        ? '命令执行成功，无输出。'
        : message.status === 'cancelled'
          ? '命令已停止。'
          : message.text);
  // biome-ignore lint/correctness/useExhaustiveDependencies: output commits change the scroll height.
  useLayoutEffect(() => {
    if (follow.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [output]);
  return (
    <div className="shell-output" data-status={message.status}>
      {/* biome-ignore lint/a11y/useSemanticElements: keep preformatted output as the named scroll region. */}
      <pre
        role="region"
        ref={viewport}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: allow keyboard scrolling of output.
        tabIndex={0}
        aria-label="Shell 执行输出"
        onScroll={() => {
          const node = viewport.current!;
          follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24;
          setFollowing(follow.current);
        }}
      >
        {output || '等待输出…'}
        {streams &&
        ['cancelled', 'failed', 'rejected'].includes(message.status ?? '') &&
        message.text &&
        message.text !== 'Tool execution cancelled.' &&
        !streams.includes(message.text)
          ? `\n${message.text}`
          : ''}
      </pre>
      <span className="shell-result" role="status">
        {executionLabel(message)}
        {result?.exitCode !== undefined ? ` · 退出码 ${result.exitCode}` : ''}
        {truncated ? ' · 输出已截断' : ''}
        {result?.status === 'exhausted' ? ' · 输出已达到工具限制' : ''}
      </span>
      {!following && (
        <Button
          variant="ghost"
          className="shell-latest"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
          }}
        >
          回到最新输出
        </Button>
      )}
    </div>
  );
}

export function ToolRow({
  message,
  openFile,
  showReadFailure,
}: {
  message: Message;
  openFile?: (path: string) => void;
  showReadFailure?: boolean;
}) {
  const target = toolTarget(message);
  const file = ['read_file', 'edit_file', 'write_file'].includes(message.toolName ?? '');
  const approval = approvalLabel(message);
  const status = executionLabel(message);
  return (
    <Marker
      className={`tool-activity-step ${!message.settled && message.approval?.state === 'reviewing' ? 'running' : (message.status ?? '')}`}
    >
      <MarkerIcon className="tool-step-marker-icon">
        <HugeiconsIcon className="tool-step-icon" icon={toolIcon(message)} />
      </MarkerIcon>
      <MarkerContent className="tool-step-content">
        <span className="tool-step-heading">
          <span className="tool-step-title tool-label">{toolTitle(message)}</span>
          {target && (
            <span className="tool-step-target">
              {file && openFile ? (
                <Button className="file-link" onClick={() => openFile(target)}>
                  {target}
                </Button>
              ) : (
                target
              )}
            </span>
          )}
          {approval && (
            <span className="tool-approval" role="status">
              {approval}
            </span>
          )}
          {status &&
            status !== '成功' &&
            status !== approval &&
            (message.status !== 'running' || message.childLifecycle) && (
              <span
                className="tool-step-status"
                data-status={message.childLifecycle ?? message.status}
              >
                {status}
              </span>
            )}
        </span>
        {(message.approval?.state === 'awaiting_user' ||
          ['failed', 'rejected', 'cancelled', 'unknown'].includes(message.status ?? '')) &&
          resultPreview(message, showReadFailure) && (
            <span className="tool-step-preview" title={resultPreview(message, showReadFailure)}>
              {resultPreview(message, showReadFailure)}
            </span>
          )}
      </MarkerContent>
    </Marker>
  );
}

export function ToolActivity({
  messages,
  expanded,
  onToggle,
  openFile,
  renderChildren,
  suppressGenericFailure,
  expandedItems,
  onToggleItem,
  childProcess = false,
}: {
  expandedItems?: Readonly<Record<string, boolean>>;
  onToggleItem?: (id: string, open: boolean) => void;
  messages: readonly Message[];
  expanded?: boolean;
  onToggle: (open: boolean) => void;
  openFile?: (path: string) => void;
  renderChildren: (toolCallId: string, expanded: boolean) => ReactNode;
  suppressGenericFailure?: boolean;
  childProcess?: boolean;
}) {
  const message = messages[0]!;
  let ask = message.ask;
  if (!ask && message.toolName === 'ask_user' && message.toolResult?.stdout) {
    try {
      const result: unknown = JSON.parse(message.toolResult.stdout);
      if (
        result &&
        typeof result === 'object' &&
        'answer' in result &&
        typeof result.answer === 'string'
      )
        ask = { questions: [], summary: result.answer };
    } catch {
      /* A tool failure is not an answered question. */
    }
  }
  const askMultiple = !!ask && ask.questions.length > 1;
  const grouped = messages.length > 1;
  const shell = !grouped && message.toolName === 'shell_execute';
  const read =
    !grouped &&
    ['read_file', 'search_content', 'search_files', 'glob', 'read_mcp_resource'].includes(
      message.toolName ?? '',
    );
  const edit = !grouped && ['edit_file', 'write_file'].includes(message.toolName ?? '');
  const active = messages.some((item) => !item.settled);
  const running = messages.some((item) =>
    item.childLifecycle
      ? item.childLifecycle === 'creating' || item.childLifecycle === 'running'
      : !item.settled && item.status === 'running',
  );
  const issues = messages.filter((item) =>
    ['failed', 'rejected', 'unknown'].includes(item.status ?? ''),
  );
  const childIssue = childProcess && issues.length > 0;
  const open = expanded ?? (grouped && active);
  const children = messages.map((item) => renderChildren(item.id.slice(5), true));
  const approval = approvalLabel(message);
  const pendingReview =
    !message.childLifecycle && !message.settled && message.approval?.state === 'reviewing';
  const hasDiff = edit && message.changeConfirmed && !!message.toolResult;
  const canExpand =
    (!read || childIssue) &&
    (!edit || hasDiff || childIssue) &&
    !pendingReview &&
    (grouped ||
      shell ||
      hasDiff ||
      !!ask ||
      message.toolName === 'task' ||
      !!message.text ||
      children.some(Boolean));
  const label = grouped
    ? activitySummary(messages)
    : ask
      ? askMultiple
        ? `询问用户 · ${message.status === 'completed' ? '已回答 ' : ''}${ask.questions.length} 项`
        : '询问用户'
      : toolTitle(message);
  const target = ask
    ? !askMultiple
      ? ask.questions[0]?.question
      : undefined
    : !grouped
      ? toolTarget(message)
      : undefined;
  const status =
    ask && message.status === 'cancelled'
      ? open
        ? undefined
        : '已取消'
      : grouped
        ? undefined
        : executionLabel(message);
  const heading = (
    <>
      <MarkerIcon className="tool-activity-marker-icon">
        <HugeiconsIcon
          className="tool-activity-kind-icon"
          icon={grouped ? Search01Icon : toolIcon(message)}
        />
      </MarkerIcon>
      <MarkerContent className="tool-activity-marker-content">
        <span className="tool-activity-title tool-label">{label}</span>
        {target &&
          (shell ? (
            <code className="tool-command tool-label">{target}</code>
          ) : (
            <span className="tool-step-target">{ask ? `· ${target}` : target}</span>
          ))}
      </MarkerContent>
      {canExpand && <HugeiconsIcon className="tool-activity-chevron" icon={ArrowDown01Icon} />}
      {approval && (
        <span className="tool-approval" role="status">
          {approval}
        </span>
      )}
      {status && (grouped || !shell || !open) && status !== '成功' && status !== approval && (
        <span
          className="tool-activity-state"
          data-status={
            message.childLifecycle
              ? ['failed', 'interrupted', 'cancelled'].includes(message.childLifecycle)
                ? 'issue'
                : 'neutral'
              : issues.length
                ? 'issue'
                : 'neutral'
          }
          role="status"
        >
          {status}
        </span>
      )}
      {!childProcess &&
        !open &&
        !grouped &&
        !shell &&
        !read &&
        !edit &&
        issues.length > 0 &&
        !(suppressGenericFailure && message.text === 'Tool execution failed.') &&
        resultPreview(message) && (
          <span className="tool-step-preview" title={resultPreview(message)}>
            {resultPreview(message)}
          </span>
        )}
    </>
  );
  return (
    <Collapsible asChild open={Boolean(open && canExpand)} onOpenChange={onToggle}>
      <article
        className={`message tool-activity${shell ? ' shell-activity' : ''}${running || pendingReview ? ' is-running' : ''}`}
        aria-label={`${label}${status ? ` · ${status}` : ''}`}
      >
        {read && !childIssue ? (
          <ToolRow message={message} openFile={openFile} />
        ) : edit && !childIssue ? (
          <Marker className="tool-activity-summary tool-edit-heading">
            <MarkerIcon className="tool-activity-marker-icon">
              <HugeiconsIcon className="tool-activity-kind-icon" icon={toolIcon(message)} />
            </MarkerIcon>
            <MarkerContent className="tool-activity-marker-content">
              <span className="tool-label">{label}</span>
              {target &&
                (openFile ? (
                  <Button className="file-link" onClick={() => openFile(target)}>
                    {target}
                  </Button>
                ) : (
                  <span className="tool-step-target">{target}</span>
                ))}
            </MarkerContent>
            {hasDiff && (
              <Button
                variant="ghost"
                className="tool-diff-toggle"
                aria-label={`${open ? '收起' : '展开'} ${target ?? '文件'} 的差异`}
                aria-expanded={open}
                onClick={() => onToggle(!open)}
              >
                <HugeiconsIcon icon={ArrowDown01Icon} />
              </Button>
            )}
            {approval && (
              <span className="tool-approval" role="status">
                {approval}
              </span>
            )}
            {status &&
              status !== '成功' &&
              status !== approval &&
              (message.status !== 'running' || message.childLifecycle) && (
                <span className="tool-step-status" data-status={message.status}>
                  {status}
                </span>
              )}
            {!hasDiff &&
              (issues.length > 0 || message.approval?.state === 'awaiting_user') &&
              resultPreview(message) && (
                <span className="tool-step-preview" title={resultPreview(message)}>
                  {resultPreview(message)}
                </span>
              )}
          </Marker>
        ) : canExpand ? (
          <CollapsibleTrigger asChild>
            <Marker asChild className="tool-activity-summary">
              <Button variant="ghost">{heading}</Button>
            </Marker>
          </CollapsibleTrigger>
        ) : (
          <Marker className="tool-activity-summary">{heading}</Marker>
        )}
        <CollapsibleContent className="tool-activity-content">
          <div className="tool-activity-reveal">
            <div className="tool-activity-reveal-inner">
              {grouped && (
                <div className="tool-activity-steps">
                  {messages.map((item) =>
                    item.toolName === 'shell_execute' ? (
                      <ToolActivity
                        key={item.id}
                        messages={[item]}
                        expanded={expandedItems?.[item.id]}
                        onToggle={(next) => onToggleItem?.(item.id, next)}
                        openFile={openFile}
                        renderChildren={renderChildren}
                      />
                    ) : (
                      <ToolRow key={item.id} message={item} openFile={openFile} />
                    ),
                  )}
                </div>
              )}
              {shell && <ShellOutput message={message} />}
              {hasDiff && <FileDiff message={message} />}
              {ask && (
                <div className="tool-ask-answers">
                  {message.status === 'cancelled' ? (
                    <span>已取消</span>
                  ) : askMultiple ? (
                    ask.questions.map((question, index) => (
                      <div className="tool-ask-answer" key={question.id}>
                        <span className="tool-ask-prefix">{index + 1}. </span>
                        <span className="tool-ask-text">
                          {question.question.replace(/[：:]\s*$/, '')}：
                          {ask.answers?.[question.id] ?? '尚未回答'}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="tool-ask-answer">
                      <span className="tool-ask-prefix">回答：</span>
                      <span className="tool-ask-text">
                        {ask.answers?.[ask.questions[0]?.id ?? ''] ?? ask.summary ?? '尚未回答'}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {!grouped &&
                !ask &&
                !shell &&
                (!edit || childIssue) &&
                (!read || childIssue) &&
                message.toolName !== 'task' &&
                !(message.status === 'cancelled' && message.text === 'Tool execution cancelled.') &&
                (message.toolResult?.stderr || message.toolResult?.stdout || message.text) && (
                  <pre className="tool-detail">
                    {message.toolResult?.stderr || message.toolResult?.stdout || message.text}
                  </pre>
                )}
              <div className="tool-activity-children">{children}</div>
            </div>
          </div>
        </CollapsibleContent>
      </article>
    </Collapsible>
  );
}
