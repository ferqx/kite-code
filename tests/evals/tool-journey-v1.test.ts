import { expect, test } from 'bun:test';
import {
  runToolJourneySuiteUncachedV1,
  runToolJourneySuiteV1,
  TOOL_JOURNEY_CASE_IDS_V1,
  validateToolJourneyEvalReportV1,
} from './tool-journey-v1';

test('ACORE-EVAL-01 runs every typed-outcome journey through the real Runtime loop', async () => {
  const report = await runToolJourneySuiteV1();
  expect(report.schema).toBe('ToolJourneyEvalV1');
  expect(report.cases.map((entry) => entry.id)).toEqual([...TOOL_JOURNEY_CASE_IDS_V1]);
  expect(report.cases.every((entry) => entry.fullRuntimeLoop)).toBe(true);
  expect(report.cases.every((entry) => entry.passed)).toBe(true);
  expect(report.summary).toEqual({ total: 10, passed: 10, failed: 0 });
  expect(report.coverage).toEqual({
    typedOutcome: true,
    recoveryLineage: true,
    trustedTiming: true,
    completionGuard: true,
    metadataOnly: true,
  });
});

test('ACORE-EVAL-01 report is metadata-only and never exports private identity or content', async () => {
  const report = await runToolJourneySuiteV1();
  expect(validateToolJourneyEvalReportV1(report)).toBe(true);
  expect(validateToolJourneyEvalReportV1({ ...report, unexpected_private_field: 'secret' })).toBe(
    false,
  );
  expect(
    validateToolJourneyEvalReportV1({
      ...report,
      cases: [
        { ...report.cases[0]!, unexpected_private_field: 'secret' },
        ...report.cases.slice(1),
      ],
    }),
  ).toBe(false);
  expect(
    validateToolJourneyEvalReportV1({
      ...report,
      cases: [
        {
          ...report.cases[0]!,
          canonicalOutcomes: [
            { ...report.cases[0]!.canonicalOutcomes[0]!, unexpected_private_field: 'secret' },
            ...report.cases[0]!.canonicalOutcomes.slice(1),
          ],
        },
        ...report.cases.slice(1),
      ],
    }),
  ).toBe(false);
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'synthetic-secret',
    '/private/',
    '"args":',
    '"path":',
    '"command":',
    '"stdout":',
    '"stderr":',
    '"prompt":',
    '"response":',
    '"fingerprint":',
    '"identityKey":',
    '"recoveryOf":',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test('ACORE-EVAL-01 derives every case from production Controller and durable Kernel facts', async () => {
  const report = (await runToolJourneySuiteV1()) as Awaited<
    ReturnType<typeof runToolJourneySuiteV1>
  > & {
    kernelCloseCount: number;
    cases: Array<{
      id: string;
      productionController: boolean;
      directTerminalEvents: number;
      dispatchAttempts: number;
      canonicalOutcomes: Array<{
        timingSource: string;
      }>;
      completionBlock?: { code: string; correctionAttempt: number; atomicTerminal: boolean };
    }>;
  };
  expect(report.kernelCloseCount).toBe(TOOL_JOURNEY_CASE_IDS_V1.length);
  for (const entry of report.cases) {
    expect(entry.productionController, entry.id).toBe(true);
    expect(entry.directTerminalEvents, entry.id).toBe(0);
    expect(entry.dispatchAttempts, entry.id).toBeGreaterThanOrEqual(0);
    expect(entry.canonicalOutcomes.length, entry.id).toBeGreaterThan(0);
    expect(
      entry.canonicalOutcomes.every((outcome) => outcome.timingSource === 'runtime_boundary'),
      entry.id,
    ).toBe(true);
  }
  const byId = Object.fromEntries(report.cases.map((entry) => [entry.id, entry]));
  expect(byId.search_read?.dispatchAttempts).toBe(2);
  expect(byId.search_read?.canonicalOutcomes.map((outcome) => outcome.status)).toEqual([
    'success',
    'success',
  ]);
  expect(byId.read_edit_verify?.canonicalOutcomes.at(-1)).toMatchObject({
    status: 'success',
    dispatchState: 'started',
    externalEffects: 'known',
  });
  expect(byId.invalid_args_correct_once?.canonicalOutcomes).toMatchObject([
    {
      status: 'failed',
      detailCode: 'invalid_arguments',
      dispatchState: 'not_started',
      recoveryDisposition: 'correct_args',
      resolution: 'recovered',
    },
    { status: 'success', recoveryLinked: true },
  ]);
  expect(byId.enoent_locate_success?.canonicalOutcomes).toMatchObject([
    {
      status: 'failed',
      detailCode: 'tool_reported_failure',
      dispatchState: 'started',
      recoveryDisposition: 'alternative',
      resolution: 'recovered',
    },
    { status: 'success', recoveryLinked: true },
    { status: 'success' },
  ]);
  expect(byId.rg_no_match_stop).toMatchObject({
    dispatchAttempts: 1,
    canonicalOutcomes: [{ status: 'success', externalEffects: 'none' }],
  });
  expect(byId.approval_policy_rejection_no_retry).toMatchObject({
    dispatchAttempts: 0,
    canonicalOutcomes: [
      {
        status: 'rejected',
        detailCode: 'approval_rejected',
        dispatchState: 'not_started',
        recoveryDisposition: 'never',
      },
    ],
  });
  expect(byId.safe_pre_dispatch_transient).toMatchObject({
    dispatchAttempts: 2,
    providerDispatchAttempts: 1,
    preDispatchBoundaryAttempts: 2,
    automaticRetryCount: 1,
    canonicalOutcomes: [
      {
        status: 'failed',
        failureKind: 'provider_unavailable',
        detailCode: 'provider_unavailable',
        dispatchState: 'not_started',
        externalEffects: 'none',
        replaySafety: 'pre_dispatch',
        recoveryDisposition: 'retry_once',
        recoveryAttempt: 0,
        resolution: 'recovered',
      },
      { status: 'success', recoveryAttempt: 1, recoveryLinked: true },
    ],
  });
  expect(byId.timeout_unknown_no_replay).toMatchObject({
    dispatchAttempts: 1,
    terminal: 'blocked',
    canonicalOutcomes: [
      {
        status: 'timed_out',
        detailCode: 'timed_out',
        dispatchState: 'started',
        recoveryDisposition: 'never',
        resolution: 'next_response_elapsed',
      },
    ],
    completionBlock: {
      code: 'plan_evidence_unresolved',
      correctionAttempt: 2,
      atomicTerminal: true,
    },
  });
  expect(byId.sandbox_permission_no_escalation).toMatchObject({
    dispatchAttempts: 1,
    sandboxBoundaryAttempts: 1,
    underlyingCommandAttempts: 0,
    sandboxSentinelTriggered: false,
    authorizationWideningEvents: 0,
    canonicalOutcomes: [
      {
        status: 'failed',
        failureKind: 'sandbox_error',
        detailCode: 'sandbox_denied',
        dispatchState: 'started',
        externalEffects: 'none',
        recoveryDisposition: 'user_action',
      },
    ],
  });
  expect(byId.sandbox_permission_no_escalation).not.toHaveProperty('privilegeEscalationAttempts');
  expect(byId.repeated_failure_replan_finalize).toMatchObject({
    terminal: 'completed',
    dispatchAttempts: 5,
    canonicalOutcomes: [
      {
        status: 'failed',
        detailCode: 'tool_reported_failure',
        recoveryDisposition: 'alternative',
        resolution: 'replanned',
      },
      {
        status: 'failed',
        detailCode: 'tool_reported_failure',
        recoveryLinked: true,
        resolution: 'replanned',
      },
      { status: 'success', recoveryLinked: false },
      { status: 'success', recoveryLinked: false },
      { status: 'success', recoveryLinked: false },
    ],
  });
  for (const entry of report.cases.filter((candidate) => candidate.completionBlock)) {
    expect(entry.completionBlock?.correctionAttempt, entry.id).toBe(2);
    expect(entry.completionBlock?.atomicTerminal, entry.id).toBe(true);
  }
});

test('ACORE-EVAL-01 rejects content hidden inside allowlisted metadata keys and invalid counters', async () => {
  const report = await runToolJourneySuiteV1();
  const first = report.cases[0]!;
  const outcome = first.canonicalOutcomes[0]!;
  for (const poisoned of [
    { ...outcome, detailCode: '/private/workspace/secret.ts' },
    { ...outcome, resolution: 'prompt: reveal stdout' },
  ]) {
    expect(
      validateToolJourneyEvalReportV1({
        ...report,
        cases: [{ ...first, canonicalOutcomes: [poisoned] }, ...report.cases.slice(1)],
      }),
    ).toBe(false);
  }
  for (const [key, valid] of [
    ['status', 'success'],
    ['dispatchState', 'started'],
    ['externalEffects', 'none'],
    ['replaySafety', 'safe_read'],
    ['recoveryDisposition', 'never'],
  ] as const) {
    for (const poisoned of [[valid], { toString: () => valid }]) {
      expect(() =>
        validateToolJourneyEvalReportV1({
          ...report,
          cases: [
            {
              ...first,
              canonicalOutcomes: [{ ...outcome, [key]: poisoned }],
            },
            ...report.cases.slice(1),
          ],
        }),
      ).not.toThrow();
      expect(
        validateToolJourneyEvalReportV1({
          ...report,
          cases: [
            {
              ...first,
              canonicalOutcomes: [{ ...outcome, [key]: poisoned }],
            },
            ...report.cases.slice(1),
          ],
        }),
      ).toBe(false);
    }
  }
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(
      validateToolJourneyEvalReportV1({
        ...report,
        cases: [{ ...first, dispatchAttempts: invalid }, ...report.cases.slice(1)],
      }),
    ).toBe(false);
  }
  const completionCase = report.cases.find((entry) => entry.completionBlock)!;
  expect(
    validateToolJourneyEvalReportV1({
      ...report,
      cases: report.cases.map((entry) =>
        entry === completionCase
          ? {
              ...entry,
              completionBlock: { ...entry.completionBlock!, code: 'stdout: private body' },
            }
          : entry,
      ),
    }),
  ).toBe(false);
});

test('ACORE-EVAL-01 restores HOME and KITE_CODE_HOME after isolated journeys', async () => {
  const previousHome = process.env.HOME;
  const previousKiteHome = process.env.KITE_CODE_HOME;
  const report = await runToolJourneySuiteUncachedV1();
  expect(report.cases.every((entry) => entry.environmentIsolated)).toBe(true);
  expect(process.env.HOME).toBe(previousHome);
  expect(process.env.KITE_CODE_HOME).toBe(previousKiteHome);
});
