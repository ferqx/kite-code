import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type { RuntimeServer as RuntimeServerPort } from '@kite-ai/runtime-server';
import {
  admitNewWorkspaceStore,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
  writeSqliteActiveLayoutPointer,
  writeSqliteRuntimeLayoutManifest,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '@kite-ai/runtime-storage-sqlite';
import { initializeSqliteRuntimeSchema } from '../../../../packages/runtime-storage-sqlite/src/schema';
import {
  KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
  KITE_SERVICE_CONNECT_PATH,
  KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH,
} from '../../src/carrier';
import type { KiteServiceApplicationPort } from '../../src/carrier/ports';
import {
  createWorkspaceWorkerCapabilityAuthority,
  createWorkspaceWorkerControlCarrier,
  createWorkspaceWorkerControlLink,
  MAX_WORKSPACE_WORKER_CAPABILITIES,
} from '../../src/workspace-worker/control-carrier';
import type { WorkspaceWorkerControlIdentity } from '../../src/workspace-worker/process-host';
import {
  resolveWorkspaceWorkerMainEnvironment,
  runWorkspaceWorkerMain,
  type WorkspaceWorkerMainSignalPort,
} from '../../src/workspace-worker/process-main';
import {
  createWorkspaceWorkerRuntimeComposition,
  type WorkspaceWorkerApplicationOwner,
} from '../../src/workspace-worker/runtime-composition';
import {
  createWorkspaceWorkerStoreContext,
  openWorkspaceWorkerStore,
} from '../../src/workspace-worker/store-owner';
import type { WorkspaceWorkerOwnerLockPort } from '../../src/workspace-worker/worker';
import { workspaceIdentityDigest } from '../../src/workspace-worker/workspace-identity';

const roots: string[] = [];
const LAYOUT = 'generation-foreground-1';

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function makeWorkspace(path: string): KiteWorkspaceIdentity {
  const digest = createHash('sha256').update(path).digest('hex');
  return {
    canonicalPath: path,
    projectId: `project_${digest}`,
    workspaceDigest: `sha256:${digest}`,
  };
}

function makeControlIdentity(workspace: KiteWorkspaceIdentity): WorkspaceWorkerControlIdentity {
  return {
    workerScopeId: 'scope-control',
    workerInstanceId: 'instance-control',
    buildId: 'build-control',
    workspace,
  };
}

function makeStoreFixture(): {
  readonly root: string;
  readonly home: ReturnType<typeof createKiteHomeIdentity>;
  readonly workspace: KiteWorkspaceIdentity;
  readonly workerScopeId: string;
  readonly context: ReturnType<typeof createWorkspaceWorkerStoreContext>;
} {
  const root = makeRoot('kite-worker-foreground-');
  const workspacePath = realpathSync(mkdtempSync(join(root, 'workspace-')));
  const workspace = makeWorkspace(workspacePath);
  const home = createKiteHomeIdentity(join(root, 'home'));
  const layout = ensureSqliteRuntimeLayoutRoot(home.root);
  ensureSqliteRuntimeGenerationRoot(layout, LAYOUT);
  const workerScopeId = 'scope-foreground';
  const binding = {
    layoutGeneration: LAYOUT,
    workerScopeId,
    workspaceIdentityDigest: workspaceIdentityDigest(workspace),
  } as const;
  const databasePath = ensureSqliteWorkspaceStoreDirectory(layout, LAYOUT, workerScopeId);
  const database = new Database(databasePath);
  initializeSqliteRuntimeSchema(database, {
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    workspaceBinding: binding,
  });
  database.close();
  chmodSync(databasePath, 0o600);
  const sourceProfile = {
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: 6,
    formatEpoch: 'kite-runtime-server-v1-2026-08-26',
  } as const;
  const journal = {
    schema: 'kite.runtime-migration-journal.v1' as const,
    sourceStoreIdentity: 'foreground-source',
    sourceStoreDigest: 'a'.repeat(64),
    sourceProfile,
    targetLayoutGeneration: LAYOUT,
    targetCatalogDigest: 'b'.repeat(64),
    workspaceStoreDigests: [],
    pointerPhase: 'committed' as const,
    targetWriteState: 'none' as const,
    migrationNonce: 'foreground-migration-nonce',
  };
  writeSqliteRuntimeLayoutManifest(layout, {
    schema: 'kite.runtime-layout-manifest.v1',
    generation: LAYOUT,
    profile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: SQLITE_RUNTIME_WORKSPACE_STORE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    },
    catalogDigest: journal.targetCatalogDigest,
    workspaceStores: [],
  });
  writeSqliteRuntimeMigrationFence(layout, {
    schema: 'kite.runtime-migration-fence.v1',
    sourceStoreIdentity: journal.sourceStoreIdentity,
    sourceStoreDigest: journal.sourceStoreDigest,
    sourceProfile,
    targetLayoutGeneration: LAYOUT,
    migrationNonce: journal.migrationNonce,
    state: 'active',
  });
  writeSqliteRuntimeMigrationJournal(layout, journal);
  writeSqliteActiveLayoutPointer(layout, {
    schema: 'kite.runtime-active-layout.v1',
    generation: LAYOUT,
  });
  admitNewWorkspaceStore(layout, binding, databasePath);
  const context = createWorkspaceWorkerStoreContext({
    home,
    workspace,
    workerScopeId,
    layoutGeneration: LAYOUT,
  });
  return { root, home, workspace, workerScopeId, context };
}

