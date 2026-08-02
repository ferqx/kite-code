import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_INPUT_BYTES = 1024 * 1024;

export interface TrackedSemanticInputSnapshotV1 {
  version: 1;
  trackedInputPath: string;
  trackedInputGitBlobId: string;
  trackedInputSha256: `sha256:${string}`;
  snapshotPath: string;
}

export function snapshotTrackedSemanticInputV1(input: {
  workspace: string;
  commit: string;
  requestedPath: string;
  snapshotPath: string;
}): TrackedSemanticInputSnapshotV1 {
  if (!/^[a-f0-9]{40}$/.test(input.commit)) throw new Error('GITHUB_SHA must be a full commit SHA');
  if (
    !input.requestedPath ||
    isAbsolute(input.requestedPath) ||
    input.requestedPath.includes('\\') ||
    input.requestedPath.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('semantic input must be a normalized repository-relative path');
  }
  const workspace = realpathSync.native(resolve(input.workspace));
  const worktreePath = resolve(workspace, input.requestedPath);
  if (!worktreePath.startsWith(`${workspace}${sep}`)) {
    throw new Error('semantic input path escapes the checkout');
  }
  const normalizedPath = relative(workspace, worktreePath).split(sep).join('/');
  if (normalizedPath !== input.requestedPath) {
    throw new Error('semantic input path is not canonical');
  }
  if (runGit(workspace, ['cat-file', '-t', input.commit]).toString('utf8').trim() !== 'commit') {
    throw new Error('GITHUB_SHA must resolve to a commit object');
  }
  const tree = runGit(workspace, [
    'ls-tree',
    '-z',
    '--full-tree',
    input.commit,
    '--',
    normalizedPath,
  ]);
  const entries = tree
    .subarray(0, tree.length - (tree.at(-1) === 0 ? 1 : 0))
    .toString('utf8')
    .split('\0');
  if (entries.length !== 1)
    throw new Error('semantic input must resolve to exactly one tracked blob');
  const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(entries[0] ?? '');
  if (!match || match[3] !== normalizedPath) {
    throw new Error('semantic input is not an exact tracked regular blob at GITHUB_SHA');
  }
  const blobId = match[2]!;
  const bytes = runGit(workspace, ['cat-file', 'blob', blobId]);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error('semantic input blob must be nonempty and at most 1 MiB');
  }
  JSON.parse(bytes.toString('utf8'));
  const snapshotPath = resolve(input.snapshotPath);
  writeFileSync(snapshotPath, bytes, { flag: 'wx', mode: 0o400 });
  return Object.freeze({
    version: 1,
    trackedInputPath: normalizedPath,
    trackedInputGitBlobId: blobId,
    trackedInputSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    snapshotPath,
  });
}

function runGit(workspace: string, argv: readonly string[]): Buffer {
  const result = spawnSync('git', argv, {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
    encoding: 'buffer',
    maxBuffer: MAX_INPUT_BYTES + 64 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${argv[0]} failed for semantic input`);
  }
  return result.stdout;
}

function requiredArgument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing required argument: ${name}`);
  return value;
}

if (import.meta.main) {
  const snapshot = snapshotTrackedSemanticInputV1({
    workspace: requiredArgument('--workspace'),
    commit: requiredArgument('--commit'),
    requestedPath: requiredArgument('--input'),
    snapshotPath: requiredArgument('--snapshot'),
  });
  const githubEnvironment = requiredArgument('--github-env');
  appendFileSync(
    githubEnvironment,
    [
      `SEMANTIC_SNAPSHOT_PATH=${snapshot.snapshotPath}`,
      `SEMANTIC_TRACKED_INPUT_PATH=${snapshot.trackedInputPath}`,
      `SEMANTIC_TRACKED_INPUT_GIT_BLOB_ID=${snapshot.trackedInputGitBlobId}`,
      `SEMANTIC_TRACKED_INPUT_SHA256=${snapshot.trackedInputSha256}`,
      '',
    ].join('\n'),
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}
