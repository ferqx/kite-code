import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  root: string;
  runner: string;
  network: string;
  profilePath: string;
  storeId: string;
  paste: string;
  expected: string;
  transcript: string;
};
const abort = new AbortController();
const interrupted = () => abort.abort(Error('owned_composer_interrupted'));
const stop = (message: unknown) => {
  if (message === 'composer-driver-stop') interrupted();
};
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
if (process.platform === 'win32') process.on('message', stop);
const pty = spawnTuiPTY({ cmd: [process.execPath, '--no-install', input.runner], cwd: input.root });
const pump = async () => {
  abort.signal.throwIfAborted();
  await Bun.sleep(100);
  await pty.drain();
};
const key = async (value: string) => {
  abort.signal.throwIfAborted();
  await pty.key(value);
  await pump();
};
// biome-ignore lint/suspicious/noControlCharactersInRegex: Preserve the original key-after PTY material check.
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const wait = async (text: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const material = pty.sinceAction().replace(ansi, '').replace(/\s+/g, ' ');
    if (material.includes(text)) return;
    if (Date.now() > end) throw Error(`expected ${text} tail=${pty.sinceAction().slice(-6000)}`);
    if (pty.ended) throw Error(`original composer host ended before ${text}`);
    await pump();
  }
};
const waitSelection = async (current: string, target: string) => {
  const end = Date.now() + 10000;
  for (;;) {
    abort.signal.throwIfAborted();
    const frame = await pty.projection();
    const lines = frame.text.split('\n');
    if (
      frame.fresh &&
      lines.some((line) => line.startsWith(`Session ${current} · `)) &&
      lines.some((line) => line.includes('Select Session (arrows/Enter, Esc)')) &&
      lines.some((line) => line.trimStart().startsWith(`❯ ${target}`))
    ) {
      console.log(`COMPOSER_SELECTION_FRAME ${current} -> ${target}`);
      return;
    }
    if (Date.now() > end)
      throw Error(
        `expected current Session ${current} chooser target ${target} tail=${frame.text.slice(-6000)}`,
      );
    if (pty.ended) throw Error('original composer host ended before Session selection');
    await pump();
  }
};
const waitFile = async (path: string) => {
  const end = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw Error('owned model request did not enter');
    await pump();
  }
};
type SessionObservation = {
  storeId: string;
  id: string;
  workspaceId: string;
  parentSessionId: string | null;
  rootSessionId?: string;
  ownerGeneration: string;
};
type WireRow = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  observedSession?: SessionObservation;
};
const wire = () =>
  readFileSync(input.network, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as WireRow);
const reconciliationSession = (row: WireRow) =>
  ['composer', 's'].find((id) => row.path === `/v1/sessions/${id}/reconcile`);
const reconciliations = () =>
  wire().filter((row) => row.method === 'POST' && reconciliationSession(row));
