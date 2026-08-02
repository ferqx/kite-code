import { describe, expect, test } from 'bun:test';
import { COMPACTION_FACT_CATEGORIES, parseCompactionCase, syntheticCompactionCase } from './schema';

describe('CompactionCaseV1', () => {
  test('accepts a strict versioned synthetic case with one to five increments', () => {
    const fixture = syntheticCompactionCase();
    expect(parseCompactionCase(fixture)).toEqual(fixture);
    expect(COMPACTION_FACT_CATEGORIES).toContain('verification');
    expect(COMPACTION_FACT_CATEGORIES).toContain('next_step');
  });

  test('rejects version drift, unknown fields, duplicate identities, and live content', () => {
    expect(() => parseCompactionCase({ ...syntheticCompactionCase(), version: 2 })).toThrow();
    expect(() =>
      parseCompactionCase({ ...syntheticCompactionCase(), releaseEligible: true }),
    ).toThrow();

    const duplicate = syntheticCompactionCase();
    const first = duplicate.transcript[0];
    if (!first) throw new Error('fixture transcript unexpectedly empty');
    const firstIncrement = duplicate.increments[0];
    if (!firstIncrement) throw new Error('fixture increment unexpectedly empty');
    firstIncrement.push(structuredClone(first));
    expect(() => parseCompactionCase(duplicate)).toThrow('messageId must be unique');

    expect(() =>
      parseCompactionCase({ ...syntheticCompactionCase(), source: 'production_transcript' }),
    ).toThrow();
  });

  test('requires at least one and no more than five incremental rounds', () => {
    expect(() => parseCompactionCase({ ...syntheticCompactionCase(), increments: [] })).toThrow();
    expect(() =>
      parseCompactionCase({
        ...syntheticCompactionCase(),
        increments: Array.from({ length: 6 }, (_, index) => [
          {
            version: 1,
            messageId: `round-${index}`,
            role: 'user',
            content: 'synthetic',
            toolCallId: null,
          },
        ]),
      }),
    ).toThrow();
  });
});