function makeApplication(
  workspace: KiteWorkspaceIdentity,
  events: string[],
): KiteServiceApplicationPort {
  return {
    server: { beginDraining: async () => undefined } as unknown as RuntimeServerPort,
    history: {
      async listSessions() {
        return { entries: [], hasMore: false };
      },
      async listEvents() {
        return { entries: [], hasMore: false, observedLastSequence: 0 };
      },
      async loadSession() {
        throw new Error('Transcript loading is not needed by this foreground fixture.');
      },
    } satisfies RuntimeHistoryClient,
    workspaceAdmission: {
      async admitForConnect() {
        return { outcome: 'admitted' as const, workspace };
      },
      async resolveIdentity(candidate) {
        return candidate.canonicalPath === workspace.canonicalPath ? workspace : undefined;
      },
    },
    runtimeAdmission: {
      create() {
        return {
          async authorize() {
            return { allowed: true as const, workspace: workspace.canonicalPath };
          },
        };
      },
    },
    appControl: {} as KiteServiceApplicationPort['appControl'],
    onConnectionBound: () => events.push('connection-bound'),
    onConnectionClosed: () => events.push('connection-closed'),
  };
}

describe('Workspace Worker Store 7 foreground state', () => {
  test('opens only an already materialized and admitted Store 7 target', () => {
    const fixture = makeStoreFixture();
    const store = openWorkspaceWorkerStore(fixture.context);
    try {
      expect(store.storeSchemaVersion).toBe(7);
      expect(store.formatEpoch).toBe(SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH);
      expect(store.workspaceAuthority.binding).toEqual(fixture.context.binding);
    } finally {
      store.close();
    }
  });

  test('fails closed without Store 7 admission and does not create a database', () => {
    const root = makeRoot('kite-worker-no-store-');
    const workspacePath = realpathSync(mkdtempSync(join(root, 'workspace-')));
    const home = createKiteHomeIdentity(join(root, 'home'));
    expect(() =>
      createWorkspaceWorkerStoreContext({
        home,
        workspace: makeWorkspace(workspacePath),
        workerScopeId: 'scope-no-store',
        layoutGeneration: LAYOUT,
      }),
    ).toThrow();
    expect(() => realpathSync(join(home.root, 'layouts', LAYOUT, 'workers'))).toThrow();
  });
});

