import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  entrance: 'slash-task' | 'draft-mode' | 'active-queued' | 'scope-draft';
  root: string;
  workspace: string;
  databasePath: string;
  runner: string;
  firstLost: string;
  transcript: string;
  expectedBodyPath: string;
};
const abort = new AbortController();
const expectedBody = readFileSync(input.expectedBodyPath, 'utf8').normalize().replace(/\s+/g, '');
const interrupted = () => abort.abort(Error('owned_planning_interrupted'));
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
const shutdown = (message: unknown) => {
  if (message === 'owned-planning-stop') interrupted();
};
// Windows TerminateProcess cannot run finally. The private driver channel
// enters the same abort path, which owns termination of its ConPTY subtree.
if (process.platform === 'win32') process.on('message', shutdown);
const pty = spawnTuiPTY({
  cmd: [process.execPath, '--no-install', input.runner],
  cwd: input.root,
  conptyCellWidths: process.platform === 'win32',
  scrollback: 20000,
});
const current = async () => {
  abort.signal.throwIfAborted();
  return pty.projection();
};
const wait = async (text: string) => {
  const end = Date.now() + 8000;
  for (;;) {
    const frame = await current();
    if (frame.fresh && frame.text.replace(/\s+/g, ' ').includes(text)) return;
    if (Date.now() > end) throw Error(`expected ${text} tail=${frame.text.slice(-5000)}`);
    if (pty.ended) throw Error('original Planning host ended');
    await Bun.sleep(50);
  }
};
const waitOriginalAttachment = async () => {
  const end = Date.now() + 8000;
  for (;;) {
    const frame = await current();
    // The whole verified attachment is emitted into real terminal scrollback.
    // Its EOF need not share the finite viewport with the answer choices.
    // ConPTY may repaint its final cells and wrap inside an ASCII marker. Decode
    // the actual terminal cells, then compare every original non-layout character.
    // Ink's wrap-ansi normalizes wrapped text to NFC. Compare canonical
    // equivalents here; the Artifact and saved body retain exact byte checks.
    const emitted = frame.text.normalize().replace(/\s+/g, '');
    if (frame.fresh && emitted.includes(expectedBody)) return;
    if (Date.now() > end) throw Error('original complete Plan attachment was not emitted');
    if (pty.ended) throw Error('original Planning host ended');
    await Bun.sleep(50);
  }
};
const waitViewport = async (text: string) => {
  const end = Date.now() + 8000;
  for (;;) {
    const frame = await current();
    const viewport = pty.viewport().replace(/\s+/g, ' ');
    if (frame.fresh && viewport.includes(text)) return;
    if (Date.now() > end) throw Error(`expected current ${text} viewport=${viewport}`);
    if (pty.ended) throw Error('original Planning host ended');
    await Bun.sleep(50);
  }
};
const key = async (value: string) => {
  await pty.key(value);
  // Preserve the original key's 100ms pump window while native PTY callbacks drain.
  await Bun.sleep(100);
  await pty.drain();
};
const choose = async (id: string, title: string) => {
  await key('\x12');
  await waitViewport('Select Session');
  await key('\t');
  await waitViewport('❯ Search:');
  await key(title);
  await waitViewport(`Search: ${title}`);
  await key('\x1b[B');
  const end = Date.now() + 8000;
  let moved = false;
  for (;;) {
    const frame = await current();
    const viewport = pty.viewport().replace(/\s+/g, ' ');
    if (frame.fresh && viewport.includes(`❯ ${title} [${id}]`)) {
      await key('\r');
      await wait(`Session ${id} ·`);
      return;
    }
    // "Original Plan" also matches "Other original Plan scope". Search does
    // not choose a target: move through the actual remaining two rows.
    if (frame.fresh && !moved && viewport.includes(`${title} [${id}]`)) {
      moved = true;
      await key('\x1b[B');
      continue;
    }
    if (Date.now() > end) throw Error(`original Session target not selected ${id}: ${viewport}`);
    if (pty.ended) throw Error('original Planning host ended');
    await Bun.sleep(50);
  }
};
const planningTask =
  input.entrance === 'active-queued'
    ? 'New task: original single plan 中文🙂'
    : 'original single plan 中文🙂';
