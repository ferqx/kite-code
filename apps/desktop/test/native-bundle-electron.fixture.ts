import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeState } from '../src/native-bridge';

const [candidate, home, control, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
const lockState = async () =>
  (await (await fetch(`${control}/locks`)).json()) as { outer: boolean; inner: boolean };
async function launch() {
  console.log('native_driver_stage: launch');
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.error('native_bundle_renderer_error', error.message));
  console.log('native_driver_stage: window');
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'Native bundled', exact: true }).click();
  await page.getByRole('heading', { name: 'Native bundled', exact: true }).waitFor();
  console.log('native_driver_stage: selection');
  const state = await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
  assert.equal(state.selection?.storeId, storeId);
  const ps = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app!.process().pid &&
        parts.slice(2).join(' ') === join(candidate, 'terminal/runtime/bun'),
    );
  assert.equal(ps.length, 1);
  childPid = Number(ps[0]![0]);
  assert.deepEqual(await lockState(), { outer: true, inner: true });
  console.log('native_driver_stage: locks held');
  return page;
}
try {
  let page = await launch();
  await page.evaluate(async () => {
    let state = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.mode',
      generation: 1,
      observationId: state.selection!.permissions!.observationId,
      mode: 'ask',
      makeDefault: false,
    });
    state = (await window.kiteNative!.request({
      method: 'permission.refresh',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.trust',
      generation: 1,
      observationId: state.selection!.permissions!.observationId,
      trusted: true,
    });
  });
  // Wait for the actual rendered original scope, not merely the Main reply.
  await page.getByText('当前模式：ask；默认模式：auto', { exact: true }).waitFor();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  await page
    .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
    .waitFor();
  await page.evaluate(() => {
    const events: { type: string; focused: boolean }[] = [];
    Object.defineProperty(window, '__bundleInputEvents', { value: events });
    document.addEventListener(
      'submit',
      (event) => {
        if ((event.target as HTMLFormElement).textContent?.includes('当前会话私有草稿'))
          events.push({ type: event.type, focused: document.hasFocus() });
      },
      { capture: true },
    );
  });
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).fill('write one real bundled file');
  assert.equal(
    await page.getByRole('textbox', { name: '当前会话私有草稿' }).inputValue(),
    'write one real bundled file',
  );
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  assert.equal(
    await page.evaluate(() => (Reflect.get(window, '__bundleInputEvents') as unknown[]).length),
    1,
  );
  console.log('native_driver_stage: submitted');
  const approvals: string[] = [],
    deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await page.getByText('轮次：completed', { exact: true }).isVisible()) break;
    const approve = page.getByRole('button', { name: 'Approve once', exact: true });
    if (await approve.isVisible()) {
      const state = await page.evaluate(
          async () =>
            (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
        ),
        card = state.selection?.interactions.find((value) => value.state === 'pending');
      if (!card) {
        console.log(
          'native_driver_card_projection',
          JSON.stringify(
            state.selection?.interactions.map((value) => ({
              id: value.id,
              state: value.state,
              definitionId: value.definitionId,
            })),
          ),
        );
        await page.waitForTimeout(20);
        continue;
      }
      if (!approvals.includes(card.id)) {
        approvals.push(card.id);
        await approve.click();
      }
    }
    await page.waitForTimeout(20);
  }
  console.log(
    'native_driver_actual_facts',
    JSON.stringify(
      await page.evaluate(async () => {
        const state = (await window.kiteNative!.request({
          method: 'state',
          generation: 1,
        })) as NativeState;
        return {
          interactions: state.selection?.interactions.map((value) => ({
            id: value.id,
            state: value.state,
            definitionId: value.definitionId,
          })),
          selection: state.selection?.session.id,
          runs: state.selection?.runs.map((run) => ({ id: run.id, status: run.status })),
          inputs: state.inputSubmissions.map((row) => ({
            commandId: row.intent.commandId,
            phase: row.phase,
            error: row.error,
          })),
          events: Reflect.get(window, '__bundleInputEvents'),
        };
      }),
    ),
  );
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  assert.ok(approvals.length > 0);
  console.log('native_driver_stage: completed');
  assert.equal(
    readFileSync(join(home, 'workspace/bundled.txt'), 'utf8'),
    'actual bundled bytes\r\n',
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), '2');
  const old = childPid!;
  await app!.evaluate(({ app }) => app.quit());
  await app!.close();
  console.log('native_driver_stage: quit');
  app = undefined;
  assert.throws(() => process.kill(old, 0));
  childPid = undefined;
  assert.deepEqual(await lockState(), { outer: false, inner: false });
  page = await launch();
  assert.equal(await (await fetch(`${control}/count`)).text(), '2');
  await page.evaluate(
    async () =>
      await window.kiteNative!.request({
        method: 'messages',
        generation: 1,
        sessionId: 's',
        limit: 50,
      }),
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), '2');
  process.kill(childPid!, 'SIGSTOP');
  app!.process().kill('SIGKILL');
  await new Promise<void>((resolve) => app!.process().once('exit', () => resolve()));
  app = undefined;
  assert.deepEqual(await lockState(), { outer: true, inner: true });
  process.kill(childPid!, 'SIGKILL');
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const locks = await lockState();
    if (!locks.outer && !locks.inner) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await lockState(), { outer: false, inner: false });
  childPid = undefined;
  console.log(
    JSON.stringify({
      approvals: approvals.length,
      provider: 2,
      sourceFree: true,
      normalQuit: true,
      mainKilledChildRetainsBoth: true,
    }),
  );
} finally {
  if (childPid) {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  }
  if (app) {
    const owned = app;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owned.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            owned.process().kill('SIGKILL');
            resolve();
          }, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
