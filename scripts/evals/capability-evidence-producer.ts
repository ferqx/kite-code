import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../release/canonical-json';
import { releaseArtifactIdentityV1Schema } from '../release/evidence-schema';
import {
  type CapabilityEvaluationCapabilityV1,
  type CapabilityEvaluationEvidenceV1,
  type CapabilityEvaluationSourceV1,
  capabilityEvaluationCapabilityV1Schema,
  capabilityEvaluationEvidenceV1Schema,
  capabilityEvaluationRetainedReceiptV1Schema,
  capabilityEvaluationSourceV1Schema,
  capabilityEvaluatorIdentityV1Schema,
  computeCapabilityArtifactIdentityDigestV1,
  computeCapabilityEvaluationBundleDigestV1,
  computeCapabilityEvaluationLedgerDigestV1,
  computeCapabilityEvaluationReceiptDigestV1,
  computeCapabilityEvaluationSourceDigestV1,
  computeCapabilityEvaluatorIdentityDigestV1,
  verifyCapabilityEvaluationEvidenceV1,
} from './contracts/capability-evaluation-evidence';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });

const rawCaseSchema = z
  .object({
    receiptId: z.string().min(1).max(256),
    caseId: z.string().min(1).max(256),
    outcome: z.enum(['passed', 'failed', 'inconclusive']),
    observedResultDigest: digestSchema,
    safety: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .strict();

export const capabilityEvaluationRetainedInputV1Schema = z
  .object({
    schema: z.literal('CapabilityEvaluationRetainedInputV1'),
    executionClass: z.enum(['contract_conformance', 'production_route_run']),
    capability: capabilityEvaluationCapabilityV1Schema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeDigest: digestSchema,
    profileDigest: digestSchema,
    evaluatorIdentity: capabilityEvaluatorIdentityV1Schema,
    freshnessSeconds: z.number().int().positive().max(2_592_000),
    cases: z.array(rawCaseSchema).min(1).max(4096),
  })
  .strict()
  .superRefine((input, context) => {
    if (Date.parse(input.endedAt) < Date.parse(input.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'endedAt precedes startedAt.',
      });
    }
    if (input.artifactIdentity.profileDigest !== input.profileDigest) {
      context.addIssue({
        code: 'custom',
        path: ['profileDigest'],
        message: 'Profile digest must match the release artifact identity.',
      });
    }
  });

export type CapabilityEvaluationRetainedInputV1 = z.infer<
  typeof capabilityEvaluationRetainedInputV1Schema
>;

export function createCapabilityContractInputV1(input: {
  capability: CapabilityEvaluationCapabilityV1;
  repository: string;
  repositoryId: string;
  headSha: string;
  startedAt: string;
}): CapabilityEvaluationRetainedInputV1 {
  const startedAt = timestampSchema.parse(input.startedAt);
  const profileDigest = digest(`profile:${input.capability}`);
  return capabilityEvaluationRetainedInputV1Schema.parse({
    schema: 'CapabilityEvaluationRetainedInputV1',
    executionClass: 'contract_conformance',
    capability: input.capability,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
    artifactIdentity: {
      canonicalRepository: input.repository,
      repositoryId: input.repositoryId,
      commit: input.headSha,
      payloadSha256: digest('payload'),
      canonicalManifestDigest: digest('manifest'),
      behaviorDigest: digest('behavior'),
      profileDigest,
      gatePolicyDigest: digest('gate-policy'),
    },
    routeDigest: digest(`route:${input.capability}`),
    profileDigest,
    evaluatorIdentity: {
      schema: 'CapabilityEvaluatorIdentityV1',
      evaluatorIdentity: `contract:${input.capability}`,
      evaluatorRouteDigest: digest('evaluator-route'),
      evaluatorConfigDigest: digest('evaluator-config'),
      rubricDigest: digest(`rubric:${input.capability}`),
      verifierRevision: 'capability-evidence-verifier-v1',
    },
    freshnessSeconds: 86_400,
    cases: [
      {
        receiptId: `contract-${input.capability}-1`,
        caseId: `contract-${input.capability}-1`,
        outcome: 'passed',
        observedResultDigest: digest(`result:${input.capability}`),
        safety: emptySafety(input.capability),
      },
    ],
  });
}

export function produceUnsignedCapabilityEvidenceV1(input: {
  retainedInput: unknown;
  source: unknown;
}): CapabilityEvaluationEvidenceV1 {
  const retained = capabilityEvaluationRetainedInputV1Schema.parse(input.retainedInput);
  const source = capabilityEvaluationSourceV1Schema.parse(input.source);
  if (
    source.startedAt !== retained.startedAt ||
    source.endedAt !== retained.endedAt ||
    source.headSha !== retained.artifactIdentity.commit ||
    source.canonicalRepository !== retained.artifactIdentity.canonicalRepository ||
    source.repositoryId !== retained.artifactIdentity.repositoryId
  ) {
    throw new Error('Capability retained input is not bound to the expected workflow source.');
  }
  const sourceDigest = computeCapabilityEvaluationSourceDigestV1(source);
  const artifactIdentityDigest = computeCapabilityArtifactIdentityDigestV1(
    retained.artifactIdentity,
  );
  const evaluatorIdentityDigest = computeCapabilityEvaluatorIdentityDigestV1(
    retained.evaluatorIdentity,
  );
  let previousReceiptDigest: `sha256:${string}` | null = null;
  const receipts = retained.cases.map((entry, index) => {
    const material = {
      schema: 'CapabilityEvaluationRetainedReceiptV1' as const,
      sequence: index + 1,
      receiptId: entry.receiptId,
      caseId: entry.caseId,
      retained: true as const,
      outcome: entry.outcome,
      artifactIdentityDigest,
      routeDigest: retained.routeDigest,
      profileDigest: retained.profileDigest,
      evaluatorIdentityDigest,
      sourceDigest,
      observedResultDigest: entry.observedResultDigest,
      previousReceiptDigest,
      capability: retained.capability,
      safety: exactSafety(retained.capability, entry.safety),
    };
    const parsedMaterial = capabilityEvaluationRetainedReceiptV1Schema.parse({
      ...material,
      receiptDigest: `sha256:${'0'.repeat(64)}`,
    });
    const { receiptDigest: _placeholder, ...typedMaterial } = parsedMaterial;
    const receipt = capabilityEvaluationRetainedReceiptV1Schema.parse({
      ...typedMaterial,
      receiptDigest: computeCapabilityEvaluationReceiptDigestV1(typedMaterial),
    });
    previousReceiptDigest = receipt.receiptDigest as `sha256:${string}`;
    return receipt;
  });
  const bundleMaterial = {
    schema: 'CapabilityEvaluationEvidenceV1' as const,
    executionClass: retained.executionClass,
    capability: retained.capability,
    source,
    artifactIdentity: retained.artifactIdentity,
    routeDigest: retained.routeDigest,
    profileDigest: retained.profileDigest,
    evaluatorIdentity: retained.evaluatorIdentity,
    receipts,
    receiptLedgerDigest: computeCapabilityEvaluationLedgerDigestV1(receipts),
    observedAt: retained.endedAt,
    freshnessSeconds: retained.freshnessSeconds,
    expiresAt: new Date(
      Date.parse(retained.endedAt) + retained.freshnessSeconds * 1_000,
    ).toISOString(),
  };
  const evidence = capabilityEvaluationEvidenceV1Schema.parse({
    ...bundleMaterial,
    bundleDigest: computeCapabilityEvaluationBundleDigestV1(bundleMaterial),
    authentication: {
      kind: 'unconfigured',
      algorithm: 'none',
      reason: 'production_oidc_sigstore_authority_unconfigured',
    },
  });
  verifyCapabilityEvaluationEvidenceV1(evidence, {
    capability: evidence.capability,
    source,
    artifactIdentity: evidence.artifactIdentity,
    routeDigest: evidence.routeDigest as `sha256:${string}`,
    profileDigest: evidence.profileDigest as `sha256:${string}`,
    evaluatorIdentityDigest,
    freshnessSeconds: evidence.freshnessSeconds,
    now: evidence.observedAt,
  });
  return evidence;
}

function emptySafety(capability: CapabilityEvaluationCapabilityV1): Record<string, number> {
  if (capability === 'verification') {
    return {
      falsePass: 0,
      requiredVerificationBypass: 0,
      fabricatedEvidence: 0,
      unknownEffectResolvedAsSuccess: 0,
    };
  }
  if (capability === 'mcp_write') {
    return {
      falseCompletion: 0,
      duplicateEffect: 0,
      unauthorizedEffect: 0,
      dataBoundaryViolation: 0,
      unknownEffectResolvedAsSuccess: 0,
    };
  }
  return {
    falseCompletion: 0,
    maliciousInstructionAccepted: 0,
    invalidShadowingAccepted: 0,
    dependencyRevisionDrift: 0,
    referenceBoundaryViolation: 0,
    duplicateEffect: 0,
    unknownEffectResolvedAsSuccess: 0,
  };
}

function exactSafety(
  capability: CapabilityEvaluationCapabilityV1,
  safety: Record<string, number>,
): Record<string, number> {
  const expected = emptySafety(capability);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(safety).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw new Error('Capability safety counters have missing or unknown fields.');
  }
  return { ...safety };
}

