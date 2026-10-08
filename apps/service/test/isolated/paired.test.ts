import { dlopen } from 'bun:ffi';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  formatServiceStartupReport,
  launchPairedService,
  PairedServiceError,
} from '../../src/paired';

const entrypoint = join(import.meta.dir, '../fixtures/paired-child.ts');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-paired-lifecycle-'));
  const profile = selectProfile({ dataRoot: join(root, 'new/data'), profile: 'disposable' });
  const host = (name: string) => ({
    ledger: join(root, `${name}.ledger`),
    entered: join(root, `${name}.entered`),
    release: join(root, `${name}.release`),
    logToken: true,
  });
  const launch = (instanceId: string, hostConfiguration = host(instanceId)) =>
    launchPairedService({
      entrypoint,
      profile,
      instanceId,
      buildId: 'fixture-build',
      apiMajor: 1,
      requiredCapabilities: ['commands', 'events'],
      hostConfiguration,
    });
  return { root, profile, host, launch };
}
async function until<T>(read: () => Promise<T> | T, condition: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (condition(value)) return value;
    if (Date.now() >= deadline) throw new Error('Fixture event deadline');
    await Bun.sleep(10);
  }
}
function lockAvailable(path: string) {
  const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
  });
  const fd = openSync(path, 'r');
  try {
    const acquired = libc.symbols.flock(fd, 6) === 0;
    if (acquired) libc.symbols.flock(fd, 8);
    return acquired;
  } finally {
    closeSync(fd);
    libc.close();
  }
}

