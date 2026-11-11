import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import stringWidth from 'string-width';
import { automaticTitleIdentity } from '../../../../packages/agent/src/business/session-title/state';
import { ptyDeadline, readTuiRender, spawnTuiPTY, terminateTuiTree } from './tui-pty';

const input = JSON.parse(process.argv[2]!) as {
  root: string;
  runner: string;
  transcript: string;
  servicePid: string;
  original: string;
  alignmentParagraph: string;
  responseMarker: string;
  expectedTitle: string;
  databasePath: string;
};
const abort = new AbortController();
const stop = () => abort.abort(Error('ordinary_driver_interrupted'));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const message = (value: unknown) => {
  if (value === 'owned-ink-parity-stop') stop();
};
if (process.platform === 'win32') process.on('message', message);
const open = (sessionId?: string) =>
  spawnTuiPTY({
    cmd: [process.execPath, '--no-install', input.runner, ...(sessionId ? [sessionId] : [])],
    cwd: input.root,
  });
let pty = open();
async function wait(text: string) {
  const until = Date.now() + 15000;
  while (true) {
    abort.signal.throwIfAborted();
    const frame = await pty.projection();
    if (frame.text.includes(text)) return frame.text;
    if (pty.ended || Date.now() > until)
      throw Error(`ordinary_tui_missing:${text}\n${frame.text.slice(-7000)}`);
    await Bun.sleep(25);
  }
}
async function key(value: string) {
  await pty.key(value);
  await Bun.sleep(75);
  await pty.drain();
}
let success = false;
let warmTranscript = '';
try {
  await wait('Exit Kite Code');
  const gate = await pty.projection();
  assert.ok(gate.text.includes('trust') || gate.text.includes('Trust'));
  await key('\u001b[A');
  await key('\r');
  const initial = await wait('❯');
  assert.ok(initial.includes('──◆ Kite Code'));
  assert.ok(!initial.includes('New Run >'));
  await key('/help');
  await key('\r');
  const help = await wait('Shift+Tab');
  assert.ok(help.includes('Help'));
  await key('\u001b');
  await key(`\u001b[200~${input.original}\u001b[201~`);
  const editing = await wait('console.log("user literal");');
  for (const line of input.original.split('\n').filter(Boolean)) assert.ok(editing.includes(line));
  const beforeSubmit = new Database(input.databasePath, { readonly: true });
  try {
    assert.equal(
      (beforeSubmit.query('SELECT count(*) AS count FROM run').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (beforeSubmit.query('SELECT count(*) AS count FROM execution').get() as { count: number })
        .count,
      0,
    );
  } finally {
    beforeSubmit.close();
  }

  const rawBeforeSubmit = pty.text();
  const submittedAt = performance.now();
  await pty.key('\r');
  const submitting = await wait('Submitting…');
  const submitFeedbackMs = Math.round(performance.now() - submittedAt);
  assert.equal(submitting.split('**literal user**').length, 2);
  assert.ok(submitting.indexOf('**literal user**') < submitting.indexOf('Submitting…'));
  assert.ok(
    pty
      .viewport()
      .split('\n')
      .some((line) => line === '❯'),
  );
  const unsent = 'PRESERVE_EDIT_DURING_SEND';
  await key(unsent);
  const edited = await wait(unsent);
  assert.ok(edited.includes('Submitting…'));
  assert.equal(edited.split('**literal user**').length, 2);
  writeFileSync(join(input.root, 'release-post'), 'allow the original request');
  const working = await wait('Working');
  assert.equal(working.split('**literal user**').length, 2);
  assert.ok(working.includes(unsent));
  assert.ok(!working.includes('Submitting…'));
  writeFileSync(join(input.root, 'release-reasoning'), 'allow the original Model to think');
  const thinking = await wait('Thinking');
  assert.equal(thinking.split('Thinking').length, 2);
  assert.ok(thinking.indexOf('**literal user**') < thinking.indexOf('Thinking'));
  assert.ok(thinking.includes(unsent));
  writeFileSync(join(input.root, 'release-response'), 'allow the original Model to finish');
  const completed = await wait(input.responseMarker);
  writeFileSync(join(input.root, 'release-output-read'), 'release any late live prefix read');
  assert.ok(completed.includes('**literal user**'));
  assert.ok(completed.includes('Original table cell'));
  assert.ok(completed.includes('console.log'));
  assert.ok(!completed.includes('Original outcome pending or unknown'));
  const replyRows = completed.split('\n');
  const thoughtRows = replyRows.filter((line) => line.includes('Thinking'));
  assert.ok(thoughtRows.length > 0);
  for (const line of thoughtRows) assert.equal(line.indexOf('Thinking'), 2);
  const heading = replyRows.find((line) => line.includes('Original assistant heading'));
  assert.equal(heading?.indexOf('Original assistant heading'), 2);
  const paragraphStart = replyRows.findIndex((line) => line.includes('ALIGN_BEGIN'));
  const paragraphEnd = replyRows.findIndex((line) => line.includes('ALIGN_END'));
  assert.ok(paragraphStart >= 0 && paragraphEnd > paragraphStart);
  const paragraphRows = replyRows.slice(paragraphStart, paragraphEnd + 1);
  for (const line of paragraphRows) {
    assert.ok(line.startsWith('  '), `Reply continuation lost its indent: ${line}`);
    assert.ok(stringWidth(line) <= 80);
  }
  assert.equal(
    paragraphRows
      .map((line) => line.slice(2))
      .join('')
      .replace(/\s/gu, ''),
    input.alignmentParagraph.replace(/\s/gu, ''),
  );
  const completedUntil = Date.now() + 5000;
  let sessionId: string | undefined;
  for (;;) {
    const db = new Database(input.databasePath, { readonly: true });
    let done: boolean;
    try {
      // The title child can finish before the parent's title Action applies its CAS.
      // Only the original root Run and its durable rename establish safe normal exit.
      const root = db
        .query(
          'SELECT s.id,s.title,r.status,r.is_active,r.origin_store_id,r.origin_command_id FROM session s JOIN run r ON r.session_id=s.id WHERE s.parent_id IS NULL ORDER BY r.started_at DESC LIMIT 1',
        )
        .get() as {
        id: string;
        title: string;
        status: string;
        is_active: number;
        origin_store_id: string;
        origin_command_id: string;
      } | null;
      const rename = root
        ? (db
            .query(
              "SELECT request_json,receipt_json FROM command WHERE session_id=? AND origin_store_id=? AND id=? AND kind='session.rename' AND status='applied'",
            )
            .get(
              root.id,
              root.origin_store_id,
              automaticTitleIdentity(root.origin_store_id, root.id, root.origin_command_id)
                .publicationCommandId,
            ) as { request_json: string; receipt_json: string } | null)
        : null;
      const request = rename ? JSON.parse(rename.request_json) : null;
      const receipt = rename ? JSON.parse(rename.receipt_json) : null;
      done =
        root?.status === 'completed' &&
        root.is_active === 0 &&
        root.title === input.expectedTitle &&
        request?.title === input.expectedTitle &&
        receipt?.outcome === 'renamed' &&
        receipt.session?.id === root.id &&
        receipt.session.title === input.expectedTitle;
      if (done) sessionId = root?.id;
    } finally {
      db.close();
    }
    if (done) break;
    if (Date.now() > completedUntil) throw Error('ordinary_actual_root_title_not_completed');
    await Bun.sleep(25);
  }
  await Bun.sleep(300);
  const after = (await pty.projection()).text;
  assert.ok(after.includes(unsent));
  assert.ok(!after.includes('Working'));
  const afterBytes = pty.text().slice(rawBeforeSubmit.length);
  assert.ok(!afterBytes.includes('builtin.session-title/'));
  const screen = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
  const paint = (data: string) => new Promise<void>((resolve) => screen.write(data, resolve));
  const frames = afterBytes.split('\u001b[?2026l');
  let showedUser = false;
  let showedReply = false;
  let activeWasVisible = false;
  const frameSummary: string[] = [];
  try {
    await paint(rawBeforeSubmit);
    for (const frame of frames.slice(0, -1)) {
      await paint(`${frame}\u001b[?2026l`);
      const text = readTuiRender(screen);
      const userCount = text.split('**literal user**').length - 1;
      const responseCount = text.split(input.responseMarker).length - 1;
      const activity = ['Submitting…', 'Working', 'Loading reply…'].find((label) =>
        text.includes(label),
      );
      const phase = [
        userCount ? 'user' : 'no user',
        activity ?? 'idle',
        text.includes('Thinking') ? 'thought' : '',
        responseCount ? 'reply' : '',
        frame.includes('\u001b[3J') ? 'scrollback cleared' : '',
      ]
        .filter(Boolean)
        .join(' / ');
      if (frameSummary.at(-1) !== phase) frameSummary.push(phase);
      assert.ok(userCount <= 1, 'original input rendered twice');
      assert.ok(responseCount <= 1, 'original answer rendered twice');
      assert.ok(!text.includes('Incomplete response'), 'a successful answer flashed as incomplete');
      assert.ok(!showedUser || userCount === 1, 'original input disappeared during handoff');
      assert.ok(!showedReply || responseCount === 1, 'original answer disappeared during handoff');
      assert.ok(
        !activeWasVisible || activity || responseCount,
        'idle flashed during the active run',
      );
      showedUser ||= userCount === 1;
      showedReply ||= responseCount === 1;
      activeWasVisible ||= !!activity;
    }
    assert.ok(showedUser && showedReply && activeWasVisible);
    assert.ok(!afterBytes.includes('\u001b[3J'), 'a first turn repainted native history');
  } finally {
    screen.dispose();
    console.log(
      `First-turn PTY (${submitFeedbackMs} ms to submission feedback): ${frameSummary.join(' → ')}`,
    );
  }
  async function closeNormally() {
    const servicePid = Number(readFileSync(input.servicePid, 'utf8'));
    await key('\u0011');
    const [code] = await ptyDeadline(
      Promise.all([pty.host.exited, pty.eof]),
      15000,
      'ordinary_tui_exit_timeout',
    );
    assert.equal(code, 0);
    assert.equal(pty.host.signalCode, null);
    const end = Date.now() + 5000;
    while (true) {
      try {
        process.kill(servicePid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
        throw error;
      }
      if (Date.now() > end) throw Error('owned_service_survived_normal_exit');
      await Bun.sleep(25);
    }
  }
  await closeNormally();
  warmTranscript = pty.text();
  pty.close();
  assert.ok(sessionId);
  pty = open(sessionId);
  const reopened = await wait(input.responseMarker);
  assert.equal(reopened.split(input.responseMarker).length, 2);
  assert.equal(reopened.split('**literal user**').length, 2);
  assert.equal(reopened.split('Thinking').length, 2);
  assert.ok(reopened.includes(unsent));
  assert.ok(!reopened.includes('Submitting…'));
  assert.ok(!reopened.includes('Working'));
  assert.ok(!reopened.includes('builtin.session-title/'));
  // Exercise /new from a nonempty history. Enter while the create response
  // is held must not send the next draft to the previous Session.
  await key(`\u001b[200~${'old editor reset '.repeat(10)}\u001b[201~`);
  await key('\u001b');
  await key('/new');
  writeFileSync(join(input.root, 'hold-new-session'), 'hold the original session creation');
  await key('\r');
  await wait('Creating conversation…');
  const nextDraft = 'PRESERVE_DRAFT_FOR_NEW_SESSION';
  await key(nextDraft);
  await key('\r');
  const awaitingCreation = await wait(nextDraft);
  assert.ok(awaitingCreation.includes('Creating conversation…'));
  assert.ok(!awaitingCreation.includes('Submitting…'));
  writeFileSync(join(input.root, 'release-new-session'), 'allow the original session creation');
  const newUntil = Date.now() + 15000;
  for (;;) {
    const frame = (await pty.projection()).text;
    if (!frame.includes(input.responseMarker) && !frame.includes('Creating conversation…')) {
      assert.ok(frame.includes(nextDraft), 'the new Session lost the edit made during creation');
      break;
    }
    if (Date.now() > newUntil) throw Error('ordinary_created_session_not_selected');
    await Bun.sleep(25);
  }
  await closeNormally();
  success = true;
  console.log('ORDINARY_INK_PARITY_RUN_EXIT');
} finally {
  writeFileSync(input.transcript, warmTranscript + pty.text());
  if (!success && !pty.ended) await terminateTuiTree(pty, { exitTimeoutMs: 10000 });
  pty.close();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (process.platform === 'win32') process.removeListener('message', message);
}
