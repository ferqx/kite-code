import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeRequest, NativeState } from '../src/native-bridge';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [outdir, root, storeId, executablePath] = process.argv.slice(2) as string[];
const app = await _electron.launch({
  executablePath,
  args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
  cwd: outdir,
  env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  timeout: 10000,
});
const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 35000);
try {
  const page = await app.firstWindow();
  console.error('pages_stage', 'window');
  page.setDefaultTimeout(10000);
  const request = (input: NativeRequest) =>
    page.evaluate((text) => window.kiteNative!.request(JSON.parse(text)), JSON.stringify(input));
  const state = async () => (await request({ method: 'state', generation: 1 })) as NativeState;
  await page.getByRole('button', { name: 's', exact: true }).click();
  await page
    .getByRole('textbox', { name: '当前会话私有草稿' })
    .fill('40 harmless original Job approvals');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  await page.waitForFunction(async () => {
    const state = await window.kiteNative!.request({ method: 'state', generation: 1 });
    return state && 'selection' in state && state.selection?.runs.some((run) => run.isActive);
  });
  console.error('pages_stage', 'run admitted');
  let first: NativeState | undefined, tail: NativeState | undefined;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    first = (await request({ method: 'select', generation: 1, sessionId: 's' })) as NativeState;
    if (first.selection?.interactions.length === 20 && first.selection.interactionsAfterId) {
      try {
        tail = (await request({
          method: 'interactions.next',
          generation: 1,
          viewGeneration: first.selection.viewGeneration,
          afterId: first.selection.interactionsAfterId,
        })) as NativeState;
        if (
          tail.selection?.interactions.length === 20 &&
          tail.selection.interactionsAfterId === null
        )
          break;
      } catch {}
    }
  }
  assert.equal(first?.selection?.interactions.length, 20);
  assert.equal(tail?.selection?.interactions.length, 20);
  const firstIds = first!.selection!.interactions.map((c) => c.id);
  assert.equal(
    tail!.selection!.interactions.some((c) => firstIds.includes(c.id)),
    false,
  );
  assert.equal(tail!.selection!.storeId, storeId);
  console.error('pages_stage', '40 cards');
  await app.evaluate(
    `(()=>{const old=globalThis.fetch;globalThis.__pagesDirectoryReads=[];globalThis.fetch=async(input,init)=>{const r=new Request(input,init);if(new URL(r.url).pathname.endsWith('/interactions'))globalThis.__pagesDirectoryReads.push({after:new URL(r.url).searchParams.get('afterId'),at:Date.now()});return old(input,init);};})()`,
  );
  // Exercise the renderer's actual next-page button after refreshing to its first window.
  await request({ method: 'select', generation: 1, sessionId: 's' });
  await openSessionTools(page);
  await page.getByRole('button', { name: '下一页待决请求（替换当前窗口）', exact: true }).waitFor();
  await page.waitForFunction(async () => {
    const state = await window.kiteNative!.request({ method: 'state', generation: 1 });
    if (
      !state ||
      !('selection' in state) ||
      !state.selection ||
      state.selection.session.id !== 's' ||
      state.selection.interactionsAfterId === null
    )
      return false;
    const cache = window as unknown as { pagesStable?: { generation: number; at: number } };
    if (cache.pagesStable?.generation !== state.selection.viewGeneration) {
      cache.pagesStable = { generation: state.selection.viewGeneration, at: performance.now() };
      return false;
    }
    return performance.now() - cache.pagesStable.at >= 250;
  });
  await page.getByRole('button', { name: '下一页待决请求（替换当前窗口）', exact: true }).click();
  const shownDeadline = Date.now() + 10000;
  let shown = await state();
  while (
    shown.selection?.interactionsAfterId !== null ||
    shown.selection?.viewLoading ||
    shown.selection?.permissionUnavailable
  ) {
    if (Date.now() > shownDeadline) throw Error('actual_later_page_publish_timeout');
    await new Promise((r) => setTimeout(r, 5));
    shown = await state();
  }
  const original = shown.selection!.interactions[0]!;
  assert.equal(firstIds.includes(original.id), false);
  console.error('pages_stage', 'renderer next');
  // Forward the actual original POST, then lose only its response. Saved answer identity survives selection changes.
  await app.evaluate(
    `(()=>{globalThis.__pagesFetch=globalThis.fetch;globalThis.__pagesPosts=0;globalThis.__pagesCancels=0;globalThis.fetch=async(input,init)=>{const r=new Request(input,init);const path=new URL(r.url).pathname;if(r.method==='POST'&&path.includes('/cancel'))globalThis.__pagesCancels++;if(r.method==='POST'&&path.includes('/interactions/')&&path.endsWith('/answer')){globalThis.__pagesPosts++;const result=await globalThis.__pagesFetch(input,init);await result.arrayBuffer();throw new TypeError('owned_answer_response_lost');}return globalThis.__pagesFetch(input,init);};})()`,
  );
  await assert.rejects(
    request({
      method: 'interaction.answer',
      generation: 1,
      interactionId: original.id,
      revision: original.revision,
      answer: { kind: 'approval', decision: 'approve' },
    }),
    (error) => {
      return error instanceof Error && error.message.includes('network_outcome_unknown');
    },
  );
  console.error('pages_stage', 'lost original answer');
  let saved = (await state()).interactionSubmissions.find((s) => s.interaction.id === original.id)!;
  assert.ok(saved);
  assert.equal(saved.phase, 'unknown');
  const commandId = saved.intent.commandId;
  await request({ method: 'select', generation: 1, sessionId: 'other' });
  await request({ method: 'lookupInteraction', generation: 1, commandId });
  saved = (await state()).interactionSubmissions.find((s) => s.intent.commandId === commandId)!;
  assert.equal(saved.phase, 'accepted');
  assert.equal(saved.intent.expectedStoreId, storeId);
  assert.equal(saved.interaction.presentationSessionId, 's');
  assert.equal(await app.evaluate('globalThis.__pagesPosts'), 1);
  await app.evaluate('globalThis.fetch=globalThis.__pagesFetch');
  // Closing and switching abort only a pending page query, including a late response.
  for (const change of ['close', 'switch'] as const) {
    await request({ method: 'select', generation: 1, sessionId: 's' });
    const enteredDeadline = Date.now() + 10000;
    let prepared: { key: string; at: number } | undefined;
    while (true) {
      const observed = await state();
      const selection = observed.selection;
      if (
        observed.generation !== 1 ||
        selection?.storeId !== storeId ||
        selection?.session.id !== 's' ||
        selection.session.workspaceId !== 'w' ||
        selection.interactionsAfterId === null
      )
        throw Error('interaction_pages_read_scope_changed');
      if (
        !selection.viewLoading &&
        !selection.permissionUnavailable &&
        selection.executions.some(
          (execution) => execution.id === original.executionId && execution.status === 'succeeded',
        ) &&
        readFileSync(join(root!, 'ledger'), 'utf8').trim().split('\n').length === 1
      ) {
        const key = JSON.stringify([observed.environmentRevision, selection.viewGeneration]);
        if (prepared?.key !== key) prepared = { key, at: Date.now() };
        else if (Date.now() - prepared.at >= 250) {
          console.error('pages_read_prepared', JSON.stringify({ change, key, effects: 1 }));
          break;
        }
      } else prepared = undefined;
      if (Date.now() >= enteredDeadline) throw Error('interaction_pages_read_prepare_timeout');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await app.evaluate(
      `(()=>{globalThis.__pagesFetch=globalThis.fetch;globalThis.__pagesReadEntered=false;globalThis.__pagesReadAborted=false;const gate=new Promise(r=>globalThis.__pagesRelease=r);globalThis.fetch=async(input,init)=>{const r=new Request(input,init);if(r.method==='GET'&&new URL(r.url).searchParams.has('afterId')&&new URL(r.url).pathname.endsWith('/interactions')){globalThis.__pagesReadEntered=true;r.signal.addEventListener('abort',()=>globalThis.__pagesReadAborted=true,{once:true});await gate;}return globalThis.__pagesFetch(input,init);};})()`,
    );
    let current = await state();
    let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
    let entered = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (
        current.generation !== 1 ||
        current.selection?.storeId !== storeId ||
        current.selection?.session.id !== 's' ||
        current.selection.session.workspaceId !== 'w' ||
        current.selection.interactionsAfterId === null
      )
        throw Error('interaction_pages_read_scope_changed');
      let pendingSettled = false;
      pending = request({
        method: 'interactions.next',
        generation: 1,
        viewGeneration: current.selection.viewGeneration,
        afterId: current.selection.interactionsAfterId,
      }).then(
        (value) => {
          pendingSettled = true;
          return { value };
        },
        (error: unknown) => {
          pendingSettled = true;
          return { error };
        },
      );
      while (!(await app.evaluate('globalThis.__pagesReadEntered'))) {
        if (pendingSettled) break;
        if (Date.now() >= enteredDeadline) throw Error('interaction_pages_read_enter_timeout');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      entered = (await app.evaluate('globalThis.__pagesReadEntered')) as boolean;
      if (entered) {
        console.error('pages_read_attempt', JSON.stringify({ change, attempt, phase: 'entered' }));
        break;
      }
      const result = await pending;
      if (
        !('error' in result) ||
        !(result.error instanceof Error) ||
        result.error.message !== 'interaction_page_observation_changed'
      ) {
        if ('error' in result) throw result.error;
        throw Error('interaction_pages_read_settled_before_enter');
      }
      console.error(
        'pages_read_attempt',
        JSON.stringify({ change, attempt, phase: 'before_fetch_rejected' }),
      );
      if (attempt === 3) throw result.error;
      if (Date.now() >= enteredDeadline) throw Error('interaction_pages_read_enter_timeout');
      current = await state();
    }
    if (!entered || !pending) throw Error('interaction_pages_read_not_entered');
    assert.equal(await app.evaluate('globalThis.__pagesReadEntered'), true);
    assert.equal(await app.evaluate('globalThis.__pagesReadAborted'), false);
    if (change === 'close')
      await request({
        method: 'interactions.close',
        generation: 1,
        viewGeneration: current.selection!.viewGeneration,
      });
    else await request({ method: 'select', generation: 1, sessionId: 'other' });
    assert.equal(await app.evaluate('globalThis.__pagesReadAborted'), true);
    await app.evaluate('globalThis.__pagesRelease();globalThis.fetch=globalThis.__pagesFetch');
    const result = await pending;
    if ('error' in result) throw result.error;
    const after = await state();
    assert.equal(after.selection?.session.id, change === 'close' ? 's' : 'other');
    assert.equal(
      after.selection?.interactions.some((c) => c.id === original.id),
      false,
    );
  }
  // Finish the remaining original cards through the closed Native bridge, retaining the original Run.
  const originalRun = first!.selection!.runs[0]!.id;
  for (let count = 0; count < 39; count++) {
    const current = (await request({
      method: 'select',
      generation: 1,
      sessionId: 's',
    })) as NativeState;
    const card = current.selection!.interactions[0]!;
    assert.ok(card);
    await request({
      method: 'interaction.answer',
      generation: 1,
      interactionId: card.id,
      revision: card.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
  }
  await page.waitForFunction(async (id) => {
    const s = await window.kiteNative!.request({ method: 'select', generation: 1, sessionId: 's' });
    return (
      s &&
      'selection' in s &&
      s.selection?.runs.some((r) => r.id === id && r.status === 'completed')
    );
  }, originalRun);
  const effectDeadline = Date.now() + 10000;
  while (readFileSync(join(root!, 'ledger'), 'utf8').trim().split('\n').length !== 40) {
    if (Date.now() > effectDeadline) throw Error('original_jobs_effect_timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
  const finalState = (await request({
    method: 'select',
    generation: 1,
    sessionId: 's',
  })) as NativeState;
  assert.equal(
    finalState.selection!.runs.find((run) => run.id === originalRun)!.status,
    'completed',
  );
  assert.equal(
    finalState.selection!.executions.filter((execution) => execution.definitionId === 'fixture.job')
      .length,
    40,
  );
  assert.equal(
    finalState
      .selection!.executions.filter((execution) => execution.definitionId === 'fixture.job')
      .every((execution) => execution.status === 'succeeded'),
    true,
  );
  assert.equal(readFileSync(join(root!, 'ledger'), 'utf8').trim().split('\n').length, 40);
  assert.equal(await app.evaluate('globalThis.__pagesCancels'), 0);
  console.log(
    'Native interaction pages assertions: passed',
    JSON.stringify({
      storeId,
      originalRun,
      originalInteractionId: original.id,
      originalAnswerCommandId: commandId,
      effects: 40,
      cancellations: 0,
    }),
  );
} catch (error) {
  console.error(error);
  console.error(
    (
      await (
        await app.firstWindow()
      )
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 6000),
  );
  app.process().kill('SIGKILL');
  throw error;
} finally {
  clearTimeout(watchdog);
  await app.close().catch(() => {});
}
