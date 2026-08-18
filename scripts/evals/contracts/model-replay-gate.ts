import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { RUNTIME_ID_SOURCE_REVISION_V1 } from '@/core/runtime/id-source';
import { createRuntimeSecretDetectorV1 } from '@/core/session-logger/content-inspector';
import { canonicalJsonBytes, sha256Digest } from '../../release/canonical-json';
import { MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1 } from './model-replay-gate-authority';
import {
  MODEL_REPLAY_PILOT_AUTHORITY_DIGEST_V1,
  MODEL_REPLAY_PILOT_AUTHORITY_V1,
  MODEL_REPLAY_PILOT_CASE_ID_V1,
  MODEL_REPLAY_PILOT_CASSETTE_DIGEST_V1,
  MODEL_REPLAY_PILOT_CLOCK_REVISION_V1,
  MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1,
  MODEL_REPLAY_PILOT_IGNORED_EVENT_FIELDS_V1,
  MODEL_REPLAY_WORKSPACE_NORMALIZER_REVISION_V1,
} from './model-replay-pilot';
import {
  computeModelReplayImportClosureV1,
  MODEL_REPLAY_IMPORT_CLOSURE_ALGORITHM_V1,
  MODEL_REPLAY_IMPORT_CLOSURE_ENTRYPOINTS_V1,
} from './qualification-import-closure';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const relativePathSchema = z
  .string()
  .regex(/^[A-Za-z0-9.][A-Za-z0-9._/-]{0,255}$/u)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'));
const secretDetector = createRuntimeSecretDetectorV1({
  environment: {},
  maxInspectionChars: 4 * 1024 * 1024,
});

export const MODEL_REPLAY_GATE_MANIFEST_SCHEMA_V1 = Object.freeze({
  name: 'kite.model-replay-gate-manifest' as const,
  version: 1 as const,
});
export const MODEL_REPLAY_REQUIRED_SUITE_ID_V1 = 'model-replay-required-suite-v1' as const;
export const MODEL_REPLAY_REQUIRED_SUITE_REVISION_V1 = 1 as const;
export const MODEL_REPLAY_REQUIRED_FIXTURE_DIGEST_V1 =
  'sha256:12fd4637aeac1a441096cdb61468e6085fcffb85d2583e3121b6e0b4cfd07dfd' as const;
export const MODEL_REPLAY_RISK_CATALOG_REVISION_V1 =
  'model-replay-required-risk-catalog-v1' as const;
export const MODEL_REPLAY_RISK_CASSETTE_DIGEST_V1 =
  'sha256:9179260eafa3d75f6a4ddb331bc71cbf5b2785a27b0484f5058e917cb2aeb510' as const;
export const MODEL_REPLAY_RISK_EXPECTED_REPORT_DIGEST_V1 =
  'sha256:066aeb99dddb854f5981c7cc5bea928c78f3c7ae2ef9a68a5babe0c02d6946c3' as const;
export const MODEL_REPLAY_GATE_PRIVACY_POLICY_REVISION_V1 =
  'model-replay-evaluation-policy.rp03.v1' as const;

export const MODEL_REPLAY_RISK_PARENT_ACTOR_V1 = Object.freeze({ kind: 'parent' as const });
export const MODEL_REPLAY_RISK_CONTINUATION_ACTOR_V1 = Object.freeze({
  kind: 'subagent' as const,
  parentToolCallId: 'risk-parent-tool-call',
  subagentId: 'risk-child',
  continuationId: 'risk-continuation-1',
});
export const MODEL_REPLAY_RISK_CASES_V1 = Object.freeze([
  {
    caseId: 'risk.primary-retry-success.v1',
    purpose: 'primary_agent',
    actor: MODEL_REPLAY_RISK_PARENT_ACTOR_V1,
    maxAttempts: 2,
    expected: 'success_after_retry',
  },
  {
    caseId: 'risk.compaction-fatal.v1',
    purpose: 'context_compaction',
    actor: MODEL_REPLAY_RISK_PARENT_ACTOR_V1,
    maxAttempts: 1,
    expected: 'fatal_failure',
  },
  {
    caseId: 'risk.auto-review-aborted.v1',
    purpose: 'auto_review',
    actor: MODEL_REPLAY_RISK_PARENT_ACTOR_V1,
    maxAttempts: 1,
    expected: 'aborted',
  },
  {
    caseId: 'risk.verification-success.v1',
    purpose: 'verification_review',
    actor: MODEL_REPLAY_RISK_PARENT_ACTOR_V1,
    maxAttempts: 1,
    expected: 'success',
  },
  {
    caseId: 'risk.subagent-continuation-success.v1',
    purpose: 'subagent',
    actor: MODEL_REPLAY_RISK_CONTINUATION_ACTOR_V1,
    maxAttempts: 1,
    expected: 'success',
  },
] as const);