const businessWrites = () => {
  const views = new Map<string, SessionObservation>();
  const writes: WireRow[] = [];
  for (const row of wire()) {
    if (row.observedSession) views.set(row.path, row.observedSession);
    if (row.method !== 'POST') continue;
    const sessionId = reconciliationSession(row);
    if (!sessionId) {
      writes.push(row);
      continue;
    }
    // Only lifecycle requests bound to a preceding actual View may be excluded.
    // An unknown POST, an extra field or a different scope still fails this test.
    const observed = views.get(`/v1/sessions/${sessionId}/view`);
    assert.ok(observed, `reconciliation lacks its original Session View: ${row.path}`);
    assert.deepEqual(
      {
        storeId: observed.storeId,
        id: observed.id,
        workspaceId: observed.workspaceId,
        parentSessionId: observed.parentSessionId,
        rootSessionId: observed.rootSessionId ?? observed.id,
      },
      {
        storeId: input.storeId,
        id: sessionId,
        workspaceId: 'w',
        parentSessionId: null,
        rootSessionId: sessionId,
      },
    );
    assert.match(observed.ownerGeneration, /^(0|[1-9]\d*)$/u);
    const digest = createHash('sha256')
      .update(JSON.stringify([input.storeId, sessionId, observed.ownerGeneration]))
      .digest('hex');
    assert.deepEqual(row.body, {
      expectedStoreId: input.storeId,
      commandId: `session-reconcile-${digest}`,
      expectedOwnerGeneration: observed.ownerGeneration,
    });
  }
  return writes;
};
let failure: unknown;
try {
  await wait('New Run');
  await key('/rec');
  await wait('/recovery');
  await key('\x1b');
  await key('o');
  await wait('/recovery');
  await key('\t');
  await wait('/recovery');
  assert.deepEqual(businessWrites(), []);
  assert.equal(reconciliations().length, 2);
  for (let i = 0; i < 9; i++) await key('\x7f');
  await key('前中🙂e\u0301后');
  await key('\x1b[H');
  await key('首');
  await key('\x1b[F');
  await key('\x1b[D');
  await key('\x7f');
  await key('改');
  await key('\x1b[F');
  await key(`\x1b[200~REMOVE_BLOCK\n${'discard '.repeat(30)}\x1b[201~`);
  await wait('Pasted');
  assert.deepEqual(businessWrites(), []);
  await key('\x7f');
  assert.deepEqual(businessWrites(), []);
  await key(`\x1b[200~${input.paste}\x1b[201~`);
  await wait('Pasted');
  assert.deepEqual(businessWrites(), []);
  await key('\r');
  await wait('Steer original active Run');
  await waitFile(join(input.root, 'composer-model-entered'));
  assert.equal(businessWrites().length, 1);
  assert.equal(businessWrites()[0]!.body!.content, input.expected);
  await key('A中🙂e\u0301Z');
  await key('\x1b[H');
  await key('\x1b[C');
  await key('\x1b[3~');
  await key('\x1b[F');
  await key('\x1b[D');
  await key('\x7f');
  await key('\x1b\r');
  await key('\x1b[A');
  await key('行');
  await key('\x1b[B');
  await key('\x1b[H');
  await key('次');
  assert.equal(businessWrites().length, 1);
  const draftDeadline = Date.now() + 5000;
  for (;;) {
    const drafts = JSON.parse(readFileSync(join(input.profilePath, 'ui/tui.json'), 'utf8'));
    if (
      drafts.drafts.some(
        (row: { sessionId: string; text: string }) =>
          row.sessionId === 'composer' && row.text === '行A🙂\n次Z',
      )
    )
      break;
    if (Date.now() > draftDeadline)
      throw Error(`exact held draft not durable: ${JSON.stringify(drafts)}`);
    await pump();
  }
  await key('\x1b[F');
  for (let i = 0; i < 6; i++) await key('\x7f');
  writeFileSync(join(input.root, 'composer-model-release'), 'explicit owned model release');
  await wait('approval [');
  await key('\x1b[B');
  await wait('❯ Deny');
  await key('\x1b[B');
  await wait('❯ Allow once');
  await wait('Approve this execution only');
  await key('\r');
  await wait('RECOVERED_ORIGINAL_DONE');
  assert.equal(businessWrites().length, 2);
  await key('\x1b[A');
  await wait('Pasted');
  assert.equal(businessWrites().length, 2);
  await key('\x1b[B');
  assert.equal(businessWrites().length, 2);
  await key('\x12');
  await wait('Select Session');
  await key('\x1b[B');
  await waitSelection('composer', 'Original recovery [s]');
  await key('\r');
  await wait('Session s');
  await key('ORIGINAL_SCOPE_TEXT');
  await wait('ORIGINAL_SCOPE_TEXT');
  await key('\x12');
  await wait('Select Session');
  await key('\x1b[A');
  await waitSelection('s', 'Composer [composer]');
  await key('\r');
  await wait('Session composer');
  await key('COMPOSER_SCOPE_TEXT');
  await wait('COMPOSER_SCOPE_TEXT');
  await key('\x12');
  await wait('Select Session');
  await key('\x1b[B');
  await waitSelection('composer', 'Original recovery [s]');
  await key('\r');
  await wait('Session s');
  await wait('ORIGINAL_SCOPE_TEXT');
  assert.equal(businessWrites().length, 2);
  assert.deepEqual(
    reconciliations().map((row) => reconciliationSession(row)),
    ['composer', 'composer', 's', 'composer', 's'],
  );
  await key('\x11');
  const end = Date.now() + 6000;
  while (!pty.ended && Date.now() < end) await pump();
  const [code] = await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    3000,
    'original composer host exit timeout',
  );
  assert.equal(code, 0);
  console.log('COMPOSER_REAL_UTF8_ONCE');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  if (process.platform === 'win32') {
    process.removeListener('message', stop);
    if (process.connected) process.disconnect?.();
  }
  try {
    if (!pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 3000 });
    await pty.drain();
    pty.close();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'composer PTY failed') : error;
  }
  writeFileSync(input.transcript, pty.text());
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
