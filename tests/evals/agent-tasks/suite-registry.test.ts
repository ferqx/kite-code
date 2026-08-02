import { describe, expect, test } from 'bun:test';
import { syntheticAgentTaskCase } from './cases/synthetic-case';
import { digest, syntheticBehaviorIdentity } from './evaluation-test-fixtures';
import { AgentTaskSuiteRegistryV1, modelVisibleCase, suiteRequiresRerun } from './suite-registry';

describe('Agent task suite registry and contamination policy', () => {
  test('keeps suite revisions immutable and append-only', () => {
    const registry = new AgentTaskSuiteRegistryV1();
    const first = registry.register(suiteInput(1));
    first.cases[0]!.title = 'caller mutation';
    expect(registry.revision('synthetic-agent-suite', 1).cases[0]?.title).not.toBe(
      'caller mutation',
    );
    expect(() => registry.register(suiteInput(1))).toThrow('append as revision 2');

    const secondInput = suiteInput(2);
    secondInput.cases[0]!.title = 'New immutable revision';
    const second = registry.register(secondInput);
    expect(second.revision).toBe(2);
    expect(second.suiteDigest).not.toBe(first.suiteDigest);
    expect(registry.revision('synthetic-agent-suite', 1).suiteDigest).toBe(first.suiteDigest);
  });

  test('records contamination without deleting history and supports explicit clearing', () => {
    const registry = new AgentTaskSuiteRegistryV1();
    const revision = registry.register(suiteInput(1));
    const caseId = revision.cases[0]!.caseId;
    registry.recordContamination({
      suiteId: revision.suiteId,
      revision: revision.revision,
      caseId,
      status: 'confirmed',
      reasonCode: 'fixture_leaked',
    });
    expect(registry.caseEligible(revision.suiteId, revision.revision, caseId)).toBe(false);
    registry.recordContamination({
      suiteId: revision.suiteId,
      revision: revision.revision,
      caseId,
      status: 'cleared',
      reasonCode: 'new_holdout_proven',
    });
    expect(registry.caseEligible(revision.suiteId, revision.revision, caseId)).toBe(true);
    expect(registry.contaminationRecords()).toHaveLength(2);
    expect(registry.revision(revision.suiteId, revision.revision).suiteDigest).toBe(
      revision.suiteDigest,
    );
  });

  test('does not expose hidden oracle/checks and invalidates results on behavior identity drift', () => {
    const task = syntheticAgentTaskCase();
    const visible = modelVisibleCase(task);
    expect(Object.keys(visible)).not.toContain('requiredDiffFacts');
    expect(Object.keys(visible)).not.toContain('forbiddenDiffFacts');
    expect(Object.keys(visible)).not.toContain('requiredChecks');

    const registry = new AgentTaskSuiteRegistryV1();
    const revision = registry.register(suiteInput(1));
    expect(suiteRequiresRerun(revision, syntheticBehaviorIdentity())).toBe(false);
    const changed = syntheticBehaviorIdentity();
    changed.toolSchemaDigest = digest('changed-tools');
    expect(suiteRequiresRerun(revision, changed)).toBe(true);
  });

  test('requires exactly one development/holdout partition per case', () => {
    const registry = new AgentTaskSuiteRegistryV1();
    const invalid = suiteInput(1);
    invalid.partitions = [];
    expect(() => registry.register(invalid)).toThrow('exactly one');
  });
});

function suiteInput(revision: number) {
  const task = syntheticAgentTaskCase();
  return {
    version: 1 as const,
    suiteId: 'synthetic-agent-suite',
    revision,
    oracleVersion: 'agent-task-oracle-v1' as const,
    scorerVersion: 'agent-task-scorer-v1' as const,
    cases: [task],
    partitions: [{ caseId: task.caseId, partition: 'development' as const }],
    behaviorIdentity: syntheticBehaviorIdentity(),
    decision: { id: 'D-07' as const, status: 'unconfigured' as const, approvedAt: null },
    evidenceEligible: false as const,
  };
}