describe('Workspace Worker authenticated control carrier', () => {
  test('serves only exact loopback identity/capability/idle-stop routes', async () => {
    const workspace = makeWorkspace('/workspace/control-carrier');
    const identity = makeControlIdentity(workspace);
    let stopCalls = 0;
    let currentTime = 1_000;
    const authority = createWorkspaceWorkerCapabilityAuthority({
      identity,
      now: () => currentTime,
      ttlMs: 1_000,
      randomBytes: (size) => new Uint8Array(size).fill(7),
      requestIdleStop: async () => {
        stopCalls += 1;
        return 'busy';
      },
    });
    const carrier = createWorkspaceWorkerControlCarrier({
      identity,
      authority,
      requestIp: () => ({ address: '127.0.0.1' }),
    });
    try {
      const link = createWorkspaceWorkerControlLink({
        origin: carrier.origin,
        credential: carrier.credential,
        expectedIdentity: identity,
      });
      await expect(link.describeIdentity()).resolves.toEqual(identity);
      const minted = await link.mintConnectionCapability({
        clientId: 'web-tab',
        connectionGeneration: 1,
        purpose: 'web_observer',
      });
      expect(minted).toMatchObject({ outcome: 'applied', capability: expect.any(String) });
      if (minted.outcome !== 'applied') throw new Error('Worker capability mint failed.');
      expect(
        authority.verifyConnectionCapability({
          workerScopeId: identity.workerScopeId,
          workerInstanceId: identity.workerInstanceId,
          workspaceDigest: `sha256:${'0'.repeat(64)}`,
          clientId: 'web-tab',
          connectionGeneration: 1,
          purpose: 'web_observer',
          secret: minted.capability,
        }),
      ).toBe(false);
      currentTime = 2_001;
      expect(
        authority.verifyConnectionCapability({
          workerScopeId: identity.workerScopeId,
          workerInstanceId: identity.workerInstanceId,
          workspaceDigest: identity.workspace.workspaceDigest,
          clientId: 'web-tab',
          connectionGeneration: 1,
          purpose: 'web_observer',
          secret: minted.capability,
        }),
      ).toBe(false);
      await expect(link.requestIdleStop()).resolves.toBe('busy');
      expect(stopCalls).toBe(1);
      const unknown = await fetch(`${carrier.origin}/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Kite-Worker-Control ${carrier.credential}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(unknown.status).toBe(404);
      const extra = await fetch(`${carrier.origin}/_kite/worker/control/identity`, {
        method: 'POST',
        headers: {
          authorization: `Kite-Worker-Control ${carrier.credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ extra: true }),
      });
      expect(extra.status).toBe(400);
    } finally {
      await carrier.close();
    }
  });

  test('bounds outstanding capabilities, overwrites the same binding safely, and rejects old credentials', async () => {
    const workspace = makeWorkspace('/workspace/control-capacity');
    const identity = makeControlIdentity(workspace);
    let nextByte = 1;
    const authority = createWorkspaceWorkerCapabilityAuthority({
      identity,
      randomBytes: (size) => new Uint8Array(size).fill(nextByte++),
    });
    try {
      const first = await authority.mintConnectionCapability({
        clientId: 'overwrite-client',
        connectionGeneration: 1,
        purpose: 'web_observer',
      });
      expect(first.outcome).toBe('applied');
      if (first.outcome !== 'applied') throw new Error('first capability mint failed');
      const replacement = await authority.mintConnectionCapability({
        clientId: 'overwrite-client',
        connectionGeneration: 1,
        purpose: 'web_observer',
      });
      expect(replacement.outcome).toBe('applied');
      if (replacement.outcome !== 'applied') throw new Error('replacement capability mint failed');
      expect(
        authority.verifyConnectionCapability({
          workerScopeId: identity.workerScopeId,
          workerInstanceId: identity.workerInstanceId,
          workspaceDigest: identity.workspace.workspaceDigest,
          clientId: 'overwrite-client',
          connectionGeneration: 1,
          purpose: 'web_observer',
          secret: first.capability,
        }),
      ).toBe(false);
      expect(
        authority.verifyConnectionCapability({
          workerScopeId: identity.workerScopeId,
          workerInstanceId: identity.workerInstanceId,
          workspaceDigest: identity.workspace.workspaceDigest,
          clientId: 'overwrite-client',
          connectionGeneration: 1,
          purpose: 'web_observer',
          secret: replacement.capability,
        }),
      ).toBe(true);
      for (let index = 0; index < MAX_WORKSPACE_WORKER_CAPABILITIES - 1; index += 1) {
        await expect(
          authority.mintConnectionCapability({
            clientId: `capacity-${index}`,
            connectionGeneration: 1,
            purpose: 'web_observer',
          }),
        ).resolves.toMatchObject({ outcome: 'applied' });
      }
      await expect(
        authority.mintConnectionCapability({
          clientId: 'capacity-overflow',
          connectionGeneration: 1,
          purpose: 'web_observer',
        }),
      ).resolves.toMatchObject({ outcome: 'unavailable' });
    } finally {
      authority.close();
    }
  });

  test('rejects a control link authenticated with an old restart credential', async () => {
    const workspace = makeWorkspace('/workspace/control-old-credential');
    const identity = makeControlIdentity(workspace);
    const authority = createWorkspaceWorkerCapabilityAuthority({ identity });
    const carrier = createWorkspaceWorkerControlCarrier({
      identity,
      authority,
      credential: 'n'.repeat(43),
      requestIp: () => ({ address: '127.0.0.1' }),
    });
    try {
      const oldLink = createWorkspaceWorkerControlLink({
        origin: carrier.origin,
        credential: 'o'.repeat(43),
        expectedIdentity: identity,
      });
      await expect(oldLink.describeIdentity()).resolves.toBeUndefined();
    } finally {
      await carrier.close();
      authority.close();
    }
  });
});

