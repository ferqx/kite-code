import {
  ArrowDown01Icon,
  BookOpen01Icon,
  BotIcon,
  Edit02Icon,
  File01Icon,
  Folder01Icon,
  GitBranchIcon,
  Globe02Icon,
  Image02Icon,
  Search01Icon,
  Shield01Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Tick02Icon,
  UserQuestion01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ChildAgentIcon, childAgentAppearance } from './ApprovalHeader';
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
  browser_execute: '浏览器操作',
  edit_file: '修改',
  list_mcp_resources: '列出 MCP 资源',
  list_mcp_tools: '列出 MCP 工具',
  load_skill: '加载技能',
  mcp_tool: '运行 MCP 工具',
  read_file: '读取',
  view_images: '查看图像',
  read_mcp_resource: '读取 MCP 资源',
  read_skill_resource: '读取技能资料',
  request_plan_review: '请求计划审阅',
  shell_execute: '运行',
  skill: '使用 Skill',
  task: '运行子 Agent 任务',
  tool_search: '搜索工具',
  update_plan: '更新计划',
  web_fetch: '读取网页',
  web_search: '网页搜索',
  write_file: '写入',
  write_plan: '编写计划',
};

function toolTitle(message: Message): string {
  const label = toolActionTitle(message);
  if (
    message.toolName === 'web_search' &&
    message.approval?.state !== 'rejected' &&
    !message.toolStopping &&
    message.dispatchCommitted !== false &&
    !message.decisionRefresh &&
    !executionUnconfirmed(message)
  ) {
    if (message.status === 'completed') return '搜索了';
    if (message.status === 'running' && message.dispatchCommitted === true) return '正在搜索';
  }
  if (
    !message.toolName ||
    !TOOL_LABELS[message.toolName] ||
    !['completed', 'failed'].includes(message.status ?? '') ||
    message.dispatchCommitted === false ||
    message.approval?.state === 'rejected' ||
    message.decisionRefresh
  )
    return label;
  if (message.toolName === 'edit_file' && message.status === 'completed' && message.changeConfirmed)
    return '已编辑';
  if (message.toolName === 'browser_execute') return '已完成浏览器操作';
  return /^(读取|写入|修改|查找|列出|加载|运行|查看|搜索|使用|请求|更新|编写|创建|继续|调用|询问)/.test(
    label,
  )
    ? `已${label}`
    : label;
}

