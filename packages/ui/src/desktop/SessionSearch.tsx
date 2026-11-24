import { Cancel01Icon, Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from './components/ui/dialog';
import { Input } from './components/ui/input';
import { sessionStatusLabel } from './status';
import type { SessionSummary, WorkspaceSummary } from './types';
import { Button } from './ui';

export type SessionSearchSession = Pick<
  SessionSummary,
  'sessionId' | 'displayName' | 'status' | 'updatedAt' | 'pendingInteractions'
>;
export type SessionSearchWorkspace = Pick<
  WorkspaceSummary,
  'id' | 'label' | 'rootUri' | 'state' | 'sessionCount'
> & { readonly sessions: readonly SessionSearchSession[] };

export interface SessionSearchProps {
  id: string;
  workspaces: readonly SessionSearchWorkspace[];
  available: boolean;
  onOpen?: (id: string) => void;
  onClose: () => void;
  restoreFocus: () => void;
}

export function sessionSearchDirectoryComplete(
  available: boolean,
  workspaces: readonly SessionSearchWorkspace[],
) {
  return (
    available &&
    workspaces.every(
      (workspace) =>
        workspace.state === 'loaded' && workspace.sessions.length === workspace.sessionCount,
    )
  );
}

export const SESSION_SEARCH_PAGE_SIZE = 50;
export const SESSION_SEARCH_QUERY_LIMIT = 512;
export type SearchRow = {
  key: string;
  session: Omit<SessionSearchSession, 'updatedAt'>;
  updatedAtMs?: number;
  workspaceLabel: string;
  location?: string;
};

/** Search the host's complete root-session directory, not the sidebar's visible rows. */
export function searchSessions(
  workspaces: readonly SessionSearchWorkspace[],
  query: string,
  now = Date.now(),
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
        .flatMap(({ updatedAt, ...session }) => {
          const time = Date.parse(updatedAt ?? '');
          if (!words.length && !(time >= now - 7 * DAY_MS && time <= now)) return [];
          return [
            {
              key: JSON.stringify([workspace.id, session.sessionId]),
              session,
              ...(Number.isFinite(time) ? { updatedAtMs: time } : {}),
              workspaceLabel: workspace.label,
              ...((names.get(workspace.label) ?? 0) > 1
                ? { location: workspace.rootUri || workspace.id }
                : {}),
            },
          ];
        }),
    )
    .sort(
      (left, right) =>
        (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0) || left.key.localeCompare(right.key),
    );
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const activityDateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'long',
  timeStyle: 'short',
});

export function sessionSearchActivityTime(updatedAtMs: number | undefined, now: number) {
  if (updatedAtMs === undefined || !Number.isSafeInteger(updatedAtMs) || !Number.isFinite(now))
    return undefined;
  const date = new Date(updatedAtMs);
  if (!Number.isFinite(date.getTime())) return undefined;
  const elapsed = now - updatedAtMs;
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  const label =
    elapsed < MINUTE_MS
      ? '刚刚'
      : elapsed < HOUR_MS
        ? `${Math.floor(elapsed / MINUTE_MS)} 分钟前`
        : elapsed < DAY_MS
          ? `${Math.floor(elapsed / HOUR_MS)} 小时前`
          : elapsed < 7 * DAY_MS
            ? `${Math.floor(elapsed / DAY_MS)} 天前`
            : date.getFullYear() === new Date(now).getFullYear()
              ? monthDay
              : `${date.getFullYear()}年${monthDay}`;
  return {
    label,
    dateTime: date.toISOString(),
    title: activityDateFormat.format(date),
  };
}

export function SessionSearch(props: SessionSearchProps) {
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(SESSION_SEARCH_PAGE_SIZE);
  const opening = useRef(false);
  const complete = sessionSearchDirectoryComplete(props.available, props.workspaces);
  const results = useMemo(
    () => (complete ? searchSessions(props.workspaces, query) : []),
    [complete, props.workspaces, query],
  );
  return (
    <SessionSearchPalette
      {...props}
      query={query}
      setQuery={(value) => {
        setQuery(value);
        setVisibleCount(SESSION_SEARCH_PAGE_SIZE);
      }}
      complete={complete}
      results={results.slice(0, visibleCount)}
      onMore={
        visibleCount < results.length
          ? () => setVisibleCount((count) => count + SESSION_SEARCH_PAGE_SIZE)
          : undefined
      }
      onOpen={
        props.onOpen &&
        ((id) => {
          if (opening.current) return;
          opening.current = true;
          props.onOpen?.(id);
          props.onClose();
        })
      }
    />
  );
}

