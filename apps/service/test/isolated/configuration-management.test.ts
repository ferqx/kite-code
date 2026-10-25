import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';
import { launchPairedService } from '../../src/paired';
import { ownedUserConfiguration } from '../fixtures/user-configuration-fixture';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kite-http-management-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const workspace = join(root, 'workspace');
  privateDirectory(workspace);
  privateDirectory(profile.profilePath);
  const userConfiguration = ownedUserConfiguration(join(root, 'home'));
  const launch = () =>
    launchPairedService({
      entrypoint: join(import.meta.dir, '../fixtures/configured-child.ts'),
      profile,
      spawnChild: userConfiguration.spawnChild,
      instanceId: crypto.randomUUID(),
      buildId: 'management-test',
      apiMajor: 1,
      requiredCapabilities: ['commands'],
    });
  const handle = await launch();
  const storeId = handle.bootstrap.storeId!;
  await handle.client.createWorkspace({
    id: 'workspace',
    rootUri: pathToFileURL(workspace).href,
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
    userConfiguration,
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
    const file = f.userConfiguration.path;
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
    const file = f.userConfiguration.path;
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
    const backup = join(dirname(f.userConfiguration.path), '.config-repair-backups');
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

test('workspace repair rejects model fields before filesystem effects and still repairs tools', async () => {
  const f = await setup();
  try {
    const file = join(f.workspace, 'kite-agent.jsonc');
    for (const original of [undefined, '{ broken']) {
      if (original !== undefined) writeFileSync(file, original);
      const view = await f.request('/v1/config/workspace?workspaceId=workspace');
      for (const key of [
        'models',
        'modelId',
        'provider',
        'model',
        'disabledModels',
        'modelOptions',
      ]) {
        const result = await f.request('/v1/config/workspace/repair', 'POST', {
          commandId: `reject-${original === undefined ? 'missing' : 'broken'}-${key}`,
          expectedStoreId: f.storeId,
          workspaceId: 'workspace',
          ifMatch: view.body.etag,
          value: { [key]: key === 'models' ? [{ id: 'a', enabled: true }] : null },
        });
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.body.code).toBe('model_settings_user_scope_required');
        if (original === undefined) expect(existsSync(file)).toBe(false);
        else expect(readFileSync(file, 'utf8')).toBe(original);
        expect(existsSync(`${file}.lock`)).toBe(false);
        expect(existsSync(join(f.workspace, '.config-repair-backups'))).toBe(false);
      }
    }
    const view = await f.request('/v1/config/workspace?workspaceId=workspace');
    const value = { tools: [{ id: 'registered', enabled: false }] };
    const repaired = await f.request('/v1/config/workspace/repair', 'POST', {
      commandId: 'repair-project-tools',
      expectedStoreId: f.storeId,
      workspaceId: 'workspace',
      ifMatch: view.body.etag,
      value,
    });
    expect(repaired.status).toBe(200);
    expect(repaired.body.state).toBe('applied');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value);
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
    const initial = await run('before-revoke');
    if (initial.status !== 'applied')
      throw new Error(`credential_run_not_applied:${JSON.stringify(initial.receipt)}`);
    const completed = (await f.handle.client.getView('session')).runs.find(
      (run) => run.originCommandId === 'before-revoke',
    )!;
    expect({ status: completed.status, reason: completed.reason }).toEqual({
      status: 'completed',
      reason: null,
    });
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
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: 'test' });
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
    userConfigurationPath: profile.profilePath + '/config.jsonc',
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
    const file = f.userConfiguration.path;
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
      operations: [{ kind: 'set', path: ['tools'], value: [] }],
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
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'config.jsonc');
  const original = '{"apiKey":"DIAGNOSTIC_PRIVATE",broken';
  writeFileSync(file, original);
  let puts = 0;
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
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
    const path = f.userConfiguration.path;
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
    const projectPath = join(f.workspace, 'kite-agent.jsonc');
    const projectText = JSON.stringify({
      models: [{ id: 'a', options: { reasoningEffort: 'low', temperature: 0.5 } }],
      modelId: 'project-only',
    });
    writeFileSync(projectPath, projectText);
    await failure(
      client.getModelSettings('workspace', { storeId: f.storeId, workspaceId: 'workspace' }),
      'model_settings_user_scope_required',
    );
    await failure(
      client.updateModelSettings('workspace', {
        expectedStoreId: f.storeId,
        workspaceId: 'workspace',
        commandId: 'workspace-effort-rejected',
        expectedReadSet: { ...view.readSet!, workspaceEtag: 'f'.repeat(64) },
        operation: { kind: 'effort', modelId: 'a', reasoningEffort: 'low' },
      }),
      'model_settings_user_scope_required',
    );
    const projectConfig = await client.getConfiguration('workspace', {
      storeId: f.storeId,
      workspaceId: 'workspace',
    });
    await failure(
      client.patchConfiguration('workspace', {
        expectedStoreId: f.storeId,
        workspaceId: 'workspace',
        commandId: 'workspace-model-patch-rejected',
        ifMatch: projectConfig.etag,
        operations: [{ kind: 'set', path: ['modelId'], value: 'a' }],
      }),
      'model_settings_user_scope_required',
    );
    expect(readFileSync(projectPath, 'utf8')).toBe(projectText);
    expect(
      (await client.getModelSettings('user', { storeId: f.storeId })).models.find(
        (model) => model.id === 'a',
      )?.reasoningEffort,
    ).toBe('high');
    let base = { expectedStoreId: f.storeId, expectedReadSet: view.readSet! };
    const disabledDefault = await client.updateModelSettings('user', {
      ...base,
      commandId: 'disable-default',
      operation: { kind: 'enabled', modelId: 'a', enabled: false },
    });
    expect(disabledDefault.state).toBe('applied');
    view = await client.getModelSettings('user', { storeId: f.storeId });
    expect(view.defaultModelId).toBe('a');
    expect(view.models.find((model) => model.id === 'a')?.enabled).toBe(false);
    expect(disabledDefault.receipt).toHaveProperty('postReadSet', view.readSet);
    base = { expectedStoreId: f.storeId, expectedReadSet: view.readSet! };
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
    const observedUser = await client.getModelSettings('user', { storeId: f.storeId });
    writeFileSync(path, text + '// another real editor\n');
    await failure(
      client.updateModelSettings('user', {
        expectedStoreId: f.storeId,
        commandId: 'stale-user',
        expectedReadSet: observedUser.readSet!,
        operation: { kind: 'enabled', modelId: 'c', enabled: true },
      }),
      'configuration_read_set_conflict',
    );
    const actual = await client.getModelSettings('user', { storeId: f.storeId });
    await failure(
      client.updateModelSettings('user', {
        expectedStoreId: f.storeId,
        commandId: 'forged-digest',
        expectedReadSet: { ...actual.readSet!, effectiveDigest: '0'.repeat(64) },
        operation: { kind: 'default', modelId: 'c' },
      }),
      'configuration_read_set_conflict',
    );
    expect(actual.models.find((model) => model.id === 'c')?.enabled).toBe(false);
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
        f.userConfiguration.path,
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
        content: 'New task: Next actual request',
      });
      await until(async () => {
        const command = await f.handle.client.getCommand('run-b');
        const receipt = command.receipt as { runId?: string } | null;
        return (
          command.status === 'applied' &&
          typeof receipt?.runId === 'string' &&
          (await f.handle.client.getView('held')).runs.some(
            (r) => r.id === receipt.runId && !r.isActive,
          )
        );
      });
      const publicCommand = await f.handle.client.getCommand('run-b');
      const receiptRun = publicCommand.receipt as { runId: string };
      const next = await f.handle.client.getRun(receiptRun.runId);
      expect(publicCommand.kind).toBe('run.start');
      expect(publicCommand.originStoreId).toBe(f.storeId);
      expect(publicCommand.subjectId).toBe('local-user');
      expect(publicCommand.receipt).not.toHaveProperty('businessCommandId');
      expect(next.originStoreId).toBe(f.storeId);
      expect(next.sessionId).toBe(publicCommand.sessionId);
      expect(next.originCommandId).toBe(publicCommand.id);
      expect(next.rootWorkCommandId).toBe('run-b');
      expect(next.id).not.toBe(old.id);
      expect(next.status).toBe('completed');
      expect((await f.handle.client.getRun(old.id)).configuration).toEqual(old.configuration);
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

