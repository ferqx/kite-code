import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';
import { launchPairedService } from '../../src/paired';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kite-http-management-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const launch = () =>
    launchPairedService({
      entrypoint: join(import.meta.dir, '../fixtures/configured-child.ts'),
      profile,
      instanceId: crypto.randomUUID(),
      buildId: 'management-test',
      apiMajor: 1,
      requiredCapabilities: ['commands'],
    });
  const handle = await launch();
  const storeId = handle.bootstrap.storeId!;
  await handle.client.createWorkspace({
    id: 'workspace',
    rootUri: `file://${workspace}`,
    name: 'Management',
    expectedStoreId: storeId,
  });
  const fStore = (target: typeof handle) => target.bootstrap.storeId!;
  const request = async (path: string, method = 'GET', body?: unknown, target = handle) => {
    const bound =
      method === 'GET' && (path.startsWith('/v1/config/') || path.startsWith('/v1/host-mutations/'))
        ? `${path}${path.includes('?') ? '&' : '?'}storeId=${fStore(target)}`
        : path;
    const response = await fetch(`${target.bootstrap.endpoint}${bound}`, {
      method,
      headers: {
        authorization: `Bearer ${target.bootstrap.token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        etag: string;
        raw: unknown;
        errors: string[];
        state: string;
        code: string;
        receipt: { persistence: string; opaqueRef: string };
      },
    };
  };
  return {
    root,
    profile,
    workspace,
    handle,
    storeId,
    launch,
    request,
    async close() {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('paired HTTP config CAS preserves comments/unknowns and same ID is durable across processes', async () => {
  const f = await setup();
  let second: Awaited<ReturnType<typeof f.launch>> | undefined;
  try {
    const file = join(f.profile.profilePath, 'config.jsonc');
    writeFileSync(
      file,
      '// keep comment\n{"unknown":{"secret":"must-not-display"},"models":[{"id":"bad","model":{"secret":"malformed-known-field-secret"}}],"modelId":null}\n',
    );
    const view = await f.request('/v1/config/user');
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain('must-not-display');
    expect(JSON.stringify(view.body)).not.toContain('malformed-known-field-secret');
    const body = {
      commandId: 'patch',
      expectedStoreId: f.storeId,
      ifMatch: view.body.etag,
      operations: [{ kind: 'set', path: ['modelId'], value: 'new' }],
    };
    const applied = await f.request('/v1/config/user', 'PATCH', body);
    expect(applied.status).toBe(200);
    expect(applied.body.state).toBe('applied');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('// keep comment');
    expect(text).toContain('must-not-display');
    second = await f.launch();
    expect(await f.request('/v1/config/user', 'PATCH', body, second)).toEqual(applied);
    expect(readFileSync(file, 'utf8')).toBe(text);
    const conflict = await f.request('/v1/config/user', 'PATCH', { ...body, commandId: 'stale' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('configuration_conflict');
    const mismatch = await f.request('/v1/config/user', 'PATCH', {
      ...body,
      commandId: 'wrong',
      expectedStoreId: 'wrong-store',
    });
    expect(mismatch.status).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(
      (
        await f.request('/v1/config/user', 'PATCH', {
          ...body,
          operations: [{ kind: 'set', path: ['modelId'], value: 'different' }],
        })
      ).status,
    ).toBe(409);
    const store = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
      mode: 'readonly',
    });
    try {
      expect(
        await store.getHostMutation({
          expectedStoreId: f.storeId,
          commandId: 'wrong',
          subjectId: 'local-user',
        }),
      ).toBeNull();
      expect(
        JSON.stringify(
          await store.getHostMutation({
            expectedStoreId: f.storeId,
            commandId: 'patch',
            subjectId: 'local-user',
          }),
        ),
      ).not.toContain('must-not-display');
    } finally {
      await store.close();
    }
  } finally {
    await second?.close();
    await f.close();
  }
});

test('bad JSONC is readable as error and explicit exact-etag repair privately backs up original', async () => {
  const f = await setup();
  try {
    const file = join(f.profile.profilePath, 'config.jsonc');
    const original = '{"apiKey":"synthetic-repair-secret", broken';
    writeFileSync(file, original);
    const view = await f.request('/v1/config/user');
    expect(view.status).toBe(200);
    expect(view.body.raw).toBeNull();
    expect(view.body.errors).toContain('invalid_jsonc');
    expect(JSON.stringify(view)).not.toContain('synthetic-repair-secret');
    const patch = await f.request('/v1/config/user', 'PATCH', {
      commandId: 'bad-patch',
      expectedStoreId: f.storeId,
      ifMatch: view.body.etag,
      operations: [{ kind: 'set', path: ['modelId'], value: null }],
    });
    expect(patch.status).toBe(400);
    expect(readFileSync(file, 'utf8')).toBe(original);
    const repaired = await f.request('/v1/config/user/repair', 'POST', {
      commandId: 'repair',
      expectedStoreId: f.storeId,
      ifMatch: view.body.etag,
      value: { modelId: null },
    });
    expect(repaired.status).toBe(200);
    expect(repaired.body.state).toBe('applied');
    expect(JSON.stringify(repaired)).not.toContain('synthetic-repair-secret');
    const backup = join(f.profile.profilePath, '.config-repair-backups');
    expect(readdirSync(backup)).toHaveLength(1);
    expect(readFileSync(join(backup, readdirSync(backup)[0]!), 'utf8')).toBe(original);
    const projectView = await f.request('/v1/config/workspace?workspaceId=workspace');
    expect(projectView.status).toBe(200);
    const project = await f.request('/v1/config/workspace', 'PATCH', {
      commandId: 'project',
      expectedStoreId: f.storeId,
      workspaceId: 'workspace',
      ifMatch: projectView.body.etag,
      operations: [{ kind: 'set', path: ['tools'], value: [{ id: 'registered', enabled: false }] }],
    });
    expect(project.status).toBe(200);
    expect(readFileSync(join(f.workspace, 'kite-agent.jsonc'), 'utf8')).toContain('registered');
    expect((await f.request('/v1/config/workspace?workspaceId=missing')).status).toBe(404);
  } finally {
    await f.close();
  }
});

test('credential HTTP writes opaque receipts only and duplicate put never stores a second secret', async () => {
  const f = await setup();
  try {
    const body = {
      commandId: 'credential',
      expectedStoreId: f.storeId,
      secret: 'synthetic-http-secret',
    };
    const first = await f.request('/v1/credentials', 'POST', body);
    expect(first.status).toBe(200);
    expect(first.body.receipt.persistence).toBe('temporary');
    expect(first.body.receipt.opaqueRef).toMatch(/^credential:/);
    expect(JSON.stringify(first)).not.toContain(body.secret);
    expect(await f.request('/v1/credentials', 'POST', body)).toEqual(first);
    expect(
      (await f.request('/v1/credentials', 'POST', { ...body, secret: 'changed-secret' })).status,
    ).toBe(409);
    const ref = first.body.receipt.opaqueRef;
    const revoke = { commandId: 'revoke', expectedStoreId: f.storeId };
    expect((await f.request(`/v1/credentials/${ref}/revoke`, 'POST', revoke)).status).toBe(200);
    const record = await f.request('/v1/host-mutations/credential');
    expect(record.status).toBe(200);
    expect(JSON.stringify(record)).not.toContain(body.secret);
    const store = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
      mode: 'readonly',
    });
    try {
      const persisted = await store.getHostMutation({
        expectedStoreId: f.storeId,
        commandId: 'credential',
        subjectId: 'local-user',
      });
      expect(JSON.stringify(persisted)).not.toContain(body.secret);
      expect(persisted!.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await store.close();
    }
  } finally {
    await f.close();
  }
});

test('HTTP-created credential binds the default Run and revoke only prevents future lookup', async () => {
  const f = await setup();
  const received: string[] = [];
  const endpoint = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      received.push(request.headers.get('authorization') ?? '');
      const payload = {
        id: 'local',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
      };
      const finish = { ...payload, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      return new Response(
        `data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  try {
    const credential = await f.request('/v1/credentials', 'POST', {
      commandId: 'live-credential',
      expectedStoreId: f.storeId,
      secret: 'synthetic-run-secret',
    });
    const view = await f.request('/v1/config/user');
    const patched = await f.request('/v1/config/user', 'PATCH', {
      commandId: 'model-config',
      expectedStoreId: f.storeId,
      ifMatch: view.body.etag,
      operations: [
        { kind: 'set', path: ['modelId'], value: 'local' },
        {
          kind: 'set',
          path: ['models'],
          value: [
            {
              id: 'local',
              provider: 'compatible',
              model: 'local',
              baseURL: `http://127.0.0.1:${endpoint.port}/v1`,
              credentialRef: credential.body.receipt.opaqueRef,
            },
          ],
        },
      ],
    });
    expect(patched.status).toBe(200);
    await f.handle.client.createSession({
      expectedStoreId: f.storeId,
      commandId: 'create-session',
      sessionId: 'session',
      workspaceId: 'workspace',
      title: 'Credential',
    });
    const run = async (commandId: string) => {
      await f.handle.client.startRun('session', {
        expectedStoreId: f.storeId,
        commandId,
        kind: 'run.start',
        content: 'Harmless local request',
      });
      const deadline = Date.now() + 5000;
      while (true) {
        const record = await f.handle.client.getCommand(commandId);
        if (
          record.status === 'rejected' ||
          (record.status === 'applied' &&
            (await f.handle.client.getView('session')).runs.some(
              (run) => run.originCommandId === commandId && !run.isActive,
            ))
        )
          return record;
        if (Date.now() > deadline) throw new Error('management_run_deadline');
        await Bun.sleep(5);
      }
    };
    await run('before-revoke');
    expect(received).toEqual(['Bearer synthetic-run-secret']);
    expect(
      (
        await f.request(`/v1/credentials/${credential.body.receipt.opaqueRef}/revoke`, 'POST', {
          commandId: 'revoke-live',
          expectedStoreId: f.storeId,
        })
      ).status,
    ).toBe(200);
    const rejected = await run('after-revoke');
    expect(JSON.stringify(rejected)).toContain('credential_revoked');
    expect(received).toHaveLength(1);
    expect((await f.request('/v1/config/user')).status).toBe(200);
    expect((await f.handle.client.getView('session')).messages.length).toBeGreaterThan(0);
    const store = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
      mode: 'readonly',
    });
    try {
      expect(JSON.stringify(await store.listMessages('session'))).not.toContain(
        'synthetic-run-secret',
      );
    } finally {
      await store.close();
    }
  } finally {
    endpoint.stop(true);
    await f.close();
  }
});