const slash = async () => {
  await key(`/plan ${planningTask}`);
  await wait(`/plan ${planningTask}`);
  await key('\r');
};
const readDatabase = <T>(work: (database: Database) => T): T => {
  const database = new Database(input.databasePath, { readonly: true });
  try {
    return work(database);
  } finally {
    database.close();
  }
};
let failure: unknown;
try {
  await wait('New Run >');
  if (input.entrance === 'scope-draft') {
    await choose('b', 'Other original Plan scope');
    await wait('New Run >');
    await key('\x1b[Z');
    await wait('Planning next Run >');
    await key('UNSENT_ORIGINAL_OTHER_PLAN');
    await wait('UNSENT_ORIGINAL_OTHER_PLAN');
    await choose('s', 'Original Plan');
    await wait('New Run >');
    await slash();
  } else if (input.entrance === 'active-queued') {
    await key('original parent task');
    await wait('original parent task');
    await key('\r');
    await wait('Steer original active Run >');
    await slash();
    await wait('input.follow_up: accepted');
    readDatabase((database) => {
      assert.deepEqual(database.query("SELECT COUNT(*) AS n FROM run WHERE session_id='s'").get(), {
        n: 1,
      });
      assert.equal(
        (database.query("SELECT status FROM run WHERE session_id='s'").get() as { status: string })
          .status,
        'running',
      );
    });
    writeFileSync(
      join(input.root, 'original-model-release'),
      'explicit owned original Model release',
    );
  } else if (input.entrance === 'slash-task') {
    await key('\x1b[Z');
    await wait('Planning next Run >');
    await key('\x1b[Z');
    await wait('New Run >');
    await slash();
  } else {
    await key('/plan');
    await wait('/plan');
    await key('\r');
    await wait('Planning next Run >');
    await key('\x1b[Z');
    await wait('New Run >');
    await key('\x1b[Z');
    await wait('Planning next Run >');
    await key(planningTask);
    await wait('original single plan');
    await key('\r');
  }
  await wait('planning.write [');
  // A model's serialized request may already mention plan_review before the
  // interactive card has mounted. Wait for its actual attachment action.
  await waitViewport('Ctrl+A: read required attachment.');
  assert.equal(
    existsSync(join(input.workspace, 'before.txt')),
    false,
    'original Full wrote before plan',
  );
  assert.equal(
    existsSync(join(input.workspace, 'after.txt')),
    false,
    'effect existed before user approval',
  );
  await key('\x01');
  await waitOriginalAttachment();
  for (const choice of [
    '1. Start execution in Auto mode',
    '2. Start execution in Accept edits mode',
    '3. Continue planning with feedback',
  ])
    assert.ok(
      pty.viewport().replace(/\s+/g, ' ').includes(choice),
      `original Plan choice is outside the current viewport: ${choice}\n${pty.viewport()}`,
    );
  await key('\x1b[B');
  await key('\x1b[B');
  await wait('❯ 2. Start execution in Accept edits mode');
  await key('\r');
  await wait('interaction.answer: unknown');
  const firstReadDeadline = Date.now() + 8000;
  while (!existsSync(input.firstLost)) {
    abort.signal.throwIfAborted();
    if (pty.ended || Date.now() > firstReadDeadline)
      throw Error('automatic original answer receipt read did not occur');
    await Bun.sleep(50);
    await pty.drain();
  }
  // The controller retries only the original GET after its first lost response.
  // No key, new request, or approval is needed to recover this receipt.
  await waitViewport('interaction.answer: unknown');
  assert.equal(existsSync(input.firstLost), true);
  await wait('interaction.answer: applied');
  await wait('ORIGINAL_PLAN_ACTUALLY_COMPLETED');
  const end = Date.now() + 8000;
  for (;;) {
    abort.signal.throwIfAborted();
    const run = readDatabase(
      (database) =>
        database
          .query("SELECT status,reason FROM run WHERE session_id='s' ORDER BY rowid DESC LIMIT 1")
          .get() as { status: string; reason: string | null },
    );
    if (run.status === 'completed') break;
    if (Date.now() > end) throw Error(`actual original Run not completed ${JSON.stringify(run)}`);
    await pty.drain();
    await Bun.sleep(50);
  }
  if (input.entrance === 'active-queued') {
    // Verify the removed key after the normal observer has reached Idle, so a
    // concurrent receipt poll cannot be mistaken for an input-triggered read.
    await waitViewport('New Run >');
    const requests = () =>
      readFileSync(join(input.root, 'plan-wire.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; path: string });
    const quietDeadline = Date.now() + 8000;
    let before = requests();
    for (;;) {
      await Bun.sleep(150);
      const after = requests();
      if (JSON.stringify(after) === JSON.stringify(before)) break;
      if (Date.now() > quietDeadline) throw Error('original Idle observer did not settle');
      before = after;
    }
    const displayed = (await current()).text;
    const viewport = pty.viewport();
    await key('\x0c');
    await Bun.sleep(150);
    const frame = await current();
    assert.deepEqual(requests(), before, 'Ctrl+L must not query or submit original requests');
    assert.equal(pty.viewport(), viewport, 'Ctrl+L must not refresh the current display');
    assert.equal(frame.text, displayed, 'Ctrl+L must preserve every currently displayed character');
  }
  if (input.entrance === 'scope-draft') {
    await choose('b', 'Other original Plan scope');
    await wait('Planning next Run >');
    await wait('UNSENT_ORIGINAL_OTHER_PLAN');
  }
  await key('\x11');
  const deadline = Date.now() + 6000;
  while (!pty.ended && Date.now() < deadline) await Bun.sleep(50);
  const [code] = await ptyDeadline(
    Promise.all([pty.host.exited, pty.eof]),
    3000,
    'original Planning host exit timeout',
  );
  assert.equal(code, 0);
  console.log('ORIGINAL_PLAN_PT Y_COMPLETE');
} catch (error) {
  failure = error;
  try {
    const source = readDatabase((database) => ({
      runs: database.query("SELECT id,status,reason FROM run WHERE session_id='s'").all(),
      models: database
        .query(
          "SELECT id,state,result_json FROM execution WHERE session_id='s' AND kind='model' ORDER BY rowid DESC LIMIT 1",
        )
        .all(),
      messages: database
        .query("SELECT id,role,status,source_json FROM message WHERE session_id='s' ORDER BY seq")
        .all()
        .map((row) => {
          const message = row as { id: string; role: string; status: string; source_json: string };
          const source = JSON.parse(message.source_json);
          return {
            id: message.id,
            role: message.role,
            status: message.status,
            source: {
              ...source,
              content:
                typeof source.content === 'string' ? source.content.slice(0, 256) : source.content,
              toolCalls: Array.isArray(source.toolCalls)
                ? source.toolCalls.map((call: { id: string; name: string }) => ({
                    id: call.id,
                    name: call.name,
                  }))
                : source.toolCalls,
            },
          };
        }),
    }));
    writeFileSync(`${input.transcript}.failure-source.json`, JSON.stringify(source, null, 2));
  } catch {
    // Preserve the original failure even if its diagnostic Store is unavailable.
  }
} finally {
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  try {
    if (!pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 3000 });
    await pty.drain();
    pty.close();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Planning PTY failed') : error;
  }
  writeFileSync(input.transcript, pty.text());
  if (process.platform === 'win32') {
    process.removeListener('message', shutdown);
    process.disconnect?.();
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