export const MODEL_REPLAY_REQUIRED_CASE_IDS_V1 = Object.freeze([
  MODEL_REPLAY_PILOT_CASE_ID_V1,
  ...MODEL_REPLAY_RISK_CASES_V1.map((entry) => entry.caseId),
] as const);

export const MODEL_REPLAY_GATE_RISK_COVERAGE_V1 = Object.freeze({
  actors: ['parent', 'concurrent_sibling', 'continuation_resume'] as const,
  purposes: [
    'primary_agent',
    'context_compaction',
    'auto_review',
    'verification_review',
    'subagent',
  ] as const,
  attempts: ['success', 'retryable_failure', 'fatal_failure', 'aborted'] as const,
  toolExecution: [
    'read_only',
    'workspace_mutation',
    'sandbox_deny',
    'receipt_artifact',
    'unknown_effect_recovery',
  ] as const,
  runtime: [
    'compaction',
    'verification',
    'crash_restore_fork',
    'canonical_terminal_oracle',
  ] as const,
  negative: [
    'miss',
    'out_of_order',
    'digest_mismatch',
    'route_mismatch',
    'owner_mismatch',
    'corruption',
  ] as const,
});

export const MODEL_REPLAY_GATE_G0_V1 = Object.freeze([
  'fixed_suite_fixture_cassette_oracle_catalog_identity',
  'workspace_normalizer',
  'deterministic_clock_id_source',
  'privacy_no_egress',
  'no_credential',
  'no_provider_transport',
  'network_deny',
  'strict_digest_mismatch_fail_closed',
  'assert_consumed',
  'owner_checked_cleanup',
] as const);

export const MODEL_REPLAY_GATE_QUALIFICATION_PATHS_V1 = Object.freeze([
  'package.json',
  'bun.lock',
  '.github/workflows/required.yml',
  'scripts/evals/contracts/model-replay-gate.ts',
  'scripts/evals/contracts/model-replay-pilot.ts',
  'scripts/evals/contracts/qualification-import-closure.ts',
  'scripts/release/canonical-json.ts',
  'scripts/evals/model-replay-gate.ts',
  'scripts/evals/model-replay-subagent-journey.ts',
  'scripts/evals/replay-network-deny.ts',
  'scripts/evals/run-model-replay-required.ts',
  'scripts/evals/run-model-replay-required-isolated.ts',
  'tests/evals/agent-tasks/replay-gate.test.ts',
  'tests/evals/agent-tasks/replay-subagent-journey.test.ts',
  'tests/evals/agent-tasks/replay-pilot.ts',
  'tests/evals/agent-tasks/replay-risk-matrix.ts',
  'tests/model-response-source.test.ts',
  'tests/model-invocation-recovery.test.ts',
  'tests/execution/tool-pipeline-stages.test.ts',
  'tests/runtime/tool-outcome-recovery.test.ts',
  'src/core/model/invocation-gateway.ts',
  'src/core/model/replay-catalog.ts',
  'src/core/model/response-source.ts',
  'src/core/runtime/id-source.ts',
  'src/core/session-logger/content-inspector.ts',
  'src/core/subagent/grant-authority.ts',
  'src/core/subagent/task-tool.ts',
] as const);

