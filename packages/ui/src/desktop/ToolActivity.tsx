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
  ShieldAlertIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Tick02Icon,
  UserQuestion01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ChildAgentIcon } from './ApprovalHeader';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockTitle,
} from './components/ui/code-block';
import { ScrollArea } from './components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './components/ui/trace';
import { DeferredProcessContent } from './DeferredProcessContent';
import { useDesktopDiagnostics } from './diagnostics';
import { FileDiff } from './FileChanges';
import { cn } from './lib/utils';
import { statusLabel } from './status';
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
    ['read_file', 'edit_file', 'write_file', 'shell_execute', 'web_fetch'].includes(
      message.toolName,
    )
  )
    return TOOL_LABELS[message.toolName]!;
  const title = message.title?.trim();
  if (title && title !== message.toolName) return title;
  return (
    (message.toolName && TOOL_LABELS[message.toolName]) || title || message.toolName || '工具执行'
  );
}

type ShellSnapshot = {
  readonly shellId?: string;
  readonly mode?: 'finite' | 'service';
  readonly status?: 'running' | 'exited';
  readonly cursor?: number;
};

function shellSnapshot(message: Message): ShellSnapshot | undefined {
  const shellTool =
    message.toolName === 'shell_execute' ||
    message.title === 'shell_read' ||
    message.title === 'shell_stop';
  if (!shellTool) return undefined;
  const fromArguments = message.arguments ?? {};
  let parsed: Record<string, unknown> | undefined;
  for (const candidate of [message.toolResult?.stdout, message.text]) {
    if (!candidate?.trim().startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
        break;
      }
    } catch {
      // Ordinary shell output is not required to be JSON.
    }
  }
  const shellId =
    typeof parsed?.shellId === 'string'
      ? parsed.shellId
      : typeof parsed?.shell_id === 'string'
        ? parsed.shell_id
        : typeof fromArguments.shell_id === 'string'
          ? fromArguments.shell_id
          : undefined;
  const mode =
    parsed?.mode === 'service' || fromArguments.mode === 'service'
      ? ('service' as const)
      : parsed?.mode === 'finite' || fromArguments.mode === 'finite'
        ? ('finite' as const)
        : undefined;
  const status =
    parsed?.status === 'running' || parsed?.status === 'exited' ? parsed.status : undefined;
  const cursor = typeof parsed?.cursor === 'number' ? parsed.cursor : undefined;
  if (!shellId && !mode && !status) return undefined;
  return { shellId, mode, status, cursor };
}

function shellSnapshotLabel(snapshot: ShellSnapshot): string {
  const kind = snapshot.mode === 'service' ? '长期服务' : '后台 Shell';
  const state =
    snapshot.status === 'running' ? '运行中' : snapshot.status === 'exited' ? '已退出' : '已受管';
  return `${kind} · ${state}`;
}

function isShellMessage(message: Message): boolean {
  return (
    !!message.shell ||
    [
      'shell_execute',
      'shell.execute',
      'shell.launch',
      'shell.read',
      'shell.wait',
      'shell.stop',
    ].includes(message.toolName ?? '')
  );
}

function shellOperation(message: Message): NonNullable<Message['shell']>['operation'] {
  return (
    message.shell?.operation ??
    ({ 'shell.launch': 'launch', 'shell.read': 'read', 'shell.wait': 'wait', 'shell.stop': 'stop' }[
      message.toolName ?? ''
    ] as 'launch' | 'read' | 'wait' | 'stop' | undefined) ??
    'execute'
  );
}

function shellCommand(message: Message): string | undefined {
  if (message.shell) return message.shell.command;
  if (typeof message.arguments?.command === 'string') return message.arguments.command;
  return shellOperation(message) === 'execute' || shellOperation(message) === 'launch'
    ? message.target
    : undefined;
}

function shellTitle(message: Message): string {
  const operation = shellOperation(message);
  const action = {
    execute: '运行命令',
    launch: '启动命令',
    read: '读取输出',
    wait: '等待命令',
    stop: '停止命令',
  }[operation];
  if (executionUnconfirmed(message) || message.status === undefined) return action;
  if (message.status === 'unknown') return '结果未知';
  if (message.status === 'completed' && message.shell?.jobStatus === 'outcome_unknown')
    return '命令结果未知';
  if (message.status === 'completed' && message.shell?.jobStatus === 'failed') return '命令失败';
  if (
    operation === 'execute' &&
    (message.shell?.timedOut || message.toolResult?.terminationReason === 'timed_out')
  )
    return '运行超时';
  if (message.status === 'completed' && operation === 'wait' && message.shell?.timedOut)
    return '等待超时';
  if (
    stoppedDuringAutoCheck(message) ||
    (message.approval?.state === 'cancelled' && message.dispatchCommitted === false) ||
    message.approval?.state === 'rejected' ||
    (automaticChecking(message) && !message.settled) ||
    message.approval?.state === 'awaiting_user'
  )
    return action;
  if (message.status === 'not_executed') return executionLabel(message, false) || action;
  if (message.status === 'queued') return '等待执行';
  if (message.status === 'failed')
    return {
      execute: '运行失败',
      launch: '启动失败',
      read: '读取失败',
      wait: '等待失败',
      stop: '停止请求失败',
    }[operation];
  if (message.status === 'cancelled')
    return operation === 'execute' && (!message.shell || message.shell.jobStatus === 'cancelled')
      ? '已停止'
      : '操作已取消';
  if (
    message.status === 'completed' &&
    message.shell &&
    !message.shell.jobStatus &&
    !(operation === 'launch' && message.shell.accepted) &&
    !(operation === 'stop' && message.shell.cancelRequested)
  )
    return action;
  if (message.status === 'completed')
    return {
      execute: '已运行',
      launch: '已请求运行',
      read: '已读取输出',
      wait: '已等待命令',
      stop: '已请求停止',
    }[operation];
  return message.status === 'running'
    ? {
        execute: '运行中',
        launch: '正在启动',
        read: '正在读取输出',
        wait: '正在等待命令',
        stop: '正在请求停止',
      }[operation]
    : action;
}

