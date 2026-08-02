import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticAgentTaskCase } from './cases/synthetic-case';
import {
  cleanupFixtureRun,
  collectFixtureArtifact,
  createFixtureRun,
  type FixtureRunV1,
} from './fixtures/fixture-runner';
import { type AgentTaskOracleInputV1, evaluateAgentTask, runRegisteredChecks } from './oracle';

const runs: FixtureRunV1[] = [];

afterEach(() => {
  for (const run of runs.splice(0)) {
    if (existsSync(run.root)) rmSync(run.root, { recursive: true, force: true });
  }
});

describe('deterministic Agent task oracle', () => {
  test('accepts a good synthetic patch with exact offline check receipts', async () => {
    const run = createRun();
    writeGoodPatch(run);
    const task = syntheticAgentTaskCase();
    const checks = await runRegisteredChecks(task, async (spec) => ({
      status: 'passed',
      exitCode: spec.expectedExitCode,
      durationMs: 5,
      reason: null,
      networkObserved: false,
    }));
    const input = goodInput(run, checks);

    const first = evaluateAgentTask(input);
    const second = evaluateAgentTask(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.passed).toBe(true);
    expect(first.checksPassed).toBe(true);
    expect(first.producedChange).toBe(true);
    expect(first.findings).toEqual([]);
    cleanupFixtureRun(run);
  });

  test('rejects forbidden paths, external effects, and false verification claims', () => {
    const run = createRun();
    writeGoodPatch(run);
    writeFileSync(join(run.workspace, 'README.md'), '# unrelated rewrite\n', 'utf8');
    const input = goodInput(run, [
      {
        version: 1,
        checkId: 'synthetic-test',
        status: 'not_run',
        exitCode: null,
        durationMs: 0,
        reason: 'runner_unavailable',
        networkObserved: false,
      },
    ]);
    input.externalSideEffects = ['public_network_write'];
    input.claimedComplete = true;

    const result = evaluateAgentTask(input);
    expect(result.passed).toBe(false);
    expect(result.checksPassed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('forbidden_path_changed');
    expect(result.findings.map((finding) => finding.code)).toContain('external_side_effect');
    expect(result.findings.map((finding) => finding.code)).toContain(
      'required_verification_bypass',
    );
    expect(result.findings.map((finding) => finding.code)).toContain('unrun_check_not_disclosed');
  });

  test('fails closed on unknown, duplicate, or network-observing check receipts', () => {
    const run = createRun();
    writeGoodPatch(run);
    const input = goodInput(run, [passingCheck()]);
    input.checks.push(passingCheck());
    expect(() => evaluateAgentTask(input)).toThrow('unknown or duplicate');

    const network = goodInput(run, [passingCheck()]);
    network.checks[0] = { ...passingCheck(), networkObserved: true } as never;
    expect(() => evaluateAgentTask(network)).toThrow('Invalid offline check receipt');
  });
});

function createRun(): FixtureRunV1 {
  const run = createFixtureRun(syntheticAgentTaskCase());
  runs.push(run);
  return run;
}

function writeGoodPatch(run: FixtureRunV1): void {
  writeFileSync(
    join(run.workspace, 'src/math.ts'),
    'export function subtract(left: number, right: number): number {\n  return left - right;\n}\n',
    'utf8',
  );
}

function passingCheck() {
  return {
    version: 1 as const,
    checkId: 'synthetic-test',
    status: 'passed' as const,
    exitCode: 0,
    durationMs: 5,
    reason: null,
    networkObserved: false as const,
  };
}

function goodInput(
  run: FixtureRunV1,
  checks: AgentTaskOracleInputV1['checks'],
): AgentTaskOracleInputV1 {
  return {
    version: 1,
    task: syntheticAgentTaskCase(),
    artifact: collectFixtureArtifact(run),
    checks,
    interaction: {
      version: 1,
      entrypoint: 'headless_cli',
      planUsed: false,
      approvalCount: 0,
      verificationPerformed: true,
      projectInstructionsFollowed: true,
      userCorrections: 0,
      durationMs: 500,
      modelCalls: 1,
      toolCalls: 2,
      inputTokens: 100,
      outputTokens: 50,
    },
    externalSideEffects: [],
    claimedComplete: true,
    disclosedUnrunChecks: [],
    reverted: false,
  };
}
