import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import type { Subprocess } from 'bun';
import {
  KiteSessionRuntimeStorageError,
  openKiteSessionRuntimeStorage,
  openKiteSessionStoreDatabase,
} from '../src';
import { checksum } from '../src/preflight';

type Event = { readonly type: string };
type State = {
  readonly revision: number;
  readonly recoveryIdentity: string;
  readonly session: {
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const STATE_EPOCH = 'test-session-state-v1';
const WORKSPACE_PATH = '/workspace';
const WORKSPACE_PATH_DIGEST = createHash('sha256').update(WORKSPACE_PATH).digest('hex');
const PROJECT_ID = `project_${WORKSPACE_PATH_DIGEST}`;
const WORKSPACE_DIGEST = `sha256:${WORKSPACE_PATH_DIGEST}` as const;
const WORKSPACE_IDENTITY_DIGEST = `sha256:${createHash('sha256')
  .update(
    `kite.workspace-identity.v1\0${JSON.stringify({
      canonicalPath: WORKSPACE_PATH,
      projectId: PROJECT_ID,
      workspaceDigest: WORKSPACE_DIGEST,
    })}`,
  )
  .digest('hex')}` as const;
const WORKSPACE_ID = `workspace_${WORKSPACE_IDENTITY_DIGEST.slice('sha256:'.length)}`;

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <Loaded>(json: string) => JSON.parse(json) as Loaded,
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 1 }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  recoveryIdentity: (state: State) => state.recoveryIdentity,
  rebindForkState: (state: State, _sessionId: string, recoveryIdentity: string) => ({
    ...state,
    recoveryIdentity,
  }),
  isCurrentPendingInteractionRequest: () => false,
};

