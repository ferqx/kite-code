import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createTrajectoryEventId,
  type TrajectoryEvent,
  type TrajectorySnapshot,
} from '@kite-ai/trajectory';
import { build as buildFixture } from '../../../scripts/tooling/build';
import { writeNativeTrajectoryBundle } from '../electron/trajectory-bundle';
import { buildNativeDesktop } from '../scripts/build-native';

// Explicit isolated artifact; ordinary clients receive no diagnostic controls or fixture inputs.
const directory = mkdtempSync(resolve(import.meta.dirname, '../../../.cache/trajectory-native-'));
const service = resolve(import.meta.dirname, '../../service/dist/main.js'),
  runtime = realpathSync(process.execPath);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const profile = { dataRoot: join(directory, 'unopened-profile'), profile: 'cold' };
const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
const origin = { storeId: 'original', cursor: '9007199254740993' };
const event: TrajectoryEvent = {
  schema: 'kite.trajectory',
  schemaVersion: 1,
  eventId: await createTrajectoryEventId(origin),
  sequence: origin.cursor,
  origin,
  workspaceId: 'w',
  sessionId: 's',
  executionId: 'model',
  sourceEventType: 'execution.succeeded',
  sourceRecordRevision: origin.cursor,
  occurredAt: 1000,
  recordedStatus: 'succeeded',
  phase: 'completed',
  identityConfidence: 'verified_origin',
  kind: 'model',
  attributes: { definitionId: 'fixture', resultRevision: '1' },
  evidenceRefs: [
    {
      evidenceId: 'body',
      contentVersion: 'v1',
      kind: 'model_output',
      availability: 'available',
      mediaType: 'application/json',
    },
  ],
};
const snapshot: TrajectorySnapshot = {
  storeId: 'restored-read',
  sessionId: 's',
  formatVersion: 1,
  upperCursor: origin.cursor,
  historyCoverage: {
    enabledAfterCursor: '0',
    upperCursor: origin.cursor,
    status: 'retained',
    integrity,
  },
};
const bundle = join(directory, 'original.kite-trajectory');
await writeNativeTrajectoryBundle(bundle, {
  snapshot,
  async readEvents({ limit: _limit, ...request }) {
    return {
      ...request,
      scannedThrough: snapshot.upperCursor,
      exhausted: true,
      events: BigInt(request.afterCursor) < BigInt(event.sequence) ? [event] : [],
      integrity,
    };
  },
  async readEvidence() {
    return Buffer.from(
      JSON.stringify({
        content: 'COLD ORIGINAL MATERIAL 雪\nsecond line',
        reasoning: '',
        toolCalls: [],
      }),
    );
  },
});
const outdir = join(directory, 'app');
await buildNativeDesktop(
  {
    kind: 'development',
    serviceEntrypoint: service,
    serviceSha256: hash(service),
    runtimeExecutable: runtime,
    runtimeSha256: hash(runtime),
    buildId: 'trajectory-native-fixture',
    apiMajor: 1,
    requiredCapabilities: ['trajectory'],
    profile,
  },
  outdir,
);
mkdirSync(join(directory, 'driver'), { mode: 0o700 });
const result = await buildFixture({
  entrypoints: [resolve(import.meta.dirname, 'trajectory-native.fixture.ts')],
  target: 'node',
  packages: 'external',
  outdir: join(directory, 'driver'),
  naming: 'driver.mjs',
});
if (!result.success) throw new AggregateError(result.logs, 'trajectory_driver_build_failed');
writeFileSync(
  join(directory, 'fixture.json'),
  JSON.stringify({
    directory,
    outdir,
    profile,
    bundle,
    driver: join(directory, 'driver/driver.mjs'),
  }),
);
console.log(
  JSON.stringify({
    directory,
    outdir,
    profile,
    bundle,
    driver: join(directory, 'driver/driver.mjs'),
  }),
);
