import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ModelOutputSnapshot, ServerInfo } from '@kite-ai/client';
import type { WebPreferences } from 'electron';
import type { ElectronApplication, Page } from 'playwright';
import type {
  NativeModelOutputChunk,
  NativeModelOutputOpen,
  NativeState,
} from '../src/native-bridge';
import { readNativeModelOutput } from '../src/native-model-output';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [launcher, home, control, desktopPackage] = process.argv.slice(2) as string[];
const { _electron } = createRequire(desktopPackage!)('playwright') as typeof import('playwright');
const expected = JSON.parse(readFileSync(join(home!, 'expected.json'), 'utf8')) as {
  storeId: string;
  sessionId: string;
  candidates: { root: string; id: string; electron: string }[];
  tasks: string[];
  bodies: string[];
};
type Physical = { path: string; method: string; output?: ModelOutputSnapshot };
type Globals = typeof globalThis & {
  versionPhysical: Physical[];
  versionServer?: Promise<ServerInfo>;
};
type Facts = {
  cursor: string;
  storeId: string;
  runs: { id: string; originCommandId: string; status: string }[];
  commands: { id: string; status: string; originStoreId: string }[];
  executions: { id: string; kind: string }[];
  providerCalls: number;
};
const started = Date.now();
const phases: unknown[] = [],
  owned: { pid: number; startIdentity: string; root: string }[] = [];
let app: ElectronApplication | undefined, childPid: number | undefined;
let tracingActive = false;
const stage = (name: string, facts = {}) =>
  console.log(
    JSON.stringify({
      stage: `native_real_versions_${name}`,
      elapsedMs: Date.now() - started,
      ...facts,
    }),
  );
const query = async <T>(path: string) => {
  const response = await fetch(`${control}/${path}`);
  if (!response.ok) throw Error(`native_version_control_failed:${path}:${response.status}`);
  return (await response.json()) as T;
};
const state = async (page: Page) =>
  await page.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
