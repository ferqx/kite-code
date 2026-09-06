import { afterEach, describe, expect, test } from 'bun:test';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  WORKER_CONTROLLER_PATH_,
  WORKER_CONTROLLER_RECEIPT_SCHEMA_,
  WORKER_CONTROLLER_REQUEST_SCHEMA_,
  WORKER_CONTROLLER_RESPONSE_SCHEMA_,
  type WorkerControllerOperationResponse,
} from '@kite-ai/kite-app-contract/worker-controller';
import { createLocalRuntimeServiceToken } from '@kite-ai/kite-local-runtime/service';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import { RuntimeServer } from '@kite-ai/runtime-server';
import {
  createKiteServiceCarrier,
  KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
  KITE_SERVICE_CONNECT_PATH,
  KITE_SERVICE_CONTROLLER_GENERATION_HEADER,
  KITE_SERVICE_CONTROLLER_SESSION_HEADER,
} from '../../../src/carrier/native-loopback-carrier';
import type {
  KiteServiceApplicationPort,
  ServiceControllerPort,
  ServiceRuntimeConnectionBinding,
} from '../../../src/carrier/ports';

const ACCESS = createLocalRuntimeServiceToken();
const CONTROL = createLocalRuntimeServiceToken();
const CLIENT = 'native-controller-client';
const WORKER = 'worker-controller-1';
const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/tmp/controller-route-workspace',
  projectId: 'project-controller-route',
  workspaceDigest: `sha256:${'a'.repeat(64)}`,
};
const carriers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(carriers.splice(0).map((carrier) => carrier.close()));
});

