import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startDevelopmentWeb } from '../../src/development-web';
import { launchPairedService } from '../../src/paired';

function gate() {
  let release!: () => void, enter!: () => void;
  return {
    waiting: new Promise<void>((r) => (release = r)),
    entered: new Promise<void>((r) => (enter = r)),
    release: () => release(),
    enter: () => enter(),
  };
}
async function until<T>(read: () => Promise<T> | T, check: (v: T) => boolean) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw Error('lifecycle_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(beforeResourceClose?: () => Promise<void>) {
  const root = mkdtempSync('/private/tmp/kite-http-lifecycle-'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' }),
    store = await openSqliteStore(profile);
  const metadata = await store.getMetadata(),
    runtime = createRuntime({
      store,
      modelId: 'fixed',
      model: createFixedModel([
        [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      ]),
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixed' };
        },
      },
    });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    '// retained\n{"modelId":null,"unknown":true}',
    { mode: 0o600 },
  );
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      kind: 'temporary',
      async put() {},
      async resolve() {
        return null;
      },
      async remove() {},
    },
  });
  const service = await startService({
    runtime,
    beforeResourceClose,
    configurationManagement: host.configurationManagement!(runtime),
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    instanceId: 'lifecycle-test',
    buildId: 'fixed',
  });
  const request = (path: string, init?: RequestInit) =>
    fetch(service.endpoint + path, {
      ...init,
      headers: { authorization: `Bearer ${service.bootstrap.token}`, ...init?.headers },
    });
  const shutdown = (mode: 'if_idle' | 'cancel', extra = {}) =>
    request('/v1/lifecycle/shutdown', {
      method: 'POST',
      body: JSON.stringify({
        lifecycleVersion: 1,
        expectedProfile: service.bootstrap.profile,
        expectedInstanceId: service.bootstrap.instanceId,
        mode,
        ...extra,
      }),
    });
  const lifecycle = async () => await (await request('/v1/lifecycle')).json();
  return {
    root,
    profile,
    metadata,
    store,
    runtime,
    service,
    request,
    shutdown,
    lifecycle,
    async cleanup() {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('authenticated lifecycle is independent and closed; wrong instance/profile/Origin/query and Browser cannot cancel', async () => {
  const f = await fixture();
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  try {
    const initial = await f.lifecycle();
    expect(initial).toMatchObject({
      lifecycleVersion: 1,
      state: 'accepting',
      busy: false,
      reasons: [],
      apiMajor: 1,
      dataAvailability: 'available',
    });
    expect('storeId' in initial).toBe(false);
    expect((await fetch(`${f.service.endpoint}/v1/lifecycle`)).status).toBe(401);
    expect(
      (await f.request('/v1/lifecycle', { headers: { origin: f.service.endpoint } })).status,
    ).toBe(403);
    expect((await f.request('/v1/lifecycle', { headers: { origin: '' } })).status).toBe(403);
    expect((await f.request('/v1/lifecycle?extra=1')).status).toBe(400);
    expect((await f.shutdown('cancel', { expectedInstanceId: 'foreign' })).status).toBe(409);
    expect(
      (await f.shutdown('cancel', { expectedProfile: { ...initial.profile, name: 'foreign' } }))
        .status,
    ).toBe(409);
    expect((await f.shutdown('cancel', { secret: 'never' })).status).toBe(400);
    expect((await f.lifecycle()).state).toBe('accepting');
    const client = createClient({
      endpoint: f.service.endpoint,
      token: f.service.bootstrap.token,
      expected: {
        profile: f.service.bootstrap.profile,
        instanceId: f.service.bootstrap.instanceId,
        buildId: 'fixed',
        apiMajor: 1,
        requiredCapabilities: [],
      },
    });
    await client.connect();
    gateway = startDevelopmentWeb({ admittedClient: client });
    expect((await fetch(`${gateway.endpoint}/v1/lifecycle`)).status).toBeGreaterThanOrEqual(400);
    expect(
      (await fetch(`${gateway.endpoint}/v1/lifecycle/shutdown`, { method: 'POST', body: '{}' }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect((await f.lifecycle()).busy).toBe(false);
    const first = f.service.close(),
      second = f.service.close();
    expect(first).toBe(second);
    await first;
    await f.service.closedPromise;
  } finally {
    await gateway?.close();
    await f.cleanup();
  }
});
test('HTTP slow body makes idle shutdown busy; accepted cancel seals and rejects body without a late Store mutation', async () => {
  const f = await fixture();
  const url = new URL(f.service.endpoint),
    body = JSON.stringify({
      expectedStoreId: f.metadata.storeId,
      id: 'late',
      rootUri: 'file:///late',
      name: 'late',
    });
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  let response = '';
  socket.on('data', (v) => (response += String(v)));
  try {
    await new Promise<void>((r) => socket.once('connect', r));
    socket.write(
      `POST /v1/workspaces HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${f.service.bootstrap.token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, 8)}`,
    );
    await until(f.lifecycle, (v) => v.reasons.includes('admission'));
    expect((await f.shutdown('if_idle')).status).toBe(409);
    expect((await f.lifecycle()).state).toBe('accepting');
    expect((await f.shutdown('cancel')).status).toBe(202);
    await f.service.closedPromise;
    expect(response.includes('201 Created')).toBe(false);
    const db = new Database(f.profile.databasePath, { readonly: true });
    expect(db.query('SELECT COUNT(*) AS n FROM workspace').get()).toEqual({ n: 0 });
    db.close();
  } finally {
    socket.destroy();
    await f.cleanup();
  }
});
test('an admitted configuration file mutation completes original receipt before final resource close; later reads and writes cannot enter', async () => {
  const f = await fixture(),
    held = gate();
  const original = f.runtime.beginHostMutation.bind(f.runtime);
  f.runtime.beginHostMutation = async (input) => {
    const value = await original(input);
    if (input.commandId === 'slow-file') {
      held.enter();
      await held.waiting;
    }
    return value;
  };
  try {
    const observed = await (
      await f.request(`/v1/config/user?storeId=${f.metadata.storeId}`)
    ).json();
    const pending = f.request('/v1/config/user', {
      method: 'PATCH',
      body: JSON.stringify({
        commandId: 'slow-file',
        expectedStoreId: f.metadata.storeId,
        ifMatch: observed.etag,
        operations: [{ kind: 'set', path: ['modelId'], value: 'next' }],
      }),
    });
    await held.entered;
    expect((await f.shutdown('if_idle')).status).toBe(409);
    const accepted = await f.shutdown('cancel');
    expect(accepted.status).toBe(202);
    expect((await f.request('/v1/workspaces')).status).toBe(503);
    expect((await f.lifecycle()).state).toBe('draining');
    expect(readFileSync(join(f.profile.profilePath, 'config.jsonc'), 'utf8')).toContain(
      '"modelId":null',
    );
    held.release();
    const written = await pending;
    expect(written.status).toBe(200);
    expect((await written.json()).state).toBe('applied');
    await f.service.closedPromise;
    expect(readFileSync(join(f.profile.profilePath, 'config.jsonc'), 'utf8')).toContain('next');
    expect(readFileSync(join(f.profile.profilePath, 'config.jsonc'), 'utf8')).toContain(
      '// retained',
    );
    const db = new Database(f.profile.databasePath, { readonly: true });
    expect(db.query("SELECT state FROM host_mutation WHERE id='slow-file'").get()).toEqual({
      state: 'applied',
    });
    db.close();
  } finally {
    held.release();
    await f.cleanup();
  }
});
test('diagnostic no-Store lifecycle shutdown exits actual runner with parent channel open and leaves same-profile peer alive', async () => {
  const root = mkdtempSync('/private/tmp/kite-lifecycle-runner-'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' }),
    entrypoint = join(import.meta.dir, '../fixtures/paired-child.ts');
  const launch = (id: string) =>
    launchPairedService({
      entrypoint,
      profile,
      instanceId: id,
      buildId: 'fixed',
      apiMajor: 1,
      requiredCapabilities: ['commands'],
      hostConfiguration: {
        ledger: join(root, `${id}.ledger`),
        entered: join(root, `${id}.entered`),
        release: join(root, `${id}.release`),
      },
    });
  const first = await launch('first'),
    peer = await launch('peer');
  try {
    const stopped = await fetch(`${first.bootstrap.endpoint}/v1/lifecycle/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.bootstrap.token}` },
      body: JSON.stringify({
        lifecycleVersion: 1,
        expectedProfile: first.bootstrap.profile,
        expectedInstanceId: 'first',
        mode: 'if_idle',
      }),
    });
    expect(stopped.status).toBe(202);
    await until(
      () => {
        try {
          process.kill(first.pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      (v) => v,
    );
    expect(
      (
        await fetch(`${peer.bootstrap.endpoint}/v1/lifecycle`, {
          headers: { authorization: `Bearer ${peer.bootstrap.token}` },
        })
      ).status,
    ).toBe(200);
    expect(existsSync(join(root, 'first.ledger'))).toBe(false);
    expect(existsSync(join(root, 'peer.ledger'))).toBe(false);
    await first.close();
    await peer.close();
    writeFileSync(profile.databasePath, 'damaged original');
    const unavailable = await launch('diagnostic');
    try {
      const info = await (
        await fetch(`${unavailable.bootstrap.endpoint}/v1/lifecycle`, {
          headers: { authorization: `Bearer ${unavailable.bootstrap.token}` },
        })
      ).json();
      expect(info.dataAvailability).toBe('unavailable');
      expect(info.busy).toBe(false);
      const reply = await fetch(`${unavailable.bootstrap.endpoint}/v1/lifecycle/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${unavailable.bootstrap.token}` },
        body: JSON.stringify({
          lifecycleVersion: 1,
          expectedProfile: unavailable.bootstrap.profile,
          expectedInstanceId: 'diagnostic',
          mode: 'cancel',
        }),
      });
      expect(reply.status).toBe(202);
      await until(
        () => {
          try {
            process.kill(unavailable.pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        (v) => v,
      );
      expect(readFileSync(profile.databasePath, 'utf8')).toBe('damaged original');
    } finally {
      await unavailable.close();
    }
  } finally {
    await first.close();
    await peer.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('pure slow GET stays idle but final close waits for its original HTTP resource', async () => {
  const f = await fixture(),
    held = gate();
  const original = f.runtime.listWorkspaces.bind(f.runtime);
  f.runtime.listWorkspaces = async () => {
    const value = await original();
    held.enter();
    await held.waiting;
    return value;
  };
  try {
    const reading = f.request(`/v1/workspaces?storeId=${f.metadata.storeId}`);
    await held.entered;
    expect(await f.lifecycle()).toMatchObject({ state: 'accepting', busy: false, reasons: [] });
    expect((await f.shutdown('if_idle')).status).toBe(202);
    await until(f.lifecycle, (v) => v.state === 'draining');
    expect((await f.request(`/v1/workspaces?storeId=${f.metadata.storeId}`)).status).toBe(503);
    expect((await f.store.getMetadata()).storeId).toBe(f.metadata.storeId);
    let closed = false;
    void f.service.closedPromise.then(() => {
      closed = true;
    });
    await Bun.sleep(10);
    expect(closed).toBe(false);
    held.release();
    expect((await reading).status).toBe(200);
    await f.service.closedPromise;
    expect(closed).toBe(true);
  } finally {
    held.release();
    await f.cleanup();
  }
});

test('actual Store metadata failure is reported unavailable without creating replacement data', async () => {
  const f = await fixture(),
    original = f.store.getMetadata.bind(f.store);
  f.store.getMetadata = async () => {
    throw Error('fixture_store_read_failure');
  };
  try {
    const status = await f.lifecycle();
    expect(status).toMatchObject({
      dataAvailability: 'unavailable',
      state: 'accepting',
      busy: false,
    });
    expect(status.instanceId).toBe(f.service.bootstrap.instanceId);
    expect(status.profile).toEqual(f.service.bootstrap.profile);
    expect(JSON.stringify(status)).not.toContain('fixture_store_read_failure');
  } finally {
    f.store.getMetadata = original;
    expect((await f.store.getMetadata()).storeId).toBe(f.metadata.storeId);
    await f.cleanup();
  }
});

for (const entry of ['lifecycle-failed-child.ts', 'lifecycle-host-failed-child.ts'])
  test(`${entry}: unconfirmed cleanup retains actual runner and diagnostics; repeated shutdown does not pretend completion`, async () => {
    const root = mkdtempSync('/private/tmp/kite-lifecycle-failed-'),
      profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    const child = await launchPairedService({
      entrypoint: join(import.meta.dir, '../fixtures', entry),
      profile,
      instanceId: 'failed',
      buildId: 'fixed',
      apiMajor: 1,
      requiredCapabilities: ['commands'],
      shutdownTimeoutMs: 100,
    });
    const get = async () =>
      await (
        await fetch(`${child.bootstrap.endpoint}/v1/lifecycle`, {
          headers: { authorization: `Bearer ${child.bootstrap.token}` },
        })
      ).json();
    const stop = () =>
      fetch(`${child.bootstrap.endpoint}/v1/lifecycle/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${child.bootstrap.token}` },
        body: JSON.stringify({
          lifecycleVersion: 1,
          expectedProfile: child.bootstrap.profile,
          expectedInstanceId: 'failed',
          mode: 'cancel',
        }),
      });
    try {
      expect((await stop()).status).toBe(202);
      const failed = await until(get, (value) => value.state === 'drain_failed');
      expect(failed.busy).toBe(true);
      expect(failed.reasons).toContain('cleanup');
      expect(failed.instanceId).toBe('failed');
      expect(process.kill(child.pid, 0)).toBe(true);
      expect((await stop()).status).toBe(202);
      expect((await get()).state).toBe('drain_failed');
      expect(
        await createProfileBackup({
          profile: { dataRoot: profile.dataRoot, profile: profile.profile },
          destinationRoot: join(root, 'backup'),
        }).catch((error: unknown) => error),
      ).toMatchObject({ code: 'owner_busy' });
      expect(existsSync(join(root, 'backup'))).toBe(false);
      const db = new Database(profile.databasePath, { readonly: true });
      expect(db.query('SELECT count(*) AS n FROM workspace').get()).toEqual({ n: 0 });
      db.close();
      expect(
        (
          await fetch(`${child.bootstrap.endpoint}/health/live`, {
            headers: { authorization: `Bearer ${child.bootstrap.token}` },
          })
        ).status,
      ).toBe(200);
    } finally {
      // Fixture cleanup owns this exact child; production shutdown did not complete or release it.
      await child.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

test('trusted hook closes Gateway before waiting for its dependent Native GET and before Store close', async () => {
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  let hookCalls = 0;
  const f = await fixture(async () => {
    hookCalls++;
    await gateway?.close();
  });
  const client = createClient({
    endpoint: f.service.endpoint,
    token: f.service.bootstrap.token,
    bootstrap: f.service.bootstrap,
    expected: {
      profile: f.service.bootstrap.profile,
      instanceId: 'lifecycle-test',
      buildId: 'fixed',
      apiMajor: 1,
      requiredCapabilities: ['history'],
    },
  });
  const native = gate();
  const original = f.store.listWorkspaces.bind(f.store);
  const originalRead = client.listWorkspaces.bind(client);
  let aborts = 0,
    storeClosed = false;
  const originalClose = f.store.close.bind(f.store);
  f.store.close = async () => {
    storeClosed = true;
    await originalClose();
  };
  f.store.listWorkspaces = async () => {
    native.enter();
    await native.waiting;
    return original();
  };
  client.listWorkspaces = async (options) => {
    const onAbort = () => {
      aborts++;
      native.release();
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await originalRead(options);
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
    }
  };
  let read: Promise<unknown> | undefined;
  try {
    await client.connect();
    gateway = startDevelopmentWeb({ admittedClient: client });
    const page = await fetch(gateway.endpoint);
    await page.text();
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    read = fetch(`${gateway.endpoint}/browser/v1/workspaces`, {
      headers: { cookie, 'x-kite-web-identity': gateway.pageIdentity },
    })
      .then((reply) => reply.text())
      .catch((error) => error);
    await native.entered;
    expect(storeClosed).toBe(false);
    expect((await f.store.getMetadata()).storeId).toBe(f.metadata.storeId);
    const completion = f.service.close();
    expect(f.service.close()).toBe(completion);
    await completion;
    await read;
    expect(hookCalls).toBe(1);
    expect(aborts).toBe(1);
    expect(storeClosed).toBe(true);
    expect(f.runtime.getLifecycleState().state).toBe('closed');
  } finally {
    native.release();
    await read;
    client.disposeNetwork();
    await gateway?.close();
    await f.cleanup();
  }
});