describe('multi-connection Kite Session Runtime storage', () => {
  test('routes Session writes through an execution scope while reads remain lease-free', async () => {
    const fixture = createFixture(['session-1', 'session-2']);
    const first = openOwner(fixture.path);
    const second = openOwner(fixture.path);
    try {
      expect(first.directory.list()[0]?.sessions).toHaveLength(2);
      expect(() => first.storage.sessions.setSessionName('session-1', 'unfenced')).toThrow(
        KiteSessionRuntimeStorageError,
      );

      const firstAuthority = acquire(first, 'session-1', 'host-1');
      const secondAuthority = acquire(second, 'session-2', 'host-2');
      const firstHandle = first.bindExecution(firstAuthority);
      const secondHandle = second.bindExecution(secondAuthority);

      await Promise.all([
        first.runWithExecution(firstHandle, async () => {
          await Promise.resolve();
          first.storage.sessions.setSessionName('session-1', 'First');
          first.storage.sessions.setSessionModelRoute('session-1', {
            provider: 'provider-1',
            name: 'model-1',
          });
          first.storage.transactions.commitDecision({
            sessionId: 'session-1',
            events: [{ type: 'updated' }],
            metadata: [{ eventId: 'event-1', revision: 1 }],
            snapshot: state(1, 'recovery-1'),
          });
          expect(
            first.storage.recoveryIdentities.getOrCreate('session-1', () => 'a'.repeat(64)),
          ).toBe('a'.repeat(64));
          first.storage.checkpoints.saveNamedSnapshot(
            'session-1',
            'checkpoint-1',
            state(1, 'recovery-1'),
            1,
          );
        }),
        second.runWithExecution(secondHandle, async () => {
          await Promise.resolve();
          second.storage.sessions.setSessionName('session-2', 'Second');
        }),
      ]);

      expect(second.storage.sessions.listSessions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: 'session-1', name: 'First' }),
          expect.objectContaining({ threadId: 'session-2', name: 'Second' }),
        ]),
      );
      expect(firstHandle.snapshot().expectedSessionRevision).toBe(1);
      expect(first.storage.sessions.getSessionModelRoute('session-1')).toEqual({
        provider: 'provider-1',
        name: 'model-1',
      });
      expect(first.storage.checkpoints.listNamedSnapshots('session-1')).toHaveLength(1);
      expect(
        first.runWithExecution(firstHandle, () =>
          first.storage.checkpoints.forkCurrentSession(
            'session-1',
            'invalid-recovery-target',
            'b'.repeat(64),
          ),
        ),
      ).toBe(false);
      expect(() =>
        first.runWithExecution(firstHandle, () =>
          first.artifactStore.collectModelGarbage({
            complete: true,
            reachableArtifactIds: [],
            createdBeforeOrAt: Date.now(),
          }),
        ),
      ).toThrow(KiteSessionRuntimeStorageError);
    } finally {
      first.close();
      second.close();
      fixture.remove();
    }
  });

  test('fences an old connection after clean handoff and removes authority with Session delete', () => {
    const fixture = createFixture(['session-1']);
    const first = openOwner(fixture.path);
    const second = openOwner(fixture.path);
    try {
      const initial = acquire(first, 'session-1', 'host-1');
      const staleHandle = first.bindExecution(initial);
      const released = first.authority.release({
        sessionId: 'session-1',
        expectedRevision: initial.revision,
        controllerGeneration: initial.controllerGeneration,
        hostInstanceId: 'host-1',
        cleanupConfirmed: true,
      });
      const successor = second.authority.acquire({
        sessionId: 'session-1',
        expectedRevision: released.revision,
        hostInstanceId: 'host-2',
        clientId: 'client-host-2',
        connectionGeneration: 1,
        leaseUntilMs: Date.now() + 60_000,
      });
      if (successor.status !== 'acquired') throw new Error('Expected successor authority.');
      const successorHandle = second.bindExecution(successor.authority);

      expect(() =>
        first.runWithExecution(staleHandle, () =>
          first.storage.sessions.setSessionName('session-1', 'stale'),
        ),
      ).toThrow();
      second.runWithExecution(successorHandle, () => {
        second.storage.sessions.setSessionName('session-1', 'successor');
      });
      expect(first.storage.sessions.listSessions()[0]?.name).toBe('successor');
      expect(() => second.runWithExecution(staleHandle, () => undefined)).toThrow(
        KiteSessionRuntimeStorageError,
      );

      second.runWithExecution(successorHandle, () => {
        second.storage.sessions.deleteSession('session-1');
      });
      expect(second.storage.sessions.listSessions()).toEqual([]);
      expect(() => second.authority.read('session-1')).toThrow();
      expect(() => successorHandle.snapshot()).toThrow(KiteSessionRuntimeStorageError);
    } finally {
      first.close();
      second.close();
      fixture.remove();
    }
  });

  test('forks target facts and generation one in the fenced source transaction', () => {
    const fixture = createFixture(['session-1']);
    const owner = openOwner(fixture.path);
    try {
      const sourceAuthority = acquire(owner, 'session-1', 'host-fork');
      const sourceHandle = owner.bindExecution(sourceAuthority);
      owner.runWithExecution(sourceHandle, () => {
        owner.storage.transactions.commitDecision({
          sessionId: 'session-1',
          events: [{ type: 'fork.source' }],
          metadata: [{ eventId: 'fork-event-1', revision: 1 }],
          snapshot: state(1, 'a'.repeat(64)),
        });
        expect(
          owner.storage.recoveryIdentities.getOrCreate('session-1', () => 'a'.repeat(64)),
        ).toBe('a'.repeat(64));
        expect(
          owner.storage.checkpoints.forkCurrentSession('session-1', 'session-fork', 'b'.repeat(64)),
        ).toBe(true);
      });

      const targetAuthority = owner.authority.read('session-fork');
      expect(targetAuthority).toMatchObject({
        status: 'active',
        controllerGeneration: 1,
        hostInstanceId: 'host-fork',
        clientId: 'client-host-fork',
        connectionGeneration: 1,
        leaseUntilMs: sourceAuthority.leaseUntilMs,
      });
      const targetHandle = owner.bindExecution(targetAuthority);
      owner.runWithExecution(targetHandle, () => {
        owner.storage.sessions.setSessionName('session-fork', 'Fork');
      });
      expect(owner.storage.sessions.listSessions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: 'session-fork', name: 'Fork' }),
        ]),
      );
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('rolls back a fork target and its authority when later copy work fails', () => {
    const fixture = createFixture(['session-1']);
    const owner = openOwner(fixture.path, { failHistoricalEncoding: true });
    try {
      const sourceAuthority = acquire(owner, 'session-1', 'host-fork-fault');
      const sourceHandle = owner.bindExecution(sourceAuthority);
      owner.runWithExecution(sourceHandle, () => {
        owner.storage.transactions.commitDecision({
          sessionId: 'session-1',
          events: [{ type: 'fork.source' }],
          metadata: [{ eventId: 'fork-event-fault', revision: 1 }],
          snapshot: state(1, 'c'.repeat(64)),
        });
        expect(
          owner.storage.recoveryIdentities.getOrCreate('session-1', () => 'c'.repeat(64)),
        ).toBe('c'.repeat(64));
        expect(() =>
          owner.storage.checkpoints.forkCurrentSession(
            'session-1',
            'session-fork-fault',
            'd'.repeat(64),
          ),
        ).toThrow();
      });
      expect(owner.storage.sessions.loadSnapshot('session-fork-fault')).toBeNull();
      expect(() => owner.authority.read('session-fork-fault')).toThrow();
    } finally {
      owner.close();
      fixture.remove();
    }
  });

  test('allows real App Server processes to write different Sessions but only one to write the same Session', async () => {
    const different = createFixture(['session-1', 'session-2']);
    const child = join(import.meta.dir, 'fixtures', 'mutate-kite-session-runtime-child.ts');
    try {
      const results = await runMutationChildren(child, different.path, [
        ['session-1', 'host-1', 'First'],
        ['session-2', 'host-2', 'Second'],
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['written', 'written']);
      const reader = openOwner(different.path);
      expect(reader.storage.sessions.listSessions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: 'session-1', name: 'First' }),
          expect.objectContaining({ threadId: 'session-2', name: 'Second' }),
        ]),
      );
      reader.close();
    } finally {
      different.remove();
    }

    const same = createFixture(['session-1']);
    try {
      const results = await runMutationChildren(child, same.path, [
        ['session-1', 'host-1', 'Winner 1'],
        ['session-1', 'host-2', 'Winner 2'],
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        'revision_conflict',
        'written',
      ]);
      const reader = openOwner(same.path);
      expect(reader.storage.sessions.listSessions()[0]?.name).toMatch(/^Winner [12]$/u);
      reader.close();
    } finally {
      same.remove();
    }
  });

  test('deep-validates a concurrent open from one stable SQLite read snapshot', () => {
    const fixture = createFixture(['session-1', 'session-2']);
    const writer = openOwner(fixture.path);
    try {
      const authority = acquire(writer, 'session-2', 'host-validation-writer');
      const handle = writer.bindExecution(authority);
      let mutated = false;
      const reader = openOwner(fixture.path, {
        onSessionIdentity: () => {
          if (mutated) return;
          mutated = true;
          writer.runWithExecution(handle, () => {
            writer.storage.transactions.commitDecision({
              sessionId: 'session-2',
              events: [{ type: 'validation.concurrent' }],
              metadata: [{ eventId: 'validation-event-1', revision: 1 }],
              snapshot: state(1, 'f'.repeat(64)),
            });
          });
        },
      });
      try {
        expect(mutated).toBe(true);
        expect(reader.storage.sessions.loadSnapshot<State>('session-2')?.revision).toBe(1);
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
      fixture.remove();
    }
  });

  test('settles effect receipt in the State transaction and fences release without a receipt as unknown', () => {
    const fixture = createFixture(['session-1']);
    const owner = openOwner(fixture.path);
    try {
      const authority = acquire(owner, 'session-1', 'host-1');
      const handle = owner.bindExecution(authority);
      owner.runWithExecution(handle, () => {
        expect(
          owner.storage.effects.tryAcquireEffectLease(
            'session-1',
            'effect-settled',
            'owner-1',
            Date.now() + 60_000,
          ),
        ).toBe(true);
        owner.storage.transactions.commitReceiptEvidence({
          sessionId: 'session-1',
          events: [{ type: 'effect.settled' }],
          metadata: [{ eventId: 'effect-event-1', revision: 1 }],
          snapshot: state(1, 'recovery-1'),
          requiredEffectLease: {
            effectId: 'effect-settled',
            ownerId: 'owner-1',
            observedAtMs: Date.now(),
          },
        });
        owner.storage.effects.releaseEffectLease('session-1', 'effect-settled', 'owner-1');

        expect(
          owner.storage.effects.tryAcquireEffectLease(
            'session-1',
            'effect-unknown',
            'owner-2',
            Date.now() + 60_000,
          ),
        ).toBe(true);
        expect(() =>
          owner.authority.release({
            sessionId: 'session-1',
            expectedRevision: authority.revision,
            controllerGeneration: authority.controllerGeneration,
            hostInstanceId: 'host-1',
            cleanupConfirmed: true,
          }),
        ).toThrow();
        expect(owner.authority.read('session-1').status).toBe('active');
        owner.storage.effects.releaseEffectLease('session-1', 'effect-unknown', 'owner-2');
      });
      expect(owner.authority.read('session-1')).toMatchObject({
        status: 'recovery_required',
        cleanupConfirmed: false,
      });
    } finally {
      owner.close();
    }

    const database = openKiteSessionStoreDatabase(fixture.path);
    try {
      expect(
        database
          .query<{ state: string; outcome: string }, [string]>(
            'SELECT state, outcome FROM runtime_effect_leases WHERE effect_id = ?',
          )
          .get('effect-settled'),
      ).toEqual({ state: 'terminal', outcome: 'settled' });
      expect(
        database
          .query<{ state: string; outcome: string }, [string]>(
            'SELECT state, outcome FROM runtime_effect_leases WHERE effect_id = ?',
          )
          .get('effect-unknown'),
      ).toEqual({ state: 'unknown', outcome: 'unknown' });
    } finally {
      database.close(false);
      fixture.remove();
    }
  });

  test('reconciles a crashed generation prepared effect as unknown before takeover', () => {
    const fixture = createFixture(['session-1']);
    let now = 100;
    const crashed = openOwner(fixture.path, { now: () => now });
    const initial = crashed.authority.acquire({
      sessionId: 'session-1',
      expectedRevision: 0,
      hostInstanceId: 'host-crashed',
      clientId: 'client-crashed',
      connectionGeneration: 1,
      leaseUntilMs: 200,
    });
    if (initial.status !== 'acquired') throw new Error('Expected initial crash authority.');
    const crashedHandle = crashed.bindExecution(initial.authority);
    crashed.runWithExecution(crashedHandle, () => {
      expect(
        crashed.storage.effects.tryAcquireEffectLease(
          'session-1',
          'effect-crashed',
          'owner-crashed',
          190,
        ),
      ).toBe(true);
    });
    crashed.close();

    now = 201;
    const successor = openOwner(fixture.path, { now: () => now });
    try {
      const blocked = successor.authority.acquire({
        sessionId: 'session-1',
        expectedRevision: initial.authority.revision,
        hostInstanceId: 'host-successor',
        clientId: 'client-successor',
        connectionGeneration: 1,
        leaseUntilMs: 300,
      });
      expect(blocked).toMatchObject({
        status: 'recovery_required',
        authority: { controllerGeneration: 2, revision: 2 },
      });
      if (blocked.status !== 'recovery_required') throw new Error('Expected recovery fence.');
      expect(successor.recovery.inspect('session-1').pendingEffects).toEqual([
        expect.objectContaining({ effectId: 'effect-crashed', state: 'prepared' }),
      ]);

      const reconciled = successor.recovery.reconcile({
        sessionId: 'session-1',
        expectedAuthorityRevision: blocked.authority.revision,
      });
      expect(reconciled).toMatchObject({
        authority: { status: 'idle', controllerGeneration: 3, revision: 3 },
        unknownEffects: [{ effectId: 'effect-crashed', state: 'unknown', outcome: 'unknown' }],
      });
      expect(successor.recovery.inspect('session-1').pendingEffects).toEqual([]);
      expect(
        successor.authority.acquire({
          sessionId: 'session-1',
          expectedRevision: reconciled.authority.revision,
          hostInstanceId: 'host-successor',
          clientId: 'client-successor',
          connectionGeneration: 1,
          leaseUntilMs: 300,
        }),
      ).toMatchObject({
        status: 'acquired',
        authority: { controllerGeneration: 4, revision: 4 },
      });
    } finally {
      successor.close();
      fixture.remove();
    }
  });

  test('persists recovery_required and no-replay evidence after a real SIGKILL', async () => {
    const fixture = createFixture(['session-1']);
    const childPath = join(import.meta.dir, 'fixtures', 'crash-kite-session-effect-child.ts');
    const child = Bun.spawn([process.execPath, childPath, fixture.path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const ready = await readFirstJsonLine<{ readonly leaseUntilMs: number }>(child.stdout);
      child.kill('SIGKILL');
      await child.exited;
      await Bun.sleep(Math.max(0, ready.leaseUntilMs - Date.now() + 20));

      const successor = openOwner(fixture.path);
      try {
        const blocked = successor.authority.acquire({
          sessionId: 'session-1',
          expectedRevision: 1,
          hostInstanceId: 'host-after-sigkill',
          clientId: 'client-after-sigkill',
          connectionGeneration: 1,
          leaseUntilMs: Date.now() + 60_000,
        });
        expect(blocked).toMatchObject({
          status: 'recovery_required',
          authority: { controllerGeneration: 2, revision: 2 },
        });
        if (blocked.status !== 'recovery_required') throw new Error('Expected recovery fence.');
        expect(successor.recovery.inspect('session-1').pendingEffects).toEqual([
          expect.objectContaining({ effectId: 'effect-sigkill', state: 'prepared' }),
        ]);
        successor.recovery.reconcile({
          sessionId: 'session-1',
          expectedAuthorityRevision: blocked.authority.revision,
        });
      } finally {
        successor.close();
      }

      const database = openKiteSessionStoreDatabase(fixture.path);
      try {
        expect(
          database
            .query<{ state: string; outcome: string }, [string]>(
              'SELECT state, outcome FROM runtime_effect_leases WHERE effect_id = ?',
            )
            .get('effect-sigkill'),
        ).toEqual({ state: 'unknown', outcome: 'unknown' });
      } finally {
        database.close(false);
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      fixture.remove();
    }
  });

  test('atomically creates Session facts, recovery identity, command receipt and generation one', () => {
    const fixture = createFixture([]);
    const owner = openOwner(fixture.path);
    try {
      const creation = owner.sessionCreationForWorkspace(WORKSPACE_ID);
      const input = creationInput('created-session', 'a', Date.now() + 60_000);
      expect(creation.create(input)).toMatchObject({
        status: 'applied',
        runtimeReceipt: { committedRevision: 0 },
        controller: {
          status: 'applied',
          lease: { sessionId: 'created-session', controllerGeneration: 1 },
        },
      });
      expect(creation.create(input)).toMatchObject({
        status: 'replay',
        controller: { status: 'replay' },
      });
      const authority = owner.authority.read('created-session');
      expect(authority).toMatchObject({
        status: 'active',
        controllerGeneration: 1,
        hostInstanceId: 'host-create',
      });
      const handle = owner.bindExecution(authority);
      owner.runWithExecution(handle, () => {
        owner.storage.sessions.setSessionName('created-session', 'Created');
      });
      expect(owner.storage.recoveryIdentities.read('created-session')).toBe('e'.repeat(64));

      expect(() =>
        creation.create(creationInput('rollback-session', 'b', Date.now() - 1)),
      ).toThrow();
      expect(owner.storage.sessions.loadSnapshot('rollback-session')).toBeNull();
      expect(() => owner.authority.read('rollback-session')).toThrow();
    } finally {
      owner.close();
      fixture.remove();
    }
  });
});

function openOwner(
  path: string,
  options?: {
    readonly failHistoricalEncoding?: boolean;
    readonly now?: () => number;
    readonly onSessionIdentity?: () => void;
  },
) {
  const selectedCodec = {
    ...codec,
    ...(options?.failHistoricalEncoding
      ? {
          encodeHistoricalEvent: () => {
            throw new Error('injected historical encode fault');
          },
        }
      : {}),
    sessionIdentity: (value: State) => {
      options?.onSessionIdentity?.();
      return codec.sessionIdentity(value);
    },
  };
  return openKiteSessionRuntimeStorage<Event, State>({
    databasePath: path,
    codec: selectedCodec,
    stateSchemaVersion: 1,
    formatEpoch: STATE_EPOCH,
    ...(options?.now ? { now: options.now } : {}),
  });
}

function acquire(owner: ReturnType<typeof openOwner>, sessionId: string, hostInstanceId: string) {
  const result = owner.authority.acquire({
    sessionId,
    expectedRevision: 0,
    hostInstanceId,
    clientId: `client-${hostInstanceId}`,
    connectionGeneration: 1,
    leaseUntilMs: Date.now() + 60_000,
  });
  if (result.status !== 'acquired') throw new Error('Expected Session authority.');
  return result.authority;
}

function state(revision: number, recoveryIdentity: string): State {
  return {
    revision,
    recoveryIdentity,
    session: { projectId: PROJECT_ID, canonicalWorkspaceDigest: WORKSPACE_DIGEST },
  };
}

function creationInput(sessionId: string, digestSeed: string, executionLeaseUntilMs: number) {
  return {
    runtime: {
      sessionId,
      events: [],
      snapshot: state(0, 'e'.repeat(64)),
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: sessionId,
          commandId: `command-${digestSeed}`,
          requestDigest: digestSeed.repeat(64),
          targetSessionId: sessionId,
          committedAt: Date.now(),
        },
        0,
      ),
    },
    controller: {
      sessionId,
      requestId: `controller-${digestSeed}`,
      requestDigest: digestSeed.repeat(64),
      clientId: 'client-create',
      connectionGeneration: 1,
      workerInstanceId: 'host-create',
      resumeSecret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'),
      resumeExpiresAtMs: Date.now() + 60_000,
      executionLeaseUntilMs,
    },
    recoveryIdentity: 'e'.repeat(64),
  } as const;
}

