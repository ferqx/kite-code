import { describe, expect, test } from 'bun:test';
import {
  contextCompactionCohortBucket,
  resolveContextCompactionRollout,
} from '../../src/core/model/context-compaction-rollout';

describe('context compaction rollout', () => {
  test('assigns a stable session cohort and changes only with salt or session', () => {
    const first = contextCompactionCohortBucket('salt-a', 'session-a');
    expect(contextCompactionCohortBucket('salt-a', 'session-a')).toBe(first);
    expect(contextCompactionCohortBucket('salt-b', 'session-a')).not.toBe(first);
    expect(contextCompactionCohortBucket('salt-a', 'session-b')).not.toBe(first);
  });

  test('enforces the off/shadow/live truth table', () => {
    expect(
      resolveContextCompactionRollout({
        masterEnabled: false,
        configuredMode: 'live',
        sessionId: 'session',
      }),
    ).toBe('off');
    expect(
      resolveContextCompactionRollout({
        masterEnabled: true,
        configuredMode: 'shadow',
        sessionId: 'session',
      }),
    ).toBe('shadow');
    expect(
      resolveContextCompactionRollout({
        masterEnabled: true,
        configuredMode: 'live',
        livePercentage: 0,
        sessionId: 'session',
      }),
    ).toBe('shadow');
    expect(
      resolveContextCompactionRollout({
        masterEnabled: true,
        configuredMode: 'live',
        livePercentage: 100,
        sessionId: 'session',
      }),
    ).toBe('live');
  });
});
