import { Cancel01Icon, Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
        .map(({ updatedAt, ...session }) => {
          const time = Date.parse(updatedAt ?? '');
          return {
            key: JSON.stringify([workspace.id, session.sessionId]),
            session,
            ...(Number.isFinite(time) ? { updatedAtMs: time } : {}),
            workspaceLabel: workspace.label,
            ...((names.get(workspace.label) ?? 0) > 1
              ? { location: workspace.rootUri || workspace.id }
              : {}),
          };
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
      total={results.length}
      results={results}
      visibleCount={visibleCount}
      onMore={() => setVisibleCount(visibleCount + SESSION_SEARCH_PAGE_SIZE)}
    />
  );
}

export function SessionSearchPalette({
  id,
  query,
  setQuery,
  complete,
  results,
  total,
  visibleCount,
  page,
  pending,
  landAtLast,
  onMore,
  onOpen,
  onClose,
  restoreFocus,
}: Omit<SessionSearchProps, 'available' | 'workspaces'> & {
  query: string;
  setQuery(value: string): void;
  complete: boolean;
  results: readonly SearchRow[];
  total: number;
  visibleCount: number;
  page?: number;
  pending?: boolean;
  landAtLast?: boolean;
  onMore?(page: number, landAtLast?: boolean): void;
}) {
  const [activeKey, setActiveKey] = useState<string>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const opening = useRef(false);
  const composing = useRef(false);
  const restoreOnClose = useRef(false);
  const listId = useId();
  const searching = Boolean(query.trim());
  const matched = results.findIndex((row) => row.key === activeKey);
  const activeIndex = matched >= 0 ? matched : landAtLast ? Math.max(0, results.length - 1) : 0;
  const active = results[activeIndex];
  const activeId = active ? `${listId}-${activeIndex}` : undefined;
  const visible = results.slice(0, Math.max(visibleCount, activeIndex + 1));
  useEffect(() => {
    if (activeId && active?.key) activeRow.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, active?.key]);
  function open(row: SearchRow) {
    if (!complete || !onOpen || opening.current || pending) return;
    opening.current = true;
    onOpen(row.session.sessionId);
    onClose();
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
                setQuery(event.target.value);
                setActiveKey(undefined);
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
                    page !== undefined &&
                    onMore &&
                    event.key === 'ArrowDown' &&
                    activeIndex === results.length - 1 &&
                    (page + 1) * SESSION_SEARCH_PAGE_SIZE < total
                  ) {
                    setActiveKey(undefined);
                    onMore(page + 1);
                  } else if (
                    page !== undefined &&
                    onMore &&
                    event.key === 'ArrowUp' &&
                    activeIndex === 0 &&
                    page > 0
                  ) {
                    setActiveKey(undefined);
                    onMore(page - 1, true);
                  } else setActiveKey(results[next]?.key);
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
          {!pending && (!complete || total === 0) && (
            <p className="session-search-feedback" role="status">
              {!complete
                ? '会话目录暂不可用，恢复后会自动更新。'
                : searching
                  ? '未找到匹配的会话'
                  : '暂无会话'}
            </p>
          )}
          <div
            className="session-search-results"
            aria-busy={pending || undefined}
            data-has-results={visible.length > 0 || undefined}
          >
            <div id={listId} role="listbox" aria-label="会话搜索结果">
              {visible.map((row, index) => {
                const time = sessionSearchActivityTime(row.updatedAtMs, now);
                return (
                  <Button
                    key={row.key}
                    ref={index === activeIndex ? activeRow : undefined}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    tabIndex={-1}
                    variant="ghost"
                    className="session-search-result"
                    disabled={!onOpen || pending}
                    title={[row.session.displayName, row.workspaceLabel, row.location]
                      .filter(Boolean)
                      .join('\n')}
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
            {!pending && onMore && page === undefined && visible.length < results.length && (
              <Button className="session-search-more" variant="ghost" onClick={() => onMore(0)}>
                显示更多（已显示 {visible.length} / {total}）
              </Button>
            )}
            {onMore && page !== undefined && total > SESSION_SEARCH_PAGE_SIZE && (
              <div className="session-search-pages">
                <Button
                  variant="ghost"
                  disabled={pending || !page}
                  onClick={() => {
                    setActiveKey(undefined);
                    onMore(page - 1);
                    input.current?.focus();
                  }}
                >
                  上一页
                </Button>
                <span>
                  {page + 1} / {Math.ceil(total / SESSION_SEARCH_PAGE_SIZE)}
                </span>
                <Button
                  variant="ghost"
                  disabled={pending || (page + 1) * SESSION_SEARCH_PAGE_SIZE >= total}
                  onClick={() => {
                    setActiveKey(undefined);
                    onMore(page + 1);
                    input.current?.focus();
                  }}
                >
                  下一页
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
