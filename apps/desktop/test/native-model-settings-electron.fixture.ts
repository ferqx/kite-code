import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';
import { readNativeCallerRequest } from './native-caller-body.fixture';

const [outdir, root, _dataRoot, storeId, _endpoint, electronExecutable, control, bunExecutable] =
  process.argv.slice(2) as string[];
const launch = () =>
  _electron.launch({
    executablePath: electronExecutable,
    args: [outdir!, `--user-data-dir=${join(root!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: root!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 30000,
  });
let app = await launch();
const pids: number[] = [];
let assertions = 0;
function eq(actual: unknown, expected: unknown) {
  assert.equal(actual, expected);
  assertions++;
}
const step = (label: string) => console.log('Settings step:', label, assertions);
async function bounded<T>(promise: Promise<T>, milliseconds = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_model_settings_step_timeout')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const controlFetch = (path: string) =>
  fetch(`${control}/${path}`, { signal: AbortSignal.timeout(30000) });
const count = async () => Number(await (await controlFetch('count')).text());
async function inputDiagnostics(page: import('playwright').Page, phase: string) {
  const value = await state(page);
  const dom = await page.evaluate(() => {
    const draft = document.querySelector('textarea');
    const button = [...document.querySelectorAll('button')].find(
      (v) => v.textContent === '发送明确的新轮次',
    );
    return {
      focused: document.hasFocus(),
      activeTag: document.activeElement?.tagName,
      activeText: document.activeElement?.textContent?.slice(0, 64),
      draftLength: draft?.value.length,
      disabled: button?.disabled,
      events: Reflect.get(window, '__settingsInputEvents'),
    };
  });
  console.log(
    'Settings input:',
    JSON.stringify({
      phase,
      ...dom,
      generation: value.generation,
      sessionId: value.selection?.session.id,
      permissionUnavailable: value.selection?.permissionUnavailable,
      runs: value.selection?.runs.map((v) => ({
        id: v.id,
        status: v.status,
        isActive: v.isActive,
      })),
      activeCommand: value.selection?.activeCommand
        ? {
            id: value.selection.activeCommand.id,
            kind: value.selection.activeCommand.kind,
            status: value.selection.activeCommand.status,
          }
        : null,
      inputSubmissions: value.inputSubmissions.map((v) => ({
        commandId: v.intent.commandId,
        phase: v.phase,
        error: v.error,
      })),
    }),
  );
}
async function state(page: import('playwright').Page, milliseconds = 30000) {
  return bounded(
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    ),
    milliseconds,
  );
}
async function waitState(
  page: import('playwright').Page,
  predicate: (value: NativeState) => boolean,
) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const value = await state(page, Math.max(1, deadline - Date.now()));
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw Error('native_model_settings_state_timeout');
    await new Promise((r) => setTimeout(r, 20));
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
  await bounded(app.close());
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    if (Date.now() >= deadline) throw Error('owned_service_still_live');
    await new Promise((r) => setTimeout(r, 20));
  }
  eq(true, true);
}
try {
  let page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  await page.evaluate(async () => {
    const initial = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.mode',
      generation: 1,
      observationId: initial.selection!.permissions!.observationId,
      mode: 'full',
      makeDefault: false,
    });
    const refreshed = (await window.kiteNative!.request({
      method: 'permission.refresh',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.trust',
      generation: 1,
      observationId: refreshed.selection!.permissions!.observationId,
      trusted: true,
    });
  });
  await page.evaluate(() => {
    const events: Record<string, unknown>[] = [];
    Object.defineProperty(window, '__settingsInputEvents', { value: events });
    for (const type of ['keydown', 'keyup', 'click', 'submit'])
      document.addEventListener(
        type,
        (event) => {
          if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
          const button = [...document.querySelectorAll('button')].find(
            (v) => v.textContent === '发送明确的新轮次',
          );
          events.push({
            type,
            key: event instanceof KeyboardEvent ? event.key : undefined,
            trusted: event.isTrusted,
            disabled: button?.disabled,
            target: event.target instanceof Element ? event.target.tagName : undefined,
            focused: document.hasFocus(),
          });
          if (events.length > 24) events.shift();
        },
        { capture: true },
      );
  });
  const draft = page.getByRole('textbox', { name: '当前会话私有草稿' });
  await draft.fill('Held original model A');
  eq(await draft.inputValue(), 'Held original model A');
  await inputDiagnostics(page, 'draft-filled');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  eq(
    await page.evaluate(
      () =>
        (
          Reflect.get(window, '__settingsInputEvents') as { type: string; trusted: boolean }[]
        ).filter((v) => v.type === 'submit' && v.trusted).length,
    ),
    1,
  );
  await inputDiagnostics(page, 'click-returned');
  await fetch(`${control}/entered`, { signal: AbortSignal.timeout(30000) });
  step('provider-held');
  const held = await waitState(page, (s) => s.selection?.runs.some((r) => r.isActive) === true);
  eq(
    held.inputSubmissions.filter(
      (v) =>
        v.sessionId === 's' &&
        v.intent.expectedStoreId === storeId &&
        v.intent.kind === 'run.start',
    ).length,
    1,
  );
  const heldRequest = await readNativeCallerRequest(
    page,
    held.generation,
    held.inputSubmissions.find((v) => v.sessionId === 's' && v.intent.kind === 'run.start')!.intent
      .commandId,
  );
  eq('content' in heldRequest && heldRequest.content, 'Held original model A');
  eq('modelId' in heldRequest && heldRequest.modelId, 'A');
  const oldRun = held.selection!.runs.find((r) => r.isActive)!.id;
  eq(await count(), 1);
  let panel = page.getByRole('region', { name: '模型设置', exact: true });
  await panel.getByRole('button', { name: '读取用户模型配置' }).click();
  await panel.getByRole('button', { name: '设为默认 B', exact: true }).waitFor();
  // Replace only the owned main-process fetch. Read the physically committed response fully,
  // destroy that socket, and discard its receipt; the Service is not mocked.
  await app.evaluate(
    `(()=>{const original=globalThis.fetch;globalThis.__settingsOriginal=original;globalThis.__settingsPosts=0;globalThis.__settingsGets=0;globalThis.fetch=async(input,init)=>{const request=new Request(input,init);const path=new URL(request.url).pathname;if(request.method==='GET'&&path.includes('/host-mutations/'))globalThis.__settingsGets++;if(request.method!=='POST'||!path.endsWith('/config/user/models'))return original(input,init);globalThis.__settingsPosts++;const body=Buffer.from(await request.arrayBuffer());const http=process.getBuiltinModule('node:http');return await new Promise((resolve,reject)=>{const outgoing=http.request(request.url,{method:'POST',headers:Object.fromEntries(request.headers)},response=>{response.on('data',()=>{});response.on('end',()=>{response.destroy();outgoing.destroy();reject(new TypeError('owned_settings_response_lost'));});});outgoing.on('error',reject);outgoing.end(body);});};})()`,
  );
  await panel.getByRole('button', { name: '设为默认 B', exact: true }).click();
  step('default-dispatched');
  const unknown = await waitState(
    page,
    (s) => s.modelSettingsSubmissions?.some((v) => v.phase === 'unknown') === true,
  );
  const original = unknown.modelSettingsSubmissions!.find((v) => v.phase === 'unknown')!;
  eq(original.scope, 'user');
  eq(original.storeId, storeId);
  eq(original.operation.modelId, 'B');
  eq(await app.evaluate('globalThis.__settingsPosts'), 1);
  eq(await app.evaluate('globalThis.__settingsGets'), 0);
  eq((await state(page)).selection!.runs.find((r) => r.id === oldRun)!.isActive, true);
  eq(await count(), 1);
  eq(JSON.parse(await (await controlFetch('configuration')).text()).modelId, 'B');
  await panel.getByRole('button', { name: '读取当前项目模型配置' }).click();
  await page.getByRole('button', { name: 'Native B', exact: true }).click();
  await page.getByRole('heading', { name: 'Native B', exact: true }).waitFor();
  await page
    .getByRole('region', { name: '模型设置提交', exact: true })
    .getByRole('button', { name: '查询原提交', exact: true })
    .click();
  step('original-lookup');
  const applied = await waitState(
    page,
    (s) =>
      s.modelSettingsSubmissions?.some(
        (v) => v.commandId === original.commandId && v.phase === 'applied',
      ) === true,
  );
  eq(
    applied.modelSettingsSubmissions!.find((v) => v.commandId === original.commandId)!.scope,
    'user',
  );
  eq(await app.evaluate('globalThis.__settingsPosts'), 1);
  eq(await app.evaluate('globalThis.__settingsGets'), 1);
  eq(await count(), 1);
  await app.evaluate('globalThis.fetch=globalThis.__settingsOriginal');
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  panel = page.getByRole('region', { name: '模型设置', exact: true });
  await panel.getByRole('button', { name: '读取用户模型配置' }).click();
  await panel.getByRole('button', { name: '禁用模型 A', exact: true }).waitFor();
  await controlFetch('edit');
  await panel.getByRole('button', { name: '禁用模型 A', exact: true }).click();
  step('stale-dispatched');
  const failed = await waitState(
    page,
    (s) =>
      s.modelSettingsSubmissions?.some(
        (v) => v.operation.kind === 'enabled' && v.phase === 'failed',
      ) === true,
  );
  const stale = failed.modelSettingsSubmissions!.find(
    (v) => v.operation.kind === 'enabled' && v.phase === 'failed',
  )!;
  eq(stale.scope, 'user');
  eq(stale.error, 'configuration_read_set_conflict');
  const retained = await (await controlFetch('configuration')).text();
  eq(retained.includes('// external editor retained'), true);
  eq(
    JSON.parse(retained.replace(/\n\/\/ external editor retained\n$/, '')).models.find(
      (v: { id: string }) => v.id === 'A',
    ).enabled !== false,
    true,
  );
  eq(await count(), 1);
  step('stale-rejected');
  await controlFetch('release');
  await waitState(
    page,
    (s) => s.selection?.runs.find((r) => r.id === oldRun)?.status === 'completed',
  );
  const picker = page.getByRole('region', { name: '下一轮模型选择', exact: true });
  // The global default is B; this existing Session still owns its original next-run preference A.
  eq(await picker.getByRole('button', { name: /^模型：fixed-A/ }).isVisible(), true);
  eq(JSON.parse(retained.replace(/\n\/\/ external editor retained\n$/, '')).modelId, 'B');
  await picker.getByRole('button', { name: /^模型：/ }).click();
  await picker
    .getByRole('region', { name: '模型与思考浮层' })
    .getByRole('button', { name: 'fixed-A', exact: true })
    .click();
  await picker.getByRole('button', { name: '选择模型 B', exact: true }).click();
  await picker.getByRole('button', { name: '关闭模型选择', exact: true }).click();
  eq(await picker.getByRole('button', { name: /^模型：fixed-B/ }).isVisible(), true);
  eq(await count(), 1);
  await page.evaluate(() => {
    (Reflect.get(window, '__settingsInputEvents') as unknown[]).length = 0;
  });
  await draft.fill('Explicit next model B');
  eq(await draft.inputValue(), 'Explicit next model B');
  await inputDiagnostics(page, 'next-draft-filled');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  eq(
    await page.evaluate(
      () =>
        (
          Reflect.get(window, '__settingsInputEvents') as { type: string; trusted: boolean }[]
        ).filter((v) => v.type === 'submit' && v.trusted).length,
    ),
    1,
  );
  await inputDiagnostics(page, 'next-click-returned');
  const finished = await waitState(
    page,
    (s) => s.selection?.runs.length === 2 && s.selection.runs.every((r) => !r.isActive),
  );
  eq(
    finished.inputSubmissions.filter(
      (v) =>
        v.sessionId === 's' &&
        v.intent.expectedStoreId === storeId &&
        v.intent.kind === 'run.start',
    ).length,
    2,
  );
  const finishedRequests = await Promise.all(
    finished.inputSubmissions
      .filter((v) => v.sessionId === 's' && v.intent.kind === 'run.start')
      .map((v) => readNativeCallerRequest(page, finished.generation, v.intent.commandId)),
  );
  eq(
    finishedRequests.filter((r) => 'content' in r && r.content === 'Explicit next model B').length,
    1,
  );
  eq(
    finishedRequests.some(
      (r) =>
        'content' in r &&
        r.content === 'Explicit next model B' &&
        'modelId' in r &&
        r.modelId === 'B',
    ),
    true,
  );
  eq(await count(), 2);
  const bodies = await (await controlFetch('requests')).json();
  eq(bodies[0].model, 'fixed-A');
  eq(bodies[1].model, 'fixed-B');
  step('next-run-complete');
  await quitOwned();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByRole('button', { name: 'Native A', exact: true }).click();
  await page.getByRole('heading', { name: 'Native A', exact: true }).waitFor();
  panel = page.getByRole('region', { name: '模型设置', exact: true });
  await panel.getByRole('button', { name: '读取用户模型配置' }).click();
  await panel.getByText(/当前期望默认模型：B/).waitFor();
  eq(await count(), 2);
  eq((await state(page)).selection!.runs.length, 2);
  await page
    .getByRole('region', { name: '下一轮模型选择', exact: true })
    .getByRole('button', { name: /^模型：fixed-B/ })
    .waitFor();
  eq(
    await page
      .getByRole('region', { name: '下一轮模型选择', exact: true })
      .getByRole('button', { name: /^模型：fixed-B/ })
      .isVisible(),
    true,
  );
  await quitOwned();
  console.log(
    'Native Model Settings Node assertions:',
    assertions,
    JSON.stringify({
      pids,
      stopped: true,
      storeId,
      models: bodies.map((v: { model: string }) => v.model),
      originalCommandId: original.commandId,
      posts: 1,
      lookups: 1,
    }),
  );
} catch (error) {
  console.error(error, 'assertions', assertions);
  await inputDiagnostics(app.windows()[0]!, 'failure').catch((diagnosticError) =>
    console.error('Settings diagnostic failed', diagnosticError),
  );
  console.error(
    await app
      .windows()[0]
      ?.locator('main')
      .innerText()
      .catch(() => ''),
  );
  await controlFetch('release').catch(() => {});
  await app.close().catch(() => {});
  throw error;
}
