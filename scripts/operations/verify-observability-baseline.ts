import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalJson,
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../release/canonical-json';
import {
  type ObservabilityBaselineExpectationV1,
  observabilityBaselineExpectationV1Schema,
  verifyObservabilityBaselineLedgerV1,
} from './observability-baseline-ledger';
import {
  type ObservabilityBaselineReportV1,
  observabilityBaselineReportV1Schema,
  produceObservabilityBaselineReportV1,
} from './produce-observability-baseline';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

// Production baseline authority is source-owned and intentionally absent. It
// cannot be supplied by a CLI argument or report field. A future non-empty
// revision requires a governed source change plus release-policy review.
const TRUSTED_OBSERVABILITY_BASELINE_PRODUCERS_V1: readonly Readonly<{
  producerIdentity: string;
  workflowPath: string;
  oidcIssuer: 'https://token.actions.githubusercontent.com';
  sourceIdentityDigest: `sha256:${string}`;
  attestationDigest: `sha256:${string}`;
  attestationSubjectDigest: `sha256:${string}`;
  retainedLedgerDigest: `sha256:${string}`;
  rebuildDigest: `sha256:${string}`;
  reportDigest: `sha256:${string}`;
}>[] = Object.freeze([]);

export const observabilityBaselineVerificationV1Schema = z
  .object({
    schema: z.literal('ObservabilityBaselineVerificationV1'),
    status: z.enum(['passed', 'blocked']),
    evidenceEligible: z.boolean(),
    sourceIdentityVerified: z.literal(true),
    retainedRebuildVerified: z.literal(true),
    sourceAuthorityConfigured: z.boolean(),
    expectedIdentityDigest: digestSchema,
    retainedLedgerDigest: digestSchema,
    rebuildDigest: digestSchema,
    reportDigest: digestSchema,
    trustRegistryDigest: digestSchema,
    reasonCodes: z.array(z.string().min(1)),
    verificationDigest: digestSchema,
  })
  .strict();

export type ObservabilityBaselineVerificationV1 = z.infer<
  typeof observabilityBaselineVerificationV1Schema
>;

