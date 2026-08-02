import { describe, expect, test } from 'bun:test';
import { syntheticCompactionCase } from './schema';
import { buildSyntheticBlindSemanticContract } from './semantic-evaluator';

describe('synthetic blind semantic contract', () => {
  test('hides case and control/treatment labels and cannot fabricate evaluator scores', () => {
    const report = buildSyntheticBlindSemanticContract(
      syntheticCompactionCase(),
      'A candidate summary for a synthetic fixture.',
    );
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.blindId).toBe('item-001');
    expect(JSON.stringify(report.items)).not.toContain('treatment');
    expect(JSON.stringify(report.items)).not.toContain('control');
    expect(JSON.stringify(report.items)).not.toContain('natural-goal');
    expect(report.evaluatorRoute).toBe('unconfigured');
    expect(report.evaluatorOutcome).toBe('not_observed');
    expect(report.uncertainty).toBeNull();
    expect(report.status).toBe('blocked');
    expect(report.evidenceEligible).toBeFalse();
  });

  test('rejects cases without semantic facts instead of lowering the rubric', () => {
    const fixture = syntheticCompactionCase();
    fixture.facts = fixture.facts.filter((fact) => fact.matcher !== 'semantic');
    expect(() => buildSyntheticBlindSemanticContract(fixture, 'candidate')).toThrow(
      'no semantic facts',
    );
  });
});