function toolActionTitle(message: Message): string {
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

function isShellExecution(message: Message): boolean {
  return isShellMessage(message) && shellOperation(message) === 'execute';
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
  if (
    message.dispatchCommitted === false ||
    message.approval?.state === 'rejected' ||
    message.toolResult?.terminationReason === 'timed_out' ||
    message.shell?.timedOut ||
    message.shell?.jobStatus === 'outcome_unknown'
  )
    return action;
  if (operation === 'execute' && message.status === 'failed') return '已运行';
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
  return action;
}

function toolTarget(message: Message): string | undefined {
  if (message.toolName === 'web_fetch') {
    if (message.target && /^请求 [1-5] 页$/.test(message.target)) return message.target;
    const urls = message.arguments?.urls;
    if (
      Array.isArray(urls) &&
      !Object.hasOwn(message.arguments!, 'url') &&
      urls.length >= 1 &&
      urls.length <= 5 &&
      urls.every((url) => typeof url === 'string' && url.length > 0)
    )
      return `请求 ${urls.length} 页`;
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
    case 'load_skill':
      return argument('skill_id');
    case 'read_skill_resource':
      return [argument('skill_id'), argument('path')].filter(Boolean).join(' · ') || undefined;
    case 'browser_execute': {
      const description = argument('description');
      const purpose = description?.replace(/\s+/gu, ' ').trim();
      return purpose
        ? [...purpose].length > 40
          ? `${[...purpose].slice(0, 40).join('')}…`
          : purpose
        : '操作浏览器';
    }
    case 'read_file':
    case 'view_images':
    case 'edit_file':
    case 'write_file':
      return argument('path');
    case 'shell_execute':
      return argument('description')?.replace(/\s+/gu, ' ').trim() || argument('command');
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

function needsResultDetails(message: Message): boolean {
  return (
    hasToolIssue(message) ||
    message.status === 'cancelled' ||
    message.status === 'not_executed' ||
    message.fileMissing === true
  );
}

/** Keep complete error material behind the item's own disclosure without repeating shared text. */
function toolDetailText(message: Message): string {
  const parts: string[] = [];
  for (const value of [
    needsResultDetails(message) &&
    !(message.approval?.source === 'auto' && message.approval.state === 'approved')
      ? message.approval?.reason
      : undefined,
    message.toolResult?.stderr,
    message.toolResult?.stdout,
    message.text,
  ]) {
    if (
      !value?.trim() ||
      value.trim() === message.decisionRefresh ||
      parts.some((part) => part.includes(value))
    )
      continue;
    for (let index = parts.length - 1; index >= 0; index--)
      if (value.includes(parts[index]!)) parts.splice(index, 1);
    parts.push(value);
  }
  const content = parts.join('\n');
  return message.toolName === 'web_fetch' && content.trim() === 'web_timeout'
    ? `网页读取超时，网络请求或页面解析未在本次时限内完成。\n${content}`
    : content;
}

export function toolIcon(message: Message) {
  if (isShellMessage(message)) return TerminalIcon;
  switch (message.toolName) {
    case 'view_images':
      return Image02Icon;
    case 'read_file':
    case 'read_mcp_resource':
    case 'mcp.resources.read':
    case 'load_skill':
    case 'read_skill_resource':
      return BookOpen01Icon;
    case 'tool_search':
    case 'list_mcp_tools':
    case 'mcp.tools.search':
      return Search01Icon;
    case 'edit_file':
    case 'write_file':
      return Edit02Icon;
    case 'browser_execute':
    case 'web_search':
    case 'web_fetch':
      return Globe02Icon;
    case 'task':
    case 'spawn_agent':
    case 'follow_up_agent':
    case 'send_agent_message':
    case 'wait_agent_events':
    case 'list_agents':
    case 'interrupt_agent':
      return BotIcon;
    case 'ask_user':
      return UserQuestion01Icon;
    case 'list_mcp_resources':
    case 'mcp.resources.list':
      return Folder01Icon;
    case 'git.worktree':
      return GitBranchIcon;
    case 'write_plan':
    case 'update_plan':
    case 'request_plan_review':
    case 'planning.read':
    case 'planning.write':
    case 'planning.review':
    case 'planning.update':
      return File01Icon;
    default:
      return Wrench01Icon;
  }
}

function activityAction(message: Message, trace = false): string {
  if (trace && isShellMessage(message))
    return {
      execute: '运行命令',
      launch: '启动后台 Shell',
      read: '查看命令输出',
      wait: '等待命令',
      stop: '请求停止命令',
    }[shellOperation(message)];
  if (trace && message.fileCreated) return '创建文件';
  switch (message.toolName) {
    case 'view_images':
      return '查看图像';
    case 'write_file':
      if (trace) return '写入文件';
      return '编辑文件';
    case 'edit_file':
      return '编辑文件';
    case 'read_file':
      return '读取文件';
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
      return (trace && (message.title || message.toolName)) || '使用工具';
  }
}

function activityLabel(messages: readonly Message[]): string {
  return [...new Set(messages.map((message) => activityAction(message)))].join('');
}

function toolTraceLabel(message: Message): string {
  if (message.fileCreated) return '已创建文件';
  if (isShellMessage(message)) return shellTitle(message);
  return toolTextFailed(message) ? toolActionTitle(message) : toolTitle(message);
}

export function toolTraceTitle(message: Message): string {
  const shell = isShellMessage(message);
  const target = toolTarget(message) ?? (shell ? shellCommand(message) : undefined);
  return [toolTraceLabel(message), target?.replace(/\s+/g, ' ').trim().slice(0, 512)]
    .filter(Boolean)
    .join(' ');
}

export function toolTextFailed(message: Message): boolean {
  return traceStatus(message) === 'error' || message.shell?.jobStatus === 'failed';
}

/** Owned summary copy only. Never infer an action from a title, target or command. */
const COMPLETED_TRACE_ACTIONS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    read_file: '读取了',
    read_skill_resource: '读取了',
    view_images: '读取了',
    write_file: '运行了',
    edit_file: '运行了',
    web_fetch: '读取了',
    web_search: '搜索了',
    browser_execute: '运行了',
    tool_search: '搜索了',
    skill: '运行了',
    task: '运行了',
    spawn_agent: '运行了',
    follow_up_agent: '运行了',
    send_agent_message: '运行了',
    wait_agent_events: '运行了',
    list_agents: '运行了',
    interrupt_agent: '运行了',
    ask_user: '运行了',
    write_plan: '运行了',
    update_plan: '运行了',
    request_plan_review: '运行了',
    'planning.read': '读取了',
    'planning.write': '运行了',
    'planning.review': '运行了',
    'planning.update': '运行了',
    'git.worktree': '运行了',
  }),
);

