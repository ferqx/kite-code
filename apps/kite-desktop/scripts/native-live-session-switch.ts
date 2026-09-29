import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type Browser, chromium } from 'playwright';

if (process.platform !== 'darwin') throw new Error('The live native window test requires macOS.');
if (process.env.KITE_RUN_LIVE_NATIVE_SWITCH !== '1')
  throw new Error('Set KITE_RUN_LIVE_NATIVE_SWITCH=1 to allow the external model test.');
const apiKey = process.env.KITE_LIVE_DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('Set KITE_LIVE_DEEPSEEK_API_KEY for the live native window test.');

const model = 'deepseek-flash';
const baseURL = 'https://api.deepseek.com/v1';
const preflight = await fetch(`${baseURL}/models`, {
  headers: { Authorization: `Bearer ${apiKey}` },
  signal: AbortSignal.timeout(15_000),
});
if (!preflight.ok)
  throw new Error(`DeepSeek model preflight failed with HTTP ${preflight.status}.`);
const models = (await preflight.json()) as { data?: readonly { id?: string }[] };
if (!models.data?.some((entry) => entry.id === model))
  throw new Error(`DeepSeek did not advertise ${model}.`);

const packagedExecutable = resolve(
  process.env.KITE_LIVE_NATIVE_EXECUTABLE ??
    process.argv[2] ??
    join(import.meta.dir, `../out/kite-darwin-${process.arch}/kite.app/Contents/MacOS/kite`),
);
if (!existsSync(packagedExecutable)) throw new Error('The packaged Kite executable is missing.');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-live-switch-')));
const appData = join(home, 'app-data');
const application = join(home, 'kite.app');
const workspace = join(home, 'workspace');
const gatePaths = [join(workspace, 'native-gate-a'), join(workspace, 'native-gate-b')];
const releaseProcesses: ReturnType<typeof Bun.spawn>[] = [];
let releasedGates = 0;
try {
  mkdirSync(appData, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(home, '.kite-code'), { mode: 0o700 });
  for (const path of gatePaths) {
    const created = Bun.spawnSync(['/usr/bin/mkfifo', path], { stdout: 'ignore', stderr: 'pipe' });
    if (created.exitCode !== 0) throw new Error('Could not create an isolated child gate.');
  }
  writeFileSync(
    join(home, '.kite-code/kite-code.jsonc'),
    JSON.stringify({
      provider: {
        deepseek: {
          type: 'deepseek',
          apiKey,
          baseURL,
          model,
          models: [{ name: model, contextWindow: 131_072, maxOutputTokens: 4_096 }],
        },
      },
      model: { default: { provider: 'deepseek', name: model } },
      interactionMode: 'auto',
      features: { resourceBudget: true, boundedCancellation: true },
      sandbox: { enabled: false },
      mcpServers: {},
    }),
    { mode: 0o600 },
  );
  cpSync(resolve(dirname(packagedExecutable), '../..'), application, {
    recursive: true,
    verbatimSymlinks: true,
  });
} catch (error) {
  rmSync(home, { recursive: true, force: true });
  throw error;
}

