import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  createKiteHomeIdentity,
  readLocalRuntimeServiceDescriptor,
  readLocalRuntimeServiceLockIdentity,
  readLocalRuntimeServiceToken,
} from '@kite-ai/kite-local-runtime/service';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import { RuntimeServer } from '@kite-ai/runtime-server';
import {
  createNativeKiteServiceInfrastructure,
  KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME,
  KITE_SERVICE_CONTROL_STOP_PATH,
  type NativeKiteServiceApplicationPort,
} from '../../src';

const INSTANCE_ID = 'native-infrastructure-test';
const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/tmp/kite-service-infrastructure-workspace',
  projectId: 'project-infrastructure',
  workspaceDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
};

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe.skipIf(process.platform === 'win32')(
  'Native Kite Service infrastructure composition',
  () => {
    test('publishes ready state and flushes control response before exact owner cleanup', async () => {
      root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-service-infrastructure-'));
      const home = createKiteHomeIdentity(join(root, 'home'));
      const calls: string[] = [];
      const application = createApplication(calls);
      const infrastructure = createNativeKiteServiceInfrastructure({
        home,
        application,
        instanceId: INSTANCE_ID,
        serverVersion: 'service-infrastructure-test',
        buildId: 'dev:1111111111111111111111111111111111111111',
        carrierLimits: {
          heartbeatIntervalMs: 50,
          heartbeatDeadlineMs: 150,
          drainDeadlineMs: 50,
        },
      });

      await expect(infrastructure.start()).resolves.toMatchObject({
        operation: 'start',
        outcome: 'applied',
        state: 'ready',
      });
      const descriptor = readLocalRuntimeServiceDescriptor(infrastructure.paths);
      const controlToken = readLocalRuntimeServiceToken(infrastructure.paths, 'control');
      expect(descriptor).toEqual(infrastructure.descriptor);
      expect(Object.isFrozen(infrastructure.descriptor)).toBe(true);
      expect(Object.isFrozen(infrastructure.descriptor?.endpoint)).toBe(true);
      expect(() => {
        (infrastructure.descriptor as { instanceId: string }).instanceId = 'mutated';
      }).toThrow();
      expect(descriptor?.instanceId).toBe(INSTANCE_ID);
      expect(controlToken).toBeTruthy();
      expect(readLocalRuntimeServiceLockIdentity(infrastructure.paths, 'instance')).toMatchObject({
        instanceId: INSTANCE_ID,
        operation: 'start',
      });
      expect(
        await fetch(`${descriptor!.endpoint.origin}/readyz`).then((response) => response.text()),
      ).toBe('ready');

      const response = await fetch(
        `${descriptor!.endpoint.origin}${KITE_SERVICE_CONTROL_STOP_PATH}`,
        {
          method: 'POST',
          headers: {
            authorization: `${KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME} ${controlToken}`,
            'content-type': 'application/json',
          },
          body: '{}',
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: 'applied', state: 'draining' });

      await expect(infrastructure.stop()).resolves.toMatchObject({
        operation: 'stop',
        outcome: 'applied',
        state: 'absent',
      });
      expect(readLocalRuntimeServiceDescriptor(infrastructure.paths)).toBeUndefined();
      expect(readLocalRuntimeServiceToken(infrastructure.paths, 'access')).toBeUndefined();
      expect(readLocalRuntimeServiceToken(infrastructure.paths, 'control')).toBeUndefined();
      expect(readLocalRuntimeServiceLockIdentity(infrastructure.paths, 'instance')).toBeUndefined();
      expect(calls).toEqual(['start', 'quiesce', 'commitDrain', 'dispose']);
    });

    test('does not hide invalid lifecycle deadlines behind default values', () => {
      root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-service-infrastructure-timeout-'));
      expect(() =>
        createNativeKiteServiceInfrastructure({
          home: createKiteHomeIdentity(join(root!, 'home')),
          application: createApplication([]),
          instanceId: INSTANCE_ID,
          serverVersion: 'service-infrastructure-test',
          buildId: 'dev:1111111111111111111111111111111111111111',
          startupTimeoutMs: 0,
        }),
      ).toThrow();
    });
  },
);

function createApplication(calls: string[]): NativeKiteServiceApplicationPort {
  const runtime: RuntimeAccess = {
    command: async (command) => ({
      status: 'applied',
      commandId: command.commandId,
      sessionId: 'session-infrastructure',
      revision: 1,
    }),
    query: async (query) => ({ status: 'ok', queryType: query.type, sessions: [] }),
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => await new Promise<IteratorResult<never>>(() => undefined),
      }),
    }),
  };
  const server = new RuntimeServer(
    {
      runtime,
      admission: {
        authorize: async () => ({ allowed: true, workspace: workspace.canonicalPath }),
      },
    },
    { serverInfo: { version: 'service-infrastructure-test', instanceId: INSTANCE_ID } },
  );
  const unavailable = async (): Promise<never> => {
    throw new Error('not used by infrastructure test');
  };
  const appControl: KiteAppControlClient = {
    queryWorkspaceTrust: unavailable,
    decideWorkspaceTrust: unavailable,
    getProviderModelSnapshot: unavailable,
    selectProviderModel: unavailable,
    getMcpSnapshot: unavailable,
    applyMcpAction: unavailable,
    getSkillCatalog: unavailable,
    getExecutionStatus: unavailable,
    getReleaseStatus: unavailable,
  };
  return {
    server,
    history: {
      listSessions: async () => ({ entries: [], hasMore: false }),
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      loadSession: unavailable,
    },
    workspaceAdmission: {
      admitForConnect: async () => ({ outcome: 'admitted', workspace }),
      resolveIdentity: async (candidate) =>
        candidate.canonicalPath === workspace.canonicalPath ? workspace : undefined,
    },
    runtimeAdmission: {
      create: () => ({
        authorize: async () => ({ allowed: true, workspace: workspace.canonicalPath }),
      }),
    },
    appControl: { discovery: appControl, forWorkspace: () => appControl },
    async start() {
      calls.push('start');
    },
    async quiesceMutations() {
      calls.push('quiesce');
      return {
        activeOperations: false,
        resume: () => calls.push('resume'),
        commitDrain: async () => {
          calls.push('commitDrain');
        },
      };
    },
    async cancelAll(reason) {
      calls.push(`cancel:${reason}`);
    },
    async [Symbol.asyncDispose]() {
      calls.push('dispose');
    },
  };
}