export function verifyObservabilityBaselineReportV1(input: {
  ledger: unknown;
  report: unknown;
  expected: unknown;
}): ObservabilityBaselineVerificationV1 {
  const ledger = verifyObservabilityBaselineLedgerV1(input.ledger);
  const report = observabilityBaselineReportV1Schema.parse(input.report);
  const expected = observabilityBaselineExpectationV1Schema.parse(input.expected);
  assertExpectedIdentity(ledger, expected);

  const rebuiltReport = produceObservabilityBaselineReportV1(ledger);
  if (canonicalJson(report) !== canonicalJson(rebuiltReport)) {
    throw new Error(
      'Observability baseline report does not rebuild exactly from retained metadata.',
    );
  }
  verifyReportDigest(report);

  const sourceIdentityDigest = sha256DomainSeparated(
    'kite.operations.observability-baseline-source-identity.v1',
    canonicalJson(expected.source),
  );
  const authority = TRUSTED_OBSERVABILITY_BASELINE_PRODUCERS_V1.find(
    (candidate) =>
      candidate.producerIdentity === expected.source.producerIdentity &&
      candidate.workflowPath === expected.source.workflowPath &&
      candidate.oidcIssuer === expected.source.oidcIssuer &&
      candidate.sourceIdentityDigest === sourceIdentityDigest &&
      candidate.attestationDigest === expected.source.attestationDigest &&
      candidate.attestationSubjectDigest === expected.source.attestationSubjectDigest &&
      candidate.retainedLedgerDigest === ledger.ledgerDigest &&
      candidate.rebuildDigest === report.rebuild.rebuildDigest &&
      candidate.reportDigest === report.reportDigest,
  );
  const reasonCodes = report.reasonCodes.filter(
    (reason) =>
      reason !== 'source_owned_baseline_authority_unconfigured' &&
      reason !== 'production_attestation_verifier_unconfigured',
  );
  if (!authority) {
    if (TRUSTED_OBSERVABILITY_BASELINE_PRODUCERS_V1.length === 0) {
      reasonCodes.push('source_owned_baseline_authority_unconfigured');
      reasonCodes.push('production_attestation_verifier_unconfigured');
    } else {
      reasonCodes.push('source_owned_baseline_authority_untrusted');
    }
  }
  const evidenceEligible = Boolean(authority) && reasonCodes.length === 0;

  const expectedIdentityDigest = sha256DomainSeparated(
    'kite.operations.observability-baseline-expectation.v1',
    canonicalJson(expected),
  );
  const trustRegistryDigest = sha256DomainSeparated(
    'kite.operations.observability-baseline-trust-registry.v1',
    canonicalJson(TRUSTED_OBSERVABILITY_BASELINE_PRODUCERS_V1),
  );
  const withoutDigest = {
    schema: 'ObservabilityBaselineVerificationV1' as const,
    status: evidenceEligible ? ('passed' as const) : ('blocked' as const),
    evidenceEligible,
    sourceIdentityVerified: true as const,
    retainedRebuildVerified: true as const,
    sourceAuthorityConfigured: TRUSTED_OBSERVABILITY_BASELINE_PRODUCERS_V1.length > 0,
    expectedIdentityDigest,
    retainedLedgerDigest: ledger.ledgerDigest,
    rebuildDigest: report.rebuild.rebuildDigest,
    reportDigest: report.reportDigest,
    trustRegistryDigest,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
  return observabilityBaselineVerificationV1Schema.parse({
    ...withoutDigest,
    verificationDigest: sha256DomainSeparated(
      'kite.operations.observability-baseline-verification.v1',
      canonicalJson(withoutDigest),
    ),
  });
}

function assertExpectedIdentity(
  ledger: ReturnType<typeof verifyObservabilityBaselineLedgerV1>,
  expected: ObservabilityBaselineExpectationV1,
): void {
  for (const field of [
    'canonicalRepository',
    'repositoryId',
    'commit',
    'payloadSha256',
    'canonicalManifestDigest',
    'behaviorDigest',
    'profileDigest',
    'gatePolicyDigest',
  ] as const) {
    if (ledger.artifactIdentity[field] !== expected.artifactIdentity[field]) {
      throw new Error(`Observability baseline artifact identity mismatch: ${field}.`);
    }
  }
  for (const field of ['schema', 'routeAlias', 'routeDigest', 'providerRouteDigest'] as const) {
    if (ledger.routeIdentity[field] !== expected.routeIdentity[field]) {
      throw new Error(`Observability baseline route identity mismatch: ${field}.`);
    }
  }
  for (const field of [
    'schema',
    'policyId',
    'revision',
    'policyDigest',
    'owner',
    'minimumSamples',
    'minimumObservationWindowSeconds',
    'approvedAt',
  ] as const) {
    if (ledger.policyIdentity[field] !== expected.policyIdentity[field]) {
      throw new Error(`Observability baseline policy identity mismatch: ${field}.`);
    }
  }
  for (const field of [
    'schema',
    'repository',
    'repositoryId',
    'headSha',
    'ref',
    'workflowPath',
    'workflowRef',
    'workflowSha',
    'runId',
    'runAttempt',
    'jobName',
    'jobId',
    'retainedArtifactName',
    'retainedArtifactId',
    'retainedArtifactDigest',
    'oidcIssuer',
    'producerIdentity',
    'attestationDigest',
    'attestationSubjectDigest',
  ] as const) {
    if (ledger.source[field] !== expected.source[field]) {
      throw new Error(`Observability baseline source identity mismatch: ${field}.`);
    }
  }
}

function verifyReportDigest(report: ObservabilityBaselineReportV1): void {
  const { reportDigest, ...material } = report;
  const expectedDigest = sha256DomainSeparated(
    'kite.operations.observability-baseline-report.v1',
    canonicalJson(material),
  );
  if (reportDigest !== expectedDigest) {
    throw new Error('Observability baseline report digest mismatch.');
  }
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

if (import.meta.main) {
  const args = readArgs(process.argv.slice(2));
  const ledger = parseCanonicalJson(readFileSync(resolve(required(args, 'ledger'))));
  const report = parseCanonicalJson(readFileSync(resolve(required(args, 'report'))));
  const expected = parseCanonicalJson(readFileSync(resolve(required(args, 'expected'))));
  const verification = verifyObservabilityBaselineReportV1({ ledger, report, expected });
  writeFileSync(resolve(required(args, 'output')), canonicalJsonBytes(verification));
  process.stdout.write(`${JSON.stringify(verification)}\n`);
}
