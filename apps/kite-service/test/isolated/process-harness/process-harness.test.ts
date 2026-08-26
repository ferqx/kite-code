import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_ } from '@kite-ai/kite-app-contract';
import {
  createLocalKiteConnection,
  LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
  type LocalRuntimeConnectorOptions,
  type LocalRuntimeServiceDescriptor,
} from '@kite-ai/kite-local-runtime/client';
import { LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ } from '@kite-ai/kite-local-runtime/service';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import {
  createKiteServiceProcessHarness,
  type KiteServiceProcessHarness,
} from '../../../src/process-harness';

let root: string | undefined;
let harness: KiteServiceProcessHarness | undefined;

afterEach(async () => {
  if (harness) {
    try {
      await harness[Symbol.asyncDispose]();
    } catch {
      // A startup-timeout fixture intentionally leaves failure evidence for inspection. The
      // isolated temporary home is removed below only after the child has had a bounded exit turn.
      await harness.waitForChildExit(1_000);
    }
  }
  harness = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function createHarness(
  extra: Partial<Parameters<typeof createKiteServiceProcessHarness>[0]> = {},
): KiteServiceProcessHarness {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-service-process-harness-'));
  harness = createKiteServiceProcessHarness({
    homeRoot: join(root, 'home'),
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
    managerOperationTimeoutMs: 2_000,
    ...extra,
  });
  return harness;
}

describe.skipIf(process.platform === 'win32')('Kite Service KLSV1-05 process harness', () => {
  test('starts a real detached child, serves carrier routes, then stops and clears state', async () => {
    const current = createHarness();
    const started = await current.ensure({ requestId: 'process-start' });
    expect(started).toMatchObject({ outcome: 'applied', operation: 'ensure', state: 'ready' });
    const descriptor = current.readDescriptor() as LocalRuntimeServiceDescriptor;
    expect(current.lastChildPid).toBeDefined();
    expect(descriptor.pid).toBe(current.lastChildPid!);
    expect((await current.request('/healthz')).status).toBe(200);
    expect((await current.request('/readyz')).status).toBe(200);
    const status = await current.status({ requestId: 'process-status' });
    expect(status).toMatchObject({ outcome: 'applied', operation: 'status', state: 'ready' });

    const history = await current.requestAccess('/_kite/history/list-sessions', {
      method: 'POST',
      body: { limit: 10 },
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ entries: [], hasMore: false });

    const stopped = await current.stop({ requestId: 'process-stop' });
    expect(stopped).toMatchObject({ outcome: 'applied', operation: 'stop', state: 'absent' });
    expect(current.readDescriptor()).toBeUndefined();
    expect(current.readToken('access')).toBeUndefined();
    expect(await current.waitForChildExit(2_000)).toBe(0);
  }, 15_000);

  test('restart creates a new instance identity and remains connector-discoverable', async () => {
    const current = createHarness();
    await expect(current.ensure({ requestId: 'restart-start' })).resolves.toMatchObject({
      outcome: 'applied',
      state: 'ready',
    });
    const first = current.readDescriptor();
    expect(first).toBeDefined();
    const restarted = await current.restart({ requestId: 'restart' });
    expect(restarted).toMatchObject({ outcome: 'applied', operation: 'restart', state: 'ready' });
    const second = current.readDescriptor();
    expect(second).toBeDefined();
    expect(second?.instanceId).not.toBe(first?.instanceId);
    expect(second?.pid).not.toBe(first?.pid);
    expect((await current.request('/readyz')).status).toBe(200);
  }, 20_000);

  test('connects through the Native connector and keeps Runtime, History, and App Control typed', async () => {
    const current = createHarness();
    const connection = createLocalKiteConnection(connectorOptions(current, 'harness-client-1'));
    let sessionId = '';
    try {
      await connection.connect();
      expect(connection.status).toBe('active');
      const created = await connection.runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'harness-runtime-create',
        type: 'create_session',
        workspace: current.workspace.canonicalPath,
      });
      expect(created).toMatchObject({ status: 'applied', sessionId: 'harness-session-1' });
      if (created.status !== 'applied') throw new Error('harness create did not apply');
      sessionId = created.sessionId;
      await expect(
        connection.runtime.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'harness-runtime-turn',
          type: 'start_turn',
          sessionId,
          expectedRevision: 1,
          input: 'continue after client disconnect',
        }),
      ).resolves.toMatchObject({ status: 'applied', revision: 2 });
      await expect(
        connection.runtime.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' }),
      ).resolves.toMatchObject({ status: 'ok', sessions: [{ sessionId: 'harness-session-1' }] });
      await expect(connection.history.listSessions({ limit: 10 })).resolves.toMatchObject({
        entries: [{ sessionId: 'harness-session-1' }],
        hasMore: false,
      });
      await expect(connection.history.loadSession(sessionId)).resolves.toMatchObject({
        session: { sessionId, lastSequence: 2 },
        events: [],
      });
      await expect(
        connection.app.getProviderModelSnapshot({
          schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
          workspace: current.workspace,
        }),
      ).resolves.toMatchObject({ workspace: current.workspace });
    } finally {
      await connection.close();
    }
    const replacement = createLocalKiteConnection(connectorOptions(current, 'harness-client-2'));
    try {
      await replacement.connect();
      await expect(
        replacement.runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId,
        }),
      ).resolves.toMatchObject({
        status: 'ok',
        session: { sessionId, revision: 2 },
      });
    } finally {
      await replacement.close();
    }
    await expect(current.stop({ requestId: 'connector-stop' })).resolves.toMatchObject({
      outcome: 'applied',
      state: 'absent',
    });
  }, 20_000);

  test('keeps stdout pure and exposes an applied mutation after the response is unavailable', async () => {
    const current = createHarness({ faults: { dropCredentialResponse: true } });
    await current.ensure({ requestId: 'lost-response-start' });
    const mutation = await current.requestAccess('/_kite/app/provider-credential/write', {
      method: 'POST',
      body: {
        schema: LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
        mutationId: 'harness-credential-mutation',
        operation: 'write_provider_api_key',
        providerId: 'harness',
        apiKey: 'secret-value-is-not-logged',
      },
    });
    expect(mutation.status).toBe(503);
    const query = await current.requestAccess('/_kite/app/provider-model/snapshot', {
      method: 'POST',
      body: {
        schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
        workspace: current.workspace,
      },
    });
    expect(query.status).toBe(200);
    const snapshot = (await query.json()) as {
      readonly providers?: readonly { readonly readiness: string }[];
    };
    expect(snapshot.providers?.[0]?.readiness).toBe('ready');
    expect(current.stdout).toBe('');
    expect(current.stderr).not.toContain('secret-value-is-not-logged');
  }, 15_000);

  test('reports startup timeout without publishing a ready descriptor or stdout protocol', async () => {
    const current = createHarness({
      startupTimeoutMs: 25,
      shutdownTimeoutMs: 250,
      managerOperationTimeoutMs: 1_000,
      faults: { startupDelayMs: 250 },
    });
    const result = await current.ensure({ requestId: 'startup-timeout' });
    expect(result).toMatchObject({ outcome: 'unavailable' });
    expect(current.readDescriptor()).toBeUndefined();
    expect(current.stdout).toBe('');
    await expect(current.waitForChildExit(1_000)).resolves.toBe(1);
  }, 10_000);
});

function connectorOptions(
  current: KiteServiceProcessHarness,
  clientInstanceId: string,
): LocalRuntimeConnectorOptions {
  return {
    manager: {
      async ensure(value) {
        const result = await current.manager.ensure({
          clientContractRevision: value?.clientContractRevision,
        });
        return result.descriptor;
      },
    },
    state: {
      async readDescriptor() {
        return current.readDescriptor();
      },
      async readToken() {
        return current.readToken('access');
      },
    },
    workspace: current.workspace.canonicalPath,
    clientInfo: {
      name: 'kite-service-process-harness',
      version: '1',
      instanceId: clientInstanceId,
    },
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  };
}
