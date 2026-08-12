import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const outputArgument = process.argv.find((value) => value.startsWith('--artifact='));
const requestedArtifact = outputArgument?.slice('--artifact='.length);
if (outputArgument && !requestedArtifact) throw new Error('--artifact requires a file path.');

const ownedDirectory = requestedArtifact
  ? undefined
  : mkdtempSync(join(tmpdir(), 'openpx-context-qualify-'));
const artifactPath = requestedArtifact
  ? resolve(requestedArtifact)
  : join(ownedDirectory!, 'progressive-context-qualification.json');

function run(script: string): void {
  const result = Bun.spawnSync(['bun', 'run', script, artifactPath], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Context qualification ${script} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
}

try {
  run('scripts/runtime/produce-progressive-context-qualification.ts');
  run('scripts/runtime/verify-progressive-context-qualification.ts');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    gate?: unknown;
    semantic?: Record<string, unknown>;
    performance?: Record<string, unknown>;
  };
  console.log(
    JSON.stringify({
      qualified: true,
      gate: artifact.gate,
      semantic: artifact.semantic
        ? {
            fixtureCount: artifact.semantic.fixtureCount,
            mandatoryRetentionPercent: artifact.semantic.mandatoryRetentionPercent,
            continuationSuccessPercent: artifact.semantic.continuationSuccessPercent,
            rawBaselineSuccessPercent: artifact.semantic.rawBaselineSuccessPercent,
            relativeSuccessDeltaPercentagePoints:
              artifact.semantic.relativeSuccessDeltaPercentagePoints,
          }
        : undefined,
      performance: artifact.performance
        ? {
            blockCount: artifact.performance.blockCount,
            transcriptUtf8Bytes: artifact.performance.transcriptUtf8Bytes,
            prepareP95Ms: artifact.performance.prepareP95Ms,
            restoreProofP95Ms: artifact.performance.restoreProofP95Ms,
            incrementalPeakRssMiB: artifact.performance.incrementalPeakRssMiB,
          }
        : undefined,
      artifact: requestedArtifact ? artifactPath : 'temporary_artifact_removed',
    }),
  );
} finally {
  if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true });
}
