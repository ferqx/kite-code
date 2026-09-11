import { useId, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import { statusLabel } from './status';
import type { WorkspaceSummary } from './types';
import { Button } from './ui';

const newConversationIcon = new URL('./assets/new-conversation.svg', import.meta.url).href;

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
  busy?: boolean;
  defaultExpanded?: boolean;
  onLoadMore?: () => void;
  onOpen?: (id: string) => void;
  onExpand?: (id: string) => void;
}

function Workspace({
  workspace,
  ...props
}: Omit<DirectoryProps, 'workspaces'> & {
  workspace: WorkspaceSummary;
  onNewSession?: (workspaceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? workspace.state === 'loaded');
  const list = useRef<HTMLElement>(null);
  const id = useId();
  const sessions = workspace.sessions;
  return (
    <section className="workspace-group">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="space-heading">
            <Button
              className="space-row"
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => {
                setExpanded(!expanded);
                if (!expanded && workspace.state === 'idle') props.onExpand?.(workspace.id);
              }}
            >
              <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
              <span className="nav-copy">
                <strong className={workspace.muted ? 'space-name-muted' : undefined}>
                  {workspace.label}
                </strong>
              </span>
            </Button>
            {props.onNewSession && (
              <Button
                className="ghost space-new-session"
                variant="ghost"
                size="icon-sm"
                aria-label={`在 ${workspace.label} 中新建对话`}
                title="新对话"
                disabled={props.busy}
                onClick={() => props.onNewSession?.(workspace.id)}
              >
                <img src={newConversationIcon} alt="" width={16} height={16} />
              </Button>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent className="kite-client directory-tooltip" side="right" sideOffset={8}>
          <strong>{workspace.label}</strong>
          <span>{workspace.state === 'idle' ? '未加载' : `${workspace.sessionCount} 个会话`}</span>
        </TooltipContent>
      </Tooltip>
      <div className="sidebar-sessions" hidden={!expanded}>
        {workspace.state === 'loading' && <p role="status">正在加载会话…</p>}
        {workspace.state === 'unavailable' && (
          <Button onClick={() => props.onExpand?.(workspace.id)}>会话暂不可用 · 重试</Button>
        )}
        <nav
          id={id}
          ref={list}
          aria-label="当前项目会话"
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
          {sessions.map((session) => (
            <Tooltip key={session.sessionId}>
              <TooltipTrigger asChild>
                <Button
                  className={`session-row ${props.selected === session.sessionId ? 'selected' : ''}`}
                  aria-current={props.selected === session.sessionId ? 'page' : undefined}
                  disabled={props.busy || !props.onOpen}
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
                </Button>
              </TooltipTrigger>
              <TooltipContent className="kite-client directory-tooltip" side="right" sideOffset={8}>
                <strong>{session.displayName}</strong>
                <span>{statusLabel(session.status)}</span>
                {sessionTime(session.updatedAt) && <span>{sessionTime(session.updatedAt)}</span>}
              </TooltipContent>
            </Tooltip>
          ))}
          {!sessions.length && workspace.state === 'loaded' && (
            <p className="empty-list">还没有会话。</p>
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
  settings?: () => void;
  connection?: { label: string; run: () => void };
  openFile?: (path: string) => void;
}
export function Sidebar({
  actions,
  connectionLabel,
  ...props
}: DirectoryProps & {
  actions: PageActions;
  connectionLabel: string;
}) {
  return (
    <>
      {actions.newSession && (
        <Button className="new-session" disabled={props.busy} onClick={actions.newSession}>
          <img src={newConversationIcon} alt="" width={16} height={16} />
          新对话
        </Button>
      )}
      <div className="nav-label">
        <span>空间</span>
      </div>
      <TooltipProvider delayDuration={500} skipDelayDuration={300}>
        <div className="workspace-directory">
          {props.workspaces.map((workspace) => (
            <Workspace
              key={workspace.id}
              {...props}
              workspace={workspace}
              onNewSession={actions.newWorkspaceSession}
            />
          ))}
          {props.onLoadMore && (
            <Button disabled={props.busy} onClick={props.onLoadMore}>
              加载更早的会话
            </Button>
          )}
        </div>
      </TooltipProvider>
      <div className="sidebar-utilities">
        {actions.settings && (
          <Button className="ghost" onClick={actions.settings}>
            模型与 Provider 设置
          </Button>
        )}
        <div className="connection">
          {connectionLabel && <span>{connectionLabel}</span>}
          {actions.connection && (
            <Button className="ghost" disabled={props.busy} onClick={actions.connection.run}>
              {actions.connection.label}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
