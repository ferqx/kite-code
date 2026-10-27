import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { inspectProcess } from '@kite-ai/service/daemon';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  executable: string;
  script: string;
  preload: string;
  dataRoot: string;
  root: string;
  repo: string;
  provider: string;
  serviceEntry: string;
  evidence: string;
};
const abort = new AbortController();
const interrupt = () => abort.abort(Error('management_driver_interrupted'));
process.once('SIGTERM', interrupt);
process.once('SIGINT', interrupt);
if (process.platform === 'win32')
  process.on('message', (message) => {
    if (message === 'management-driver-stop') interrupt();
  });
let active: ReturnType<typeof spawnTuiPTY> | undefined;
let round = 0;
let failure: unknown;
const cleanupErrors: unknown[] = [];
const receipts: unknown[] = [];
const observationPath = () => `${input.evidence}.service-${round}.json`;
const readOwned = () => {
  const path = observationPath();
  if (!existsSync(path)) throw Error('management_service_observation_missing');
  const record = JSON.parse(readFileSync(path, 'utf8')) as {
    pid: number;
    start: string;
    cmd: string[];
  };
  if (
    !Number.isSafeInteger(record.pid) ||
    !record.start ||
    !record.cmd.includes(input.serviceEntry)
  )
    throw Error('management_service_identity_missing');
  return record;
};
const open = () => {
  round++;
  active = spawnTuiPTY({
    cmd: [
      input.executable,
      '--preload',
      input.preload,
      `${import.meta.dir}/tui-diagnostics-entry.ts`,
      input.script,
      '--thread',
      'a',
      '--data-root',
      input.dataRoot,
    ],
    cwd: input.repo,
    env: {
      KITE_MANAGEMENT_SERVICE_ENTRY: input.serviceEntry,
      KITE_MANAGEMENT_OBSERVATION: observationPath(),
    },
  });
};
const pump = async () => {
  abort.signal.throwIfAborted();
  await Bun.sleep(500);
  await active!.drain();
};
// biome-ignore lint/suspicious/noControlCharactersInRegex: Original terminal control stripping.
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const wait = async (text: string) => {
  const deadline = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await active!.projection();
    const material = active!.sinceAction().replace(ansi, '').replace(/\s+/g, ' ');
    const current = frame.text.replace(/\s+/g, ' ');
    if (frame.fresh && (material.includes(text) || current.includes(text))) return;
    if (active!.ended || Date.now() > deadline)
      throw Error(`expected ${text} tail=${material.slice(-3000)}`);
    await Bun.sleep(100);
  }
};
const key = async (text: string) => {
  abort.signal.throwIfAborted();
  await active!.key(text);
};
const send = async (text: string) => {
  await key(text);
  await wait(text);
  await key('\r');
};
const normalClose = async () => {
  const owned = readOwned();
  const observeEnd = Date.now() + 6000;
  while (!active!.ended && Date.now() < observeEnd) {
    await Bun.sleep(100);
    await active!.drain();
  }
  const [exit] = await ptyDeadline(
    Promise.all([active!.host.exited, active!.eof]),
    3000,
    'management_original_three_second_join',
  );
  assert.equal(exit, 0); // Original Python p.returncode==0, once per actual host.
  const deadline = Date.now() + 3000;
  while (inspectProcess(owned.pid, owned.start) !== 'dead') {
    if (Date.now() > deadline) throw Error('management_owned_service_exit_unknown');
    await Bun.sleep(5);
  }
  const exited = JSON.parse(readFileSync(`${observationPath()}.exit`, 'utf8')) as {
    pid: number;
    start: string;
    code: number;
  };
  assert.equal(exited.pid, owned.pid, 'management_service_exit_pid_mismatch');
  assert.equal(exited.start, owned.start, 'management_service_exit_birth_mismatch');
  assert.equal(exited.code, 0, 'management_service_exit_not_normal');
  receipts.push({
    round,
    pid: active!.host.pid,
    service: owned,
    normal: true,
    code: exit,
    serviceState: 'dead',
    serviceExit: exited,
  });
  writeFileSync(`${input.evidence}.round-${round}.terminal`, active!.text());
  active!.close();
  active = undefined;
};
try {
  open();
  await wait('New Run');
  await send('Owned ordinary task');
  await wait('ORIGINAL_FULL_TAIL');
  await pump();
  await send('New task: Qualifying historical task');
  await wait('QUALIFYING_SETTLED_HISTORY');
  await pump();
  await send('/session rename Managed title');
  await wait('session.rename: applied');
  await pump();
  await send('/context');
  await wait('Current selected Context projection');
  await wait('frozen upper');
  await key('\x1b');
  await pump();
  await send('/compact preserve original facts');
  await wait('context.compress: accepted');
  const compressionMaterial = (await active!.projection()).text.replace(/\s+/g, ' ');
  const compressionOriginal = compressionMaterial.match(
    /Original management a \/ ([a-f0-9-]{36}) context\.compress: accepted/,
  );
  assert.ok(compressionOriginal, 'management_original_compression_identity_unavailable');
  await pump();
  await key('新任务Queued after maintenance');
  await wait('新任务Queued after maintenance');
  // The queued successor must be observed while the original maintenance is held.
  await wait('Queue follow-up after original maintenance Run >');
  await key('\r');
  await wait('input.follow_up');
  writeFileSync(`${input.root}/release-summary`, 'explicit fixture release');
  await pump();
  await key('\x0b');
  await wait('FOLLOWUP_COMPLETED');
  await pump();
  // An already observed original receipt is stable. Repeating its read can
  // correctly leave Ink unchanged, so retain that exact painted qualification.
  const completedCompression = `Original management a / ${compressionOriginal[1]} context.compress: applied`;
  if (!active!.viewport().replace(/\s+/g, ' ').includes(completedCompression)) await key('\x0b');
  await wait(completedCompression);
  await pump();
  await send('/compact reset');
  await pump();
  await key('\x0b');
  await wait('context.compression.reset: failed');
  await key('\x1b');
  await pump();
  const observe = async () => {
    const response = await fetch(`${input.provider}rewind-observation`);
    assert.equal(response.status, 200);
    await response.text();
  };
  await observe();
  await send('/rewind');
  await wait('Files recovery');
  await wait('No recovery points');
  await wait('Reading state: ready');
  await key('\x1b');
  await pump();
  await observe();
  await send('/unknown');
  await wait('tui_command_unavailable');
  await pump();
  for (let remaining = '/unknown'.length - 1; remaining >= 0; remaining--) {
    await key('\x7f');
    await wait(`New Run >${remaining ? ` ${'/unknown'.slice(0, remaining)}` : ''}`);
  }
  await send('/session fork Forked scope');
  await wait('session.fork: applied');
  await pump();
  await send('/session delete confirm');
  await wait('delete_requested');
  await wait('stop unconfirmed');
  await pump();
  await key('\x11');
  await normalClose();
  open();
  await wait('New Run');
  await send('/exit');
  await normalClose();
  console.log('SLASH_COMPLETE_ZERO_REPLAY');
} catch (error) {
  failure = error;
} finally {
  if (active) {
    let owned: ReturnType<typeof readOwned> | undefined;
    let serviceState: 'alive' | 'dead' | 'uncertain' | 'unobserved' = 'unobserved';
    try {
      owned = readOwned();
      serviceState = inspectProcess(owned.pid, owned.start);
      assert.notEqual(serviceState, 'uncertain', 'management_failure_service_identity_unknown');
    } catch (error) {
      cleanupErrors.push(error);
    }
    // Held PTY ownership remains valid even when separate Service identity cannot be read.
    try {
      if (!active.ended)
        await terminateTuiTree(active, {
          exitTimeoutMs: 3000,
          ...(owned && serviceState !== 'uncertain'
            ? { servicePid: owned.pid, requireServiceAlive: serviceState === 'alive' }
            : {}),
        });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await active.drain();
      writeFileSync(`${input.evidence}.round-${round}.terminal`, active.text());
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (owned) serviceState = inspectProcess(owned.pid, owned.start);
    if (owned && serviceState !== 'dead')
      cleanupErrors.push(Error('management_failure_service_exit_unknown'));
    receipts.push({
      round,
      pid: active.host.pid,
      service: owned,
      normal: false,
      code: active.host.exitCode,
      serviceState,
    });
    try {
      active.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  writeFileSync(
    `${input.evidence}.receipts.json`,
    JSON.stringify({
      receipts,
      failure: failure ? String(failure) : null,
      cleanupErrors: cleanupErrors.map(String),
    }),
  );
  if (process.platform === 'win32' && process.connected) process.disconnect?.();
}
if (cleanupErrors.length)
  throw new AggregateError(
    failure ? [failure, ...cleanupErrors] : cleanupErrors,
    'management_cleanup_unknown',
  );
if (failure) throw failure;
