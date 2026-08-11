import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const inputPath = process.argv[2];
if (!inputPath)
  throw new Error('Usage: verify-progressive-context-qualification.ts <artifact.json>');
const artifact = JSON.parse(readFileSync(resolve(inputPath), 'utf8')) as Record<string, unknown>;
const { producerDigest, ...body } = artifact;
const expectedDigest = createHash('sha256')
  .update('progressive-context-qualification:v1\0')
  .update(JSON.stringify(body))
  .digest('hex');
if (producerDigest !== expectedDigest) throw new Error('Qualification producer digest mismatch.');
const semantic = body.semantic as Record<string, unknown>;
const artifactPerformance = body.performance as Record<string, unknown>;
const replayDirectory = mkdtempSync(join(tmpdir(), 'openpx-context-qualification-verifier-'));
const replayPath = join(replayDirectory, 'replayed.json');
let replay: Record<string, unknown>;
try {
  const producerPath = resolve(
    dirname(import.meta.path),
    'produce-progressive-context-qualification.ts',
  );
  const result = Bun.spawnSync(['bun', 'run', producerPath, replayPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Qualification replay failed: ${result.stderr.toString()}`);
  }
  replay = JSON.parse(readFileSync(replayPath, 'utf8')) as Record<string, unknown>;
} finally {
  rmSync(replayDirectory, { recursive: true, force: true });
}
const replayBody = { ...replay };
delete replayBody.producerDigest;
const replaySemantic = replayBody.semantic as Record<string, unknown>;
const performance = replayBody.performance as Record<string, unknown>;
const failures: string[] = [];
const fixtures = Array.isArray(semantic.fixtures)
  ? (semantic.fixtures as Array<Record<string, unknown>>)
  : [];
const mandatoryCount = fixtures.reduce((sum, item) => sum + Number(item.mandatoryCount), 0);
const retainedCount = fixtures.reduce((sum, item) => sum + Number(item.retainedCount), 0);
const continuationSuccess = fixtures.filter(
  (item) =>
    item.continuationSucceeded === true &&
    item.providerCallCount === 1 &&
    typeof item.providerInputDigest === 'string' &&
    typeof item.providerOutputDigest === 'string' &&
    item.compactAnswerDigest === item.expectedAnswerDigest,
).length;
const rawSuccess = fixtures.filter(
  (item) =>
    item.rawBaselineSucceeded === true && item.rawAnswerDigest === item.expectedAnswerDigest,
).length;
const mandatoryRetentionPercent = (retainedCount / mandatoryCount) * 100;
const continuationSuccessPercent = (continuationSuccess / fixtures.length) * 100;
const rawBaselineSuccessPercent = (rawSuccess / fixtures.length) * 100;
const relativeSuccessDeltaPercentagePoints =
  ((continuationSuccess - rawSuccess) / fixtures.length) * 100;
const samples = performance.samples as
  | { prepareMs?: unknown; restoreProofMs?: unknown; rssDeltaMiB?: unknown }
  | undefined;
const numericSamples = (value: unknown): number[] =>
  Array.isArray(value) && value.every((item) => Number.isFinite(item)) ? (value as number[]) : [];
const percentile = (values: number[], ratio: number): number =>
  [...values].sort((left, right) => left - right)[
    Math.max(0, Math.ceil(values.length * ratio) - 1)
  ] ?? Number.POSITIVE_INFINITY;
const prepareSamples = numericSamples(samples?.prepareMs);
const restoreSamples = numericSamples(samples?.restoreProofMs);
const rssSamples = numericSamples(samples?.rssDeltaMiB);
if (body.schemaVersion !== 1 || body.gate !== 'PSMC-06') failures.push('schema_or_gate');
if (JSON.stringify(semantic) !== JSON.stringify(replaySemantic)) failures.push('semantic_replay');
if (
  artifactPerformance.blockCount !== performance.blockCount ||
  artifactPerformance.transcriptUtf8Bytes !== performance.transcriptUtf8Bytes
)
  failures.push('performance_fixture_replay');
if (
  body.fixtureCount !== 20 ||
  fixtures.length !== 20 ||
  new Set(fixtures.map((item) => item.id)).size !== 20
)
  failures.push('fixture_count');
if (
  mandatoryRetentionPercent !== 100 ||
  semantic.mandatoryRetentionPercent !== mandatoryRetentionPercent
)
  failures.push('mandatory_retention');
if (
  continuationSuccessPercent < 95 ||
  semantic.continuationSuccessPercent !== continuationSuccessPercent
)
  failures.push('continuation_success');
if (semantic.rawBaselineSuccessPercent !== rawBaselineSuccessPercent)
  failures.push('raw_baseline_success');
if (
  relativeSuccessDeltaPercentagePoints < -2 ||
  semantic.relativeSuccessDeltaPercentagePoints !== relativeSuccessDeltaPercentagePoints
)
  failures.push('raw_baseline_delta');
if (performance.blockCount !== 2_000) failures.push('performance_block_count');
if (Number(performance.transcriptUtf8Bytes) < 8 * 1024 * 1024) failures.push('performance_bytes');
if (
  prepareSamples.length !== 20 ||
  percentile(prepareSamples, 0.95) !== performance.prepareP95Ms ||
  Number(performance.prepareP95Ms) > 75
)
  failures.push('prepare_p95');
if (
  restoreSamples.length !== 20 ||
  percentile(restoreSamples, 0.95) !== performance.restoreProofP95Ms ||
  Number(performance.restoreProofP95Ms) > 100
)
  failures.push('restore_p95');
if (
  rssSamples.length !== 20 ||
  Math.max(...rssSamples) !== performance.incrementalPeakRssMiB ||
  Number(performance.incrementalPeakRssMiB) > 96
)
  failures.push('incremental_rss');
if (failures.length > 0)
  throw new Error(`Progressive context qualification failed: ${failures.join(', ')}`);
console.log(
  JSON.stringify({
    verified: true,
    producerDigest,
    replayProducerDigest: replay.producerDigest,
    semantic,
    performance,
  }),
);