function toolTarget(message: Message): string | undefined {
  if (message.toolName === 'web_fetch') {
    const raw = message.target ?? message.arguments?.url;
    if (typeof raw !== 'string') return undefined;
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) return undefined;
      return url.host + (url.pathname === '/' ? '' : url.pathname);
    } catch {
      return undefined;
    }
  }
  if (message.target !== undefined) return message.target;
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
    case 'mcp.tools.search':
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
      return [
        argument('name') ?? argument('subagent_type'),
        argument('task_id') && `task_id ${argument('task_id')}`,
      ]
        .filter(Boolean)
        .join(' · ');
    default:
      return undefined;
  }
}

function hasToolIssue(message: Message): boolean {
  return (
    ['failed', 'rejected', 'unknown'].includes(message.status ?? '') ||
    ['rejected', 'unavailable', 'awaiting_user'].includes(message.approval?.state ?? '')
  );
}

/** Keep complete error material behind the item's own disclosure without repeating shared text. */
function toolDetailText(message: Message, includeProgress = false): string {
  const parts: string[] = [];
  for (const value of [
    hasToolIssue(message) &&
    !(message.approval?.source === 'auto' && message.approval.state === 'approved')
      ? message.approval?.reason
      : undefined,
    message.toolResult?.stderr ?? (includeProgress ? message.toolProgress?.stderr : undefined),
    message.toolResult?.stdout ?? (includeProgress ? message.toolProgress?.stdout : undefined),
    message.text,
  ]) {
    if (!value?.trim() || parts.some((part) => part.includes(value))) continue;
    for (let index = parts.length - 1; index >= 0; index--)
      if (value.includes(parts[index]!)) parts.splice(index, 1);
    parts.push(value);
  }
  const content = parts.join('\n');
  return message.toolName === 'web_fetch' && content.trim() === 'web_timeout'
    ? `网页读取超时，网络请求或页面解析未在本次时限内完成。\n${content}`
    : content;
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
    case 'shell.launch':
    case 'shell.read':
    case 'shell.wait':
    case 'shell.stop':
      return TerminalIcon;
    case 'edit_file':
    case 'write_file':
    case 'files.write_path':
    case 'files.edit_path':
      return Edit02Icon;
    case 'web_fetch':
      return Globe02Icon;
    case 'task':
      return BotIcon;
    case 'ask_user':
      return UserQuestion01Icon;
    case 'list_mcp_resources':
    case 'mcp.resources.list':
      return Folder01Icon;
    case 'write_plan':
    case 'update_plan':
    case 'request_plan_review':
    case 'planning.read':
    case 'planning.write':
    case 'planning.review':
    case 'planning.update':
      return File01Icon;
    case 'validation.define':
    case 'validation.check':
    case 'validation.rebind':
    case 'validation.request_waiver':
    case 'validation.auto_check':
      return Tick02Icon;
    default:
      return Wrench01Icon;
  }
}

function activityAction(message: Message): string {
  switch (message.toolName) {
    case 'write_file':
    case 'edit_file':
      return '编辑文件';
    case 'read_file':
      return '读取文件';
    case 'search_content':
      return '搜索内容';
    case 'search_files':
    case 'glob':
    case 'files.glob':
      return '查找文件';
    case 'files.list':
      return '浏览目录';
    case 'shell_execute':
    case 'shell.launch':
      return '运行命令';
    case 'shell.read':
    case 'shell.wait':
      return '查看命令输出';
    case 'shell.stop':
      return '请求停止命令';
    case 'web_fetch':
      return '读取网页';
    case 'mcp_tool':
      return '调用 MCP 工具';
    case 'read_mcp_resource':
      return '读取资源';
    case 'list_mcp_resources':
      return '查看资源';
    case 'list_mcp_tools':
    case 'tool_search':
      return '查找工具';
    case 'skill':
      return '使用技能';
    case 'task':
      return '运行子 Agent 任务';
    case 'spawn_agent':
      return '创建子 Agent';
    case 'follow_up_agent':
      return '继续子 Agent 任务';
    case 'send_agent_message':
      return '发送 Agent 消息';
    case 'wait_agent_events':
    case 'list_agents':
      return '查看 Agent 进展';
    case 'interrupt_agent':
      return '请求中断 Agent';
    case 'ask_user':
      return '询问用户';
    case 'write_plan':
    case 'update_plan':
      return '更新计划';
    case 'request_plan_review':
      return '请求计划审阅';
    default:
      return '使用工具';
  }
}