test('in-flight durable credential receipt is not retried, and another HTTP subject cannot claim it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-management-pending-'));
  const profile = selectProfile({ dataRoot: root, profile: 'test' });
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let puts = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      kind: 'temporary',
      async put() {
        puts++;
        entered();
        await barrier;
      },
      async resolve() {
        return null;
      },
      async remove() {},
    },
  });
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  const manager = host.configurationManagement!(runtime);
  const service = await startService({
    runtime,
    configurationManagement: manager,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'pending-test',
  });
  const other = await startService({
    runtime,
    configurationManagement: manager,
    subjectId: 'intruder',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'pending-test',
  });
  const storeId = (await runtime.getMetadata()).storeId;
  const body = {
    commandId: 'pending',
    expectedStoreId: storeId,
    secret: 'controlled-barrier-secret',
  };
  const send = (target: typeof service) =>
    fetch(`${target.endpoint}/v1/credentials`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  try {
    const original = send(service);
    await enteredPromise;
    expect(puts).toBe(1);
    const retry = await send(service);
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe('mutation_incomplete');
    expect(puts).toBe(1);
    const denied = await send(other);
    expect(denied.status).toBe(409);
    expect(puts).toBe(1);
    const pending = await store.getHostMutation({
      commandId: 'pending',
      subjectId: 'local-user',
      expectedStoreId: storeId,
    });
    expect(pending!.state).toBe('pending');
    expect(JSON.stringify(pending)).not.toContain(body.secret);
    release();
    expect((await original).status).toBe(200);
    expect((await send(service)).status).toBe(200);
    expect(puts).toBe(1);
  } finally {
    release();
    await other.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Native configuration SDK keeps original CAS and cold receipts, with one committed PATCH on physical socket loss', async () => {
  const f = await setup();
  const makeClient = (target: typeof f.handle, endpoint = target.bootstrap.endpoint) =>
    createClient({
      endpoint,
      token: target.bootstrap.token,
      expected: {
        profile: target.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['configuration_management'],
      },
    });
  const client = makeClient(f.handle);
  let writes = 0,
    lookups = 0,
    mode = '';
  const relay = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = { ...request.headers };
      delete headers.host;
      delete headers.connection;
      const downstream = await fetch(`${f.handle.bootstrap.endpoint}${request.url}`, {
        method: request.method,
        headers: headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      if (request.method !== 'GET') writes++;
      if (request.url?.startsWith('/v1/host-mutations/')) lookups++;
      const body = await downstream.text();
      if (request.method === 'PATCH' && mode === 'drop') {
        mode = '';
        request.socket.destroy();
        return;
      }
      response.writeHead(downstream.status, { 'content-type': 'application/json' });
      if (request.method === 'PATCH' && mode === 'bad') {
        mode = '';
        const value = JSON.parse(body);
        value.originStoreId = 'foreign';
        response.end(JSON.stringify(value));
        return;
      }
      response.end(body);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.address();
  if (!address || typeof address === 'string') throw Error('relay_missing');
  const proxied = makeClient(f.handle, `http://127.0.0.1:${address.port}`);
  let cold: typeof f.handle | undefined;
  const failed = async (work: Promise<unknown>, code: string) => {
    const error = await work.catch((error: unknown) => error);
    expect((error as { code: string }).code).toBe(code);
  };
  try {
    await client.connect();
    await proxied.connect();
    const file = join(f.profile.profilePath, 'config.jsonc');
    writeFileSync(
      file,
      '// untouched comment\n{"unknown":{"secret":"PRIVATE_UNKNOWN"},"modelId":null,"models":[{"id":"local","provider":"compatible","model":"fixture","baseURL":"http://127.0.0.1/v1","options":{"reasoningEffort":"low","unknownSecret":"PRIVATE_OPTION"}}]}\n',
    );
    const user = await client.getConfiguration('user', { storeId: f.storeId });
    expect(JSON.stringify(user)).not.toContain('PRIVATE_UNKNOWN');
    expect(user.storeId).toBe(f.storeId);
    expect(JSON.stringify(user)).toContain('reasoningEffort');
    expect(JSON.stringify(user)).toContain('low');
    expect(JSON.stringify(user)).not.toContain('PRIVATE_OPTION');
    const original = {
      expectedStoreId: f.storeId,
      commandId: 'sdk-user',
      ifMatch: user.etag,
      operations: [{ kind: 'set' as const, path: ['modelId'], value: 'selected' }],
    };
    const promise = client.patchConfiguration('user', original);
    original.operations[0]!.value = 'caller alias';
    const applied = await promise;
    expect(applied.originStoreId).toBe(f.storeId);
    expect(applied.ifMatch).toBe(user.etag);
    expect(readFileSync(file, 'utf8')).toContain('// untouched comment');
    expect(readFileSync(file, 'utf8')).toContain('PRIVATE_UNKNOWN');
    expect(readFileSync(file, 'utf8')).not.toContain('caller alias');
    await failed(
      client.patchConfiguration('user', { ...original, commandId: 'sdk-stale' }),
      'configuration_conflict',
    );
    const workspace = await client.getConfiguration('workspace', {
      storeId: f.storeId,
      workspaceId: 'workspace',
    });
    const project = await client.patchConfiguration('workspace', {
      expectedStoreId: f.storeId,
      commandId: 'sdk-workspace',
      workspaceId: 'workspace',
      ifMatch: workspace.etag,
      operations: [{ kind: 'set', path: ['modelId'], value: null }],
    });
    expect(project.workspaceId).toBe('workspace');
    const bad = '{"apiKey":"PRIVATE_REPAIR_SECRET",broken';
    writeFileSync(file, bad);
    const damaged = await client.getConfiguration('user', { storeId: f.storeId });
    expect(damaged.effective).toBeNull();
    expect(damaged.errors).toContain('invalid_jsonc');
    const repaired = await client.repairConfiguration('user', {
      expectedStoreId: f.storeId,
      commandId: 'sdk-repair',
      ifMatch: damaged.etag,
      value: { modelId: null },
    });
    expect(repaired.state).toBe('applied');
    expect(JSON.stringify(repaired)).not.toContain('PRIVATE_REPAIR_SECRET');
    const credential = await client.putCredential({
      expectedStoreId: f.storeId,
      commandId: 'sdk-credential',
      secret: 'PRIVATE_CREDENTIAL_SECRET',
    });
    expect(credential.state).toBe('applied');
    expect(JSON.stringify(credential)).not.toContain('PRIVATE_CREDENTIAL_SECRET');
    const ref = (credential.receipt as { opaqueRef: string }).opaqueRef;
    const revoked = await client.revokeCredential(ref, {
      expectedStoreId: f.storeId,
      commandId: 'sdk-revoke',
    });
    expect(revoked.state).toBe('applied');
    const current = await proxied.getConfiguration('user', { storeId: f.storeId });
    mode = 'drop';
    await failed(
      proxied.patchConfiguration('user', {
        expectedStoreId: f.storeId,
        commandId: 'sdk-drop',
        ifMatch: current.etag,
        operations: [{ kind: 'set', path: ['modelId'], value: null }],
      }),
      'network_outcome_unknown',
    );
    expect(writes).toBe(1);
    expect(lookups).toBe(0);
    const recovered = await proxied.getHostMutation('sdk-drop', { storeId: f.storeId });
    expect(recovered.state).toBe('applied');
    expect(writes).toBe(1);
    expect(lookups).toBe(1);
    const next = await proxied.getConfiguration('user', { storeId: f.storeId });
    mode = 'bad';
    await failed(
      proxied.patchConfiguration('user', {
        expectedStoreId: f.storeId,
        commandId: 'sdk-bad-receipt',
        ifMatch: next.etag,
        operations: [{ kind: 'set', path: ['modelId'], value: null }],
      }),
      'network_outcome_unknown',
    );
    expect(writes).toBe(2);
    expect((await proxied.getHostMutation('sdk-bad-receipt', { storeId: f.storeId })).state).toBe(
      'applied',
    );
    expect(writes).toBe(2);
    expect(lookups).toBe(2);
    await failed(
      proxied.getHostMutation('sdk-drop', { storeId: 'other' }),
      'store_identity_mismatch',
    );
    expect(lookups).toBe(2);
    for (const query of [
      `storeId=${f.storeId}&storeId=${f.storeId}`,
      `storeId=${f.storeId}&path=/tmp/other`,
      `storeId=other`,
    ]) {
      const response = await fetch(`${f.handle.bootstrap.endpoint}/v1/config/user?${query}`, {
        headers: { authorization: `Bearer ${f.handle.bootstrap.token}` },
      });
      expect(response.status).toBe(query === 'storeId=other' ? 409 : 400);
    }
    for (const query of [
      `storeId=${f.storeId}&storeId=${f.storeId}`,
      `storeId=${f.storeId}&subjectId=forged`,
      `storeId=other`,
    ]) {
      const response = await fetch(
        `${f.handle.bootstrap.endpoint}/v1/host-mutations/sdk-drop?${query}`,
        { headers: { authorization: `Bearer ${f.handle.bootstrap.token}` } },
      );
      expect(response.status).toBe(query === 'storeId=other' ? 409 : 400);
    }
    const authority = {
      expectedStoreId: f.storeId,
      commandId: 'hidden',
      secret: 'x',
      subjectId: 'forged',
    };
    await failed(proxied.putCredential(authority), 'invalid_request');
    expect(writes).toBe(2);
    await f.handle.close();
    cold = await f.launch();
    const reader = makeClient(cold);
    await reader.connect();
    expect(await reader.getHostMutation('sdk-user', { storeId: f.storeId })).toEqual(applied);
    expect(await reader.getHostMutation('sdk-drop', { storeId: f.storeId })).toEqual(recovered);
    reader.disposeNetwork();
    const store = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
      mode: 'readonly',
    });
    try {
      expect(await store.listSessions()).toEqual([]);
    } finally {
      await store.close();
    }
    expect(readdirSync(f.profile.profilePath)).not.toContain('tool-ledger');
  } finally {
    client.disposeNetwork();
    proxied.disposeNetwork();
    relay.closeAllConnections();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await cold?.close();
    await f.close();
  }
}, 15000);