/** Summary categories never replace the original per-tool title or target. */
function traceCategoryAction(message: Message): string | undefined {
  if (message.toolSummaryCategory === 'mcp') return '运行了';
  if (message.toolSummaryCategory === 'skill') return '加载了';
  switch (message.toolName) {
    case 'mcp_tool':
    case 'list_mcp_tools':
    case 'list_mcp_resources':
    case 'read_mcp_resource':
    case 'mcp.tools.search':
    case 'mcp.resources.list':
    case 'mcp.resources.read':
      return '运行了';
    case 'load_skill':
      return '加载了';
    default:
      return undefined;
  }
}

function completedTraceAction(message: Message): string {
  const category = traceCategoryAction(message);
  if (category) return category;
  if (isShellMessage(message) || message.fileCreated) return '运行了';
  return COMPLETED_TRACE_ACTIONS.get(message.toolName ?? '') ?? '运行了';
}

function hasCompletedTraceAction(message: Message): boolean {
  // A finite Shell process can exit unsuccessfully and still have run.
  const ran = isShellExecution(message) && message.shell?.jobStatus === 'failed';
  return (
    (message.status === 'completed' || ran) &&
    message.dispatchCommitted !== false &&
    message.approval?.state !== 'rejected' &&
    // A completed wrapper alone does not establish missing or unknown Shell evidence.
    (!isShellMessage(message) || shellTitle(message).startsWith('已'))
  );
}

/** Preserve the existing single-tool disclosure layout while hiding outer identities. */
export function completedToolCategory(message: Message): string | undefined {
  if (message.status !== 'completed' || !hasCompletedTraceAction(message)) return undefined;
  return (
    traceCategoryAction(message) ??
    (!isShellMessage(message) &&
    !message.fileCreated &&
    !COMPLETED_TRACE_ACTIONS.get(message.toolName ?? '')
      ? '运行了'
      : undefined)
  );
}

export function completedToolSummary(message: Message): string | undefined {
  return hasCompletedTraceAction(message) ? completedTraceAction(message) : undefined;
}

