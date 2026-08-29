import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  claimWorkspaceReservation,
  createWorkspaceReservationPort,
  type WorkspaceReservationPort,
} from '../../src/workspace-worker/reservation';
import type { WorkspaceWorkerIdentity } from '../../src/workspace-worker/worker';
import { createNativeWorkspaceOwnerLockPort } from '../../src/workspace-worker/workspace-owner-lock';

const roots: string[] = [];
const WORKSPACE_DIGEST = `sha256:${'a'.repeat(64)}` as const;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('cross-home Workspace reservation', () => {
  test('serializes two explicit Kite homes through one OS-user coordination root', async () => {
    const root = makeRoot('kite-reservation-cross-home-');
    const coordinationHome = createKiteHomeIdentity(join(root, 'coordination'));
    const first = reservationPort(coordinationHome, 'manager-one');
    const second = reservationPort(coordinationHome, 'manager-two');
    const workspace = workspaceIdentity('/workspace/cross-home');

    const reservation = await first.acquire({ workerScopeId: 'scope-one', workspace });
    if (!reservation || 'outcome' in reservation) throw new Error('reservation was not acquired');
    expect(reservation.coordinationHomeRoot).toBe(coordinationHome.root);
    await reservation.prepare({ workerInstanceId: 'worker-one' });
    const child = claimWorkspaceReservation({
      coordinationHome,
      workerScopeId: 'scope-one',
      workspaceDigest: WORKSPACE_DIGEST,
      workerInstanceId: 'worker-one',
      nonce: reservation.nonce,
      workerPid: 1001,
      workerProcessStartIdentity: 'worker-start-one',
    });

    await expect(second.acquire({ workerScopeId: 'scope-two', workspace })).resolves.toEqual({
      outcome: 'unknown',
    });
    await reservation.handoff({
      workerInstanceId: 'worker-one',
      workerPid: 1001,
      workerProcessStartIdentity: 'worker-start-one',
    });
    await child.release();
  });

  test('keeps an unknown launch durable so a new manager cannot replay it', async () => {
    const root = makeRoot('kite-reservation-unknown-');
    const coordinationHome = createKiteHomeIdentity(join(root, 'coordination'));
    const first = reservationPort(coordinationHome, 'manager-one');
    const restarted = reservationPort(coordinationHome, 'manager-two');
    const workspace = workspaceIdentity('/workspace/unknown');

    const reservation = await first.acquire({ workerScopeId: 'scope-unknown', workspace });
    if (!reservation || 'outcome' in reservation) throw new Error('reservation was not acquired');
    await reservation.prepare({ workerInstanceId: 'worker-unknown' });

    await expect(
      restarted.acquire({ workerScopeId: 'scope-unknown-restarted', workspace }),
    ).resolves.toEqual({ outcome: 'unknown' });
    await expect(
      restarted.acquire({ workerScopeId: 'scope-unknown-replayed', workspace }),
    ).resolves.toEqual({ outcome: 'unknown' });
    await reservation.release();
  });

  test('does not clean a PID-reused or uncertain manager reservation', async () => {
    const root = makeRoot('kite-reservation-pid-reuse-');
    const coordinationHome = createKiteHomeIdentity(join(root, 'coordination'));
    const workspace = workspaceIdentity('/workspace/pid-reuse');
    const first = reservationPort(coordinationHome, 'manager-old', (start) =>
      start === 'manager-old' ? 'uncertain' : 'alive',
    );
    const restarted = reservationPort(coordinationHome, 'manager-new', (start) =>
      start === 'manager-old' ? 'uncertain' : 'alive',
    );
    const reservation = await first.acquire({ workerScopeId: 'scope-pid', workspace });
    if (!reservation || 'outcome' in reservation) throw new Error('reservation was not acquired');

    await expect(
      restarted.acquire({ workerScopeId: 'scope-pid-new', workspace }),
    ).resolves.toBeUndefined();
    await reservation.release();
  });

  test('fails closed for symlink and hardlink reservation aliases', async () => {
    const root = makeRoot('kite-reservation-alias-');
    const coordinationHome = createKiteHomeIdentity(join(root, 'coordination'));
    const port = reservationPort(coordinationHome, 'manager-one');
    const workspace = workspaceIdentity('/workspace/aliases');
    const reservation = await port.acquire({ workerScopeId: 'scope-alias', workspace });
    if (!reservation || 'outcome' in reservation) throw new Error('reservation was not acquired');
    await reservation.release();

    const reservationPath = join(
      coordinationHome.root,
      'workspace-reservations',
      'v1',
      `${WORKSPACE_DIGEST.slice('sha256:'.length)}.json`,
    );
    const source = await port.acquire({ workerScopeId: 'scope-alias', workspace });
    if (!source || 'outcome' in source) throw new Error('reservation was not reacquired');
    const hardlink = `${reservationPath}.hardlink`;
    linkSync(reservationPath, hardlink);
    await expect(port.acquire({ workerScopeId: 'scope-alias-2', workspace })).rejects.toThrow(
      /busy or unverifiable/u,
    );
    rmSync(hardlink);
    await source.release();

    const symlink = `${reservationPath}.symlink`;
    symlinkSync(reservationPath, symlink);
    expect(() =>
      claimWorkspaceReservation({
        coordinationHome,
        workerScopeId: 'scope-alias',
        workspaceDigest: WORKSPACE_DIGEST,
        workerInstanceId: 'worker-alias',
        nonce: 'A'.repeat(43),
        workerPid: 1001,
        workerProcessStartIdentity: 'worker-start',
      }),
    ).toThrow();
    rmSync(symlink);
  });

  test('child owner lock claims the exact reservation before Store ownership is released', async () => {
    const root = makeRoot('kite-reservation-child-');
    const coordinationHome = createKiteHomeIdentity(join(root, 'coordination'));
    const port = reservationPort(coordinationHome, 'manager-one', (start) =>
      start === 'worker-start-child' ? 'dead' : 'alive',
    );
    const workspace = workspaceIdentity('/workspace/child');
    const reservation = await port.acquire({ workerScopeId: 'scope-child', workspace });
    if (!reservation || 'outcome' in reservation) throw new Error('reservation was not acquired');
    await reservation.prepare({ workerInstanceId: 'worker-child' });
    const identity = workerIdentity('worker-child');
    const lock = createNativeWorkspaceOwnerLockPort({
      coordinationHome,
      currentProcessIdentity: () => 'worker-start-child',
      processState: () => 'alive',
      childReservation: {
        coordinationHome,
        workerScopeId: 'scope-child',
        workspaceDigest: WORKSPACE_DIGEST,
        workerInstanceId: identity.workerInstanceId,
        nonce: reservation.nonce,
      },
      randomBytes: (size) => new Uint8Array(size).fill(9),
    });
    const ownerLock = await lock.acquire(identity);
    await reservation.handoff({
      workerInstanceId: identity.workerInstanceId,
      workerPid: process.pid,
      workerProcessStartIdentity: 'worker-start-child',
    });
    await ownerLock[Symbol.asyncDispose]();
    await expect(reservation.release()).resolves.toBeUndefined();
    const next = await port.acquire({ workerScopeId: 'scope-child-next', workspace });
    expect(next).not.toBeUndefined();
    if (next && !('outcome' in next)) await next.release();
  });
});

function reservationPort(
  coordinationHome: ReturnType<typeof createKiteHomeIdentity>,
  managerStart: string,
  state: (processStartIdentity: string) => 'alive' | 'dead' | 'uncertain' = () => 'alive',
): WorkspaceReservationPort {
  return createWorkspaceReservationPort({
    coordinationHome,
    currentProcessIdentity: () => managerStart,
    processState: async (_pid, processStartIdentity) => state(processStartIdentity),
    randomBytes: (size) => new Uint8Array(size).fill(7),
  });
}

function workspaceIdentity(path: string) {
  const digest = createHash('sha256').update(path).digest('hex');
  return {
    canonicalPath: path,
    projectId: `project_${digest}`,
    workspaceDigest: WORKSPACE_DIGEST,
  } as const;
}

function workerIdentity(instanceId: string): WorkspaceWorkerIdentity {
  return {
    workerScopeId: 'scope-child',
    workerInstanceId: instanceId,
    buildId: 'build-child',
    workspace: workspaceIdentity('/workspace/child'),
  };
}

function makeRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}
