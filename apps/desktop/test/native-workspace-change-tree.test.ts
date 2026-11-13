import { expect, test } from '#kite-test';
import {
  boundedWorkspaceChanges,
  filterWorkspaceChanges,
  visibleWorkspaceTreeRows,
  WORKSPACE_CHANGE_LIMIT,
  WORKSPACE_METADATA_BYTE_LIMIT,
  WORKSPACE_TREE_DEPTH_LIMIT,
  WORKSPACE_TREE_DIRECTORY_LIMIT,
  workspaceChangeStatus,
  workspaceChangeTree,
  workspacePathLabel,
} from '../src/native-workspace-change-tree';
import type { NativeWorkspaceChange } from '../src/workspace-changes-bridge';

function change(path: string, index = 0): NativeWorkspaceChange {
  return {
    path,
    changeId: `opaque-${index}`,
    indexStatus: 'M',
    worktreeStatus: ' ',
    untracked: false,
  };
}

test('display truncation preserves surrogate pairs at both edges and never changes request metadata', () => {
  const path = `${'a'.repeat(118)}😀${'middle'.repeat(80)}😀${'z'.repeat(118)}`;
  const label = workspacePathLabel(path);
  expect(label.length).toBeLessThanOrEqual(240);
  expect(decodeURIComponent(encodeURIComponent(label))).toBe(label);
  expect(workspacePathLabel('src/😀.ts')).toBe('src/😀.ts');
  const entry = change(path);
  const file = workspaceChangeTree([entry]).nodes[0]!;
  expect(file.kind).toBe('file');
  if (file.kind !== 'file') throw Error('expected_file');
  expect(file.entry).toBe(entry);
  expect(file.entry.path).toBe(path);
  expect(file.label).toBe(label);
});

test('extreme directory depth builds a bounded model and keeps the real leaf', () => {
  const entry = change(`${'a/'.repeat(100_000)}last.ts`);
  const rows = visibleWorkspaceTreeRows(workspaceChangeTree([entry]).nodes, new Set());
  expect(rows).toHaveLength(WORKSPACE_TREE_DEPTH_LIMIT + 1);
  expect(rows.at(-1)!.node.label.startsWith('…/a/a/')).toBe(true);
  expect(rows.at(-1)!.node.label.endsWith('/last.ts')).toBe(true);
  expect(workspaceChangeTree([entry]).simplified).toBe(true);
  expect(rows.at(-1)!.level).toBe(WORKSPACE_TREE_DEPTH_LIMIT + 1);
  const collapsed = visibleWorkspaceTreeRows(
    workspaceChangeTree([entry]).nodes,
    new Set([rows[0]!.node.id]),
  );
  expect(collapsed).toHaveLength(1);
});

test('legacy metadata is bounded by item count and UTF-8 byte budget before retaining it', () => {
  const many = boundedWorkspaceChanges(
    Array.from({ length: WORKSPACE_CHANGE_LIMIT + 10 }, (_, index) =>
      change(`src/${index}.ts`, index),
    ),
  );
  expect(many.entries).toHaveLength(WORKSPACE_CHANGE_LIMIT);
  expect(many.truncated).toBe(true);
  const tooLong = boundedWorkspaceChanges([change('x'.repeat(WORKSPACE_METADATA_BYTE_LIMIT + 1))]);
  expect(tooLong.entries).toHaveLength(0);
  expect(tooLong.truncated).toBe(true);
  const unicode = boundedWorkspaceChanges(
    Array.from({ length: 5 }, (_, index) => change(`${'😀'.repeat(40_000)}-${index}`, index)),
  );
  expect(unicode.entries).toHaveLength(3);
  expect(unicode.truncated).toBe(true);
  expect(boundedWorkspaceChanges([change('short.ts')]).truncated).toBe(false);
});

