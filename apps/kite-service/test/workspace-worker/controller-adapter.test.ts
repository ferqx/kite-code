import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type {
  SqliteWorkspaceAuthority,
  SqliteWorkspaceControllerOperationResult,
} from '@kite-ai/runtime-storage-sqlite';
import {
  createSqliteWorkspaceAuthority,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
} from '@kite-ai/runtime-storage-sqlite';
import { initializeSqliteRuntimeSchema } from '../../../../packages/runtime-storage-sqlite/src/schema';
import { createWorkspaceWorkerControllerAdapter } from '../../src/workspace-worker/controller-adapter';

const WORKER = 'worker-instance-1';
const REQUEST_DIGEST = 'a'.repeat(64);

function controllerFixture() {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const applied: SqliteWorkspaceControllerOperationResult = {
    status: 'applied',
    receipt: {
      schema: 'kite.runtime-controller-operation-receipt.v1',
      sessionId: 'session-1',
      requestId: 'request-1',
      requestDigest: REQUEST_DIGEST,
      operation: 'request_control',
      status: 'applied',
      code: 'acquired',
      controllerGeneration: 1,
      connectionGeneration: 7,
      interactionGeneration: 0,
      clientId: 'native-1',
      workerInstanceId: WORKER,
      completedAt: 1,
    },
    lease: {
      sessionId: 'session-1',
      clientId: 'native-1',
      connectionGeneration: 7,
      controllerGeneration: 1,
      workerInstanceId: WORKER,
      status: 'active',
    },
  };
  const resultFor = (input: {
    readonly requestId: string;
    readonly requestDigest: string;
  }): SqliteWorkspaceControllerOperationResult => ({
    ...applied,
    receipt: {
      ...applied.receipt,
      requestId: input.requestId,
      requestDigest: input.requestDigest,
    },
  });
  const controller: SqliteWorkspaceAuthority['controller'] = {
    requestControl: (input) => {
      calls.push({ method: 'requestControl', input });
      return resultFor(input);
    },
    releaseControl: (input) => {
      calls.push({ method: 'releaseControl', input });
      return resultFor(input);
    },
    detachController: (input) => {
      calls.push({ method: 'detachController', input });
      return resultFor(input);
    },
    issueResumeCapability: (input) => {
      calls.push({ method: 'issueResumeCapability', input });
      return resultFor(input);
    },
    resumeController: (input) => {
      calls.push({ method: 'resumeController', input });
      return resultFor(input);
    },
    mintDetachedRecoveryCapability: (input) => {
      calls.push({ method: 'mintDetachedRecoveryCapability', input });
      return resultFor(input);
    },
    abandonDetachedController: (input) => {
      calls.push({ method: 'abandonDetachedController', input });
      return resultFor(input);
    },
    read: (sessionId) => {
      calls.push({ method: 'read', input: sessionId });
      return {
        sessionId,
        status: 'active',
        controllerGeneration: 1,
        connectionGeneration: 7,
        clientId: 'native-1',
        workerInstanceId: WORKER,
        interactionGeneration: 0,
        resumeCapabilityExpiresAtMs: null,
      };
    },
    lease: (sessionId) => {
      calls.push({ method: 'lease', input: sessionId });
      return {
        sessionId,
        clientId: 'native-1',
        connectionGeneration: 7,
        controllerGeneration: 1,
        workerInstanceId: WORKER,
        status: 'active',
      };
    },
    readRecovery: (sessionId) => {
      calls.push({ method: 'readRecovery', input: sessionId });
      return {
        sessionId,
        status: 'normal',
        controllerGeneration: 1,
        interactionGeneration: 0,
        updatedAt: 1,
      };
    },
    lookupOperation: () => null,
    validateResumeCapability: (input) => {
      calls.push({ method: 'validateResumeCapability', input });
      return {
        status: 'valid',
        sessionId: 'session-1',
        clientId: 'native-1',
        controllerGeneration: 1,
        connectionGeneration: 7,
      };
    },
  };
  return { authority: { controller }, calls, applied };
}

function request() {
  return {
    sessionId: 'session-1',
    requestId: 'request-1',
    requestDigest: REQUEST_DIGEST,
    clientId: 'native-1',
    connectionGeneration: 7,
    resumeSecret: 's'.repeat(43),
    resumeExpiresAtMs: 10_000,
  };
}

