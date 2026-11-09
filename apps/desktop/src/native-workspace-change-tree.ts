import type { NativeWorkspaceChange } from './workspace-changes-bridge';

export const WORKSPACE_TREE_PAGE_SIZE = 50;
export const WORKSPACE_CHANGE_LIMIT = 1_000;
export const WORKSPACE_METADATA_BYTE_LIMIT = 512 * 1_024;
export const WORKSPACE_TREE_DEPTH_LIMIT = 24;
export const WORKSPACE_TREE_DIRECTORY_LIMIT = 2_048;
export const WORKSPACE_FILTER_LIMIT = 256;

/** Presentation only: the bridge always receives the original opaque changeId. */
export function workspacePathLabel(value: string, limit = 240): string {
  if (value.length <= limit) return value;
  const side = Math.floor((limit - 1) / 2);
  let headEnd = side;
  let tailStart = value.length - side;
  const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
  const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  if (isHigh(value.charCodeAt(headEnd - 1)) && isLow(value.charCodeAt(headEnd))) headEnd--;
  if (isLow(value.charCodeAt(tailStart)) && isHigh(value.charCodeAt(tailStart - 1))) tailStart++;
  return `${value.slice(0, headEnd)}…${value.slice(tailStart)}`;
}

/** Mirror the host budget before retaining/rendering metadata from an older bridge. */
export function boundedWorkspaceChanges(entries: readonly NativeWorkspaceChange[]): {
  entries: NativeWorkspaceChange[];
  truncated: boolean;
} {
  const bounded: NativeWorkspaceChange[] = [];
  const encoder = new TextEncoder();
  let remaining = WORKSPACE_METADATA_BYTE_LIMIT;
  for (const entry of entries) {
    if (bounded.length === WORKSPACE_CHANGE_LIMIT) break;
    // Include fixed object/flag overhead; never encode an already oversized string.
    let bytes = 64;
    for (const value of [
      entry.changeId,
      entry.path,
      entry.oldPath ?? '',
      entry.indexStatus,
      entry.worktreeStatus,
    ]) {
      if (value.length > remaining - bytes) {
        bytes = remaining + 1;
        break;
      }
      bytes += encoder.encode(value).byteLength;
      if (bytes > remaining) break;
    }
    if (bytes > remaining) break;
    remaining -= bytes;
    bounded.push(entry);
  }
  return { entries: bounded, truncated: bounded.length < entries.length };
}

export function workspaceChangeStatus(entry: NativeWorkspaceChange): string {
  if (entry.untracked) return entry.indexStatus === 'D' ? '已暂存 D / 当前文件未跟踪' : '未跟踪';
  if (
    entry.indexStatus === 'U' ||
    entry.worktreeStatus === 'U' ||
    ['AA', 'DD'].includes(entry.indexStatus + entry.worktreeStatus)
  )
    return `冲突 ${entry.indexStatus}${entry.worktreeStatus}`;
  return [
    entry.indexStatus !== ' ' && `已暂存 ${entry.indexStatus}`,
    entry.worktreeStatus !== ' ' && `未暂存 ${entry.worktreeStatus}`,
  ]
    .filter(Boolean)
    .join(' / ');
}

export type WorkspaceChangeTreeNode = {
  id: string;
  parentId?: string;
  label: string;
  title: string;
} & (
  | { kind: 'directory'; children: WorkspaceChangeTreeNode[] }
  | { kind: 'file'; entry: NativeWorkspaceChange }
);

export type WorkspaceChangeTreeRow = {
  node: WorkspaceChangeTreeNode;
  level: number;
  position: number;
  size: number;
};

export function filterWorkspaceChanges(
  entries: readonly NativeWorkspaceChange[],
  query: string,
): NativeWorkspaceChange[] {
  const needle = query.slice(0, WORKSPACE_FILTER_LIMIT).trim().toLocaleLowerCase();
  return entries.slice(0, WORKSPACE_CHANGE_LIMIT).filter((entry) => {
    if (!needle) return true;
    // The host caps all metadata at 512 KiB. Also bound work for legacy/untrusted input.
    return [entry.path, entry.oldPath ?? ''].some((path) =>
      workspacePathLabel(path, 8_192).toLocaleLowerCase().includes(needle),
    );
  });
}

const pathOrder = new Intl.Collator(undefined, { numeric: true });

export function workspaceChangeTree(entries: readonly NativeWorkspaceChange[]): {
  nodes: WorkspaceChangeTreeNode[];
  simplified: boolean;
} {
  const root: WorkspaceChangeTreeNode[] = [];
  const directories = new Map<string, WorkspaceChangeTreeNode & { kind: 'directory' }>();
  let simplified = false;
  for (const entry of entries.slice(0, WORKSPACE_CHANGE_LIMIT)) {
    const lastSlash = entry.path.lastIndexOf('/');
    const segments =
      lastSlash < 0
        ? []
        : entry.path.slice(0, lastSlash).split('/', WORKSPACE_TREE_DEPTH_LIMIT + 1);
    let children = root;
    let parentId: string | undefined;
    let path = '';
    // Deep/wide paths keep all files, but stop creating directories at either budget.
    for (const segment of segments.slice(0, WORKSPACE_TREE_DEPTH_LIMIT)) {
      const candidate = `${path}${segment}/`;
      let directory = directories.get(candidate);
      if (!directory) {
        if (directories.size >= WORKSPACE_TREE_DIRECTORY_LIMIT) break;
        directory = {
          id: `directory:${candidate}`,
          parentId,
          kind: 'directory',
          label: workspacePathLabel(segment),
          title: workspacePathLabel(candidate, 1_024),
          children: [],
        };
        directories.set(candidate, directory);
        children.push(directory);
      }
      path = candidate;
      children = directory.children;
      parentId = directory.id;
    }
    const shortened = path.length <= lastSlash;
    simplified ||= shortened;
    children.push({
      id: `file:${entry.path}`,
      parentId,
      kind: 'file',
      entry,
      label: workspacePathLabel(`${shortened ? '…/' : ''}${entry.path.slice(path.length)}`),
      title: workspacePathLabel(
        entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path,
        1_024,
      ),
    });
  }
  function sort(nodes: WorkspaceChangeTreeNode[]) {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return pathOrder.compare(left.label, right.label);
    });
    for (const node of nodes) if (node.kind === 'directory') sort(node.children);
  }
  sort(root);
  return { nodes: root, simplified };
}

export function visibleWorkspaceTreeRows(
  nodes: readonly WorkspaceChangeTreeNode[],
  collapsed: ReadonlySet<string>,
): WorkspaceChangeTreeRow[] {
  const rows: WorkspaceChangeTreeRow[] = [];
  function append(children: readonly WorkspaceChangeTreeNode[], level: number) {
    for (const [index, node] of children.entries()) {
      rows.push({ node, level, position: index + 1, size: children.length });
      if (node.kind === 'directory' && !collapsed.has(node.id)) append(node.children, level + 1);
    }
  }
  append(nodes, 1);
  return rows;
}