export function SessionSearchPalette({
  id,
  query,
  resultsQuery = query,
  setQuery,
  complete,
  results,
  pending,
  onMore,
  onOpen,
  onClose,
  restoreFocus,
}: Omit<SessionSearchProps, 'available' | 'workspaces'> & {
  query: string;
  resultsQuery?: string;
  setQuery(value: string): void;
  complete: boolean;
  results: readonly SearchRow[];
  pending?: boolean;
  onMore?(): void;
}) {
  const [activeKey, setActiveKey] = useState<string>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const lastResultsQuery = useRef(resultsQuery);
  const advanceFrom = useRef<string | undefined>(undefined);
  const composing = useRef(false);
  const restoreOnClose = useRef(false);
  const listId = useId();
  const queryChanged = resultsQuery !== lastResultsQuery.current;
  const matched = queryChanged ? -1 : results.findIndex((row) => row.key === activeKey);
  const activeIndex = Math.max(matched, 0);
  const active = results[activeIndex];
  const activeId = active ? `${listId}-${activeIndex}` : undefined;
  useLayoutEffect(() => {
    if (!queryChanged) return;
    lastResultsQuery.current = resultsQuery;
    setActiveKey(undefined);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [queryChanged, resultsQuery]);
  useLayoutEffect(() => {
    if (advanceFrom.current === undefined || pending) return;
    const index = results.findIndex((row) => row.key === advanceFrom.current);
    if (index >= 0 && results[index + 1]) {
      advanceFrom.current = undefined;
      setActiveKey(results[index + 1]?.key);
    } else if (index < 0 || !onMore) advanceFrom.current = undefined;
  }, [onMore, pending, results]);
  useEffect(() => {
    if (activeId && active?.key) activeRow.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, active?.key]);
  function open(row: SearchRow) {
    if (complete && !pending) onOpen?.(row.session.sessionId);
  }
  function dismiss() {
    restoreOnClose.current = true;
    onClose();
  }
  const isComposing = (event: KeyboardEvent) =>
    composing.current || event.isComposing || event.keyCode === 229;
  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogPortal>
        <DialogOverlay className="session-search-backdrop" />
        <DialogContent
          id={id}
          aria-modal="true"
          className="kite-client session-search"
          portalled={false}
          showOverlay={false}
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreOnClose.current) restoreFocus();
          }}
          onEscapeKeyDown={(event) => {
            event.stopPropagation();
            if (isComposing(event)) event.preventDefault();
          }}
        >
          <DialogTitle className="sr-only">会话搜索</DialogTitle>
          <DialogDescription className="sr-only">
            按会话标题或项目名称搜索。使用方向键选择，Enter 打开，Esc 关闭。
          </DialogDescription>
          <div className="session-search-input">
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
            <Input
              ref={input}
              value={query}
              placeholder="搜索会话或项目"
              aria-label="搜索会话或项目"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={pending ? undefined : activeId}
              autoComplete="off"
              maxLength={SESSION_SEARCH_QUERY_LIMIT}
              spellCheck={false}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onChange={(event) => {
                advanceFrom.current = undefined;
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (isComposing(event.nativeEvent) || event.repeat || pending) return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const next = Math.max(
                    0,
                    Math.min(
                      results.length - 1,
                      activeIndex + (event.key === 'ArrowDown' ? 1 : -1),
                    ),
                  );
                  if (
                    onMore &&
                    active &&
                    event.key === 'ArrowDown' &&
                    activeIndex === results.length - 1
                  ) {
                    advanceFrom.current = active.key;
                    onMore();
                  } else {
                    advanceFrom.current = undefined;
                    setActiveKey(results[next]?.key);
                  }
                } else if (event.key === 'Enter' && active) {
                  event.preventDefault();
                  open(active);
                }
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={dismiss}
              aria-label="关闭会话搜索"
              title="关闭会话搜索（Esc）"
            >
              <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
            </Button>
          </div>
          {(!complete || results.length === 0) && (
            <p className="session-search-feedback" role="status">
              {!complete
                ? '会话目录暂不可用，恢复后会自动更新。'
                : resultsQuery.trim()
                  ? '未找到匹配的会话'
                  : '最近 7 天暂无会话'}
            </p>
          )}
          <div
            ref={viewport}
            className="session-search-results"
            aria-busy={pending || undefined}
            data-has-results={results.length > 0 || undefined}
            onScroll={(event) => {
              const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
              if (!pending && scrollHeight - scrollTop - clientHeight <= 64) onMore?.();
            }}
          >
            <div id={listId} role="listbox" aria-label="会话搜索结果">
              {results.map((row, index) => {
                const time = sessionSearchActivityTime(row.updatedAtMs, now);
                return (
                  <Button
                    key={row.key}
                    ref={index === activeIndex ? activeRow : undefined}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-disabled={pending || undefined}
                    tabIndex={-1}
                    variant="ghost"
                    className="session-search-result"
                    disabled={!onOpen}
                    title={[row.session.displayName, row.workspaceLabel, row.location]
                      .filter(Boolean)
                      .join('\n')}
                    onMouseDown={(event) => {
                      if (pending) event.preventDefault();
                    }}
                    onClick={() => open(row)}
                  >
                    <span className="session-search-result-label">
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
                    </span>
                    {time && (
                      <time
                        className="session-search-result-time"
                        dateTime={time.dateTime}
                        title={time.title}
                      >
                        {time.label}
                      </time>
                    )}
                  </Button>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