function activityLabel(messages: readonly Message[]): string {
  return [...new Set(messages.map(activityAction))].join('');
}

/** New adapters emit checking; saved UI snapshots may still carry reviewing. */
function automaticChecking(message: Message): boolean {
  return message.approval?.state === 'checking' || message.approval?.state === 'reviewing';
}

function stoppedDuringAutoCheck(message: Message): boolean {
  return (
    message.settled &&
    message.status === 'cancelled' &&
    message.approval?.source === 'auto' &&
    automaticChecking(message) &&
    (message.dispatchCommitted === false || (!message.toolProgress && !message.toolResult))
  );
}

function executionUnconfirmed(message: Message): boolean {
  return (
    !!message.executionUnconfirmed &&
    !message.settled &&
    [
      'creating',
      'queued',
      'running',
      'waiting',
      'auto_checking',
      'auto_reviewing',
      'recovery_required',
    ].includes(message.status ?? '')
  );
}

function approvalLabel(message: Message): string | undefined {
  if (executionUnconfirmed(message)) return undefined;
  const approval = message.approval;
  if (!approval) return;
  switch (approval.state) {
    case 'submitted':
      return '已提交批准，待核对';
    case 'unavailable':
      return '自动审批结果未知';
    case 'cancelled':
      return approval.source === 'auto' ? '自动审批已停止' : '审批已取消';
    case 'checking':
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

function approvalIcon(message: Message) {
  if (message.approval?.state === 'approved') return ShieldCheckIcon;
  if (message.approval?.source === 'auto' && message.approval.state === 'rejected')
    return ShieldAlertIcon;
  return undefined;
}

function ToolApproval({
  message,
  label,
  insideSummary = false,
  summaryFocused = false,
}: {
  message: Message;
  label: string;
  insideSummary?: boolean;
  summaryFocused?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const icon = approvalIcon(message);
  if (!icon)
    return (
      <span className="tool-approval" role="status">
        {label}
      </span>
    );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open || summaryFocused} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'tool-approval tool-approval-icon',
              message.approval?.state === 'approved'
                ? 'tool-approval-approved'
                : 'tool-approval-rejected',
            )}
            role="img"
            aria-label={label}
            tabIndex={insideSummary ? undefined : 0}
          >
            <HugeiconsIcon icon={icon} aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="tool-approval-tooltip" side="top" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function createdChildTask(message: Message): boolean {
  if (message.toolName !== 'task' || message.status !== 'completed') return false;
  const output = message.toolResult?.stdout;
  if (!output) return false;
  try {
    const result: unknown = JSON.parse(output);
    return (
      !!result &&
      typeof result === 'object' &&
      'task_id' in result &&
      typeof result.task_id === 'string' &&
      result.task_id.length > 0
    );
  } catch {
    return false;
  }
}

function executionLabel(message: Message, diagnostics: boolean) {
  if (executionUnconfirmed(message)) return diagnostics ? '执行状态待核实' : '';
  if (message.status === undefined && !diagnostics) return '';
  // Confirmed approval failures already explain why the tool never started.
  // Independent unknown effects and timeouts must retain their result labels.
  if (
    !message.decisionRefresh &&
    message.status !== 'unknown' &&
    message.toolResult?.terminationReason !== 'timed_out' &&
    (stoppedDuringAutoCheck(message) ||
      (message.dispatchCommitted === false &&
        (message.approval?.state === 'rejected' || message.approval?.state === 'cancelled')))
  )
    return '';
  if (message.status === 'not_executed')
    return message.decisionRefresh === 'context_refresh_required'
      ? '上下文已更新，此次未执行'
      : message.decisionRefresh === 'capability_refresh_required'
        ? '工具信息已更新，此次未执行'
        : '未执行';
  if (createdChildTask(message)) return '已创建';
  if (automaticChecking(message) && !message.settled) return '';
  if (message.approval?.state === 'awaiting_user' && !message.settled) return '';
  if (message.toolResult?.terminationReason === 'timed_out') return '执行超时';
  return message.status === 'completed'
    ? '成功'
    : message.status === 'queued'
      ? '等待执行'
      : message.status === 'running'
        ? '执行中'
        : message.status
          ? statusLabel(message.status)
          : '结果未知';
}

// Trace only decorates facts already present in the host projection. Inactive
// streams, cancellation and unknown results never imply an execution failure.
function traceStatus(message: Message): 'running' | 'error' | 'pending' | undefined {
  if (executionUnconfirmed(message)) return undefined;
  if (!message.settled && (message.status === 'running' || automaticChecking(message)))
    return 'running';
  if (message.status === 'failed' || message.status === 'rejected') return 'error';
  if (!message.settled && message.status === 'queued') return 'pending';
  return undefined;
}

function shellResultLabel(message: Message, diagnostics: boolean): string {
  if (executionUnconfirmed(message)) return diagnostics ? '执行状态待核实' : '';
  if (
    message.status !== 'unknown' &&
    message.shell?.operation === 'execute' &&
    message.shell.timedOut
  )
    return '执行超时';
  const original = executionLabel(message, diagnostics);
  if (
    !original ||
    message.status === 'unknown' ||
    message.status === 'failed' ||
    message.status === 'rejected'
  )
    return original;
  const shell = message.shell;
  if (!shell) {
    const snapshot = shellSnapshot(message);
    return snapshot?.status === 'running'
      ? '执行中'
      : snapshot?.status === 'exited'
        ? '已退出'
        : original;
  }
  if (message.status === 'cancelled')
    return shell.jobStatus === 'cancelled' ? '已停止' : '操作已取消';
  if (
    shell.operation === 'wait' &&
    shell.timedOut &&
    ['planned', 'dispatching', 'running'].includes(shell.jobStatus ?? '')
  )
    return shell.jobStatus === 'planned' ? '等待超时 · 等待执行' : '等待超时 · 命令仍在运行';
  if (
    shell.cancelRequested &&
    ['planned', 'dispatching', 'running'].includes(shell.jobStatus ?? '')
  )
    return '已请求停止，等待结束';
  if (shell.operation === 'execute' && shell.timedOut) return '执行超时';
  if (shell.jobStatus)
    return {
      planned: '等待执行',
      dispatching: '执行中',
      running: '执行中',
      succeeded: '成功',
      failed: '失败',
      cancelled: '已停止',
      outcome_unknown: '结果未知',
    }[shell.jobStatus];
  if (message.status === 'completed')
    return {
      execute: '命令结果未提供',
      launch: shell.accepted ? '已受理' : '启动结果未提供',
      read: '读取结果未提供',
      wait: '等待结果未提供',
      stop: shell.cancelRequested ? '已请求停止' : '停止结果未提供',
    }[shell.operation];
  return original;
}

function ShellOutput({
  message,
  originalContent,
  metadataPending,
}: {
  message: Message;
  originalContent?: ReactNode;
  metadataPending?: boolean;
}) {
  const diagnostics = useDesktopDiagnostics();
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const result = message.toolResult;
  const shell = message.shell;
  const command = shellCommand(message);
  const preview = !command ? shell?.commandPreview : undefined;
  const stdout = shell?.stdout ?? result?.stdout ?? message.toolProgress?.stdout;
  const stderr = shell?.stderr ?? result?.stderr ?? message.toolProgress?.stderr;
  const streams = shell?.output ?? [stdout, stderr].filter(Boolean).join('\n');
  const lineCount = (text: string | undefined) =>
    text ? text.replace(/\r?\n$/, '').split('\n').length : 0;
  const truncated =
    shell?.truncated ||
    (result?.totalLines !== undefined && result.totalLines > lineCount(stdout) + lineCount(stderr));
  const stoppedBeforeExecution = stoppedDuringAutoCheck(message);
  const reason =
    message.approval?.state === 'rejected' || message.approval?.state === 'awaiting_user'
      ? message.approval.reason
      : undefined;
  let output: string;
  if (stoppedBeforeExecution) output = '任务在自动审批期间停止，命令未开始执行。';
  else if (shell) {
    if (streams) {
      const detail =
        hasToolIssue(message) ||
        reason ||
        shell.jobStatus === 'outcome_unknown' ||
        shell.jobStatus === 'failed'
          ? toolDetailText(message, true)
          : '';
      output = detail && !streams.includes(detail) ? `${streams}\n\n${detail}` : streams;
    } else if (
      hasToolIssue(message) ||
      reason ||
      shell.jobStatus === 'outcome_unknown' ||
      shell.jobStatus === 'failed'
    )
      output = toolDetailText(message, true);
    else if (shell.jobStatus === 'succeeded' && shell.outputComplete === true)
      output = '命令执行成功，无输出。';
    else if (!shell.jobStatus && message.text && !(shell.operation === 'launch' && shell.accepted))
      output = message.text;
    else output = shell.outputComplete === false ? '本次记录未包含完整输出。' : '';
  } else
    output =
      hasToolIssue(message) || reason
        ? toolDetailText(message, true)
        : streams ||
          (message.status === 'completed'
            ? '命令执行成功，无输出。'
            : message.status === 'cancelled'
              ? '命令已停止。'
              : message.text);
  const label = metadataPending ? '' : shellResultLabel(message, diagnostics);
  const exitCode = shell?.exitCode ?? result?.exitCode;
  const resultSummary = [
    label,
    exitCode !== undefined && label !== '成功' ? `退出码 ${exitCode}` : '',
    truncated ? '输出已截断' : '',
    !truncated && shell?.outputComplete === false && streams ? '部分输出' : '',
    result?.status === 'exhausted' ? '输出已达到工具限制' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const displayStatus =
    label === '成功'
      ? 'completed'
      : ['失败', '执行超时', '结果未知'].includes(label)
        ? 'failed'
        : executionUnconfirmed(message)
          ? undefined
          : message.status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: transcript commits change the scroll height.
  useLayoutEffect(() => {
    if (follow.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [command, preview, output]);
  return (
    <CodeBlock className="shell-output" data-status={displayStatus}>
      <CodeBlockHeader className="shell-output-header">
        <CodeBlockTitle className="shell-output-title">
          {command || preview ? (
            <span className="shell-command-block" data-preview={preview ? 'true' : undefined}>
              {preview && <span className="shell-command-preview-label">命令摘要 </span>}
              <span className="shell-prompt" aria-hidden="true">
                ${' '}
              </span>
              <code className="shell-command-text">{command ?? preview}</code>
            </span>
          ) : (
            'Shell'
          )}
        </CodeBlockTitle>
        {command && (
          <CodeBlockActions>
            <CodeBlockCopyButton value={command} />
          </CodeBlockActions>
        )}
      </CodeBlockHeader>
      <ScrollArea
        className="shell-output-scroll"
        orientation="both"
        fade="y"
        viewportRef={viewport}
        chainScroll
        viewportClassName="shell-output-viewport"
        viewportProps={{
          role: 'region',
          tabIndex: 0,
          'aria-label': 'Shell 执行输出',
          onScroll: () => {
            const node = viewport.current!;
            follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 24;
          },
        }}
      >
        {metadataPending || originalContent ? (
          <div className="shell-original-record">
            {metadataPending ? <p>正在读取记录…</p> : originalContent}
          </div>
        ) : (
          <CodeBlockContent tabIndex={-1}>
            <span className="shell-console-output">
              {output ||
                (!command && !preview && !executionUnconfirmed(message) ? '等待输出…' : '')}
              {!shell &&
              !hasToolIssue(message) &&
              streams &&
              ['cancelled', 'failed', 'rejected'].includes(message.status ?? '') &&
              message.text &&
              message.text !== 'Tool execution cancelled.' &&
              !streams.includes(message.text)
                ? `\n${message.text}`
                : ''}
            </span>
          </CodeBlockContent>
        )}
      </ScrollArea>
      {resultSummary && (
        <CodeBlockFooter className="shell-output-footer">
          <span className="shell-result" role="status">
            {label === '成功' && (
              <HugeiconsIcon className="shell-result-icon" icon={Tick02Icon} aria-hidden="true" />
            )}
            {resultSummary}
          </span>
        </CodeBlockFooter>
      )}
    </CodeBlock>
  );
}

export function ToolRow({
  message,
  openFile,
}: {
  message: Message;
  openFile?: (path: string) => void;
  showReadFailure?: boolean;
}) {
  const diagnostics = useDesktopDiagnostics();
  const target = toolTarget(message);
  const file = ['read_file', 'edit_file', 'write_file'].includes(message.toolName ?? '');
  const approval = approvalLabel(message);
  const status = executionLabel(message, diagnostics);
  return (
    <TraceLine
      asChild
      status={traceStatus(message)}
      className={`tool-activity-step ${executionUnconfirmed(message) ? '' : !message.settled && automaticChecking(message) ? 'running' : (message.status ?? '')}`}
    >
      <div>
        <TraceIcon className="tool-step-marker-icon">
          <HugeiconsIcon className="tool-step-icon" icon={toolIcon(message)} />
        </TraceIcon>
        <TraceTitle className="tool-step-content">
          <span className="tool-step-heading">
            <span className="tool-step-title tool-label">{toolTitle(message)}</span>
            {target && (
              <span className="tool-step-target" title={target}>
                {file && openFile ? (
                  <Button className="file-link" onClick={() => openFile(target)}>
                    {target}
                  </Button>
                ) : (
                  target
                )}
              </span>
            )}
            {approval && <ToolApproval message={message} label={approval} />}
            {status && status !== '成功' && status !== approval && (
              <TraceDescription
                className={`tool-step-status${traceStatus(message) === 'error' ? ' sr-only' : ''}`}
                data-status={executionUnconfirmed(message) ? undefined : message.status}
              >
                {status}
              </TraceDescription>
            )}
          </span>
        </TraceTitle>
      </div>
    </TraceLine>
  );
}

export interface ChildAgentActivity {
  readonly identity: string;
  readonly name: string;
}

export function ToolActivity({
  messages,
  expanded,
  onToggle,
  openFile,
  openFileForMessage,
  renderChildren,
  renderItem,
  expandedItems,
  onToggleItem,
  childProcess = false,
  activityId,
  restoredExpanded,
  childDetail,
  childDetailForMessage,
  childAgent,
  unverified,
  metadataPending,
  aggregate = false,
}: {
  /** Stable outer activity, including its first tool before more calls arrive. */
  aggregate?: boolean;
  expandedItems?: Readonly<Record<string, boolean>>;
  onToggleItem?: (id: string, open: boolean) => void;
  messages: readonly Message[];
  expanded?: boolean;
  onToggle: (open: boolean) => void;
  openFile?: (path: string) => void;
  openFileForMessage?: (message: Message) => ((path: string) => void) | undefined;
  renderChildren: (toolCallId: string, expanded: boolean) => ReactNode;
  /** Keep a host's original per-item reader inside the aggregate's disclosure. */
  renderItem?: (message: Message) => ReactNode | undefined;
  suppressGenericFailure?: boolean;
  childProcess?: boolean;
  activityId?: string;
  restoredExpanded?: ReadonlySet<string>;
  childDetail?: { readonly label: string; readonly onOpen: () => void };
  childDetailForMessage?: (
    message: Message,
  ) => { readonly label: string; readonly onOpen: () => void } | undefined;
  childAgent?: ChildAgentActivity;
  /** The host has an original record but has not verified its execution status. */
  unverified?: boolean;
  /** Pending metadata for this item only; never gates verified siblings. */
  metadataPending?: boolean;
}) {
  const diagnostics = useDesktopDiagnostics();
  const [approvalFocused, setApprovalFocused] = useState(false);
  const message = messages[0]!;
  const messageOpenFile = openFileForMessage ? openFileForMessage(message) : openFile;
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
  const grouped = aggregate || messages.length > 1;
  if (grouped) ask = undefined;
  const shell = !grouped && isShellMessage(message);
  const managedShell = !grouped ? shellSnapshot(message) : undefined;
  const read =
    !grouped &&
    ['read_file', 'search_content', 'search_files', 'glob', 'read_mcp_resource'].includes(
      message.toolName ?? '',
    );
  const edit = !grouped && ['edit_file', 'write_file'].includes(message.toolName ?? '');
  const running = messages.some(
    (item) => !executionUnconfirmed(item) && !item.settled && item.status === 'running',
  );
  const issues = messages.filter((item) =>
    ['failed', 'rejected', 'unknown'].includes(item.status ?? ''),
  );
  const childIssue = childProcess && issues.length > 0;
  const itemIssue = !grouped && (hasToolIssue(message) || childIssue);
  const webSuccess =
    !grouped && message.toolName === 'web_fetch' && message.status === 'completed' && !itemIssue;
  const detailLabel = itemIssue ? '工具异常详情' : '工具详情';
  // A failed original Tool receipt always keeps its own failure presentation.
  const agent = !grouped && !itemIssue && message.status !== 'cancelled' ? childAgent : undefined;
  const open = expanded ?? false;
  let projectedChildren: ReactNode[] | undefined;
  const getChildren = () => {
    projectedChildren ??=
      agent || grouped || webSuccess
        ? []
        : messages.map((item) => renderChildren(item.id.slice(5), true));
    return projectedChildren;
  };
  const approval = grouped ? undefined : approvalLabel(message);
  const pendingReview = messages.some(
    (item) => !executionUnconfirmed(item) && !item.settled && automaticChecking(item),
  );
  const summaryTraceStatus =
    running || pendingReview
      ? 'running'
      : !grouped && messages.some((item) => traceStatus(item) === 'error')
        ? 'error'
        : messages.some((item) => traceStatus(item) === 'pending')
          ? 'pending'
          : undefined;
  const hasDiff = edit && message.changeConfirmed && !!message.toolResult;
  const canExpand =
    !agent &&
    !webSuccess &&
    (grouped || itemIssue || message.status !== 'not_executed') &&
    (!read || itemIssue) &&
    (!edit || hasDiff || itemIssue) &&
    (grouped || shell || itemIssue || !pendingReview) &&
    (grouped ||
      itemIssue ||
      shell ||
      hasDiff ||
      !!ask ||
      message.toolName === 'task' ||
      !!message.text ||
      getChildren().some(Boolean));
  const label = grouped
    ? activityLabel(messages)
    : ask
      ? askMultiple
        ? `询问用户 · ${message.status === 'completed' && !ask.cancelled ? '已回答 ' : ''}${ask.questions.length} 项`
        : '询问用户'
      : shell
        ? shellTitle(message)
        : toolTitle(message);
  const target = ask
    ? !askMultiple
      ? ask.questions[0]?.question
      : undefined
    : grouped
      ? undefined
      : shell
        ? (shellCommand(message) ??
          message.shell?.commandPreview ??
          message.shell?.shellId ??
          toolTarget(message))
        : toolTarget(message);
  const status =
    ask && (ask.cancelled || message.status === 'cancelled')
      ? open
        ? undefined
        : ask.cancelled
          ? '已取消回答'
          : '已取消'
      : grouped
        ? undefined
        : unverified && message.status === undefined
          ? diagnostics
            ? '状态待核对'
            : undefined
          : executionLabel(message, diagnostics);
  const commandSummary = shell && target ? target.replace(/\s+/g, ' ').trim() : undefined;
  const shortCommand =
    commandSummary && commandSummary.length > 512
      ? `${commandSummary.slice(0, 512)}…`
      : commandSummary;
  const accessibleStatus = shell ? shellResultLabel(message, diagnostics) : status;
  const heading = agent ? (
    <>
      <TraceIcon className="tool-activity-marker-icon">
        <ChildAgentIcon identity={agent.identity} />
      </TraceIcon>
      <TraceTitle className="tool-agent-name tool-label" title={agent.name}>
        {agent.name}
      </TraceTitle>
      <TraceDescription className="tool-agent-operation">{label}</TraceDescription>
    </>
  ) : (
    <>
      <TraceIcon className="tool-activity-marker-icon">
        <HugeiconsIcon
          className="tool-activity-kind-icon"
          icon={grouped ? Wrench01Icon : toolIcon(message)}
        />
      </TraceIcon>
      <TraceTitle
        className="tool-activity-marker-content"
        title={grouped ? label : shell ? commandSummary?.slice(0, 2048) : undefined}
        aria-live={grouped ? 'polite' : undefined}
        aria-atomic={grouped ? 'true' : undefined}
      >
        <span className="tool-activity-title tool-label">{label}</span>
        {target &&
          (shell ? (
            <code className="tool-command tool-label">{shortCommand}</code>
          ) : (
            <span className="tool-step-target" title={target}>
              {ask ? `· ${target}` : target}
            </span>
          ))}
      </TraceTitle>
      {approval && approvalIcon(message) && (
        <ToolApproval
          message={message}
          label={approval}
          insideSummary={canExpand || !!childDetail}
          summaryFocused={approvalFocused}
        />
      )}
      {canExpand && <HugeiconsIcon className="tool-activity-chevron" icon={ArrowDown01Icon} />}
      {approval && !approvalIcon(message) && <ToolApproval message={message} label={approval} />}
      {status && !shell && status !== '成功' && status !== approval && (
        <TraceDescription
          className={`tool-activity-state${traceStatus(message) === 'error' ? ' sr-only' : ''}`}
          data-status={issues.length ? 'issue' : 'neutral'}
          role="status"
        >
          {status}
        </TraceDescription>
      )}
      {managedShell && !shell && !executionUnconfirmed(message) && (
        <span className="managed-shell-summary" role="status">
          {shellSnapshotLabel(managedShell)}
          {managedShell.shellId && <code>{managedShell.shellId}</code>}
          {managedShell.cursor !== undefined && <span>日志游标 {managedShell.cursor}</span>}
        </span>
      )}
    </>
  );
  return (
    <TraceCollapsible asChild open={Boolean(open && canExpand)} onOpenChange={onToggle}>
      <article
        className={`message tool-activity${grouped ? ' tool-activity-aggregate' : ''}${shell ? ' shell-activity' : ''}${agent ? ' child-agent-activity' : ''}${running || pendingReview ? ' is-running' : ''}`}
        data-restored-expanded={restoredExpanded?.has(activityId ?? message.id) || undefined}
        onFocusCapture={(event) =>
          setApprovalFocused(
            (event.target as HTMLElement).matches('button.tool-activity-summary:focus-visible'),
          )
        }
        onBlurCapture={() => setApprovalFocused(false)}
        onPointerDownCapture={() => setApprovalFocused(false)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape') setApprovalFocused(false);
        }}
        aria-label={
          agent
            ? `${agent.name} · ${label}`
            : `${label}${!grouped && accessibleStatus ? ` · ${accessibleStatus}` : ''}`
        }
      >
        {agent ? (
          <TraceLine asChild status={summaryTraceStatus} className="tool-activity-summary">
            <Button
              variant="ghost"
              disabled={!childDetail}
              aria-label={`查看子 Agent 详情：${agent.name}`}
              onClick={childDetail?.onOpen}
            >
              {heading}
            </Button>
          </TraceLine>
        ) : childDetail ? (
          <div className="tool-activity-heading-row">
            <TraceCollapsibleTrigger asChild>
              <TraceLine asChild status={summaryTraceStatus} className="tool-activity-summary">
                <Button variant="ghost">{heading}</Button>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <Button
              className="tool-child-detail"
              variant="ghost"
              size="xs"
              aria-label={`查看子 Agent 详情：${childDetail.label}`}
              onClick={childDetail.onOpen}
            >
              查看详情
            </Button>
          </div>
        ) : read && !itemIssue ? (
          <ToolRow message={message} openFile={messageOpenFile} />
        ) : edit && !itemIssue ? (
          <TraceLine
            asChild
            status={traceStatus(message)}
            className="tool-activity-summary tool-edit-heading"
          >
            <div>
              <TraceIcon className="tool-activity-marker-icon">
                <HugeiconsIcon className="tool-activity-kind-icon" icon={toolIcon(message)} />
              </TraceIcon>
              <TraceTitle className="tool-activity-marker-content">
                <span className="tool-label">{label}</span>
                {target &&
                  (messageOpenFile ? (
                    <Button
                      className="file-link"
                      title={target}
                      onClick={() => messageOpenFile(target)}
                    >
                      {target}
                    </Button>
                  ) : (
                    <span className="tool-step-target" title={target}>
                      {target}
                    </span>
                  ))}
              </TraceTitle>
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
              {approval && <ToolApproval message={message} label={approval} />}
              {status && status !== '成功' && status !== approval && (
                <TraceDescription
                  className={`tool-step-status${traceStatus(message) === 'error' ? ' sr-only' : ''}`}
                  data-status={executionUnconfirmed(message) ? undefined : message.status}
                >
                  {status}
                </TraceDescription>
              )}
            </div>
          </TraceLine>
        ) : canExpand ? (
          <TraceCollapsibleTrigger asChild>
            <TraceLine asChild status={summaryTraceStatus} className="tool-activity-summary">
              <Button variant="ghost">{heading}</Button>
            </TraceLine>
          </TraceCollapsibleTrigger>
        ) : (
          <TraceLine asChild status={summaryTraceStatus} className="tool-activity-summary">
            <div>{heading}</div>
          </TraceLine>
        )}
        {!agent && !webSuccess && (
          <DeferredProcessContent
            component={TraceCollapsibleContent}
            className="tool-activity-content"
            open={Boolean(open && canExpand)}
            render={() => {
              const children = getChildren();
              return (
                <>
                  {grouped && (
                    <ScrollArea
                      className="tool-activity-scroll"
                      fade="y"
                      chainScroll
                      viewportClassName="tool-activity-viewport"
                      viewportProps={{ role: 'region', 'aria-label': '工具执行明细', tabIndex: 0 }}
                    >
                      <Trace className="tool-activity-steps">
                        {messages.map((item) => (
                          <Fragment key={item.presentationKey ?? item.id}>
                            {renderItem?.(item) ??
                              (!hasToolIssue(item) &&
                              [
                                'read_file',
                                'search_content',
                                'search_files',
                                'glob',
                                'read_mcp_resource',
                              ].includes(item.toolName ?? '') ? (
                                <ToolRow
                                  message={item}
                                  openFile={
                                    openFileForMessage ? openFileForMessage(item) : openFile
                                  }
                                />
                              ) : (
                                <ToolActivity
                                  messages={[item]}
                                  expanded={expandedItems?.[item.presentationKey ?? item.id]}
                                  onToggle={(next) =>
                                    onToggleItem?.(item.presentationKey ?? item.id, next)
                                  }
                                  activityId={item.presentationKey ?? item.id}
                                  restoredExpanded={restoredExpanded}
                                  openFile={openFile}
                                  openFileForMessage={openFileForMessage}
                                  childDetail={childDetailForMessage?.(item)}
                                  renderChildren={renderChildren}
                                />
                              ))}
                          </Fragment>
                        ))}
                      </Trace>
                    </ScrollArea>
                  )}
                  {shell && (
                    <ShellOutput
                      message={message}
                      metadataPending={metadataPending}
                      originalContent={unverified && children.some(Boolean) ? children : undefined}
                    />
                  )}
                  {hasDiff && <FileDiff message={message} />}
                  {ask && (
                    <div className="tool-ask-answers">
                      {ask.cancelled || message.status === 'cancelled' ? (
                        <span>{ask.cancelled ? '已取消回答' : '已取消'}</span>
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
                    (!ask || itemIssue) &&
                    !shell &&
                    (!edit || itemIssue) &&
                    (!read || itemIssue) &&
                    (message.toolName !== 'task' || itemIssue) &&
                    !(
                      message.status === 'cancelled' && message.text === 'Tool execution cancelled.'
                    ) &&
                    (itemIssue
                      ? toolDetailText(message)
                      : message.toolResult?.stderr ||
                        message.toolResult?.stdout ||
                        message.text) && (
                      <ScrollArea
                        className="tool-detail-scroll"
                        fade="y"
                        chainScroll
                        viewportClassName="tool-detail-viewport"
                        viewportProps={{ role: 'region', 'aria-label': detailLabel, tabIndex: 0 }}
                      >
                        <pre className="tool-detail">
                          {itemIssue
                            ? toolDetailText(message)
                            : message.toolResult?.stderr ||
                              message.toolResult?.stdout ||
                              message.text}
                        </pre>
                      </ScrollArea>
                    )}
                  <div className="tool-activity-children">
                    {shell
                      ? null
                      : unverified || !message.toolName
                        ? children.some(Boolean) && (
                            <ScrollArea
                              className="tool-detail-scroll"
                              fade="y"
                              chainScroll
                              viewportClassName="tool-detail-viewport"
                              viewportProps={{
                                role: 'region',
                                'aria-label': '工具原始记录',
                                tabIndex: 0,
                              }}
                            >
                              {children}
                            </ScrollArea>
                          )
                        : children}
                  </div>
                </>
              );
            }}
          />
        )}
      </article>
    </TraceCollapsible>
  );
}
