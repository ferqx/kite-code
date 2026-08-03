import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../release/canonical-json';
import {
  type AgentTaskEvidenceSourceV1,
  type AuthenticatedAgentTaskEvidenceVerificationV1,
  agentTaskEvidenceSourceV1Schema,
  authenticatedAgentTaskEvidenceV1Schema,
  verifyAuthenticatedAgentTaskEvidenceV1,
} from './contracts/agent-task-authenticated-evidence';

export const PINNED_AGENT_TASK_REPOSITORY_V1 = 'ferqx/kite-code' as const;
export const PINNED_AGENT_TASK_REPOSITORY_ID_V1 = 'R_kgDOSKbi8g' as const;
export const PINNED_AGENT_TASK_WORKFLOW_PATH_V1 =
  '.github/workflows/agent-task-evidence.yml' as const;

export interface FormalAgentTaskEvidenceVerificationV1 {
  schema: 'FormalAgentTaskEvidenceVerificationV1';
  status: 'passed' | 'failed' | 'blocked';
  evidenceEligible: boolean;
  expectedSource: AgentTaskEvidenceSourceV1;
  sourceIdentityVerified: true;
  retainedArtifactIdentity: {
    artifactId: string;
    artifactName: string;
  };
  verification: AuthenticatedAgentTaskEvidenceVerificationV1;
  reportDigest: `sha256:${string}`;
}

export function verifyFormalAgentTaskEvidenceV1(input: {
  evidence: unknown;
  expectedSource: unknown;
}): FormalAgentTaskEvidenceVerificationV1 {
  const expectedSource = agentTaskEvidenceSourceV1Schema.parse(input.expectedSource);
  if (
    expectedSource.repository !== PINNED_AGENT_TASK_REPOSITORY_V1 ||
    expectedSource.repositoryId !== PINNED_AGENT_TASK_REPOSITORY_ID_V1 ||
    expectedSource.workflowPath !== PINNED_AGENT_TASK_WORKFLOW_PATH_V1
  ) {
    throw new Error('Agent task expected source is outside the pinned repository/workflow root.');
  }
  const evidence = authenticatedAgentTaskEvidenceV1Schema.parse(input.evidence);
  if (!sameCanonicalValue(evidence.source, expectedSource)) {
    throw new Error('Agent task evidence source identity does not match independent expectations.');
  }
  const verification = verifyAuthenticatedAgentTaskEvidenceV1(evidence);
  const material = {
    schema: 'FormalAgentTaskEvidenceVerificationV1' as const,
    status: verification.status,
    evidenceEligible: verification.evidenceEligible,
    expectedSource,
    sourceIdentityVerified: true as const,
    retainedArtifactIdentity: {
      artifactId: expectedSource.artifactId,
      artifactName: expectedSource.artifactName,
    },
    verification,
  };
  return Object.freeze({
    ...material,
    reportDigest: sha256DomainSeparated(
      'kite.evals.formal-agent-task-evidence-verification.v1',
      canonicalJsonBytes(material),
    ),
  });
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)));
}

function readArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const entry of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/.exec(entry);
    if (!match?.[1] || match[2] === undefined) throw new Error(`Invalid argument: ${entry}`);
    args.set(match[1], match[2]);
  }
  return args;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function expectedSourceFromArgs(args: Map<string, string>): AgentTaskEvidenceSourceV1 {
  return agentTaskEvidenceSourceV1Schema.parse({
    schema: 'AgentTaskEvidenceSourceV1',
    repository: required(args, 'expected-repository'),
    repositoryId: required(args, 'expected-repository-id'),
    headSha: required(args, 'expected-head-sha'),
    ref: required(args, 'expected-ref'),
    workflowPath: required(args, 'expected-workflow-path'),
    workflowRef: required(args, 'expected-workflow-ref'),
    workflowSha: required(args, 'expected-workflow-sha'),
    runId: required(args, 'expected-run-id'),
    runAttempt: Number(required(args, 'expected-run-attempt')),
    job: required(args, 'expected-job'),
    artifactId: required(args, 'expected-artifact-id'),
    artifactName: required(args, 'expected-artifact-name'),
    startedAt: required(args, 'expected-started-at'),
    endedAt: required(args, 'expected-ended-at'),
  });
}

if (import.meta.main) {
  const args = readArgs(process.argv.slice(2));
  const evidence = parseCanonicalJson(readFileSync(resolve(required(args, 'evidence'))));
  const report = verifyFormalAgentTaskEvidenceV1({
    evidence,
    expectedSource: expectedSourceFromArgs(args),
  });
  if (args.get('require-blocked') === 'true' && report.status !== 'blocked') {
    throw new Error(`Expected blocked formal evidence, received ${report.status}.`);
  }
  writeFileSync(resolve(required(args, 'output')), canonicalJsonBytes(report));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
