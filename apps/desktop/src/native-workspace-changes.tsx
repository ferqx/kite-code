import {
  Badge,
  Button,
  FileDiff,
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  Input,
} from '@kite-ai/ui/desktop';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
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
  type WorkspaceChangeTreeRow,
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
  listFailed,
  onClose,
}: {
  bridge: NativeBridge;
  generation: number;
  entry: NativeWorkspaceChange;
  layout: 'split' | 'unified';
  onLayoutChange: (layout: 'split' | 'unified') => void;
  observationId: string;
  refreshing: boolean;
  listFailed: boolean;
  onClose: () => void;
}) {
  const [body, setBody] = useState<NativeWorkspaceChangeDetail>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    // A replaced list lease cancels an in-flight read, but the last verified body
    // remains readable until the successor is available. It is never another path.
    if (refreshing || listFailed) return;
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
          setError(workspaceReadError(cause, '无法读取当前差异，请重新打开「变更」重试。'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      void bridge.request({ method: 'workspaceChanges.close', generation, readId }).catch(() => {});
    };
  }, [bridge, generation, entry.changeId, observationId, refreshing, listFailed]);
  const separator = entry.path.lastIndexOf('/');
  const folder = separator === -1 ? '' : entry.path.slice(0, separator);
  const header = {
    title: (
      <div className="workspace-change-file-heading" title={workspacePathLabel(entry.path, 1_024)}>
        <span className="workspace-change-file-icon" aria-hidden="true" />
        <div className="workspace-change-file-label">
          <strong>{workspacePathLabel(entry.path.slice(separator + 1))}</strong>
          <div className="workspace-change-file-meta">
            {folder && <span>{workspacePathLabel(folder)}</span>}
            <span>{workspaceChangeStatus(entry)}</span>
          </div>
          {entry.oldPath && (
            <span
              className="workspace-change-rename"
              title={workspacePathLabel(entry.oldPath, 1_024)}
            >
              原路径 {workspacePathLabel(entry.oldPath)}
            </span>
          )}
        </div>
      </div>
    ),
    action: (
      <Button
        variant="ghost"
        size="icon-sm"
        className="workspace-change-clear"
        aria-label="关闭当前文件差异"
        title="关闭当前文件差异"
        onClick={onClose}
      >
        ×
      </Button>
    ),
  };
  const standaloneHeader = (
    <div className="workspace-change-file-bar">
      {header.title}
      {header.action}
    </div>
  );
  if (!body) {
    const unavailable = listFailed ? '无法读取当前差异，请重新打开「变更」重试。' : error;
    return (
      <>
        {standaloneHeader}
        {unavailable ? (
          <p className="workspace-change-notice" role="alert">
            {unavailable}
          </p>
        ) : (
          <div
            className="workspace-change-empty"
            role="status"
            aria-label="正在读取当前差异"
            aria-busy="true"
          >
            <span className="workspace-change-spinner" />
          </div>
        )}
      </>
    );
  }
  const reasons = {
    binary: '二进制文件不显示文本差异。',
    too_large: '文件过大，未加载完整差异。请在本地 Git 工具中查看。',
    unsupported: '此文件类型或仓库状态不支持文本预览。',
    unavailable: '差异目前不可读，请重新打开「变更」重试。',
  };
  return (
    <>
      {!body.text && standaloneHeader}
      {error && (
        <p className="workspace-change-notice" role="alert">
          {error} 当前显示上次读取的内容。
        </p>
      )}
      <div
        className="workspace-change-live-body"
        aria-busy={(!listFailed && (refreshing || loading)) || undefined}
      >
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
            header={header}
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
  listFailed,
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
  listFailed: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string>();
  const treeRef = useRef<HTMLDivElement>(null);
  const boundedPage = useMemo(() => boundedWorkspaceChanges(page.entries), [page.entries]);
  const entries = boundedPage.entries;
  const filtered = useMemo(() => filterWorkspaceChanges(entries, query), [entries, query]);
  const tree = useMemo(() => workspaceChangeTree(filtered), [filtered]);
  const rows = useMemo(() => visibleWorkspaceTreeRows(tree.nodes, collapsed), [tree, collapsed]);
  const rowsByParent = useMemo(() => {
    const groups = new Map<string | undefined, WorkspaceChangeTreeRow[]>();
    for (const row of rows) {
      const parent = row.node.parentId;
      const group = groups.get(parent);
      if (group) group.push(row);
      else groups.set(parent, [row]);
    }
    return groups;
  }, [rows]);
  const activeFocus = rows.some(({ node }) => node.id === focusedId) ? focusedId : rows[0]?.node.id;
  const selected = filtered.find((entry) => entry.path === selectedPath);
  const truncated = page.truncated || boundedPage.truncated;
  useLayoutEffect(() => {
    treeRef.current
      ?.querySelector('[role="treeitem"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, []);
  function focusRow(index: number) {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    if (!row) return;
    const target = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    ).find((item) => item.dataset.treeId === row.node.id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }
  function setDirectoryOpen(id: string, open: boolean) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
    setFocusedId(id);
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
      if (collapsed.has(node.id)) setDirectoryOpen(node.id, true);
      else focusRow(index + 1);
    } else if (event.key === 'ArrowLeft') {
      if (node.kind === 'directory' && !collapsed.has(node.id)) setDirectoryOpen(node.id, false);
      else if (node.parentId) focusRow(rows.findIndex((row) => row.node.id === node.parentId));
    } else return;
    event.preventDefault();
  }
  function changeFilter(value: string) {
    const nextQuery = value.slice(0, WORKSPACE_FILTER_LIMIT);
    onQueryChange(nextQuery);
    if (treeRef.current) treeRef.current.scrollTop = 0;
    setFocusedId(undefined);
    // Search results are immediately reachable even if their parent was previously folded.
    setCollapsed(new Set());
    if (selected && !filterWorkspaceChanges([selected], nextQuery).length) onSelectPath(undefined);
  }
  function renderTreeRows(parentId?: string): ReactNode {
    return rowsByParent.get(parentId)?.map(({ node, level, position, size }) => {
      const rowProps = {
        className: 'workspace-change-tree-row',
        label: node.label,
        'data-tree-id': node.id,
        style: { '--tree-level': Math.min(level - 1, 6) } as CSSProperties,
        'aria-level': level,
        'aria-posinset': position,
        'aria-setsize': size,
        tabIndex: node.id === activeFocus ? 0 : -1,
        title: node.title,
        onFocus: () => setFocusedId(node.id),
      };
      if (node.kind === 'directory')
        return (
          <FileTreeFolder
            key={node.id}
            {...rowProps}
            path={node.title}
            aria-label={node.title}
            open={!collapsed.has(node.id)}
            onOpenChange={(open) => setDirectoryOpen(node.id, open)}
          >
            {renderTreeRows(node.id)}
          </FileTreeFolder>
        );
      const { entry } = node;
      const status = workspaceChangeStatus(entry);
      const indexMarker =
        entry.untracked && entry.indexStatus !== 'D' ? '' : entry.indexStatus.trim();
      const worktreeMarker = entry.untracked ? 'U' : entry.worktreeStatus.trim();
      return (
        <FileTreeFile
          key={node.id}
          {...rowProps}
          path={entry.path}
          data-change-id={workspacePathLabel(entry.changeId, 1_024)}
          aria-selected={selected?.changeId === entry.changeId}
          aria-label={`${node.title}，${status}`}
          onClick={() => onSelectPath(entry.path)}
        >
          <Badge className="workspace-change-tree-status" aria-hidden="true" title={status}>
            {indexMarker && <span data-git-status={indexMarker}>{indexMarker}</span>}
            {indexMarker && worktreeMarker && ', '}
            {worktreeMarker && (
              <span data-git-status={entry.untracked ? 'untracked' : worktreeMarker}>
                {worktreeMarker}
              </span>
            )}
          </Badge>
        </FileTreeFile>
      );
    });
  }
  return (
    <div className="workspace-changes-body">
      <section className="workspace-change-editor" aria-label="选中文件差异">
        {selected ? (
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
              listFailed={listFailed}
              onClose={() => onSelectPath(undefined)}
            />
          </div>
        ) : (
          <div className="workspace-change-empty">
            <p>
              {entries.length
                ? '选择文件查看差异'
                : truncated
                  ? '未取得可展示文件，请在本地 Git 工具中查看。'
                  : '本次读取未发现已暂存、未暂存或未跟踪文件。'}
            </p>
          </div>
        )}
      </section>
      <aside className="workspace-change-files" aria-label="变更文件导航">
        <div className="workspace-change-files-header">
          <div className="workspace-change-filter">
            <span className="workspace-change-search-icon" aria-hidden="true" />
            <Input
              type="search"
              aria-label="筛选文件"
              placeholder="筛选文件…"
              value={query}
              maxLength={WORKSPACE_FILTER_LIMIT}
              onInput={(event) => changeFilter(event.currentTarget.value)}
            />
          </div>
          <div className="workspace-change-files-title">
            <span>
              {query.trim() ? `${filtered.length} / ` : ''}
              {entries.length}
              {truncated ? '+' : ''} 个文件
            </span>
          </div>
        </div>
        <FileTree
          className="workspace-change-tree"
          aria-label="变更文件"
          ref={treeRef}
          onKeyDown={handleKeyDown}
        >
          {renderTreeRows()}
          {!filtered.length && entries.length > 0 && (
            <p className="workspace-change-no-match" role="status">
              没有匹配的变更文件
            </p>
          )}
        </FileTree>
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
  fileSelection?: { current: WorkspaceChangeSelection | undefined };
};

export type WorkspaceChangeSelection = {
  scope: string;
  repositoryIdentity: string | undefined;
  path: string;
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
  return <WorkspaceChangesView key={scope} {...props} scope={scope} />;
}

function WorkspaceChangesView({
  bridge,
  generation,
  selection,
  scope,
  refreshKey = '',
  fileSelection,
}: WorkspaceChangesProps & { scope: string }) {
  const viewSelection = selection.viewSelection ?? selection.viewGeneration;
  const storeId = selection.storeId;
  const sessionId = selection.session.id;
  const workspaceId = selection.session.workspaceId;
  const [selectedFile, setSelectedFile] = useState(() => {
    const remembered = fileSelection?.current;
    return remembered?.repositoryIdentity && remembered.scope === scope ? remembered : undefined;
  });
  useLayoutEffect(() => {
    if (fileSelection) fileSelection.current = selectedFile;
  }, [fileSelection, selectedFile]);
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
  const refreshRequest = useRef<(() => void) | undefined>(undefined);
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
        setSelectedFile((previous) => {
          const selected =
            previous &&
            previous.repositoryIdentity === value.repositoryIdentity &&
            bounded.entries.find((entry) => entry.path === previous.path);
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
            error: workspaceReadError(cause, '无法确认工作区变更，请重新打开「变更」重试。'),
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
      if (event.reset) {
        ++epoch;
        pending = false;
        close();
        setSelectedFile(undefined);
        setState({ bridge, loading: true });
        schedule(0);
        return;
      }
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
      </header>
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
          selectedPath={
            selectedFile?.repositoryIdentity === current.page.repositoryIdentity
              ? selectedFile?.path
              : undefined
          }
          onSelectPath={(path) =>
            setSelectedFile(
              path
                ? { scope, repositoryIdentity: current.page?.repositoryIdentity, path }
                : undefined,
            )
          }
          layout={layout}
          onLayoutChange={setLayout}
          refreshing={current.loading}
          listFailed={!!current.error}
        />
      )}
    </div>
  );
}
