import { sha256Digest } from '../../../scripts/release/canonical-json';
import { syntheticAgentTaskCase } from './cases/synthetic-case';
import {
  type AgentTaskAttemptV1,
  type AgentTaskRepeatedReportV1,
  buildRepeatedRunReport,
} from './repeated-runner';
import {
  AgentTaskSuiteRegistryV1,
  type AgentTaskSuiteRevisionV1,
  type SuiteBehaviorIdentityV1,
} from './suite-registry';

export function syntheticBehaviorIdentity(): SuiteBehaviorIdentityV1 {
  return {
    version: 1,
    routeDigest: digest('route'),
    artifactDigest: digest('artifact'),
    contractDigest: digest('contract'),
    toolSchemaDigest: digest('tools'),
    evaluatorDigest: digest('evaluator'),
  };
}

export function syntheticSuite(): AgentTaskSuiteRevisionV1 {
  const registry = new AgentTaskSuiteRegistryV1();
  const task = syntheticAgentTaskCase();
  return registry.register({
    version: 1,
    suiteId: 'synthetic-agent-suite',
    revision: 1,
    oracleVersion: 'agent-task-oracle-v1',
    scorerVersion: 'agent-task-scorer-v1',
    cases: [task],
    partitions: [{ caseId: task.caseId, partition: 'development' }],
    behaviorIdentity: syntheticBehaviorIdentity(),
    decision: { id: 'D-07', status: 'unconfigured', approvedAt: null },
    evidenceEligible: false,
  });
}

export function syntheticRepeatedReport(
  suite: AgentTaskSuiteRevisionV1 = syntheticSuite(),
): AgentTaskRepeatedReportV1 {
  const task = suite.cases[0];
  if (!task) throw new Error('Synthetic suite requires one case.');
  const identity = suite.behaviorIdentity;
  const config = {
    version: 1 as const,
    executionClass: 'synthetic_fixture' as const,
    caseId: task.caseId,
    suiteDigest: suite.suiteDigest,
    routeIdentity: 'synthetic-offline-route',
    configDigest: digest('config'),
    artifactDigest: identity.artifactDigest,
    contractDigest: identity.contractDigest,
    schemaDigest: identity.toolSchemaDigest,
    repetitionCount: 1,
    evaluatorSeed: 1729,
    decision: { id: 'D-07' as const, status: 'unconfigured' as const, approvedAt: null },
  };
  const attempt: AgentTaskAttemptV1 = {
    version: 1,
    attemptIndex: 0,
    attemptId: 'synthetic-attempt-0',
    caseId: task.caseId,
    startedAt: '2026-08-02T00:00:00.000Z',
    finishedAt: '2026-08-02T00:00:01.000Z',
    attempted: true,
    producedChange: true,
    checksPassed: true,
    humanAccepted: 'not_observed',
    integrated: 'not_observed',
    reverted: 'not_observed',
    failureKinds: [],
    oracleDigest: digest('oracle'),
    metrics: {
      latencyMs: 1_000,
      modelCalls: 1,
      toolCalls: 2,
      inputTokens: 100,
      outputTokens: 50,
      approvalCount: 0,
      userCorrections: 0,
    },
  };
  return buildRepeatedRunReport(config, [attempt]);
}

export function digest(value: string): `sha256:${string}` {
  return sha256Digest(value);
}
