import { describe, expect, test } from 'bun:test';
import {
  isLiveTaskJourneyPassedV1,
  type LiveTaskJourneyReportV1,
  runLiveTaskJourneyEval,
} from '../../scripts/evals/live-task-journey';

describe('live task journey evaluator', () => {
  const journey = (): NonNullable<LiveTaskJourneyReportV1['journey']> => ({
    modelResponses: 2,
    taskCalls: 1,
    taskSucceeded: 1,
    taskFailedOrRejected: 0,
    invalidTaskCalls: 0,
    modelCorrectionCalls: 0,
    taskRoleCounts: { explore: 0, plan: 1, code: 0, review: 0, unknown: 0 },
    subagentStarted: 1,
    subagentCompleted: 1,
    subagentFailed: 0,
    taskCallOutcomes: [],
    modelRespondedAfterFirstTaskOutcome: true,
    recoveredAfterTaskFailure: false,
    completed: true,
    blocked: false,
  });

  test('natural scorer requires exactly one successful plan child', () => {
    expect(isLiveTaskJourneyPassedV1({ scenario: 'natural', journey: journey() })).toBe(true);
    expect(
      isLiveTaskJourneyPassedV1({
        scenario: 'natural',
        journey: { ...journey(), taskCalls: 2, taskSucceeded: 2, subagentCompleted: 2 },
      }),
    ).toBe(false);
    expect(
      isLiveTaskJourneyPassedV1({
        scenario: 'natural',
        journey: {
          ...journey(),
          taskRoleCounts: { explore: 1, plan: 0, code: 0, review: 0, unknown: 0 },
        },
      }),
    ).toBe(false);
  });

  test('invalid-args scorer rejects extra successful task calls', () => {
    const recovered = {
      ...journey(),
      taskCalls: 2,
      taskFailedOrRejected: 1,
      invalidTaskCalls: 1,
      modelCorrectionCalls: 1,
      recoveredAfterTaskFailure: true,
    };
    expect(
      isLiveTaskJourneyPassedV1({ scenario: 'invalid_args_recovery', journey: recovered }),
    ).toBe(true);
    expect(
      isLiveTaskJourneyPassedV1({
        scenario: 'invalid_args_recovery',
        journey: { ...recovered, taskCalls: 3, taskSucceeded: 2, subagentCompleted: 2 },
      }),
    ).toBe(false);
  });

  test('does not contact a provider unless explicitly enabled', async () => {
    const report = await runLiveTaskJourneyEval({ live: false });
    expect(report.status).toBe('live_eval_skipped');
    expect(report.interactionMode).toBe('full');
    expect(report.authorizationMode).toBe('full_access');
    expect(report.scenario).toBe('natural');
    expect(report.arm).toBe('v2');
    expect(report.promptContractV2).toBe(true);
    expect(report.contentLogged).toBe(false);
  });

  test('declares the invalid-args recovery scenario without contacting a provider', async () => {
    const report = await runLiveTaskJourneyEval({ live: false, scenario: 'invalid_args_recovery' });
    expect(report.status).toBe('live_eval_skipped');
    expect(report.scenario).toBe('invalid_args_recovery');
  });

  test('declares a targeted role smoke without contacting a provider', async () => {
    const report = await runLiveTaskJourneyEval({
      live: false,
      scenario: 'role_smoke',
      role: 'review',
    });
    expect(report.status).toBe('live_eval_skipped');
    expect(report.scenario).toBe('role_smoke');
    expect(report.targetRole).toBe('review');
  });

  test('constructs a legacy control arm without contacting a provider', async () => {
    const report = await runLiveTaskJourneyEval({ live: false, arm: 'legacy' });
    expect(report.status).toBe('live_eval_skipped');
    expect(report.arm).toBe('legacy');
    expect(report.promptContractV2).toBe(false);
  });
});
