import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  BookOpen01Icon,
  Edit02Icon,
  File01Icon,
  FileSearchIcon,
  Folder01Icon,
  Globe02Icon,
  Search01Icon,
  Task01Icon,
  TerminalIcon,
  UserQuestion01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { statusLabel } from './status';
import type { Message } from './types';
import { Button } from './ui';

const TOOL_LABELS: Record<string, string> = {
  ask_user: '询问用户',
  edit_file: '编辑文件',
  glob: '查找文件',
  list_mcp_resources: '列出 MCP 资源',
  list_mcp_tools: '列出 MCP 工具',
  mcp_tool: '运行 MCP 工具',
  read_file: '读取文件',
  read_mcp_resource: '读取 MCP 资源',
  request_plan_review: '请求计划审阅',
  search_content: '搜索内容',
  search_files: '搜索文件',
  shell_execute: '运行命令',
  skill: '使用 Skill',
  task: '运行子 Agent 任务',
  tool_search: '搜索工具',
  update_plan: '更新计划',
  web_fetch: '读取网页',
  write_file: '写入文件',
  write_plan: '编写计划',
};

function toolTitle(message: Message): string {
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
      return argument('description') ?? argument('command');
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

function resultPreview(message: Message): string | undefined {
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
      return Task01Icon;
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

export function ToolActivity({
  messages,
  expanded,
  onToggle,
  openFile,
  renderChildren,
}: {
  messages: readonly Message[];
  expanded?: boolean;
  onToggle: (open: boolean) => void;
  openFile?: (path: string) => void;
  renderChildren: (toolCallId: string, expanded: boolean) => ReactNode;
}) {
  const active = messages.some((message) => !message.settled);
  const waiting = messages.some((message) => !message.settled && message.status === 'waiting');
  const running = messages.some((message) => !message.settled && message.status === 'running');
  const queued = messages.some((message) => !message.settled && message.status === 'queued');
  const statusCount = (status: Message['status']) =>
    messages.filter((message) => message.status === status).length;
  const failed = statusCount('failed');
  const rejected = statusCount('rejected');
  const cancelled = statusCount('cancelled');
  const unknown = statusCount('unknown');
  const unsuccessful = failed + rejected + cancelled + unknown;
  const singleActive = messages.length === 1 && active;
  const open = singleActive || (expanded ?? (active || unsuccessful > 0));
  const standaloneShell = messages.length === 1 && messages[0]?.toolName === 'shell_execute';
  const terminalState = [
    failed && `${failed} 项失败`,
    rejected && `${rejected} 项已拒绝`,
    cancelled && `${cancelled} 项已停止`,
    unknown && `${unknown} 项结果未知`,
  ]
    .filter(Boolean)
    .join(' · ');
  const state = waiting
    ? '等待交互'
    : running
      ? '进行中'
      : queued
        ? '排队中'
        : unsuccessful
          ? terminalState
          : '已完成';

  return (
    <article
      className={`message tool-activity${standaloneShell ? ' shell-activity' : ''}${unsuccessful ? ' has-issues' : ''}${active ? ' active' : ''}`}
      aria-label={`${activitySummary(messages)} · ${state}`}
    >
      {!singleActive && (
        <Button
          className="tool-activity-summary"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => onToggle(!open)}
        >
          <HugeiconsIcon
            data-icon="inline-start"
            className="tool-activity-kind-icon"
            icon={standaloneShell ? TerminalIcon : Search01Icon}
          />
          <span className="tool-activity-title">{activitySummary(messages)}</span>
          {state !== '已完成' && (
            <span
              className="tool-activity-state"
              data-status={waiting ? 'waiting' : running ? 'running' : queued ? 'queued' : 'issue'}
              role="status"
            >
              {state}
            </span>
          )}
          <span className="tool-activity-chevron" aria-hidden="true">
            <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} />
          </span>
        </Button>
      )}
      {open && (
        <ol className="tool-activity-steps">
          {messages.map((message) => {
            const target = toolTarget(message);
            const preview = resultPreview(message);
            return (
              <li className={`tool-activity-step ${message.status ?? ''}`} key={message.id}>
                <HugeiconsIcon className="tool-step-icon" icon={toolIcon(message)} />
                <div className="tool-step-content">
                  <div className="tool-step-heading">
                    <span className="tool-step-title">{toolTitle(message)}</span>
                    {target && (
                      <span className="tool-step-target">
                        {openFile && (message.toolName === 'read_file' || !!message.changedFile) ? (
                          <Button className="file-link" onClick={() => openFile(target)}>
                            {target}
                          </Button>
                        ) : (
                          target
                        )}
                      </span>
                    )}
                    {!['completed', 'running', 'queued'].includes(message.status ?? '') && (
                      <span className="tool-step-status" data-status={message.status ?? 'unknown'}>
                        {message.status ? statusLabel(message.status) : '状态未提供'}
                      </span>
                    )}
                  </div>
                  {preview && message.status !== 'completed' && (
                    <p className="tool-step-preview">{preview}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="tool-activity-children">
        {messages.map((message) => renderChildren(message.id.slice(5), open))}
      </div>
    </article>
  );
}
