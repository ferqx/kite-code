import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../release/canonical-json';
import {
  type AgentTaskEvidenceSourceV1,
  authenticatedAgentTaskEvidenceV1Schema,
} from './contracts/agent-task-authenticated-evidence';
import {
  type AgentTaskProductEvidenceVerificationV1,
  verifyAgentTaskProductEvidenceV1,
} from './contracts/agent-task-product-evidence';
import {
  type FormalAgentTaskEvidenceVerificationV1,
  verifyFormalAgentTaskEvidenceV1,
} from './verify-agent-task-evidence';

export interface FormalAgentTaskProductCompanionVerificationV1 {
  schema: 'FormalAgentTaskProductCompanionVerificationV1';
  status: 'passed' | 'blocked' | 'failed';
  evidenceEligible: boolean;
  formalVerification: FormalAgentTaskEvidenceVerificationV1;
  productVerification: AgentTaskProductEvidenceVerificationV1;
  expectedAttemptCount: number;
  reportDigest: `sha256:${string}`;
}

export function verifyFormalAgentTaskProductCompanionV1(input: {
  formalEvidence: unknown;
  productEvidence: unknown;
  expectedSource: AgentTaskEvidenceSourceV1;
  requiredHumanReceiptCount: number;
}): FormalAgentTaskProductCompanionVerificationV1 {
  if (
    !Number.isSafeInteger(input.requiredHumanReceiptCount) ||
    input.requiredHumanReceiptCount < 0
  ) {
    throw new Error('Required human receipt count must be a non-negative integer.');
  }
  const formalEvidence = authenticatedAgentTaskEvidenceV1Schema.parse(input.formalEvidence);
  const formalVerification = verifyFormalAgentTaskEvidenceV1({
    evidence: formalEvidence,
    expectedSource: input.expectedSource,
  });
  const expectedAttempts = formalEvidence.caseLedgers.flatMap((ledger) =>
    ledger.attempts.map((attempt) => ({ attemptId: attempt.attemptId, caseId: ledger.caseId })),
  );
  const productVerification = verifyAgentTaskProductEvidenceV1({
    evidence: input.productEvidence,
    expectedSource: formalEvidence.source,
    expectedCandidate: formalEvidence.candidate,
    expectedAttempts,
    requiredHumanReceiptCount: input.requiredHumanReceiptCount,
  });
  const status =
    formalVerification.status === 'failed' || productVerification.status === 'failed'
      ? ('failed' as const)
      : formalVerification.status === 'blocked' || productVerification.status === 'blocked'
        ? ('blocked' as const)
        : ('passed' as const);
  const evidenceEligible =
    status === 'passed' &&
    formalVerification.evidenceEligible &&
    productVerification.evidenceEligible;
  const material = {
    schema: 'FormalAgentTaskProductCompanionVerificationV1' as const,
    status,
    evidenceEligible,
    formalVerification,
    productVerification,
    expectedAttemptCount: expectedAttempts.length,
  };
  return Object.freeze({
    ...material,
    reportDigest: sha256DomainSeparated(
      'kite.evals.formal-agent-task-product-companion-verification.v1',
      canonicalJsonBytes(material),
    ),
  });
}

function readArgs(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/.exec(entry);
    if (!match?.[1] || match[2] === undefined) throw new Error(`Invalid argument: ${entry}`);
    result.set(match[1], match[2]);
  }
  return result;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

if (import.meta.main) {
  const args = readArgs(process.argv.slice(2));
  const report = verifyFormalAgentTaskProductCompanionV1({
    formalEvidence: parseCanonicalJson(readFileSync(resolve(required(args, 'formal-evidence')))),
    productEvidence: parseCanonicalJson(readFileSync(resolve(required(args, 'product-evidence')))),
    expectedSource: parseCanonicalJson(
      readFileSync(resolve(required(args, 'expected-source'))),
    ) as AgentTaskEvidenceSourceV1,
    requiredHumanReceiptCount: Number(required(args, 'required-human-receipt-count')),
  });
  if (args.get('require-blocked') === 'true' && report.status !== 'blocked') {
    throw new Error(`Expected blocked product companion, received ${report.status}.`);
  }
  writeFileSync(resolve(required(args, 'output')), canonicalJsonBytes(report));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
