import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFilesForScope } from '../../../scripts/check-docs-impact';

let repository = '';

function git(...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function commit(message: string): void {
  git(
    '-c',
    'user.name=Kite Test',
    '-c',
    'user.email=kite@example.invalid',
    'commit',
    '-qm',
    message,
  );
}

afterEach(() => {
  if (repository) rmSync(repository, { recursive: true, force: true });
  repository = '';
});

describe('documentation impact Git scopes', () => {
  it('discovers all, staged, and CI base-to-HEAD changes', () => {
    repository = mkdtempSync(join(tmpdir(), 'kite-docs-impact-'));
    mkdirSync(join(repository, 'src'), { recursive: true });
    mkdirSync(join(repository, 'docs', 'active'), { recursive: true });
    writeFileSync(join(repository, 'src', 'runtime.ts'), 'export const version = 1;\n');
    writeFileSync(join(repository, 'docs', 'active', 'runtime.md'), '# Runtime v1\n');
    git('init', '-q');
    git('add', '.');
    commit('base');
    const base = git('rev-parse', 'HEAD');

    writeFileSync(join(repository, 'src', 'runtime.ts'), 'export const version = 2;\n');
    writeFileSync(join(repository, 'untracked.txt'), 'new\n');
    expect(changedFilesForScope({ scope: 'all' }, repository).sort()).toEqual([
      'src/runtime.ts',
      'untracked.txt',
    ]);

    git('add', 'src/runtime.ts');
    expect(changedFilesForScope({ scope: 'staged' }, repository)).toEqual(['src/runtime.ts']);
    unlinkSync(join(repository, 'untracked.txt'));
    writeFileSync(join(repository, 'docs', 'active', 'runtime.md'), '# Runtime v2\n');
    git('add', 'docs/active/runtime.md');
    commit('current authority');

    expect(changedFilesForScope({ scope: 'range', base }, repository).sort()).toEqual([
      'docs/active/runtime.md',
      'src/runtime.ts',
    ]);
  });
});
