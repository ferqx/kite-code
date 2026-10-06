import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeAnswerRecord } from '../electron/answer-journal';
import type { NativeRequest, NativeState } from '../src/native-bridge';

const [outdir, root, storeId, executablePath] = process.argv.slice(2) as string[];
const launch = () =>
  _electron.launch({
    executablePath,
    args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
let app = await launch();
const firstMainPid = app.process().pid;
const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 35000);
const full = '原答复🙂é\r\n完整原文';
const privatePath = join(root!, 'data/owned/desktop-private/data.sqlite');
try {
  let page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  const request = (input: NativeRequest) =>
    page.evaluate((text) => window.kiteNative!.request(JSON.parse(text)), JSON.stringify(input));
  const state = async () => (await request({ method: 'state', generation: 1 })) as NativeState;
  const until = async (predicate: (state: NativeState) => boolean) => {
    const end = Date.now() + 10000;
    let current = await state();
    while (!predicate(current)) {
      if (Date.now() > end) throw Error('answer_state_timeout');
      await new Promise((r) => setTimeout(r, 10));
      current = await state();
    }
    return current;
  };
  const row = async () =>
    app.evaluate((_electron, path) => {
      const { DatabaseSync } = process.getBuiltinModule(
        'node:sqlite',
      ) as typeof import('node:sqlite');
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return JSON.parse(
          (db.prepare('SELECT state FROM answer_intents').get() as { state: string }).state,
        );
      } finally {
        db.close();
      }
    }, privatePath);
  await page.getByRole('button', { name: 's', exact: true }).click();
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).fill('one original question');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  const shown = await until((s) => s.selection?.interactions.length === 1);
  const card = shown.selection!.interactions[0]!,
    runId = card.runId!;
  console.error('answer_stage', 'original question');
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__answerPosts=0;globalThis.fetch=async(input,init)=>{const r=new Request(input,init);if(r.method==='POST'&&new URL(r.url).pathname.endsWith('/answer')){const db=new (process.getBuiltinModule('node:sqlite').DatabaseSync)(${JSON.stringify(privatePath)},{readOnly:true});try{globalThis.__beforePost=JSON.parse(db.prepare('SELECT state FROM answer_intents').get().state);}finally{db.close();}globalThis.__wireBody=JSON.parse(await r.clone().text());globalThis.__answerPosts++;const result=await original(input,init);await result.arrayBuffer();throw new TypeError('owned_original_answer_response_lost');}return original(input,init);};})()`,
  );
  await assert.rejects(
    request({
      method: 'interaction.answer',
      generation: 1,
      interactionId: card.id,
      revision: card.revision,
      answer: { kind: 'question', answers: { full } },
    }),
    /network_outcome_unknown/,
  );
  console.error('answer_stage', 'lost POST returned');
  const original = await row(),
    commandId = original.intent.request.commandId;
  assert.equal(original.phase, 'unknown');
  const before = (await app.evaluate('globalThis.__beforePost')) as NativeAnswerRecord;
  assert.equal(before.phase, 'submitting');
  assert.deepEqual(before.intent, original.intent);
  assert.deepEqual(await app.evaluate('globalThis.__wireBody'), original.intent.request);
  assert.deepEqual(original.intent.request.answer, { kind: 'question', answers: { full } });
  assert.equal(original.intent.scope.storeId, storeId);
  assert.equal(original.intent.scope.sessionId, 's');
  assert.equal(original.intent.interaction.id, card.id);
  assert.equal(await app.evaluate('globalThis.__answerPosts'), 1);
  await until(
    (s) => s.selection?.runs.some((r) => r.id === runId && r.status === 'completed') === true,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(root!, 'ledger'), 'utf8').trim()), {
    executionId: card.executionId,
    answer: { full },
  });
  console.error('answer_stage', 'original applied, response lost, effect once');
  // Kill the actual Main; the Service's lifetime pipe releases its owned profile lock.
  app.process().kill('SIGKILL');
  await new Promise<void>((resolve) =>
    app.process().exitCode !== null ? resolve() : app.process().once('exit', () => resolve()),
  );
  await new Promise((r) => setTimeout(r, 250));
  app = await launch();
  assert.notEqual(app.process().pid, firstMainPid);
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'other', exact: true }).waitFor();
  console.error('answer_stage', 'cold Main');
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__coldPosts=0;globalThis.__coldGets=[];globalThis.__coldLose=true;globalThis.fetch=async(input,init)=>{const r=new Request(input,init);const path=new URL(r.url).pathname;if(r.method==='POST'&&path.endsWith('/answer'))globalThis.__coldPosts++;if(r.method==='GET'&&path.endsWith('/commands/${commandId}')){globalThis.__coldGets.push(path);const result=await original(input,init);if(globalThis.__coldLose){globalThis.__coldLose=false;await result.arrayBuffer();throw new TypeError('owned_original_get_lost');}return result;}return original(input,init);};})()`,
  );
  await request({ method: 'select', generation: 1, sessionId: 'other' });
  let cold = await state();
  assert.equal(cold.interactionSubmissions.length, 0);
  let metadata = cold.answerSubmissions!.find((r) => r.request.commandId === commandId)!;
  assert.equal(metadata.phase, 'unknown');
  assert.equal(metadata.association, 'unavailable');
  assert.deepEqual((await row()).intent, original.intent);
  assert.equal(await app.evaluate('globalThis.__coldGets.length'), 0);
  await assert.rejects(
    request({ method: 'lookupInteraction', generation: 1, commandId }),
    /network_outcome_unknown/,
  );
  assert.equal((await row()).phase, 'unknown');
  assert.deepEqual((await row()).intent, original.intent);
  // The renderer's saved-intent control also queries precisely the original command.
  await page.getByRole('button', { name: `只查原答复 · ${commandId}`, exact: true }).click();
  cold = await until(
    (s) =>
      s.answerSubmissions?.find((r) => r.request.commandId === commandId)?.phase === 'accepted',
  );
  metadata = cold.answerSubmissions!.find((r) => r.request.commandId === commandId)!;
  assert.equal(cold.selection!.session.id, 'other');
  assert.equal(metadata.association, 'unavailable');
  assert.deepEqual((await row()).intent, original.intent);
  assert.equal((await row()).phase, 'accepted');
  assert.equal(await app.evaluate('globalThis.__coldPosts'), 0);
  assert.equal(await app.evaluate('globalThis.__coldGets.length'), 2);
  const final = (await request({ method: 'select', generation: 1, sessionId: 's' })) as NativeState;
  assert.equal(final.selection!.runs.find((r) => r.id === runId)!.status, 'completed');
  const lines = readFileSync(join(root!, 'ledger'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).executionId, card.executionId);
  console.info(
    JSON.stringify({
      originalStoreId: storeId,
      originalSessionId: 's',
      originalInteractionId: card.id,
      originalRevision: card.revision,
      originalCommandId: commandId,
      originalExecutionId: card.executionId,
      originalRunId: runId,
      originalRunStatus: 'completed',
      bodyDigest: original.intent.bodyDigest,
      requestDigest: original.intent.requestDigest,
      firstMainPid,
      coldMainPid: app.process().pid,
      coldOriginalGets: 2,
      coldAnswerPosts: 0,
      originalEffects: 1,
    }),
  );
  console.log(
    'Native cold answer assertions: original identity/body/digests retained across SIGKILL; original Run completed; original execution effect once; cold lost GET then exact original GET; zero cold POST; selection unchanged',
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  app.process().kill('SIGKILL');
  process.exit(process.exitCode ?? 0);
}
