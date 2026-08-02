import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotTrackedSemanticInputV1 } from '../../../scripts/evals/snapshot-tracked-semantic-input';

function git(cwd: string, ...argv: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', ...argv],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Kite Test',
      GIT_AUTHOR_EMAIL: 'kite-test@example.invalid',
      GIT_COMMITTER_NAME: 'Kite Test',
      GIT_COMMITTER_EMAIL: 'kite-test@example.invalid',
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe('tracked semantic input snapshot', () => {
  test('reads the exact GITHUB_SHA blob and rejects untracked input', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-semantic-git-'));
    try {
      git(root, 'init', '--quiet');
      writeFileSync(join(root, 'tracked.json'), '{"source":"committed"}\n');
      git(root, 'add', 'tracked.json');
      git(root, 'commit', '--quiet', '-m', 'fixture');
      const commit = git(root, 'rev-parse', 'HEAD');
      writeFileSync(join(root, 'tracked.json'), '{"source":"worktree-splice"}\n');
      writeFileSync(join(root, 'untracked.json'), '{"source":"untracked"}\n');

      const snapshot = snapshotTrackedSemanticInputV1({
        workspace: root,
        commit,
        requestedPath: 'tracked.json',
        snapshotPath: join(root, 'snapshot.json'),
      });
      expect(readFileSync(snapshot.snapshotPath, 'utf8')).toBe('{"source":"committed"}\n');
      expect(snapshot.trackedInputGitBlobId).toMatch(/^[a-f0-9]{40,64}$/);
      expect(snapshot.trackedInputSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(() =>
        snapshotTrackedSemanticInputV1({
          workspace: root,
          commit,
          requestedPath: 'untracked.json',
          snapshotPath: join(root, 'untracked-snapshot.json'),
        }),
      ).toThrow('not an exact tracked regular blob');
      const tree = git(root, 'rev-parse', 'HEAD^{tree}');
      expect(() =>
        snapshotTrackedSemanticInputV1({
          workspace: root,
          commit: tree,
          requestedPath: 'tracked.json',
          snapshotPath: join(root, 'tree-snapshot.json'),
        }),
      ).toThrow('commit object');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
