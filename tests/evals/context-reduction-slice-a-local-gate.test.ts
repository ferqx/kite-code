import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSliceALocalGateEvidenceEnvelopeV1,
  type SliceAEvidenceV1,
  verifySliceALocalGateEvidenceV1,
} from '../../scripts/evals/context-reduction-slice-a-local-gate';

describe('Slice-A local gate evidence', () => {
  let evidence: SliceAEvidenceV1;
  let directory: string;

  beforeAll(() => {
    // Performance production runs only through the isolated Gate command. Unit
    // tests use fixed measurements so the verifier cannot become CPU-contention dependent.
    evidence = createSliceALocalGateEvidenceEnvelopeV1({
      fixture: {
        settledToolBlocks: 2_000,
        eligibleBlocks: 200,
        ineligibleBlocks: 1_800,
        canonicalModelContentUtf8Bytes: 8_390_000,
      },
      measurements: {
        rawBaselineP95Ms: 100,
        offPrepareP95Ms: 100,
        livePrepareP95Ms: 10,
        offRegressionPercent: 0,
        offPeakMemorySamplesBytes: Array.from({ length: 7 }, () => 100_000_000),
        livePeakMemorySamplesBytes: Array.from({ length: 7 }, () => 100_001_024),
        additionalPeakHeapBytes: 1_024,
        primaryCommitMetadataUtf8Bytes: 3_206,
        verifiedTerminalMetadataUtf8Bytes: 984,
        payloadByteMismatchCount: 0,
      },
    });
    directory = mkdtempSync(join(tmpdir(), 'openpx-slice-a-evidence-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test('replays a bounded passing envelope independently of benchmark scheduling', () => {
    expect(evidence.status).toBe('passed');
    expect(verifySliceALocalGateEvidenceV1(structuredClone(evidence))).toEqual(evidence);
    expect(Buffer.byteLength(JSON.stringify(evidence), 'utf8')).toBeLessThan(32 * 1_024);
  });

  test('rejects deterministic measurement tampering, inventory drift, and sensitive fields', () => {
    const tampered = structuredClone(evidence);
    tampered.measurements.livePrepareP95Ms = 51;
    expect(() => verifySliceALocalGateEvidenceV1(tampered)).toThrow('checks do not replay');

    const drifted = structuredClone(evidence);
    drifted.identity.inventoryDigest = '0'.repeat(64);
    expect(() => verifySliceALocalGateEvidenceV1(drifted)).toThrow('Contract inventory drifted');

    const gcDrifted = structuredClone(evidence);
    gcDrifted.identity.gcMode = 'unregistered-gc-protocol';
    expect(() => verifySliceALocalGateEvidenceV1(gcDrifted)).toThrow(
      'Evidence identity does not match',
    );

    const memoryTampered = structuredClone(evidence);
    memoryTampered.measurements.livePeakMemorySamplesBytes[0] = 200_000_000;
    expect(() => verifySliceALocalGateEvidenceV1(memoryTampered)).toThrow('checks do not replay');

    expect(() =>
      verifySliceALocalGateEvidenceV1({
        ...structuredClone(evidence),
        workspacePath: '/secret/workspace',
      }),
    ).toThrow('unknown or missing field');
  });

  test('supports the independent --verify replay command', () => {
    const artifactPath = join(directory, 'evidence.json');
    writeFileSync(artifactPath, `${JSON.stringify(evidence)}\n`, 'utf8');
    const result = Bun.spawnSync(
      [
        process.execPath,
        'run',
        'scripts/evals/context-reduction-slice-a-local-gate.ts',
        '--verify',
        artifactPath,
      ],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"status":"passed"');
  });
});