export function completedToolActions(messages: readonly Message[]): string {
  const actions = new Set<string>();
  for (const message of messages)
    if (hasCompletedTraceAction(message)) actions.add(completedTraceAction(message));
  return [...actions].join(' · ');
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
        : approval.optionKind === 'scope' && approval.presentation
          ? `已人工批准 · ${approval.presentation.label}`
          : '已人工批准';
  }
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
  const approved = message.approval?.state === 'approved';
  const autoRejected = message.approval?.source === 'auto' && message.approval.state === 'rejected';
  const icon = approved ? ShieldCheckIcon : autoRejected ? ShieldAlertIcon : Shield01Icon;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open || summaryFocused} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'tool-approval tool-approval-icon',
              approved && 'tool-approval-approved',
              autoRejected && 'tool-approval-rejected',
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
  if (message.fileMissing && message.toolName === 'read_file' && message.status === 'completed')
    return '文件不存在';
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
  const exitCode = message.shell?.exitCode ?? message.toolResult?.exitCode;
  // A nonzero command can still return useful diagnostic output. Keep the
  // failed receipt and its detail; describe the process fact, not task failure.
  if (
    original === '失败' &&
    Number.isSafeInteger(exitCode) &&
    exitCode !== 0 &&
    message.shell?.jobStatus === 'failed'
  )
    return '已执行 · 非零退出';
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
  const showFailure =
    needsResultDetails(message) ||
    shell?.jobStatus === 'failed' ||
    shell?.jobStatus === 'outcome_unknown';
  const failure = stoppedBeforeExecution
    ? '任务在自动审批期间停止，命令未开始执行。'
    : showFailure
      ? toolDetailText({
          ...message,
          toolResult: undefined,
          text: shell?.failureReason ?? message.text,
        })
      : '';
  let output: string;
  if (shell?.output !== undefined) output = shell.output;
  else if (streams) output = streams;
  else if (showFailure || stoppedBeforeExecution) output = '';
  else if (shell) {
    if (shell.jobStatus === 'succeeded' && shell.outputComplete === true)
      output = '命令执行成功，无输出。';
    else if (!shell.jobStatus && message.text && !(shell.operation === 'launch' && shell.accepted))
      output = message.text;
    else output = shell.outputComplete === false ? '本次记录未包含完整输出。' : '';
  } else output = message.status === 'completed' ? '命令执行成功，无输出。' : message.text;
  const label = metadataPending
    ? ''
    : originalContent && !shell?.jobStatus
      ? executionLabel(message, diagnostics)
      : shellResultLabel(message, diagnostics);
  const exitCode = shell?.exitCode ?? result?.exitCode;
  const resultSummary = [
    label,
    exitCode !== undefined && label !== '成功' ? `退出码 ${exitCode}` : '',
    shell?.output === undefined && !truncated && shell?.outputComplete === false && streams
      ? '部分输出'
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const displayStatus =
    label === '成功'
      ? 'completed'
      : ['失败', '已执行 · 非零退出', '执行超时', '结果未知'].includes(label)
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
          <div className="shell-original-record">{!metadataPending && originalContent}</div>
        ) : (
          <CodeBlockContent tabIndex={-1}>
            <span className="shell-console-output">
              {output ||
                (shell?.output === undefined &&
                !failure &&
                !command &&
                !preview &&
                !executionUnconfirmed(message)
                  ? '等待输出…'
                  : '')}
            </span>
          </CodeBlockContent>
        )}
      </ScrollArea>
      {!metadataPending && failure && failure !== 'Tool execution cancelled.' && (
        <p className="shell-failure-reason">{failure}</p>
      )}
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
      <article aria-label={status && status !== '成功' ? status : undefined}>
        <TraceIcon>
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
          </span>
        </TraceTitle>
        {approval && <ToolApproval message={message} label={approval} />}
      </article>
    </TraceLine>
  );
}

export interface ChildAgentActivity {
  readonly identity?: string;
  readonly name: string;
}

