import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';

const repository = resolve(import.meta.dir, '../../..');
async function child(argv: string[], cwd: string, home: string) {
  const child = Bun.spawn(argv, {
    cwd,
    env: { HOME: home, PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw Error(`upgrade_child_failed:${code}\n${err}\n${out}`);
    return out;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
type Event = { kind: string; version: string; scope: string };
type Evidence = {
  pid: number;
  instanceId: string;
  storeId: string;
  calls: number;
  firstRun: string;
  secondRun: string;
  futureRun: string;
  activeOld: Event[];
  replacement: Event[];
  lifecycle: Event[];
  records: unknown[];
  futureBefore: unknown;
  futureAfter: unknown;
  effects: string;
  executions: { id: string; kind: string; definitionVersion: string; status: string }[];
};
test('E13 two standalone artifacts replace at a new Run while original active Job drains in the same public Host', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-extension-upgrade-')));
  try {
    const candidate = await buildTerminalBundle({
      destination: join(root, 'candidate'),
      repositoryRoot: repository,
    });
    const app = join(root, 'app');
    mkdirSync(app, { mode: 0o700 });
    mkdirSync(join(app, 'home'), { mode: 0o700 });
    symlinkSync(join(candidate.root, 'node_modules'), join(app, 'node_modules'));
    const runChild = (argv: string[], cwd: string) => child(argv, cwd, join(app, 'home'));
    const artifacts: string[] = [];
    for (const version of ['1', '2']) {
      const fixture = join(repository, 'tests/fixtures/extensions/upgrade', `v${version}`);
      const target = join(app, `v${version}`);
      mkdirSync(target, { mode: 0o700 });
      const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')) as {
        scripts: { build: string };
      };
      const args = manifest.scripts.build
        .split(' ')
        .slice(1)
        .map((value) => (value === '--outdir=dist' ? `--outdir=${join(target, 'dist')}` : value));
      await runChild([process.execPath, ...args], fixture);
      copyFileSync(join(fixture, 'asset.txt'), join(target, 'asset.txt'));
      artifacts.push(join(target, 'dist/index.js'));
    }
    const hashes = artifacts.map((path) =>
      createHash('sha256').update(readFileSync(path)).digest('hex'),
    );
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(readFileSync(join(app, 'v1/asset.txt'), 'utf8')).not.toBe(
      readFileSync(join(app, 'v2/asset.txt'), 'utf8'),
    );
    await runChild(
      [
        process.execPath,
        'build',
        join(repository, 'tests/fixtures/extensions/upgrade/host.ts'),
        '--target=bun',
        '--packages=external',
        `--outfile=${join(app, 'host.js')}`,
      ],
      repository,
    );
    expect(existsSync(join(app, 'src'))).toBe(false);
    expect(existsSync(join(candidate.root, 'node_modules/@kite-ai/agent/src'))).toBe(false);
    const owned = join(app, 'owned');
    const evidence = JSON.parse(
      await runChild(
        [join(candidate.root, 'runtime/bun'), join(app, 'host.js'), owned, 'warm', ...artifacts],
        app,
      ),
    ) as Evidence;
    expect(evidence.pid).toBeGreaterThan(0);
    expect(evidence.instanceId).toBeString();
    expect(evidence.firstRun).not.toBe(evidence.secondRun);
    expect(evidence.calls).toBe(8);
    expect(evidence.activeOld.some((e) => e.kind === 'job-start' && e.scope === 'old-work')).toBe(
      true,
    );
    expect(
      evidence.activeOld.some((e) => e.kind === 'scope-dispose' && e.scope === 'old-work'),
    ).toBe(false);
    expect(
      evidence.replacement.some(
        (e) => e.kind === 'job-terminal' && e.scope === 'new-work' && e.version === '2',
      ),
    ).toBe(true);
    expect(
      evidence.replacement.some((e) => e.kind === 'scope-dispose' && e.scope === 'old-work'),
    ).toBe(false);
    expect(
      evidence.replacement.some((e) => e.kind === 'job-terminal' && e.scope === 'old-work'),
    ).toBe(false);
    const effect = evidence.effects
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(effect.map((e) => e.amount)).toEqual([10, 1]);
    expect(effect.map((e) => e.marker)).toEqual(['replacement V2 asset\n', 'original V1 asset\n']);
    for (const scope of ['old-work', 'new-work']) {
      expect(
        evidence.lifecycle.filter((e) => e.scope === scope && e.kind === 'scope-dispose'),
      ).toHaveLength(1);
      expect(
        evidence.lifecycle.filter((e) => e.scope === scope && e.kind === 'job-dispose'),
      ).toHaveLength(1);
      expect(
        evidence.lifecycle.findIndex((e) => e.scope === scope && e.kind === 'scope-dispose'),
      ).toBeGreaterThan(
        evidence.lifecycle.findIndex((e) => e.scope === scope && e.kind === 'job-terminal'),
      );
    }
    const jobs = evidence.executions.filter((e) => e.kind === 'job');
    expect(jobs).toHaveLength(2);
    expect(jobs.map((e) => e.definitionVersion).sort()).toEqual(['1', '2']);
    expect(jobs.every((e) => e.status === 'succeeded')).toBe(true);
    expect(evidence.futureAfter).toEqual(evidence.futureBefore);
    const cold = JSON.parse(
      await runChild(
        [join(candidate.root, 'runtime/bun'), join(app, 'host.js'), owned, 'cold', ...artifacts],
        app,
      ),
    );
    expect(cold.storeId).toBe(evidence.storeId);
    expect(cold.calls).toBe(0);
    expect(cold.records).toEqual(evidence.records);
    expect(cold.before).toBe(cold.after);
    expect(cold.effects).toBe(evidence.effects);
    expect(cold.executions.map((e: { id: string }) => e.id)).toEqual(
      evidence.executions.map((e) => e.id),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