test('real diagnostic Native configuration preserves broken bytes with no Runtime or credential write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-diagnostic-config-'));
  const profile = selectProfile({ dataRoot: root, profile: 'test' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const file = join(profile.profilePath, 'config.jsonc');
  const original = '{"apiKey":"DIAGNOSTIC_PRIVATE",broken';
  writeFileSync(file, original);
  let puts = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      kind: 'temporary',
      async put() {
        puts++;
      },
      async resolve() {
        return null;
      },
      async remove() {},
    },
  });
  const service = await startService({
    configurationManagement: host.configurationManagement!(undefined),
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'diagnostic',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['configuration_management'],
    },
  });
  try {
    const info = await client.connect();
    expect(info.dataAvailability).toBe('unavailable');
    const view = await client.getConfiguration('user', {});
    expect(view.raw).toBeNull();
    expect(view.effective).toBeNull();
    expect(view.snapshot).toBeNull();
    expect(view.errors).toContain('invalid_jsonc');
    expect(view.etag).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(view)).not.toContain('DIAGNOSTIC_PRIVATE');
    const error = await client
      .putCredential({ expectedStoreId: 'nonexistent', commandId: 'no-runtime', secret: 'private' })
      .catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe('data_unavailable');
    expect(puts).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Settings model mutations enforce effective default and exact full read-set CAS without replacing other model facts', async () => {
  const f = await setup();
  const makeClient = (target: typeof f.handle) =>
    createClient({
      endpoint: target.bootstrap.endpoint,
      token: target.bootstrap.token,
      expected: {
        profile: target.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['configuration_management'],
      },
    });
  const client = makeClient(f.handle);
  let cold: typeof f.handle | undefined;
  const failure = async (work: Promise<unknown>, code: string) => {
    const result = await work.catch((e: unknown) => e);
    expect((result as { code: string }).code).toBe(code);
  };
  try {
    const path = join(f.profile.profilePath, 'config.jsonc');
    writeFileSync(
      path,
      '// preserve model comments\n' +
        JSON.stringify({
          modelId: 'a',
          unknown: { keep: 'PRIVATE_CONFIG' },
          models: [
            {
              id: 'a',
              provider: 'compatible',
              model: 'fixture-a',
              baseURL: 'http://127.0.0.1/v1',
              enabled: true,
              custom: 'PRIVATE_A',
            },
            {
              id: 'b',
              provider: 'compatible',
              model: 'fixture-b',
              baseURL: 'http://127.0.0.1/v1',
              enabled: false,
            },
            {
              id: 'c',
              provider: 'compatible',
              model: 'fixture-c',
              baseURL: 'http://127.0.0.1/v1',
              enabled: false,
            },
            {
              id: 'invalid',
              provider: 'unsupported',
              model: 'bad',
              baseURL: 'http://127.0.0.1/v1',
            },
          ],
        }) +
        '\n',
    );
    await client.connect();
    let view = await client.getModelSettings('user', { storeId: f.storeId });
    expect(view.defaultModelId).toBe('a');
    expect(view.models.find((m) => m.id === 'invalid')?.configured).toBe(false);
    expect(JSON.stringify(view)).not.toContain('127.0.0.1');
    expect(JSON.stringify(view)).not.toContain('PRIVATE_');
    expect(view.models.find((m) => m.id === 'a')?.reasoningEffort).toBeNull();
    expect(view.models.find((m) => m.id === 'a')?.reasoningEffortSupport).toBe('compatible_wire');
    expect(view.models.find((m) => m.id === 'invalid')?.reasoningEffortChoices).toEqual([]);
    const effortBase = { expectedStoreId: f.storeId, expectedReadSet: view.readSet! };
    await failure(
      client.updateModelSettings('user', {
        ...effortBase,
        commandId: 'unsupported-effort',
        operation: { kind: 'effort', modelId: 'invalid', reasoningEffort: 'high' },
      }),
      'model_reasoning_effort_unsupported',
    );
    const effortIntent = {
      ...effortBase,
      commandId: 'effort-high',
      operation: { kind: 'effort' as const, modelId: 'a', reasoningEffort: 'high' as const },
    };
    const effortReceipt = await client.updateModelSettings('user', effortIntent);
    expect(await client.updateModelSettings('user', effortIntent)).toEqual(effortReceipt);
    await failure(
      client.updateModelSettings('user', {
        ...effortIntent,
        operation: { ...effortIntent.operation, reasoningEffort: 'low' },
      }),
      'host_mutation_conflict',
    );
    await failure(
      client.updateModelSettings('user', { ...effortIntent, commandId: 'stale-effort' }),
      'configuration_read_set_conflict',
    );
    view = await client.getModelSettings('user', { storeId: f.storeId });
    expect(view.models.find((m) => m.id === 'a')?.reasoningEffort).toBe('high');
    await client.updateModelSettings('workspace', {
      expectedStoreId: f.storeId,
      workspaceId: 'workspace',
      commandId: 'workspace-effort',
      expectedReadSet: (
        await client.getModelSettings('workspace', { storeId: f.storeId, workspaceId: 'workspace' })
      ).readSet!,
      operation: { kind: 'effort', modelId: 'a', reasoningEffort: 'low' },
    });
    expect(
      (
        await client.getModelSettings('workspace', { storeId: f.storeId, workspaceId: 'workspace' })
      ).models.find((m) => m.id === 'a')?.reasoningEffort,
    ).toBe('low');
    await client.updateModelSettings('workspace', {
      expectedStoreId: f.storeId,
      workspaceId: 'workspace',
      commandId: 'clear-workspace-effort',
      expectedReadSet: (
        await client.getModelSettings('workspace', { storeId: f.storeId, workspaceId: 'workspace' })
      ).readSet!,
      operation: { kind: 'effort', modelId: 'a', reasoningEffort: null },
    });
    expect(
      (
        await client.getModelSettings('workspace', { storeId: f.storeId, workspaceId: 'workspace' })
      ).models.find((m) => m.id === 'a')?.reasoningEffort,
    ).toBe('high');

    writeFileSync(
      join(f.workspace, 'kite-agent.jsonc'),
      JSON.stringify({
        models: [{ id: 'a', options: { reasoningEffort: 'low', temperature: 0.5 } }],
      }),
    );
    await client.updateModelSettings('workspace', {
      expectedStoreId: f.storeId,
      workspaceId: 'workspace',
      commandId: 'clear-partial-options',
      expectedReadSet: (
        await client.getModelSettings('workspace', { storeId: f.storeId, workspaceId: 'workspace' })
      ).readSet!,
      operation: { kind: 'effort', modelId: 'a', reasoningEffort: null },
    });
    expect(
      (
        await client.getModelSettings('workspace', { storeId: f.storeId, workspaceId: 'workspace' })
      ).models.find((m) => m.id === 'a')?.reasoningEffort,
    ).toBeNull();
    expect(
      JSON.parse(readFileSync(join(f.workspace, 'kite-agent.jsonc'), 'utf8')).models[0].options,
    ).toEqual({ temperature: 0.5 });
    expect(
      (await client.getModelSettings('user', { storeId: f.storeId })).models.find(
        (m) => m.id === 'a',
      )?.reasoningEffort,
    ).toBe('high');
    const base = { expectedStoreId: f.storeId, expectedReadSet: view.readSet! };
    await failure(
      client.updateModelSettings('user', {
        ...base,
        commandId: 'disable-default',
        operation: { kind: 'enabled', modelId: 'a', enabled: false },
      }),
      'model_settings_default_disable_denied',
    );
    await failure(
      client.updateModelSettings('user', {
        ...base,
        commandId: 'disabled-default',
        operation: { kind: 'default', modelId: 'b' },
      }),
      'model_settings_model_disabled',
    );
    await failure(
      client.updateModelSettings('user', {
        ...base,
        commandId: 'invalid-default',
        operation: { kind: 'default', modelId: 'invalid' },
      }),
      'model_settings_model_unconfigured',
    );
    const enabled = await client.updateModelSettings('user', {
      ...base,
      commandId: 'enable-b',
      operation: { kind: 'enabled', modelId: 'b', enabled: true },
    });
    expect(enabled.kind).toBe('model_settings.update');
    view = await client.getModelSettings('user', { storeId: f.storeId });
    const intent = {
      expectedStoreId: f.storeId,
      commandId: 'default-b',
      expectedReadSet: view.readSet!,
      operation: { kind: 'default' as const, modelId: 'b' },
    };
    const original = structuredClone(intent);
    const pending = client.updateModelSettings('user', intent);
    intent.operation.modelId = 'invalid';
    const changed = await pending;
    expect(changed.modelSettings?.operation).toEqual(original.operation);
    expect(changed.ifMatch).toBe(original.expectedReadSet.userEtag);
    expect(await client.updateModelSettings('user', original)).toEqual(changed);
    await failure(
      client.updateModelSettings('user', {
        ...original,
        operation: { kind: 'default', modelId: 'a' },
      }),
      'host_mutation_conflict',
    );
    view = await client.getModelSettings('user', { storeId: f.storeId });
    expect(view.defaultModelId).toBe('b');
    expect(view.models.find((m) => m.id === 'b')?.enabled).toBe(true);
    expect(view.models.find((m) => m.id === 'c')?.enabled).toBe(false);
    await client.updateModelSettings('user', {
      expectedStoreId: f.storeId,
      commandId: 'disable-a',
      expectedReadSet: view.readSet!,
      operation: { kind: 'enabled', modelId: 'a', enabled: false },
    });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('// preserve model comments');
    expect(text).toContain('PRIVATE_A');
    expect(text).toContain('PRIVATE_CONFIG');
    let project = await client.getModelSettings('workspace', {
      storeId: f.storeId,
      workspaceId: 'workspace',
    });
    // A non-target user-file edit invalidates the original Workspace read set without changing its own ETag.
    writeFileSync(path, text + '// another real editor\n');
    await failure(
      client.updateModelSettings('workspace', {
        expectedStoreId: f.storeId,
        commandId: 'stale-user',
        workspaceId: 'workspace',
        expectedReadSet: project.readSet!,
        operation: { kind: 'enabled', modelId: 'c', enabled: true },
      }),
      'configuration_read_set_conflict',
    );
    project = await client.getModelSettings('workspace', {
      storeId: f.storeId,
      workspaceId: 'workspace',
    });
    const projectResult = await client.updateModelSettings('workspace', {
      expectedStoreId: f.storeId,
      commandId: 'project-c',
      workspaceId: 'workspace',
      expectedReadSet: project.readSet!,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
    });
    expect(projectResult.scope).toBe('workspace');
    expect(projectResult.workspaceId).toBe('workspace');
    expect(
      (await client.getModelSettings('user', { storeId: f.storeId })).models.find(
        (m) => m.id === 'c',
      )?.enabled,
    ).toBe(false);
    const actual = await client.getModelSettings('workspace', {
      storeId: f.storeId,
      workspaceId: 'workspace',
    });
    expect(actual.models.find((m) => m.id === 'c')?.enabled).toBe(true);
    await failure(
      client.updateModelSettings('workspace', {
        expectedStoreId: f.storeId,
        commandId: 'forged-digest',
        workspaceId: 'workspace',
        expectedReadSet: { ...actual.readSet!, effectiveDigest: '0'.repeat(64) },
        operation: { kind: 'default', modelId: 'c' },
      }),
      'configuration_read_set_conflict',
    );
    await f.handle.close();
    cold = await f.launch();
    const reader = makeClient(cold);
    await reader.connect();
    expect(await reader.getHostMutation('default-b', { storeId: f.storeId })).toEqual(changed);
    reader.disposeNetwork();
    expect(readdirSync(f.profile.profilePath)).not.toContain('tool-ledger');
  } finally {
    client.disposeNetwork();
    await cold?.close();
    await f.close();
  }
}, 15000);