function createFixture(sessionIds: readonly string[]) {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-session-runtime-storage-')),
  );
  const path = join(root, 'kite-session.sqlite');
  const database = openKiteSessionStoreDatabase(path);
  database
    .query(
      `INSERT INTO workspaces(
        workspace_id, canonical_path, workspace_identity_digest, project_id, workspace_digest,
        display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Workspace', 1, 1)`,
    )
    .run(WORKSPACE_ID, WORKSPACE_PATH, WORKSPACE_IDENTITY_DIGEST, PROJECT_ID, WORKSPACE_DIGEST);
  const insertSession = database.query(
    `INSERT INTO runtime_sessions(
      session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
      revision, name, updated_at, run_index_from_revision
    ) VALUES (?, ?, ?, ?, 1, ?, 0, '', 1, 0)`,
  );
  const insertSnapshot = database.query(
    `INSERT INTO runtime_snapshots(
      session_id, schema_version, format_epoch, revision, state_json, event_position,
      state_checksum, created_at
    ) VALUES (?, 1, ?, 0, ?, 0, ?, 1)`,
  );
  for (const [index, sessionId] of sessionIds.entries()) {
    insertSession.run(sessionId, WORKSPACE_ID, PROJECT_ID, WORKSPACE_DIGEST, STATE_EPOCH);
    const json = JSON.stringify(state(0, `recovery-${index}`));
    insertSnapshot.run(sessionId, STATE_EPOCH, json, checksum(json));
  }
  database.close(false);
  return {
    path,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function runMutationChildren(
  childPath: string,
  databasePath: string,
  inputs: readonly (readonly [sessionId: string, hostId: string, name: string])[],
): Promise<Array<{ readonly status: string }>> {
  const startAt = Date.now() + 250;
  const children = inputs.map(([sessionId, hostId, name]) =>
    Bun.spawn(
      [process.execPath, childPath, databasePath, sessionId, hostId, name, String(startAt)],
      { stdout: 'pipe', stderr: 'pipe' },
    ),
  );
  return Promise.all(children.map(readChild));
}

async function readChild(
  child: Subprocess<'ignore', 'pipe', 'pipe'>,
): Promise<{ readonly status: string }> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(stdout) as { readonly status: string };
}

async function readFirstJsonLine<Result>(stream: ReadableStream<Uint8Array>): Promise<Result> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Child exited before readiness evidence.');
      buffered += decoder.decode(value, { stream: true });
      const newline = buffered.indexOf('\n');
      if (newline >= 0) return JSON.parse(buffered.slice(0, newline)) as Result;
    }
  } finally {
    reader.releaseLock();
  }
}
