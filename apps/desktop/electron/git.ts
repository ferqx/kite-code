import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NativeProcessOwner } from './native-processes';
export interface BranchSnapshot {
  workspace: string;
  repository: boolean;
  root: string | null;
  current: string | null;
  head: string | null;
  branches: readonly string[];
  dirty: boolean;
  canSwitch: boolean;
}

const GIT_OUTPUT_LIMIT = 1_048_576;
const GIT_TIMEOUT_MS = 15_000;

async function runGit(
  path: string,
  args: readonly string[],
  processes: NativeProcessOwner,
): Promise<[boolean, string]> {
  const running = processes.start(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd: path,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
    {
      timeoutMs: GIT_TIMEOUT_MS,
      timeoutError: 'Git 操作超时，请刷新分支确认实际状态。',
      launchError: '无法启动 Git，请检查是否已安装。',
    },
  );
  const { child } = running;
  const output: Buffer[] = [];
  let outputBytes = 0;
  let errorBytes = 0;
  child.stdout!.on('data', (value: Buffer) => {
    outputBytes += value.length;
    if (outputBytes <= GIT_OUTPUT_LIMIT) output.push(value);
    else {
      running.stop(new Error('Git 输出过大，无法确认项目状态。'));
    }
  });
  child.stderr!.on('data', (value: Buffer) => {
    errorBytes += value.length;
    if (errorBytes > GIT_OUTPUT_LIMIT) {
      running.stop(new Error('Git 输出过大，无法确认项目状态。'));
    }
  });
  const code = await running.result;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output));
  } catch {
    throw new Error('Git 输出编码不可用。');
  }
  return [code === 0, text];
}

export async function queryBranch(
  path: string,
  processes: NativeProcessOwner,
): Promise<BranchSnapshot> {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    throw new Error('项目目录不可用。');
  }
  if (canonical !== path) throw new Error('项目路径已改变，请重新添加项目。');
  const markerRoot = findGitMarker(path);
  if (!markerRoot) return ordinaryDirectory(path);

  let repository: boolean;
  let rootOutput: string;
  try {
    [repository, rootOutput] = await runGit(path, ['rev-parse', '--show-toplevel'], processes);
  } catch {
    return ordinaryDirectory(path);
  }
  if (!repository) return ordinaryDirectory(path);
  const root = rootOutput.trimEnd();
  const [hasBranch, branch] = await runGit(
    path,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    processes,
  );
  const [hasHead, head] = await runGit(path, ['rev-parse', '--verify', 'HEAD'], processes);
  const [refsOk, refs] = await runGit(
    path,
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    processes,
  );
  const [statusOk, status] = await runGit(
    path,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    processes,
  );
  if (!refsOk || !statusOk) throw new Error('无法确认 Git 分支或工作区改动。');
  let canonicalRoot: string | undefined;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {
    canonicalRoot = undefined;
  }
  return {
    workspace: path,
    repository: true,
    root,
    current: hasBranch ? branch.trimEnd() : null,
    head: hasHead ? head.trimEnd() : null,
    branches: refs.split('\n').filter(Boolean),
    dirty: status.length > 0,
    canSwitch: canonicalRoot === path,
  };
}

export async function switchBranch(
  path: string,
  branch: string,
  expected: BranchSnapshot,
  processes: NativeProcessOwner,
): Promise<BranchSnapshot> {
  const current = await queryBranch(path, processes);
  if (
    current.workspace !== expected.workspace ||
    current.root !== expected.root ||
    current.current !== expected.current ||
    current.head !== expected.head
  )
    throw new Error('项目或分支已改变，请刷新后重新选择。');
  if (current.current === branch) return current;
  if (!current.canSwitch) throw new Error('请打开 Git 仓库根目录后切换分支。');
  if (current.dirty) throw new Error('工作区有未提交或未跟踪的改动，请先处理后再切换分支。');
  if (!current.branches.includes(branch)) throw new Error('所选本地分支已不存在，请刷新后重试。');
  const [ok] = await runGit(path, ['switch', '--no-guess', '--', branch], processes);
  if (!ok) throw new Error('Git 未能切换分支，可能被其他工作目录占用；请刷新确认实际状态。');
  const actual = await queryBranch(path, processes);
  if (actual.current !== branch) throw new Error('无法确认分支切换结果，请刷新检查。');
  return actual;
}

function ordinaryDirectory(workspace: string): BranchSnapshot {
  return {
    workspace,
    repository: false,
    root: null,
    current: null,
    head: null,
    branches: [],
    dirty: false,
    canSwitch: false,
  };
}

function findGitMarker(path: string): string | undefined {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
  }
}
