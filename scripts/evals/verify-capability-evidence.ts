import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../release/canonical-json';
import { capabilityEvaluationRetainedInputV1Schema } from './capability-evidence-producer';
import {
  type CapabilityEvaluationExpectedIdentityV1,
  capabilityEvaluationEvidenceV1Schema,
  capabilityEvaluationSourceV1Schema,
  computeCapabilityEvaluatorIdentityDigestV1,
  verifyCapabilityEvaluationEvidenceV1,
} from './contracts/capability-evaluation-evidence';

export const formalCapabilityExpectedSourceV1Schema = capabilityEvaluationSourceV1Schema;

export interface FormalCapabilityEvidenceVerificationV1 {
  schema: 'FormalCapabilityEvidenceVerificationV1';
  status: 'passed' | 'blocked' | 'failed';
  evidenceEligible: boolean;
  sourceIdentityVerified: true;
  retainedInputVerified: true;
  verification: ReturnType<typeof verifyCapabilityEvaluationEvidenceV1>;
  reportDigest: `sha256:${string}`;
}

export function verifyFormalCapabilityEvidenceV1(input: {
  evidence: unknown;
  retainedInput: unknown;
  expectedSource: unknown;
  now: string;
}): FormalCapabilityEvidenceVerificationV1 {
  const evidence = capabilityEvaluationEvidenceV1Schema.parse(input.evidence);
  const retained = capabilityEvaluationRetainedInputV1Schema.parse(input.retainedInput);
  const expectedSource = formalCapabilityExpectedSourceV1Schema.parse(input.expectedSource);
  if (!sameCanonicalValue(evidence.source, expectedSource)) {
    throw new Error('Capability evidence source does not match independent workflow expectations.');
  }
  if (
    evidence.capability !== retained.capability ||
    evidence.executionClass !== retained.executionClass ||
    !sameCanonicalValue(evidence.artifactIdentity, retained.artifactIdentity) ||
    evidence.routeDigest !== retained.routeDigest ||
    evidence.profileDigest !== retained.profileDigest ||
    !sameCanonicalValue(evidence.evaluatorIdentity, retained.evaluatorIdentity) ||
    evidence.freshnessSeconds !== retained.freshnessSeconds ||
    evidence.observedAt !== retained.endedAt
  ) {
    throw new Error('Capability evidence does not bind the retained evaluation input.');
  }
  const expected: CapabilityEvaluationExpectedIdentityV1 = {
    capability: retained.capability,
    source: expectedSource,
    artifactIdentity: retained.artifactIdentity,
    routeDigest: retained.routeDigest as `sha256:${string}`,
    profileDigest: retained.profileDigest as `sha256:${string}`,
    evaluatorIdentityDigest: computeCapabilityEvaluatorIdentityDigestV1(retained.evaluatorIdentity),
    freshnessSeconds: retained.freshnessSeconds,
    now: z.iso.datetime({ offset: true }).parse(input.now),
  };
  const verification = verifyCapabilityEvaluationEvidenceV1(evidence, expected);
  const material = {
    schema: 'FormalCapabilityEvidenceVerificationV1' as const,
    status: verification.status,
    evidenceEligible: verification.evidenceEligible,
    sourceIdentityVerified: true as const,
    retainedInputVerified: true as const,
    verification,
  };
  return Object.freeze({
    ...material,
    reportDigest: sha256DomainSeparated(
      'kite.evals.formal-capability-evidence-verification.v1',
      canonicalJsonBytes(material),
    ),
  });
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)));
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
  const evidence = parseCanonicalJson(readFileSync(resolve(required(args, 'evidence'))));
  const retainedInput = parseCanonicalJson(readFileSync(resolve(required(args, 'retained-input'))));
  const expectedSource = parseCanonicalJson(
    readFileSync(resolve(required(args, 'expected-source'))),
  );
  const report = verifyFormalCapabilityEvidenceV1({
    evidence,
    retainedInput,
    expectedSource,
    now: required(args, 'now'),
  });
  if (args.get('require-blocked') === 'true' && report.status !== 'blocked') {
    throw new Error(`Expected blocked capability evidence, received ${report.status}.`);
  }
  writeFileSync(resolve(required(args, 'output')), canonicalJsonBytes(report));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