describe('Workspace Store Worker Controller adapter', () => {
  test('uses the real Workspace Store controller for durable replay and exact mutation fencing', () => {
    const database = new Database(':memory:');
    const binding = {
      layoutGeneration: 'generation-controller-adapter',
      workerScopeId: 'scope-controller-adapter',
      workspaceIdentityDigest: 'd'.repeat(64),
    } as const;
    initializeSqliteRuntimeSchema(database, {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
      workspaceBinding: binding,
    });
    database
      .query(
        'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, format_epoch, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'session-real',
        'project-real',
        'sha256:workspace-real',
        binding.workerScopeId,
        binding.workspaceIdentityDigest,
        SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
        SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
        0,
      );
    const authority = createSqliteWorkspaceAuthority({ db: database, binding });
    const adapter = createWorkspaceWorkerControllerAdapter({
      authority,
      workerInstanceId: WORKER,
    });
    const request = {
      sessionId: 'session-real',
      requestId: 'request-real',
      requestDigest: 'e'.repeat(64),
      clientId: 'native-real',
      connectionGeneration: 1,
      resumeSecret: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        'base64url',
      ),
      resumeExpiresAtMs: Date.now() + 60_000,
    };
    try {
      expect(adapter.native.requestControl(request)).toMatchObject({ status: 'applied' });
      expect(adapter.native.requestControl(request)).toMatchObject({ status: 'replay' });
      expect(
        adapter.native.authorizeMutation({
          sessionId: request.sessionId,
          clientId: request.clientId,
          connectionGeneration: request.connectionGeneration,
          controllerGeneration: 1,
          workerInstanceId: WORKER,
        }),
      ).toBe(true);
      expect(
        adapter.native.authorizeMutation({
          sessionId: request.sessionId,
          clientId: request.clientId,
          connectionGeneration: request.connectionGeneration,
          controllerGeneration: 2,
          workerInstanceId: WORKER,
        }),
      ).toBe(false);
      expect(() =>
        adapter.native.requestControl({ ...request, requestDigest: 'f'.repeat(64) }),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test('delegates native acquisition to the injected Store authority and binds Worker identity', () => {
    const fixture = controllerFixture();
    const adapter = createWorkspaceWorkerControllerAdapter({
      authority: fixture.authority,
      workerInstanceId: WORKER,
    });

    expect(adapter.native.requestControl(request())).toEqual(fixture.applied);
    expect(fixture.calls).toContainEqual({
      method: 'requestControl',
      input: { ...request(), workerInstanceId: WORKER },
    });
    expect(adapter.workerInstanceId).toBe(WORKER);
  });

  test('rejects caller-supplied Worker identity instead of accepting a mismatched process binding', () => {
    const fixture = controllerFixture();
    const adapter = createWorkspaceWorkerControllerAdapter({
      authority: fixture.authority,
      workerInstanceId: WORKER,
    });

    expect(() =>
      adapter.native.requestControl({ ...request(), workerInstanceId: 'other-worker' } as never),
    ).toThrow(/must not provide/u);
    expect(fixture.calls).toHaveLength(0);
  });

  test('keeps observer surface read-only and authorizes only an exact native binding', () => {
    const fixture = controllerFixture();
    const adapter = createWorkspaceWorkerControllerAdapter({
      authority: fixture.authority,
      workerInstanceId: WORKER,
    });

    expect(adapter.observer.read('session-1').status).toBe('active');
    expect(Object.keys(adapter.observer)).toEqual([
      'read',
      'lease',
      'readRecovery',
      'lookupOperation',
    ]);
    expect(
      adapter.native.authorizeMutation({
        sessionId: 'session-1',
        clientId: 'native-1',
        connectionGeneration: 7,
        controllerGeneration: 1,
        workerInstanceId: WORKER,
      }),
    ).toBe(true);
    expect(() =>
      adapter.native.authorizeMutation({
        sessionId: 'session-1',
        clientId: 'native-1',
        connectionGeneration: 8,
        controllerGeneration: 1,
        workerInstanceId: 'other-worker',
      }),
    ).toThrow(/invalid/u);
  });

  test('does not infer controller generation for release or recovery operations', () => {
    const fixture = controllerFixture();
    const adapter = createWorkspaceWorkerControllerAdapter({
      authority: fixture.authority,
      workerInstanceId: WORKER,
    });
    const release = {
      sessionId: 'session-1',
      requestId: 'release-1',
      requestDigest: 'b'.repeat(64),
      clientId: 'native-1',
      connectionGeneration: 7,
      controllerGeneration: 1,
    };

    adapter.native.releaseControl(release);
    expect(fixture.calls).toContainEqual({
      method: 'releaseControl',
      input: { ...release, workerInstanceId: WORKER },
    });
    expect(() =>
      adapter.native.releaseControl({ ...release, controllerGeneration: 0 }),
    ).not.toThrow();
  });
});
