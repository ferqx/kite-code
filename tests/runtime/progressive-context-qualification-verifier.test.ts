import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function digest(body: unknown): string {
  return createHash('sha256')
    .update('progressive-context-qualification:v1\0')
    .update(JSON.stringify(body))
    .digest('hex');
}

describe('progressive context qualification verifier', () => {
  test('rejects a self-consistent forged artifact instead of trusting its claimed metrics', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-forged-context-qualification-'));
    try {
      const artifactPath = join(directory, 'forged.json');
      const fixtures = Array.from({ length: 20 }, (_, index) => ({
        id: `forged-${index}`,
        mandatoryCount: 1,
        retainedCount: 1,
        providerCallCount: 1,
        providerInputDigest: 'a'.repeat(64),
        providerOutputDigest: 'b'.repeat(64),
        expectedAnswerDigest: 'c'.repeat(64),
        compactAnswerDigest: 'c'.repeat(64),
        rawAnswerDigest: 'c'.repeat(64),
        continuationSucceeded: true,
        rawBaselineSucceeded: true,
      }));
      const body = {
        schemaVersion: 1,
        gate: 'PSMC-06',
        fixtureCount: 20,
        semantic: {
          mandatoryRetentionPercent: 100,
          continuationSuccessPercent: 100,
          rawBaselineSuccessPercent: 100,
          relativeSuccessDeltaPercentagePoints: 0,
          fixtures,
        },
        performance: {
          blockCount: 2_000,
          transcriptUtf8Bytes: 9 * 1024 * 1024,
          prepareP95Ms: 1,
          restoreProofP95Ms: 1,
          incrementalPeakRssMiB: 1,
          samples: {
            prepareMs: Array(20).fill(1),
            restoreProofMs: Array(20).fill(1),
            rssDeltaMiB: Array(20).fill(1),
          },
        },
      };
      writeFileSync(artifactPath, `${JSON.stringify({ ...body, producerDigest: digest(body) })}\n`);
      const verifierPath = resolve(
        process.cwd(),
        'scripts/runtime/verify-progressive-context-qualification.ts',
      );
      const result = Bun.spawnSync(['bun', 'run', verifierPath, artifactPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain('semantic_replay');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