async function waitState(page: Page, predicate: (value: NativeState) => boolean) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await state(page);
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw Error('native_version_state_timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function launch(index: number) {
  const candidate = expected.candidates[index]!;
  app = await _electron.launch({
    executablePath: launcher!,
    args: [`--user-data-dir=${join(home!, 'electron-data')}`],
    cwd: home,
    env: {
      HOME: home!,
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      ...(process.platform === 'linux'
        ? { DISPLAY: process.env.DISPLAY ?? '', XAUTHORITY: process.env.XAUTHORITY ?? '' }
        : {}),
    },
    timeout: 15000,
    chromiumSandbox: true,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: 'Native real versions', exact: true }).waitFor();
  await openSessionTools(page);
  assert.equal(
    await app.evaluate(() => process.execPath),
    join(candidate.root, candidate.electron),
  );
  const security = await app.evaluate(({ app, BrowserWindow }) => ({
    sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
    windows: BrowserWindow.getAllWindows().map((window) => {
      const preferences = (
        window.webContents as typeof window.webContents & {
          getLastWebPreferences(): WebPreferences;
        }
      ).getLastWebPreferences();
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      };
    }),
  }));
  assert.deepEqual(security, {
    sandboxDisabled: false,
    windows: [{ sandbox: true, contextIsolation: true, nodeIntegration: false }],
  });
  const processColumn = process.platform === 'linux' ? 'args=' : 'comm=';
  const children = String(execFileSync('/bin/ps', ['-axo', `pid=,ppid=,${processColumn}`]))
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app!.process().pid &&
        (process.platform === 'linux' ? parts[2]! : parts.slice(2).join(' ')) ===
          join(candidate.root, 'terminal/runtime/bun'),
    );
  assert.equal(children.length, 1);
  childPid = Number(children[0]![0]);
  const identity = await query<{ pid: number; startIdentity: string }>(`process?pid=${childPid}`);
  assert.equal(identity.pid, childPid);
  assert.ok(identity.startIdentity);
  owned.push({ ...identity, root: candidate.root });
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  tracingActive = true;
  await app.evaluate(() => {
    const target = globalThis as Globals,
      original = globalThis.fetch;
    target.versionPhysical = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const url = new URL(String(args[0]));
      const row: Physical = { path: url.pathname, method: args[1]?.method ?? 'GET' };
      target.versionPhysical.push(row);
      // Read the actual admitted Service's public identity using this caller's own headers.
      target.versionServer ??= original(new URL('/v1/server', url), {
        headers: args[1]?.headers,
      }).then(async (response) => {
        if (!response.ok) throw Error('native_version_server_read_failed');
        return (await response.json()) as ServerInfo;
      });
      const response = await original(...args);
      if (response.ok && /\/model-output$/.test(url.pathname))
        row.output = (await response.clone().json()) as ModelOutputSnapshot;
      return response;
    }) as typeof fetch;
  });
  await page.getByRole('button', { name: 'Native real versions', exact: true }).click();
  await page
    .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
    .waitFor();
  assert.equal((await state(page)).selection?.storeId, expected.storeId);
  const server = await app.evaluate(async () => await (globalThis as Globals).versionServer!);
  assert.equal(server.buildId, `native-${candidate.id}`);
  assert.equal(server.storeId, expected.storeId);
  assert.ok(
    !phases.some((value) => (value as { instanceId?: string }).instanceId === server.instanceId),
  );
  stage('launch', {
    index,
    candidateId: candidate.id,
    instanceId: server.instanceId,
    security,
    ...identity,
  });
  return { page, server };
}
async function read(page: Page, count: number) {
  const before = await query<Facts>('snapshot');
  assert.equal(before.providerCalls, count);
  assert.equal(before.runs.length, count);
  assert.ok(before.runs.every((run) => run.status === 'completed'));
  await app!.evaluate(() => {
    (globalThis as Globals).versionPhysical = [];
  });
  const outputs = page
    .getByRole('region', { name: '会话消息', exact: true })
    .locator('article')
    .filter({ has: page.locator('small', { hasText: /^assistant ·/ }) });
  if (count) await outputs.nth(count - 1).waitFor();
  assert.equal(await outputs.count(), count);
  for (let index = 0; index < count; index++) {
    const panel = outputs.nth(index);
    if (await panel.locator('.model-output-message').count()) {
      const close = panel.getByRole('button', { name: 'Close full Model output', exact: true });
      if (await close.count()) await close.click();
      await panel
        .getByRole('button', { name: 'Read complete recorded Model output', exact: true })
        .click();
      await panel.getByText('Complete Model output', { exact: true }).waitFor();
    } else {
      // Small original outputs render their complete inline body. Read their same original
      // Model through the Main boundary too, without inventing a missing UI button.
      const current = await state(page);
      const execution = current.selection!.executions.find(
        (value) =>
          value.kind === 'model' &&
          value.result &&
          typeof value.result === 'object' &&
          !Array.isArray(value.result) &&
          value.result.content === expected.bodies[index],
      );
      assert.ok(execution);
      const snapshot = await readNativeModelOutput({
        bridge: {
          request: async (request) => {
            if (
              request.method !== 'modelOutput.open' &&
              request.method !== 'modelOutput.read' &&
              request.method !== 'modelOutput.close'
            )
              throw Error('native_version_read_method_invalid');
            return await page.evaluate(
              async (input) =>
                (await window.kiteNative!.request(input)) as
                  | NativeModelOutputOpen
                  | NativeModelOutputChunk
                  | null,
              request,
            );
          },
          watch: () => () => {},
        },
        generation: current.generation,
        expectedStoreId: expected.storeId,
        sessionId: expected.sessionId,
        executionId: execution.id,
        signal: new AbortController().signal,
        isCurrent: () => true,
      });
      assert.equal(snapshot.output.content, expected.bodies[index]);
    }
    assert.equal(await panel.locator('.message-markdown').textContent(), expected.bodies[index]);
  }
  const physical = await app!.evaluate(() => (globalThis as Globals).versionPhysical);
  assert.ok(
    physical.every((row) => row.method === 'GET'),
    JSON.stringify(physical.map(({ path, method }) => ({ path, method }))),
  );
  const snapshots = physical.flatMap((row) => (row.output ? [row.output] : []));
  assert.equal(snapshots.length, count);
  for (let index = 0; index < snapshots.length; index++) {
    const output = snapshots[index]!;
    assert.equal(output.storeId, expected.storeId);
    assert.equal(output.sessionId, expected.sessionId);
    assert.equal(output.output.complete, true);
    assert.equal(output.output.content, expected.bodies[index]);
    assert.equal(output.contentBytes, String(Buffer.byteLength(expected.bodies[index]!)));
    const originalRun = before.runs.find((run) => run.id === output.runId)!;
    assert.ok(originalRun);
    assert.equal(output.originCommandId, originalRun.originCommandId);
  }
  const after = await query<Facts>('snapshot');
  assert.deepEqual(
    after,
    before,
    'complete cold GET must preserve the original Store facts/cursor and Provider count',
  );
  return snapshots;
}
async function run(page: Page, index: number) {
  const before = await state(page);
  const prior = before.callerSubmissions ?? [];
  await page.evaluate(() => {
    const events: string[] = [];
    Reflect.set(window, '__nativeVersionSubmits', events);
    document.addEventListener(
      'submit',
      (event) => {
        if (
          (event.target as HTMLFormElement).querySelector('textarea[aria-label="当前会话私有草稿"]')
        )
          events.push(event.type);
      },
      { capture: true, once: true },
    );
  });
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).fill(expected.tasks[index]!);
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  assert.equal(
    await page.evaluate(() => (Reflect.get(window, '__nativeVersionSubmits') as string[]).length),
    1,
  );
  const completed = await waitState(
    page,
    (value) =>
      value.selection?.runs.length === index + 1 &&
      value.selection.runs.every((run) => run.status === 'completed'),
  );
  // Input submissions describe this process's hot bindings. Cold originals remain in the
  // persistent caller directory; reading them must not promote them into new hot work.
  assert.equal(completed.inputSubmissions.length, 1);
  assert.equal(completed.callerSubmissions!.length, index + 1);
  for (const record of prior)
    assert.deepEqual(
      completed.callerSubmissions!.find(
        (value) => value.request.commandId === record.request.commandId,
      ),
      record,
    );
  assert.ok(completed.callerSubmissions!.every((value) => value.phase === 'accepted'));
  assert.ok(completed.inputSubmissions.every((value) => value.phase === 'accepted'));
  await page
    .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
    .waitFor();
  assert.equal((await query<Facts>('snapshot')).providerCalls, index + 1);
  return await read(page, index + 1);
}
async function close(sequence: number) {
  const current = app!,
    pid = childPid!;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    current.process().once('exit', (code, signal) => resolve({ code, signal })),
  );
  if (tracingActive) {
    await current
      .firstWindow()
      .then((page) =>
        page.context().tracing.stop({ path: join(home!, `native-version-${sequence}-trace.zip`) }),
      );
    tracingActive = false;
  }
  await current.evaluate(({ app }) => app.quit());
  const exit = await exited;
  assert.deepEqual(exit, { code: 0, signal: null });
  app = undefined;
  assert.throws(() => process.kill(pid, 0));
  childPid = undefined;
  const locks = await query<{ outer: boolean; inner: boolean }[]>('locks');
  assert.ok(locks.every((row) => !row.outer && !row.inner));
  stage('ordinary_exit', { sequence, pid, exit, exclusive: true });
}
try {
  let launched = await launch(0);
  await launched.page.evaluate(async () => {
    const current = (await window.kiteNative!.request({
      method: 'state',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.mode',
      generation: 1,
      observationId: current.selection!.permissions!.observationId,
      mode: 'full',
      makeDefault: false,
    });
    const updated = (await window.kiteNative!.request({
      method: 'permission.refresh',
      generation: 1,
    })) as NativeState;
    await window.kiteNative!.request({
      method: 'permission.trust',
      generation: 1,
      observationId: updated.selection!.permissions!.observationId,
      trusted: true,
    });
  });
  await launched.page.getByText('当前模式：full；默认模式：auto', { exact: true }).waitFor();
  await launched.page
    .getByText(/^工作区：native-version-workspace；信任状态：trusted；版本：/)
    .waitFor();
  const first = await run(launched.page, 0);
  phases.push({
    instanceId: launched.server.instanceId,
    candidateId: expected.candidates[0]!.id,
    outputs: first,
  });
  const upgraded = await query<{ candidateId: string; previousCandidateId: string }>('upgrade');
  assert.equal(upgraded.candidateId, expected.candidates[1]!.id);
  assert.equal(upgraded.previousCandidateId, expected.candidates[0]!.id);
  assert.equal(
    await app!.evaluate(() => process.execPath),
    join(expected.candidates[0]!.root, expected.candidates[0]!.electron),
  );
  assert.equal((await query<{ blocked: boolean }>('busy')).blocked, true);
  const held = await query<{ outer: boolean; inner: boolean }[]>('locks');
  assert.deepEqual(held, [
    { outer: true, inner: true },
    { outer: false, inner: false },
  ]);
  await read(launched.page, 1);
  await close(0);
  launched = await launch(1);
  await read(launched.page, 1);
  const second = await run(launched.page, 1);
  phases.push({
    instanceId: launched.server.instanceId,
    candidateId: expected.candidates[1]!.id,
    outputs: second,
  });
  await close(1);
  assert.equal(
    (await query<{ candidateId: string }>('rollback')).candidateId,
    expected.candidates[0]!.id,
  );
  launched = await launch(0);
  await read(launched.page, 2);
  const third = await run(launched.page, 2);
  phases.push({
    instanceId: launched.server.instanceId,
    candidateId: expected.candidates[0]!.id,
    outputs: third,
  });
  await close(2);
  assert.equal(
    (await query<{ candidateId: string }>('rollback')).candidateId,
    expected.candidates[1]!.id,
  );
  launched = await launch(1);
  const final = await read(launched.page, 3);
  phases.push({
    instanceId: launched.server.instanceId,
    candidateId: expected.candidates[1]!.id,
    outputs: final,
  });
  await close(3);
  assert.equal((await query<{ removed: boolean }>('uninstall')).removed, true);
  writeFileSync(join(home!, 'native-version-report.json'), JSON.stringify({ owned, phases }));
  stage('complete', {
    windows: 4,
    normalExits: 4,
    modelCalls: 3,
    fullBodyBytes: Buffer.byteLength(expected.bodies[1]!),
    fullBodyHash: createHash('sha256').update(expected.bodies[1]!).digest('hex'),
    restoredData: false,
  });
} catch (error) {
  if (app) {
    try {
      const page = await app.firstWindow();
      writeFileSync(
        join(home!, 'native-version-failure.txt'),
        await page.locator('body').innerText(),
      );
      await page.screenshot({ path: join(home!, 'native-version-failure.png'), fullPage: true });
      if (tracingActive) {
        await page
          .context()
          .tracing.stop({ path: join(home!, 'native-version-failure-trace.zip') });
        tracingActive = false;
      }
      stage('failure', { error: String(error), state: await state(page) });
    } catch {}
    try {
      await close(owned.length - 1);
    } catch {}
  }
  throw error;
} finally {
  writeFileSync(join(home!, 'native-version-owned.json'), JSON.stringify(owned));
  if (app) {
    const current = app,
      timer = setTimeout(() => current.process().kill('SIGKILL'), 2000);
    try {
      await current.close();
    } finally {
      clearTimeout(timer);
    }
  }
}