export function ToolActivity({
  messages,
  expanded,
  onToggle,
  openFile,
  openFileForMessage,
  renderChildren,
  receiptDetails,
  renderItem,
  renderImages,
  renderFileChange,
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
  inTrace = false,
  directTraceDetails = false,
  traceSummaryTitle,
  parentDisclosureOpen = true,
}: {
  /** Stable outer activity, including its first tool before more calls arrive. */
  aggregate?: boolean;
  /** The conversation Trace owns grouping and disclosure defaults. */
  inTrace?: boolean;
  directTraceDetails?: boolean;
  /** Completed action copy for a single row that also owns the outer Trace summary. */
  traceSummaryTitle?: string;
  parentDisclosureOpen?: boolean;
  expandedItems?: Readonly<Record<string, boolean>>;
  onToggleItem?: (id: string, open: boolean) => void;
  messages: readonly Message[];
  expanded?: boolean;
  onToggle: (open: boolean) => void;
  openFile?: (path: string) => void;
  openFileForMessage?: (message: Message) => ((path: string) => void) | undefined;
  /** Confirmed receipt replaces generic raw output; only invoke when the owning tool is expanded. */
  receiptDetails?: (message: Message) => (() => ReactNode) | undefined;
  renderChildren: (toolCallId: string, expanded: boolean, messageId: string) => ReactNode;
  /** Keep a host's original per-item reader inside the aggregate's disclosure. */
  renderItem?: (message: Message) => ReactNode | undefined;
  /** Verified image receipts use the host's existing scoped image reader. */
  renderImages?: (message: Message) => ReactNode;
  /** A confirmed receipt can disclose a scoped, lazy diff without preloading its body. */
  renderFileChange?: (
    message: Message,
    open: boolean,
    openFile?: (path: string) => void,
  ) => ReactNode;
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
  const imageOnly = !unverified && messages.every((item) => item.toolName === 'view_images');
  const [imageDefaultOpen, setImageDefaultOpen] = useState(imageOnly);
  // Appending a sibling must not fold an image the user is already reading.
  if (imageOnly && !imageDefaultOpen) setImageDefaultOpen(true);
  const imageCount = messages.reduce(
    (count, item) =>
      count +
      (item.status === 'completed' &&
      Number.isSafeInteger(item.toolImageCount) &&
      item.toolImageCount! > 0
        ? item.toolImageCount!
        : 0),
    0,
  );
  if (grouped) ask = undefined;
  const shell = !grouped && isShellMessage(message);
  const managedShell = !grouped ? shellSnapshot(message) : undefined;
  const read = !grouped && ['read_file', 'read_mcp_resource'].includes(message.toolName ?? '');
  const edit = !grouped && ['edit_file', 'write_file'].includes(message.toolName ?? '');
  const running = messages.some(
    (item) => !executionUnconfirmed(item) && !item.settled && item.status === 'running',
  );
  const issues = messages.filter((item) =>
    ['failed', 'rejected', 'unknown'].includes(item.status ?? ''),
  );
  const childIssue = childProcess && issues.length > 0;
  const itemIssue = !grouped && (needsResultDetails(message) || childIssue);
  const waitFailure = !grouped && message.agentWait && message.status === 'failed';
  const summaryOnly =
    !grouped &&
    !itemIssue &&
    ((message.toolName === 'web_fetch' && message.status === 'completed') ||
      (message.toolName === 'browser_execute' && !unverified));
  const detailLabel = itemIssue ? '工具异常详情' : '工具详情';
  // A failed original Tool receipt always keeps its own failure presentation.
  const agent = !grouped && !itemIssue && message.status !== 'cancelled' ? childAgent : undefined;
  const open = directTraceDetails || (expanded ?? (!inTrace && (imageOnly || imageDefaultOpen)));
  const imageThumbnails = () =>
    renderImages && (
      <div className="tool-image-thumbnails">
        {messages.map((item) => (
          <Fragment key={item.presentationKey ?? item.id}>{renderImages(item)}</Fragment>
        ))}
      </div>
    );
  const receipt = !grouped ? receiptDetails?.(message) : undefined;
  let projectedChildren: ReactNode;
  const getChildren = () => {
    if (projectedChildren === undefined)
      projectedChildren = receipt
        ? open && parentDisclosureOpen
          ? receipt()
          : null
        : agent || grouped || summaryOnly
          ? null
          : (renderChildren(message.id.slice(5), !shell || open, message.id) ?? null);
    return projectedChildren;
  };
  const approval = grouped ? undefined : approvalLabel(message);
  const pendingReview = messages.some(
    (item) => !executionUnconfirmed(item) && !item.settled && automaticChecking(item),
  );
  const summaryTraceStatus =
    running || pendingReview
      ? 'running'
      : !grouped && (inTrace ? toolTextFailed(message) : traceStatus(message) === 'error')
        ? 'error'
        : messages.some((item) => traceStatus(item) === 'pending')
          ? 'pending'
          : undefined;
  const hasDiff =
    edit &&
    message.status === 'completed' &&
    message.dispatchCommitted !== false &&
    message.changeConfirmed &&
    !unverified &&
    !itemIssue &&
    (!!renderFileChange || !!message.toolResult);
  const inlineEdit = hasDiff;
  const canExpand =
    !agent &&
    !summaryOnly &&
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
      !!receipt ||
      !!message.text ||
      (imageOnly && !!renderImages) ||
      Boolean(getChildren()));
  const ownSummaryTitle = canExpand && !directTraceDetails ? traceSummaryTitle : undefined;
  const label =
    ownSummaryTitle ??
    (imageOnly
      ? imageCount && !issues.length && !running
        ? `已查看 ${imageCount} 张图像`
        : '查看图像'
      : grouped
        ? activityLabel(messages)
        : ask
          ? askMultiple
            ? `询问用户 · ${ask.questions.length} 项`
            : '询问用户'
          : inTrace
            ? toolTraceLabel(message)
            : shell
              ? shellTitle(message)
              : toolTitle(message));
  const target = imageOnly
    ? undefined
    : ask
      ? !askMultiple
        ? ask.questions[0]?.question
        : undefined
      : grouped
        ? undefined
        : shell
          ? (toolTarget(message) ??
            shellCommand(message) ??
            message.shell?.commandPreview ??
            message.shell?.shellId)
          : toolTarget(message);
  const status = grouped
    ? undefined
    : ask?.cancelled
      ? '已取消回答'
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
  const startedChildIdentity =
    message.toolName === 'spawn_agent' && message.status === 'completed'
      ? agent?.identity
      : undefined;
  const childOperationLabel = startedChildIdentity ? '子agent开始工作' : label;
  const showDirectIdentity =
    directTraceDetails &&
    !!traceSummaryTitle &&
    (!shell || (!!target && target !== (shellCommand(message) ?? message.shell?.commandPreview)));
  const heading = agent ? (
    <>
      <TraceIcon className="tool-activity-marker-icon">
        {agent.identity ? (
          <ChildAgentIcon identity={agent.identity} neutral={!startedChildIdentity} />
        ) : (
          <HugeiconsIcon icon={BotIcon} />
        )}
      </TraceIcon>
      <TraceTitle className="tool-activity-marker-content">
        <span className="tool-agent-name tool-label" title={agent.name}>
          {agent.name}
        </span>
        {startedChildIdentity && <span aria-hidden="true">·</span>}
        <TraceDescription className="tool-agent-operation">{childOperationLabel}</TraceDescription>
      </TraceTitle>
    </>
  ) : (
    <>
      <TraceIcon className="tool-activity-marker-icon">
        <HugeiconsIcon
          className="tool-activity-kind-icon"
          icon={imageOnly ? Image02Icon : grouped ? Wrench01Icon : toolIcon(message)}
        />
      </TraceIcon>
      <TraceTitle
        className="tool-activity-marker-content"
        title={grouped ? label : shell ? commandSummary?.slice(0, 2048) : undefined}
        aria-live={grouped ? 'polite' : undefined}
        aria-atomic={grouped ? 'true' : undefined}
      >
        <span className="tool-activity-title tool-label">{label}</span>
        {!ownSummaryTitle &&
          target &&
          (shell ? (
            <code className="tool-command tool-label">{shortCommand}</code>
          ) : (
            <span className="tool-step-target" title={target}>
              {ask ? `· ${target}` : target}
            </span>
          ))}
      </TraceTitle>
      {approval && (
        <ToolApproval
          message={message}
          label={approval}
          insideSummary={canExpand || !!childDetail}
          summaryFocused={approvalFocused}
        />
      )}
      {canExpand && !showDirectIdentity && (
        <TraceIcon className="tool-activity-chevron">
          <HugeiconsIcon icon={ArrowDown01Icon} />
        </TraceIcon>
      )}
    </>
  );
  return (
    <TraceCollapsible asChild open={Boolean(open && canExpand)} onOpenChange={onToggle}>
      <article
        className={`message tool-activity${imageOnly ? ' tool-image-activity' : ''}${grouped ? ' tool-activity-aggregate' : ''}${shell ? ' shell-activity' : ''}${agent ? ' child-agent-activity' : ''}${running || pendingReview ? ' is-running' : ''}`}
        data-child-color={
          startedChildIdentity ? childAgentAppearance(startedChildIdentity).color : undefined
        }
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
            ? `${agent.name} · ${childOperationLabel}`
            : `${label}${!grouped && accessibleStatus ? ` · ${accessibleStatus}` : ''}`
        }
      >
        {directTraceDetails && canExpand ? (
          showDirectIdentity ? (
            <TraceLine status={summaryTraceStatus} className="tool-activity-summary">
              {heading}
            </TraceLine>
          ) : null
        ) : agent ? (
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
              {inlineEdit ? (
                <Button
                  variant="ghost"
                  className="tool-file-disclosure tool-diff-toggle"
                  aria-expanded={open}
                  aria-label={`${open ? '收起' : '展开'}${ownSummaryTitle ?? '已编辑的文件'}${!ownSummaryTitle && target ? `：${target}` : ''}`}
                  title={ownSummaryTitle ? undefined : target}
                  onClick={() => onToggle(!open)}
                >
                  <span className="tool-label">{ownSummaryTitle ?? '已编辑的文件'}</span>
                  <HugeiconsIcon className="tool-file-chevron" icon={ArrowDown01Icon} />
                </Button>
              ) : (
                <TraceTitle className="tool-activity-marker-content">
                  <span className="tool-label">{label}</span>
                  {!ownSummaryTitle &&
                    target &&
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
              )}
              {approval && <ToolApproval message={message} label={approval} />}
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
        {!agent && !summaryOnly && (
          <DeferredProcessContent
            component={TraceCollapsibleContent}
            className="tool-activity-content"
            open={Boolean(open && canExpand)}
            render={() => {
              if (imageOnly && !issues.length && message.status !== 'cancelled')
                return imageThumbnails();
              const children = getChildren();
              const detailText = itemIssue && !shell ? toolDetailText(message) : undefined;
              return (
                <>
                  {ownSummaryTitle && !edit && (
                    <p className="tool-detail-status">{toolTraceTitle(message)}</p>
                  )}
                  {grouped && (
                    <ScrollArea
                      className="tool-activity-scroll"
                      nativeScrollbars
                      fade="y"
                      chainScroll
                      viewportClassName="tool-activity-viewport"
                      viewportProps={{ role: 'region', 'aria-label': '工具执行明细', tabIndex: 0 }}
                    >
                      <Trace className="tool-activity-steps">
                        {messages.map((item) => (
                          <Fragment key={item.presentationKey ?? item.id}>
                            {renderItem?.(item) ??
                              (!needsResultDetails(item) &&
                              ['read_file', 'read_mcp_resource'].includes(item.toolName ?? '') ? (
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
                                  parentDisclosureOpen={open && parentDisclosureOpen}
                                  openFile={openFile}
                                  openFileForMessage={openFileForMessage}
                                  childDetail={childDetailForMessage?.(item)}
                                  receiptDetails={receiptDetails}
                                  renderChildren={renderChildren}
                                  renderImages={imageOnly ? undefined : renderImages}
                                  renderFileChange={renderFileChange}
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
                      originalContent={children || undefined}
                    />
                  )}
                  {!grouped && !shell && !ask && status && status !== '成功' && (
                    <p className="tool-detail-status" role="status">
                      {waitFailure ? message.text : status}
                    </p>
                  )}
                  {managedShell && !shell && !executionUnconfirmed(message) && (
                    <span className="managed-shell-summary" role="status">
                      {shellSnapshotLabel(managedShell)}
                      {managedShell.shellId && <code>{managedShell.shellId}</code>}
                      {managedShell.cursor !== undefined && (
                        <span>日志游标 {managedShell.cursor}</span>
                      )}
                    </span>
                  )}
                  {hasDiff &&
                    (renderFileChange ? (
                      renderFileChange(message, open && parentDisclosureOpen, messageOpenFile)
                    ) : (
                      <FileDiff
                        message={message}
                        path={target}
                        inline={inlineEdit}
                        openFile={messageOpenFile}
                      />
                    ))}
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
                  {!receipt &&
                    !grouped &&
                    !waitFailure &&
                    (!ask || itemIssue) &&
                    !shell &&
                    (!edit || itemIssue) &&
                    (!read || itemIssue) &&
                    (message.toolName !== 'task' || itemIssue) &&
                    !(
                      message.status === 'cancelled' && message.text === 'Tool execution cancelled.'
                    ) &&
                    (itemIssue
                      ? detailText
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
                            ? detailText
                            : message.toolResult?.stderr ||
                              message.toolResult?.stdout ||
                              message.text}
                        </pre>
                      </ScrollArea>
                    )}
                  {!shell && Boolean(children) && (
                    <div className="tool-activity-children">
                      {unverified || !message.toolName ? (
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
                      ) : (
                        children
                      )}
                    </div>
                  )}
                  {imageOnly && imageThumbnails()}
                </>
              );
            }}
          />
        )}
      </article>
    </TraceCollapsible>
  );
}
