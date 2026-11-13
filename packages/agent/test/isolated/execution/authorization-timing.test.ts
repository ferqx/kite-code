import { expect, test } from '#kite-test';
import {
  type AuthorizationTimingState,
  authorizationTimingSnapshot,
} from '../../../src/execution/authorization-timing';

test('preparation before queue admission consumes the original total budget', () => {
  expect(authorizationTimingSnapshot({ startedAt: 1000, budgetMs: 3000 }, 4000)).toEqual({
    startedAt: 1000,
    budgetMs: 3000,
    deadlineAt: 4000,
    prepareMs: 3000,
    queueMs: 0,
    providerMs: 0,
    totalMs: 3000,
  });
});

test('waiting for a permit counts only actual queue time', () => {
  const state = { startedAt: 1000, budgetMs: 3000, queueStartedAt: 1020 };
  expect(authorizationTimingSnapshot(state, 4000)).toMatchObject({
    prepareMs: 20,
    queueMs: 2980,
    providerMs: 0,
    totalMs: 3000,
    deadlineAt: 4000,
  });
});

test('post-permit dispatch and request preparation remain preparation until stream starts', () => {
  const state = {
    startedAt: 1000,
    budgetMs: 3000,
    queueStartedAt: 1020,
    queueFinishedAt: 1060,
  };
  expect(authorizationTimingSnapshot(state, 1100)).toMatchObject({
    prepareMs: 60,
    queueMs: 40,
    providerMs: 0,
    totalMs: 100,
  });
  expect(authorizationTimingSnapshot({ ...state, providerStartedAt: 1080 }, 1200)).toMatchObject({
    prepareMs: 40,
    queueMs: 40,
    providerMs: 120,
    totalMs: 200,
  });
});

test('snapshots do not restart or cap elapsed time at the deadline, and never mutate the tracker', () => {
  const state = Object.freeze({
    startedAt: 1000,
    budgetMs: 40,
    queueStartedAt: 1005,
    queueFinishedAt: 1010,
    providerStartedAt: 1015,
  });
  const first = authorizationTimingSnapshot(state, 1040);
  const later = authorizationTimingSnapshot(state, 1100);
  expect(first).toMatchObject({ prepareMs: 10, queueMs: 5, providerMs: 25, totalMs: 40 });
  expect(later).toMatchObject({ prepareMs: 10, queueMs: 5, providerMs: 85, totalMs: 100 });
  expect(first.deadlineAt).toBe(1040);
  expect(later.deadlineAt).toBe(first.deadlineAt);
  expect(state).toEqual({
    startedAt: 1000,
    budgetMs: 40,
    queueStartedAt: 1005,
    queueFinishedAt: 1010,
    providerStartedAt: 1015,
  });
});

test('clock rollback and future milestones cannot create negative or overlapping durations', () => {
  const states: AuthorizationTimingState[] = [
    { startedAt: 1000, budgetMs: 40 },
    { startedAt: 1000, budgetMs: 40, queueStartedAt: 1010 },
    {
      startedAt: 1000,
      budgetMs: 40,
      queueStartedAt: 990,
      queueFinishedAt: 980,
      providerStartedAt: 970,
    },
    {
      startedAt: 1000,
      budgetMs: 40,
      queueStartedAt: 1010,
      queueFinishedAt: 2000,
      providerStartedAt: 1100,
    },
  ];
  for (const state of states)
    for (const now of [900, 1000, 1005, 1200]) {
      const value = authorizationTimingSnapshot(state, now);
      expect(value.prepareMs).toBeGreaterThanOrEqual(0);
      expect(value.queueMs).toBeGreaterThanOrEqual(0);
      expect(value.providerMs).toBeGreaterThanOrEqual(0);
      expect(value.prepareMs + value.queueMs + value.providerMs).toBe(value.totalMs);
    }
});

test('non-finite or unsafe values fail explicitly instead of producing invalid observations', () => {
  for (const state of [
    { startedAt: Number.NaN, budgetMs: 40 },
    { startedAt: 1000, budgetMs: Number.POSITIVE_INFINITY },
    { startedAt: 1000, budgetMs: 0 },
    { startedAt: 1000, budgetMs: -1 },
    { startedAt: Number.MAX_SAFE_INTEGER, budgetMs: 1 },
    { startedAt: 1000, budgetMs: 40, queueStartedAt: 1000.5 },
  ])
    expect(() => authorizationTimingSnapshot(state, 1100)).toThrow('invalid_authorization_timing');
  expect(() => authorizationTimingSnapshot({ startedAt: 1000, budgetMs: 40 }, Number.NaN)).toThrow(
    'invalid_authorization_timing',
  );
});
