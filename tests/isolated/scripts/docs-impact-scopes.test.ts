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

describe('documentation impact command outcomes', () => {
  const script = join(import.meta.dir, '../../../scripts/check-docs-impact.ts');
  function run(...args: string[]) {
    return Bun.spawnSync(['bun', script, ...args], {
      cwd: repository,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }
  function setup(): void {
    repository = mkdtempSync(join(tmpdir(), 'kite-docs-command-'));
    mkdirSync(join(repository, 'src'), { recursive: true });
    mkdirSync(join(repository, 'docs', 'handbook', 'clients', 'tui', 'guides'), {
      recursive: true,
    });
    writeFileSync(join(repository, 'src/run.ts'), 'export const value = 1;\n');
    writeFileSync(join(repository, 'docs/handbook/clients/tui/guides/input.md'), '# 输入\n');
    writeFileSync(
      join(repository, 'docs/documentation-map.json'),
      JSON.stringify({
        version: 2,
        rules: [
          {
            id: 'input',
            sources: ['src/**'],
            authorities: ['docs/handbook/clients/tui/guides/input.md'],
          },
        ],
      }),
    );
    git('init', '-q');
    git('add', '.');
    commit('fixture');
  }
  it('keeps missing document changes advisory and respects the staged boundary', () => {
    setup();
    writeFileSync(join(repository, 'src/run.ts'), 'export const value = 2;\n');
    git('add', 'src/run.ts');
    writeFileSync(
      join(repository, 'docs/handbook/clients/tui/guides/input.md'),
      '# 输入\n已核对\n',
    );
    const staged = run('--scope=staged');
    expect(staged.exitCode).toBe(0);
    expect(staged.stdout.toString()).toContain(
      'review unchanged: docs/handbook/clients/tui/guides/input.md',
    );
    const all = run();
    expect(all.exitCode).toBe(0);
    expect(all.stdout.toString()).toContain('changed; review content:');
  });
  it('fails invalid and missing mapping targets, including historical authorities', () => {
    setup();
    unlinkSync(join(repository, 'docs/handbook/clients/tui/guides/input.md'));
    expect(run().exitCode).toBe(1);
    writeFileSync(join(repository, 'docs/documentation-map.json'), '{invalid');
    expect(run().exitCode).toBe(1);
    mkdirSync(join(repository, 'docs/adr'), { recursive: true });
    writeFileSync(join(repository, 'docs/adr/old.md'), '# Historical\n');
    writeFileSync(
      join(repository, 'docs/documentation-map.json'),
      JSON.stringify({
        version: 2,
        rules: [{ id: 'input', sources: ['src/**'], authorities: ['docs/adr/old.md'] }],
      }),
    );
    expect(run().exitCode).toBe(1);
    expect(run('--scope=range').exitCode).toBe(2);
  });
  it('rejects missing links in nested client guides', () => {
    setup();
    for (const directory of ['apps', 'packages', 'docs/active', 'docs/development', 'docs/plans']) {
      mkdirSync(join(repository, directory), { recursive: true });
    }
    for (const path of [
      'docs/handbook/README.md',
      'docs/development/README.md',
      'docs/plans/README.md',
    ]) {
      writeFileSync(join(repository, path), '# 导航\n');
    }
    const structureScript = join(import.meta.dir, '../../../scripts/check-docs.ts');
    const structure = () =>
      Bun.spawnSync(['bun', structureScript], { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
    expect(structure().exitCode).toBe(0);
    writeFileSync(
      join(repository, 'docs/handbook/clients/tui/guides/input.md'),
      '# 输入\n[缺失](missing.md)\n',
    );
    const failure = structure();
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr.toString()).toContain('links to missing local target: missing.md');
  });
  it('requires both product and technical design links to survive until cleanup', () => {
    setup();
    for (const directory of [
      'apps',
      'packages',
      'docs/active',
      'docs/development/flows',
      'docs/plans',
    ]) {
      mkdirSync(join(repository, directory), { recursive: true });
    }
    for (const path of [
      'docs/handbook/README.md',
      'docs/development/README.md',
      'docs/plans/README.md',
    ]) {
      writeFileSync(join(repository, path), '# 导航\n');
    }
    const product = 'docs/handbook/clients/tui/guides/input.md';
    const technical = 'docs/development/flows/input.md';
    const plan = 'docs/plans/feature.md';
    writeFileSync(join(repository, plan), '# 已确认设计\n产品与技术目标。\n');
    writeFileSync(
      join(repository, product),
      '# 当前输入\n> 已确认设计，尚未实现：[方案](../../../../plans/feature.md)\n',
    );
    writeFileSync(
      join(repository, technical),
      '# 当前实现\n> 已确认设计，尚未实现：[方案](../../plans/feature.md)\n',
    );
    const structureScript = join(import.meta.dir, '../../../scripts/check-docs.ts');
    const check = () =>
      Bun.spawnSync(['bun', structureScript], { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
    expect(check().exitCode).toBe(0);
    unlinkSync(join(repository, plan));
    expect(check().exitCode).toBe(1);
    writeFileSync(join(repository, product), '# 交付后的输入\n');
    expect(check().exitCode).toBe(1);
    writeFileSync(join(repository, technical), '# 交付后的实现\n');
    expect(check().exitCode).toBe(0);
  });
  it('checks new root and docs-root Markdown without opting historical ADRs into current validation', () => {
    setup();
    for (const directory of [
      'apps',
      'packages',
      'docs/active',
      'docs/development',
      'docs/plans',
      'docs/adr',
    ]) {
      mkdirSync(join(repository, directory), { recursive: true });
    }
    for (const path of [
      'docs/handbook/README.md',
      'docs/development/README.md',
      'docs/plans/README.md',
    ]) {
      writeFileSync(join(repository, path), '# 导航\n');
    }
    const structureScript = join(import.meta.dir, '../../../scripts/check-docs.ts');
    const check = () =>
      Bun.spawnSync(['bun', structureScript], { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
    writeFileSync(join(repository, 'docs/adr/history.md'), '# 当时记录\n[旧路径](removed.ts)\n');
    expect(check().exitCode).toBe(0);
    writeFileSync(join(repository, 'NEW-ENTRY.md'), '# 新入口\n[失效](missing.md)\n');
    const rootFailure = check();
    expect(rootFailure.exitCode).toBe(1);
    expect(rootFailure.stderr.toString()).toContain('NEW-ENTRY.md links to missing local target');
    writeFileSync(join(repository, 'NEW-ENTRY.md'), '# 新入口\n[手册](docs/handbook/README.md)\n');
    expect(check().exitCode).toBe(0);
    writeFileSync(join(repository, 'docs/NEW-ENTRY.md'), '# 新文档入口\n[失效](missing.md)\n');
    const docsFailure = check();
    expect(docsFailure.exitCode).toBe(1);
    expect(docsFailure.stderr.toString()).toContain(
      'docs/NEW-ENTRY.md links to missing local target',
    );
  });
  it('reports both sides of renames and deleted tracked files', () => {
    setup();
    git('mv', 'src/run.ts', 'src/renamed.ts');
    expect(changedFilesForScope({ scope: 'staged' }, repository).sort()).toEqual([
      'src/renamed.ts',
      'src/run.ts',
    ]);
    unlinkSync(join(repository, 'src/renamed.ts'));
    expect(changedFilesForScope({ scope: 'all' }, repository).sort()).toEqual([
      'src/renamed.ts',
      'src/run.ts',
    ]);
  });
});
