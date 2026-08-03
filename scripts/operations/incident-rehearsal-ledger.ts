import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from '../release/canonical-json';
import { releaseArtifactIdentityV1Schema } from '../release/evidence-schema';
import { INCIDENT_REHEARSAL_SCENARIOS_V1 } from './rehearsal-evidence';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const identitySchema = z.string().trim().min(1).max(256);

export const incidentRehearsalSourceV1Schema = z
  .object({
    schema: z.literal('IncidentRehearsalSourceV1'),
    repository: z.literal('ferqx/kite-code'),
    repositoryId: z.literal('R_kgDOSKbi8g'),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    ref: z.string().startsWith('refs/'),
    workflowPath: z.literal('.github/workflows/incident-rehearsal.yml'),
    workflowRef: identitySchema,
    workflowSha: z.string().regex(/^[a-f0-9]{40}$/),
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    jobName: identitySchema,
    artifactId: z.string().regex(/^[1-9][0-9]*$/),
    artifactName: identitySchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
  })
  .strict()
  .superRefine((source, context) => {
    if (
      source.workflowRef !== `${source.repository}/${source.workflowPath}@${source.ref}` ||
      Date.parse(source.endedAt) < Date.parse(source.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message: 'Incident rehearsal source identity or window is invalid.',
      });
    }
  });

const receiptMaterialV1Schema = z
  .object({
    schema: z.literal('IncidentRehearsalReceiptV1'),
    sequence: z.number().int().positive(),
    scenario: z.enum(INCIDENT_REHEARSAL_SCENARIOS_V1),
    sourceDigest: digestSchema,
    artifactIdentityDigest: digestSchema,
    routeDigest: digestSchema,
    cohortDigest: digestSchema,
    requestedAt: timestampSchema,
    completedAt: timestampSchema,
    outcome: z.enum(['passed', 'failed']),
    actionReceiptDigest: digestSchema,
    staleProcessOrSessionCount: z.number().int().nonnegative(),
    rawContentCollected: z.literal(false),
    previousReceiptDigest: digestSchema.nullable(),
  })
  .strict();

export const incidentRehearsalReceiptV1Schema = receiptMaterialV1Schema.extend({
  receiptDigest: digestSchema,
});
export type IncidentRehearsalReceiptV1 = z.infer<typeof incidentRehearsalReceiptV1Schema>;

export const incidentRehearsalEvidenceV1Schema = z
  .object({
    schema: z.literal('IncidentRehearsalEvidenceV1'),
    executionClass: z.enum(['contract_conformance', 'production_rehearsal']),
    source: incidentRehearsalSourceV1Schema,
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeDigest: digestSchema,
    cohortDigest: digestSchema,
    receipts: z
      .array(incidentRehearsalReceiptV1Schema)
      .length(INCIDENT_REHEARSAL_SCENARIOS_V1.length),
    ledgerDigest: digestSchema,
    bundleDigest: digestSchema,
    authentication: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('unconfigured'),
          subjectDigest: digestSchema,
          reason: z.literal('production_incident_rehearsal_authority_unconfigured'),
        })
        .strict(),
      z
        .object({
          kind: z.literal('github_oidc_sigstore_v1'),
          authorityIdentity: identitySchema,
          verifierIdentity: identitySchema,
          subjectDigest: digestSchema,
          attestationDigest: digestSchema,
          verificationReceiptDigest: digestSchema,
          verifiedAt: timestampSchema,
        })
        .strict(),
    ]),
  })
  .strict();

export type IncidentRehearsalEvidenceV1 = z.infer<typeof incidentRehearsalEvidenceV1Schema>;

export interface IncidentRehearsalAuthorityV1 {
  authorityIdentity: string;
  verifierIdentity: string;
  subjectDigest: `sha256:${string}`;
  attestationDigest: `sha256:${string}`;
  verificationReceiptDigest: `sha256:${string}`;
  verifiedAt: string;
}

export const PRODUCTION_INCIDENT_REHEARSAL_AUTHORITIES_V1: readonly IncidentRehearsalAuthorityV1[] =
  Object.freeze([]);

export function buildIncidentRehearsalReceiptV1(
  rawMaterial: z.infer<typeof receiptMaterialV1Schema>,
): IncidentRehearsalReceiptV1 {
  const material = receiptMaterialV1Schema.parse(rawMaterial);
  return incidentRehearsalReceiptV1Schema.parse({
    ...material,
    receiptDigest: sha256DomainSeparated(
      'kite.operations.incident-rehearsal-receipt.v1',
      canonicalJson(material),
    ),
  });
}

export function computeIncidentRehearsalLedgerDigestV1(
  receipts: readonly IncidentRehearsalReceiptV1[],
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.operations.incident-rehearsal-ledger.v1',
    canonicalJson(receipts),
  );
}

export function computeIncidentRehearsalBundleDigestV1(
  material: Omit<IncidentRehearsalEvidenceV1, 'bundleDigest' | 'authentication'>,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.operations.incident-rehearsal-evidence.v1',
    canonicalJson(material),
  );
}

