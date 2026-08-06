import { existsSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { canonicalJsonBytes } from '../../release/canonical-json';
import {
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
  type L2NativeConformanceTargetV1,
} from '../contracts/qualification/l2-native-conformance-schema-v1';
import {
  buildL2NativeConformanceBlockedWorkerTransportV1,
  type L2NativeConformanceBlockedWorkerTransportV1,
} from '../contracts/qualification/l2-native-conformance-worker-record-v1';

/** The protected workflow may write exactly one metadata-only worker file. */
export const L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1 = 'l2-native-worker.json' as const;

export interface L2NativeConformanceGovernancePreflightInputV1 {
  argv: readonly string[];
  workingDirectory?: string;
}

export interface L2NativeConformanceGovernancePreflightResultV1 {
  transport: L2NativeConformanceBlockedWorkerTransportV1;
  outputPath: string;
}

function stableRunnerFailure(reasonCode: string): never {
  throw new Error(reasonCode);
}

function targetForDistributionIdentity(distributionTargetId: string): L2NativeConformanceTargetV1 {
  const target = L2_NATIVE_CONFORMANCE_TARGETS_V1.find(
    (candidate) => candidate.distributionTargetId === distributionTargetId,
  );
  if (!target) stableRunnerFailure('l2_native_runner_unknown_distribution_target');
  return target;
}

function parseGovernancePreflightArgs(argv: readonly string[]): {
  outputName: typeof L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1;
  distributionTargetId: string;
} {
  if (argv.length !== 5 || argv[0] !== '--worker-output' || argv[2] !== '--distribution-target') {
    stableRunnerFailure('l2_native_runner_invalid_arguments');
  }
  if (argv[4] !== '--governance-preflight-only') {
    stableRunnerFailure('l2_native_runner_preflight_mode_required');
  }
  const outputName = argv[1];
  const distributionTargetId = argv[3];
  if (
    outputName !== L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1 ||
    basename(outputName) !== outputName
  ) {
    stableRunnerFailure('l2_native_runner_invalid_worker_output');
  }
  if (!distributionTargetId) stableRunnerFailure('l2_native_runner_unknown_distribution_target');
  return { outputName, distributionTargetId };
}

/**
 * This intentionally stops before any candidate, probe, build, smoke, or
 * child-process operation. The current repository has no auditable atomic
 * protected-CI ledger, maintainer authorization, or protection witness, so
 * this is the only executable production workflow branch.
 */
export function runL2NativeConformanceGovernancePreflightV1(
  input: L2NativeConformanceGovernancePreflightInputV1,
): L2NativeConformanceGovernancePreflightResultV1 {
  const parsed = parseGovernancePreflightArgs(input.argv);
  const target = targetForDistributionIdentity(parsed.distributionTargetId);
  const workingDirectory = resolve(input.workingDirectory ?? process.cwd());
  const outputPath = resolve(workingDirectory, parsed.outputName);
  if (outputPath !== resolve(workingDirectory, L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1)) {
    stableRunnerFailure('l2_native_runner_invalid_worker_output');
  }
  if (existsSync(outputPath)) stableRunnerFailure('l2_native_runner_worker_output_exists');

  const transport = buildL2NativeConformanceBlockedWorkerTransportV1({ target });
  try {
    writeFileSync(outputPath, canonicalJsonBytes(transport), {
      encoding: undefined,
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    // The workflow must never copy a filesystem error or path into its log.
    stableRunnerFailure('l2_native_runner_worker_output_write_failed');
  }
  return { transport, outputPath };
}

function emitCanonicalTransport(transport: L2NativeConformanceBlockedWorkerTransportV1): void {
  process.stdout.write(`${new TextDecoder().decode(canonicalJsonBytes(transport))}\n`);
}

if (import.meta.main) {
  try {
    const result = runL2NativeConformanceGovernancePreflightV1({ argv: process.argv.slice(2) });
    emitCanonicalTransport(result.transport);
  } catch {
    // No path, exception, candidate data, or child output is safe for this workflow log.
    process.exitCode = 1;
  }
}
