import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  installNativeAnomalyNetwork,
  loseNativeAnomalyReceipt,
  readNativeAnomalyNetwork,
  setNativeAnomalyOffline,
} from './native-session-anomaly-network.fixture';

const [outdir, home, executablePath, control, evidence, , bunExecutable, packagePath] =
  process.argv.slice(2) as string[];
const { _electron } = createRequire(packagePath!)('playwright') as typeof import('playwright');
type CommandRow = {
  id: string;
  session_id: string;
  kind: string;
  status: string;
  request_json: string;
  request_digest: string;
};
type RunRow = {
  id: string;
  session_id: string;
  origin_command_id: string;
  status: string;
  is_active: number;
};
type ExecutionRow = {
  id: string;
  run_id: string;
  kind: string;
  state: string;
  adapter_id: string;
};
type MessageRow = { id: string; run_id: string; role: string; source_json: string };
type Facts = {
  commands: CommandRow[];
  runs: RunRow[];
  executions: ExecutionRow[];
  messages: MessageRow[];
  provider: {
    calls: { marker: string; phase: string; ordinal: number }[];
    counts: Record<string, number>;
  };
  journal: { caller: { command_id: string; state: string }[] };
  effects: Record<string, string>;
  failures: string[];
};
type Probe = {
  active: boolean;
  scans: number;
  hits: unknown[];
  frames: unknown[];
  scan: () => void;
};
declare global {
  interface Window {
    __sessionAnomalyProbe?: Probe;
  }
}
let application: ElectronApplication | undefined;
let stage = 'launch';
let boot = 0;
let screenFrames = 0;
const screenTimeline: { boot: number; index: number; at: number; timestamp?: number }[] = [];
const rendererErrors: string[] = [];
const snapshots: unknown[] = [];
const ownedServices = new Map<number, { pid: number; birth: string }>();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let factReadRetries = 0;
const readFacts = async (): Promise<Facts> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${control}/facts`);
    if (response.status === 503) {
      factReadRetries++;
      await wait(50);
      continue;
    }
    if (!response.ok) assert.fail(`cold facts HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as Facts;
  }
  throw Error('cold facts remained locked after bounded read-only retries');
};
const markerText = (text: string) => text.replaceAll('\\_', '_');
async function until(check: () => Promise<boolean>, label: string, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < end, `session_anomaly_deadline:${stage}:${label}`);
    await wait(40);
  }
}
async function launch() {
  application = await _electron.launch({
    executablePath,
    args: [outdir!, `--user-data-dir=${join(home!, 'electron-data')}`],
    cwd: outdir,
    env: { HOME: home!, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 20000,
  });
  boot++;
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => {
    rendererErrors.push(error.message);
    console.error('renderer error', error.message);
  });
  const frameDirectory = join(evidence!, `boot-${boot}-frames`);
  mkdirSync(frameDirectory, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  let lastFrame = 0;
  let frameIndex = 0;
  cdp.on('Page.screencastFrame', (frame) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (Date.now() - lastFrame < 100 || frameIndex >= 1000) return;
    lastFrame = Date.now();
    frameIndex++;
    screenFrames++;
    screenTimeline.push({
      boot,
      index: frameIndex,
      at: Date.now(),
      timestamp: frame.metadata.timestamp,
    });
    writeFileSync(join(evidence!, 'screen-timeline.json'), JSON.stringify(screenTimeline));
    writeFileSync(
      join(frameDirectory, `${String(frameIndex).padStart(4, '0')}.jpg`),
      Buffer.from(frame.data, 'base64'),
    );
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 65,
    maxWidth: 1100,
    maxHeight: 780,
    everyNthFrame: 1,
  });
  await installNativeAnomalyNetwork(application);
  await page.evaluate(() => {
    const probe: Probe = { active: false, scans: 0, hits: [], frames: [], scan: () => {} };
    let previousSequence = '';
    const allowed = '.message.user,.message.assistant';
    const forbidden =
      /执行状态待核实|上次确认状态|状态待核对|历史尚未完整校准|历史已完整读取至固定高水位|历史暂不可用|操作未完成|操作提交结果未知|提交结果未知|权限事实暂不可核实|队列操作结果尚未确认|上次状态.*待核实|等待重连刷新|原执行者已释放|无法核实原执行者|重新加载会话|重新读取队列|核对并取回原文|核对原队列操作|查询原首次提交|查询原输入|查询原权限申请|会话工具/;
    const inspect = (node: Node, context?: Node) => {
      if (!probe.active || probe.hits.length >= 100) return;
      const element = node instanceof Element ? node : node.parentElement;
      if (element?.closest(allowed)) return;
      if (context instanceof Element && context.closest(allowed)) return;
      const text = node.textContent?.trim() ?? '';
      if (text && forbidden.test(text))
        probe.hits.push({ time: performance.now(), text: text.slice(0, 500) });
    };
    probe.scan = () => {
      if (!probe.active) return;
      probe.scans++;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) inspect(walker.currentNode);
      for (const dialog of document.querySelectorAll('[role="alertdialog"]'))
        probe.hits.push({ time: performance.now(), unexpectedDialog: dialog.textContent });
      for (const notice of document.querySelectorAll('[role="alert"],[role="status"]'))
        if (
          !notice.closest(
            `${allowed},.tool-activity,[data-tool-call-id],.response-status,.agent-turn-summary,.agent-turn-status-label`,
          ) &&
          notice.textContent?.trim() &&
          notice.getBoundingClientRect().height > 0
        )
          probe.hits.push({ time: performance.now(), unexpectedNotice: notice.textContent });
      const sequence = [
        ...document.querySelectorAll('.message.user,.agent-turn,.message.assistant'),
      ]
        .filter(
          (element) =>
            !(element.matches('.message.assistant') && element.closest('.agent-turn')) &&
            element.getBoundingClientRect().height > 0,
        )
        .map((element) => ({
          role: element.matches('.message.user') ? 'user' : 'agent',
          text: (element.textContent ?? '').trim().slice(0, 250),
          top: element.getBoundingClientRect().top,
        }));
      const signature = JSON.stringify(sequence.map(({ role, text }) => ({ role, text })));
      if (signature !== previousSequence) {
        previousSequence = signature;
        const frame = { time: performance.now(), at: Date.now(), sequence };
        if (probe.frames.length < 2000) probe.frames.push(frame);
        else if (probe.hits.length < 100) probe.hits.push({ sequenceRecordingOverflow: true });
        let inputs = 0;
        let responses = 0;
        for (const entry of sequence) {
          if (entry.role === 'user') inputs++;
          else responses++;
          if (responses > inputs) {
            probe.hits.push({ ...frame, responseBeforeOriginalInput: true });
            break;
          }
        }
        const inputsByMarker = new Set<string>();
        for (let index = 0; index < sequence.length; index++) {
          const entry = sequence[index]!;
          if (entry.role === 'user') {
            if (inputsByMarker.has(entry.text))
              probe.hits.push({ ...frame, duplicateInput: entry.text });
            inputsByMarker.add(entry.text);
          } else {
            for (const match of entry.text.matchAll(/DONE (ANOMALY_[A-Z_]+)/g))
              if (!inputsByMarker.has(match[1]!))
                probe.hits.push({ ...frame, replyBeforeMatchingInput: match[1] });
          }
          if (index && entry.top < sequence[index - 1]!.top - 1)
            probe.hits.push({ ...frame, visualOrderDiffersFromDOM: true });
        }
      }
    };
    new MutationObserver((records) => {
      probe.scan();
      for (const record of records)
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) inspect(node, record.target);
          else if (node instanceof Element) {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) inspect(walker.currentNode, record.target);
          }
        }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__sessionAnomalyProbe = probe;
  });
  return page;
}
async function probe(page: Page) {
  const result = await page.evaluate(() => {
    const state = window.__sessionAnomalyProbe!;
    state.scan();
    return { scans: state.scans, hits: state.hits, frames: state.frames };
  });
  writeFileSync(join(evidence!, `boot-${boot}-probe.json`), JSON.stringify(result, null, 2));
  assert.deepEqual(result.hits, [], `causal message order and no extra anomaly UI during ${stage}`);
  return result;
}
async function select(page: Page, title: string) {
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.locator('.session-header').getByTitle(title, { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).waitFor();
  const mode = page.locator('[data-permission-trigger]');
  await until(async () => (await mode.getAttribute('aria-busy')) !== 'true', 'mode readable');
  assert.ok((await mode.innerText()).includes('完全访问'), 'actual persisted Full mode');
  assert.equal(await page.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
  await page.evaluate(() => {
    window.__sessionAnomalyProbe!.active = true;
    window.__sessionAnomalyProbe!.scan();
  });
  await probe(page);
}
async function send(page: Page, marker: string) {
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(marker);
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
}
function original(facts: Facts, marker: string) {
  const commands = facts.commands.filter(
    (row) => markerText(JSON.parse(row.request_json).content ?? '') === marker,
  );
  assert.equal(commands.length, 1, `${marker} has one original Command`);
  const command = commands[0]!;
  const runs = facts.runs.filter((row) => row.origin_command_id === command.id);
  assert.equal(runs.length, 1, `${marker} has one original Run`);
  return { command, run: runs[0]! };
}
function assertCompleted(facts: Facts, marker: string) {
  assert.deepEqual(facts.failures, []);
  const { command, run } = original(facts, marker);
  assert.equal(command.status, 'applied');
  assert.equal(run.status, 'completed');
  assert.equal(run.is_active, 0);
  const executions = facts.executions.filter((row) => row.run_id === run.id);
  assert.equal(executions.filter((row) => row.kind === 'model').length, 2);
  const tools = executions.filter((row) => row.kind === 'tool');
  assert.equal(tools.length, 1, `${marker} tool execution is not duplicated`);
  assert.equal(tools[0]!.adapter_id, 'files.write');
  assert.equal(tools[0]!.state, 'succeeded');
  assert.equal(facts.provider.counts[marker], 2, `${marker} Provider has two expected steps only`);
  assert.equal(facts.effects[`${marker}.txt`], marker);
  const user = facts.messages.filter(
    (row) =>
      row.run_id === run.id &&
      row.role === 'user' &&
      markerText(JSON.parse(row.source_json).content ?? '') === marker,
  );
  assert.equal(user.length, 1, `${marker} has one persisted user message`);
  return {
    commandId: command.id,
    runId: run.id,
    executionIds: executions.map((row) => row.id).sort(),
  };
}
function assertCrashUnreplayed(facts: Facts, before: Facts, crash: ReturnType<typeof original>) {
  const current = original(facts, 'ANOMALY_CRASH');
  assert.deepEqual(current.command, crash.command, 'original crash Command and digest unchanged');
  assert.equal(current.run.id, crash.run.id);
  assert.equal(current.run.status, 'interrupted');
  assert.equal(current.run.is_active, 0);
  assert.equal(facts.provider.counts.ANOMALY_CRASH, 1, 'old Model never replayed');
  assert.equal(facts.effects['ANOMALY_CRASH.txt'], undefined, 'old tool never started');
  assert.deepEqual(
    facts.executions
      .filter((row) => row.run_id === crash.run.id)
      .map((row) => row.id)
      .sort(),
    before.executions
      .filter((row) => row.run_id === crash.run.id)
      .map((row) => row.id)
      .sort(),
    'no new Execution added to the old Run',
  );
}
async function completed(page: Page, marker: string) {
  await until(async () => {
    const facts = await readFacts();
    const command = facts.commands.find(
      (row) => markerText(JSON.parse(row.request_json).content ?? '') === marker,
    );
    return (
      !!command &&
      facts.runs.some((run) => run.origin_command_id === command.id && run.status === 'completed')
    );
  }, `${marker} durable completion`);
  await page.getByText(`DONE ${marker}`, { exact: true }).waitFor();
  await until(async () => (await page.locator('.response-status').count()) === 0, 'no active turn');
  const facts = await readFacts();
  const identity = assertCompleted(facts, marker);
  const network = await readNativeAnomalyNetwork(application!);
  assert.equal(
    network.requests.filter((row) => row.method === 'POST' && row.commandId === identity.commandId)
      .length,
    1,
  );
  await probe(page);
  const users = await page.locator('.message.user').allInnerTexts();
  assert.equal(
    users.filter((text) => markerText(text.trim()) === marker).length,
    1,
    `${marker} has one visible user bubble after durable history takes over`,
  );
  return { facts, identity, network };
}
async function capture(page: Page, name: string) {
  const value = {
    stage,
    boot,
    facts: await readFacts(),
    network: await readNativeAnomalyNetwork(application!),
    probe: await probe(page),
  };
  snapshots.push(value);
  await page.screenshot({ path: join(evidence!, `${name}.png`) });
  writeFileSync(join(evidence!, 'snapshots.json'), JSON.stringify(snapshots, null, 2));
}
function ownedService(app: ElectronApplication) {
  const rows = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (row) => Number(row[1]) === app.process().pid && row.slice(2).join(' ') === bunExecutable,
    );
  assert.equal(rows.length, 1, 'one exact owned paired Service executable');
  const pid = Number(rows[0]![0]);
  ownedServices.set(app.process().pid!, {
    pid,
    birth: String(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='])).trim(),
  });
  return pid;
}
async function forceOwnedCleanup() {
  const app = application;
  if (!app) return;
  const main = app.process();
  let service = ownedServices.get(main.pid!);
  if (!service) {
    try {
      ownedService(app);
      service = ownedServices.get(main.pid!);
    } catch {}
  }
  if (service) {
    try {
      const birth = String(
        execFileSync('/bin/ps', ['-p', String(service.pid), '-o', 'lstart=']),
      ).trim();
      const executable = String(
        execFileSync('/bin/ps', ['-p', String(service.pid), '-o', 'comm=']),
      ).trim();
      if (birth === service.birth && executable === bunExecutable)
        process.kill(service.pid, 'SIGKILL');
    } catch {}
  }
  if (main.exitCode === null && main.signalCode === null) {
    const exited = new Promise<void>((resolve) => main.once('exit', () => resolve()));
    main.kill('SIGKILL');
    await Promise.race([exited, wait(5000)]);
  }
  application = undefined;
}
process.once('SIGTERM', () => {
  void forceOwnedCleanup().finally(() => process.exit(143));
});
async function close() {
  if (!application) return;
  const app = application;
  const service = ownedService(app);
  const child = app.process();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await app.evaluate(({ app }) => app.quit());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('anomaly_normal_quit_deadline')), 25000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(child.exitCode, 0);
  application = undefined;
  assert.throws(() => process.kill(service, 0), 'owned Service really exited');
}
function businessIdentity(facts: Facts) {
  return {
    commands: facts.commands.filter(
      (row) =>
        typeof JSON.parse(row.request_json).content === 'string' &&
        markerText(JSON.parse(row.request_json).content).startsWith('ANOMALY_'),
    ),
    runs: facts.runs,
    executions: facts.executions,
    messages: facts.messages,
    provider: facts.provider,
    effects: facts.effects,
  };
}
mkdirSync(evidence!, { recursive: true });
try {
  let page = await launch();
  stage = 'disconnect';
  await select(page, '断线验证');
  await send(page, 'ANOMALY_DISCONNECT');
  await until(
    async () => (await readFacts()).provider.counts.ANOMALY_DISCONNECT === 1,
    'original Model held',
  );
  const liveService = ownedService(application!);
  assert.ok(
    (await setNativeAnomalyOffline(application!, true)) > 0,
    'existing real Service socket disconnected',
  );
  await capture(page, '01-disconnected-held');
  assert.equal(
    (await (await fetch(`${control}/release?marker=ANOMALY_DISCONNECT`)).json()).released,
    true,
  );
  await until(async () => {
    const facts = await readFacts();
    return facts.runs.some((row) => row.session_id === 'disconnect' && row.status === 'completed');
  }, 'Service completes during outage');
  await wait(1500);
  process.kill(liveService, 0);
  assert.ok((await readNativeAnomalyNetwork(application!)).offlineAttempts > 0);
  await capture(page, '02-disconnected-completed-backend');
  await setNativeAnomalyOffline(application!, false);
  await completed(page, 'ANOMALY_DISCONNECT');
  await capture(page, '03-reconnected');
  await send(page, 'ANOMALY_DISCONNECT_CONTINUE');
  await completed(page, 'ANOMALY_DISCONNECT_CONTINUE');
  await capture(page, '04-disconnect-continued');

  stage = 'receipt_loss';
  await select(page, '回执验证');
  await loseNativeAnomalyReceipt(application!, 'ANOMALY_RECEIPT');
  await send(page, 'ANOMALY_RECEIPT');
  await until(
    async () => (await readNativeAnomalyNetwork(application!)).lostReceipts.length === 1,
    'physical receipt socket lost',
  );
  await capture(page, '05-receipt-lost');
  const receipt = await completed(page, 'ANOMALY_RECEIPT');
  const lost = receipt.network.lostReceipts[0]!;
  assert.equal(lost.commandId, receipt.identity.commandId);
  assert.equal(lost.responseStatus, 202);
  assert.ok(lost.receivedBytes > 0);
  await until(
    async () =>
      (await readNativeAnomalyNetwork(application!)).requests.some(
        (row) => row.method === 'GET' && row.path === `/v1/commands/${lost.commandId}`,
      ),
    'automatic original receipt lookup',
  );
  await until(async () => {
    const row = (await readFacts()).journal.caller.find(
      (entry) => entry.command_id === lost.commandId,
    );
    return !!row && JSON.parse(row.state).phase === 'applied';
  }, 'original caller journal confirms applied');
  await until(
    async () =>
      !(
        await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).innerText()
      ).trim(),
    'original acknowledged draft consumed without resending',
  );
  await capture(page, '06-receipt-confirmed');
  await send(page, 'ANOMALY_RECEIPT_CONTINUE');
  await completed(page, 'ANOMALY_RECEIPT_CONTINUE');
  await capture(page, '07-receipt-continued');

  stage = 'paired_SIGKILL';
  await select(page, '强杀验证');
  await send(page, 'ANOMALY_CRASH');
  await until(
    async () => (await readFacts()).provider.counts.ANOMALY_CRASH === 1,
    'crash Model held',
  );
  await capture(page, '08-before-SIGKILL');
  const before = await readFacts();
  const originalCrash = original(before, 'ANOMALY_CRASH');
  assert.equal(originalCrash.run.is_active, 1);
  assert.equal(before.effects['ANOMALY_CRASH.txt'], undefined);
  const killedNetwork = await readNativeAnomalyNetwork(application!);
  const app = application!;
  const service = ownedService(app);
  const main = app.process();
  const exited = new Promise<void>((resolve) => main.once('exit', () => resolve()));
  process.kill(service, 'SIGKILL');
  main.kill('SIGKILL');
  await exited;
  application = undefined;
  await until(async () => {
    try {
      process.kill(service, 0);
      return false;
    } catch {
      return true;
    }
  }, 'killed paired Service exited');
  const coldKilled = await readFacts();
  assert.equal(coldKilled.provider.counts.ANOMALY_CRASH, 1);
  writeFileSync(
    join(evidence!, 'killed-cold.json'),
    JSON.stringify(
      { mainPid: main.pid, servicePid: service, before, coldKilled, network: killedNetwork },
      null,
      2,
    ),
  );
  page = await launch();
  stage = 'cold_reopen_after_SIGKILL';
  await select(page, '强杀验证');
  await until(
    async () =>
      (await readFacts()).runs.some(
        (row) =>
          row.id === originalCrash.run.id && row.status === 'interrupted' && row.is_active === 0,
      ),
    'old Run durably interrupted',
  );
  const reopened = await readFacts();
  assertCrashUnreplayed(reopened, before, originalCrash);
  assert.equal(
    (await readNativeAnomalyNetwork(application!)).requests.filter(
      (row) => row.method === 'POST' && row.commandId === originalCrash.command.id,
    ).length,
    0,
    'cold reopen never resubmits the interrupted Command',
  );
  await capture(page, '09-reopened-interrupted');
  await send(page, 'ANOMALY_CRASH_CONTINUE');
  await completed(page, 'ANOMALY_CRASH_CONTINUE');
  await capture(page, '10-crash-continued');
  const stable = await readFacts();
  assertCrashUnreplayed(stable, before, originalCrash);
  for (const marker of [
    'ANOMALY_DISCONNECT',
    'ANOMALY_DISCONNECT_CONTINUE',
    'ANOMALY_RECEIPT',
    'ANOMALY_RECEIPT_CONTINUE',
    'ANOMALY_CRASH_CONTINUE',
  ])
    assertCompleted(stable, marker);
  await close();
  const afterClose = await readFacts();
  assert.deepEqual(businessIdentity(afterClose), businessIdentity(stable));
  page = await launch();
  stage = 'final_cold_read';
  for (const title of ['断线验证', '强杀验证', '回执验证']) {
    await select(page, title);
    await probe(page);
  }
  await page.getByText('DONE ANOMALY_RECEIPT_CONTINUE', { exact: true }).waitFor();
  const final = await readFacts();
  assertCrashUnreplayed(final, before, originalCrash);
  const originalCommandIds = new Set(businessIdentity(stable).commands.map((row) => row.id));
  assert.equal(
    (await readNativeAnomalyNetwork(application!)).requests.filter(
      (row) => row.method === 'POST' && !!row.commandId && originalCommandIds.has(row.commandId),
    ).length,
    0,
    'final cold reading never resubmits any original Command',
  );
  assert.deepEqual(
    businessIdentity(final),
    businessIdentity(stable),
    'cold reading changes no original work, model calls or effects',
  );
  await capture(page, '11-final-cold-read');
  await close();
  assert.deepEqual(rendererErrors, [], 'no renderer exception throughout the real window process');
  for (let recordedBoot = 1; recordedBoot <= boot; recordedBoot++)
    assert.ok(
      screenTimeline.some((frame) => frame.boot === recordedBoot),
      `real screen frames captured for boot ${recordedBoot}`,
    );
  writeFileSync(
    join(evidence!, 'qualification.json'),
    JSON.stringify(
      {
        status: 'passed',
        sourceCommit: JSON.parse(readFileSync(join(evidence!, 'metadata.json'), 'utf8'))
          .sourceCommit,
        sourceFiles: JSON.parse(readFileSync(join(evidence!, 'metadata.json'), 'utf8')).sourceFiles,
        scenarios: [
          'Main-Service physical disconnect and automatic reconnect',
          'physical POST receipt loss and original-ID automatic GET',
          'active Model with owned Service/Main SIGKILL and cold reopen',
        ],
        completedInputs: 5,
        interruptedInputs: 1,
        snapshots: snapshots.length,
        noExtraAnomalyUI: true,
        observedCausalMessageOrder: true,
        capturedScreenFrames: screenFrames,
        factReadRetries,
        noReplayedCommandRunModelOrTool: true,
        normalOwnedExit: true,
      },
      null,
      2,
    ),
  );
  console.log('native-session-anomalies-qualified', evidence);
} catch (error) {
  writeFileSync(
    join(evidence!, 'failure-facts.json'),
    JSON.stringify(
      {
        stage,
        facts: await readFacts().catch((readError) => ({ readError: String(readError) })),
        snapshots,
      },
      null,
      2,
    ),
  );
  console.error(stage, error);
  if (application) {
    const page = await application.firstWindow().catch(() => undefined);
    if (page) await probe(page).catch(() => {});
    console.error(
      await page
        ?.locator('body')
        .innerText()
        .catch(() => ''),
    );
    await page?.screenshot({ path: join(evidence!, 'failure.png') }).catch(() => {});
    await application
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
  }
  throw error;
} finally {
  try {
    await close();
  } catch (error) {
    await forceOwnedCleanup();
    console.error('isolated failure cleanup', error);
    process.exitCode = 1;
  }
}
