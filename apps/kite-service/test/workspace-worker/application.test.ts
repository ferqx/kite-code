import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type KiteWorkspaceIdentity,
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
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
import { createKiteInProcessAppControlComposition } from '../../src/app-control/composition';
import { createRuntimeOperationGate } from '../../src/runtime-application';
import { createWorkspaceWorkerApplication } from '../../src/workspace-worker/application';
import { createWorkspaceWorkerIdleLifecycle } from '../../src/workspace-worker/lifecycle';
import {
  createWorkspaceWorkerStoreContext,
  openWorkspaceWorkerStore,
} from '../../src/workspace-worker/store-owner';

const LAYOUT = 'generation-application-1';
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test('keeps the authenticated command context across the mutation operation gate', () => {
  const source = readFileSync(join(import.meta.dir, '../../src/bootstrap.ts'), 'utf8');
  expect(source).toMatch(
    /command: \(command: RuntimeCommand, context\?: Readonly<RuntimeCommandContext>\) =>\s*input\.operationGate!\.runMutation\(\(\) => host\.command\(command, context\)\)/u,
  );
});

test('composes a real Worker Application over one injected Store and query-only History', async () => {
  const fixture = makeFixture();
  const configPath = join(fixture.root, 'worker-config.jsonc');
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: {
        fixture: {
          type: 'openai-compatible',
          apiKey: 'worker-test-key',
          baseURL: 'http://127.0.0.1:43123/v1',
          model: 'fixture-model',
        },
      },
      model: { default: { provider: 'fixture', name: 'fixture-model' } },
      sandbox: { enabled: false },
      interactionMode: 'auto',
    }),
  );
  const storage = openWorkspaceWorkerStore(fixture.context);
  const lifecycle = createWorkspaceWorkerIdleLifecycle({
    drain: async () => undefined,
    close: async () => undefined,
  });
  const appControl = createKiteInProcessAppControlComposition(createRuntimeOperationGate(), {
    userConfigPath: configPath,
    workspaceTrustStorePath: join(fixture.root, 'workspace-trust.jsonc'),
  });
  const trust = await appControl.gateway.discovery.queryWorkspaceTrust({
    schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
    workspace: fixture.workspace.canonicalPath,
  });
  await appControl.gateway.discovery.decideWorkspaceTrust({
    schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
    workspace: trust.workspace,
    observedStatus: trust.status,
    expectedRevision: trust.revision,
    decision: 'trust',
    externalReadScopeDigest: trust.externalReadScope.digest,
  });
  const owner = await createWorkspaceWorkerApplication(
    {
      coordinationHome: fixture.home,
      workspace: trust.workspace,
      workerIdentity: {
        workerScopeId: fixture.workerScopeId,
        workerInstanceId: 'worker-application-instance',
        buildId: 'worker-application-build',
        workspace: fixture.workspace,
      },
      storeContext: fixture.context,
      storage,
      authority: storage.workspaceAuthority,
      lifecycle,
    },
    {
      appControl,
      sandboxBackend: 'none',
    },
  );
  try {
    await owner.start();
    expect(owner.application.server).toBeDefined();
    await expect(owner.application.history.listSessions({ limit: 10 })).resolves.toMatchObject({
      entries: [],
      hasMore: false,
    });
    await expect(owner.application.history.loadSession('legacy-only-session')).rejects.toThrow(
      /not found/u,
    );
    await expect(
      owner.application.workspaceAdmission.admitForConnect(fixture.workspace.canonicalPath),
    ).resolves.toMatchObject({ outcome: 'admitted', workspace: fixture.workspace });
    await expect(
      owner.application.workspaceAdmission.admitForConnect(join(fixture.root, 'other-workspace')),
    ).resolves.toMatchObject({ outcome: 'untrusted' });
    const controllerRequest = {
      schema: 'kite.app.worker-controller.request.v1' as const,
      operation: 'create_session' as const,
      sessionId: 'atomic-session',
      requestId: 'atomic-create-request',
      requestDigest: 'c'.repeat(64),
      resumeSecret: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString(
        'base64url',
      ),
      resumeExpiresAtMs: Date.now() + 60_000,
    };
    const controllerBinding = {
      clientId: 'atomic-native-client',
      connectionGeneration: 1,
      workerInstanceId: 'worker-application-instance',
    };
    const created = await owner.application.controller?.createSession(
      controllerRequest,
      controllerBinding,
    );
    expect(created).toMatchObject({
      operation: 'create_session',
      status: 'applied',
      receipt: { operation: 'request_control', controllerGeneration: 1 },
      lease: { sessionId: 'atomic-session', controllerGeneration: 1, status: 'active' },
    });
    expect(created?.sessionRevision).toBeGreaterThanOrEqual(0);
    expect(storage.sessions.loadSnapshot('atomic-session')).not.toBeNull();
    const checkpointState = storage.sessions.loadSnapshot('atomic-session');
    if (!checkpointState) throw new Error('Atomic Session state is unavailable.');
    storage.checkpoints.saveNamedSnapshot(
      'atomic-session',
      'checkpoint-agent-read',
      checkpointState,
      storage.sessions.getLastEventPosition('atomic-session'),
    );
    const beforeAgentRead = owner.application.server.connectionCount;
    const agentRead = await owner.openAgentApiReadContext?.();
    expect(agentRead).toBeDefined();
    expect(owner.application.server.connectionCount).toBe(beforeAgentRead + 1);
    await expect(
      agentRead!.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId: 'atomic-session',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      session: { sessionId: 'atomic-session' },
    });
    await expect(agentRead!.history.listSessions({ limit: 1 })).resolves.toMatchObject({
      entries: [{ sessionId: 'atomic-session' }],
    });
    expect(agentRead!.checkpoints.list({ sessionId: 'atomic-session', limit: 1 })).toMatchObject({
      entries: [{ checkpointId: 'checkpoint-agent-read', sessionId: 'atomic-session' }],
    });
    await agentRead!.close();
    expect(owner.application.server.connectionCount).toBe(beforeAgentRead);
    await expect(
      owner.application.controller?.createSession(controllerRequest, controllerBinding),
    ).resolves.toMatchObject({ status: 'replay', sessionRevision: created?.sessionRevision });
    const admission = owner.application.runtimeAdmission.create(
      trust.workspace,
      'atomic-runtime-connection',
      'native_client',
      controllerBinding,
    );
    await expect(
      admission.authorize({
        connectionId: 'atomic-runtime-connection',
        operation: 'runtime/command',
        requestId: 'raw-create-request',
        clientInfo: { name: 'test', version: '1', instanceId: controllerBinding.clientId },
        command: {
          schema: 'kite.runtime-command.v1',
          commandId: 'raw-create-command',
          type: 'create_session',
          workspace: fixture.workspace.canonicalPath,
          bootstrapSessionId: 'raw-session',
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: 'unauthorized' });
    await expect(
      admission.authorize({
        connectionId: 'atomic-runtime-connection',
        operation: 'runtime/command',
        requestId: 'start-turn-request',
        clientInfo: { name: 'test', version: '1', instanceId: controllerBinding.clientId },
        command: {
          schema: 'kite.runtime-command.v1',
          commandId: 'start-turn-command',
          type: 'start_turn',
          sessionId: 'atomic-session',
          expectedRevision: created?.sessionRevision ?? 0,
          input: 'exercise the pinned Controller context',
        },
      }),
    ).resolves.toMatchObject({
      allowed: true,
      workspace: fixture.workspace.canonicalPath,
      bindingReference: expect.stringMatching(/^worker-command-/u),
    });
    await owner.drain();
  } finally {
    await owner[Symbol.asyncDispose]();
    // Runtime Host disposal owns the injected Store; a second close must be harmless.
    storage.close();
    await appControl[Symbol.asyncDispose]();
  }
});

