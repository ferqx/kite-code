import { Button, FileDiff } from '@kite-ai/ui/desktop';
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import {
  boundedWorkspaceChanges,
  filterWorkspaceChanges,
  visibleWorkspaceTreeRows,
  WORKSPACE_FILTER_LIMIT,
  WORKSPACE_TREE_PAGE_SIZE,
  type WorkspaceChangeTreeNode,
  workspaceChangeStatus,
  workspaceChangeTree,
  workspacePathLabel,
} from './native-workspace-change-tree';
import type {
  NativeWorkspaceChange,
  NativeWorkspaceChangeDetail,
  NativeWorkspaceChangePage,
} from './workspace-changes-bridge';
import './native-workspace-changes.css';

function workspaceReadError(cause: unknown, fallback: string): string {
  const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
  const known: Record<string, string> = {
    workspace_changes_filters_unsupported:
      '仓库配置了 Git 内容过滤器（例如 LFS），为避免执行外部程序，此处不读取。请使用本地 Git 工具查看。',
    workspace_changes_attributes_unsupported:
      '仓库或全局属性设置暂不支持安全预览，请使用本地 Git 工具查看。',
    workspace_changes_split_index_unsupported:
      '此仓库使用分离索引，暂不支持预览。请使用本地 Git 工具查看。',
    workspace_changes_index_too_large: 'Git 索引超过读取上限，未加载。请使用本地 Git 工具查看。',
    workspace_changes_protected_root: '仓库范围包含受保护目录，无法安全读取整个仓库。',
    workspace_changes_excludes_unsupported:
      'Git 忽略文件过大或无法安全读取，请使用本地 Git 工具查看。',
    workspace_changes_config_unsupported:
      '当前 Git 配置暂不支持安全预览，请使用本地 Git 工具查看。',
  };
  return known[code ?? ''] ?? fallback;
}

function WorkspaceChangeDetail({
  bridge,
  generation,
  entry,
  layout,
  onLayoutChange,
  observationId,
  refreshing,
}: {
  bridge: NativeBridge;
  generation: number;
  entry: NativeWorkspaceChange;
  layout: 'split' | 'unified';
  onLayoutChange: (layout: 'split' | 'unified') => void;
  observationId: string;
  refreshing: boolean;
}) {
  const [body, setBody] = useState<NativeWorkspaceChangeDetail>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    // A replaced list lease cancels an in-flight read, but the last verified body
    // remains readable until the successor is available. It is never another path.
    if (refreshing) return;
    const readId = `${observationId}-${crypto.randomUUID()}`;
    let active = true;
    setLoading(true);
    setError('');
    void bridge
      .request({ method: 'workspaceChanges.detail', generation, changeId: entry.changeId, readId })
      .then((value) => {
        if (!active) return;
        if (
          !value ||
          !('readId' in value) ||
          !('kind' in value) ||
          value.kind !== 'workspaceChanges.detail' ||
          value.readId !== readId ||
          value.changeId !== entry.changeId
        )
          throw Error('workspace_change_identity_mismatch');
        setBody((previous) =>
          previous?.text === value.text &&
          previous?.reason === value.reason &&
          previous?.truncated === value.truncated
            ? previous
            : value,
        );
      })
      .catch((cause) => {
        if (active)
          setError(
            workspaceReadError(cause, '无法读取当前差异，文件可能已变化。请刷新列表后重试。'),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      void bridge.request({ method: 'workspaceChanges.close', generation, readId }).catch(() => {});
    };
  }, [bridge, generation, entry.changeId, observationId, refreshing]);
  if (error && !body)
    return (
      <p className="workspace-change-notice" role="alert">
        {error}
      </p>
    );
  if (!body)
    return (
      <div
        className="workspace-change-empty"
        role="status"
        aria-label="正在读取当前差异"
        aria-busy="true"
      >
        <span className="workspace-change-spinner" />
      </div>
    );
  const reasons = {
    binary: '二进制文件不显示文本差异。',
    too_large: '文件过大，未加载完整差异。请在本地 Git 工具中查看。',
    unsupported: '此文件类型或仓库状态不支持文本预览。',
    unavailable: '差异目前不可读，请刷新后重试。',
  };
  return (
    <>
      {error && (
        <p className="workspace-change-notice" role="alert">
          {error} 当前显示上次读取的内容。
        </p>
      )}
      <div className="workspace-change-live-body" aria-busy={refreshing || loading || undefined}>
        {!body.text && (
          <div className="workspace-change-path" title={workspacePathLabel(entry.path, 1_024)}>
            {workspacePathLabel(entry.path)}
          </div>
        )}
        {body.reason && (
          <p className="workspace-change-notice" role="status">
            {reasons[body.reason]}
          </p>
        )}
        {body.truncated && (
          <p className="workspace-change-notice" role="status">
            差异预览已截断，未显示全部改动。
          </p>
        )}
        {body.text ? (
          <FileDiff
            path={entry.path}
            scope="workspace"
            layout={layout}
            onLayoutChange={onLayoutChange}
            message={{
              id: entry.path,
              role: 'tool',
              text: '',
              settled: true,
              toolResult: { ok: true, stdout: body.text },
            }}
          />
        ) : (
          !body.reason && (
            <p className="workspace-change-notice">
              当前文件内容与 HEAD 相同；暂存区仍可能有独立改动。
            </p>
          )
        )}
      </div>
    </>
  );
}

