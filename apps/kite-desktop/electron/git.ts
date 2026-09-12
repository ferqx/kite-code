import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BranchSnapshot } from '../src/bridge';

const GIT_OUTPUT_LIMIT = 1_048_576;
const GIT_TIMEOUT_MS = 15_000;

async function runGit(path: string, args: readonly string[]): Promise<[boolean, string]> {
  const child = spawn(
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
  );
  const output: Buffer[] = [];
  let outputBytes = 0;
  let errorBytes = 0;
  let oversized = false;
  child.stdout.on('data', (value: Buffer) => {
    outputBytes += value.length;
    if (outputBytes <= GIT_OUTPUT_LIMIT) output.push(value);
    else {
      oversized = true;
      child.kill('SIGKILL');
    }
  });
  child.stderr.on('data', (value: Buffer) => {
    errorBytes += value.length;
    if (errorBytes > GIT_OUTPUT_LIMIT) {
      oversized = true;
      child.kill('SIGKILL');
    }
  });
  const result = await new Promise<{ code: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Git 操作超时，请刷新分支确认实际状态。'));
    }, GIT_TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('无法启动 Git，请检查是否已安装。'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
  if (oversized) throw new Error('Git 输出过大，无法确认项目状态。');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output));
  } catch {
    throw new Error('Git 输出编码不可用。');
  }
  return [result.code === 0, text];
}

export async function queryBranch(path: string): Promise<BranchSnapshot> {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    throw new Error('项目目录不可用。');
  }
  if (canonical !== path) throw new Error('项目路径已改变，请重新添加项目。');
  if (!hasGitMarker(path)) return ordinaryDirectory(path);

  const [repository, rootOutput] = await runGit(path, ['rev-parse', '--show-toplevel']);
  if (!repository) {
    if (hasGitMarker(path)) throw new Error('Git 仓库状态无法读取，请检查仓库后重试。');
    return ordinaryDirectory(path);
  }
  const root = rootOutput.trimEnd();
  const [hasBranch, branch] = await runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const [hasHead, head] = await runGit(path, ['rev-parse', '--verify', 'HEAD']);
  const [refsOk, refs] = await runGit(path, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  const [statusOk, status] = await runGit(path, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
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
): Promise<BranchSnapshot> {
  const current = await queryBranch(path);
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
  const [ok] = await runGit(path, ['switch', '--no-guess', '--', branch]);
  if (!ok) throw new Error('Git 未能切换分支，可能被其他工作目录占用；请刷新确认实际状态。');
  const actual = await queryBranch(path);
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

function hasGitMarker(path: string): boolean {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
  }
}