test.each([
  'api',
  'capability',
] as const)('paired %s mismatch creates only startup schema and cleans its own child', async (mismatch) => {
  const data = fixture();
  try {
    expect(existsSync(data.profile.dataRoot)).toBe(false);
    const failure = await launchPairedService({
      entrypoint,
      profile: data.profile,
      instanceId: 'mismatch',
      buildId: 'fixture-build',
      apiMajor: mismatch === 'api' ? 2 : 1,
      requiredCapabilities: mismatch === 'capability' ? ['unsupported'] : ['commands'],
      hostConfiguration: data.host('mismatch'),
    }).then(
      () => null,
      (error) => error,
    );
    expect(failure).toMatchObject({
      code: mismatch === 'api' ? 'api_major_incompatible' : 'required_capability_missing',
    });
    const db = new Database(data.profile.databasePath, { readonly: true });
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({
        count: 1,
      });
      expect(db.query('SELECT COUNT(*) AS count FROM command').get()).toEqual({ count: 0 });
      expect(db.query('SELECT COUNT(*) AS count FROM execution').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    if (process.platform !== 'win32')
      expect(lockAvailable(join(data.profile.coordinationPath, 'profile-use.lock'))).toBe(true);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}, 20_000);

test('actual default Store failure survives failed admission as a bounded diagnostic; external repair permits an explicit new launch', async () => {
  const data = fixture(),
    original = 'private database bytes /private/user credential session-content';
  mkdirSync(data.profile.profilePath, { recursive: true, mode: 0o700 });
  writeFileSync(data.profile.databasePath, original, { mode: 0o600 });
  const options = {
    entrypoint: join(import.meta.dir, '../../src/main.ts'),
    profile: data.profile,
    instanceId: 'diagnostic',
    buildId: 'diagnostic-build',
    apiMajor: 1,
    requiredCapabilities: ['file_recovery'],
  };
  let unexpected: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  try {
    const failure = await launchPairedService(options).then(
      (service) => {
        unexpected = service;
        return null;
      },
      (error) => error,
    );
    expect(failure).toBeInstanceOf(PairedServiceError);
    expect(failure.code).toBe('required_capability_missing');
    expect(failure.startupDiagnostic).toEqual({ code: 'data_unavailable', stage: 'opening_store' });
    const report = formatServiceStartupReport(failure.startupDiagnostic);
    expect(report).not.toContain('private');
    expect(report).not.toContain('credential');
    expect(report).not.toContain('session-content');
    expect(readFileSync(data.profile.databasePath, 'utf8')).toBe(original);
    if (process.platform !== 'win32')
      expect(lockAvailable(join(data.profile.coordinationPath, 'profile-use.lock'))).toBe(true);
    // Repair is a fixture action, never a client overwrite or old-data migration.
    rmSync(data.profile.databasePath);
    const retry = await launchPairedService({ ...options, instanceId: 'explicit-retry' });
    try {
      expect(retry.bootstrap.storeId).toBeString();
      expect(retry.startupDiagnostic).toBeUndefined();
    } finally {
      await retry.close();
    }
    expect(await retry.exited).toBe(0);
  } finally {
    await unexpected?.close();
    rmSync(data.root, { recursive: true, force: true });
  }
}, 20_000);

test('two actual paired children distinguish network disconnect from parent EOF and release only their own resources', async () => {
  const data = fixture();
  const hostA = data.host('a');
  const hostB = data.host('b');
  const first = await data.launch('service-a', hostA);
  const second = await data.launch('service-b', hostB);
  try {
    expect(first.pid).not.toBe(second.pid);
    expect(first.bootstrap.profile).toEqual({
      dataRoot: data.profile.dataRoot,
      name: data.profile.profile,
      accessKey: data.profile.profileAccessKey,
    });
    expect(first.bootstrap.instanceId).toBe('service-a');
    expect(first.client.serverInfo).toMatchObject({
      instanceId: 'service-a',
      buildId: 'fixture-build',
      apiMajor: 1,
    });
    const storeId = first.bootstrap.storeId!;
    await first.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: `file://${data.root}`,
      name: 'Disposable',
    });
    await first.client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'session',
      workspaceId: 'workspace',
      title: 'Paired',
    });
    await first.client.startRun('session', {
      expectedStoreId: storeId,
      commandId: 'first-work',
      kind: 'run.start',
      content: 'count once',
    });
    await until(() => existsSync(hostA.entered), Boolean);
    const sse = await fetch(`${first.bootstrap.endpoint}/v1/events?storeId=${storeId}&after=0`, {
      headers: { authorization: `Bearer ${first.bootstrap.token}` },
    });
    const reader = sse.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    first.client.disposeNetwork();
    expect(existsSync(hostA.ledger)).toBe(false);
    writeFileSync(hostA.release, 'release');
    await first.client.connect();
    await until(
      () => first.client.getView('session'),
      (view) => view.runs[0]?.status === 'completed',
    );
    expect(readFileSync(hostA.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    await second.client.createSession({
      expectedStoreId: storeId,
      commandId: 'create-other',
      sessionId: 'other',
      workspaceId: 'workspace',
      title: 'Other owner',
    });
    await second.client.startRun('other', {
      expectedStoreId: storeId,
      commandId: 'other-work',
      kind: 'run.start',
      content: 'remain alive',
    });
    await until(() => existsSync(hostB.entered), Boolean);
    expect((await second.client.getView('other')).runs[0]!.isActive).toBe(true);
    // Hold the next original Execution, then end only A's private parent pipe.
    rmSync(hostA.release);
    rmSync(hostA.entered);
    await first.client.startRun('session', {
      expectedStoreId: storeId,
      commandId: 'closing-work',
      kind: 'run.start',
      content: 'cancel on EOF',
    });
    await until(() => existsSync(hostA.entered), Boolean);
    const closingCursor = (await first.client.getView('session')).snapshotCursor;
    const closingStream = await fetch(
      `${first.bootstrap.endpoint}/v1/events?storeId=${storeId}&after=${closingCursor}`,
      { headers: { authorization: `Bearer ${first.bootstrap.token}` } },
    );
    const closingReader = closingStream.body!.getReader();
    expect((await closingReader.read()).done).toBe(false);
    const unrelatedFailure = await launchPairedService({
      entrypoint,
      profile: data.profile,
      instanceId: 'failed-third',
      buildId: 'fixture-build',
      apiMajor: 2,
      requiredCapabilities: [],
      hostConfiguration: data.host('failed-third'),
    }).then(
      () => null,
      (error) => error,
    );
    expect(unrelatedFailure).toMatchObject({ code: 'api_major_incompatible' });
    expect((await second.client.getView('other')).runs[0]!.isActive).toBe(true);
    await first.close();
    expect((await closingReader.read()).done).toBe(true);
    expect(await first.exited).toBe(0);
    expect(first.diagnostics.every((code) => !code.includes(first.bootstrap.token))).toBe(true);
    expect(first.diagnostics).toContain('unstructured_service_log');
    const cancelled = await second.client.getView('session');
    expect(cancelled.runs.find((run) => run.originCommandId === 'closing-work')!.status).toBe(
      'cancelled',
    );
    expect(readFileSync(hostA.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    expect((await second.client.getView('other')).runs[0]!.isActive).toBe(true);
    expect(existsSync(hostB.ledger)).toBe(false);
    // B can own the same Session after EOF, without replaying A's completed work.
    writeFileSync(hostB.release, 'release');
    await until(
      () => second.client.getView('other'),
      (view) => view.runs[0]?.status === 'completed',
    );
    await second.client.startRun('session', {
      expectedStoreId: storeId,
      commandId: 'survivor',
      kind: 'run.start',
      content: 'fresh work',
    });
    const survivingView = await until(
      () => second.client.getView('session'),
      (view) => {
        const run = view.runs.find((item) => item.originCommandId === 'survivor');
        return !!run && !run.isActive;
      },
    );
    expect(survivingView.runs.find((run) => run.originCommandId === 'survivor')).toMatchObject({
      status: 'completed',
      reason: null,
    });
    expect(readFileSync(hostB.ledger, 'utf8').trim().split('\n')).toHaveLength(2);
    expect((await second.client.getView('session')).runs).toHaveLength(3);
    if (process.platform !== 'win32')
      expect(lockAvailable(join(data.profile.coordinationPath, 'profile-use.lock'))).toBe(false);
    await second.close();
    expect(await second.exited).toBe(0);
    if (process.platform !== 'win32')
      expect(lockAvailable(join(data.profile.coordinationPath, 'profile-use.lock'))).toBe(true);
    const reopened = await openSqliteStore({
      dataRoot: data.profile.dataRoot,
      profile: data.profile.profile,
    });
    try {
      const owner = await reopened.acquireSessionOwner('session', 'probe');
      expect(owner).not.toBeNull();
      await reopened.releaseSessionOwner(owner!);
      expect((await reopened.getView('session')).runs).toHaveLength(3);
      expect(readFileSync(hostB.ledger, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    await second.close();
    rmSync(data.root, { recursive: true, force: true });
  }
}, 30_000);

test('oversized stdout bootstrap fails within its own bounded launch', async () => {
  const data = fixture();
  try {
    const error = await launchPairedService({
      entrypoint: join(import.meta.dir, '../fixtures/oversized-bootstrap.ts'),
      profile: data.profile,
      instanceId: 'oversized',
      buildId: 'fixture-build',
      apiMajor: 1,
      requiredCapabilities: [],
      shutdownTimeoutMs: 100,
    }).then(
      () => null,
      (failure) => failure,
    );
    expect(error).toMatchObject({ code: 'bootstrap_too_large' });
    expect(existsSync(data.profile.dataRoot)).toBe(false);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
}, 10_000);

test('a real damaged Store remains diagnostic and never masquerades as an empty session list', async () => {
  const data = fixture();
  mkdirSync(data.profile.profilePath, { recursive: true, mode: 0o700 });
  writeFileSync(data.profile.databasePath, 'not a SQLite database');
  const service = await data.launch('damaged');
  try {
    expect(service.bootstrap.dataAvailability).toBe('unavailable');
    expect(service.client.serverInfo!.dataAvailability).toBe('unavailable');
    const response = await fetch(`${service.bootstrap.endpoint}/v1/sessions`, {
      headers: { authorization: `Bearer ${service.bootstrap.token}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'data_unavailable' });
    expect(service.diagnostics).toContain('data_unavailable');
  } finally {
    await service.close();
    rmSync(data.root, { recursive: true, force: true });
  }
}, 20_000);
