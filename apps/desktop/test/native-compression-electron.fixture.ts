import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { verifyModelInputSnapshot } from '@kite-ai/client';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';
import { readNativeCallerRequest } from './native-caller-body.fixture';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [outdir, root, _dataRoot, storeId, _endpoint, electronExecutable, control, bunExecutable] =
  process.argv.slice(2) as [string, string, string, string, string, string, string, string];
const launch = () =>
  _electron.launch({
    executablePath: electronExecutable,
    args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
let app = await launch();
const pids: number[] = [];
let assertions = 0;
function eq(actual: unknown, expected: unknown) {
  assert.equal(actual, expected);
  assertions++;
}
const count = async () => Number(await (await fetch(`${control}/count`)).text());
async function waitState(
  page: import('playwright').Page,
  predicate: (value: NativeState) => boolean,
) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw Error('native_compression_state_timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function quitOwned() {
  const parent = await app.evaluate(() => process.pid);
  const line = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .split('\n')
    .find((line) => {
      const fields = line.trim().split(/\s+/);
      return Number(fields[1]) === parent && fields.slice(2).join(' ') === bunExecutable;
    });
  const pid = Number(line?.trim().split(/\s+/)[0]);
  assert.ok(pid > 0);
  assertions++;
  pids.push(pid);
  await app.evaluate(({ app }) => app.quit());
  await app.close();
  let stopped = false;
  try {
    process.kill(pid, 0);
  } catch {
    stopped = true;
  }
  eq(stopped, true);
}
try {
  let page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('native_permission_attempt ')) console.error(text);
  });
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native A', { exact: true }).waitFor();
  await openSessionTools(page);
  await page.evaluate(
    async ({ generation, storeId }) => {
      const identity = (state: NativeState) => {
        if (
          state.generation !== generation ||
          state.selection?.storeId !== storeId ||
          state.selection.session.id !== 's' ||
          state.selection.session.workspaceId !== 'w'
        )
          throw Error('permission_fixture_identity_changed');
      };
      const intentIds = (state: NativeState) =>
        JSON.stringify(state.permissionSubmissions.map((row) => row.intent.commandId).sort());
      for (const kind of ['permission.mode', 'permission.trust'] as const) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const fresh = (await window.kiteNative!.request({
            method: 'permission.refresh',
            generation,
          })) as NativeState;
          identity(fresh);
          const observationId = fresh.selection!.permissions!.observationId;
          const before = intentIds(fresh);
          console.error(
            'native_permission_attempt ' +
              JSON.stringify({ kind, attempt, observationId, phase: 'choice' }),
          );
          try {
            await window.kiteNative!.request(
              kind === 'permission.mode'
                ? { method: kind, generation, observationId, mode: 'full', makeDefault: false }
                : { method: kind, generation, observationId, trusted: true },
            );
            console.error(
              'native_permission_attempt ' +
                JSON.stringify({ kind, attempt, observationId, phase: 'success' }),
            );
            break;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'permission_observation_changed')
              throw error;
            const after = (await window.kiteNative!.request({
              method: 'state',
              generation,
            })) as NativeState;
            identity(after);
            if (intentIds(after) !== before) throw Error('permission_fixture_intent_changed');
            console.error(
              'native_permission_attempt ' +
                JSON.stringify({ kind, attempt, observationId, phase: 'pre_intent_rejected' }),
            );
            if (attempt === 3) throw error;
          }
        }
      }
    },
    { generation: 1, storeId },
  );
  await page.getByText('当前模式：full；默认模式：auto', { exact: true }).waitFor();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await page
    .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
    .waitFor();
  await page.evaluate(() => {
    const events: string[] = [];
    Object.defineProperty(window, '__compressionInputEvents', { value: events });
    document.addEventListener(
      'submit',
      (event) => {
        if (
          (event.target as HTMLFormElement).querySelector('textarea[aria-label="当前会话私有草稿"]')
        )
          events.push(event.type);
      },
      { capture: true },
    );
  });
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).fill('Original actual user source');
  // One real click waits for current actionability; a prior trial does not reserve the read gate.
  eq(
    await page.getByRole('textbox', { name: '当前会话私有草稿' }).inputValue(),
    'Original actual user source',
  );
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  eq(
    await page.evaluate(() => (Reflect.get(window, '__compressionInputEvents') as string[]).length),
    1,
  );
  const submitted = await waitState(page, (state) =>
    state.inputSubmissions.some(
      (item) => item.intent.kind === 'run.start' && item.phase === 'accepted',
    ),
  );
  const firstInputs = submitted.inputSubmissions.filter((item) => item.intent.kind === 'run.start');
  eq(firstInputs.length, 1);
  eq(firstInputs[0]!.sessionId, 's');
  eq(firstInputs[0]!.intent.expectedStoreId, storeId);
  eq(
    (
      (await readNativeCallerRequest(
        page,
        submitted.generation,
        firstInputs[0]!.intent.commandId,
      )) as { content: string }
    ).content,
    'Original actual user source',
  );
  await fetch(`${control}/entered`);
  await fetch(`${control}/release`);
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  eq(await count(), 1);
  // The formal compressor requires older settled user history to reduce.
  // Produce that history through the same actual Native input path.
  await page
    .getByRole('textbox', { name: '当前会话私有草稿' })
    .fill('New task: Qualifying second settled user turn');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  await page
    .getByTestId('content')
    .getByText('Second actual answer completing the settled history', { exact: false })
    .waitFor();
  await waitState(
    page,
    (value) =>
      value.selection?.runs.length === 2 && value.selection.runs.every((run) => !run.isActive),
  );
  eq(await count(), 2);
  let panel = page.getByRole('region', { name: '当前所选上下文' });
  await panel.getByRole('button', { name: '读取当前所选上下文' }).click();
  const focus = `${'完整说明。'.repeat(3000)} FULL_FOCUS_TAIL`;
  await panel.getByRole('textbox', { name: '完整压缩重点' }).fill(focus);
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__compactOriginal=original;globalThis.__compactPosts=0;globalThis.fetch=async(input,init)=>{const request=new Request(input,init);if(request.method!=='POST'||!new URL(request.url).pathname.endsWith('/context/compress'))return original(input,init);globalThis.__compactPosts++;const body=Buffer.from(await request.arrayBuffer());const http=process.getBuiltinModule('node:http');return await new Promise((resolve,reject)=>{const outgoing=http.request(request.url,{method:'POST',headers:Object.fromEntries(request.headers)},response=>{response.destroy();outgoing.destroy();reject(new TypeError('owned_compression_response_lost'));});outgoing.on('error',reject);outgoing.end(body);});};})()`,
  );
  await panel.getByRole('button', { name: '明确请求手动压缩' }).click();
  await panel.getByText(/手动压缩：unknown/).waitFor();
  eq(await app.evaluate('globalThis.__compactPosts'), 1);
  await fetch(`${control}/compression-entered`);
  await waitState(page, (value) => value.selection?.activeCommand?.kind === 'context.compress');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿' })
    .fill('New task: Explicit follow-up during original compression');
  await page.getByRole('button', { name: '排队压缩后的输入' }).click();
  await waitState(page, (value) =>
    value.inputSubmissions.some(
      (entry) => entry.intent.kind === 'input.follow_up' && entry.phase === 'accepted',
    ),
  );
  const queued = await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
  const follow = queued.inputSubmissions.find((value) => value.intent.kind === 'input.follow_up');
  eq(follow?.intent.kind, 'input.follow_up');
  eq(follow?.phase, 'accepted');
  const followRequest = await readNativeCallerRequest(
    page,
    queued.generation,
    follow!.intent.commandId,
  );
  eq(
    followRequest.kind === 'input.follow_up' && followRequest.afterRunId,
    queued.selection!.runs.find((value) => value.isActive)!.id,
  );
  eq(
    followRequest.kind === 'input.follow_up' && followRequest.contextSelectionId,
    queued.selection!.session.contextSelectionId,
  );
  eq(await count(), 3);
  await fetch(`${control}/release-compression`);
  await page.getByText('Next actual answer', { exact: false }).first().waitFor();
  eq(await count(), 4);
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native B', { exact: true }).waitFor();
  await openSessionTools(page);
  // The original caller intent remains queryable independently of the current view.
  await page.evaluate(async () => {
    const state = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'lookupCompression',
      generation: 1,
      commandId: state.compressionSubmissions![0]!.intent.commandId,
    });
  });
  const original = await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
  eq(original.compressionSubmissions?.[0]?.sessionId, 's');
  eq(original.compressionSubmissions?.[0]?.run?.status, 'completed');
  eq(await count(), 4);
  eq(await app.evaluate('globalThis.__compactPosts'), 1);
  await app.evaluate('globalThis.fetch=globalThis.__compactOriginal');
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native A', { exact: true }).waitFor();
  await openSessionTools(page);
  panel = page.getByRole('region', { name: '当前所选上下文' });
  await panel.getByRole('button', { name: '读取当前所选上下文' }).click();
  await panel.getByText(/活动压缩记录/).waitFor();
  const observed = await page.evaluate(
    async () =>
      await window.kiteNative!.request({
        method: 'context.read',
        generation: 1,
        sessionId: 's',
        readId: 'assert-record',
      }),
  );
  const compression =
    observed && 'page' in observed && 'compression' in observed.page
      ? observed.page.compression
      : undefined;
  assert.ok(compression);
  assertions++;
  eq(compression.originStoreId, storeId);
  eq(compression.originSessionId, 's');
  const directory = await page.evaluate(
    async ({ storeId }) =>
      await window.kiteNative!.request({
        method: 'modelInputs.list',
        generation: 1,
        sessionId: 's',
        expectedStoreId: storeId,
        readId: 'compression-model-directory',
        limit: 200,
      }),
    { storeId: storeId! },
  );
  eq(
    directory &&
      'items' in directory &&
      directory.items.some(
        (value) =>
          value.executionId === compression.modelExecutionId &&
          value.originCommandId === original.compressionSubmissions![0]!.intent.commandId,
      ),
    true,
  );
  const bodies = await (await fetch(`${control}/requests`)).json();
  eq(JSON.stringify(bodies[2]).includes(focus), true);
  eq(
    (await page.locator('main').innerText()).includes(
      'Original actual answer with preserved source',
    ),
    true,
  );
  await page
    .getByRole('textbox', { name: '当前会话私有草稿' })
    .fill('New task: Next explicit user');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  await waitState(
    page,
    (value) =>
      value.selection?.runs.length === 5 && value.selection.runs.every((run) => !run.isActive),
  );
  eq(await count(), 5);
  const nextBodies = await (await fetch(`${control}/requests`)).json();
  eq(
    JSON.stringify(nextBodies[4]).includes('Factual recorded summary of original user and answer'),
    true,
  );
  const recorded = await page.evaluate(async (storeId) => {
    const directory = await window.kiteNative!.request({
      method: 'modelInputs.list',
      generation: 1,
      sessionId: 's',
      expectedStoreId: storeId,
      readId: 'next-input-directory',
      limit: 200,
    });
    if (!directory || !('items' in directory)) throw Error('missing_input_directory');
    const executionId = directory.items.at(-1)!.executionId;
    const opened = await window.kiteNative!.request({
      method: 'modelInput.open',
      generation: 1,
      sessionId: 's',
      expectedStoreId: storeId,
      executionId,
      readId: 'next-recorded-input',
    });
    if (!opened || !('wireBytes' in opened)) throw Error('missing_recorded_input');
    const bytes = new Uint8Array(Number(opened.wireBytes));
    let offset = 0;
    for (;;) {
      const chunk = await window.kiteNative!.request({
        method: 'modelInput.read',
        generation: 1,
        readId: 'next-recorded-input',
        offset,
        limit: 65536,
      });
      if (!chunk || !('data' in chunk)) throw Error('missing_input_chunk');
      const raw = atob(chunk.data);
      for (let i = 0; i < raw.length; i++) bytes[offset + i] = raw.charCodeAt(i);
      offset = chunk.nextOffset;
      if (chunk.eof) break;
    }
    await window.kiteNative!.request({
      method: 'modelInput.close',
      generation: 1,
      readId: 'next-recorded-input',
    });
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }, storeId!);
  const verifiedInput = await verifyModelInputSnapshot(recorded);
  eq(verifiedInput.storeId, storeId);
  eq(verifiedInput.sessionId, 's');
  eq(
    JSON.stringify(verifiedInput).includes('Factual recorded summary of original user and answer'),
    true,
  );
  eq(JSON.stringify(verifiedInput).includes('Next explicit user'), true);
  await panel.getByRole('button', { name: '读取当前所选上下文' }).click();
  await panel.getByRole('button', { name: '预检并重置压缩点' }).click();
  const reset = await waitState(page, (value) =>
    value.compressionSubmissions!.some(
      (entry) => entry.kind === 'reset' && entry.phase !== 'saved' && entry.phase !== 'submitting',
    ),
  );
  const resetId = reset.compressionSubmissions!.find((entry) => entry.kind === 'reset')!.intent
    .commandId;
  const resetDeadline = Date.now() + 10000;
  for (;;) {
    await page.evaluate(
      async (commandId) =>
        await window.kiteNative!.request({ method: 'lookupCompression', generation: 1, commandId }),
      resetId,
    );
    const value = await page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
    if (
      value.compressionSubmissions!.find((entry) => entry.intent.commandId === resetId)?.run
        ?.status === 'failed'
    )
      break;
    if (Date.now() >= resetDeadline) throw Error('native_reset_terminal_timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  await panel.getByText(/压缩原轮次：failed（compression_reset_unsafe）/).waitFor();
  await panel.getByRole('button', { name: '读取当前所选上下文' }).click();
  await panel.getByText(/活动压缩记录/).waitFor();
  eq((await panel.innerText()).includes(compression.id), true);
  eq(await count(), 5);
  await quitOwned();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native A', { exact: true }).waitFor();
  await openSessionTools(page);
  panel = page.getByRole('region', { name: '当前所选上下文' });
  await panel.getByRole('button', { name: '读取当前所选上下文' }).click();
  await panel.getByText(/活动压缩记录/).waitFor();
  await panel.getByText(/活动压缩记录/).waitFor();
  eq((await panel.innerText()).includes(compression.id), true);
  eq(await count(), 5);
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await page.locator('.session-header').getByTitle('Native B', { exact: true }).waitFor();
  await openSessionTools(page);
  panel = page.getByRole('region', { name: '当前所选上下文' });
  await panel.getByRole('button', { name: '读取当前所选上下文' }).click();
  await panel.getByText('无活动压缩点；重置无需请求模型。', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '预检并重置压缩点' }).click();
  await panel.getByRole('button', { name: '查询原压缩命令与执行' }).click();
  // A lookup is a point-in-time read: accepted may precede creation of the original Run.
  // Keep querying that original command, with the same deadline and no second reset intent.
  const emptyReset = await waitState(
    page,
    (value) =>
      value.compressionSubmissions?.some(
        (entry) => entry.kind === 'reset' && entry.sessionId === 'other',
      ) === true,
  );
  const emptyResetId = emptyReset.compressionSubmissions!.find(
    (entry) => entry.sessionId === 'other',
  )!.intent.commandId;
  const emptyResetDeadline = Date.now() + 10000;
  for (;;) {
    await page.evaluate(
      async (commandId) =>
        await window.kiteNative!.request({ method: 'lookupCompression', generation: 1, commandId }),
      emptyResetId,
    );
    const value = await page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
    const entry = value.compressionSubmissions!.find(
      (entry) => entry.intent.commandId === emptyResetId,
    );
    if (entry?.run?.status === 'completed') {
      eq(entry.run.originCommandId, emptyResetId);
      eq(entry.run.sessionId, 'other');
      break;
    }
    if (Date.now() >= emptyResetDeadline) throw Error('native_empty_reset_terminal_timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await panel.getByText(/压缩原轮次：completed/).waitFor();
  eq(await count(), 5);
  await quitOwned();
  console.log(
    'Native Compression Node assertions:',
    assertions,
    JSON.stringify({ pids, stopped: true, storeId }),
  );
} catch (error) {
  console.error(error);
  console.error('compression_assertion_count', assertions);
  console.error(
    'compression_state',
    await app
      .windows()[0]
      ?.evaluate(async () => {
        const value = (await window.kiteNative!.request({
          method: 'state',
          generation: 1,
        })) as NativeState;
        return { selection: value.selection, submissions: value.compressionSubmissions };
      })
      .catch((error) => error.message),
  );
  console.error(
    'compression_panel',
    await app
      .windows()[0]
      ?.getByRole('region', { name: '当前所选上下文' })
      .innerText()
      .catch(() => ''),
  );
  await app.close().catch(() => {});
  throw error;
}