for (const mode of ['default', 'effort'] as const)
  test(`Settings ${mode} committed response loss preserves one mutation and held/new Run wire facts`, async () => {
    const f = await setup();
    const requests: { model: string; reasoning_effort?: string }[] = [];
    let release: (() => void) | undefined;
    const chunk = (content: string, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] })}\n\n`;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string; reasoning_effort?: string };
        requests.push(body);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encode = (value: string) => controller.enqueue(new TextEncoder().encode(value));
              encode(chunk('original response', null));
              const end = () => {
                encode(chunk('', 'stop'));
                encode('data: [DONE]\n\n');
                controller.close();
              };
              if (requests.length === 1) release = end;
              else end();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let posts = 0,
      lookups = 0;
    const relay = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = { ...request.headers };
        delete headers.host;
        delete headers.connection;
        const downstream = await fetch(`${f.handle.bootstrap.endpoint}${request.url}`, {
          method: request.method,
          headers: headers as Record<string, string>,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const body = await downstream.text();
        if (request.method === 'POST') {
          posts++;
          expect(downstream.status).toBe(200);
          request.socket.destroy();
          return;
        }
        if (request.url?.startsWith('/v1/host-mutations/')) lookups++;
        response.writeHead(downstream.status, { 'content-type': 'application/json' });
        response.end(body);
      } catch {
        response.destroy();
      }
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.address();
    if (!address || typeof address === 'string') throw Error('relay_unavailable');
    const makeClient = (target: typeof f.handle, endpoint = target.bootstrap.endpoint) =>
      createClient({
        endpoint,
        token: target.bootstrap.token,
        expected: {
          profile: target.bootstrap.profile,
          apiMajor: 1,
          requiredCapabilities: ['configuration_management'],
        },
      });
    const client = makeClient(f.handle, `http://127.0.0.1:${address.port}`);
    let cold: typeof f.handle | undefined;
    const until = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw Error('actual_model_deadline');
        await Bun.sleep(5);
      }
    };
    try {
      writeFileSync(
        join(f.profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'a',
          models: [
            {
              id: 'a',
              provider: 'compatible',
              model: 'actual-model-a',
              options: { reasoningEffort: 'low', temperature: 0.25 },
              baseURL: `${provider.url.href}v1`,
            },
            {
              id: 'b',
              provider: 'compatible',
              model: 'actual-model-b',
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
      );
      await client.connect();
      await f.handle.client.createSession({
        expectedStoreId: f.storeId,
        commandId: 'create-held',
        sessionId: 'held',
        workspaceId: 'workspace',
        title: 'Original model',
      });
      await f.handle.client.startRun('held', {
        expectedStoreId: f.storeId,
        commandId: 'run-a',
        kind: 'run.start',
        content: 'First actual request',
      });
      await until(async () => requests.length === 1);
      const old = (await f.handle.client.getView('held')).runs.find(
        (r) => r.originCommandId === 'run-a',
      )!;
      expect(old.isActive).toBe(true);
      const settings = await client.getModelSettings('user', { storeId: f.storeId });
      const intent = {
        expectedStoreId: f.storeId,
        commandId: 'dropped-settings',
        expectedReadSet: settings.readSet!,
        operation:
          mode === 'default'
            ? { kind: 'default' as const, modelId: 'b' }
            : { kind: 'effort' as const, modelId: 'a', reasoningEffort: 'high' as const },
      };
      const error = await client.updateModelSettings('user', intent).catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe('network_outcome_unknown');
      expect(posts).toBe(1);
      expect(lookups).toBe(0);
      expect(requests).toHaveLength(1);
      const receipt = await client.getHostMutation(intent.commandId, { storeId: f.storeId });
      expect(receipt.kind).toBe('model_settings.update');
      expect(receipt.modelSettings).toEqual({
        expectedReadSet: intent.expectedReadSet,
        operation: intent.operation,
      });
      expect(lookups).toBe(1);
      expect(posts).toBe(1);
      expect(
        (await f.handle.client.getView('held')).runs.find((r) => r.id === old.id)?.isActive,
      ).toBe(true);
      release!();
      release = undefined;
      await until(
        async () => !(await f.handle.client.getView('held')).runs.some((r) => r.isActive),
      );
      await f.handle.client.startRun('held', {
        expectedStoreId: f.storeId,
        commandId: 'run-b',
        kind: 'run.start',
        content: 'Next actual request',
      });
      await until(async () =>
        (await f.handle.client.getView('held')).runs.some(
          (r) => r.originCommandId === 'run-b' && !r.isActive,
        ),
      );
      expect(requests.map((r) => r.model)).toEqual([
        'actual-model-a',
        mode === 'default' ? 'actual-model-b' : 'actual-model-a',
      ]);
      expect(requests.map((r) => r.reasoning_effort)).toEqual([
        'low',
        mode === 'default' ? undefined : 'high',
      ]);
      const inputs = await f.handle.client.listModelInputs('held');
      expect(inputs.items).toHaveLength(2);
      const recorded = [];
      for (const item of inputs.items)
        recorded.push(await f.handle.client.getModelInput('held', item.executionId));
      expect(recorded.map((snapshot) => snapshot.request.modelId)).toEqual([
        'a',
        mode === 'default' ? 'b' : 'a',
      ]);
      expect(recorded.every((snapshot) => snapshot.confirmation === 'succeeded')).toBe(true);
      await f.handle.close();
      cold = await f.launch();
      const reader = makeClient(cold);
      await reader.connect();
      expect(await reader.getHostMutation(intent.commandId, { storeId: f.storeId })).toEqual(
        receipt,
      );
      expect((await reader.getModelSettings('user', { storeId: f.storeId })).defaultModelId).toBe(
        mode === 'default' ? 'b' : 'a',
      );
      expect((await cold.client.listModelInputs('held')).items).toHaveLength(2);
      expect(requests).toHaveLength(2);
      expect(posts).toBe(1);
      reader.disposeNetwork();
      expect(readdirSync(f.profile.profilePath)).not.toContain('tool-ledger');
    } finally {
      release?.();
      client.disposeNetwork();
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      provider.stop(true);
      await cold?.close();
      await f.close();
    }
  }, 15000);

test('effort read/write never resolves credentials or models and explicit options remain immutable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-effort-no-io-'));
  const profile = selectProfile({ dataRoot: root, profile: 'test' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const file = join(profile.profilePath, 'config.jsonc');
  const value = {
    modelId: 'a',
    models: [
      {
        id: 'a',
        provider: 'compatible',
        model: 'fixture',
        baseURL: 'http://127.0.0.1:1/v1',
        credentialRef: 'credential:11111111-1111-4111-8111-111111111111',
        options: { reasoningEffort: 'low', temperature: 0.2 },
      },
    ],
  };
  writeFileSync(file, JSON.stringify(value));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  let credentialCalls = 0,
    modelCalls = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    hostConfiguration: {
      configuration: { models: [{ id: 'a', options: { reasoningEffort: 'medium' } }] },
    },
    credentialBackend: {
      kind: 'temporary',
      async put() {
        credentialCalls++;
      },
      async resolve() {
        credentialCalls++;
        return null;
      },
      async remove() {
        credentialCalls++;
      },
    },
  });
  const runtime = createRuntime({
    store,
    model: {
      async *stream() {
        modelCalls++;
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    },
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  const service = await startService({
    runtime,
    configurationManagement: host.configurationManagement!(runtime),
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'effort-readonly',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['configuration_management'],
    },
  });
  try {
    const storeId = (await client.connect()).storeId!;
    const observed = await client.getModelSettings('user', { storeId });
    expect(observed.models[0]!.reasoningEffort).toBe('medium');
    expect(observed.models[0]!.reasoningEffortReadonlyReason).toBe('model_settings_override');
    const before = readFileSync(file, 'utf8');
    for (const reasoningEffort of ['high', null] as const) {
      const error = await client
        .updateModelSettings('user', {
          expectedStoreId: storeId,
          expectedReadSet: observed.readSet!,
          commandId: `readonly-${reasoningEffort}`,
          operation: { kind: 'effort', modelId: 'a', reasoningEffort },
        })
        .catch((e) => e);
      expect(error.code).toBe('model_settings_override');
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(credentialCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(await store.listSessions()).toEqual([]);
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