function WorkspaceChangeBrowser({
  bridge,
  generation,
  page,
  query,
  onQueryChange,
  selectedPath,
  onSelectPath,
  layout,
  onLayoutChange,
  refreshing,
}: {
  bridge: NativeBridge;
  generation: number;
  page: NativeWorkspaceChangePage;
  query: string;
  onQueryChange: (query: string) => void;
  selectedPath?: string;
  onSelectPath: (path: string | undefined) => void;
  layout: 'split' | 'unified';
  onLayoutChange: (layout: 'split' | 'unified') => void;
  refreshing: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string>();
  const pendingFocus = useRef<string | undefined>(undefined);
  const treeRef = useRef<HTMLDivElement>(null);
  const boundedPage = useMemo(() => boundedWorkspaceChanges(page.entries), [page.entries]);
  const entries = boundedPage.entries;
  const filtered = useMemo(() => filterWorkspaceChanges(entries, query), [entries, query]);
  const tree = useMemo(() => workspaceChangeTree(filtered), [filtered]);
  const rows = useMemo(() => visibleWorkspaceTreeRows(tree.nodes, collapsed), [tree, collapsed]);
  const [pageIndex, setPageIndex] = useState(() =>
    Math.floor(
      Math.max(
        0,
        rows.findIndex(({ node }) => node.kind === 'file' && node.entry.path === selectedPath),
      ) / WORKSPACE_TREE_PAGE_SIZE,
    ),
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / WORKSPACE_TREE_PAGE_SIZE));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const visibleRows = rows.slice(
    currentPage * WORKSPACE_TREE_PAGE_SIZE,
    (currentPage + 1) * WORKSPACE_TREE_PAGE_SIZE,
  );
  const activeFocus = visibleRows.some(({ node }) => node.id === focusedId)
    ? focusedId
    : visibleRows[0]?.node.id;
  const selected = filtered.find((entry) => entry.path === selectedPath);
  const truncated = page.truncated || boundedPage.truncated;
  const previousViewport = useRef<{ page: number; query: string } | undefined>(undefined);
  useLayoutEffect(() => {
    if (
      previousViewport.current?.page !== currentPage ||
      previousViewport.current?.query !== query
    ) {
      if (treeRef.current) treeRef.current.scrollTop = 0;
      previousViewport.current = { page: currentPage, query };
    }
  }, [currentPage, query]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const target = [
      ...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
    ].find((node) => node.dataset.treeId === pendingFocus.current);
    if (target) {
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
      pendingFocus.current = undefined;
    }
  });
  function focusRow(index: number) {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    if (!row) return;
    pendingFocus.current = row.node.id;
    setFocusedId(row.node.id);
    setPageIndex(
      Math.floor(Math.max(0, Math.min(index, rows.length - 1)) / WORKSPACE_TREE_PAGE_SIZE),
    );
  }
  function toggleDirectory(node: WorkspaceChangeTreeNode) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
    setFocusedId(node.id);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = rows.findIndex(({ node }) => node.id === activeFocus);
    const node = rows[index]?.node;
    if (!node) return;
    if (event.key === 'ArrowDown') focusRow(index + 1);
    else if (event.key === 'ArrowUp') focusRow(index - 1);
    else if (event.key === 'Home') focusRow(0);
    else if (event.key === 'End') focusRow(rows.length - 1);
    else if (event.key === 'ArrowRight') {
      if (node.kind !== 'directory') return;
      if (collapsed.has(node.id)) toggleDirectory(node);
      else focusRow(index + 1);
    } else if (event.key === 'ArrowLeft') {
      if (node.kind === 'directory' && !collapsed.has(node.id)) toggleDirectory(node);
      else if (node.parentId) focusRow(rows.findIndex((row) => row.node.id === node.parentId));
    } else return;
    event.preventDefault();
  }
  function changeFilter(value: string) {
    const nextQuery = value.slice(0, WORKSPACE_FILTER_LIMIT);
    onQueryChange(nextQuery);
    setPageIndex(0);
    setFocusedId(undefined);
    // Search results are immediately reachable even if their parent was previously folded.
    setCollapsed(new Set());
    if (selected && !filterWorkspaceChanges([selected], nextQuery).length) onSelectPath(undefined);
  }
  return (
    <div className="workspace-changes-body">
      <section className="workspace-change-editor" aria-label="选中文件差异">
        {selected ? (
          <>
            <div className="workspace-change-status">
              <span>{workspaceChangeStatus(selected)}</span>
              {selected.oldPath && (
                <span
                  className="workspace-change-rename"
                  title={workspacePathLabel(`${selected.oldPath} → ${selected.path}`, 1_024)}
                >
                  重命名：{workspacePathLabel(selected.oldPath)} →{' '}
                  {workspacePathLabel(selected.path)}
                </span>
              )}
              <button
                type="button"
                className="workspace-change-clear"
                aria-label="关闭当前文件差异"
                onClick={() => onSelectPath(undefined)}
              >
                ×
              </button>
            </div>
            <div className="workspace-change-preview">
              <WorkspaceChangeDetail
                key={selected.path}
                bridge={bridge}
                generation={generation}
                entry={selected}
                layout={layout}
                onLayoutChange={onLayoutChange}
                observationId={page.readId}
                refreshing={refreshing}
              />
            </div>
          </>
        ) : (
          <div className="workspace-change-empty">
            <span className="workspace-change-empty-icon" aria-hidden="true">
              ±
            </span>
            <p>
              {entries.length
                ? '选择文件查看差异'
                : truncated
                  ? '未取得可展示文件，请在本地 Git 工具中查看。'
                  : '本次读取未发现已暂存、未暂存或未跟踪文件。'}
            </p>
            {entries.length > 0 && <span>只读取选中文件的当前内容</span>}
          </div>
        )}
      </section>
      <aside className="workspace-change-files" aria-label="变更文件导航">
        <div className="workspace-change-files-header">
          <label className="workspace-change-filter">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              aria-label="筛选文件"
              placeholder="筛选文件…"
              value={query}
              maxLength={WORKSPACE_FILTER_LIMIT}
              onInput={(event) => changeFilter(event.currentTarget.value)}
            />
          </label>
          <div className="workspace-change-files-title">
            <strong>已更改的文件</strong>
            <span>
              {query.trim() ? `${filtered.length} / ` : ''}
              {entries.length}
              {truncated ? '+' : ''} 个文件
            </span>
          </div>
        </div>
        <div
          className="workspace-change-tree"
          role="tree"
          aria-label="变更文件"
          ref={treeRef}
          onKeyDown={handleKeyDown}
        >
          {visibleRows.map(({ node, level, position, size }) => (
            <button
              type="button"
              role="treeitem"
              key={node.id}
              className={`workspace-change-tree-row ${node.kind === 'file' ? 'workspace-change-tree-file' : 'workspace-change-tree-directory'}`}
              data-tree-id={node.id}
              data-change-id={
                node.kind === 'file' ? workspacePathLabel(node.entry.changeId, 1_024) : undefined
              }
              style={{ '--tree-level': Math.min(level - 1, 8) } as CSSProperties}
              aria-level={level}
              aria-posinset={position}
              aria-setsize={size}
              aria-expanded={node.kind === 'directory' ? !collapsed.has(node.id) : undefined}
              aria-selected={
                node.kind === 'file' ? selected?.changeId === node.entry.changeId : undefined
              }
              aria-label={
                node.kind === 'file'
                  ? `${node.title}，${workspaceChangeStatus(node.entry)}`
                  : node.title
              }
              tabIndex={node.id === activeFocus ? 0 : -1}
              title={node.title}
              onFocus={() => setFocusedId(node.id)}
              onClick={() =>
                node.kind === 'directory' ? toggleDirectory(node) : onSelectPath(node.entry.path)
              }
            >
              <span className="workspace-change-tree-glyph" aria-hidden="true">
                {node.kind === 'directory' ? (collapsed.has(node.id) ? '›' : '⌄') : '≡'}
              </span>
              <span className="workspace-change-tree-name">{node.label}</span>
              {node.kind === 'file' && (
                <span
                  className="workspace-change-tree-status"
                  title={workspaceChangeStatus(node.entry)}
                >
                  {node.entry.untracked
                    ? node.entry.indexStatus === 'D'
                      ? 'D?'
                      : '?'
                    : `${node.entry.indexStatus}${node.entry.worktreeStatus}`.trim()}
                </span>
              )}
            </button>
          ))}
          {!filtered.length && entries.length > 0 && (
            <p className="workspace-change-no-match" role="status">
              没有匹配的变更文件
            </p>
          )}
        </div>
        {pageCount > 1 && (
          <nav className="workspace-change-pagination" aria-label="文件树分页">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => {
                setPageIndex(currentPage - 1);
                setFocusedId(undefined);
              }}
            >
              上一页
            </button>
            <span>
              {currentPage + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={currentPage === pageCount - 1}
              onClick={() => {
                setPageIndex(currentPage + 1);
                setFocusedId(undefined);
              }}
            >
              下一页
            </button>
          </nav>
        )}
        {tree.simplified && (
          <p className="workspace-change-tree-notice" role="status">
            部分目录已简化为相对路径，所有已加载文件仍可筛选和查看。
          </p>
        )}
        {truncated && (
          <p className="workspace-change-tree-notice" role="status">
            仓库变更列表已截断；请在本地 Git 工具中查看全部文件。
          </p>
        )}
      </aside>
    </div>
  );
}

