import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ptyDeadline, spawnTuiPTY, terminateTuiTree } from './tui-pty';

type Settings = {
  root: string;
  runner: string;
  databasePath: string;
  evidence: string;
  scenario: 'replan' | 'waive' | 'cancel';
};
async function main(settings: Settings) {
  const questionOutput: Uint8Array[] = [];
  let questionSubmitted = false;
  const host = spawnTuiPTY({
    cmd: [process.execPath, '--no-install', settings.runner],
    cwd: process.cwd(),
    onData: (bytes) => {
      if (questionSubmitted) questionOutput.push(bytes.slice());
    },
  });
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once('SIGINT', interrupt);
  const stop = (message: unknown) => {
    if (message === 'workflow-question-driver-stop') interrupt();
  };
  if (process.platform === 'win32') process.on('message', stop);
  const read = <T>(work: (db: Database) => T) => {
    const db = new Database(settings.databasePath, { readonly: true });
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Preserve original-question material across explicit Ctrl+L display clears.
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
  const wait = async (text: string, latestReady = false, material = false) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (interrupted) throw Error('workflow question driver interrupted');
      const frame = await host.projection();
      const lines = frame.text.split('\n').map((line) => line.trim());
      const candidate = material
        ? Buffer.concat(questionOutput).toString('utf8').replace(ansi, '')
        : frame.text;
      if (
        (material || frame.fresh) &&
        candidate.replace(/\s+/g, ' ').includes(text) &&
        (!latestReady ||
          (lines.includes('Session s · Waiting for answer') &&
            lines.includes('Question 2/2') &&
            lines.includes(`Answer > ${text}`)))
      )
        return;
      if (host.ended) throw Error(`host ended before ${text}`);
      await Bun.sleep(50);
    }
    throw Error(`expected ${text} tail=${host.text().slice(-5000)}`);
  };
  const key = (value: string) => host.key(value);
  const until = async <T>(readValue: () => T, match: (value: T) => boolean, message: string) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (interrupted) throw Error('workflow question driver interrupted');
      const value = readValue();
      if (match(value)) return value;
      await Bun.sleep(50);
    }
    throw Error(message);
  };
  const seen = new Set<string>();
  const card = async (kind: string, definition?: string) => {
    const selected = await until(
      () =>
        read((db) =>
          (
            db
              .query("SELECT id,request_json FROM interaction WHERE kind=? AND state='pending'")
              .all(kind) as { id: string; request_json: string }[]
          ).find(
            (row) =>
              !seen.has(row.id) &&
              (definition === undefined ||
                JSON.parse(row.request_json).definitionId === definition),
          ),
        ),
      (value) => value !== undefined,
      `missing pending ${kind} ${definition}`,
    );
    seen.add(selected!.id);
    await wait(selected!.id.slice(0, 24));
    return selected!.id;
  };
  const approve = async (definition: string) => {
    await card('approval', definition);
    await key('\x1b[B');
    await wait('only this call');
    await key('\r');
  };
  const snapshot = (stage: string) => {
    const facts = read((db) =>
      Object.fromEntries(
        ['run', 'command', 'execution', 'interaction', 'extension_record'].map((table) => [
          table,
          db.query(`SELECT * FROM ${table}`).all(),
        ]),
      ),
    );
    appendFileSync(
      join(settings.evidence, 'stages.jsonl'),
      `${JSON.stringify({ stage, tuiPid: host.host.pid, tuiExit: host.host.exitCode, facts })}\n`,
    );
  };
  const completed = async () => {
    snapshot('final-body-visible');
    const original = read(
      (db) =>
        (
          db.query("SELECT run_id FROM interaction WHERE kind='question'").get() as {
            run_id: string;
          }
        ).run_id,
    );
    await until(
      () =>
        read(
          (db) =>
            (db.query('SELECT status FROM run WHERE id=?').get(original) as { status: string })
              .status,
        ),
      (state) => {
        if (['cancelled', 'failed', 'interrupted'].includes(state))
          throw Error(`original Run terminal ${state}`);
        return state === 'completed';
      },
      `original Run completion not confirmed ${original}`,
    );
    snapshot('original-completed-before-quit');
  };
  let failure: unknown;
  try {
    await wait('New Run >');
    await key('/alpha-skill original verification task');
    await wait('/alpha-skill original verification task');
    await key('\r');
    await approve('complete_skill');
    await approve('skill.workflow.verify');
    await approve('decide_skill_verification');
    await card('question');
    if (settings.scenario === 'cancel') {
      await key('\x03');
      await wait('command.cancel: applied');
      await key('\x03');
      await until(
        () => read((db) => (db.query('SELECT status FROM run').get() as { status: string }).status),
        (state) => state === 'cancelled',
        'original Run cancellation not confirmed',
      );
    } else {
      await wait('Question 1/2 · Selection: No selection (Enter has no answer)');
      const selection = settings.scenario === 'replan' ? 1 : 2;
      await key('\x1b[B'.repeat(selection));
      await wait(`Question 1/2 · Selection: ${selection}`);
      await key('\r');
      await wait('Question 2/2');
      const detail = 'original explicit user instruction';
      await key(detail);
      await wait(detail, true);
      await host.drain();
      // Only this original Question's final Enter opens the material window.
      // Ctrl+L can clear display history while the original answer is recovered.
      questionSubmitted = true;
      await key('\r');
      await wait('interaction.answer: unknown');
      await key('\x0c');
      await until(
        () => existsSync(join(settings.root, 'first-get-lost')),
        Boolean,
        'original question answer GET loss not confirmed',
      );
      await wait('interaction.answer: unknown');
      assert.ok(existsSync(join(settings.root, 'first-get-lost')));
      await key('\x0c');
      await wait('interaction.answer: applied');
      if (settings.scenario === 'replan') {
        await approve('complete_skill');
        await approve('skill.workflow.verify');
      }
      await wait('WORKFLOW_DECISION_DONE', false, true);
      await completed();
    }
    await key('\x11');
    const end = Date.now() + 6000;
    while (!host.ended && Date.now() < end) await Bun.sleep(50);
    const [exit] = await ptyDeadline(
      Promise.all([host.host.exited, host.eof]),
      3000,
      'workflow question host exit timeout',
    );
    assert.equal(exit, 0);
    console.log(
      settings.scenario === 'cancel'
        ? 'WORKFLOW_QUESTION_ORIGINAL_CANCELLED'
        : 'WORKFLOW_QUESTION_ORIGINAL_COMPLETE',
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      snapshot('tui-finally');
      writeFileSync(join(settings.evidence, 'frame.txt'), host.sinceAction());
      writeFileSync(join(settings.evidence, 'question-submit.pty'), Buffer.concat(questionOutput));
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'workflow question failed') : error;
    }
    try {
      if (!host.ended) await terminateTuiTree(host, { exitTimeoutMs: 3000 });
      await host.drain();
      host.close();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'workflow question failed') : error;
    }
    process.removeListener('SIGINT', interrupt);
    if (process.platform === 'win32') {
      process.removeListener('message', stop);
      if (process.connected) process.disconnect?.();
    }
  }
  if (failure) throw failure;
}
if (import.meta.main) {
  try {
    await main(JSON.parse(process.argv[2]!));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
