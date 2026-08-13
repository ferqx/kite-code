import { describe, expect, test } from 'bun:test';
import {
  AGENT_TASK_CATEGORIES,
  AgentTaskSchemaError,
  parseAgentTaskCase,
} from '../../../scripts/evals/contracts/agent-task-case-schema';
import { syntheticAgentTaskCase } from './cases/synthetic-case';

describe('AgentTaskCaseV1 schema', () => {
  test('freezes the complete local task taxonomy and strict synthetic case shape', () => {
    expect(AGENT_TASK_CATEGORIES).toEqual([
      'repository_research',
      'bug_fix',
      'small_feature',
      'refactor',
      'test',
      'documentation',
      'failure_recovery',
      'adversarial',
    ]);
    const task = syntheticAgentTaskCase();
    expect(parseAgentTaskCase(task)).toEqual(task);
  });

  test('rejects unknown fields, unsafe paths, path overlap, and network-enabled checks', () => {
    const unknown = { ...syntheticAgentTaskCase(), acceptanceThreshold: 0.9 };
    expect(() => parseAgentTaskCase(unknown)).toThrow(AgentTaskSchemaError);

    const traversal = syntheticAgentTaskCase();
    traversal.allowedPaths = ['../src/'];
    expect(() => parseAgentTaskCase(traversal)).toThrow('normalized relative');

    const overlap = syntheticAgentTaskCase();
    overlap.forbiddenPaths = ['src/math.ts'];
    expect(() => parseAgentTaskCase(overlap)).toThrow('must not overlap');

    const online = structuredClone(syntheticAgentTaskCase()) as unknown as {
      requiredChecks: Array<Record<string, unknown>>;
    };
    if (online.requiredChecks[0]) online.requiredChecks[0].network = 'allowlist';
    expect(() => parseAgentTaskCase(online)).toThrow('network');
  });

  test('rejects context/capability drift and duplicate oracle or check identities', () => {
    const longContextDrift = syntheticAgentTaskCase();
    longContextDrift.contextClass = 'long';
    expect(() => parseAgentTaskCase(longContextDrift)).toThrow('must match contextClass');

    const duplicateFact = syntheticAgentTaskCase();
    const firstFact = duplicateFact.requiredDiffFacts[0];
    if (!firstFact) throw new Error('Synthetic case lost its required fact.');
    duplicateFact.forbiddenDiffFacts[0] = {
      version: 1,
      factId: firstFact.factId,
      kind: 'patch_contains',
      text: 'forbidden',
    };
    expect(() => parseAgentTaskCase(duplicateFact)).toThrow('factId must be unique');

    const duplicateCheck = syntheticAgentTaskCase();
    const firstCheck = duplicateCheck.requiredChecks[0];
    if (!firstCheck) throw new Error('Synthetic case lost its required check.');
    duplicateCheck.requiredChecks.push(structuredClone(firstCheck));
    expect(() => parseAgentTaskCase(duplicateCheck)).toThrow('checkId must be unique');
  });
});
