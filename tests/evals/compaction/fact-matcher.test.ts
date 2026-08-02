import { describe, expect, test } from 'bun:test';
import { matchCompactionFacts, normalizeFactText } from './fact-matcher';
import { syntheticCompactionCase } from './schema';

describe('deterministic compaction fact matcher', () => {
  test('defines stable escaping, case, whitespace, and path normalization', () => {
    expect(normalizeFactText('  KEEP .\\src\\stable.ts\nUNCHANGED ')).toBe(
      'keep src/stable.ts unchanged',
    );
    const report = matchCompactionFacts(
      syntheticCompactionCase(),
      'KEEP src/stable.ts   unchanged. The work is pending.',
    );
    expect(report.deterministicOutcome).toBe('passed');
    expect(report.semanticNotObserved).toEqual(['natural-goal']);
    expect(report.status).toBe('blocked');
  });

  test('never lets a semantic item cover a critical deterministic loss', () => {
    const fixture = syntheticCompactionCase();
    fixture.facts[0] = {
      version: 1,
      factId: 'approval-state',
      importance: 'critical',
      category: 'approval',
      matcher: 'exact',
      expected: 'approval: denied',
    };
    const report = matchCompactionFacts(fixture, 'The intent is semantically similar.');
    expect(report.deterministicOutcome).toBe('failed');
    expect(report.criticalMissing).toEqual(['approval-state']);
    expect(report.reversalViolations).toEqual(['approval-state']);
  });

  test('fails forbidden claims even when all deterministic facts survive', () => {
    const report = matchCompactionFacts(
      syntheticCompactionCase(),
      'Keep src/stable.ts unchanged. Verification PASSED.',
    );
    expect(report.deterministicOutcome).toBe('failed');
    expect(report.forbiddenClaimsFound).toEqual(['verification passed']);
  });
});
