import { spawnSync } from 'node:child_process';

const protectedBranch = 'man';

const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();

if (branch !== protectedBranch) {
  process.exit(0);
}

const isMerge = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).status === 0;
const isCherryPick =
  spawnSync('git', ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']).status === 0;

if (isMerge || isCherryPick) {
  process.exit(0);
}

console.error(
  `拒绝提交：${protectedBranch} 是受保护分支。请在独立分支提交后，通过 Pull Request 合并。`,
);
process.exit(1);
