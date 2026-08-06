import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';

const workflowPath = L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1;
const workflow = readFileSync(resolve(workflowPath), 'utf8');

function actionBlock(action: string): string {
  const start = workflow.indexOf(`- uses: ${action}@`);
  if (start < 0) throw new Error(`workflow action is missing: ${action}`);
  const nextStep = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, nextStep < 0 ? workflow.length : nextStep);
}

function githubExpression(value: string): string {
  return `\${{ ${value} }}`;
}

describe('L2 native conformance qualification workflow security contract', () => {
  test('uses only a protected-main push and input-free manual dispatch', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(/^ {2}pull_request:/m);
    expect(workflow).not.toMatch(/^ {2}pull_request_target:/m);
    expect(workflow).not.toMatch(/^ {4}inputs:/m);
    expect(workflow).toContain(
      "if: github.repository == 'ferqx/kite-code' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain(`  ${L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1}:`);
  });

  test('has least GitHub permissions, no secrets, and no caller-selected checkout SHA', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(
      /^ {2}(?:actions|attestations|checks|deployments|id-token|issues|packages|pull-requests|statuses):/m,
    );
    expect(workflow).not.toMatch(/\bsecrets\./iu);
    expect(workflow).toContain(`QUALIFICATION_HEAD_SHA: ${githubExpression('github.sha')}`);
    expect(workflow).not.toMatch(/^\s+(?:ref|repository):/mu);
    expect(actionBlock('actions/checkout')).toContain('persist-credentials: false');
  });

  test('pins every third-party action to an immutable commit SHA', () => {
    const actionUses = [...workflow.matchAll(/^\s*- uses:\s+([^\s]+)\s*$/gmu)].map(
      (match) => match[1],
    );
    expect(actionUses).toEqual([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ]);
    for (const action of actionUses) expect(action).toMatch(/^[^@\s]+@[a-f0-9]{40}$/);
  });

  test('maps exactly the source-owned distribution targets to native runners', () => {
    const matrixRows = [
      ...workflow.matchAll(
        /^ {10}- distribution_target: ([^\n]+)\n {12}target: ([^\n]+)\n {12}runner: ([^\n]+)\n {12}runner_class: ([^\n]+)$/gmu,
      ),
    ].map((match) => ({
      distributionTarget: match[1],
      target: match[2],
      runner: match[3],
      runnerClass: match[4],
    }));
    const expectedRows = L2_NATIVE_CONFORMANCE_TARGETS_V1.map((target) => ({
      distributionTarget: target.distributionTargetId,
      target: target.candidateTargetId,
      runner: target.nativeRunner,
      runnerClass: target.runnerClass,
    }));

    expect(matrixRows).toEqual(expectedRows);
    expect(workflow).toContain(`runs-on: ${githubExpression('matrix.runner')}`);
    expect(workflow).toContain(
      `QUALIFICATION_RUNNER_CLASS: ${githubExpression('matrix.runner_class')}`,
    );
    expect(workflow).toContain('max-parallel: 1');
    expect(workflow).toContain('timeout-minutes: 10');
  });

  test('runs governance preflight before any candidate or native probe dispatch', () => {
    const worker = workflow.indexOf(
      'bun run scripts/evals/qualification/run-l2-native-conformance.ts',
    );

    expect(worker).toBeGreaterThan(-1);
    expect(workflow).toContain(`QUALIFICATION_WORKFLOW: ${workflowPath}`);
    expect(workflow).toContain('tests/release/standalone-keyring-unavailable.test.ts');
    expect(workflow).toContain('tests/evals/qualification/l2-native-runner.test.ts');
    expect(workflow).toContain('--worker-output l2-native-worker.json');
    expect(workflow).toContain(
      `--distribution-target ${githubExpression('matrix.distribution_target')}`,
    );
    expect(workflow).toContain('--governance-preflight-only');
    expect(workflow).toContain('bun install --frozen-lockfile --ignore-scripts');

    for (const forbiddenDispatch of [
      'bun run release:build',
      'bun run release:verify',
      'bun run release:smoke',
      'platform-capability-probe.ts',
      'verify-platform-capability-evidence.ts',
      '--candidate ',
      '--probe ',
    ]) {
      expect(workflow).not.toContain(forbiddenDispatch);
    }
  });

  test('retains only the metadata-only blocked worker record, never probe files or raw logs', () => {
    const upload = actionBlock('actions/upload-artifact');
    expect(upload).toContain('path: l2-native-worker.json');
    expect(upload).toContain('retention-days: 14');
    expect(upload).not.toContain('platform-capability-evidence.json');
    expect(upload).not.toContain('platform-capability-verification.json');
    expect(upload).not.toMatch(/(?:\.log|test-results|junit|stdout|stderr)/iu);
  });
});
