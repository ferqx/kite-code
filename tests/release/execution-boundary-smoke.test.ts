import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticArtifact } from '../../scripts/release/build-artifact';
import {
  runExecutionBoundaryArtifactSmokeV1,
  verifyExecutionBoundarySmokeReportV1,
} from '../../scripts/release/execution-boundary-smoke';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function matrix(): unknown {
  return JSON.parse(
    readFileSync('release/platform-capabilities/support-matrix-v1.json', 'utf8'),
  ) as unknown;
}

describe('execution boundary artifact smoke', () => {
  test('turns the accepted empty support set into explicit negative conformance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-execution-artifact-smoke-'));
    roots.push(directory);
    buildSyntheticArtifact({ directory });
    const report = runExecutionBoundaryArtifactSmokeV1({
      artifactDirectory: directory,
      supportMatrix: matrix(),
    });
    expect(report.status).toBe('passed_negative_conformance');
    expect(report.productionSupported).toBe(false);
    expect(report.supportedCombinationCount).toBe(0);
    expect(report.excludedTargets).toHaveLength(3);
    expect(report.excludedTargets.every(({ outcome }) => outcome === 'excluded')).toBe(true);
    expect(report.adversarialCases).toHaveLength(8);
    expect(verifyExecutionBoundarySmokeReportV1(structuredClone(report))).toEqual(report);
  });

  test('rejects a matrix that silently adds production support', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-execution-artifact-smoke-'));
    roots.push(directory);
    buildSyntheticArtifact({ directory });
    const widened = matrix() as { productionSupportedPlatforms: string[] };
    widened.productionSupportedPlatforms = ['ubuntu-24.04/bubblewrap'];
    expect(() =>
      runExecutionBoundaryArtifactSmokeV1({
        artifactDirectory: directory,
        supportMatrix: widened,
      }),
    ).toThrow('accepted empty support set');
  });

  test('detects report tampering', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-execution-artifact-smoke-'));
    roots.push(directory);
    buildSyntheticArtifact({ directory });
    const report = runExecutionBoundaryArtifactSmokeV1({
      artifactDirectory: directory,
      supportMatrix: matrix(),
    });
    expect(() =>
      verifyExecutionBoundarySmokeReportV1({
        ...report,
        excludedTargets: report.excludedTargets.slice(1),
      }),
    ).toThrow('digest mismatch');
  });
});
