import {
  Add01Icon,
  CalendarClockIcon,
  Delete02Icon,
  Folder01Icon,
  Folder02Icon,
  Home03Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  UserCircleIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useId, useRef, useState } from 'react';
import { Badge } from './components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { ScrollArea } from './components/ui/scroll-area';
import { Spinner } from './components/ui/spinner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import { sessionStatusLabel } from './status';
import type { WorkspaceSummary } from './types';
import { Button } from './ui';

function updatedTime(value?: string) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

export function sessionTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export interface DirectoryProps {
  workspaces: readonly WorkspaceSummary[];
  selected?: string;
  selectedWorkspace?: string;
  busy?: boolean;
  mutationBusy?: boolean;
  defaultExpanded?: boolean;
  onOpen?: (id: string) => void;
  onExpand?: (id: string) => void;
}

function Workspace({
  workspace,
  ...props
}: Omit<DirectoryProps, 'workspaces'> & {
  workspace: WorkspaceSummary;
  onNewSession?: (workspaceId: string) => void;
  onRemove?: (workspaceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? workspace.state === 'loaded');
  const [visibleCount, setVisibleCount] = useState(5);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tooltipNeedsHover, setTooltipNeedsHover] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const id = useId();
  const sessions = [...workspace.sessions]
    .sort((a, b) => updatedTime(b.updatedAt) - updatedTime(a.updatedAt))
    .slice(0, visibleCount);
  return (
    <section className="workspace-group">
      <Tooltip
        open={tooltipOpen && !moreOpen && !tooltipNeedsHover}
        onOpenChange={(open) => setTooltipOpen(open && !moreOpen && !tooltipNeedsHover)}
      >
        <TooltipTrigger asChild>
          <div
            ref={heading}
            className={`space-heading${props.selectedWorkspace === workspace.id ? ' selected' : ''}`}
            data-menu-active={moreOpen || undefined}
            onPointerEnter={() => {
              if (!moreOpen) setTooltipNeedsHover(false);
            }}
          >
            <Button
              className="space-row"
              aria-current={props.selectedWorkspace === workspace.id ? 'page' : undefined}
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => {
                setExpanded(!expanded);
                if (expanded) setVisibleCount(5);
                if (!expanded && workspace.state === 'idle') props.onExpand?.(workspace.id);
              }}
            >
              <HugeiconsIcon
                data-icon={expanded ? 'folder-open' : 'folder-closed'}
                icon={expanded ? Folder02Icon : Folder01Icon}
              />
              <span className="nav-copy">
                <strong className={workspace.muted ? 'space-name-muted' : undefined}>
                  {workspace.label}
                </strong>
              </span>
            </Button>
            {props.onNewSession && workspace.state !== 'unavailable' && (
              <Button
                className="ghost space-new-session"
                variant="ghost"
                size="icon-xs"
                aria-label={`在 ${workspace.label} 中新建对话`}
                title="新对话"
                disabled={props.mutationBusy}
                onClick={() => props.onNewSession?.(workspace.id)}
              >
                <HugeiconsIcon icon={PencilEdit02Icon} />
              </Button>
            )}
            {props.onRemove && (
              <DropdownMenu
                open={moreOpen}
                onOpenChange={(open) => {
                  setMoreOpen(open);
                  setTooltipOpen(false);
                  setTooltipNeedsHover(true);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    className="ghost space-more"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${workspace.label} 更多操作`}
                    title="更多操作"
                    disabled={props.busy || props.mutationBusy}
                  >
                    <HugeiconsIcon icon={MoreHorizontalIcon} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="sidebar-menu"
                  aria-label={`${workspace.label} 更多操作`}
                  onCloseAutoFocus={(event) => {
                    if (!heading.current?.matches(':hover')) event.preventDefault();
                  }}
                >
                  <DropdownMenuItem
                    className="space-remove"
                    aria-label={`移除 ${workspace.label}`}
                    disabled={props.busy || props.mutationBusy}
                    onSelect={() => props.onRemove?.(workspace.id)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} />
                    移除空间
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </TooltipTrigger>
        {!moreOpen && !tooltipNeedsHover && (
          <TooltipContent className="kite-client directory-tooltip" side="right" sideOffset={8}>
            <strong>{workspace.label}</strong>
            {(workspace.state === 'loaded' || workspace.sessions.length > 0) && (
              <span>{workspace.sessionCount} 个会话</span>
            )}
          </TooltipContent>
        )}
      </Tooltip>
      <div className="sidebar-sessions" hidden={!expanded}>
        {workspace.state === 'unavailable' && (
          <Button onClick={() => props.onExpand?.(workspace.id)}>会话暂不可用 · 重试</Button>
        )}
        <nav
          id={id}
          ref={list}
          aria-label="当前项目会话"
          aria-busy={workspace.state === 'loading' || undefined}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const buttons = Array.from(
              list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
            );
            if (!buttons.length) return;
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : Math.max(
                      0,
                      Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                    );
            event.preventDefault();
            buttons[next]?.focus();
          }}
        >
          {sessions.map((session) => {
            const awaitingInteraction = Boolean(session.pendingInteractions);
            const managedWaiting =
              session.status === 'waiting' && session.waitingReason === 'required_background';
            const statusLabel = managedWaiting ? '任务进行中' : sessionStatusLabel(session.status);
            return (
              <Tooltip key={session.sessionId}>
                <TooltipTrigger asChild>
                  <Button
                    className={`session-row ${props.selected === session.sessionId ? 'selected' : ''}`}
                    aria-label={session.displayName}
                    aria-description={awaitingInteraction ? '待用户输入' : statusLabel}
                    aria-current={props.selected === session.sessionId ? 'page' : undefined}
                    disabled={!props.onOpen}
                    onClick={() => props.onOpen?.(session.sessionId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        props.onOpen?.(session.sessionId);
                      }
                    }}
                  >
                    <span className="nav-copy">
                      <strong>{session.displayName}</strong>
                    </span>
                    {awaitingInteraction ? (
                      <Badge>待用户输入</Badge>
                    ) : session.status === 'running' || managedWaiting ? (
                      <Spinner aria-label={managedWaiting ? '任务进行中' : '会话运行中'} />
                    ) : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  className="kite-client directory-tooltip"
                  side="right"
                  sideOffset={8}
                >
                  <strong>{session.displayName}</strong>
                  {sessionTime(session.updatedAt) && <span>{sessionTime(session.updatedAt)}</span>}
                </TooltipContent>
              </Tooltip>
            );
          })}
          {workspace.sessions.length > visibleCount && (
            <Button
              variant="ghost"
              className="session-row session-load-more"
              onClick={() => setVisibleCount((count) => count + 10)}
            >
              展开更多
            </Button>
          )}
          {!sessions.length && workspace.state === 'loaded' && (
            <p className="empty-list">暂无聊天</p>
          )}
        </nav>
      </div>
    </section>
  );
}

/** Only granted operations are supplied by the entry point. Absence means unavailable. */
export interface PageActions {
  newSession?: () => void;
  newWorkspaceSession?: (workspaceId: string) => void;
  addWorkspace?: () => void;
  removeWorkspace?: (workspaceId: string) => void;
  workbench?: () => void;
  scheduledTasks?: () => void;
  settings?: () => void;
  theme?: {
    value: 'dark' | 'light' | 'system';
    onChange: (value: 'dark' | 'light' | 'system') => void;
  };
  connection?: { label: string; run: () => void };
  openFile?: (path: string) => void;
}
export function Sidebar({
  actions,
  connectionLabel,
  activePage = 'conversation',
  ...props
}: DirectoryProps & {
  actions: PageActions;
  connectionLabel: string;
  activePage?: 'conversation' | 'newConversation' | 'workbench' | 'scheduledTasks';
}) {
  const newConversationSelected = activePage === 'newConversation' && !props.selectedWorkspace;
  return (
    <>
      {(actions.newSession || actions.workbench || actions.scheduledTasks) && (
        <nav className="primary-navigation" aria-label="主要导航">
          {actions.newSession && (
            <Button
              className={newConversationSelected ? 'new-session selected' : 'new-session'}
              aria-current={newConversationSelected ? 'page' : undefined}
              variant="ghost"
              disabled={props.busy || props.mutationBusy}
              onClick={actions.newSession}
            >
              <HugeiconsIcon data-icon="inline-start" icon={PencilEdit02Icon} />
              <span>新对话</span>
            </Button>
          )}
          {actions.workbench && (
            <Button
              variant="ghost"
              className={activePage === 'workbench' ? 'selected' : undefined}
              aria-current={activePage === 'workbench' ? 'page' : undefined}
              onClick={actions.workbench}
            >
              <HugeiconsIcon data-icon="inline-start" icon={Home03Icon} />
              <span>工作台</span>
            </Button>
          )}
          {actions.scheduledTasks && (
            <Button
              variant="ghost"
              className={activePage === 'scheduledTasks' ? 'selected' : undefined}
              aria-current={activePage === 'scheduledTasks' ? 'page' : undefined}
              onClick={actions.scheduledTasks}
            >
              <HugeiconsIcon data-icon="inline-start" icon={CalendarClockIcon} />
              <span>安排任务</span>
            </Button>
          )}
        </nav>
      )}
      <div className="nav-label">
        <span>空间</span>
        {actions.addWorkspace && (
          <Button
            className="ghost space-add"
            variant="ghost"
            size="icon-sm"
            aria-label="添加空间"
            title="添加空间"
            disabled={props.mutationBusy}
            onClick={actions.addWorkspace}
          >
            <HugeiconsIcon icon={Add01Icon} />
          </Button>
        )}
      </div>
      <TooltipProvider delayDuration={500} skipDelayDuration={300}>
        <ScrollArea className="workspace-directory">
          <div className="workspace-directory-content">
            {props.workspaces.map((workspace) => (
              <Workspace
                key={workspace.id}
                {...props}
                workspace={workspace}
                onNewSession={actions.newWorkspaceSession}
                onRemove={actions.removeWorkspace}
              />
            ))}
          </div>
        </ScrollArea>
      </TooltipProvider>
      <div className="sidebar-utilities">
        {(connectionLabel || actions.connection) && (
          <div className="connection">
            {connectionLabel && <span>{connectionLabel}</span>}
            {actions.connection && (
              <Button className="ghost" disabled={props.busy} onClick={actions.connection.run}>
                {actions.connection.label}
              </Button>
            )}
          </div>
        )}
        {(actions.settings || actions.theme) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="profile-card" aria-label="用户菜单">
                <HugeiconsIcon className="profile-avatar" icon={UserCircleIcon} />
                <span>
                  <strong>个人工作区</strong>
                </span>
                <HugeiconsIcon icon={MoreHorizontalIcon} aria-label="更多操作" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="sidebar-menu">
              {actions.settings && (
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={actions.settings}>设置</DropdownMenuItem>
                </DropdownMenuGroup>
              )}
              {actions.settings && actions.theme && <DropdownMenuSeparator />}
              {actions.theme && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="sidebar-menu-label">主题</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    aria-label="主题"
                    value={actions.theme.value}
                    onValueChange={(value) => {
                      if (value === 'dark' || value === 'light' || value === 'system')
                        actions.theme?.onChange(value);
                    }}
                  >
                    <DropdownMenuRadioItem value="dark">暗</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="light">亮</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">跟随系统</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </>
  );
}
