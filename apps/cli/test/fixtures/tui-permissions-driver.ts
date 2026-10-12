import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  runner: string;
  root: string;
  databasePath: string;
  workspace: string;
  evidence: string;
};
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_permissions_driver_interrupted'));
const stop = (message: unknown) => {
  if (message === 'permissions-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', stop);
const output: Uint8Array[] = [];
const owned = spawnTuiPTY({
  cmd: [process.execPath, '--no-install', input.runner],
  cwd: input.root,
  env: {
    HOME: input.root,
    KITE_CODE_HOME: join(input.root, 'owned-home'),
    ...(process.platform === 'win32' ? { USERPROFILE: input.root } : {}),
  },
  onData(bytes) {
    output.push(bytes.slice());
  },
});
const rows = (sql: string) => {
  const db = new Database(input.databasePath, { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
};
const wait = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await owned.projection();
    if (frame.fresh && frame.text.replace(/\s+/g, ' ').includes(text)) return;
    if (Date.now() > end) {
      console.log(
        `FINITE_SQL ${JSON.stringify({
          executions: rows('select kind,adapter_id,state,cancel_requested from execution'),
          interactions: rows(
            'select definition_id,state,accepted_decision_revision,answer_json from interaction',
          ),
          runs: rows('select status from run'),
          commands: rows('select kind,status,request_json,receipt_json from command'),
        })}`,
      );
      throw Error(`expected ${text} tail=${frame.text.slice(-3000)}`);
    }
    if (owned.ended) throw Error(`permission host exited before ${text}`);
    await Bun.sleep(100);
  }
};
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  await owned.key(value);
  await Bun.sleep(200);
};
const pump = async () => {
  await Bun.sleep(400);
  await owned.drain();
};
const send = async (text: string) => {
  await owned.key(text);
  await wait(`New Run > ${text}`);
  await owned.key('\r');
};
let failure: unknown;
let normal = false;
let servicePid: number | undefined;
try {
  await wait('New Run');
  servicePid = Number(readFileSync(join(input.root, 'owned-service-pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(servicePid) && servicePid > 0);
  process.kill(servicePid, 0);
  await send('/permissions');
  await wait('Saved same_command grants: 0');
  await key('t');
  await wait('Confirm original');
  await key('\r');
  await wait('workspace.trust: applied');
  await wait('trusted, revision');
  await pump();
  // Formal request approval admits workspace writes. Explicit Auto with an actual
  // ask_user review exercises the original two independent same-command cards.
  await key('\x1b[B');
  await wait('› 自动审核');
  await key('\r');
  await wait('Confirm original');
  await key('\r');
  await wait('permission.mode: applied');
  await key('\x1b');
  await wait('New Run >');
  await send('owned-1');
  await wait('same_command');
  await key('\r');
  await pump();
  assert.equal(
    (
      rows('select count(*) as n from interaction where answer_json is not null')[0] as {
        n: number;
      }
    ).n,
    0,
  );
  assert.equal(existsSync(join(input.workspace, 'effects')), false);
  await key('\x1b[B');
  await key('\x1b[B');
  await wait('same command in original Session');
  await key('\r');
  await wait('interaction.answer: applied');
  await pump();
  const end = Date.now() + 5000;
  let card: { id: string } | undefined;
  while (!card && Date.now() < end) {
    card = rows(
      "select id from interaction where definition_id='shell.command' and state='pending'",
    )[0] as { id: string } | undefined;
    await pump();
  }
  assert.ok(card);
  await wait(`approval [${card.id}] original Session`);
  await pump();
  await key('\x1b[B');
  await key('\x1b[B');
  await wait('same command in original Session');
  await key('\r');
  await wait('DONE owned-1');
  await pump();
  await send('/permissions');
  await wait('Saved same_command grants: 2');
  await key('\x1b');
  await wait('New Run >');
  await send('owned-2');
  await wait('DONE owned-2');
  await pump();
  await send('/permissions');
  await wait('Saved same_command grants: 2');
  await key('c');
  await wait('Confirm original');
  await key('\r');
  await wait('permission.grants.clear: applied');
  await wait('Saved same_command grants: 0');
  await key('\x1b');
  await wait('New Run >');
  await send('owned-3');
  await wait('same_command');
  await key('\x03');
  await pump();
  await key('\x11');
  const exitEnd = Date.now() + 6000;
  while (!owned.ended && Date.now() < exitEnd) await Bun.sleep(100);
  const [exitCode] = await ptyDeadline(
    Promise.all([owned.host.exited, owned.eof]),
    3000,
    'permission normal exit unconfirmed',
  );
  assert.equal(exitCode, 0);
  assert.throws(() => process.kill(servicePid!, 0));
  normal = true;
  console.log('PERMISSIONS_ORIGINAL_COMPLETE');
} catch (error) {
  failure = error;
} finally {
  try {
    if (!owned.ended) await terminateTuiTree(owned, { exitTimeoutMs: 3000 });
    await owned.drain();
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], 'Permission PTY cleanup failed')
      : error;
  } finally {
    owned.close();
  }
  try {
    writeFileSync(join(input.evidence, 'terminal.bin'), Buffer.concat(output));
    writeFileSync(
      join(input.evidence, 'pty-exit.json'),
      JSON.stringify({
        pid: owned.host.pid,
        servicePid,
        normal,
        code: owned.host.exitCode,
        failure: failure ? String(failure) : null,
      }),
    );
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    if (process.platform === 'win32') {
      process.removeListener('message', stop);
      if (process.connected) process.disconnect?.();
    }
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