function digest(label: string): `sha256:${string}` {
  return sha256DomainSeparated('kite.evals.capability-contract-conformance.v1', label);
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

function sourceFromArgs(
  args: Map<string, string>,
  retained: CapabilityEvaluationRetainedInputV1,
): CapabilityEvaluationSourceV1 {
  return capabilityEvaluationSourceV1Schema.parse({
    schema: 'CapabilityEvaluationSourceV1',
    canonicalRepository: required(args, 'repository'),
    repositoryId: required(args, 'repository-id'),
    headSha: required(args, 'head-sha'),
    ref: required(args, 'ref'),
    workflowPath: required(args, 'workflow-path'),
    workflowRef: required(args, 'workflow-ref'),
    workflowSha: required(args, 'workflow-sha'),
    runId: required(args, 'run-id'),
    runAttempt: Number(required(args, 'run-attempt')),
    job: required(args, 'job'),
    retainedArtifactId: required(args, 'artifact-id'),
    retainedArtifactName: required(args, 'artifact-name'),
    startedAt: retained.startedAt,
    endedAt: retained.endedAt,
  });
}

if (import.meta.main) {
  const args = readArgs(process.argv.slice(2));
  const mode = required(args, 'mode');
  if (mode === 'contract-input') {
    const output = createCapabilityContractInputV1({
      capability: capabilityEvaluationCapabilityV1Schema.parse(required(args, 'capability')),
      repository: required(args, 'repository'),
      repositoryId: required(args, 'repository-id'),
      headSha: required(args, 'head-sha'),
      startedAt: required(args, 'started-at'),
    });
    writeFileSync(resolve(required(args, 'output')), canonicalJsonBytes(output));
  } else if (mode === 'produce') {
    const retained = capabilityEvaluationRetainedInputV1Schema.parse(
      parseCanonicalJson(readFileSync(resolve(required(args, 'input')))),
    );
    const output = produceUnsignedCapabilityEvidenceV1({
      retainedInput: retained,
      source: sourceFromArgs(args, retained),
    });
    writeFileSync(resolve(required(args, 'output')), canonicalJsonBytes(output));
  } else {
    throw new Error(`Unsupported --mode=${mode}.`);
  }
}