export function verifyIncidentRehearsalEvidenceV1(input: {
  evidence: unknown;
  expectedSource: z.infer<typeof incidentRehearsalSourceV1Schema>;
  expectedArtifactIdentity: z.infer<typeof releaseArtifactIdentityV1Schema>;
  expectedRouteDigest: `sha256:${string}`;
  expectedCohortDigest: `sha256:${string}`;
}): Readonly<{
  schema: 'IncidentRehearsalEvidenceVerificationV1';
  status: 'passed' | 'blocked' | 'failed';
  evidenceEligible: boolean;
  verifiedScenarioCount: 8;
  ledgerDigest: `sha256:${string}`;
  bundleDigest: `sha256:${string}`;
  reasonCodes: string[];
}> {
  const evidence = incidentRehearsalEvidenceV1Schema.parse(input.evidence);
  if (canonicalJson(evidence.source) !== canonicalJson(input.expectedSource)) {
    throw new Error('Incident rehearsal source identity mismatch.');
  }
  if (canonicalJson(evidence.artifactIdentity) !== canonicalJson(input.expectedArtifactIdentity)) {
    throw new Error('Incident rehearsal artifact identity mismatch.');
  }
  if (
    evidence.routeDigest !== input.expectedRouteDigest ||
    evidence.cohortDigest !== input.expectedCohortDigest
  ) {
    throw new Error('Incident rehearsal route or cohort identity mismatch.');
  }
  const sourceDigest = sha256DomainSeparated(
    'kite.operations.incident-rehearsal-source.v1',
    canonicalJson(evidence.source),
  );
  const artifactIdentityDigest = sha256DomainSeparated(
    'kite.operations.incident-rehearsal-artifact.v1',
    canonicalJson(evidence.artifactIdentity),
  );
  let previous: string | null = null;
  const reasons = new Set<string>();
  for (const [index, receipt] of evidence.receipts.entries()) {
    if (
      receipt.sequence !== index + 1 ||
      receipt.scenario !== INCIDENT_REHEARSAL_SCENARIOS_V1[index] ||
      receipt.previousReceiptDigest !== previous
    ) {
      throw new Error('Incident rehearsal receipt order or chain is invalid.');
    }
    if (
      receipt.sourceDigest !== sourceDigest ||
      receipt.artifactIdentityDigest !== artifactIdentityDigest ||
      receipt.routeDigest !== evidence.routeDigest ||
      receipt.cohortDigest !== evidence.cohortDigest
    ) {
      throw new Error('Incident rehearsal receipt identity mismatch.');
    }
    if (Date.parse(receipt.completedAt) < Date.parse(receipt.requestedAt)) {
      throw new Error('Incident rehearsal receipt window is invalid.');
    }
    const { receiptDigest, ...material } = receipt;
    if (
      receiptDigest !==
      sha256DomainSeparated(
        'kite.operations.incident-rehearsal-receipt.v1',
        canonicalJson(material),
      )
    ) {
      throw new Error('Incident rehearsal receipt digest mismatch.');
    }
    if (receipt.outcome !== 'passed') reasons.add(`scenario_failed:${receipt.scenario}`);
    if (receipt.staleProcessOrSessionCount !== 0) {
      reasons.add(`stale_runtime_state:${receipt.scenario}`);
    }
    previous = receiptDigest;
  }
  if (evidence.ledgerDigest !== computeIncidentRehearsalLedgerDigestV1(evidence.receipts)) {
    throw new Error('Incident rehearsal ledger digest mismatch.');
  }
  const { bundleDigest, authentication, ...material } = evidence;
  if (
    bundleDigest !== computeIncidentRehearsalBundleDigestV1(material) ||
    authentication.subjectDigest !== bundleDigest
  ) {
    throw new Error('Incident rehearsal bundle or authentication subject mismatch.');
  }
  if (evidence.executionClass !== 'production_rehearsal') {
    reasons.add('contract_conformance_not_production');
  }
  const authenticated =
    authentication.kind === 'github_oidc_sigstore_v1' &&
    PRODUCTION_INCIDENT_REHEARSAL_AUTHORITIES_V1.some(
      (authority) =>
        authority.authorityIdentity === authentication.authorityIdentity &&
        authority.verifierIdentity === authentication.verifierIdentity &&
        authority.subjectDigest === authentication.subjectDigest &&
        authority.attestationDigest === authentication.attestationDigest &&
        authority.verificationReceiptDigest === authentication.verificationReceiptDigest &&
        authority.verifiedAt === authentication.verifiedAt,
    );
  if (!authenticated) reasons.add('production_incident_rehearsal_authority_unconfigured');
  const failed = [...reasons].some(
    (reason) => reason.startsWith('scenario_failed:') || reason.startsWith('stale_runtime_state:'),
  );
  const status = failed ? 'failed' : reasons.size === 0 ? 'passed' : 'blocked';
  return Object.freeze({
    schema: 'IncidentRehearsalEvidenceVerificationV1' as const,
    status,
    evidenceEligible: status === 'passed',
    verifiedScenarioCount: 8 as const,
    ledgerDigest: evidence.ledgerDigest as `sha256:${string}`,
    bundleDigest: evidence.bundleDigest as `sha256:${string}`,
    reasonCodes: [...reasons].sort(),
  });
}