describe('native Worker Controller carrier route', () => {
  test('accepts only native capability-bound requests and never takes identity from the body', async () => {
    const calls: Array<{
      readonly binding: ServiceRuntimeConnectionBinding;
      readonly sessionId: string;
    }> = [];
    const controller = createControllerPort(calls);
    const carrier = createFixture(controller);
    carriers.push(carrier);
    const headers = nativeHeaders(carrier.origin);
    const request = {
      schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
      operation: 'request_control' as const,
      sessionId: 'session-1',
      requestId: 'request-1',
      requestDigest: 'b'.repeat(64),
      resumeSecret: 'A'.repeat(43),
      resumeExpiresAtMs: Date.now() + 60_000,
    };
    const response = await fetch(`${carrier.origin}${WORKER_CONTROLLER_PATH_}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation: 'request_control',
    });
    expect(calls).toEqual([
      {
        binding: expect.objectContaining({
          clientId: CLIENT,
          connectionGeneration: 3,
          workerInstanceId: WORKER,
        }),
        sessionId: 'session-1',
      },
    ]);
    const createResponse = await fetch(`${carrier.origin}${WORKER_CONTROLLER_PATH_}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
        operation: 'create_session',
        sessionId: 'session-created',
        requestId: 'request-create',
        requestDigest: 'd'.repeat(64),
        resumeSecret: Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString(
          'base64url',
        ),
        resumeExpiresAtMs: Date.now() + 60_000,
      }),
    });
    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toMatchObject({
      operation: 'create_session',
      sessionRevision: 1,
      receipt: { operation: 'request_control' },
    });
    const parsedBody = JSON.parse(
      await (
        await fetch(`${carrier.origin}${KITE_SERVICE_CONNECT_PATH}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ workspace: workspace.canonicalPath }),
        })
      ).text(),
    ) as { readonly ticket?: string };
    expect(parsedBody.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test('rejects Web purpose, unknown fields, and missing authenticated binding', async () => {
    const carrier = createFixture(createControllerPort([]));
    carriers.push(carrier);
    const request = {
      schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
      operation: 'read_controller' as const,
      sessionId: 'session-1',
    };
    const web = await fetch(`${carrier.origin}${WORKER_CONTROLLER_PATH_}`, {
      method: 'POST',
      headers: {
        ...nativeHeaders(carrier.origin),
        'x-kite-worker-purpose': 'web_observer',
      },
      body: JSON.stringify(request),
    });
    expect(web.status).toBe(404);
    const extra = await fetch(`${carrier.origin}${WORKER_CONTROLLER_PATH_}`, {
      method: 'POST',
      headers: nativeHeaders(carrier.origin),
      body: JSON.stringify({ ...request, clientId: CLIENT }),
    });
    expect(extra.status).toBe(400);
    const missingBinding = await fetch(`${carrier.origin}${WORKER_CONTROLLER_PATH_}`, {
      method: 'POST',
      headers: {
        authorization: `${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS}`,
        origin: carrier.origin,
        'content-type': 'application/json',
        'x-kite-worker-purpose': 'native_client',
      },
      body: JSON.stringify(request),
    });
    expect(missingBinding.status).toBe(401);
  });
});

function createFixture(controller: ServiceControllerPort) {
  const runtime: RuntimeAccess = {
    command: async () => ({ status: 'rejected', commandId: 'unused', code: 'unsupported' }),
    query: async () => ({ status: 'ok', queryType: 'list_sessions', sessions: [] }),
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => await new Promise<IteratorResult<never>>(() => undefined),
      }),
    }),
  };
  const server = new RuntimeServer(
    {
      runtime,
      admission: { authorize: async () => ({ allowed: false, reason: 'unauthorized' }) },
    },
    { serverInfo: { version: 'controller-route-test', instanceId: 'service-controller-route' } },
  );
  const application: KiteServiceApplicationPort = {
    server,
    history: {
      listSessions: async () => ({ entries: [], hasMore: false }),
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      loadSession: async () => ({
        session: {
          sessionId: 'session-1',
          displayName: 'Session',
          needsSmartName: false,
          updatedAt: 0,
          lastSequence: 0,
        },
        records: [],
        events: [],
        interactionMode: 'auto',
        recovery: 'normal',
      }),
    },
    workspaceAdmission: {
      admitForConnect: async (requested) =>
        requested === workspace.canonicalPath
          ? { outcome: 'admitted', workspace }
          : { outcome: 'untrusted' },
      resolveIdentity: async (candidate) =>
        candidate.canonicalPath === workspace.canonicalPath ? workspace : undefined,
    },
    runtimeAdmission: {
      create: () => ({ authorize: async () => ({ allowed: false, reason: 'unauthorized' }) }),
    },
    appControl: {} as KiteServiceApplicationPort['appControl'],
    controller,
  };
  const carrier = createKiteServiceCarrier({
    application,
    instanceId: 'service-controller-route',
    serverVersion: 'controller-route-test',
    buildId: 'build-controller-route',
    accessToken: ACCESS,
    controlToken: CONTROL,
    connectionKindForRequest: (request) =>
      request.headers.get('x-kite-worker-purpose') === 'native_client'
        ? 'native_client'
        : request.headers.get('x-kite-worker-purpose') === 'web_observer'
          ? 'web_observer'
          : undefined,
    connectionBindingForRequest: (request) => {
      if (request.headers.get('x-kite-worker-purpose') !== 'native_client') return undefined;
      const clientId = request.headers.get('x-kite-worker-client-id');
      const generation = Number(request.headers.get('x-kite-worker-connection-generation'));
      if (!clientId || !Number.isSafeInteger(generation) || generation < 1) return undefined;
      return { clientId, connectionGeneration: generation, workerInstanceId: WORKER };
    },
  });
  return carrier;
}

function createControllerPort(
  calls: Array<{ readonly binding: ServiceRuntimeConnectionBinding; readonly sessionId: string }>,
): ServiceControllerPort {
  const operationResponse = (
    operation: 'request_control' | 'read_controller',
    binding: ServiceRuntimeConnectionBinding,
    sessionId: string,
  ): WorkerControllerOperationResponse => {
    calls.push({ binding, sessionId });
    if (operation === 'read_controller') {
      throw new Error('read not used in this fixture');
    }
    return {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation,
      status: 'rejected',
      receipt: {
        schema: WORKER_CONTROLLER_RECEIPT_SCHEMA_,
        sessionId,
        requestId: 'request-1',
        requestDigest: 'b'.repeat(64),
        operation,
        status: 'rejected',
        code: 'controller_busy',
        controllerGeneration: 1,
        connectionGeneration: binding.connectionGeneration,
        interactionGeneration: 0,
        clientId: binding.clientId,
        workerInstanceId: binding.workerInstanceId,
        completedAt: Date.now(),
      },
    };
  };
  return {
    createSession: async (request, binding) => {
      calls.push({ binding, sessionId: request.sessionId });
      return {
        schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
        operation: 'create_session',
        status: 'applied',
        sessionRevision: 1,
        receipt: {
          schema: WORKER_CONTROLLER_RECEIPT_SCHEMA_,
          sessionId: request.sessionId,
          requestId: request.requestId,
          requestDigest: request.requestDigest,
          operation: 'request_control',
          status: 'applied',
          code: 'acquired',
          controllerGeneration: 1,
          connectionGeneration: binding.connectionGeneration,
          interactionGeneration: 0,
          clientId: binding.clientId,
          workerInstanceId: binding.workerInstanceId,
          completedAt: Date.now(),
        },
        lease: {
          sessionId: request.sessionId,
          clientId: binding.clientId,
          connectionGeneration: binding.connectionGeneration,
          controllerGeneration: 1,
          workerInstanceId: binding.workerInstanceId,
          status: 'active',
        },
      };
    },
    read: async (request, binding) => {
      operationResponse('read_controller', binding, request.sessionId);
      throw new Error('read not used in this fixture');
    },
    requestControl: async (request, binding) =>
      operationResponse('request_control', binding, request.sessionId),
    releaseControl: async () => {
      throw new Error('unused');
    },
    detach: async () => {
      throw new Error('unused');
    },
    issueResumeCapability: async () => {
      throw new Error('unused');
    },
    resume: async () => {
      throw new Error('unused');
    },
    mintDetachedRecoveryCapability: async () => {
      throw new Error('unused');
    },
    abandonDetachedController: async () => {
      throw new Error('unused');
    },
    validateResumeCapability: async () => {
      throw new Error('unused');
    },
  };
}

function nativeHeaders(origin: string): Record<string, string> {
  return {
    authorization: `${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS}`,
    origin,
    'content-type': 'application/json',
    'x-kite-worker-client-id': CLIENT,
    'x-kite-worker-connection-generation': '3',
    'x-kite-worker-purpose': 'native_client',
    [KITE_SERVICE_CONTROLLER_SESSION_HEADER]: 'session-1',
    [KITE_SERVICE_CONTROLLER_GENERATION_HEADER]: '1',
  };
}
