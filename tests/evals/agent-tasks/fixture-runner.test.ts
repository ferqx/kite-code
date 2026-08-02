import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syntheticAgentTaskCase } from './cases/synthetic-case';
import {
  cleanupFixtureRun,
  collectFixtureArtifact,
  createFixtureRun,
  FixtureRunnerError,
  registerFixtureProcess,
} from './fixtures/fixture-runner';

const cleanupTargets: string[] = [];

afterEach(() => {
  for (const target of cleanupTargets.splice(0)) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
});

describe('isolated Agent task fixture runner', () => {
  test('creates repeatable fixed Git baselines in distinct temporary workspaces', () => {
    const first = trackedRun();
    const second = trackedRun();

    expect(first.workspace).not.toBe(second.workspace);
    expect(first.baselineCommit).toBe(second.baselineCommit);
    expect(first.fixtureDigest).toBe(second.fixtureDigest);
    expect(first.initialDirtyFiles).toEqual([]);
    expect(readFileSync(join(first.workspace, 'src/math.ts'), 'utf8')).toContain('left + right');

    cleanupFixtureRun(first);
    cleanupFixtureRun(second);
    expect(existsSync(first.root)).toBe(false);
    expect(existsSync(second.root)).toBe(false);
  });

  test('collects the full workspace delta and preserves diagnostics before safe cleanup', () => {
    const run = trackedRun();
    writeFileSync(
      join(run.workspace, 'src/math.ts'),
      'export function subtract(left: number, right: number): number {\n  return left - right;\n}\n',
      'utf8',
    );

    const artifact = collectFixtureArtifact(run);
    expect(artifact.changedFiles).toEqual(['src/math.ts']);
    expect(artifact.patch).toContain('return left - right;');
    expect(artifact.residualProcessIds).toEqual([]);
    expect(artifact.residualWorktrees).toEqual([]);

    const retained = cleanupFixtureRun(run);
    expect(retained.patchSha256).toBe(artifact.patchSha256);
    expect(existsSync(run.root)).toBe(false);
  });

  test('refuses cleanup on lease mismatch or unowned process termination', () => {
    const run = trackedRun();
    const originalNonce = run.ownershipNonce;
    run.ownershipNonce = 'mismatch';
    expectCode(() => cleanupFixtureRun(run), 'cleanup_identity_mismatch');
    expect(existsSync(run.root)).toBe(true);
    run.ownershipNonce = originalNonce;

    const lease = registerFixtureProcess(run, 4242);
    expectCode(() => cleanupFixtureRun(run), 'residual_process');
    expect(existsSync(run.root)).toBe(true);
    const diagnostic = cleanupFixtureRun(run, {
      terminateOwnedProcess: (candidate) => candidate.processToken === lease.processToken,
    });
    expect(diagnostic.residualProcessIds).toEqual([4242]);
    expect(existsSync(run.root)).toBe(false);
  });

  test('rejects credential-like or symlink-bearing fixture sources before Git initialization', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'kite-agent-eval-invalid-source-'));
    cleanupTargets.push(fixtureRoot);
    writeFileSync(join(fixtureRoot, '.env'), 'TOKEN=not-a-real-token\n', 'utf8');

    expectCode(
      () => createFixtureRun(syntheticAgentTaskCase(), { fixtureRoot }),
      'fixture_invalid',
    );
  });
});

function trackedRun() {
  const run = createFixtureRun(syntheticAgentTaskCase());
  cleanupTargets.push(run.root);
  return run;
}

function expectCode(run: () => unknown, code: FixtureRunnerError['code']): void {
  try {
    run();
    throw new Error('Expected fixture operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(FixtureRunnerError);
    expect((error as FixtureRunnerError).code).toBe(code);
  }
}