describe('Workspace Worker runtime foreground composition', () => {
  test('acquires owner before Store/application, serves real loopback data and control endpoints, and closes once', async () => {
    const fixture = makeStoreFixture();
    const events: string[] = [];
    let lockReleaseCalls = 0;
    const ownerLock: WorkspaceWorkerOwnerLockPort = {
      async acquire(identity) {
        events.push('lock');
        return {
          identity,
          async [Symbol.asyncDispose]() {
            lockReleaseCalls += 1;
          },
        };
      },
    };
    let appDisposeCalls = 0;
    const applicationOwner: WorkspaceWorkerApplicationOwner = {
      application: makeApplication(fixture.workspace, events),
      async start() {
        events.push('application-start');
      },
      async drain() {
        events.push('application-drain');
      },
      async [Symbol.asyncDispose]() {
        appDisposeCalls += 1;
      },
    };
    const composition = await createWorkspaceWorkerRuntimeComposition({
      home: fixture.home,
      coordinationHome: fixture.home,
      workspace: fixture.workspace,
      workerScopeId: fixture.workerScopeId,
      workerInstanceId: 'instance-foreground',
      buildId: 'build-foreground',
      layoutGeneration: LAYOUT,
      controlCredential: 'c'.repeat(43),
      ownerLock,
      createApplication: async (input) => {
        expect(input.storage.workspaceAuthority.binding).toEqual(fixture.context.binding);
        expect(events).toEqual(['lock']);
        return applicationOwner;
      },
    });
    try {
      expect(events).toEqual(['lock', 'application-start']);
      expect(await fetch(`${composition.origin}/readyz`).then((response) => response.status)).toBe(
        200,
      );
      const link = createWorkspaceWorkerControlLink({
        origin: composition.controlOrigin,
        credential: composition.controlCredential,
        expectedIdentity: composition.controlIdentity,
      });
      await expect(link.describeIdentity()).resolves.toEqual(composition.controlIdentity);
      expect(link.readDirectoryOutbox).toBeDefined();
      await expect(link.readDirectoryOutbox!({})).resolves.toEqual({
        entries: [],
        hasMore: false,
      });
      const minted = await link.mintConnectionCapability({
        clientId: 'foreground-wire-client',
        connectionGeneration: 1,
        purpose: 'web_observer',
      });
      expect(minted.outcome).toBe('applied');
      if (minted.outcome !== 'applied') throw new Error('Worker capability mint failed.');
      const connect = await fetch(`${composition.origin}${KITE_SERVICE_CONNECT_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${minted.capability}`,
          'content-type': 'application/json',
          'x-kite-worker-client-id': 'foreground-wire-client',
          'x-kite-worker-connection-generation': '1',
          'x-kite-worker-purpose': 'web_observer',
        },
        body: JSON.stringify({ workspace: fixture.workspace.canonicalPath }),
      });
      expect(connect.status).toBe(200);
      expect(await connect.json()).toEqual({ ticket: expect.any(String) });
      const history = await fetch(
        `${composition.origin}${KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH}`,
        {
          method: 'POST',
          headers: {
            authorization: `${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${minted.capability}`,
            'content-type': 'application/json',
            'x-kite-worker-client-id': 'foreground-wire-client',
            'x-kite-worker-connection-generation': '1',
            'x-kite-worker-purpose': 'web_observer',
          },
          body: JSON.stringify({ limit: 1 }),
        },
      );
      expect(history.status).toBe(200);
      expect(await history.json()).toEqual({ entries: [], hasMore: false });
      const replay = await fetch(`${composition.origin}${KITE_SERVICE_CONNECT_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${minted.capability}`,
          'content-type': 'application/json',
          'x-kite-worker-client-id': 'foreground-wire-client',
          'x-kite-worker-connection-generation': '1',
          'x-kite-worker-purpose': 'web_observer',
        },
        body: JSON.stringify({ workspace: fixture.workspace.canonicalPath }),
      });
      expect(replay.status).toBe(401);
      const wrongGeneration = await fetch(`${composition.origin}${KITE_SERVICE_CONNECT_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${minted.capability}`,
          'content-type': 'application/json',
          'x-kite-worker-client-id': 'foreground-wire-client',
          'x-kite-worker-connection-generation': '2',
          'x-kite-worker-purpose': 'web_observer',
        },
        body: JSON.stringify({ workspace: fixture.workspace.canonicalPath }),
      });
      expect(wrongGeneration.status).toBe(401);
    } finally {
      await composition.close();
    }
    expect(appDisposeCalls).toBe(1);
    expect(lockReleaseCalls).toBe(1);
    expect(events).toContain('application-drain');
  });
});

