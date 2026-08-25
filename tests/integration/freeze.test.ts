import { describe, expect, test } from 'bun:test';
import { freezeAnsi, freezeState } from '../helpers/freeze';

describe('freezeAnsi', () => {
  test('replaces timer pattern', () => {
    expect(freezeAnsi('00:42 elapsed', ['timer'])).toBe('<TIMER> elapsed');
  });

  test('does not replace short numbers as timer', () => {
    expect(freezeAnsi('Step 1/5 done', ['timer'])).toBe('Step 1/5 done');
  });

  test('replaces cache hit rate', () => {
    expect(freezeAnsi('cache: 42%', ['cacheHitRate'])).toBe('cache: <CACHE_HIT_RATE>');
  });

  test('replaces large numbers as token count', () => {
    expect(freezeAnsi('tokens: 123,456 used', ['cacheTokenCount'])).toBe(
      'tokens: <CACHE_TOKEN_COUNT> used',
    );
  });

  test('replaces timestamp pattern', () => {
    expect(freezeAnsi('at 2025-01-15T10:30:00Z', ['timestamp'])).toContain('<TIMESTAMP>');
  });

  test('replaces tool elapsed time', () => {
    expect(freezeAnsi('done (150ms)', ['toolElapsed'])).toBe('done <TOOL_ELAPSED>');
    expect(freezeAnsi('done (1.2s)', ['toolElapsed'])).toBe('done <TOOL_ELAPSED>');
  });

  test('multiple freezes', () => {
    const input = 't=00:42 cache=80% tokens=5,000 took (100ms)';
    expect(freezeAnsi(input, ['timer', 'cacheHitRate', 'cacheTokenCount', 'toolElapsed'])).toBe(
      't=<TIMER> cache=<CACHE_HIT_RATE> tokens=<CACHE_TOKEN_COUNT> took <TOOL_ELAPSED>',
    );
  });
});

describe('freezeState', () => {
  test('replaces cache fields in status', () => {
    const state = { status: { cacheHitRate: 42, totalTokens: 123456, other: 'keep' } };
    const frozen = freezeState(state, ['cacheHitRate', 'cacheTokenCount']);
    expect(frozen.status).toEqual({
      cacheHitRate: '<CACHE_HIT_RATE>',
      totalTokens: '<CACHE_TOKEN_COUNT>',
      other: 'keep',
    });
  });

  test('no-op when no freeze keys', () => {
    const state = { status: { cacheHitRate: 42 } };
    expect(freezeState(state, [])).toEqual(state);
  });

  test('handles missing status', () => {
    expect(freezeState({ blocks: [] }, ['cacheHitRate'])).toEqual({ blocks: [] });
  });
});