for (const initialDefault of ['b', 'a'] as const)
  test(`disabling ${initialDefault === 'a' ? 'default' : 'non-default'} A preserves its active Run and never silently replaces disabled routes`, async () => {
    const f = await setup();
    const requests: { model: string }[] = [];
    let release: (() => void) | undefined;
    const chunk = (content: string, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] })}\n\n`;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model: string };
        requests.push(body);
        const first = requests.length === 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encode = (value: string) => controller.enqueue(new TextEncoder().encode(value));
              encode(chunk(first ? 'Partial response' : 'Completed response', null));
              const end = () => {
                encode(chunk('', first ? 'length' : 'stop'));
                encode('data: [DONE]\n\n');
                controller.close();
              };
              if (first) release = end;
              else end();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const until = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw Error('active_disabled_model_deadline');
        await Bun.sleep(5);
      }
    };
    const finishedRun = async (commandId: string) => {
      await until(async () => {
        const command = await f.handle.client.getCommand(commandId);
        const receipt = command.receipt as { runId?: string } | null;
        return (
          command.status === 'applied' &&
          typeof receipt?.runId === 'string' &&
          !(await f.handle.client.getRun(receipt.runId)).isActive
        );
      });
      const command = await f.handle.client.getCommand(commandId);
      return f.handle.client.getRun((command.receipt as { runId: string }).runId);
    };
    try {
      writeFileSync(
        f.userConfiguration.path,
        JSON.stringify({
          modelId: initialDefault,
          models: ['a', 'b'].map((id) => ({
            id,
            provider: 'compatible',
            model: `actual-model-${id}`,
            baseURL: `${provider.url.href}v1`,
          })),
        }),
      );
      await f.handle.client.createSession({
        expectedStoreId: f.storeId,
        commandId: 'create-disable-held',
        sessionId: 'disable-held',
        workspaceId: 'workspace',
        title: 'Disable active model',
      });
      await f.handle.client.startRun('disable-held', {
        expectedStoreId: f.storeId,
        commandId: 'run-explicit-a',
        kind: 'run.start',
        modelId: 'a',
        content: 'New task: Continue the partial response to completion',
      });
      await until(async () => requests.length === 1 && release !== undefined);
      const originalCommand = await f.handle.client.getCommand('run-explicit-a');
      const original = await f.handle.client.getRun(
        (originalCommand.receipt as { runId: string }).runId,
      );
      expect(original).toMatchObject({
        originStoreId: f.storeId,
        sessionId: 'disable-held',
        isActive: true,
        status: 'running',
      });
      expect(originalCommand.subjectId).toBe('local-user');
      const settings = await f.handle.client.getModelSettings('user', { storeId: f.storeId });
      expect(settings.defaultModelId).toBe(initialDefault);
      const intent = {
        expectedStoreId: f.storeId,
        commandId: 'disable-active-a',
        expectedReadSet: settings.readSet!,
        operation: { kind: 'enabled' as const, modelId: 'a', enabled: false },
      };
      const applied = await f.handle.client.updateModelSettings('user', intent);
      expect(applied).toMatchObject({
        commandId: intent.commandId,
        originStoreId: f.storeId,
        scope: 'user',
        kind: 'model_settings.update',
        state: 'applied',
        modelSettings: { expectedReadSet: intent.expectedReadSet, operation: intent.operation },
      });
      const disabled = await f.handle.client.getModelSettings('user', { storeId: f.storeId });
      expect(applied.receipt).toHaveProperty('postReadSet', {
        userEtag: disabled.readSet!.userEtag,
        workspaceEtag: disabled.readSet!.workspaceEtag,
        explicitDigest: disabled.readSet!.explicitDigest,
        effectiveDigest: disabled.readSet!.effectiveDigest,
      });
      expect(disabled.defaultModelId).toBe(initialDefault);
      expect(disabled.models.find((model) => model.id === 'a')?.enabled).toBe(false);
      expect(disabled.models.filter((model) => model.enabled).map((model) => model.id)).toEqual([
        'b',
      ]);
      expect(requests.map((request) => request.model)).toEqual(['actual-model-a']);
      expect(await f.handle.client.getRun(original.id)).toEqual(original);
      release!();
      release = undefined;
      const completed = await finishedRun('run-explicit-a');
      expect(completed).toEqual({
        ...original,
        status: 'completed',
        isActive: false,
        finishedAt: expect.any(Number),
      });
      expect(await f.handle.client.getCommand('run-explicit-a')).toEqual(originalCommand);
      expect(requests.map((request) => request.model)).toEqual([
        'actual-model-a',
        'actual-model-a',
      ]);
      const activeInputs = await f.handle.client.listModelInputs('disable-held');
      expect(activeInputs.items).toHaveLength(2);
      for (const item of activeInputs.items) {
        expect(item).toMatchObject({
          runId: original.id,
          originCommandId: original.originCommandId,
          rootWorkCommandId: original.rootWorkCommandId,
          rootWorkSeq: original.rootWorkSeq,
          modelId: 'a',
          status: 'succeeded',
          confirmation: 'succeeded',
        });
        const input = await f.handle.client.getModelInput('disable-held', item.executionId);
        expect(input.request.modelId).toBe('a');
        expect(await f.handle.client.getExecution(item.executionId)).toMatchObject({
          originStoreId: f.storeId,
          sessionId: original.sessionId,
          runId: original.id,
          definitionId: 'a',
          status: 'succeeded',
          cancelRequestedAt: null,
        });
      }
      await f.handle.client.startRun('disable-held', {
        expectedStoreId: f.storeId,
        commandId: 'new-disabled-a',
        kind: 'run.start',
        modelId: 'a',
        content: 'New task: Explicit disabled model must be rejected',
      });
      await until(
        async () => (await f.handle.client.getCommand('new-disabled-a')).status === 'rejected',
      );
      expect(await f.handle.client.getCommand('new-disabled-a')).toMatchObject({
        originStoreId: f.storeId,
        subjectId: originalCommand.subjectId,
        status: 'rejected',
        receipt: { reason: 'model_unavailable' },
        cancelRequestedAt: null,
      });
      expect(requests).toHaveLength(2);
      expect((await f.handle.client.getView('disable-held')).runs).toHaveLength(1);
      if (initialDefault === 'a') {
        const reject = async (commandId: string, modelId?: string) => {
          const count = requests.length;
          await f.handle.client.startRun('disable-held', {
            expectedStoreId: f.storeId,
            commandId,
            kind: 'run.start',
            content: 'New task: A disabled route must not be substituted',
            ...(modelId ? { modelId } : {}),
          });
          await until(
            async () => (await f.handle.client.getCommand(commandId)).status === 'rejected',
          );
          expect(await f.handle.client.getCommand(commandId)).toMatchObject({
            originStoreId: f.storeId,
            subjectId: originalCommand.subjectId,
            status: 'rejected',
            receipt: { reason: 'model_unavailable' },
            cancelRequestedAt: null,
          });
          expect(requests).toHaveLength(count);
        };
        const toggle = async (modelId: string, enabled: boolean) => {
          const before = await f.handle.client.getModelSettings('user', { storeId: f.storeId });
          const result = await f.handle.client.updateModelSettings('user', {
            expectedStoreId: f.storeId,
            commandId: `${modelId}-${enabled}`,
            expectedReadSet: before.readSet!,
            operation: { kind: 'enabled', modelId, enabled },
          });
          const after = await f.handle.client.getModelSettings('user', { storeId: f.storeId });
          expect(result.state).toBe('applied');
          expect(result.receipt).toHaveProperty('postReadSet', after.readSet);
          expect(after.defaultModelId).toBe('a');
          return after;
        };
        // B is still usable, but an omitted model must not silently replace disabled default A.
        await reject('new-disabled-default-a');
        const allDisabled = await toggle('b', false);
        expect(allDisabled.models.every((model) => !model.enabled)).toBe(true);
        await reject('all-disabled-default-a');
        await reject('all-disabled-explicit-b', 'b');
        await expect(
          f.handle.client.updateModelSettings('user', {
            expectedStoreId: f.storeId,
            commandId: 'disabled-b-cannot-be-default',
            expectedReadSet: allDisabled.readSet!,
            operation: { kind: 'default', modelId: 'b' },
          }),
        ).rejects.toMatchObject({ code: 'model_settings_model_disabled' });
        // Editing a connection preserves both disabled routes and the exact default identity.
        const providers = await f.handle.client.getProviderSettings({ storeId: f.storeId });
        const connection = providers.providers.find((entry) => entry.id === 'compatible')!
          .connections[0]!;
        const edit = {
          expectedStoreId: f.storeId,
          commandId: 'edit-connection-with-disabled-default',
          expectedReadSet: providers.readSet!,
          operation: {
            provider: 'compatible' as const,
            connectionId: connection.id,
            name: 'Still disabled',
            baseURL: `${provider.url.href}v1`,
            protocol: 'chat-completions' as const,
            modelNames: ['actual-model-a', 'actual-model-b'],
            credential: 'none' as const,
          },
        };
        const edited = await f.handle.client.updateProviderSettings(edit);
        expect(edited).toMatchObject({
          state: 'applied',
          receipt: {
            status: 'applied',
            credentialState: 'unchanged',
            configurationState: 'published',
          },
        });
        expect(await f.handle.client.updateProviderSettings(edit)).toEqual(edited);
        const retained = await f.handle.client.getModelSettings('user', { storeId: f.storeId });
        expect(retained.defaultModelId).toBe('a');
        expect(retained.models.map((model) => [model.id, model.enabled])).toEqual([
          ['a', false],
          ['b', false],
        ]);
        expect(requests).toHaveLength(2);
        await toggle('a', true);
        await f.handle.client.startRun('disable-held', {
          expectedStoreId: f.storeId,
          commandId: 're-enabled-default-a',
          kind: 'run.start',
          content: 'New task: Re-enabled default A is available again',
        });
        const restoredA = await finishedRun('re-enabled-default-a');
        expect(restoredA.status).toBe('completed');
        await toggle('b', true);
        await f.handle.client.startRun('disable-held', {
          expectedStoreId: f.storeId,
          commandId: 're-enabled-explicit-b',
          kind: 'run.start',
          modelId: 'b',
          content: 'New task: Re-enabled B is available without replacing default A',
        });
        const restoredB = await finishedRun('re-enabled-explicit-b');
        expect(restoredB.status).toBe('completed');
        expect(requests.map((request) => request.model)).toEqual([
          'actual-model-a',
          'actual-model-a',
          'actual-model-a',
          'actual-model-b',
        ]);
        const inputs = await f.handle.client.listModelInputs('disable-held');
        expect(inputs.items.map((item) => [item.runId, item.modelId, item.status])).toEqual([
          [original.id, 'a', 'succeeded'],
          [original.id, 'a', 'succeeded'],
          [restoredA.id, 'a', 'succeeded'],
          [restoredB.id, 'b', 'succeeded'],
        ]);
        expect((await f.handle.client.getRun(original.id)).configuration).toEqual(
          original.configuration,
        );
        return;
      }
      await f.handle.client.startRun('disable-held', {
        expectedStoreId: f.storeId,
        commandId: 'new-default-b',
        kind: 'run.start',
        content: 'New task: Use the enabled default model',
      });
      const next = await finishedRun('new-default-b');
      expect(next.id).not.toBe(original.id);
      expect(next.status).toBe('completed');
      expect(requests.map((request) => request.model)).toEqual([
        'actual-model-a',
        'actual-model-a',
        'actual-model-b',
      ]);
      const inputs = await f.handle.client.listModelInputs('disable-held');
      expect(inputs.items.map((item) => [item.runId, item.modelId, item.status])).toEqual([
        [original.id, 'a', 'succeeded'],
        [original.id, 'a', 'succeeded'],
        [next.id, 'b', 'succeeded'],
      ]);
      expect((await f.handle.client.getRun(original.id)).configuration).toEqual(
        original.configuration,
      );
    } finally {
      release?.();
      provider.stop(true);
      await f.close();
    }
  }, 15000);

test('effort read/write never resolves credentials or models and explicit options remain immutable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-effort-no-io-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(profile.profilePath);
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
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: 'test' });
  let credentialCalls = 0,
    modelCalls = 0;
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
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
