import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ExecutionRecord } from '@kite-ai/agent/storage';
import type { ModelOutputSnapshot, ServerInfo } from '@kite-ai/client';
import type { WebPreferences } from 'electron';
import type { ElectronApplication, Page } from 'playwright';
import type {
  NativeCallerMetadata,
  NativeModelOutputChunk,
  NativeModelOutputOpen,
  NativeState,
  NativeWorkspaceRemoval,
} from '../src/native-bridge';
import { readNativeModelOutput } from '../src/native-model-output';

async function openSessionTools(page: import('playwright').Page) {
  const toggle = page.getByRole('button', { name: '会话工具', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

const [launcher, home, control, desktopPackage, mode] = process.argv.slice(2) as string[];
const { _electron } = createRequire(desktopPackage!)('playwright') as typeof import('playwright');
const expected = JSON.parse(readFileSync(join(home!, 'expected.json'), 'utf8')) as {
  storeId: string;
  sessionId: string;
  candidates: { root: string; id: string; electron: string }[];
  tasks: string[];
  bodies: string[];
};
type Physical = {
  path: string;
  method: string;
  query: string;
  body?: string;
  output?: ModelOutputSnapshot;
  json?: unknown;
};
type Globals = typeof globalThis & {
  versionPhysical: Physical[];
  versionServer?: Promise<ServerInfo>;
};
type Facts = {
  cursor: string;
  storeId: string;
  runs: { id: string; originCommandId: string; status: string }[];
  commands: { id: string; status: string; originStoreId: string }[];
  executions: ExecutionRecord[];
  extensionCommands: { id: string; status: string }[];
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
async function readCallerBody(page: Page, row: NativeCallerMetadata): Promise<string> {
  return await page.evaluate(async (row) => {
    const readId = crypto.randomUUID();
    let offset = 0,
      body = '';
    try {
      for (;;) {
        const chunk = await window.kiteNative!.request({
          method: 'caller.body',
          generation: 1,
          commandId: row.request.commandId,
          readId,
          offset,
          limit: 65536,
        });
        if (
          !chunk ||
          !('readId' in chunk) ||
          chunk.kind !== 'caller.body' ||
          chunk.commandId !== row.request.commandId ||
          chunk.readId !== readId ||
          chunk.offset !== offset ||
          chunk.bodyDigest !== row.bodyDigest
        )
          throw Error('db9_original_body_identity');
        body += chunk.data;
        if (chunk.eof) {
          const bytes = new TextEncoder().encode(body);
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            (value) => value.toString(16).padStart(2, '0'),
          ).join('');
          if (bytes.length !== chunk.bodyBytes || digest !== row.bodyDigest)
            throw Error('db9_original_body_integrity');
          return body;
        }
        if (chunk.nextOffset <= offset) throw Error('db9_original_body_gap');
        offset = chunk.nextOffset;
      }
    } finally {
      await window.kiteNative!.request({ method: 'caller.close', generation: 1, readId });
    }
  }, row);
}
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
      const row: Physical = {
        path: url.pathname,
        query: url.search,
        method: args[1]?.method ?? 'GET',
        ...(typeof args[1]?.body === 'string' ? { body: args[1].body } : {}),
      };
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
      if (
        response.ok &&
        row.method === 'GET' &&
        (/\/executions\//.test(url.pathname) || /\/queries\//.test(url.pathname))
      )
        row.json = await response.clone().json();
      return response;
    }) as typeof fetch;
  });
  await page.getByRole('button', { name: 'Native real versions', exact: true }).click();
  if (mode === 'db8-cold' && index === 0) {
    const failure = page.getByRole('alertdialog', { name: '操作未完成', exact: true });
    await failure.getByText('draft_storage_unavailable', { exact: true }).waitFor();
    await failure.getByRole('button', { name: '确定', exact: true }).click();
  }
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
    .getByRole('article', { name: /^(assistant 消息|助手消息)$/ });
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
  if (mode === 'db8-cold') {
    const saved = JSON.parse(
      readFileSync(join(home!, 'native-db8-intent.json'), 'utf8'),
    ) as NativeWorkspaceRemoval;
    const db9 = JSON.parse(readFileSync(join(home!, 'native-db9-intent.json'), 'utf8')) as {
      intent: NativeCallerMetadata;
      body: string;
      execution: Facts['executions'][number];
      command: Facts['extensionCommands'][number];
      finding: unknown;
    };
    assert.equal(
      (await query<{ candidateId: string }>('rollback')).candidateId,
      expected.candidates[0]!.id,
    );
    let cold = await launch(0);
    const rejected = await cold.page.evaluate(async (sessionId) => {
      try {
        await window.kiteNative!.request({ method: 'draft.read', generation: 1, sessionId });
        return 'unexpected_success';
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        return failure.code ?? failure.message;
      }
    }, expected.sessionId);
    assert.equal(rejected, 'draft_storage_unavailable');
    assert.equal((await state(cold.page)).callerUnavailable, true);
    await read(cold.page, 3);
    const oldPhysical = await app!.evaluate(() => (globalThis as Globals).versionPhysical);
    assert.ok(oldPhysical.every((row) => row.method === 'GET'));
    assert.equal((await query<{ unchanged: boolean }>('db8-private')).unchanged, true);
    await close(4);
    assert.equal(
      (await query<{ candidateId: string }>('rollback')).candidateId,
      expected.candidates[1]!.id,
    );
    cold = await launch(1);
    await read(cold.page, 3);
    const original = (await state(cold.page)).workspaceRemovalSubmissions!.find(
      (row) => row.commandId === saved.commandId,
    )!;
    assert.equal(original.phase, 'unknown');
    assert.equal(original.storeId, saved.storeId);
    assert.equal(original.workspaceId, saved.workspaceId);
    assert.equal((await query<{ unchanged: boolean }>('db8-private')).unchanged, true);
    await app!.evaluate(() => {
      (globalThis as Globals).versionPhysical = [];
    });
    await cold.page.getByRole('button', { name: '查询原移除', exact: true }).click();
    const lookedUp = await waitState(
      cold.page,
      (value) =>
        value.workspaceRemovalSubmissions?.some(
          (row) => row.commandId === saved.commandId && row.phase === 'applied',
        ) === true,
    );
    const applied = lookedUp.workspaceRemovalSubmissions!.find(
      (row) => row.commandId === saved.commandId,
    )!;
    assert.equal(applied.receipt!.originStoreId, saved.storeId);
    assert.equal(applied.receipt!.workspaceId, saved.workspaceId);
    assert.equal(applied.receipt!.deletedSessions, 0);
    const physical = await app!.evaluate(() => (globalThis as Globals).versionPhysical);
    assert.ok(physical.every((row) => row.method === 'GET'));
    assert.ok(
      physical.some(
        (row) =>
          row.path === `/v1/workspaces/${saved.workspaceId}/removals/${saved.commandId}` &&
          row.query === `?storeId=${saved.storeId}`,
      ),
    );

    await query('db9-current-private');
    const coldIntent = (await state(cold.page)).callerSubmissions!.find(
      (row) => row.request.commandId === db9.intent.request.commandId,
    )!;
    assert.deepEqual(coldIntent, db9.intent);
    assert.equal(await readCallerBody(cold.page, coldIntent), db9.body);
    const beforeExtension = await query<Facts>('snapshot');
    assert.deepEqual(
      beforeExtension.executions.find((row) => row.id === db9.execution.id),
      db9.execution,
    );
    assert.deepEqual(
      beforeExtension.extensionCommands.find((row) => row.id === db9.command.id),
      db9.command,
    );
    await openSessionTools(cold.page);
    const panel = cold.page.locator('details[aria-label="扩展能力"]');
    await panel.locator('summary').click();
    await panel.getByRole('heading', { name: 'fixture.mini-review · 1', exact: true }).waitFor();
    assert.equal((await query<{ unchanged: boolean }>('db9-private')).unchanged, true);
    await app!.evaluate(() => {
      (globalThis as Globals).versionPhysical = [];
    });
    const originalRow = panel.locator('p').filter({ hasText: db9.intent.request.commandId });
    await originalRow.getByRole('button', { name: '查询原命令', exact: true }).click();
    await panel
      .getByRole('status')
      .getByText(`原命令 ${db9.intent.request.commandId}：succeeded`, { exact: true })
      .waitFor();
    const lookedUpExtension = (await state(cold.page)).callerSubmissions!.find(
      (row) => row.request.commandId === db9.intent.request.commandId,
    )!;
    assert.deepEqual(lookedUpExtension.request, db9.intent.request);
    assert.deepEqual(lookedUpExtension.scope, db9.intent.scope);
    assert.deepEqual(lookedUpExtension.target, db9.intent.target);
    const queryForm = panel
      .locator('div')
      .filter({
        has: cold.page.getByRole('heading', {
          name: 'Read saved results with a generic public presentation',
          exact: true,
        }),
      })
      .first();
    await queryForm.getByRole('button', { name: '读取结果', exact: true }).click();
    await panel.getByText('Review db9-real-code-original: unmarked', { exact: true }).waitFor();
    const extensionPhysical = await app!.evaluate(() => (globalThis as Globals).versionPhysical);
    assert.ok(
      extensionPhysical.length > 0 && extensionPhysical.every((row) => row.method === 'GET'),
    );
    assert.ok(
      extensionPhysical.some((row) =>
        row.path.endsWith(`/commands/${db9.intent.request.commandId}`),
      ),
    );
    assert.ok(
      extensionPhysical.some((row) => row.path.endsWith(`/executions/${db9.execution.id}`)),
    );
    assert.deepEqual(
      extensionPhysical.find((row) => row.path.endsWith(`/executions/${db9.execution.id}`))!.json,
      // GET /executions/:id uses the complete public Execution schema, not the Core record.
      {
        id: db9.execution.id,
        originStoreId: db9.execution.originStoreId,
        childSessionId: db9.execution.childSessionId,
        parentExecutionId: db9.execution.parentExecutionId,
        cancelWithParent: db9.execution.cancelWithParent,
        sessionId: db9.execution.sessionId,
        runId: db9.execution.runId,
        kind: db9.execution.kind,
        definitionId: db9.execution.definitionId,
        definitionVersion: db9.execution.definitionVersion,
        status: db9.execution.status,
        result: db9.execution.result,
        resultRevision: db9.execution.resultRevision,
        cancelRequestedAt: db9.execution.cancelRequestedAt,
        delivery: db9.execution.delivery,
        deliveryReason: db9.execution.deliveryReason,
      },
    );
    assert.deepEqual(
      extensionPhysical.find((row) => row.path.endsWith('/queries/fixture.mini-review.results'))!
        .json,
      db9.finding,
    );
    const afterExtension = await query<Facts>('snapshot');
    assert.deepEqual(afterExtension, beforeExtension);
    assert.equal(afterExtension.providerCalls, 3);
    assert.equal(await readCallerBody(cold.page, lookedUpExtension), db9.body);
    await close(5);
    assert.equal((await query<{ removed: boolean }>('uninstall')).removed, true);
    writeFileSync(
      join(home!, 'native-db8-report.json'),
      JSON.stringify({
        owned,
        saved,
        rejected,
        applied,
        oldPhysical,
        physical,
        db9: {
          original: db9,
          lookedUp: lookedUpExtension,
          extensionPhysical,
          after: afterExtension,
        },
      }),
    );
    stage('db9_cold_complete', {
      privateFormat: 9,
      extensionCommandId: db9.intent.request.commandId,
      originalBodyHash: db9.intent.bodyDigest,
      normalExits: 2,
      oldPrivateError: rejected,
      originalCommandId: saved.commandId,
      storeId: saved.storeId,
      newModelCalls: 0,
      restoredData: false,
    });
  } else {
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
    if (process.platform === 'darwin') {
      const witness = (await state(launched.page)).directory!.workspaces.find(
        (w) => w.id === 'db8-removal-workspace',
      )!;
      assert.ok(witness);
      await app!.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
        const original = globalThis.fetch;
        let drop = true;
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
          const response = await original(...args);
          if (
            drop &&
            new URL(String(args[0])).pathname === '/v1/workspaces/db8-removal-workspace/remove' &&
            response.ok
          ) {
            drop = false;
            throw Error('owned_db8_lost_reply');
          }
          return response;
        }) as typeof fetch;
        (globalThis as Globals).versionPhysical = [];
      });
      await launched.page
        .getByRole('button', { name: `移除 ${witness.name}`, exact: true })
        .locator('..')
        .hover();
      await launched.page
        .getByRole('button', { name: `移除 ${witness.name}`, exact: true })
        .click();
      const unknownState = await waitState(
        launched.page,
        (value) =>
          value.workspaceRemovalSubmissions?.some(
            (row) => row.workspaceId === witness.id && row.phase === 'unknown',
          ) === true,
      );
      const saved = unknownState.workspaceRemovalSubmissions!.find(
        (row) => row.workspaceId === witness.id,
      )!;
      assert.equal(saved.storeId, expected.storeId);
      assert.ok(saved.commandId);
      const posts = (await app!.evaluate(() => (globalThis as Globals).versionPhysical)).filter(
        (row) => row.method === 'POST',
      );
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.path, '/v1/workspaces/db8-removal-workspace/remove');
      assert.deepEqual(JSON.parse(posts[0]!.body!), {
        expectedStoreId: expected.storeId,
        commandId: saved.commandId,
      });
      writeFileSync(join(home!, 'native-db8-intent.json'), JSON.stringify(saved));
      stage('db8_original_sidebar_unknown', { commandId: saved.commandId, singlePost: true });
      await openSessionTools(launched.page);
      const permissions = launched.page.getByRole('region', {
        name: '权限与工作区信任',
        exact: true,
      });
      await permissions
        .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
        .check();
      await permissions.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
      await permissions
        .getByText(/^工作区：native-version-workspace；信任状态：trusted；版本：/)
        .waitFor();
      await permissions.getByRole('radio', { name: 'Full', exact: true }).check();
      await permissions.getByRole('button', { name: '保存模式选择', exact: true }).click();
      await permissions.getByText(/^当前模式：full；默认模式：/).waitFor();
      assert.equal((await query<{ version: number }>('db8-capture')).version, 8);
      const sourceFacts = await state(launched.page);
      const sourceModel = sourceFacts.selection!.executions.find(
        (value) =>
          value.kind === 'model' &&
          value.status === 'succeeded' &&
          value.id === final[1]!.executionId,
      )!;
      assert.ok(sourceModel);
      const originalFacts = await query<Facts>('snapshot');
      const sourceOriginal = originalFacts.executions.find((row) => row.id === sourceModel.id);
      const panel = launched.page.locator('details[aria-label="扩展能力"]');
      await panel.locator('summary').click();
      const extension = panel.locator('section').filter({
        has: launched.page.getByRole('heading', { name: 'fixture.mini-review · 1', exact: true }),
      });
      await extension.waitFor();
      const analyze = extension
        .locator('div')
        .filter({
          has: launched.page.getByRole('heading', {
            name: 'Analyze one authorized source result using a new explicit business identity',
            exact: true,
          }),
        })
        .first();
      await analyze
        .getByRole('textbox', { name: 'businessKey', exact: true })
        .fill('db9-real-code-original');
      await analyze
        .getByRole('textbox', { name: 'sourceRunId', exact: true })
        .fill(sourceModel.runId!);
      await analyze
        .getByRole('textbox', { name: 'sourceExecutionId', exact: true })
        .fill(sourceModel.id);
      await app!.evaluate(() => {
        const original = globalThis.fetch;
        let drop = true;
        (globalThis as Globals).versionPhysical = [];
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
          const response = await original(...args);
          if (
            drop &&
            args[1]?.method === 'POST' &&
            new URL(String(args[0])).pathname.endsWith('/commands') &&
            typeof args[1]?.body === 'string' &&
            JSON.parse(args[1].body).kind === 'extension.invoke' &&
            response.ok
          ) {
            drop = false;
            throw Error('owned_db9_original_lost_reply');
          }
          return response;
        }) as typeof fetch;
      });
      await analyze.getByRole('button', { name: '执行动作', exact: true }).click();
      const extensionState = await waitState(
        launched.page,
        (value) =>
          value.callerSubmissions?.some(
            (row) => row.request.kind === 'extension.invoke' && row.phase === 'unknown',
          ) === true,
      );
      const intent = extensionState.callerSubmissions!.find(
        (row) => row.request.kind === 'extension.invoke',
      )!;
      assert.equal(intent.scope.storeId, expected.storeId);
      assert.equal(intent.scope.sessionId, expected.sessionId);
      const completionDeadline = Date.now() + 10000;
      const existingExecutions = new Set(originalFacts.executions.map((row) => row.id));
      let terminalId = '';
      for (;;) {
        const current = await state(launched.page);
        const selected = current.selection;
        const terminal = selected?.executions.find(
          (row) =>
            row.kind === 'job' &&
            !existingExecutions.has(row.id) &&
            row.definitionId === 'fixture.mini-review/fixture.mini-review.analyze' &&
            row.definitionVersion === '1' &&
            row.runId === null &&
            row.parentExecutionId === null,
        );
        if (
          selected?.storeId === intent.scope.storeId &&
          selected.session.id === intent.scope.sessionId &&
          selected.session.workspaceId === intent.scope.workspaceId &&
          terminal?.originStoreId === intent.scope.storeId &&
          terminal.sessionId === intent.scope.sessionId &&
          terminal.status === 'succeeded'
        ) {
          terminalId = terminal.id;
          break;
        }
        if (Date.now() >= completionDeadline) throw Error('db9_original_action_not_complete');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const terminalFacts = await query<Facts>('snapshot');
      const execution = terminalFacts.executions.find(
        (row) => row.kind === 'job' && row.originCommandId === intent.request.commandId,
      )!;
      const command = terminalFacts.extensionCommands.find(
        (row) => row.id === intent.request.commandId,
      )!;
      assert.equal(execution.id, terminalId);
      assert.equal(execution.originCommandId, intent.request.commandId);
      assert.equal(execution.status, 'succeeded');
      assert.equal(command.status, 'applied');
      const queryForm = extension
        .locator('div')
        .filter({
          has: launched.page.getByRole('heading', {
            name: 'Read saved results with a generic public presentation',
            exact: true,
          }),
        })
        .first();
      await queryForm.getByRole('button', { name: '读取结果', exact: true }).click();
      await panel.getByText('Review db9-real-code-original: unmarked', { exact: true }).waitFor();
      const physical = await app!.evaluate(() => (globalThis as Globals).versionPhysical);
      const extensionPosts = physical.filter((row) => row.method === 'POST');
      assert.equal(extensionPosts.length, 1);
      assert.deepEqual(JSON.parse(extensionPosts[0]!.body!), {
        kind: 'extension.invoke',
        expectedStoreId: expected.storeId,
        extensionId: 'fixture.mini-review',
        commandId: intent.request.commandId,
        actionId: 'fixture.mini-review.analyze',
        definitionVersion: '1',
        input: {
          businessKey: 'db9-real-code-original',
          sourceRunId: sourceModel.runId,
          sourceExecutionId: sourceModel.id,
        },
      });
      assert.deepEqual(
        JSON.parse(await readCallerBody(launched.page, intent)),
        JSON.parse(extensionPosts[0]!.body!),
      );
      const finding = physical.find((row) =>
        row.path.endsWith('/queries/fixture.mini-review.results'),
      )!.json;
      assert.ok(Array.isArray(finding) && finding.length === 1);
      assert.ok(sourceOriginal);
      assert.equal(sourceOriginal.runId, sourceModel.runId);
      assert.equal(sourceOriginal.resultRevision, sourceModel.resultRevision);
      assert.deepEqual(finding[0].payload, {
        businessKey: 'db9-real-code-original',
        source: {
          runId: sourceModel.runId,
          executionId: sourceModel.id,
          resultRevision: sourceModel.resultRevision,
          result: sourceOriginal.result,
        },
        findings: ['Check the saved source result.'],
        marked: false,
      });
      const sourceResult = sourceOriginal.result as {
        content: string;
        reasoning: string;
        modelOutput: { complete: boolean; contentBytes: string; reasoningBytes: string };
      };
      assert.ok(expected.bodies[1]!.startsWith(sourceResult.content));
      assert.equal(sourceResult.modelOutput.complete, true);
      assert.equal(
        sourceResult.modelOutput.contentBytes,
        String(Buffer.byteLength(expected.bodies[1]!)),
      );
      assert.equal(sourceResult.modelOutput.reasoningBytes, final[1]!.reasoningBytes);
      assert.equal(final[1]!.output.content, expected.bodies[1]);
      assert.equal(final[1]!.output.reasoning, '');
      assert.equal(sourceResult.reasoning, final[1]!.output.reasoning);

      assert.equal(terminalFacts.providerCalls, 3);
      writeFileSync(
        join(home!, 'native-db9-intent.json'),
        JSON.stringify({
          intent,
          body: await readCallerBody(launched.page, intent),
          execution,
          command,
          finding,
        }),
      );
      stage('db9_original_action_unknown_complete', {
        commandId: intent.request.commandId,
        executionId: execution.id,
        singlePost: true,
      });
    }
    await close(3);
    // macOS keeps these same installed candidates for the separate bounded DB8 cold
    // driver. That driver performs the original uninstall after both ordinary exits.
    if (process.platform !== 'darwin')
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
  }
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
