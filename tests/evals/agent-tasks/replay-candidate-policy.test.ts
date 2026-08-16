import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import {
  AGENT_TASK_REPLAY_CANDIDATE_V1,
  APPROVED_AGENT_TASK_SUITE_V1,
} from '../../../scripts/evals/contracts/agent-task-approved-suite';
import { cleanupFixtureRun, createFixtureRun, type FixtureRunV1 } from './fixtures/fixture-runner';

const fixtureRuns: FixtureRunV1[] = [];

afterEach(() => {
  for (const run of fixtureRuns.splice(0)) {
    if (existsSync(run.root)) cleanupFixtureRun(run);
  }
});

describe('RP-00 replay candidate policy', () => {
  test('keeps the D-07 suite candidate-only without record or replay-gate authority', () => {
    expect(AGENT_TASK_REPLAY_CANDIDATE_V1).toEqual({
      version: 1,
      decision: 'ADR-0112',
      suiteId: APPROVED_AGENT_TASK_SUITE_V1.suiteId,
      suiteRevision: APPROVED_AGENT_TASK_SUITE_V1.revision,
      suiteDigest: APPROVED_AGENT_TASK_SUITE_V1.suiteDigest,
      status: 'candidate',
      replayGate: 'disabled',
      recordAuthorization: 'denied',
      cassette: 'absent',
      riskCoverage: 'not_demonstrated',
    });
    expect(Object.isFrozen(AGENT_TASK_REPLAY_CANDIDATE_V1)).toBeTrue();
  });

  test('admits only the bounded synthetic fixture content used by the candidate suite', () => {
    const fixtureParent = resolve(import.meta.dir, 'fixtures');
    const uniqueFixtures = new Map(
      APPROVED_AGENT_TASK_SUITE_V1.cases.map((task) => [task.fixtureId, task] as const),
    );

    expect(APPROVED_AGENT_TASK_SUITE_V1.cases).toHaveLength(12);
    expect(
      APPROVED_AGENT_TASK_SUITE_V1.cases.every(
        (task) =>
          task.repositoryType === 'synthetic_local' &&
          task.requiredChecks.every((check) => check.network === 'off'),
      ),
    ).toBeTrue();

    for (const [fixtureId, task] of uniqueFixtures) {
      const fixtureRoot = resolve(fixtureParent, fixtureId);
      const fixtureRelative = relative(fixtureParent, fixtureRoot);
      expect(fixtureRelative).toBe(fixtureId);
      expect(fixtureRelative.startsWith(`..${sep}`)).toBeFalse();

      const run = createFixtureRun(task, { fixtureRoot });
      fixtureRuns.push(run);
      expect(run.fixtureId).toBe(fixtureId);
      expect(run.fixtureDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});
