import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  clearDeadDaemonEndpoint,
  readDaemonReservation,
  requestDaemonBootstrap,
  reserveDaemonEndpoint,
  selectDaemonEndpoint,
} from '../../src/daemon/endpoint';
import { readProcessStartIdentity } from '../../src/daemon/process-identity';

const input = {
  httpEndpoint: 'http://127.0.0.1:12345',
  token: 'x'.repeat(64),
  webOrigin: 'http://127.0.0.1:12346',
};
function fixture() {
  const root = mkdtempSync('/private/tmp/kite-daemon-leaf-'),
    p = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const profile = { dataRoot: p.dataRoot, name: p.profile, accessKey: p.profileAccessKey },
    endpoint = selectDaemonEndpoint({
      profileAccessKey: p.profileAccessKey,
      explicitSocket: join(root, 's.sock'),
    });
  return {
    root,
    profile,
    endpoint,
    identity: { profile, instanceId: 'original', buildId: 'fixed', workspace: root },
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
async function raw(path: string, value: string) {
  return await new Promise<string>((resolve, reject) => {
    const s = createConnection(path);
    let text = '';
    s.setTimeout(2000, () => s.destroy(Error('timeout')));
    s.on('data', (v) => (text += v));
    s.on('error', reject);
    s.on('close', () => resolve(text));
    s.once('connect', () => s.end(value));
  });
}
test('pure short canonical profile selector and absent observation create no paths', () => {
  const f = fixture();
  try {
    const d = selectDaemonEndpoint({ profileAccessKey: f.profile.accessKey });
    expect(Buffer.byteLength(d.socket)).toBeLessThanOrEqual(103);
    expect(existsSync(d.root)).toBe(false);
    expect(readDaemonReservation(d)).toBeUndefined();
    expect(existsSync(d.root)).toBe(false);
    expect(existsSync(f.profile.dataRoot)).toBe(false);
    expect(() =>
      selectDaemonEndpoint({ profileAccessKey: f.profile.accessKey, platform: 'win32' }),
    ).toThrow('unsupported');
    expect(() =>
      selectDaemonEndpoint({
        profileAccessKey: f.profile.accessKey,
        explicitSocket: `/private/tmp/${'界'.repeat(40)}`,
      }),
    ).toThrow('invalid_endpoint');
  } finally {
    f.clean();
  }
});
test('reservation precedes Store and exact finite bootstrap; malformed/large frames never grant a second protocol', async () => {
  const f = fixture(),
    owner = await reserveDaemonEndpoint(f.endpoint, f.identity);
  try {
    expect(existsSync(f.profile.dataRoot)).toBe(false);
    const start = readProcessStartIdentity(process.pid);
    expect(start).toBeDefined();
    if (!start) throw Error('fixture_missing_kernel_identity');
    expect(owner.reservation.processStartIdentity).toBe(start);
    expect(owner.reservation.socket).toBeUndefined();
    await expect(requestDaemonBootstrap(f.endpoint, f.profile)).rejects.toThrow('not_ready');
    await owner.listen(input);
    const result = await requestDaemonBootstrap(f.endpoint, f.profile);
    expect(result).toMatchObject({
      ...input,
      profile: f.profile,
      instanceId: 'original',
      workspace: f.root,
      pid: process.pid,
    });
    expect(readFileSync(f.endpoint.record, 'utf8')).not.toContain(input.token);
    await expect(
      requestDaemonBootstrap(f.endpoint, { ...f.profile, name: 'foreign' }),
    ).rejects.toThrow('identity_mismatch');
    expect(
      await raw(
        f.endpoint.socket,
        `${JSON.stringify({ requestVersion: 1, requestId: 'one', operation: 'bootstrap', command: 'run' })}\n`,
      ),
    ).toBe('');
    expect(await raw(f.endpoint.socket, 'x'.repeat(16385))).toBe('');
    expect((await requestDaemonBootstrap(f.endpoint, f.profile)).instanceId).toBe('original');
    const a = owner.close(),
      b = owner.close();
    expect(a).toBe(b);
    await a;
    expect(existsSync(f.endpoint.socket)).toBe(false);
    expect(existsSync(f.endpoint.record)).toBe(false);
  } finally {
    await owner.close();
    f.clean();
  }
});
test('prebound fd close preserves foreign pathname replacement and owner record on inode drift', async () => {
  const f = fixture(),
    owner = await reserveDaemonEndpoint(f.endpoint, f.identity);
  await owner.listen(input);
  const record = readFileSync(f.endpoint.record, 'utf8');
  try {
    renameSync(f.endpoint.socket, `${f.endpoint.socket}.moved`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f.endpoint.socket, 'harmless', { mode: 0o600 });
    await expect(owner.close()).rejects.toThrow('drift');
    expect(readFileSync(f.endpoint.socket, 'utf8')).toBe('harmless');
    expect(readFileSync(f.endpoint.record, 'utf8')).toBe(record);
    expect(existsSync(`${f.endpoint.socket}.moved`)).toBe(true);
  } finally {
    f.clean();
  }
});
test('unsafe existing parent and symlink namespace are rejected without chmod or Store creation', async () => {
  const f = fixture();
  try {
    chmodSync(f.root, 0o777);
    await expect(reserveDaemonEndpoint(f.endpoint, f.identity)).rejects.toThrow('unsafe');
    expect(existsSync(f.endpoint.record)).toBe(false);
    expect(existsSync(f.profile.dataRoot)).toBe(false);
    chmodSync(f.root, 0o700);
    const link = `${f.root}-link`;
    symlinkSync(f.root, link);
    try {
      const endpoint = selectDaemonEndpoint({
        profileAccessKey: f.profile.accessKey,
        explicitSocket: `${link}/s.sock`,
      });
      await expect(
        reserveDaemonEndpoint(endpoint, { ...f.identity, workspace: f.root }),
      ).rejects.toThrow('unsafe');
    } finally {
      rmSync(link);
    }
    await expect(
      reserveDaemonEndpoint(f.endpoint, { ...f.identity, workspace: 'file:///fake' }),
    ).rejects.toBeDefined();
  } finally {
    f.clean();
  }
});
test('actual two processes compete; alive evidence survives, kill then exact cold dead cleanup is explicit', async () => {
  const f = fixture(),
    entry = join(import.meta.dir, '../fixtures/daemon-endpoint-child.ts');
  const launch = (id: string) =>
    Bun.spawn([process.execPath, entry, f.root, f.endpoint.socket, id], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const a = launch('first');
  let b: ReturnType<typeof launch> | undefined;
  try {
    const reader = a.stdout.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const record = JSON.parse(new TextDecoder().decode(first.value));
    reader.releaseLock();
    expect(record.instanceId).toBe('first');
    expect(clearDeadDaemonEndpoint(f.endpoint, record)).toEqual({
      outcome: 'blocked',
      reason: 'alive',
    });
    b = launch('second');
    const output = await new Response(b.stdout).text();
    expect(await b.exited).toBe(1);
    expect(JSON.parse(output).error).toBe('daemon_endpoint_busy');
    expect((await requestDaemonBootstrap(f.endpoint, f.profile)).instanceId).toBe('first');
    a.kill('SIGKILL');
    await a.exited;
    const cold = readDaemonReservation(f.endpoint)!;
    expect(cold).toEqual(record);
    expect(existsSync(f.profile.dataRoot)).toBe(false);
    renameSync(f.endpoint.socket, `${f.endpoint.socket}.moved`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f.endpoint.socket, 'foreign', { mode: 0o600 });
    expect(clearDeadDaemonEndpoint(f.endpoint, cold)).toEqual({
      outcome: 'blocked',
      reason: 'drift',
    });
    expect(readFileSync(f.endpoint.socket, 'utf8')).toBe('foreign');
    rmSync(f.endpoint.socket);
    renameSync(`${f.endpoint.socket}.moved`, f.endpoint.socket);
    expect(clearDeadDaemonEndpoint(f.endpoint, cold)).toEqual({ outcome: 'cleared' });
    expect(readDaemonReservation(f.endpoint)).toBeUndefined();
    expect(existsSync(f.profile.dataRoot)).toBe(false);
  } finally {
    a.kill('SIGKILL');
    await a.exited;
    if (b) {
      b.kill('SIGKILL');
      await b.exited;
    }
    f.clean();
  }
}, 15000);

test('private record link/mode and replacement identity fail closed; cold reads never open Store', async () => {
  const f = fixture(),
    owner = await reserveDaemonEndpoint(f.endpoint, f.identity);
  try {
    chmodSync(f.endpoint.record, 0o644);
    expect(() => readDaemonReservation(f.endpoint)).toThrow('unsafe');
    chmodSync(f.endpoint.record, 0o600);
    linkSync(f.endpoint.record, `${f.endpoint.record}.hard`);
    expect(() => readDaemonReservation(f.endpoint)).toThrow('unsafe');
    rmSync(`${f.endpoint.record}.hard`);
    renameSync(f.endpoint.record, `${f.endpoint.record}.old`);
    symlinkSync(`${f.endpoint.record}.old`, f.endpoint.record);
    expect(() => readDaemonReservation(f.endpoint)).toThrow();
    rmSync(f.endpoint.record);
    writeFileSync(f.endpoint.record, readFileSync(`${f.endpoint.record}.old`), { mode: 0o600 });
    await expect(owner.close()).rejects.toThrow('drift');
    expect(existsSync(f.endpoint.record)).toBe(true);
    expect(existsSync(f.profile.dataRoot)).toBe(false);
  } finally {
    f.clean();
  }
});

test('closing during fd handoff shares cleanup and closes bounded bootstrap connections', async () => {
  const f = fixture(),
    owner = await reserveDaemonEndpoint(f.endpoint, f.identity);
  try {
    const opening = owner.listen(input);
    const pending = opening.catch((error) => error);
    const close = owner.close();
    expect(owner.close()).toBe(close);
    await close;
    await pending;
    expect(existsSync(f.endpoint.socket)).toBe(false);
    expect(existsSync(f.endpoint.record)).toBe(false);
    expect(existsSync(f.profile.dataRoot)).toBe(false);
  } finally {
    await owner.close();
    f.clean();
  }
});

test('orphan socket with no record is unknown and ordinary reserve never overwrites or creates a record', async () => {
  const f = fixture();
  try {
    writeFileSync(f.endpoint.socket, 'unowned', { mode: 0o600 });
    expect(() => readDaemonReservation(f.endpoint)).toThrow('identity_unknown');
    await expect(requestDaemonBootstrap(f.endpoint, f.profile)).rejects.toMatchObject({
      code: 'daemon_identity_unknown',
    });
    await expect(reserveDaemonEndpoint(f.endpoint, f.identity)).rejects.toMatchObject({
      code: 'daemon_identity_unknown',
    });
    expect(readFileSync(f.endpoint.socket, 'utf8')).toBe('unowned');
    expect(existsSync(f.endpoint.record)).toBe(false);
    expect(existsSync(f.profile.dataRoot)).toBe(false);
  } finally {
    f.clean();
  }
});