describe('Workspace Worker process main', () => {
  test('binds the default owner claim to the same process identity published in readiness', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../src/workspace-worker/process-main.ts'),
      'utf8',
    );
    expect(source).toContain('currentProcessIdentity: () => processStartIdentity');
  });

  test('pins builtin artifact storage to the validated Worker Kite home', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../src/workspace-worker/production.ts'),
      'utf8',
    );
    expect(source).toContain('process.env.KITE_CODE_HOME = environment.home.root');
  });

  test('accepts exact worker run args, self-reads process identity, writes readiness, and shuts down on signal', async () => {
    const root = makeRoot('kite-worker-main-');
    const workspacePath = realpathSync(mkdtempSync(join(root, 'workspace-')));
    const workspace = makeWorkspace(workspacePath);
    const environment = {
      KITE_WORKER_HOME: join(root, 'home'),
      KITE_WORKER_COORDINATION_HOME: join(root, 'coordination-home'),
      KITE_WORKER_WORKSPACE: workspace.canonicalPath,
      KITE_WORKER_PROJECT_ID: workspace.projectId,
      KITE_WORKER_WORKSPACE_DIGEST: workspace.workspaceDigest,
      KITE_WORKER_SCOPE_ID: 'scope-main',
      KITE_WORKER_INSTANCE_ID: 'instance-main',
      KITE_WORKER_BUILD_ID: 'build-main',
      KITE_WORKER_LAYOUT_GENERATION: LAYOUT,
      KITE_WORKER_CONTROL_CREDENTIAL: 'd'.repeat(43),
      KITE_WORKER_OWNER_RESERVATION_NONCE: 'r'.repeat(43),
      KITE_WORKER_READY_FD: '9',
    };
    const parsed = resolveWorkspaceWorkerMainEnvironment(environment);
    expect(parsed.workspace).toEqual(workspace);
    expect(parsed.controlCredential).toBe('d'.repeat(43));
    let shutdown!: () => void;
    let closeCalls = 0;
    let ready: unknown;
    let readCalls = 0;
    const runtime = {
      workerIdentity: {
        workerScopeId: 'scope-main',
        workerInstanceId: 'instance-main',
        buildId: 'build-main',
        workspace,
      },
      controlIdentity: {
        workerScopeId: 'scope-main',
        workerInstanceId: 'instance-main',
        buildId: 'build-main',
        workspace,
      },
      origin: 'http://127.0.0.1:43144',
      rpcUrl: 'ws://127.0.0.1:43144/rpc',
      controlOrigin: 'http://127.0.0.1:43145',
      requestShutdown: async () => {
        shutdown();
        return 'closed' as const;
      },
      waitForShutdown: async () =>
        new Promise<void>((resolvePromise) => (shutdown = resolvePromise)),
      close: async () => {
        closeCalls += 1;
      },
    } as unknown as Awaited<ReturnType<typeof createWorkspaceWorkerRuntimeComposition>>;
    const signals: WorkspaceWorkerMainSignalPort = {
      subscribe(listener) {
        shutdown = listener;
        return () => undefined;
      },
    };
    const ownerLock: WorkspaceWorkerOwnerLockPort = {
      async acquire(identity) {
        return { identity, async [Symbol.asyncDispose]() {} };
      },
    };
    const run = runWorkspaceWorkerMain(['worker', 'run'], {
      environment,
      ownerLock,
      readProcessStartIdentity: async () => {
        readCalls += 1;
        return 'main-start';
      },
      createRuntime: async () => runtime,
      signals,
      writeReady(value) {
        ready = value;
      },
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(readCalls).toBe(1);
    expect(ready).toMatchObject({
      identity: { workerScopeId: 'scope-main', instanceId: 'instance-main' },
      processStartIdentity: 'main-start',
      controlOrigin: 'http://127.0.0.1:43145',
    });
    shutdown();
    await run;
    expect(closeCalls).toBe(1);
  });

  test('rejects unknown entry args and missing explicit environment', async () => {
    await expect(runWorkspaceWorkerMain(['worker', 'status'], {})).rejects.toThrow(/exact/u);
    await expect(
      runWorkspaceWorkerMain(['worker', 'run'], {
        environment: {},
        createRuntime: async () => {
          throw new Error('must not compose');
        },
      }),
    ).rejects.toThrow(/explicit KITE_WORKER_HOME/u);
  });
});