test('filtering matches original and renamed paths without changing their identities', () => {
  const renamed = { ...change('src/current.ts'), oldPath: 'legacy/Before.ts' };
  expect(filterWorkspaceChanges([renamed], 'BEFORE.ts')[0]).toBe(renamed);
  expect(filterWorkspaceChanges([renamed], 'src/current')[0]).toBe(renamed);
  expect(filterWorkspaceChanges([renamed], 'not-present')).toHaveLength(0);
});

test('directory budget bounds the entire model without dropping files or their original identities', () => {
  const entries = Array.from({ length: WORKSPACE_CHANGE_LIMIT }, (_, index) =>
    change(`${index}/${'nested/'.repeat(WORKSPACE_TREE_DEPTH_LIMIT)}leaf.ts`, index),
  );
  const tree = workspaceChangeTree(entries);
  const rows = visibleWorkspaceTreeRows(tree.nodes, new Set());
  const directories = rows.filter(({ node }) => node.kind === 'directory');
  const files = rows.filter(({ node }) => node.kind === 'file');
  expect(tree.simplified).toBe(true);
  expect(directories).toHaveLength(WORKSPACE_TREE_DIRECTORY_LIMIT);
  expect(files).toHaveLength(WORKSPACE_CHANGE_LIMIT);
  expect(rows).toHaveLength(WORKSPACE_TREE_DIRECTORY_LIMIT + WORKSPACE_CHANGE_LIMIT);
  expect(Math.max(...rows.map((row) => row.level))).toBeLessThanOrEqual(
    WORKSPACE_TREE_DEPTH_LIMIT + 1,
  );
  const last = files.find(
    ({ node }) => node.kind === 'file' && node.entry.changeId === 'opaque-999',
  )!.node;
  if (last.kind !== 'file') throw Error('expected_file');
  expect(last.entry).toBe(entries[999]!);
  expect(last.label).toBe(`…/${entries[999]!.path}`);
  expect(last.title).toBe(entries[999]!.path);
  expect(
    new Set(files.map(({ node }) => (node.kind === 'file' ? node.entry.changeId : ''))).size,
  ).toBe(WORKSPACE_CHANGE_LIMIT);
});

test('staged removal plus untracked working copy retains both status facts', () => {
  expect(
    workspaceChangeStatus({
      ...change('file'),
      indexStatus: 'D',
      worktreeStatus: '?',
      untracked: true,
    }),
  ).toBe('已暂存 D / 当前文件未跟踪');
  expect(
    workspaceChangeStatus({
      ...change('file'),
      indexStatus: '?',
      worktreeStatus: '?',
      untracked: true,
    }),
  ).toBe('未跟踪');
});

test('inserting and removing earlier paths cannot reassign folder or file identity', () => {
  const before = workspaceChangeTree([change('b/file.ts', 1), change('c/file.ts', 2)]);
  const b = before.nodes.find((node) => node.title === 'b/')!;
  const after = workspaceChangeTree([
    change('a/file.ts', 3),
    change('b/file.ts', 4),
    change('c/file.ts', 5),
  ]);
  expect(after.nodes.find((node) => node.title === 'b/')!.id).toBe(b.id);
  const rows = visibleWorkspaceTreeRows(after.nodes, new Set([b.id]));
  expect(rows.some(({ node }) => node.kind === 'file' && node.entry.path === 'a/file.ts')).toBe(
    true,
  );
  expect(rows.some(({ node }) => node.kind === 'file' && node.entry.path === 'b/file.ts')).toBe(
    false,
  );
  const originalFile = visibleWorkspaceTreeRows(before.nodes, new Set()).find(
    ({ node }) => node.kind === 'file' && node.entry.path === 'c/file.ts',
  )!.node;
  const remainingFile = visibleWorkspaceTreeRows(
    workspaceChangeTree([change('c/file.ts', 8)]).nodes,
    new Set(),
  ).find(({ node }) => node.kind === 'file')!.node;
  expect(remainingFile.id).toBe(originalFile.id);
});
