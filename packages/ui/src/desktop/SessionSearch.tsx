import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Input } from './components/ui/input';
import { ScrollArea } from './components/ui/scroll-area';
import { sessionStatusLabel } from './status';
import type { SessionSummary, WorkspaceSummary } from './types';
import { Button } from './ui';

const PAGE_SIZE = 50;
type SearchRow = {
  key: string;
  session: SessionSummary;
  workspaceLabel: string;
  location?: string;
};

/** Search the host's complete root-session directory, not the sidebar's visible rows. */
export function searchSessions(
  workspaces: readonly WorkspaceSummary[],
  query: string,
): SearchRow[] {
  const words = query.trim().toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean);
  const names = new Map<string, number>();
  for (const workspace of workspaces)
    names.set(workspace.label, (names.get(workspace.label) ?? 0) + 1);
  return workspaces
    .flatMap((workspace) =>
      workspace.sessions
        .filter((session) => {
          const text = `${session.displayName} ${workspace.label}`.toLocaleLowerCase('en-US');
          return words.every((word) => text.includes(word));
        })
        .map((session) => ({
          key: JSON.stringify([workspace.id, session.sessionId]),
          session,
          workspaceLabel: workspace.label,
          ...((names.get(workspace.label) ?? 0) > 1
            ? { location: workspace.rootUri || workspace.id }
            : {}),
        })),
    )
    .sort((left, right) => {
      const time = (value?: string) => {
        const parsed = Date.parse(value ?? '');
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return (
        time(right.session.updatedAt) - time(left.session.updatedAt) ||
        left.key.localeCompare(right.key)
      );
    });
}

export function SessionSearch({
  workspaces,
  available,
  onOpen,
  onClose,
}: {
  workspaces: readonly WorkspaceSummary[];
  available: boolean;
  onOpen?: (id: string) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string>();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const input = useRef<HTMLInputElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const opening = useRef(false);
  const listId = useId();
  const complete =
    available &&
    workspaces.every(
      (workspace) =>
        workspace.state === 'loaded' && workspace.sessions.length === workspace.sessionCount,
    );
  const results = useMemo(
    () => (complete ? searchSessions(workspaces, query) : []),
    [complete, workspaces, query],
  );
  const activeIndex = Math.max(
    0,
    results.findIndex((row) => row.key === activeKey),
  );
  const active = results[activeIndex];
  const activeId = active ? `${listId}-${activeIndex}` : undefined;
  const visible = results.slice(0, Math.max(visibleCount, activeIndex + 1));
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (activeId && active?.key) activeRow.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, active?.key]);
  function open(row: SearchRow) {
    if (!complete || !onOpen || opening.current) return;
    opening.current = true;
    onOpen(row.session.sessionId);
    onClose(false);
  }
  return (
    <section
      className="session-search"
      aria-label="会话搜索"
      onKeyDownCapture={(event) => {
        if (
          event.key === 'Escape' &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="session-search-input">
        <Input
          ref={input}
          value={query}
          placeholder="搜索会话或项目"
          aria-label="搜索会话或项目"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveKey(undefined);
            setVisibleCount(PAGE_SIZE);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat)
              return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const next = Math.max(
                0,
                Math.min(results.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)),
              );
              setActiveKey(results[next]?.key);
            } else if (event.key === 'Enter' && active) {
              event.preventDefault();
              open(active);
            }
          }}
        />
        <Button variant="ghost" onClick={() => onClose()} aria-label="关闭会话搜索">
          取消
        </Button>
      </div>
      {!complete ? (
        <p className="session-search-feedback" role="status">
          会话目录暂不可用，恢复后会自动更新。
        </p>
      ) : (
        <p className="session-search-feedback" role="status">
          {results.length
            ? `${results.length} 个会话 · ↑↓ 选择，Enter 打开`
            : query.trim()
              ? '未找到匹配的会话'
              : '暂无会话'}
        </p>
      )}
      <ScrollArea className="session-search-results">
        <div id={listId} role="listbox" aria-label="会话搜索结果">
          {visible.map((row, index) => (
            <Button
              key={row.key}
              ref={index === activeIndex ? activeRow : undefined}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              variant="ghost"
              className="session-search-result"
              disabled={!onOpen}
              title={[row.session.displayName, row.workspaceLabel, row.location]
                .filter(Boolean)
                .join('\n')}
              onClick={() => open(row)}
            >
              <strong>{row.session.displayName}</strong>
              <small>
                {row.workspaceLabel}
                {row.session.pendingInteractions
                  ? ' · 待用户输入'
                  : sessionStatusLabel(row.session.status)
                    ? ` · ${sessionStatusLabel(row.session.status)}`
                    : ''}
              </small>
              {row.location && <small>{row.location}</small>}
            </Button>
          ))}
        </div>
        {visible.length < results.length && (
          <Button
            className="session-search-more"
            variant="ghost"
            onClick={() => setVisibleCount(visible.length + PAGE_SIZE)}
          >
            显示更多（已显示 {visible.length} / {results.length}）
          </Button>
        )}
      </ScrollArea>
    </section>
  );
}