export const MODEL_REPLAY_REQUIRED_SUITE_DIGEST_V1 = sha256Digest(
  canonicalJsonBytes({
    suiteId: MODEL_REPLAY_REQUIRED_SUITE_ID_V1,
    suiteRevision: MODEL_REPLAY_REQUIRED_SUITE_REVISION_V1,
    caseIds: MODEL_REPLAY_REQUIRED_CASE_IDS_V1,
  }),
);

export { MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1 } from './model-replay-gate-authority';

const routeBindingSchema = z
  .object({
    label: z.enum(['pilot', 'risk_matrix']),
    routeFingerprint: digestSchema,
    adapterKind: z.literal('openai-compatible'),
    adapterProtocolVersion: z.literal('ai-sdk-language-model-v4'),
    ownerFingerprint: digestSchema,
  })
  .strict();

const manifestSchema = z
  .object({
    schema: z
      .object({ name: z.literal(MODEL_REPLAY_GATE_MANIFEST_SCHEMA_V1.name), version: z.literal(1) })
      .strict(),
    status: z.literal('approved'),
    authority: z
      .object({
        approver: z.literal('github:@ferqx'),
        decision: z.literal('ADR-0112'),
        approvedAt: z.literal('2026-08-16'),
      })
      .strict(),
    suite: z
      .object({
        suiteId: z.literal(MODEL_REPLAY_REQUIRED_SUITE_ID_V1),
        suiteRevision: z.literal(MODEL_REPLAY_REQUIRED_SUITE_REVISION_V1),
        suiteDigest: digestSchema,
        caseIds: z.array(identifierSchema),
      })
      .strict(),
    bindings: z
      .object({
        pilotAuthorityDigest: digestSchema,
        pilotFixtureDigest: digestSchema,
        pilotCassetteDigest: digestSchema,
        pilotOracleDigest: digestSchema,
        pilotCatalogRevision: identifierSchema,
        riskFixtureDigest: digestSchema,
        riskCassetteDigest: digestSchema,
        riskReportDigest: digestSchema,
        riskCatalogRevision: identifierSchema,
        catalogSchemaRevision: z.literal('kite.model-replay-catalog.v1'),
        canonicalizerRevision: z.literal('kite.model-surface.canonical-json.v1'),
        privacyPolicyRevision: z.literal(MODEL_REPLAY_GATE_PRIVACY_POLICY_REVISION_V1),
        workspaceNormalizerRevision: z.literal(MODEL_REPLAY_WORKSPACE_NORMALIZER_REVISION_V1),
        runtimeIdSourceRevision: z.literal(RUNTIME_ID_SOURCE_REVISION_V1),
        clockRevision: z.literal(MODEL_REPLAY_PILOT_CLOCK_REVISION_V1),
        ignoredEventFields: z.array(identifierSchema),
        routes: z.array(routeBindingSchema),
      })
      .strict(),
    riskCoverage: z
      .object({
        actors: z.array(identifierSchema),
        purposes: z.array(identifierSchema),
        attempts: z.array(identifierSchema),
        toolExecution: z.array(identifierSchema),
        runtime: z.array(identifierSchema),
        negative: z.array(identifierSchema),
      })
      .strict(),
    g0: z.array(identifierSchema),
    qualificationFiles: z.array(
      z.object({ path: relativePathSchema, sha256: digestSchema }).strict(),
    ),
    qualificationImportClosure: z
      .object({
        algorithm: z.literal(MODEL_REPLAY_IMPORT_CLOSURE_ALGORITHM_V1),
        entrypoints: z.array(relativePathSchema),
        fileCount: z.number().int().positive().max(1_024),
        digest: digestSchema,
      })
      .strict(),
    gate: z
      .object({
        command: z.literal(
          '/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file run eval:replay:required',
        ),
        requiredWorkflow: z.literal('.github/workflows/required.yml'),
        ciRecord: z.literal(false),
        liveFallback: z.literal(false),
        contentLogged: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type ModelReplayGateManifestV1 = z.infer<typeof manifestSchema>;

export function parseModelReplayGateManifestV1(
  input: string | Uint8Array,
): ModelReplayGateManifestV1 {
  try {
    const text =
      typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    if (secretDetector({ text, provenance: 'model_visible_answer' }).verdict !== 'clear') {
      throw new Error('manifest privacy rejection');
    }
    const manifest = manifestSchema.parse(JSON.parse(text));
    exact(manifest.suite.caseIds, MODEL_REPLAY_REQUIRED_CASE_IDS_V1);
    exact(manifest.riskCoverage, MODEL_REPLAY_GATE_RISK_COVERAGE_V1);
    exact(manifest.g0, MODEL_REPLAY_GATE_G0_V1);
    exact(
      manifest.qualificationFiles.map((entry) => entry.path),
      MODEL_REPLAY_GATE_QUALIFICATION_PATHS_V1,
    );
    exact(
      manifest.qualificationImportClosure.entrypoints,
      MODEL_REPLAY_IMPORT_CLOSURE_ENTRYPOINTS_V1,
    );
    exact(manifest.bindings.ignoredEventFields, MODEL_REPLAY_PILOT_IGNORED_EVENT_FIELDS_V1);
    if (
      manifest.suite.suiteDigest !== MODEL_REPLAY_REQUIRED_SUITE_DIGEST_V1 ||
      manifest.bindings.pilotAuthorityDigest !== MODEL_REPLAY_PILOT_AUTHORITY_DIGEST_V1 ||
      manifest.bindings.pilotFixtureDigest !== MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1 ||
      manifest.bindings.pilotCassetteDigest !== MODEL_REPLAY_PILOT_CASSETTE_DIGEST_V1 ||
      manifest.bindings.pilotOracleDigest !==
        MODEL_REPLAY_PILOT_AUTHORITY_V1.expectedOracleDigest ||
      manifest.bindings.pilotCatalogRevision !== MODEL_REPLAY_PILOT_AUTHORITY_V1.catalogRevision ||
      manifest.bindings.riskFixtureDigest !== MODEL_REPLAY_REQUIRED_FIXTURE_DIGEST_V1 ||
      manifest.bindings.riskCassetteDigest !== MODEL_REPLAY_RISK_CASSETTE_DIGEST_V1 ||
      manifest.bindings.riskReportDigest !== MODEL_REPLAY_RISK_EXPECTED_REPORT_DIGEST_V1 ||
      manifest.bindings.riskCatalogRevision !== MODEL_REPLAY_RISK_CATALOG_REVISION_V1 ||
      sha256Digest(canonicalJsonBytes(manifest)) !== MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1
    ) {
      throw new Error('manifest authority mismatch');
    }
    return deepFreeze(structuredClone(manifest));
  } catch {
    throw new Error('MODEL_REPLAY_GATE_MANIFEST_INVALID');
  }
}

export function verifyModelReplayGateQualificationFilesV1(input: {
  manifest: ModelReplayGateManifestV1;
  repositoryRoot: string;
}): void {
  try {
    const manifest = parseModelReplayGateManifestV1(canonicalJsonBytes(input.manifest));
    for (const entry of manifest.qualificationFiles) {
      const bytes = readFileSync(resolve(input.repositoryRoot, entry.path));
      if (sha256Digest(bytes) !== entry.sha256) throw new Error('qualification digest mismatch');
    }
    const closure = computeModelReplayImportClosureV1({
      repositoryRoot: input.repositoryRoot,
      entrypoints: manifest.qualificationImportClosure.entrypoints,
    });
    if (
      closure.digest !== manifest.qualificationImportClosure.digest ||
      closure.paths.length !== manifest.qualificationImportClosure.fileCount
    ) {
      throw new Error('qualification import closure mismatch');
    }
  } catch {
    throw new Error('MODEL_REPLAY_GATE_QUALIFICATION_INVALID');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function exact(left: unknown, right: unknown): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error('exact binding mismatch');
}
