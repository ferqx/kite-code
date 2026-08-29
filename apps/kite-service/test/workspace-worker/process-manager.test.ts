import { describe, expect, test } from 'bun:test';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorWorkerIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import {
  WORKSPACE_WORKER_STORE_PROFILE_,
  type WorkspaceWorkerControlLink,
  type WorkspaceWorkerProcessChild,
  type WorkspaceWorkerProcessEnvironment,
  type WorkspaceWorkerProcessStatus,
  type WorkspaceWorkerReadySignal,
} from '../../src/workspace-worker/process-host';
import {
  createWorkspaceWorkerProcessManager,
  WORKSPACE_WORKER_PROCESS_DESCRIPTOR_SCHEMA,
  type WorkspaceOwnerReservation,
  type WorkspaceWorkerCapabilityResult,
  type WorkspaceWorkerProcessDescriptor,
  type WorkspaceWorkerProcessManagerOptions,
  type WorkspaceWorkerProcessResult,
} from '../../src/workspace-worker/process-manager';
import type { WorkerConnectionCapabilityRequest } from '../../src/workspace-worker/worker';

const READY_AT = '2026-08-29T00:00:00.000Z';
const LAYOUT = 'layout-1';
const BUILD = 'build-1';

type ResolverReadyOverride = (
  ready: WorkspaceWorkerReadySignal,
) => WorkspaceWorkerReadySignal | Promise<WorkspaceWorkerReadySignal>;

interface HarnessOptions {
  readonly readyOverride?: ResolverReadyOverride;
  readonly spawnFailure?: boolean;
  readonly admissionFailure?: boolean;
  readonly stopResult?: 'closed' | 'busy' | 'outcome_unknown' | 'unavailable';
  readonly ownerReservation?: OwnerReservationPort;
  readonly describeIdentityFailures?: number;
  readonly clearCredentialFailures?: number;
  readonly clearDescriptorFailures?: number;
}

interface OwnerReservationPort {
  readonly port: {
    acquire(input: {
      readonly workerScopeId: string;
      readonly workspace: KiteWorkspaceIdentity;
    }): Promise<WorkspaceOwnerReservation | undefined>;
  };
  readonly held: Map<string, string>;
}

interface Harness {
  readonly manager: ReturnType<typeof createWorkspaceWorkerProcessManager>;
  readonly workspaces: Map<string, KiteWorkspaceIdentity>;
  readonly spawnInputs: WorkspaceWorkerProcessChild[];
  readonly spawnCount: () => number;
  readonly setStatus: (scope: string, status: WorkspaceWorkerProcessStatus) => void;
  readonly setDescribeIdentityFailures: (count: number) => void;
  readonly statusFor: (scope: string) => WorkspaceWorkerProcessStatus;
  readonly registry: {
    readonly registered: WorkspaceWorkerProcessDescriptor[];
    readonly unregistered: string[];
  };
  readonly state: {
    readonly values: Map<string, WorkspaceWorkerProcessDescriptor>;
    readonly published: WorkspaceWorkerProcessDescriptor[];
    readonly cleared: WorkspaceWorkerProcessDescriptor[];
  };
  readonly controls: Map<
    string,
    {
      mintCalls: number;
      mintRequests: unknown[];
      stopCalls: number;
      directoryReads: number;
    }
  >;
  readonly controlLinks: Map<string, WorkspaceWorkerControlLink>;
  readonly events: string[];
  readonly restart: (
    controlLinkFor: NonNullable<WorkspaceWorkerProcessManagerOptions['controlLinkFor']>,
  ) => ReturnType<typeof createWorkspaceWorkerProcessManager>;
  readonly resolveReady: (scope: string) => void;
  readonly resolveExit: (scope: string) => void;
}

function makeWorkspace(scope: string, marker: string): KiteWorkspaceIdentity {
  return {
    canonicalPath: `/workspace/${scope}`,
    projectId: `project-${scope}`,
    workspaceDigest: `sha256:${marker.repeat(64)}` as `sha256:${string}`,
  };
}