test('rejects an Application factory input whose Store authority is not the injected owner', async () => {
  const fixture = makeFixture();
  const storage = openWorkspaceWorkerStore(fixture.context);
  const lifecycle = createWorkspaceWorkerIdleLifecycle({
    drain: async () => undefined,
    close: async () => undefined,
  });
  const otherAuthority = {
    ...storage.workspaceAuthority,
    binding: { ...storage.workspaceAuthority.binding, workerScopeId: 'other-scope' },
  } as typeof storage.workspaceAuthority;
  try {
    await expect(
      createWorkspaceWorkerApplication({
        coordinationHome: fixture.home,
        workspace: fixture.workspace,
        workerIdentity: {
          workerScopeId: fixture.workerScopeId,
          workerInstanceId: 'worker-application-instance',
          buildId: 'worker-application-build',
          workspace: fixture.workspace,
        },
        storeContext: fixture.context,
        storage,
        authority: otherAuthority,
        lifecycle,
      }),
    ).rejects.toThrow(/non-owner Store authority/u);
    await expect(
      createWorkspaceWorkerApplication({
        coordinationHome: fixture.home,
        workspace: fixture.workspace,
        workerIdentity: {
          workerScopeId: fixture.workerScopeId,
          workerInstanceId: 'worker-application-instance',
          buildId: 'worker-application-build',
          workspace: { ...fixture.workspace, projectId: 'project-mismatched' },
        },
        storeContext: fixture.context,
        storage,
        authority: storage.workspaceAuthority,
        lifecycle,
      }),
    ).rejects.toThrow(/does not match the admitted layout binding/u);
  } finally {
    storage.close();
  }
});

interface Fixture {
  readonly root: string;
  readonly home: ReturnType<typeof createKiteHomeIdentity>;
  readonly workspace: KiteWorkspaceIdentity;
  readonly workerScopeId: string;
  readonly context: ReturnType<typeof createWorkspaceWorkerStoreContext>;
}

function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worker-application-')));
  roots.push(root);
  const workspacePath = realpathSync(mkdtempSync(join(root, 'workspace-')));
  const workspace = makeWorkspace(workspacePath);
  const home = createKiteHomeIdentity(join(root, 'home'));
  const layout = ensureSqliteRuntimeLayoutRoot(home.root);
  ensureSqliteRuntimeGenerationRoot(layout, LAYOUT);
  const workerScopeId = 'scope-application';
  const binding = {
    layoutGeneration: LAYOUT,
    workerScopeId,
    workspaceIdentityDigest: `sha256:${createHash('sha256')
      .update(
        `kite.workspace-identity.v1\0${JSON.stringify({
          canonicalPath: workspace.canonicalPath,
          projectId: workspace.projectId,
          workspaceDigest: workspace.workspaceDigest,
        })}`,
      )
      .digest('hex')}`,
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
    sourceStoreIdentity: 'application-source',
    sourceStoreDigest: 'a'.repeat(64),
    sourceProfile,
    targetLayoutGeneration: LAYOUT,
    targetCatalogDigest: 'b'.repeat(64),
    workspaceStoreDigests: [],
    pointerPhase: 'committed' as const,
    targetWriteState: 'none' as const,
    migrationNonce: 'application-migration-nonce',
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

function makeWorkspace(path: string): KiteWorkspaceIdentity {
  const digest = createHash('sha256').update(path).digest('hex');
  return {
    canonicalPath: path,
    projectId: `project_${digest}`,
    workspaceDigest: `sha256:${digest}`,
  };
}
