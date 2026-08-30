import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebGatewayObserverClient, WebObserverStreamEvent } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorGatewayRegistration,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createWebGatewayCarrier,
  createWebGatewayControlLink,
  createWebGatewayProcessLockIdentity,
  createWebGatewayProcessManager,
  createWebGatewayProcessStatePort,
  type WebGatewayProcessChild,
  type WebGatewayProcessStatus,
  type WebGatewayReadySignal,
} from '../../apps/kite-service/src/web-gateway';
import type { WebObserverCore } from '../../apps/kite-service/src/web-observer';

describe('real Gateway carrier ↔ process manager restart', () => {
  test('discovers a live instance, mints a fresh launch, and stops only the Gateway', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-gateway-process-carrier-'));
    const staticRoot = join(root, 'web');
    mkdirSync(staticRoot, { mode: 0o700 });
    mkdirSync(join(staticRoot, 'api-docs'), { mode: 0o700 });
    mkdirSync(join(staticRoot, 'assets'), { mode: 0o700 });
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>Kite Observer</title>');
    writeFileSync(join(staticRoot, 'api-docs', 'openapi.json'), '{}');
    writeFileSync(join(staticRoot, 'assets', 'index.js'), 'export {};');
    const executable = join(root, 'gateway-executable');
    writeFileSync(executable, 'fixture', { mode: 0o700 });
    const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
    let status: WebGatewayProcessStatus = 'dead';
    let carrier: ReturnType<typeof createWebGatewayCarrier> | undefined;
    let instanceLease: Awaited<ReturnType<typeof state.acquireLock>>;
    let spawnCount = 0;
    const registrations: CoordinatorGatewayRegistration[] = [];
    const common = {
      state,
      executableResolver: {
        resolve: async () => ({ path: executable, mode: 'source' as const, buildId: 'build-1' }),
      },
      environment: {
        resolve: async () => ({ cwd: root, env: { KITE_WEB_GATEWAY_STATIC_ROOT: staticRoot } }),
      },
      process: {
        inspect: async (input: { readonly pid: number; readonly processStartIdentity: string }) =>
          input.pid === 44_001 && input.processStartIdentity === 'gateway-start-1'
            ? status
            : ('uncertain' as const),
      },
      registry: {
        register(value: CoordinatorGatewayRegistration) {
          registrations.push(value);
        },
        unregister(instanceId: string) {
          const index = registrations.findIndex(
            (value) => value.identity.instanceId === instanceId,
          );
          if (index >= 0) registrations.splice(index, 1);
        },
      },
      managerProcessStartIdentity: 'manager-start-1',
      readChildProcessStartIdentity: async () => 'gateway-start-1',
      createGatewayInstanceId: () => 'gateway-instance-1',
      operationTimeoutMs: 2_000,
      startupTimeoutMs: 2_000,
      createControlLink: async ({
        descriptor,
        credential,
      }: {
        readonly descriptor: {
          readonly identity: { readonly instanceId: string; readonly buildId: string };
          readonly endpoint: { readonly origin: string };
        };
        readonly credential: string;
      }) =>
        createWebGatewayControlLink({
          origin: descriptor.endpoint.origin,
          credential,
          expectedInstanceId: descriptor.identity.instanceId,
          expectedBuildId: descriptor.identity.buildId,
        }),
      controlLinkFor: async (
        descriptor: {
          readonly identity: { readonly instanceId: string; readonly buildId: string };
          readonly endpoint: { readonly origin: string };
        },
        credential: string,
      ) =>
        createWebGatewayControlLink({
          origin: descriptor.endpoint.origin,
          credential,
          expectedInstanceId: descriptor.identity.instanceId,
          expectedBuildId: descriptor.identity.buildId,
        }),
    };
    try {
      const first = createWebGatewayProcessManager({
        ...common,
        spawn: {
          spawn: async (input): Promise<WebGatewayProcessChild> => {
            spawnCount += 1;
            const credential = input.env.KITE_WEB_GATEWAY_CONTROL_CREDENTIAL;
            if (!credential) throw new Error('missing control credential');
            carrier = createWebGatewayCarrier({
              staticAssetRoot: staticRoot,
              instanceId: 'gateway-instance-1',
              createObserver: observer,
              nativeControl: {
                credential,
                buildId: 'build-1',
                requestStop: async () => {
                  await carrier?.close();
                  status = 'dead';
                  await instanceLease?.release();
                },
              },
            });
            const ready: WebGatewayReadySignal = {
              schema: 'kite.web-gateway-ready.v1',
              identity: {
                role: 'web_gateway',
                instanceId: 'gateway-instance-1',
                buildId: 'build-1',
                protocolVersion: COORDINATOR_PROTOCOL_VERSION,
                protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
                clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
              },
              pid: 44_001,
              startedAt: '2026-08-29T00:00:00.000Z',
              processStartIdentity: 'gateway-start-1',
              endpoint: { origin: carrier.origin },
            };
            instanceLease = await state.acquireLock(
              'instance',
              createWebGatewayProcessLockIdentity({
                kind: 'instance',
                pid: ready.pid,
                instanceId: ready.identity.instanceId,
                startedAt: ready.startedAt,
                processStartIdentity: ready.processStartIdentity,
                buildId: ready.identity.buildId,
                operation: 'ensure',
              }),
            );
            if (!instanceLease) throw new Error('instance lock unavailable');
            status = 'alive';
            return {
              pid: ready.pid,
              readiness: { release: async () => undefined },
              waitForReady: async () => ready,
            };
          },
        },
      });

      const ensured = await first.ensure();
      expect(spawnCount).toBe(1);
      await expect(bootstrap(ensured.launchUrl)).resolves.toBe(200);

      const restarted = createWebGatewayProcessManager({
        ...common,
        spawn: { spawn: async () => Promise.reject(new Error('must not respawn')) },
      });
      const discovered = await restarted.discover();
      expect(discovered?.launchUrl).not.toBe(ensured.launchUrl);
      await expect(bootstrap(discovered!.launchUrl)).resolves.toBe(200);
      expect(spawnCount).toBe(1);

      await restarted.stop();
      expect(status).toBe('dead');
      await expect(state.readDescriptor()).resolves.toBeUndefined();
      await expect(state.readControlCredential()).resolves.toBeUndefined();
    } finally {
      await carrier?.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function bootstrap(launchUrl: string): Promise<number> {
  const url = new URL(launchUrl);
  const response = await fetch(`${url.origin}/_kite/web/bootstrap`, {
    method: 'POST',
    headers: {
      origin: url.origin,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
    },
    body: JSON.stringify({ launchToken: url.hash.slice(1) }),
  });
  return response.status;
}

function observer(binding: {
  readonly tabHandle: string;
  readonly connectionGeneration: number;
}): WebObserverCore {
  const client: WebGatewayObserverClient & {
    readonly events: (subscriptionId: string) => AsyncIterable<WebObserverStreamEvent>;
    readonly subscriptionEvents: (subscriptionId: string) => AsyncIterable<WebObserverStreamEvent>;
  } = {
    bootstrap: async () => ({
      schema: 'kite.app.web.bootstrap-response.v1',
      gatewayInstanceId: 'gateway-instance-1',
      contractRevision: 'contract-1',
    }),
    createTab: async () => ({
      schema: 'kite.app.web.tab-create-response.v1',
      tabHandle: binding.tabHandle,
      connectionGeneration: binding.connectionGeneration,
    }),
    listDirectory: async () => ({ schema: 'kite.app.web.directory-response.v1', workspaces: [] }),
    loadHistory: async ({ sessionId }) => ({
      schema: 'kite.app.web.history-response.v1',
      sessionId,
      messages: [],
      hasMore: false,
      observedLastSequence: 0,
    }),
    subscribe: async ({ sessionId }) => ({
      schema: 'kite.app.web.subscribe-response.v1',
      subscriptionId: 'subscription-1',
      sessionId,
      liveSequence: null,
    }),
    unsubscribe: async ({ subscriptionId }) => ({
      schema: 'kite.app.web.unsubscribe-response.v1',
      subscriptionId,
      unsubscribed: true,
    }),
    disconnect: async () => ({
      schema: 'kite.app.web.disconnect-response.v1',
      disconnected: true,
    }),
    events: () => emptyEvents(),
    subscriptionEvents: () => emptyEvents(),
  };
  return client;
}

function emptyEvents(): AsyncIterable<WebObserverStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      // No live messages are needed for process-control recovery.
    },
  };
}
