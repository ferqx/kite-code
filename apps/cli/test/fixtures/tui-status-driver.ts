import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { retainProcessObservation } from '@kite-ai/service/daemon';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  runner: string;
  ledger: string;
  databasePath: string;
  storeId: string;
  mode: 'paired' | 'shared' | 'shared-loss';
  profileAccessKey: string;
  profilePath: string;
  ownedService: string;
  evidence: string;
};
const abort = new AbortController();
const interrupt = () => abort.abort(Error('owned_status_driver_interrupted'));
let abruptComplete = false;
let abruptFailure: string | undefined;
const message = (value: unknown) => {
  if (value === 'owned-status-driver-stop') interrupt();
  if (value && typeof value === 'object' && 'type' in value) {
    if (value.type === 'owned-status-daemon-dead') abruptComplete = true;
    if (value.type === 'owned-status-daemon-failed') abruptFailure = 'owned_daemon_stop_failed';
  }
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
process.on('message', message);
const host = spawnTuiPTY({
  cmd: [process.execPath, '--no-install', input.runner],
  cwd: process.cwd(),
});
let service: ReturnType<typeof retainProcessObservation> | undefined;
let servicePid: number | undefined;
let serviceDead: boolean | null = null;
let failure: unknown;
let normal = false;
let forcedCleanup = false;
const rows = () =>
  readFileSync(input.ledger, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const wait = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await host.projection();
    if (frame.fresh && frame.text.replace(/\s+/g, ' ').includes(text)) return;
    if (host.ended || Date.now() > end)
      throw Error(`expected ${text} tail=${frame.text.slice(-6000)}`);
    await Bun.sleep(50);
  }
};
const key = (value: string) => host.key(value);
const closeService = () => {
  if (service) {
    serviceDead = service.inspect() === 'dead';
    if (!serviceDead) throw Error('status_service_cleanup_unknown');
    service.close();
  }
};
try {
  await wait('New Run >');
  if (input.mode === 'paired') {
    const record = JSON.parse(readFileSync(input.ownedService, 'utf8'));
    servicePid = record.pid;
    service = retainProcessObservation(record.pid, record.start);
    assert.equal(service.inspect(), 'alive');
  }
  await key('/status');
  await wait('/status');
  await key('\r');
  await wait('Connection: verified');
  await wait(input.mode === 'paired' ? 'paired' : 'shared');
  await wait('Profile: development');
  await wait('Build: owned-status');
  await wait('Workspace: w');
  await wait('Session: a');
  await wait('Shell: unavailable');
  await wait('Telemetry: disabled');
  const original = rows();
  assert.equal(original.length, 1);
  assert.deepEqual(original[0].scope, { workspaceId: 'w', sessionId: 'a' });
  assert.equal(original[0].identity.storeId, input.storeId);
  await key('r');
  await wait('Connection: unknown');
  await wait('Last confirmed host facts');
  await wait('Build: owned-status');
  assert.equal(host.text().includes('SECRET'), false);
  await key('r');
  await wait('Connection: verified');
  await key('\x03');
  await wait('New Run >');
  assert.equal(rows().length, 3);
  await key('/status');
  await wait('/status');
  await key('\r');
  await wait('Connection: verified');
  if (input.mode === 'shared-loss') {
    if (!process.send) throw Error('status_owned_daemon_ipc_missing');
    process.send({ type: 'owned-status-daemon-abrupt' });
    const end = Date.now() + 10000;
    while (!abruptComplete) {
      abort.signal.throwIfAborted();
      if (abruptFailure) throw Error(abruptFailure);
      if (Date.now() > end) throw Error('owned_status_daemon_exit_unconfirmed');
      await Bun.sleep(50);
    }
    await wait('Connection: unknown');
    await key('r');
    await wait('Current host status unknown');
    await wait('Last confirmed host facts');
    await wait('Build: owned-status');
  }
  await key('\x1b');
  await wait('New Run >');
  const db = new Database(input.databasePath, { readonly: true });
  try {
    assert.equal(db.query('select count(*) from run').values()[0]?.[0], 0);
    assert.equal(db.query('select count(*) from execution').values()[0]?.[0], 0);
    assert.equal(
      db.query("select count(*) from command where kind='command.cancel'").values()[0]?.[0],
      0,
    );
  } finally {
    db.close();
  }
  await key('\x11');
  const end = Date.now() + 6000;
  while (!host.ended && Date.now() < end) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([host.host.exited, host.eof]),
    3000,
    'status_normal_exit_timeout',
  );
  assert.equal(code, 0);
  await host.drain();
  const output = host.text();
  assert.equal(output.includes(input.profileAccessKey), false);
  assert.equal(output.includes(input.profilePath), false);
  assert.equal(output.includes('httpEndpoint'), false);
  if (service) {
    const end = Date.now() + 3000;
    while (service.inspect() !== 'dead') {
      if (Date.now() > end) throw Error('owned_status_service_remains');
      await Bun.sleep(20);
    }
  }
  normal = true;
  console.log('STATUS_ORIGINAL_COMPLETE');
} catch (error) {
  failure = error;
} finally {
  try {
    if (!host.ended) {
      forcedCleanup = true;
      await terminateTuiTree(host, {
        exitTimeoutMs: 3000,
        servicePid,
        serviceExitTimeoutMs: 3000,
        requireServiceAlive: false,
      });
    }
    await host.drain();
    closeService();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Status cleanup failed') : error;
  } finally {
    host.close();
  }
  writeFileSync(`${input.evidence}.pty.log`, host.text(), { mode: 0o600 });
  writeFileSync(
    `${input.evidence}.receipt.json`,
    JSON.stringify({
      platform: process.platform,
      mode: input.mode,
      pid: host.host.pid,
      servicePid,
      serviceDead,
      normal,
      forcedCleanup,
      code: host.host.exitCode,
      signalCode: host.host.signalCode,
      failure: failure ? String(failure) : null,
    }),
    { mode: 0o600 },
  );
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  process.removeListener('message', message);
  if (process.connected) process.disconnect?.();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
