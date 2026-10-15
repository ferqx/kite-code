import assert from 'node:assert/strict';
import { appendFileSync, closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, type TuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  root: string;
  evidence: string;
  controlURL: string;
  runner: string;
};
const abort = new AbortController();
const interrupt = () => abort.abort(Error('owned_tools_driver_interrupted'));
const stop = (message: unknown) => {
  if (message === 'mcp-tools-driver-stop') interrupt();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
if (process.platform === 'win32') process.on('message', stop);
const hosts: TuiPTY[] = [];
let active!: TuiPTY;
let phase: 'warm' | 'cold' = 'warm';
const current = async () => {
  abort.signal.throwIfAborted();
  return active.projection();
};
const normalized = (text: string) => text.replace(/\s+/g, ' ');
const wait = async (text: string, compact = false) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    const value = normalized(frame.text);
    if (frame.fresh && (compact ? value.replace(/ /g, '') : value).includes(text)) return;
    if (Date.now() > end) throw Error(`expected ${text} tail=${value.slice(-5000)}`);
    if (active.ended) throw Error(`original Tools host ended before ${text}`);
    await Bun.sleep(50);
  }
};
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  await active.key(value);
};
const control = async (path: string) =>
  ptyDeadline(
    (async () => {
      const response = await fetch(new URL(path, input.controlURL), {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw Error(`owned_tools_control_failed:${path}:${response.status}`);
      return (await response.json()) as { indices: number[]; readyExecutionId: string };
    })(),
    12000,
    `owned_tools_control_deadline:${path}`,
  );
const start = async () => {
  active = spawnTuiPTY({
    cmd: [process.execPath, '--no-install', input.runner],
    cwd: input.root,
    env: {
      HOME: input.root,
      ...(process.platform === 'win32' ? { USERPROFILE: input.root } : {}),
      KITE_CODE_HOME: join(input.root, 'owned-home'),
    },
  });
  hosts.push(active);
  const fd = openSync(join(input.evidence, 'pids.jsonl'), 'a', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ phase, tuiPid: active.host.pid })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await wait('New Run >');
};
const waitSeed = async (executionId: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = await current();
    const value = normalized(frame.text);
    if (
      frame.fresh &&
      value.replace(/ /g, '').includes(`"executionId":"${executionId}"`) &&
      value.includes('toolsMetadata') &&
      value.includes('New Run >') &&
      !value.includes('Up/Down explicit approval selection:')
    ) {
      writeFileSync(
        join(input.evidence, 'ready-frame.json'),
        JSON.stringify({ executionId, frame: value }),
      );
      return;
    }
    if (Date.now() > end) throw Error(`original refresh not rendered ready: ${value.slice(-5000)}`);
    if (active.ended) throw Error('original Tools host ended before refresh ready');
    await Bun.sleep(50);
  }
};
const frame = async (generation: number, kind: string) => {
  const value = await current();
  appendFileSync(
    join(input.evidence, 'frames.jsonl'),
    `${JSON.stringify({ phase, generation, kind, frame: normalized(value.text) })}\n`,
  );
};
const chooseMenu = async (label: string) => {
  const end = Date.now() + 10000;
  for (let index = 0; index < 32; index++) {
    const observed = await active.projection();
    const text = normalized(observed.text);
    if (text.includes(`❯ ${label}`)) return;
    if (!text.includes('❯')) {
      if (Date.now() > end) throw Error(`owned_tools_menu_absent:${label}`);
      await Bun.sleep(50);
      index--;
      continue;
    }
    await key('\x1b[B');
    for (;;) {
      const next = await active.projection();
      if (next.fresh && normalized(next.text) !== text) break;
      if (Date.now() > end) throw Error(`owned_tools_menu_deadline:${label}`);
      await Bun.sleep(50);
    }
  }
  throw Error(`owned_tools_menu_unavailable:${label}`);
};
const tools = async (indices: number[], generation: number) => {
  await key('/mcp');
  await wait('New Run > /mcp');
  await key('\r');
  await wait('Server list ready');
  await chooseMenu('Saved tool snapshots');
  await wait('❯ Saved tool snapshots');
  await key('\r');
  await wait('Generation ');
  if (indices[generation - 1]) await key('\x1b[B'.repeat(indices[generation - 1]!));
  await wait(`❯ Generation ${generation}`);
  await key('\r');
  await wait('Tools 1');
  await key('\x1b[B'.repeat(32));
  await wait('❯ Next tools');
  await key('\r');
  await wait('Tools 33');
  await key('\r');
  await wait('Complete metadata');
  await key('\x1b[F');
  await wait(`FULL_METADATA_TAIL_V${generation}_终点😀`);
  await frame(generation, 'metadataTail');
  await key('\x1b[D'.repeat(2));
  await wait(`INPUT_SCHEMA_TAIL_V${generation}_终点😀`, true);
  await frame(generation, 'inputSchemaTail');
  await key('\x03');
  await wait('New Run >');
};
const close = async () => {
  await key('\x11');
  const end = Date.now() + 6000;
  while (!active.ended && Date.now() < end) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([active.host.exited, active.eof]),
    3000,
    'owned_tools_normal_exit_unconfirmed',
  );
  assert.equal(code, 0);
  appendFileSync(
    join(input.evidence, 'exits.jsonl'),
    `${JSON.stringify({ pid: active.host.pid, exit: code })}\n`,
  );
};
let failure: unknown;
try {
  await start();
  const seeded = await control('seed');
  await waitSeed(seeded.readyExecutionId);
  await tools(seeded.indices, 1);
  await tools(seeded.indices, 2);
  await control('check');
  await close();
  await control('cold');
  phase = 'cold';
  await start();
  const cold = await control('check');
  await tools(cold.indices, 1);
  await tools(cold.indices, 2);
  await control('check');
  await close();
  console.log('ORIGINAL_TOOLS_WARM_COLD_COMPLETE');
} catch (error) {
  failure = error;
} finally {
  try {
    if (active) writeFileSync(join(input.evidence, 'final-frame.txt'), active.sinceAction());
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Tools evidence failed') : error;
  }
  for (const host of hosts) {
    try {
      if (!host.ended) await terminateTuiTree(host, { exitTimeoutMs: 3000 });
      await host.drain();
      host.close();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Tools PTY failed') : error;
    }
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  if (process.platform === 'win32') {
    process.removeListener('message', stop);
    if (process.connected) process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