type WorkspaceChangesProps = {
  bridge: NativeBridge;
  generation: number;
  selection: NativeSelection;
  refreshKey?: string;
};

/** The visible Git tab owns a bounded read, independent of saved tool receipts. */
export function NativeWorkspaceChanges(props: WorkspaceChangesProps) {
  const { generation, selection } = props;
  const scope = JSON.stringify([
    generation,
    selection.viewSelection ?? selection.viewGeneration,
    selection.storeId,
    selection.session.id,
    selection.session.workspaceId,
  ]);
  return <WorkspaceChangesView key={scope} {...props} />;
}

function WorkspaceChangesView({
  bridge,
  generation,
  selection,
  refreshKey = '',
}: WorkspaceChangesProps) {
  const viewSelection = selection.viewSelection ?? selection.viewGeneration;
  const storeId = selection.storeId;
  const sessionId = selection.session.id;
  const workspaceId = selection.session.workspaceId;
  const [selectedPath, setSelectedPath] = useState<string>();
  const [layout, setLayout] = useState<'split' | 'unified'>('split');
  const [query, setQuery] = useState('');
  const currentQuery = useRef(query);
  useLayoutEffect(() => {
    currentQuery.current = query;
  }, [query]);
  const [state, setState] = useState<{
    bridge: NativeBridge;
    page?: NativeWorkspaceChangePage;
    error?: string;
    loading: boolean;
  }>({ bridge, loading: true });
  const refreshRequest = useRef<((delay?: number) => void) | undefined>(undefined);
  useEffect(() => {
    let active = true;
    let pending = false;
    let queued = false;
    let readId: string | undefined;
    let epoch = 0;
    let lastReadStarted = 0;
    let lastReadDuration = 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (readId)
        void bridge
          .request({ method: 'workspaceChanges.close', generation, readId })
          .catch(() => {});
      readId = undefined;
    };
    const schedule = (delay = 150) => {
      queued = true;
      if (delay === 0) {
        failures = 0;
        clearTimeout(timer);
        timer = undefined;
      }
      // One in-flight observation and at most one successor: write bursts cannot
      // repeatedly cancel Git work or starve the panel. Hidden windows do no I/O.
      if (!active || pending || timer || document.visibilityState === 'hidden') return;
      // Native Git observations are not cheap: cap automatic reads to 1 Hz,
      // with a larger cool-down when the previous repository read was slow.
      const wait =
        delay === 0
          ? 0
          : Math.max(
              delay,
              lastReadStarted +
                Math.min(10_000, Math.max(1_000, lastReadDuration * 4)) -
                Date.now(),
            );
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, wait);
    };
    const read = async () => {
      if (!active || document.visibilityState === 'hidden') return;
      queued = false;
      pending = true;
      const ownEpoch = ++epoch;
      lastReadStarted = Date.now();
      let nextDelay = 500;
      const ownReadId = crypto.randomUUID();
      readId = ownReadId;
      setState((previous) => ({
        ...(previous.bridge === bridge ? previous : {}),
        bridge,
        loading: true,
        error: undefined,
      }));
      try {
        const value = await bridge.request({
          method: 'workspaceChanges.list',
          generation,
          viewSelection,
          readId: ownReadId,
        });
        if (!active || ownEpoch !== epoch) return;
        if (
          !value ||
          !('readId' in value) ||
          !('kind' in value) ||
          value.kind !== 'workspaceChanges.page' ||
          value.readId !== ownReadId ||
          value.scope.generation !== generation ||
          value.scope.viewSelection !== viewSelection ||
          value.scope.storeId !== storeId ||
          value.scope.sessionId !== sessionId ||
          value.scope.workspaceId !== workspaceId
        )
          throw Error('workspace_change_identity_mismatch');
        failures = 0;
        const bounded = boundedWorkspaceChanges(value.entries);
        setSelectedPath((previous) => {
          const selected = previous && bounded.entries.find((entry) => entry.path === previous);
          return selected && filterWorkspaceChanges([selected], currentQuery.current).length
            ? previous
            : undefined;
        });
        setState({
          bridge,
          page: {
            ...value,
            entries: bounded.entries,
            truncated: value.truncated || bounded.truncated,
          },
          loading: false,
        });
      } catch (cause) {
        if (active && ownEpoch === epoch) {
          const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
          if (!/unsupported|protected|identity_mismatch/.test(code ?? '') && ++failures <= 3) {
            queued = true;
            nextDelay = failures * 3_000;
          }
          setState((previous) => ({
            ...previous,
            bridge,
            loading: false,
            error: workspaceReadError(
              cause,
              '无法确认工作区变更，请刷新重试。读取失败不表示没有改动。',
            ),
          }));
        }
      } finally {
        if (active && ownEpoch === epoch) {
          pending = false;
          lastReadDuration = Date.now() - lastReadStarted;
          if (queued) schedule(nextDelay);
        }
      }
    };
    const focus = () => schedule(0);
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        timer = undefined;
        ++epoch;
        pending = false;
        queued = true;
        close();
        setState((previous) => ({ ...previous, loading: true }));
      } else schedule(0);
    };
    const unwatch = bridge.watch((event) => {
      if (
        event.kind !== 'workspaceChanges.changed' ||
        event.readId !== readId ||
        event.generation !== generation ||
        event.scope.generation !== generation ||
        event.scope.viewSelection !== viewSelection ||
        event.scope.storeId !== storeId ||
        event.scope.sessionId !== sessionId ||
        event.scope.workspaceId !== workspaceId
      )
        return;
      schedule();
    });
    refreshRequest.current = schedule;
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    schedule(0);
    return () => {
      active = false;
      ++epoch;
      clearTimeout(timer);
      refreshRequest.current = undefined;
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
      unwatch();
      close();
    };
  }, [bridge, generation, viewSelection, storeId, sessionId, workspaceId]);
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    refreshRequest.current?.();
  }, [refreshKey]);
  const current =
    state.bridge === bridge ? state : { bridge, loading: true, page: undefined, error: undefined };
  return (
    <div className="workspace-changes" aria-busy={current.loading || undefined}>
      <header className="workspace-changes-toolbar">
        <strong>工作区变更</strong>
        <span className="workspace-changes-baseline">当前内容 ↔ HEAD</span>
        <Button
          className="ghost workspace-changes-refresh"
          disabled={current.loading}
          onClick={() => refreshRequest.current?.(0)}
        >
          刷新变更
        </Button>
      </header>
      <div className="workspace-changes-scope">
        <span>整个仓库 · 不代表 Agent 的贡献</span>
        <details>
          <summary>范围说明</summary>
          <p>
            整个仓库的当前内容相对
            HEAD（当前分支末次提交，无提交时与空树比较）。包含已暂存、未暂存和未跟踪文件。子模块内部改动不在此列表中；请在子模块的
            Git 工具中查看。
          </p>
        </details>
      </div>
      {current.loading && !current.page && (
        <div
          className="workspace-change-empty"
          role="status"
          aria-label="正在读取工作区"
          aria-busy="true"
        >
          <span className="workspace-change-spinner" />
        </div>
      )}
      {current.error && (
        <p className="workspace-change-notice" role="alert">
          {current.error}
          {current.page && ' 当前显示上次读取的结果，尚未确认最新内容。'}
        </p>
      )}
      {current.page && !current.page.repository && (
        <p className="workspace-change-notice">
          当前项目不在 Git 仓库中。每次文件工具的历史差异仍可在会话中展开。
        </p>
      )}
      {current.page?.repository && (
        <WorkspaceChangeBrowser
          bridge={bridge}
          generation={generation}
          page={current.page}
          query={query}
          onQueryChange={setQuery}
          selectedPath={selectedPath}
          onSelectPath={setSelectedPath}
          layout={layout}
          onLayoutChange={setLayout}
          refreshing={current.loading || !!current.error}
        />
      )}
    </div>
  );
}
