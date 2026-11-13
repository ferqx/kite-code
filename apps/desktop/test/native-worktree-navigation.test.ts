import { expect, test } from '#kite-test';
import type { NativeDirectory, NativeSelection } from '../src/native-bridge';
import {
  isNativeWorktreeExitCommand,
  resolveNativeWorktreeExit,
} from '../src/native-worktree-navigation';

const selection = {
  storeId: 'store',
  session: { id: 'linked', workspaceId: 'linked-project', parentSessionId: null, deletedAt: null },
} as NativeSelection;
const directory = {
  storeId: 'store',
  workspaces: [
    { id: 'linked-project', name: 'Linked', rootUri: 'file:///linked' },
    { id: 'source-project', name: 'Source', rootUri: 'file:///source' },
  ],
  sessions: [
    {
      ...selection.session,
      worktreeSource: { sessionId: 'source', workspaceId: 'source-project' },
    },
    { id: 'source', workspaceId: 'source-project', parentSessionId: null, deletedAt: null },
  ],
} as NativeDirectory;

test('only standalone exit commands select local navigation; explanations, quoted text and deletion remain chat', () => {
  for (const text of [
    '退出工作树',
    '退出 Git 工作树',
    '  exit worktree\n',
    'LEAVE GIT WORKTREE',
    '返回来源会话',
  ])
    expect(isNativeWorktreeExitCommand(text)).toBe(true);
  for (const text of [
    '删除工作树',
    'git worktree remove /linked',
    '退出工作树是什么意思？',
    '退出工作树后删除缓存',
    '不要退出工作树',
    '> 退出工作树',
    '`退出工作树`',
    '```\n退出工作树\n```',
    '退出\n工作树',
    '说明 exit worktree',
  ])
    expect(isNativeWorktreeExitCommand(text)).toBe(false);
});

test('return target requires the same visible directory and exact source identity, without requiring a live folder or write permission', () => {
  expect(resolveNativeWorktreeExit(directory, selection)).toEqual({
    kind: 'source',
    sessionId: 'source',
    workspaceId: 'source-project',
  });
  expect(
    resolveNativeWorktreeExit(directory, {
      ...selection,
      workspaceUnavailable: true,
      permissionUnavailable: true,
    }),
  ).toEqual({ kind: 'source', sessionId: 'source', workspaceId: 'source-project' });
  for (const bad of [
    { ...directory, storeId: 'another-store' },
    { ...directory, unavailable: true },
    { ...directory, sessions: directory.sessions.slice(0, 1) },
    { ...directory, workspaces: directory.workspaces.slice(0, 1) },
    { ...directory, sessions: [...directory.sessions, directory.sessions[1]!] },
    {
      ...directory,
      sessions: [directory.sessions[0]!, { ...directory.sessions[1]!, parentSessionId: 'parent' }],
    },
    {
      ...directory,
      sessions: [directory.sessions[0]!, { ...directory.sessions[1]!, deletedAt: 1 }],
    },
    {
      ...directory,
      sessions: [directory.sessions[0]!, { ...directory.sessions[1]!, workspaceId: 'other' }],
    },
  ])
    expect(resolveNativeWorktreeExit(bad, selection)).toEqual({ kind: 'unavailable' });
  expect(resolveNativeWorktreeExit(directory, { ...selection, viewLoading: true })).toEqual({
    kind: 'unavailable',
  });
});

test('a creation history can explain unchanged cwd, but titles and paths cannot invent a return target', () => {
  const original = {
    ...directory,
    sessions: [{ ...selection.session, activity: { hasCreatedWorktree: true } }],
  } as NativeDirectory;
  expect(resolveNativeWorktreeExit(original, selection)).toEqual({ kind: 'already_source' });
  const unknown = { ...directory, sessions: [{ ...selection.session, title: 'source /source' }] };
  expect(resolveNativeWorktreeExit(unknown, selection)).toEqual({ kind: 'unavailable' });
  expect(directory.sessions[0]!.workspaceId).toBe('linked-project');
});
