import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  root: string;
  workspace: string;
  databasePath: string;
  ledger: string;
  runner: string;
  settings: object;
  control: string;
};
const abort = new AbortController();
const interrupt = () => abort.abort(Error('skills driver interrupted'));
const stop = (message: unknown) => {
  if (message === 'skills-driver-stop') interrupt();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
if (process.platform === 'win32') process.on('message', stop);
const host = spawnTuiPTY({
  cmd: [process.execPath, '--no-install', input.runner],
  cwd: process.cwd(),
  env: {
    TUI_SKILLS_SETTINGS: JSON.stringify(input.settings),
    HOME: input.root,
    ...(process.platform === 'win32' ? { USERPROFILE: input.root } : {}),
  },
});
const wait = async (text: string, exactLine = false) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await host.projection();
    if (
      frame.fresh &&
      (exactLine
        ? frame.text.split('\n').includes(text)
        : frame.text.replace(/\s+/g, ' ').includes(text))
    )
      return;
    if (Date.now() > end) throw Error(`expected ${text} tail=${host.text().slice(-6000)}`);
    if (host.ended) throw Error(`skills host ended before ${text}`);
    await Bun.sleep(50);
  }
};
const key = (value: string) => host.key(value);
const rows = () =>
  readFileSync(input.ledger, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as {
    value: {
      entries: { id: string; state: string; missingCapabilities?: string[] }[];
      complete: boolean;
      revision: string;
    };
  }[];
const counts = () => {
  const db = new Database(input.databasePath, { readonly: true });
  try {
    return Object.fromEntries(
      ['session', 'run', 'execution', 'command', 'host_mutation'].map((table) => [
        table,
        (db.query(`select count(*) as count from ${table}`).get() as { count: number }).count,
      ]),
    );
  } finally {
    db.close();
  }
};
let failure: unknown;
try {
  await wait('New Run >');
  const baseline = counts();
  // Startup command completion also reads the catalogue. Finish that real read
  // before measuring the explicit panel's independent, complete pagination.
  const initialReadDeadline = Date.now() + 5000;
  while (!existsSync(input.ledger) || !rows().at(-1)?.value.complete) {
    abort.signal.throwIfAborted();
    if (Date.now() > initialReadDeadline) throw Error('startup catalogue did not finish');
    await Bun.sleep(10);
  }
  const firstPanelPage = rows().length;

  await key('/skills');
  await wait('/skills');
  await key('\r');
  await wait('Knowledge Skills');
  await wait('total 304');
  await wait('Catalog read: verified');
  await wait('Guide000 [available]');
  await wait('a001-disabled [disabled]');
  await wait('a002-broken [unavailable]');
  await wait('a003-missing [unavailable]');
  await key('\x1b[B'.repeat(303));
  await wait('Entry 304/304');
  await wait('g299 [available]');
  await key('\x1b[A'.repeat(303));
  await wait('Entry 1/304');
  await wait('Guide000 [available]');
  const original = rows().slice(firstPanelPage);
  assert.ok(original.length > 1);
  const entries = original.flatMap((page) => page.value.entries);
  assert.equal(entries.length, 304);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 304);
  assert.ok(original.at(-1)!.value.complete);
  assert.equal(new Set(original.map((page) => page.value.revision)).size, 1);
  assert.equal(entries.find((entry) => entry.id === 'a002-broken')!.state, 'unavailable');
  assert.equal(entries.find((entry) => entry.id === 'a001-disabled')!.state, 'disabled');
  assert.deepEqual(entries.find((entry) => entry.id === 'a003-missing')!.missingCapabilities, [
    'fixture.unavailable',
  ]);
  await key('\r');
  await Bun.sleep(100);
  assert.deepEqual(counts(), baseline);
  writeFileSync(join(input.root, 'arm-owned-page'), 'next original refresh first page');
  await key('r');
  const held = Date.now() + 5000;
  while (!existsSync(join(input.root, 'held-page'))) {
    abort.signal.throwIfAborted();
    if (Date.now() > held) throw Error('refresh did not request original page');
    await Bun.sleep(10);
  }
  await key('\x1b');
  await wait('New Run >');
  await key('\x12');
  await wait('Select Session');
  await key('\x1b[B');
  await wait('❯ Beta [b]');
  await key('\r');
  await wait('Session b · Idle');
  writeFileSync(
    join(input.workspace, 'a000', 'SKILL.md'),
    '---\nname: ScopeFresh000\ndescription: refreshed real file\n---\nKnowledge only; never execute script.sh\n',
  );
  await key('/skills');
  await wait('/skills');
  await key('\r');
  await wait('Catalog read: verified');
  await wait('ScopeFresh000 [available]');
  const release = await fetch(new URL('release-page', input.control), { signal: abort.signal });
  await release.arrayBuffer();
  await Bun.sleep(200);
  await key('\x1b[B');
  await wait('ScopeFresh000 [available]');
  await key('\x1b[A');
  await wait('ScopeFresh000 [available]');
  assert.deepEqual(counts(), baseline);
  await key('\x1b');
  await wait('Session b');
  await key('/skills');
  await wait('/skills');
  await key('\r');
  await wait('ScopeFresh000 [available]');
  await wait('Read only');
  assert.deepEqual(counts(), baseline);
  assert.equal(existsSync(join(input.root, 'script-effect')), false);
  await key('\x03');
  await wait('New Run >');
  await key('\x11');
  const end = Date.now() + 6000;
  while (!host.ended && Date.now() < end) await Bun.sleep(50);
  const [exit] = await ptyDeadline(
    Promise.all([host.host.exited, host.eof]),
    3000,
    'skills normal exit timeout',
  );
  assert.equal(exit, 0);
  assert.deepEqual(counts(), baseline);
  console.log('SKILLS_ORIGINAL_COMPLETE');
} catch (error) {
  failure = error;
} finally {
  try {
    if (!host.ended) await terminateTuiTree(host, { exitTimeoutMs: 3000 });
    await host.drain();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'skills failed') : error;
  } finally {
    host.close();
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
