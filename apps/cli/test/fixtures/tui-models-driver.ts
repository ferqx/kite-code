import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { retainProcessObservation } from '@kite-ai/service/daemon';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

type Input = {
  runner: string;
  storeId: string;
  databasePath: string;
  count: string;
  callsURL: string;
  releaseURL: string;
  mode: 'paired' | 'shared';
  ownedPath: string;
  transcript: string;
};
const input = JSON.parse(process.argv[2]!) as Input;
const bytes: Uint8Array[] = [];
const pty = spawnTuiPTY({
  cmd: [process.execPath, '--no-install', input.runner],
  cwd: process.cwd(),
  env: { TERM: 'xterm-256color', FORCE_COLOR: '3' },
  onData: (chunk) => bytes.push(chunk.slice()),
});
const abort = new AbortController();
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());
if (process.platform === 'win32')
  process.on('message', (message) => {
    if (message === 'models-driver-stop') abort.abort();
  });
let normal = false;
let failure: unknown;
let owner: ReturnType<typeof retainProcessObservation> | undefined;
let service: { pid: number; start: string } | undefined;
const wait = async (text: string) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    abort.signal.throwIfAborted();
    const frame = await pty.projection();
    if (frame.fresh && frame.text.replace(/\s+/g, ' ').includes(text)) return;
    if (pty.ended) throw Error(`models host ended before ${text}`);
    await Bun.sleep(50);
  }
  const db = new Database(input.databasePath, { readonly: true });
  try {
    console.error(
      'FINITE_MUTATIONS',
      db.query('select kind,state,safe_request_json,receipt_json from host_mutation').all(),
    );
  } finally {
    db.close();
  }
  throw Error(`expected ${text} tail=${pty.text().slice(-5000)}`);
};
const key = async (value: string) => {
  await pty.key(value);
  await Bun.sleep(150);
};
const send = async (text: string) => {
  await key(text);
  await wait(text);
  await key('\r');
};
const requests = async () => await (await fetch(input.callsURL)).json();
const cleanup = async () => {
  if (!pty.ended)
    await terminateTuiTree(pty, {
      exitTimeoutMs: 9000,
      servicePid: service?.pid,
      requireServiceAlive: false,
    });
  await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    3000,
    'models actual caller cleanup unknown',
  );
  await pty.drain();
  if (owner && owner.inspect() !== 'dead') throw Error('models owned Service cleanup unknown');
  owner?.close();
  pty.close();
};
try {
  await wait('› Exit Kite Code');
  await key('\x1b[B');
  await wait('› Trust this workspace and continue');
  await key('\r');
  await wait('New Run');
  const trustDb = new Database(input.databasePath, { readonly: true });
  try {
    const saved = trustDb
      .query(
        "SELECT id,origin_store_id,scope,state,safe_request_json,receipt_json FROM host_mutation WHERE kind='workspace.trust'",
      )
      .all() as {
      id: string;
      origin_store_id: string;
      scope: string;
      state: string;
      safe_request_json: string;
      receipt_json: string;
    }[];
    assert.equal(saved.length, 1);
    const original = saved[0]!;
    assert.equal(original.origin_store_id, input.storeId);
    assert.equal(original.scope, 'workspace:w');
    assert.equal(original.state, 'applied');
    const request = JSON.parse(original.safe_request_json),
      receipt = JSON.parse(original.receipt_json);
    assert.equal(request.workspaceId, 'w');
    assert.equal(request.trusted, true);
    assert.equal(request.ifRevision, '0');
    assert.equal(receipt.trusted, true);
    assert.equal(receipt.revision, '1');
    assert.equal(receipt.canonicalIdentity, request.canonicalIdentity);
    assert.equal(receipt.externalReadScopeDigest, request.externalReadScopeDigest);
  } finally {
    trustDb.close();
  }
  if (input.mode === 'paired') {
    service = JSON.parse(readFileSync(input.ownedPath, 'utf8'));
    if (!service || typeof service.start !== 'string')
      throw Error('models original Service identity missing');
    owner = retainProcessObservation(service.pid, service.start);
    if (owner.inspect() !== 'alive') throw Error('models original Service not alive');
  }
  await send('/permissions');
  await wait('Workspace w: trusted, revision 1');
  await key('\x1b');
  await wait('New Run');
  await send('held-original');
  const end = Date.now() + 5000;
  while ((await requests()).length !== 1) {
    abort.signal.throwIfAborted();
    if (Date.now() > end) throw Error('held provider not entered');
    await Bun.sleep(20);
  }
  await wait('Steer original active Run >');
  await send('/model');
  await wait('Desired default: one');
  await key('\x1b[B');
  await wait('compatible');
  await wait('❯ two');
  await key('\r');
  await wait('outcome_unknown');
  await key('\r');
  await wait('model_settings_original_outcome_required');
  await key('k');
  await wait('Desired default: two');
  assert.deepEqual(await requests(), [{ model: 'one' }]);
  await key('\x1b');
  await wait('Steer original active Run >');
  await send('/effort');
  await wait('❯ Default');
  for (const value of ['none', 'minimal']) {
    await key('\x1b[B');
    await wait(`❯ ${value}`);
  }
  for (const value of ['none', 'Default', 'max', 'high', 'medium', 'low']) {
    await key('\x1b[A');
    await wait(`❯ ${value}`);
  }
  for (const value of ['medium', 'high']) {
    await key('\x1b[B');
    await wait(`❯ ${value}`);
  }
  await key('\r');
  await wait('high Current');
  assert.deepEqual(await requests(), [{ model: 'one' }]);
  await key('\x1b');
  await (await fetch(input.releaseURL)).text();
  await wait('DONE one');
  await wait('New Run >');
  await send('next-original');
  await wait('DONE two');
  assert.deepEqual(await requests(), [
    { model: 'one' },
    { model: 'two', reasoning_effort: 'high' },
  ]);
  const db = new Database(input.databasePath, { readonly: true });
  try {
    assert.equal(
      (
        db
          .query(
            "select count(*) AS n from host_mutation where json_extract(safe_request_json,'$.modelSettings') is not null",
          )
          .get() as { n: number }
      ).n,
      2,
    );
    writeFileSync(
      `${input.transcript}.facts.json`,
      JSON.stringify({
        modelRequests: await requests(),
        mutations: db
          .query('select kind,state,safe_request_json,receipt_json from host_mutation')
          .all(),
        postCount: readFileSync(input.count, 'utf8'),
      }),
    );
  } finally {
    db.close();
  }
  assert.equal(readFileSync(input.count, 'utf8'), 'post\npost\n');
  await key('\x11');
  const exitEnd = Date.now() + 6000;
  while (!pty.ended && Date.now() < exitEnd) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    3000,
    'models host exit timeout',
  );
  assert.equal(code, 0);
  if (owner && owner.inspect() !== 'dead') throw Error('models owned Service exit unknown');
  if (service) {
    const exit = JSON.parse(readFileSync(`${input.ownedPath}.exit`, 'utf8'));
    if (exit.code !== 0 || exit.pid !== service.pid || exit.start !== service.start)
      throw Error('models original Service exit not normal');
    writeFileSync(`${input.transcript}.service-exit.json`, JSON.stringify({ ...exit, dead: true }));
  }
  normal = true;
  console.log('MODEL_ORIGINAL_COMPLETE');
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanup();
  } catch (cleanup) {
    failure = new AggregateError(
      failure ? [failure, cleanup] : [cleanup],
      'models driver cleanup unknown',
      { cause: failure },
    );
  }
  writeFileSync(input.transcript, Buffer.concat(bytes));
  writeFileSync(
    `${input.transcript}.exit.json`,
    JSON.stringify({
      pid: pty.host.pid,
      service,
      serviceExitConfirmed: normal && input.mode === 'paired',
      normal,
      code: pty.host.exitCode,
      signalCode: pty.host.signalCode,
      failure: failure ? String(failure) : null,
    }),
  );
  if (process.platform === 'win32' && process.connected) process.disconnect?.();
}
if (failure) throw failure;
