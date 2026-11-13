import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTrajectoryEventId,
  type TrajectoryEvent,
  type TrajectorySnapshot,
} from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import {
  openNativeTrajectoryBundle,
  TrajectoryBundleCleanupError,
  writeNativeTrajectoryBundle,
} from '../../electron/trajectory-bundle';

async function facts() {
  const origin = { storeId: 'original-store', cursor: '9007199254740993' };
  const event: TrajectoryEvent = {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: await createTrajectoryEventId(origin),
    sequence: origin.cursor,
    origin,
    sessionId: 's',
    workspaceId: 'w',
    sourceEventType: 'command.accepted',
    sourceRecordRevision: origin.cursor,
    identityConfidence: 'verified_origin',
    kind: 'command',
    attributes: { commandId: 'c' },
    phase: 'observed',
    recordedStatus: 'accepted',
    occurredAt: 100,
    evidenceRefs: [
      {
        evidenceId: 'material',
        contentVersion: 'v1',
        kind: 'tool_result',
        availability: 'available',
        mediaType: 'text/plain',
      },
    ],
  };
  const integrity = {
    facts: 'complete' as const,
    identityConfidence: 'verified_origin' as const,
    reasons: [],
  };
  const snapshot: TrajectorySnapshot = {
    storeId: 'read-store',
    sessionId: 's',
    upperCursor: origin.cursor,
    formatVersion: 1,
    historyCoverage: {
      enabledAfterCursor: '0',
      upperCursor: origin.cursor,
      status: 'retained',
      integrity,
    },
  };
  return { event, snapshot, integrity };
}
test('single-file Native bundle reads exact sections offline without a Runtime or external source', async () => {
  const root = temporaryDirectory('kite-offline-trajectory-');
  chmodSync(root, 0o700);
  const path = join(root, 'original.kite-trajectory');
  const { event, snapshot, integrity } = await facts();
  let sourceReads = 0;
  try {
    await writeNativeTrajectoryBundle(path, {
      snapshot,
      async readEvents({ limit: _limit, ...request }) {
        sourceReads++;
        return {
          ...request,
          scannedThrough: snapshot.upperCursor,
          exhausted: true,
          events: BigInt(request.afterCursor) < BigInt(event.sequence) ? [event] : [],
          integrity,
        };
      },
      async readEvidence() {
        return new TextEncoder().encode('original material 雪');
      },
    });
    const afterExport = sourceReads;
    const network = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => {
      throw Error('unexpected_network');
    }, {});
    try {
      const opened = await openNativeTrajectoryBundle(path);
      try {
        expect(opened.bundle.offline).toBe(true);
        const page = await opened.bundle.readEvents({
          storeId: snapshot.storeId,
          sessionId: 's',
          afterCursor: '0',
          upperCursor: snapshot.upperCursor,
        });
        expect(page.events).toEqual([event]);
        expect(
          new TextDecoder().decode(
            (await opened.bundle.readEvidence(event.eventId, 'material', 'v1'))!,
          ),
        ).toBe('original material 雪');
        expect(sourceReads).toBe(afterExport);
      } finally {
        await opened.close();
      }
    } finally {
      globalThis.fetch = network;
    }
    expect(
      readFileSync(path).subarray(0, Buffer.byteLength('KITE-TRAJECTORY-BUNDLE 1\n')).toString(),
    ).toBe('KITE-TRAJECTORY-BUNDLE 1\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('Native file wrapper rejects traversal, duplicate paths, truncated frames and changed material bytes', async () => {
  const root = temporaryDirectory('kite-invalid-trajectory-');
  chmodSync(root, 0o700);
  const path = join(root, 'bad.kite-trajectory');
  const prefix = 'KITE-TRAJECTORY-BUNDLE 1\n';
  try {
    for (const bytes of [
      `${prefix}{"path":"../outside","bytes":"0"}\n\n`,
      `${prefix}{"path":"manifest.json","bytes":"0"}\n\n{"path":"manifest.json","bytes":"0"}\n\n`,
      `${prefix}{"path":"manifest.json","bytes":"1000"}\nshort\n`,
    ]) {
      writeFileSync(path, bytes);
      await expect(openNativeTrajectoryBundle(path)).rejects.toThrow();
    }
    const { event, snapshot, integrity } = await facts();
    await writeNativeTrajectoryBundle(path, {
      snapshot,
      async readEvents({ limit: _limit, ...request }) {
        return {
          ...request,
          scannedThrough: snapshot.upperCursor,
          exhausted: true,
          events: [event],
          integrity,
        };
      },
    });
    const bytes = readFileSync(path),
      position = bytes.indexOf(Buffer.from('command.accepted'));
    expect(position).toBeGreaterThan(0);
    bytes[position] = 'x'.charCodeAt(0);
    writeFileSync(path, bytes);
    const opened = await openNativeTrajectoryBundle(path);
    try {
      await expect(
        opened.bundle.readEvents({
          storeId: snapshot.storeId,
          sessionId: 's',
          afterCursor: '0',
          upperCursor: snapshot.upperCursor,
        }),
      ).rejects.toThrow('trajectory_bundle_');
    } finally {
      await opened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed-open cleanup retains the actual file handle when its close is unconfirmed', async () => {
  const root = temporaryDirectory('kite-trajectory-close-');
  const path = join(root, 'invalid.kite-trajectory');
  writeFileSync(path, 'invalid original bytes');
  const probe = await open(path, 'r'),
    prototype = Object.getPrototypeOf(probe);
  const original = prototype.close;
  await probe.close();
  let retained: Awaited<ReturnType<typeof open>> | undefined, caught: unknown;
  prototype.close = function (this: Awaited<ReturnType<typeof open>>) {
    retained = this;
    return Promise.reject(Error('fixture_close_unknown'));
  };
  try {
    await openNativeTrajectoryBundle(path);
  } catch (error) {
    caught = error;
  } finally {
    prototype.close = original;
  }
  try {
    expect(caught).toBeInstanceOf(TrajectoryBundleCleanupError);
    expect((caught as Error).cause).toMatchObject({
      originalError: expect.any(Error),
      cleanupError: expect.any(Error),
      file: retained,
    });
    expect(retained!.fd).toBeGreaterThanOrEqual(0);
    expect((await retained!.stat()).size).toBe(Buffer.byteLength('invalid original bytes'));
  } finally {
    await retained?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
