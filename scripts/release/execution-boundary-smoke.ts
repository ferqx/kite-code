import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SUPPORTED_PRODUCTION_EXECUTION_TARGETS_ } from '#kite-service/config/release-profile';
import { verifyBootstrapArtifact } from './bootstrap-verifier';
import { canonicalJsonBytes, sha256DomainSeparated } from './canonical-json';

const ADVERSARIAL_CASES = [
  [
    'filesystem_symlink_and_path_traversal',
    'apps/kite-service/test/policies/protected-path.test.ts',
  ],
  [
    'network_dns_redirect_and_private_destination',
    'apps/kite-service/test/sandbox/network-boundary.test.ts',
  ],
  [
    'network_parallel_receipt_isolation',
    'apps/kite-service/test/sandbox/network-boundary-concurrency.test.ts',
  ],
  [
    'mcp_transport_receipt_and_revision_isolation',
    'tests/integration/builtin-runtime/mcp-transport-boundary.test.ts',
  ],
  [
    'mcp_parallel_sibling_isolation',
    'packages/builtin-runtime/test/mcp-transport-boundary-concurrency.test.ts',
  ],
  [
    'process_tree_hard_limit_and_orphan_cleanup',
    'tests/qualification/sandbox/process-tree-limit.test.ts',
  ],
  [
    'sandbox_missing_fail_closed',
    'apps/kite-service/test/isolated/sandbox/execution-boundary.test.ts',
  ],
  [
    'worktree_collision_ownership_and_cleanup',
    'tests/isolated/workspace/worktree-controller.test.ts',
  ],
] as const;

interface SupportMatrix {
  version: 1;
  decisionId: 'D-04';
  status: 'accepted_empty_support_set';
  productionSupportedPlatforms: string[];
  targets: Array<{
    runner: string;
    candidateBackend: string;
    currentOutcome: 'excluded';
    reason: string;
  }>;
}

export interface ExecutionBoundarySmokeReport {
  schema: 'ExecutionBoundaryArtifactSmoke';
  artifactClass: 'synthetic_non_production';
  status: 'passed_negative_conformance';
  productionSupported: false;
  supportedCombinationCount: 0;
  excludedTargets: Array<{
    runner: string;
    backend: string;
    outcome: 'excluded';
    reason: string;
  }>;
  adversarialCases: Array<{
    caseId: string;
    sourceTest: string;
    outcome: 'excluded_not_admitted';
  }>;
  artifactIdentity: {
    payloadSha256: string;
    canonicalManifestDigest: string;
    distributable: false;
    realSigstoreSigningEnabled: false;
  };
  reportDigest: string;
}

export function runExecutionBoundaryArtifactSmoke(input: {
  artifactDirectory: string;
  supportMatrix: unknown;
  repositoryRoot?: string;
}): ExecutionBoundarySmokeReport {
  const matrix = parseSupportMatrix(input.supportMatrix);
  if (SUPPORTED_PRODUCTION_EXECUTION_TARGETS_.length !== 0) {
    throw new Error('Core D-04 execution registry diverges from the accepted empty support set.');
  }
  const root = resolve(input.repositoryRoot ?? '.');
  const adversarialCases = ADVERSARIAL_CASES.map(([caseId, sourceTest]) => {
    if (!existsSync(resolve(root, sourceTest))) {
      throw new Error(`Missing adversarial conformance source: ${sourceTest}.`);
    }
    return { caseId, sourceTest, outcome: 'excluded_not_admitted' as const };
  });
  const artifact = verifyBootstrapArtifact(input.artifactDirectory);
  const material = {
    schema: 'ExecutionBoundaryArtifactSmoke' as const,
    artifactClass: 'synthetic_non_production' as const,
    status: 'passed_negative_conformance' as const,
    productionSupported: false as const,
    supportedCombinationCount: 0 as const,
    excludedTargets: matrix.targets.map((target) => ({
      runner: target.runner,
      backend: target.candidateBackend,
      outcome: target.currentOutcome,
      reason: target.reason,
    })),
    adversarialCases,
    artifactIdentity: {
      payloadSha256: artifact.manifest.payloadSha256,
      canonicalManifestDigest: artifact.signature.manifestSha256,
      distributable: false as const,
      realSigstoreSigningEnabled: false as const,
    },
  };
  return {
    ...material,
    reportDigest: sha256DomainSeparated(
      'execution-boundary-artifact-smoke-v1',
      canonicalJsonBytes(material),
    ),
  };
}

export function verifyExecutionBoundarySmokeReport(
  value: ExecutionBoundarySmokeReport,
): ExecutionBoundarySmokeReport {
  const { reportDigest, ...material } = value;
  const expected = sha256DomainSeparated(
    'execution-boundary-artifact-smoke-v1',
    canonicalJsonBytes(material),
  );
  if (reportDigest !== expected)
    throw new Error('Execution boundary smoke report digest mismatch.');
  if (
    value.productionSupported ||
    value.supportedCombinationCount !== 0 ||
    value.artifactIdentity.distributable ||
    value.artifactIdentity.realSigstoreSigningEnabled
  ) {
    throw new Error('Negative conformance report cannot claim production support or distribution.');
  }
  return value;
}

function parseSupportMatrix(value: unknown): SupportMatrix {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('D-04 support matrix must be an object.');
  }
  const matrix = value as Partial<SupportMatrix>;
  if (
    matrix.version !== 1 ||
    matrix.decisionId !== 'D-04' ||
    matrix.status !== 'accepted_empty_support_set' ||
    !Array.isArray(matrix.productionSupportedPlatforms) ||
    matrix.productionSupportedPlatforms.length !== 0 ||
    !Array.isArray(matrix.targets) ||
    matrix.targets.length !== 3
  ) {
    throw new Error('D-04 support matrix is not the accepted empty support set.');
  }
  for (const target of matrix.targets) {
    if (
      !target ||
      typeof target.runner !== 'string' ||
      typeof target.candidateBackend !== 'string' ||
      target.currentOutcome !== 'excluded' ||
      typeof target.reason !== 'string' ||
      target.reason.length === 0
    ) {
      throw new Error('Every D-04 target must have an explicit excluded outcome and reason.');
    }
  }
  return matrix as SupportMatrix;
}

if (import.meta.main) {
  const artifactDirectory = resolve(process.argv[2] ?? 'dist/release-synthetic');
  const outputPath = resolve(process.argv[3] ?? 'dist/execution-boundary-smoke.json');
  const supportMatrix = JSON.parse(
    readFileSync(resolve('release/platform-capabilities/support-matrix.json'), 'utf8'),
  ) as unknown;
  const report = runExecutionBoundaryArtifactSmoke({ artifactDirectory, supportMatrix });
  writeFileSync(outputPath, canonicalJsonBytes(report), { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: report.status,
        productionSupported: report.productionSupported,
        supportedCombinationCount: report.supportedCombinationCount,
        excludedTargetCount: report.excludedTargets.length,
        adversarialCaseCount: report.adversarialCases.length,
        artifactClass: report.artifactClass,
        reportDigest: report.reportDigest,
        outputPath,
      },
      null,
      2,
    )}\n`,
  );
}