const executable = join(application, 'Contents/MacOS/kite');
// app.getPath('home') ignores shell HOME on macOS. Pause before the packaged
// entrypoint reads paths, then isolate this process without product test flags.
let child: ReturnType<typeof spawn>;
try {
  child = spawn(executable, ['--inspect-brk=0', '--remote-debugging-port=0'], {
    cwd: home,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (error) {
  rmSync(home, { recursive: true, force: true });
  throw error;
}
const exited = new Promise<number | null>((done, fail) => {
  child.once('exit', done);
  child.once('error', fail);
});
let logs = '';
child.stderr!.on('data', (chunk: Buffer) => {
  logs = (logs + chunk.toString()).slice(-16_384);
});
async function endpoint(expression: RegExp): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = logs.match(expression);
    if (match?.[1]) return match[1];
    if (child.exitCode !== null) throw new Error('The isolated Electron process exited early.');
    await Bun.sleep(25);
  }
  throw new Error('The isolated Electron debugger did not start.');
}
function releaseGate(path: string, marker: string): ReturnType<typeof Bun.spawn> {
  const process = Bun.spawn(
    ['/bin/sh', '-c', 'printf "%s\\n" "$1" > "$2"', 'release', marker, path],
    {
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  releaseProcesses.push(process);
  return process;
}
async function waitFor(description: string, predicate: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
function readFacts() {
  const path = join(home, '.kite-code/kite-session.sqlite');
  if (!existsSync(path)) return undefined;
  const database = new Database(path, { readonly: true });
  try {
    const row = database
      .query<{ session_id: string }, [string]>(
        'SELECT session_id FROM runtime_snapshots WHERE state_json LIKE ? ORDER BY revision DESC LIMIT 1',
      )
      .get('%NATIVE_LIVE_SWITCH_A%');
    if (!row) return undefined;
    const run = database
      .query<{ run_id: string; status: string }, [string]>(
        'SELECT run_id, status FROM runtime_runs WHERE session_id = ? ORDER BY created_at_ms DESC LIMIT 1',
      )
      .get(row.session_id);
    if (!run) return undefined;
    const events = database
      .query<{ event_json: string }, [string]>(
        'SELECT event_json FROM runtime_events WHERE session_id = ? ORDER BY sequence',
      )
      .all(row.session_id)
      .map(({ event_json }) => JSON.parse(event_json) as { type: string });
    const taskCalls = database
      .query<{ background: number | null; disposition: string | null }, [string]>(
        `SELECT json_extract(event_json, '$.args.background') AS background,
          json_extract(event_json, '$.args.result_disposition') AS disposition
         FROM runtime_events WHERE session_id = ?
           AND json_extract(event_json, '$.type') = 'tool.queued'
           AND json_extract(event_json, '$.name') = 'task'`,
      )
      .all(row.session_id);
    const childCommands = database
      .query<{ session_id: string; command: string | null; timeout_ms: number | null }, []>(
        `SELECT session_id, json_extract(event_json, '$.args.command') AS command,
          json_extract(event_json, '$.args.timeout_ms') AS timeout_ms
         FROM runtime_events WHERE json_extract(event_json, '$.type') = 'tool.queued'
           AND json_extract(event_json, '$.name') = 'shell_execute'`,
      )
      .all();
    const childTerminals = database
      .query<{ session_id: string }, []>(
        `SELECT DISTINCT queued.session_id FROM runtime_events AS queued
         JOIN runtime_events AS terminal
           ON terminal.session_id = queued.session_id
          AND json_extract(terminal.event_json, '$.toolCallId') =
              json_extract(queued.event_json, '$.toolCallId')
         WHERE json_extract(queued.event_json, '$.type') = 'tool.queued'
           AND json_extract(queued.event_json, '$.name') = 'shell_execute'
           AND json_extract(queued.event_json, '$.args.command') IN
             ('head -n 1 native-gate-a', 'head -n 1 native-gate-b')
           AND json_extract(terminal.event_json, '$.type') IN
             ('tool.finished', 'tool.failed', 'tool.rejected', 'tool.cancelled')`,
      )
      .all();
    return {
      sessionId: row.session_id,
      runId: run.run_id,
      runStatus: run.status,
      eventTypes: events.map((event) => event.type),
      taskCalls,
      childCommands,
      childTerminals: new Set(childTerminals.map((terminal) => terminal.session_id)),
    };
  } finally {
    database.close(false);
  }
}

let browser: Browser | undefined;
let inspector: WebSocket | undefined;
let main: ((expression: string) => Promise<unknown>) | undefined;
try {
  inspector = new WebSocket(await endpoint(/Debugger listening on (ws:\/\/[^\s]+)/u));
  await new Promise<void>((done, fail) => {
    inspector!.addEventListener('open', () => done(), { once: true });
    inspector!.addEventListener('error', () => fail(new Error('Inspector connection failed.')), {
      once: true,
    });
  });
  type InspectorResult = { result?: { value?: unknown }; exceptionDetails?: unknown };
  const pending = new Map<number, (result: InspectorResult) => void>();
  let nextId = 0;
  let onPause: (frameId: string) => void = () => {};
  inspector.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Debugger.paused') onPause(message.params.callFrames[0].callFrameId);
    const accept = pending.get(message.id);
    if (accept) {
      pending.delete(message.id);
      accept(message.result);
    }
  });
  const command = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    return Promise.race([
      new Promise<InspectorResult>((done) => {
        pending.set(id, done);
        inspector!.send(JSON.stringify({ id, method, params }));
      }),
      Bun.sleep(30_000).then(() => {
        throw new Error(`Electron inspector timed out: ${method}`);
      }),
    ]);
  };
  await command('Runtime.enable');
  await command('Debugger.enable');
  const paused = new Promise<string>((done) => {
    onPause = done;
  });
  await command('Runtime.runIfWaitingForDebugger');
  const callFrameId = await paused;
  const isolated = await command('Debugger.evaluateOnCallFrame', {
    callFrameId,
    expression: `globalThis.__kiteLiveWindow = require('electron');
__kiteLiveWindow.app.setPath('home', ${JSON.stringify(home)});
__kiteLiveWindow.app.setPath('appData', ${JSON.stringify(appData)});
__kiteLiveWindow.app.setPath('userData', ${JSON.stringify(join(appData, 'dev.kite-code.desktop'))});
__kiteLiveWindow.app.getPath('home')`,
    returnByValue: true,
  });
  assert.equal(isolated.result?.value, home);
  main = async (expression) => {
    const result = await command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error('Electron main evaluation failed.');
    return result.result?.value;
  };
  await command('Debugger.resume');
  browser = await chromium.connectOverCDP(await endpoint(/DevTools listening on (ws:\/\/[^\s]+)/u));
  assert.deepEqual(
    await main(
      `({home: __kiteLiveWindow.app.getPath('home'), packaged: __kiteLiveWindow.app.isPackaged})`,
    ),
    { home, packaged: true },
  );
  await main(`__kiteLiveWindow.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(workspace)}] });
__kiteLiveWindow.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });`);

  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.getByRole('button', { name: '新对话', exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByRole('button', { name: '项目空间', exact: true }).click();
  await page.getByRole('menuitem', { name: '添加项目…', exact: true }).click();

  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.fill('NATIVE_LIVE_SWITCH_B: reply exactly NATIVE_LIVE_SWITCH_B_READY.');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page
    .locator('.message.assistant[data-final-reply="true"]')
    .filter({ hasText: 'NATIVE_LIVE_SWITCH_B_READY' })
    .waitFor({ timeout: 90_000 });

  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await input.fill(
    [
      'NATIVE_LIVE_SWITCH_A: test required background delegation.',
      'In one response, dispatch exactly two independent explore task calls with background=true and result_disposition="required".',
      'Child A must make exactly one shell_execute call with command `head -n 1 native-gate-a` and timeout_ms=180000, then report the line returned by that command. The path is a FIFO; do not substitute read_file.',
      'Child B must make exactly one shell_execute call with command `head -n 1 native-gate-b` and timeout_ms=180000, then report the line returned by that command. The path is a FIFO; do not substitute read_file.',
      'After both task calls are accepted, call task_wait once with both returned task_id values and timeout_ms=60000. Do not call other parent tools.',
      'Once both children finish, reply exactly NATIVE_LIVE_SWITCH_A_DONE.',
    ].join('\n'),
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();

  try {
    await waitFor(
      'two active real child shell calls',
      async () => {
        const facts = readFacts();
        if (!facts) return false;
        if (['failed', 'cancelled', 'recovery_required', 'completed'].includes(facts.runStatus))
          throw new Error(`A ended before both child calls were active: ${facts.runStatus}.`);
        const commands = facts.childCommands.filter((child) =>
          /^head -n 1 native-gate-[ab]$/u.test(child.command ?? ''),
        );
        return (
          facts.eventTypes.filter((type) => type === 'subagent.started').length === 2 &&
          facts.taskCalls.length === 2 &&
          facts.taskCalls.every(
            (call) => call.background === 1 && call.disposition === 'required',
          ) &&
          commands.length === 2 &&
          new Set(commands.map((child) => child.session_id)).size === 2 &&
          commands.every((child) => child.timeout_ms === 180_000) &&
          commands.every((child) => !facts.childTerminals.has(child.session_id))
        );
      },
      120_000,
    );
  } catch (error) {
    const facts = readFacts();
    console.error(
      JSON.stringify({
        phase: 'child-start-failed',
        runStatus: facts?.runStatus,
        eventTypes: facts?.eventTypes,
        taskCalls: facts?.taskCalls,
        childCommands: facts?.childCommands,
        childTerminalCount: facts?.childTerminals.size,
      }),
    );
    throw error;
  }
  const initial = readFacts()!;
  const aRow = page.locator('.session-row').filter({ hasText: 'NATIVE_LIVE_SWITCH_A' });
  const bRow = page.locator('.session-row').filter({ hasText: 'NATIVE_LIVE_SWITCH_B' });
  await aRow.waitFor();
  await bRow.waitFor();
  const childCards = page.getByRole('region', { name: '子智能体' });
  const childButtons = childCards.getByRole('button', { name: /^查看子 Agent 详情：/u });
  const assertParentActive = async (childTerminalCount = 0) => {
    await page.getByRole('button', { name: '停止任务' }).waitFor({ timeout: 15_000 });
    await input.waitFor({ timeout: 15_000 });
    await page.locator('.message.user').filter({ hasText: 'NATIVE_LIVE_SWITCH_A' }).waitFor();
    const facts = readFacts();
    assert.ok(facts, 'A must remain available after returning from child or B.');
    assert.equal(facts.sessionId, initial.sessionId);
    assert.equal(facts.runId, initial.runId);
    assert.ok(['running', 'waiting'].includes(facts.runStatus));
    assert.equal(facts.childTerminals.size, childTerminalCount);
  };
  const ensureChildCards = async () => {
    if ((await childCards.count()) === 0)
      await page.getByRole('button', { name: '显示环境信息' }).click();
    await waitFor(
      'both child detail entries',
      async () => (await childButtons.count()) === 2,
      15_000,
    );
  };
  const assertParentDisplayStable = async (
    expectedStatuses: readonly string[] = ['运行中', '运行中'],
  ) => {
    await ensureChildCards();
    await waitFor(
      'both child agents to recover their authoritative status',
      async () => {
        const statuses = await childCards.locator('.background-execution-status').allTextContents();
        return (
          statuses.length === 2 &&
          statuses.toSorted().join('|') === expectedStatuses.toSorted().join('|')
        );
      },
      10_000,
    );
    const sample = await page.evaluate(
      async (expected) => {
        const message = [...document.querySelectorAll<HTMLElement>('.message.user')].find((item) =>
          item.textContent?.includes('NATIVE_LIVE_SWITCH_A'),
        );
        if (!message) return { stable: false, reason: 'parent message missing' };
        const parent = message.parentElement;
        const existingMessages = [...document.querySelectorAll<HTMLElement>('.message')];
        for (let index = 0; index < 12; index++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const childGroup = document.querySelector('[aria-label="子智能体"]');
          const statuses = [
            ...(childGroup?.querySelectorAll<HTMLElement>('.background-execution-status') ?? []),
          ].map((item) => item.textContent);
          const missingMessages = existingMessages.filter((item) => !item.isConnected).length;
          const loading = !!document.querySelector('.conversation-loading');
          if (
            !message.isConnected ||
            message.parentElement !== parent ||
            missingMessages > 0 ||
            loading ||
            statuses.length !== expected.length ||
            statuses.toSorted().join('|') !== expected.toSorted().join('|')
          )
            return {
              stable: false,
              reason: JSON.stringify({
                sample: index,
                statuses,
                expected,
                userMessageConnected: message.isConnected,
                userMessageParentChanged: message.parentElement !== parent,
                missingMessages,
                loading,
              }),
            };
        }
        return { stable: true };
      },
      [...expectedStatuses],
    );
    if (!sample.stable) {
      const traces = await page.evaluate(() => {
        const monitor = window as Window & {
          __kiteChildStatusTrace?: { statuses: string[]; messageVisible: boolean; atMs: number }[];
          __kiteClientTrace?: unknown[];
        };
        return {
          childStatus: monitor.__kiteChildStatusTrace?.slice(-12) ?? [],
          client: monitor.__kiteClientTrace?.slice(-24) ?? [],
        };
      });
      console.error(
        JSON.stringify({ phase: 'display-stability-failed', reason: sample.reason, traces }),
      );
    }
    assert.equal(sample.stable, true, sample.reason ?? 'Parent display became unstable.');
  };
  await assertParentActive();
  await assertParentDisplayStable();
  const childLabels = await childButtons.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label')),
  );
  assert.equal(new Set(childLabels).size, 2);
  await page.evaluate(() => {
    const monitor = window as Window & {
      __kiteChildStatusTrace?: {
        statuses: string[];
        messageVisible: boolean;
        cardVisible: boolean;
        cardDisplay: string;
        cardVisibility: string;
        cardOpacity: number;
        loading: boolean;
        animated: boolean;
        atMs: number;
      }[];
      __kiteChildStatusObserver?: MutationObserver;
      __kiteChildStatusFrame?: number;
      __kiteChildStatusMonitoring?: boolean;
      __kiteClientTrace?: {
        atMs: number;
        selected?: string;
        ready: boolean;
        loading: boolean;
        childCount: number;
        backgroundStale?: boolean;
        backgroundIds: string[];
      }[];
    };
    monitor.__kiteChildStatusTrace = [];
    monitor.__kiteChildStatusMonitoring = true;
    const record = () => {
      const selected = document.querySelector<HTMLElement>('.session-row[aria-current="page"]');
      if (!selected?.textContent?.includes('NATIVE_LIVE_SWITCH_A')) return;
      if (
        [...document.querySelectorAll<HTMLButtonElement>('button')].some((button) =>
          button.textContent?.includes('返回父会话'),
        )
      )
        return;
      const messageVisible = [...document.querySelectorAll<HTMLElement>('.message.user')].some(
        (message) => message.textContent?.includes('NATIVE_LIVE_SWITCH_A'),
      );
      const group = document.querySelector('[aria-label="子智能体"]');
      const card = document.querySelector<HTMLElement>('.environment-information');
      const cardStyle = card && getComputedStyle(card);
      const cardDisplay = cardStyle?.display ?? 'missing';
      const cardVisibility = cardStyle?.visibility ?? 'missing';
      const cardOpacity = cardStyle ? Number(cardStyle.opacity) : 0;
      const cardVisible =
        cardDisplay !== 'none' && cardVisibility === 'visible' && cardOpacity > 0.99;
      const loading = card?.textContent?.includes('正在读取子 Agent') ?? false;
      const animated = !!card?.closest('.environment-information-animated');
      const statuses = [
        ...(group?.querySelectorAll<HTMLElement>('.background-execution-status') ?? []),
      ].map((item) => item.textContent?.trim() ?? '');
      const trace = monitor.__kiteChildStatusTrace!;
      if (
        trace.at(-1)?.statuses.join('|') !== statuses.join('|') ||
        trace.at(-1)?.messageVisible !== messageVisible ||
        trace.at(-1)?.cardVisible !== cardVisible ||
        trace.at(-1)?.cardDisplay !== cardDisplay ||
        trace.at(-1)?.cardVisibility !== cardVisibility ||
        trace.at(-1)?.cardOpacity !== cardOpacity ||
        trace.at(-1)?.loading !== loading ||
        trace.at(-1)?.animated !== animated
      )
        trace.push({
          statuses,
          messageVisible,
          cardVisible,
          cardDisplay,
          cardVisibility,
          cardOpacity,
          loading,
          animated,
          atMs: Math.round(performance.now()),
        });
    };
    monitor.__kiteChildStatusObserver = new MutationObserver(record);
    monitor.__kiteChildStatusObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
    record();
    const sampleFrame = () => {
      if (!monitor.__kiteChildStatusMonitoring) return;
      record();
      monitor.__kiteChildStatusFrame = requestAnimationFrame(sampleFrame);
    };
    monitor.__kiteChildStatusFrame = requestAnimationFrame(sampleFrame);
    const root = document.getElementById('root') as (HTMLElement & Record<string, unknown>) | null;
    const fiberKey = root && Object.keys(root).find((key) => key.startsWith('__reactContainer$'));
    const stack: unknown[] = fiberKey ? [root?.[fiberKey]] : [];
    while (stack.length) {
      const fiber = stack.pop() as {
        child?: unknown;
        sibling?: unknown;
        memoizedProps?: {
          client?: {
            getSnapshot: () => {
              selected?: string;
              ready: boolean;
              loadingSession: boolean;
              childSessions?: { entries: unknown[] };
              background?: Record<
                string,
                { stale: boolean; snapshot: { executions: { executionId: string }[] } }
              >;
            };
            subscribe: (callback: () => void) => () => void;
          };
        };
      };
      const client = fiber.memoizedProps?.client;
      if (client?.getSnapshot && client.subscribe) {
        monitor.__kiteClientTrace = [];
        const recordClient = () => {
          const state = client.getSnapshot();
          const background = state.selected ? state.background?.[state.selected] : undefined;
          const trace = monitor.__kiteClientTrace!;
          trace.push({
            atMs: Math.round(performance.now()),
            selected: state.selected,
            ready: state.ready,
            loading: state.loadingSession,
            childCount: state.childSessions?.entries.length ?? 0,
            backgroundStale: background?.stale,
            backgroundIds: background?.snapshot.executions.map((entry) => entry.executionId) ?? [],
          });
          if (trace.length > 2_000) trace.shift();
        };
        client.subscribe(recordClient);
        recordClient();
        break;
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
  });
  const visitedChildMessages = new Map<number, number>();
  let cachedChildRevisitsVerified = 0;
  const openChild = async (index: number) => {
    await ensureChildCards();
    const priorMessageCount = visitedChildMessages.get(index);
    if (priorMessageCount !== undefined) {
      await page.evaluate(() => {
        const monitor = window as Window & {
          __kiteCachedChildTrace?: { blank: boolean; loading: boolean; observed: boolean };
          __kiteCachedChildObserver?: MutationObserver;
        };
        monitor.__kiteCachedChildObserver?.disconnect();
        const trace = { blank: false, loading: false, observed: false };
        monitor.__kiteCachedChildTrace = trace;
        const record = () => {
          const childDetail = [...document.querySelectorAll<HTMLButtonElement>('button')].some(
            (button) => button.textContent?.includes('返回父会话'),
          );
          if (!childDetail) return;
          trace.observed = true;
          if (document.querySelector('.conversation-loading')) trace.loading = true;
          if (!document.querySelector('.message')) trace.blank = true;
        };
        monitor.__kiteCachedChildObserver = new MutationObserver(record);
        monitor.__kiteCachedChildObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
      });
    }
    await childCards.getByRole('button', { name: childLabels[index]!, exact: true }).click();
    await page.getByRole('button', { name: '返回父会话' }).waitFor({ timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const refresh = [...document.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('刷新详情'),
        );
        return refresh instanceof HTMLButtonElement && !refresh.disabled;
      },
      undefined,
      { timeout: 15_000 },
    );
    assert.equal(await input.count(), 0);
    assert.equal(await page.getByText('子会话读取失败', { exact: true }).count(), 0);
    const messageCount = await page.locator('.message').count();
    assert.ok(messageCount > 0, `Child ${index} has no rendered messages.`);
    visitedChildMessages.set(index, messageCount);
    if (priorMessageCount !== undefined) {
      const trace = await page.evaluate(() => {
        const monitor = window as Window & {
          __kiteCachedChildTrace?: { blank: boolean; loading: boolean; observed: boolean };
          __kiteCachedChildObserver?: MutationObserver;
        };
        monitor.__kiteCachedChildObserver?.disconnect();
        return monitor.__kiteCachedChildTrace;
      });
      assert.equal(trace?.observed, true, `Child ${index} detail was not observed.`);
      assert.equal(trace.blank, false, `Child ${index} detail flashed blank on revisit.`);
      assert.equal(trace.loading, false, `Child ${index} detail showed a loader on revisit.`);
      cachedChildRevisitsVerified++;
    }
  };
  const switchToBAndBack = async (
    childTerminalCount = 0,
    statuses: readonly string[] = ['运行中', '运行中'],
  ) => {
    await bRow.click();
    await page
      .locator('.message.assistant[data-final-reply="true"]')
      .filter({ hasText: 'NATIVE_LIVE_SWITCH_B_READY' })
      .waitFor({ timeout: 15_000 });
    await aRow.click();
    await assertParentActive(childTerminalCount);
    await assertParentDisplayStable(statuses);
  };
  const visitChild = async (
    index: number,
    destination: 'parent' | 'b',
    childTerminalCount = 0,
    statuses: readonly string[] = ['运行中', '运行中'],
  ) => {
    await openChild(index);
    if (destination === 'b') {
      // Sidebar navigation from a child detail must release its stream.
      await switchToBAndBack(childTerminalCount, statuses);
    } else {
      await page.getByRole('button', { name: '返回父会话' }).click();
      await assertParentActive(childTerminalCount);
      await assertParentDisplayStable(statuses);
    }
  };
  // Parent → child 1 → parent → child 2 → parent → B → parent.
  await visitChild(0, 'parent');
  await visitChild(1, 'parent');
  await switchToBAndBack();
  // Direct child-detail → B, reverse child order, and another B/A interleave.
  await visitChild(1, 'b');
  await visitChild(0, 'parent');
  await switchToBAndBack();
  await visitChild(0, 'parent');
  await visitChild(1, 'parent');
  await switchToBAndBack();
  await visitChild(0, 'b');
  await visitChild(1, 'parent');
  await switchToBAndBack();
  let childDetailVisits = 8;
  const switchCycles = 30;
  for (let cycle = 0; cycle < switchCycles; cycle++) {
    await bRow.click();
    await aRow.click();
    await assertParentActive();
    await ensureChildCards();
    const statuses = await childCards.locator('.background-execution-status').allTextContents();
    assert.equal(statuses.length, 2);
    assert.ok(!statuses.includes('不可用'), `Unexpected unavailable child at cycle ${cycle}.`);
  }
  await assertParentActive();
  await assertParentDisplayStable();
  const afterSwitch = readFacts()!;
  assert.equal(afterSwitch.sessionId, initial.sessionId);
  assert.equal(afterSwitch.runId, initial.runId);
  assert.ok(['running', 'waiting'].includes(afterSwitch.runStatus));
  assert.equal(afterSwitch.childTerminals.size, 0);
  console.log(
    JSON.stringify({ phase: 'window-switches-complete', switchCycles, childDetailVisits }),
  );

  // Settle only child 1 while reading child 2, then inspect the mixed parent state.
  await openChild(1);
  childDetailVisits++;
  const firstRelease = releaseGate(gatePaths[0]!, 'NATIVE_GATE_0_RELEASED');
  await Promise.race([
    firstRelease.exited,
    Bun.sleep(15_000).then(() => {
      throw new Error('The first child gate had no active FIFO reader.');
    }),
  ]);
  releasedGates = 1;
  await waitFor(
    'one child to finish while its sibling remains active',
    async () => readFacts()?.childTerminals.size === 1,
    45_000,
  );
  await page.getByRole('button', { name: '返回父会话' }).click();
  await assertParentActive(1);
  const mixedStatuses = ['已完成', '运行中'];
  await assertParentDisplayStable(mixedStatuses);
  await switchToBAndBack(1, mixedStatuses);
  await visitChild(0, 'parent', 1, mixedStatuses);
  childDetailVisits++;
  await visitChild(1, 'parent', 1, mixedStatuses);
  childDetailVisits++;
  const trace = await page.evaluate(() => {
    const monitor = window as Window & {
      __kiteChildStatusTrace?: {
        statuses: string[];
        messageVisible: boolean;
        cardVisible: boolean;
        cardDisplay: string;
        cardVisibility: string;
        cardOpacity: number;
        loading: boolean;
        animated: boolean;
        atMs: number;
      }[];
      __kiteChildStatusObserver?: MutationObserver;
      __kiteChildStatusFrame?: number;
      __kiteChildStatusMonitoring?: boolean;
    };
    monitor.__kiteChildStatusMonitoring = false;
    monitor.__kiteChildStatusObserver?.disconnect();
    if (monitor.__kiteChildStatusFrame !== undefined)
      cancelAnimationFrame(monitor.__kiteChildStatusFrame);
    return monitor.__kiteChildStatusTrace ?? [];
  });
  const invalidTrace = trace.filter(
    (entry) =>
      !entry.messageVisible ||
      !entry.cardVisible ||
      entry.loading ||
      entry.animated ||
      entry.statuses.length !== 2 ||
      entry.statuses.includes('不可用') ||
      entry.statuses.includes('状态待确认'),
  );
  assert.deepEqual(invalidTrace.slice(0, 10), [], 'A lost its message or child rows.');

  const releases = [releaseGate(gatePaths[1]!, 'NATIVE_GATE_1_RELEASED')];
  await Promise.race([
    Promise.all(releases.map((release) => release.exited)),
    Bun.sleep(15_000).then(() => {
      throw new Error('A child gate had no active FIFO reader after UI switching.');
    }),
  ]);
  releasedGates = gatePaths.length;
  await waitFor(
    'A and both children to complete',
    async () => {
      const facts = readFacts();
      return (
        facts?.runId === initial.runId &&
        facts.runStatus === 'completed' &&
        facts.eventTypes.filter((type) => type === 'subagent.background_result_persisted')
          .length === 2
      );
    },
    90_000,
  );
  await page
    .locator('.message.assistant[data-final-reply="true"]')
    .filter({ hasText: 'NATIVE_LIVE_SWITCH_A_DONE' })
    .waitFor({ timeout: 30_000 });
  const terminal = readFacts()!;
  assert.equal(terminal.runId, initial.runId);
  assert.equal(terminal.eventTypes.filter((type) => type === 'run.error').length, 0);
  assert.equal(terminal.eventTypes.filter((type) => type === 'run.completed').length, 1);
  await page
    .getByRole('button', { name: '停止任务' })
    .waitFor({ state: 'detached', timeout: 15_000 });

  await main('__kiteLiveWindow.app.quit()');
  inspector.close();
  await browser.close();
  browser = undefined;
  assert.equal(await exited, 0);
  console.log(
    JSON.stringify({
      ok: true,
      provider: 'deepseek',
      model,
      packagedNativeWindow: true,
      requiredChildren: 2,
      switchCycles,
      childDetailVisits,
      cachedChildRevisitsVerified,
      directChildToBTransitions: 2,
      partialChildSettlementVerified: true,
      childStatusTransitions: trace.length,
      runIdentityPreserved: true,
    }),
  );
} finally {
  for (const path of gatePaths.slice(releasedGates)) releaseGate(path, 'cleanup');
  if (child.exitCode === null) {
    await main?.('__kiteLiveWindow.app.quit()').catch(() => undefined);
    await Promise.race([
      exited.catch(() => undefined),
      Bun.sleep(20_000).then(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }),
    ]);
  }
  inspector?.close();
  await browser?.close().catch(() => undefined);
  for (const release of releaseProcesses) {
    if (release.exitCode === null) release.kill();
    await release.exited.catch(() => undefined);
  }
  rmSync(home, { recursive: true, force: true });
}
