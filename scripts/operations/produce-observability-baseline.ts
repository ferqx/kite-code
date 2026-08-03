import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalJson,
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../release/canonical-json';
import { releaseArtifactIdentityV1Schema } from '../release/evidence-schema';
import {
  OBSERVABILITY_BASELINE_METRICS_V1,
  observabilityBaselineG0V1Schema,
  observabilityBaselineGithubSourceV1Schema,
  observabilityBaselinePolicyIdentityV1Schema,
  observabilityBaselineRouteIdentityV1Schema,
  rebuildObservabilityBaselineV1,
  verifyObservabilityBaselineLedgerV1,
} from './observability-baseline-ledger';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rateSchema = z
  .object({
    observedCount: z.number().int().nonnegative(),
    positiveCount: z.number().int().nonnegative(),
    rate: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();
const metricsSchema = z
  .object(
    Object.fromEntries(OBSERVABILITY_BASELINE_METRICS_V1.map((metric) => [metric, rateSchema])) as {
      [Key in (typeof OBSERVABILITY_BASELINE_METRICS_V1)[number]]: typeof rateSchema;
    },
  )
  .strict();
const rebuildSchema = z
  .object({
    schema: z.literal('ObservabilityBaselineRebuildV1'),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    durationSeconds: z.number().int().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
    noData: z.boolean(),
    droppedSampleCount: z.literal(0),
    unknownMetrics: z.array(z.enum(OBSERVABILITY_BASELINE_METRICS_V1)),
    metrics: metricsSchema,
    g0: observabilityBaselineG0V1Schema,
    g1Failures: z.number().int().nonnegative(),
    ledgerDigest: digestSchema,
    rebuildDigest: digestSchema,
  })
  .strict();

export const observabilityBaselineReportV1Schema = z
  .object({
    schema: z.literal('ObservabilityBaselineReportV1'),
    status: z.literal('blocked'),
    baselineState: z.enum(['unknown', 'observed_unqualified']),
    evidenceEligible: z.literal(false),
    sourceAuthority: z.literal('unconfigured'),
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeIdentity: observabilityBaselineRouteIdentityV1Schema,
    policyIdentity: observabilityBaselinePolicyIdentityV1Schema,
    source: observabilityBaselineGithubSourceV1Schema,
    retainedLedgerDigest: digestSchema,
    rebuild: rebuildSchema,
    reasonCodes: z.array(z.string().min(1)),
    reportDigest: digestSchema,
  })
  .strict();

export type ObservabilityBaselineReportV1 = z.infer<typeof observabilityBaselineReportV1Schema>;

/**
 * Rebuilds a production-shaped report from retained metadata only. The local
 * producer deliberately has no authority input and can therefore never mint a
 * production-eligible baseline.
 */
export function produceObservabilityBaselineReportV1(
  rawLedger: unknown,
): ObservabilityBaselineReportV1 {
  const ledger = verifyObservabilityBaselineLedgerV1(rawLedger);
  const rebuild = rebuildObservabilityBaselineV1(ledger);
  const reasons = new Set<string>([
    'source_owned_baseline_authority_unconfigured',
    'production_attestation_verifier_unconfigured',
  ]);
  if (rebuild.noData) reasons.add('no_data');
  if (rebuild.sampleCount < ledger.policyIdentity.minimumSamples) {
    reasons.add('sample_count_insufficient');
  }
  if (rebuild.durationSeconds < ledger.policyIdentity.minimumObservationWindowSeconds) {
    reasons.add('observation_window_insufficient');
  }
  for (const metric of rebuild.unknownMetrics) reasons.add(`metric_unknown:${metric}`);
  if (Object.values(rebuild.g0).some((count) => count !== 0)) reasons.add('g0_observed');
  if (rebuild.g1Failures !== 0) reasons.add('g1_observed');

  const withoutDigest = {
    schema: 'ObservabilityBaselineReportV1' as const,
    status: 'blocked' as const,
    baselineState:
      rebuild.noData || rebuild.unknownMetrics.length > 0
        ? ('unknown' as const)
        : ('observed_unqualified' as const),
    evidenceEligible: false as const,
    sourceAuthority: 'unconfigured' as const,
    artifactIdentity: ledger.artifactIdentity,
    routeIdentity: ledger.routeIdentity,
    policyIdentity: ledger.policyIdentity,
    source: ledger.source,
    retainedLedgerDigest: ledger.ledgerDigest,
    rebuild,
    reasonCodes: [...reasons].sort(compareCodeUnits),
  };
  return observabilityBaselineReportV1Schema.parse({
    ...withoutDigest,
    reportDigest: sha256DomainSeparated(
      'kite.operations.observability-baseline-report.v1',
      canonicalJson(withoutDigest),
    ),
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  const report = produceObservabilityBaselineReportV1(ledger);
  writeFileSync(resolve(required(args, 'output')), canonicalJsonBytes(report));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
