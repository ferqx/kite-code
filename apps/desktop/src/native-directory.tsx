import type { Session, Workspace } from '@kite-ai/client';
import { useId, useState } from 'react';

/** Directory presentation uses the original IDs; callbacks retain the host's authority. */
export function NativeDirectory({
  workspaces,
  sessions,
  selectedId,
  creating,
  onCreate,
  onSelect,
}: {
  workspaces: readonly Workspace[];
  sessions: readonly Session[];
  selectedId?: string;
  creating: boolean;
  onCreate(workspaceId: string): void;
  onSelect(sessionId: string): void;
}) {
  const prefix = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const unlinked = sessions.filter((session) => !known.has(session.workspaceId));
  const sessionRows = (items: readonly Session[]) => (
    <ul>
      {items.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            data-directory-item
            aria-current={session.id === selectedId ? 'page' : undefined}
            onClick={() => onSelect(session.id)}
          >
            {session.title}
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <nav
      aria-label="项目会话目录"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-directory-item]'),
        ];
        const index = items.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        items[
          Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))
        ]?.focus();
      }}
    >
      {!workspaces.length && !sessions.length && <p>尚未添加项目</p>}
      {workspaces.map((workspace) => {
        const opened = !collapsed.has(workspace.id);
        const items = sessions.filter((session) => session.workspaceId === workspace.id);
        const panelId = `${prefix}-${workspace.id}`;
        return (
          <section key={workspace.id} aria-label={workspace.name}>
            <button
              type="button"
              data-directory-item
              aria-expanded={opened}
              aria-controls={panelId}
              onClick={() =>
                setCollapsed((old) => {
                  const next = new Set(old);
                  if (!old.has(workspace.id)) next.add(workspace.id);
                  else next.delete(workspace.id);
                  return next;
                })
              }
            >
              {workspace.name}
            </button>
            <button type="button" disabled={creating} onClick={() => onCreate(workspace.id)}>
              新建会话
            </button>
            {opened && (
              <div id={panelId}>{items.length ? sessionRows(items) : <p>暂无聊天</p>}</div>
            )}
          </section>
        );
      })}
      {unlinked.length > 0 && (
        <section aria-label="项目待读取的会话">
          <p>这些会话的项目尚未进入本次目录；重新读取目录可更新项目归属。</p>
          {sessionRows(unlinked)}
        </section>
      )}
    </nav>
  );
}