function makeIdentity(
  scope: string,
  instanceId: string,
  buildId = BUILD,
): CoordinatorWorkerIdentity {
  return {
    role: 'worker',
    workerScopeId: scope,
    instanceId,
    buildId,
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  };
}

function makeEndpoint(pid: number): { readonly origin: string; readonly websocketUrl: string } {
  const port = 43000 + (pid % 1000);
  return {
    origin: `http://127.0.0.1:${port}`,
    websocketUrl: `ws://127.0.0.1:${port}/rpc`,
  };
}

function portForControl(pid: number): number {
  return 44000 + (pid % 1000);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolvePromise!(value),
  };
}

function createOwnerReservationPort(): OwnerReservationPort {
  const held = new Map<string, string>();
  return {
    held,
    port: {
      async acquire({ workerScopeId, workspace }) {
        if (held.has(workspace.workspaceDigest)) return undefined;
        held.set(workspace.workspaceDigest, workerScopeId);
        let handedOff = false;
        return {
          workerScopeId,
          workspaceDigest: workspace.workspaceDigest,
          async handoff() {
            handedOff = true;
          },
          async release() {
            if (!handedOff && held.get(workspace.workspaceDigest) === workerScopeId) {
              held.delete(workspace.workspaceDigest);
            }
          },
        };
      },
    },
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const workspaces = new Map<string, KiteWorkspaceIdentity>();
  const statuses = new Map<string, WorkspaceWorkerProcessStatus>();
  const processIdentityByScope = new Map<string, { pid: number; start: string }>();
  const children: WorkspaceWorkerProcessChild[] = [];
  const registry = {
    registered: [] as WorkspaceWorkerProcessDescriptor[],
    unregistered: [] as string[],
  };
  const stateValues = new Map<string, WorkspaceWorkerProcessDescriptor>();
  const credentials = new Map<string, string>();
  const state = {
    values: stateValues,
    published: [] as WorkspaceWorkerProcessDescriptor[],
    cleared: [] as WorkspaceWorkerProcessDescriptor[],
  };
  const controls = new Map<
    string,
    { mintCalls: number; mintRequests: unknown[]; stopCalls: number; directoryReads: number }
  >();
  const controlLinks = new Map<string, WorkspaceWorkerControlLink>();
  const events: string[] = [];
  const ownerReservation = options.ownerReservation ?? createOwnerReservationPort();
  let spawnCalls = 0;
  let describeIdentityFailures = options.describeIdentityFailures ?? 0;
  let clearCredentialFailures = options.clearCredentialFailures ?? 0;
  let clearDescriptorFailures = options.clearDescriptorFailures ?? 0;
  const readyGates = new Map<string, ReturnType<typeof deferred<WorkspaceWorkerReadySignal>>>();
  const exitGates = new Map<string, ReturnType<typeof deferred<void>>>();

  const managerOptions: WorkspaceWorkerProcessManagerOptions = {
    executableResolver: {
      resolve: async () => ({
        path: '/repo/worker.js',
        mode: 'source' as const,
        buildId: BUILD,
      }),
    },
    environment: {
      async resolve(input): Promise<WorkspaceWorkerProcessEnvironment> {
        workspaces.set(input.workerScopeId, input.workspace);
        return {
          cwd: input.workspace.canonicalPath,
          env: { KITE_WORKER_SCOPE_ID: input.workerScopeId },
        };
      },
    },
    spawn: {
      async spawn(input) {
        events.push('spawn');
        spawnCalls += 1;
        if (options.spawnFailure) throw new Error('spawn failed');
        const scope = input.env.KITE_WORKER_SCOPE_ID;
        if (!scope) throw new Error('test spawn missing scope');
        const instanceId = input.args[1];
        if (!instanceId) throw new Error('test spawn missing instance');
        const pid = 999 + spawnCalls;
        const processStart = `process-start-${pid}`;
        const workspace = workspaces.get(scope);
        if (!workspace) throw new Error('test spawn missing workspace');
        const ready: WorkspaceWorkerReadySignal = {
          schema: 'kite.workspace-worker-ready.v1',
          identity: makeIdentity(scope, instanceId, input.executable.buildId),
          workspace,
          pid,
          startedAt: READY_AT,
          processStartIdentity: processStart,
          storeProfile: WORKSPACE_WORKER_STORE_PROFILE_,
          layoutGeneration: LAYOUT,
          endpoint: makeEndpoint(pid),
          controlOrigin: `http://127.0.0.1:${portForControl(pid)}`,
        };
        const gate = deferred<WorkspaceWorkerReadySignal>();
        readyGates.set(scope, gate);
        const exitGate = deferred<void>();
        exitGates.set(scope, exitGate);
        const controlsForScope = {
          mintCalls: 0,
          mintRequests: [] as unknown[],
          stopCalls: 0,
          directoryReads: 0,
        };
        controls.set(scope, controlsForScope);
        const control = Object.freeze({
          async describeIdentity() {
            if (describeIdentityFailures > 0) {
              describeIdentityFailures -= 1;
              throw new Error('transient control identity failure');
            }
            return {
              workerScopeId: scope,
              workerInstanceId: instanceId,
              buildId: input.executable.buildId,
              workspace,
            };
          },
          async mintConnectionCapability(request: WorkerConnectionCapabilityRequest) {
            controlsForScope.mintCalls += 1;
            controlsForScope.mintRequests.push(request);
            return {
              outcome: 'applied' as const,
              capability: 'cap-secret',
              expiresAt: '2026-08-29T00:10:00.000Z',
            };
          },
          async requestIdleStop() {
            controlsForScope.stopCalls += 1;
            return options.stopResult ?? ('closed' as const);
          },
          async readDirectoryOutbox(request: {
            readonly cursor?: number;
            readonly limit?: number;
          }) {
            controlsForScope.directoryReads += 1;
            return {
              entries: [
                {
                  sessionId: 'directory-session',
                  workerScopeId: scope,
                  revision: 1,
                  updatedAt: 10,
                  tombstone: false,
                },
              ],
              nextCursor: (request.cursor ?? 0) + 1,
              hasMore: false,
            };
          },
        });
        controlLinks.set(scope, control);
        processIdentityByScope.set(scope, { pid, start: processStart });
        statuses.set(`${pid}:${processStart}`, 'alive');
        const child: WorkspaceWorkerProcessChild = {
          pid,
          readiness: {
            async release() {
              // The readiness channel is an internal resource and is released exactly once by
              // the manager. The fake intentionally tolerates repeated release calls.
            },
          },
          control,
          async waitForReady() {
            const resolved = await gate.promise;
            return options.readyOverride ? options.readyOverride(resolved) : resolved;
          },
          waitForExit: () => exitGate.promise,
        };
        children.push(child);
        queueMicrotask(() => gate.resolve(ready));
        return child;
      },
    },
    process: {
      async inspect(input) {
        return statuses.get(`${input.pid}:${input.processStartIdentity}`) ?? 'uncertain';
      },
    },
    ownerReservation: ownerReservation.port,
    admitWorkspaceStore: async () => {
      events.push('admit');
      if (options.admissionFailure) throw new Error('Store admission failed');
    },
    registry: {
      async register(value) {
        registry.registered.push(value as unknown as WorkspaceWorkerProcessDescriptor);
      },
      async unregister(scope, instance) {
        registry.unregistered.push(`${scope}:${instance}`);
      },
    },
    state: {
      async read(scope) {
        return stateValues.get(scope);
      },
      async publish(value) {
        stateValues.set(value.identity.workerScopeId, value);
        state.published.push(value);
      },
      async clear(value) {
        if (clearDescriptorFailures > 0) {
          clearDescriptorFailures -= 1;
          throw new Error('transient descriptor cleanup failure');
        }
        stateValues.delete(value.identity.workerScopeId);
        state.cleared.push(value);
      },
      async readControlCredential(scope: string) {
        return credentials.get(scope);
      },
      async publishControlCredential(scope: string, credential: string) {
        if (credentials.has(scope)) throw new Error('credential marker already exists');
        credentials.set(scope, credential);
        return credential;
      },
      async clearControlCredential(scope: string, expected: string) {
        if (clearCredentialFailures > 0) {
          clearCredentialFailures -= 1;
          throw new Error('transient credential cleanup failure');
        }
        if (credentials.get(scope) !== expected) throw new Error('credential marker mismatch');
        credentials.delete(scope);
      },
    },
    activeLayoutGeneration: async () => LAYOUT,
    createWorkerInstanceId: (() => {
      let next = 0;
      return () => `worker-instance-${++next}`;
    })(),
    argsFor: ({ workerScopeId, workerInstanceId }) => [workerScopeId, workerInstanceId],
    startupTimeoutMs: 1000,
    operationTimeoutMs: 1000,
    controlLinkFor: async (descriptor) => controlLinks.get(descriptor.identity.workerScopeId),
  };
  const manager = createWorkspaceWorkerProcessManager(managerOptions);

  return {
    manager,
    workspaces,
    spawnInputs: children,
    spawnCount: () => spawnCalls,
    setStatus(scope, status) {
      const identity = processIdentityByScope.get(scope);
      if (identity) statuses.set(`${identity.pid}:${identity.start}`, status);
    },
    setDescribeIdentityFailures(count) {
      describeIdentityFailures = count;
    },
    statusFor(scope) {
      const identity = processIdentityByScope.get(scope);
      return identity
        ? (statuses.get(`${identity.pid}:${identity.start}`) ?? 'uncertain')
        : 'uncertain';
    },
    registry,
    state,
    controls,
    controlLinks,
    events,
    restart(controlLinkFor) {
      return createWorkspaceWorkerProcessManager({ ...managerOptions, controlLinkFor });
    },
    resolveReady(scope) {
      const gate = readyGates.get(scope);
      if (!gate) throw new Error(`no readiness gate for ${scope}`);
      const identity = processIdentityByScope.get(scope);
      const workspace = workspaces.get(scope);
      if (!identity || !workspace) throw new Error(`incomplete test worker ${scope}`);
      gate.resolve({
        schema: 'kite.workspace-worker-ready.v1',
        identity: makeIdentity(scope, `worker-instance-${identity.pid - 999}`),
        workspace,
        pid: identity.pid,
        startedAt: READY_AT,
        processStartIdentity: identity.start,
        storeProfile: WORKSPACE_WORKER_STORE_PROFILE_,
        layoutGeneration: LAYOUT,
        endpoint: makeEndpoint(identity.pid),
        controlOrigin: `http://127.0.0.1:${portForControl(identity.pid)}`,
      });
    },
    resolveExit(scope) {
      const gate = exitGates.get(scope);
      if (!gate) throw new Error(`no exit gate for ${scope}`);
      gate.resolve(undefined);
    },
  };
}

function ensureRequest(scope: string, workspace: KiteWorkspaceIdentity) {
  return { workerScopeId: scope, workspace, executableMode: 'source' as const };
}

function capabilityRequest(scope: string): {
  readonly workerScopeId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly purpose: 'web_observer';
} {
  return {
    workerScopeId: scope,
    clientId: 'web-client',
    connectionGeneration: 1,
    purpose: 'web_observer',
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
}

describe('Workspace Worker process manager', () => {
  test('serializes same-scope ensure into one spawn while allowing the second call to resolve', async () => {
    const harness = createHarness();
    const workspace = makeWorkspace('same-scope', 'a');
    const first = harness.manager.ensure(ensureRequest('scope-same', workspace));
    await flush();
    const second = harness.manager.ensure(ensureRequest('scope-same', workspace));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(harness.spawnCount()).toBe(1);
    expect(firstResult).toMatchObject({ outcome: 'applied', state: 'ready' });
    expect(secondResult).toMatchObject({ outcome: 'applied', state: 'ready' });
    expect(harness.registry.registered).toHaveLength(1);
    await expect(harness.manager.listKnownScopes()).resolves.toEqual(['scope-same']);
  });

  test('runs independent Workspace scopes in parallel', async () => {
    const harness = createHarness();
    const workspaceA = makeWorkspace('parallel-a', 'b');
    const workspaceB = makeWorkspace('parallel-b', 'c');
    const first = harness.manager.ensure(ensureRequest('scope-a', workspaceA));
    const second = harness.manager.ensure(ensureRequest('scope-b', workspaceB));
    await flush();
    expect(harness.spawnCount()).toBe(2);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.outcome).toBe('applied');
    expect(secondResult.outcome).toBe('applied');
  });

  test('holds the OS-user Workspace reservation before spawn and rejects a cross-home duplicate', async () => {
    const owner = createOwnerReservationPort();
    const firstHarness = createHarness({ ownerReservation: owner });
    const secondHarness = createHarness({ ownerReservation: owner });
    const workspace = makeWorkspace('cross-home', 'd');
    const first = firstHarness.manager.ensure(ensureRequest('scope-first', workspace));
    await flush();

    const duplicate = await secondHarness.manager.ensure(ensureRequest('scope-second', workspace));
    expect(duplicate).toMatchObject({
      outcome: 'busy',
      diagnostic: 'workspace_owner_busy',
    });
    expect(secondHarness.spawnCount()).toBe(0);

    const firstResult = await first;
    expect(firstResult.outcome).toBe('applied');
    expect(owner.held.get(workspace.workspaceDigest)).toBe('scope-first');
  });

  test('requires Store 7 admission while the reservation is held and never spawns on admission failure', async () => {
    const owner = createOwnerReservationPort();
    const harness = createHarness({ ownerReservation: owner, admissionFailure: true });
    const workspace = makeWorkspace('admission-failure', '8');
    const result = await harness.manager.ensure(ensureRequest('scope-admission', workspace));
    expect(result).toMatchObject({ outcome: 'unavailable', diagnostic: 'layout_mismatch' });
    expect(harness.events).toEqual(['admit']);
    expect(harness.spawnCount()).toBe(0);
    expect(owner.held.has(workspace.workspaceDigest)).toBe(false);
  });

  test('does not clean up, stop, or respawn when process identity is uncertain, including PID reuse', async () => {
    const harness = createHarness();
    const workspace = makeWorkspace('identity', 'e');
    const ensured = await harness.manager.ensure(ensureRequest('scope-identity', workspace));
    expect(ensured.outcome).toBe('applied');
    harness.setStatus('scope-identity', 'uncertain');

    const resolved = await harness.manager.resolve({ workerScopeId: 'scope-identity', workspace });
    expect(resolved).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    const stopped = await harness.manager.stopIfIdle({ workerScopeId: 'scope-identity' });
    expect(stopped).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
    expect(harness.spawnCount()).toBe(1);
    expect(harness.registry.unregistered).toHaveLength(0);
    expect(harness.controls.get('scope-identity')?.stopCalls).toBe(0);
  });

  test('cleans up only after confirmed exact death, then permits a replacement spawn', async () => {
    const owner = createOwnerReservationPort();
    const harness = createHarness({ ownerReservation: owner });
    const workspace = makeWorkspace('dead', 'f');
    expect((await harness.manager.ensure(ensureRequest('scope-dead', workspace))).outcome).toBe(
      'applied',
    );
    harness.setStatus('scope-dead', 'dead');
    owner.held.delete(workspace.workspaceDigest);

    const resolved = await harness.manager.resolve({ workerScopeId: 'scope-dead', workspace });
    expect(resolved).toMatchObject({
      outcome: 'applied',
      state: 'absent',
      diagnostic: 'not_running',
    });
    expect(harness.registry.unregistered).toHaveLength(1);
    expect(harness.state.cleared).toHaveLength(1);

    const replacement = await harness.manager.ensure(ensureRequest('scope-dead', workspace));
    expect(replacement).toMatchObject({ outcome: 'applied', state: 'ready' });
    expect(harness.spawnCount()).toBe(2);
  });

  test('reconciles an exact child exit before PID reuse can poison the next ensure', async () => {
    const owner = createOwnerReservationPort();
    const harness = createHarness({ ownerReservation: owner });
    const scope = 'scope-exit-observer';
    const workspace = makeWorkspace('exit-observer', '9');
    await expect(harness.manager.ensure(ensureRequest(scope, workspace))).resolves.toMatchObject({
      outcome: 'applied',
      state: 'ready',
    });

    owner.held.delete(workspace.workspaceDigest);
    harness.setStatus(scope, 'uncertain');
    harness.resolveExit(scope);
    await flush();
    await flush();
    expect(harness.state.values.has(scope)).toBe(false);
    expect(harness.registry.unregistered).toHaveLength(1);

    await expect(harness.manager.ensure(ensureRequest(scope, workspace))).resolves.toMatchObject({
      outcome: 'applied',
      state: 'ready',
    });
    expect(harness.spawnCount()).toBe(2);
  });

  test('keeps uncertain and transient control identity recovery pending without a second spawn', async () => {
    const owner = createOwnerReservationPort();
    const harness = createHarness({ ownerReservation: owner });
    const workspace = makeWorkspace('recovery-pending', 'a');
    await expect(
      harness.manager.ensure(ensureRequest('scope-recovery-pending', workspace)),
    ).resolves.toMatchObject({ outcome: 'applied', state: 'ready' });

    harness.setDescribeIdentityFailures(1);
    await expect(
      harness.manager.ensure(ensureRequest('scope-recovery-pending', workspace)),
    ).resolves.toMatchObject({ outcome: 'outcome_unknown', state: 'starting' });
    expect(harness.spawnCount()).toBe(1);

    harness.setStatus('scope-recovery-pending', 'uncertain');
    await expect(
      harness.manager.ensure(ensureRequest('scope-recovery-pending', workspace)),
    ).resolves.toMatchObject({
      outcome: 'outcome_unknown',
      state: 'starting',
      diagnostic: 'identity_uncertain',
    });
    expect(harness.spawnCount()).toBe(1);

    harness.setStatus('scope-recovery-pending', 'dead');
    owner.held.delete(workspace.workspaceDigest);
    await expect(
      harness.manager.ensure(ensureRequest('scope-recovery-pending', workspace)),
    ).resolves.toMatchObject({ outcome: 'applied', state: 'ready' });
    expect(harness.spawnCount()).toBe(2);
  });

  test('recovers dead descriptor cleanup after credential or descriptor clear fails once', async () => {
    for (const failure of ['credential', 'descriptor'] as const) {
      const owner = createOwnerReservationPort();
      const harness = createHarness({
        ownerReservation: owner,
        ...(failure === 'credential'
          ? { clearCredentialFailures: 1 }
          : { clearDescriptorFailures: 1 }),
      });
      const scope = `scope-cleanup-${failure}`;
      const workspace = makeWorkspace(`cleanup-${failure}`, failure === 'credential' ? 'b' : 'c');
      await harness.manager.ensure(ensureRequest(scope, workspace));
      harness.setStatus(scope, 'dead');
      owner.held.delete(workspace.workspaceDigest);

      await expect(harness.manager.ensure(ensureRequest(scope, workspace))).resolves.toMatchObject({
        outcome: 'outcome_unknown',
        state: 'starting',
      });
      const restarted = harness.restart(async (descriptor) =>
        harness.controlLinks.get(descriptor.identity.workerScopeId),
      );
      await expect(restarted.ensure(ensureRequest(scope, workspace))).resolves.toMatchObject({
        outcome: 'applied',
        state: 'ready',
      });
      expect(harness.spawnCount()).toBe(2);
    }
  });

  test('blocks replay after a readiness identity mismatch', async () => {
    const harness = createHarness({
      readyOverride: (ready) => ({
        ...ready,
        workspace: { ...ready.workspace, canonicalPath: '/workspace/not-requested' },
      }),
    });
    const workspace = makeWorkspace('mismatch', '1');
    const first = await harness.manager.ensure(ensureRequest('scope-mismatch', workspace));
    expect(first).toMatchObject({
      outcome: 'outcome_unknown',
      state: 'starting',
      diagnostic: 'ready_mismatch',
    });
    const second = await harness.manager.ensure(ensureRequest('scope-mismatch', workspace));
    expect(second).toMatchObject({ outcome: 'outcome_unknown', diagnostic: 'outcome_unknown' });
    expect(harness.spawnCount()).toBe(1);
    expect(harness.registry.registered).toHaveLength(0);
  });

  test('returns busy for active Worker work and never kills or unregisters it', async () => {
    const harness = createHarness({ stopResult: 'busy' });
    const workspace = makeWorkspace('busy', '2');
    await harness.manager.ensure(ensureRequest('scope-busy', workspace));

    const stopped = await harness.manager.stopIfIdle({ workerScopeId: 'scope-busy' });
    expect(stopped).toMatchObject({ outcome: 'busy', diagnostic: 'process_busy' });
    expect(harness.statusFor('scope-busy')).toBe('alive');
    expect(harness.registry.unregistered).toHaveLength(0);
    expect(harness.controls.get('scope-busy')?.stopCalls).toBe(1);
  });

  test('mints through the injected Worker control link without retaining raw capability material', async () => {
    const harness = createHarness();
    const workspace = makeWorkspace('capability', '3');
    await harness.manager.ensure(ensureRequest('scope-capability', workspace));

    const first: WorkspaceWorkerCapabilityResult = await harness.manager.mintConnectionCapability(
      capabilityRequest('scope-capability'),
    );
    const second = await harness.manager.mintConnectionCapability({
      ...capabilityRequest('scope-capability'),
      clientId: 'another-client',
    });
    expect(first).toMatchObject({ outcome: 'applied', capability: 'cap-secret' });
    expect(second).toMatchObject({ outcome: 'applied', capability: 'cap-secret' });
    expect(harness.controls.get('scope-capability')?.mintCalls).toBe(2);
    expect(harness.controls.get('scope-capability')?.mintRequests).toEqual([
      {
        clientId: 'web-client',
        connectionGeneration: 1,
        purpose: 'web_observer',
      },
      {
        clientId: 'another-client',
        connectionGeneration: 1,
        purpose: 'web_observer',
      },
    ]);
    expect(JSON.stringify(harness.state.published[0])).not.toContain('cap-secret');
    expect(JSON.stringify(harness.registry.registered[0])).not.toContain(workspace.canonicalPath);
  });

  test('reads Directory outbox only after an authenticated exact Worker identity check', async () => {
    const harness = createHarness();
    const workspace = makeWorkspace('directory-read', 'f');
    await expect(
      harness.manager.ensure(ensureRequest('scope-directory-read', workspace)),
    ).resolves.toMatchObject({ outcome: 'applied', state: 'ready' });

    await expect(
      harness.manager.readDirectoryOutbox({
        workerScopeId: 'scope-directory-read',
        cursor: 4,
        limit: 1,
      }),
    ).resolves.toEqual({
      entries: [
        {
          sessionId: 'directory-session',
          workerScopeId: 'scope-directory-read',
          revision: 1,
          updatedAt: 10,
          tombstone: false,
        },
      ],
      nextCursor: 5,
      hasMore: false,
    });
    expect(harness.controls.get('scope-directory-read')?.directoryReads).toBe(1);
  });

  test('does not replay an unknown spawn outcome after a manager restart while its owner fence remains held', async () => {
    const owner = createOwnerReservationPort();
    const harness = createHarness({ ownerReservation: owner, spawnFailure: true });
    const workspace = makeWorkspace('unknown-spawn', '4');
    const first = await harness.manager.ensure(ensureRequest('scope-unknown', workspace));
    const restarted = harness.restart(async () => undefined);
    const second = await restarted.ensure(ensureRequest('scope-unknown', workspace));
    expect(first).toMatchObject({ outcome: 'outcome_unknown', diagnostic: 'outcome_unknown' });
    expect(second).toMatchObject({ outcome: 'outcome_unknown', diagnostic: 'outcome_unknown' });
    expect(harness.spawnCount()).toBe(1);
  });

  test('keeps persisted process descriptors path-free and schema-strict', async () => {
    const harness = createHarness();
    const workspace = makeWorkspace('descriptor', '5');
    const result: WorkspaceWorkerProcessResult = await harness.manager.ensure(
      ensureRequest('scope-descriptor', workspace),
    );
    expect(result.outcome).toBe('applied');
    const descriptor = harness.state.published[0];
    expect(descriptor).toBeDefined();
    expect(descriptor).not.toHaveProperty('workspace');
    expect(descriptor).not.toHaveProperty('canonicalPath');
    expect(() =>
      WORKSPACE_WORKER_PROCESS_DESCRIPTOR_SCHEMA.parse({
        ...descriptor,
        unexpected: 'field',
      }),
    ).toThrow();
  });

  test('recovers the exact Workspace identity through authenticated Worker handshake after restart', async () => {
    const harness = createHarness();
    const workspace = makeWorkspace('restart', '6');
    await harness.manager.ensure(ensureRequest('scope-restart', workspace));
    const descriptor = harness.state.published[0];
    expect(descriptor).toBeDefined();
    expect(JSON.stringify(descriptor)).not.toContain(workspace.canonicalPath);

    let observedCredential = '';
    const restarted = harness.restart(async (loadedDescriptor, credential) => {
      expect(loadedDescriptor.identity.workerScopeId).toBe('scope-restart');
      observedCredential = credential;
      return harness.controlLinks.get('scope-restart');
    });
    const resolved = await restarted.resolve({
      workerScopeId: 'scope-restart',
      workspace,
    });
    expect(resolved).toMatchObject({ outcome: 'applied', state: 'ready' });
    expect(observedCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(restarted.describeScope('scope-restart')).resolves.toMatchObject({
      workerScopeId: 'scope-restart',
      workspace,
    });
    const capability = await restarted.mintConnectionCapability(capabilityRequest('scope-restart'));
    expect(capability).toMatchObject({ outcome: 'applied', capability: 'cap-secret' });
  });

  test('cleans confirmed-dead persisted state before authenticating a replacement Worker', async () => {
    const owner = createOwnerReservationPort();
    const harness = createHarness({ ownerReservation: owner });
    const workspace = makeWorkspace('restart-dead', '8');
    await harness.manager.ensure(ensureRequest('scope-restart-dead', workspace));
    const staleDescriptor = harness.state.published[0];
    expect(staleDescriptor).toBeDefined();
    harness.setStatus('scope-restart-dead', 'dead');
    owner.held.delete(workspace.workspaceDigest);

    let staleHandshakeCalls = 0;
    const restarted = harness.restart(async (descriptor) => {
      if (descriptor.identity.instanceId === staleDescriptor!.identity.instanceId) {
        staleHandshakeCalls += 1;
        return undefined;
      }
      return harness.controlLinks.get('scope-restart-dead');
    });
    const replacement = await restarted.ensure(ensureRequest('scope-restart-dead', workspace));

    expect(replacement).toMatchObject({ outcome: 'applied', state: 'ready' });
    expect(staleHandshakeCalls).toBe(0);
    expect(harness.state.cleared).toContainEqual(staleDescriptor!);
    expect(harness.spawnCount()).toBe(2);
  });

  test('does not route a restarted Worker when the authenticated identity handshake mismatches', async () => {
    const harness = createHarness();
    const workspace = makeWorkspace('restart-mismatch', '7');
    await harness.manager.ensure(ensureRequest('scope-restart-mismatch', workspace));
    const restarted = harness.restart(async () => {
      const control = harness.controlLinks.get('scope-restart-mismatch');
      if (!control) return undefined;
      return {
        ...control,
        async describeIdentity() {
          return {
            workerScopeId: 'other-scope',
            workerInstanceId: 'other-instance',
            buildId: BUILD,
            workspace,
          };
        },
      };
    });
    const resolved = await restarted.resolve({ workerScopeId: 'scope-restart-mismatch' });
    expect(resolved).toMatchObject({ outcome: 'unavailable', diagnostic: 'identity_uncertain' });
  });
});
