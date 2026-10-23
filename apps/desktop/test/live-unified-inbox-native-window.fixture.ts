import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { parseDesktopMarkdown } from '../../../packages/ui/src/desktop/markdown-parser';
import type { NativeState } from '../src/native-bridge';

// Private Node driver for the ordinary source-free Desktop candidate. Model
// requests belong to the runner's transparent Provider proxy, never this file.
const [candidate, home, control, receiptPath, desktopPackage] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const parentCompactionOnly = process.argv.slice(7).includes('--parent-compaction-only');
const finalResultsOnly = process.argv.slice(7).includes('--final-results-only');
const steeringBoundaries = process.argv.slice(7).includes('--steering-boundaries');
assert.ok(
  [parentCompactionOnly, finalResultsOnly, steeringBoundaries].filter(Boolean).length <= 1,
  'live_profiles_are_mutually_exclusive',
);
const validationProfile = steeringBoundaries
  ? 'steering-boundaries'
  : finalResultsOnly
    ? 'final-results-only'
    : parentCompactionOnly
      ? 'parent-compaction-only'
      : 'full';
const require = createRequire(desktopPackage);
const { _electron } = require('playwright') as typeof import('playwright');
type Scenario = 'idle' | 'active';
type OrdinaryMail = {
  id: string;
  name: string;
  body: string;
  sourceSessionId: string;
  sourceExecutionId: string;
  receivedRunId: string | null;
};
type Steer = {
  commandId: string;
  status: string;
  body: string;
  targetRunId: string;
  contextSelectionId: string;
  messageId: string | null;
  messageRunId: string | null;
  seq: number;
};
type Facts = {
  sessionId: string;
  title: string;
  originalRunId: string | null;
  rootActive: boolean;
  rootCompleted: boolean;
  rootRunIds: string[];
  childCount: number;
  childTask: {
    messageId: string;
    body: string;
    sourceIds: string[];
    seq: string;
    runId: string;
    commandId: string;
    sessionId: string;
  } | null;
  childCompression: {
    id: string;
    runId: string;
    coveredThroughSeq: string;
    trigger: string;
  } | null;
  childCompressionPending: boolean;
  childInstructionCode: string | null;
  childDone: boolean | number;
  childFinalText?: string | null;
  streamPrefix?: string | null;
  ordinaryPending: number;
  ordinaryReceived: number;
  resultPending: number;
  resultReceived: number;
  receiptMode: string | null;
  receivedRunId: string | null;
  sourceId: string | null;
  holds: string[];
  physicalRequests: number;
  footprint: {
    runs: number;
    executions: number;
    commands: number;
    sources: number;
    controls: number;
  };
  mode: string;
  expectedCode: string;
  ordinaryMail: OrdinaryMail | null;
  steers: Steer[];
  steerCodes: string[];
  compression: {
    id: string;
    modelExecutionId: string;
    runId: string;
    coveredThroughSeq: string;
    trigger: string;
  } | null;
  compressionPending: boolean;
  compressionAttempts: {
    id: string;
    modelExecutionId: string;
    published: boolean;
    state: string | null;
  }[];
  parentReadCount: number;
  materialCode: string | null;
};
const identities = {
  idle: { sessionId: 'inbox-idle', title: '真实模型 · 结束后接收' },
  active: { sessionId: 'inbox-active', title: '真实模型 · 本轮接收' },
} as const;
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let page: Page | undefined;
let stage = 'initializing';
let scenario: Scenario = 'idle';
const deadline = Date.now() + 600000;
const checks: Record<string, boolean | number> = {};
const scenarios: Partial<Record<Scenario, Facts>> = {};
const observations: { stage: string; scenario: Scenario; at: number; facts: Facts }[] = [];
const frames: { file: string; stage: string; scenario: Scenario; at: number; layout: unknown }[] =
  [];
const frameDirectory = join(home, 'process-frames');
mkdirSync(frameDirectory, { recursive: true });
const manifest = join(frameDirectory, 'manifest.json');
const compressionAuditPath = join(frameDirectory, 'compression-transitions.json');
const compressionAudits: unknown[] = [];
type CompressionAudit = {
  snapshot: (reason: string) => unknown;
  begin: (scope: 'parent' | 'child') => void;
  finish: () => { errors: string[]; samples: unknown[] };
  beginAgent: () => void;
  finishAgent: () => { errors: string[]; samples: unknown[] };
  samples: unknown[];
};
async function installCompressionAudit() {
  await page!.evaluate(() => {
    const target = window as typeof window & { __compressionAudit?: CompressionAudit };
    const ids = new WeakMap<Element, number>();
    let nextId = 0;
    const id = (element: Element) => {
      if (!ids.has(element)) ids.set(element, ++nextId);
      return ids.get(element)!;
    };
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const samples: unknown[] = [];
    let signature = '';
    let watch:
      | { scope: 'parent' | 'child'; node: number; height: number; errors: Set<string> }
      | undefined;
    let agentWatch: { node: number; operation: string; errors: Set<string> } | undefined;
    const rows = () => [...document.querySelectorAll('.context-compacted')];
    const inScope = (element: Element, scope: 'parent' | 'child') =>
      !!element.closest('.session-tab-child') === (scope === 'child');
    const snapshot = (reason: string) => {
      const compression = rows().map((element) => ({
        node: id(element),
        rect: rect(element),
        className: element.className,
        title: element.getAttribute('title'),
        text: element.textContent,
        child: !!element.closest('.session-tab-child'),
        turn: element.closest('.agent-turn') ? id(element.closest('.agent-turn')!) : null,
      }));
      const agentTools = [...document.querySelectorAll('.child-agent-activity')]
        .filter((element) => !element.closest('.session-tab-child'))
        .map((element) => ({
          node: id(element),
          rect: rect(element),
          className: element.className,
          text: element.textContent,
          operation: element.querySelector('.tool-agent-operation')?.textContent,
          status: element.querySelector('.tool-activity-summary')?.getAttribute('data-status'),
        }));
      if (agentWatch) {
        if (agentTools.length !== 1) agentWatch.errors.add(`agent_tool_count_${agentTools.length}`);
        const row = agentTools[0];
        if (row) {
          if (row.node !== agentWatch.node) agentWatch.errors.add('agent_tool_node_replaced');
          if (row.operation !== agentWatch.operation)
            agentWatch.errors.add('agent_tool_operation_changed');
          if (
            row.className.includes('is-running') ||
            row.status === 'running' ||
            row.status === 'error'
          )
            agentWatch.errors.add('agent_tool_inherited_child_status');
        }
      }
      const response = [...document.querySelectorAll('.response-status')].map((element) => ({
        node: id(element),
        rect: rect(element),
        className: element.className,
        text: element.textContent,
        turn: element.closest('.agent-turn') ? id(element.closest('.agent-turn')!) : null,
      }));
      const reading = [...document.querySelectorAll('.conversation-viewport')].map((element) => ({
        node: id(element),
        rect: rect(element),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
      }));
      if (watch) {
        const current = rows().filter((element) => inScope(element, watch!.scope));
        if (current.length !== 1) watch.errors.add(`compression_count_${current.length}`);
        if (current.length === 1) {
          if (id(current[0]!) !== watch.node) watch.errors.add('compression_dom_node_replaced');
          if (
            current[0]!.classList.contains('unknown') ||
            current[0]!.textContent?.includes('上次确认')
          )
            watch.errors.add('compression_reverted_to_cold_unknown');
          if (Math.abs(rect(current[0]!).height - watch.height) > 1)
            watch.errors.add('compression_row_height_changed');
        }
      }
      const turns = [...document.querySelectorAll('.agent-turn')].map((element) => ({
        node: id(element),
        rect: rect(element),
        status: element.getAttribute('data-turn-status'),
        textLength: element.textContent?.length ?? 0,
      }));
      const value = { compression, agentTools, response, reading, turns };
      const encoded = JSON.stringify(value);
      if (encoded !== signature) {
        signature = encoded;
        if (samples.length < 40000)
          samples.push({ at: Date.now(), performanceAt: performance.now(), reason, ...value });
      }
      return { at: Date.now(), performanceAt: performance.now(), ...value };
    };
    target.__compressionAudit = {
      snapshot,
      samples,
      begin: (scope) => {
        const current = rows().filter((element) => inScope(element, scope));
        if (current.length !== 1) throw Error(`compression_audit_begin_count_${current.length}`);
        watch = {
          scope,
          node: id(current[0]!),
          height: rect(current[0]!).height,
          errors: new Set(),
        };
        snapshot('begin');
      },
      finish: () => {
        snapshot('finish');
        const result = { errors: [...(watch?.errors ?? [])], samples: [...samples] };
        watch = undefined;
        return result;
      },
      beginAgent: () => {
        const current = snapshot('agent-tool-begin').agentTools;
        if (current.length !== 1 || current[0]!.operation !== '创建子 Agent')
          throw Error('agent_tool_history_begin_invalid');
        agentWatch = {
          node: current[0]!.node,
          operation: current[0]!.operation,
          errors: new Set(),
        };
      },
      finishAgent: () => {
        snapshot('agent-tool-finish');
        const result = { errors: [...(agentWatch?.errors ?? [])], samples: [...samples] };
        agentWatch = undefined;
        return result;
      },
    };
    new MutationObserver((records) => {
      const changes = records.flatMap((record) => {
        const changed = [...record.addedNodes, ...record.removedNodes].flatMap((node) =>
          node instanceof Element
            ? [node, ...node.querySelectorAll('.context-compacted, .response-status')]
            : [],
        );
        return changed
          .filter((node) => node.matches('.context-compacted, .response-status'))
          .map((node) => ({
            node: id(node),
            connected: node.isConnected,
            className: node.className,
            text: node.textContent,
          }));
      });
      if (changes.length && samples.length < 40000)
        samples.push({
          at: Date.now(),
          performanceAt: performance.now(),
          reason: 'node-mutation',
          changes,
        });
      snapshot('mutation');
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const tick = () => {
      snapshot('animation-frame');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
async function compressionAudit(action: 'begin' | 'finish', scope: 'parent' | 'child') {
  const result = await page!.evaluate(
    ({ action, scope }) => {
      const audit = (window as typeof window & { __compressionAudit: CompressionAudit })
        .__compressionAudit;
      if (action === 'begin') {
        audit.begin(scope);
        return null;
      }
      return audit.finish();
    },
    { action, scope },
  );
  if (result) {
    compressionAudits.push({ scope, stage, ...result });
    writeFileSync(compressionAuditPath, JSON.stringify(compressionAudits));
    assert.deepEqual(result.errors, [], `${scope}_compression_handoff_stable`);
    checks[`${scope}CompressionHandoffStable`] = true;
  }
}
async function agentOperationAudit(action: 'begin' | 'finish') {
  const result = await page!.evaluate((action) => {
    const audit = (window as typeof window & { __compressionAudit: CompressionAudit })
      .__compressionAudit;
    if (action === 'begin') {
      audit.beginAgent();
      return null;
    }
    return audit.finishAgent();
  }, action);
  if (result) {
    compressionAudits.push({ scope: 'agent-operation', stage, ...result });
    assert.deepEqual(result.errors, [], 'original_agent_tool_history_stays_static');
    checks.staticAgentToolHistoryThroughChildCompletion = true;
  }
}
async function saveCompressionAudit() {
  if (!page || page.isClosed()) return;
  const samples = await page.evaluate(
    () =>
      (window as typeof window & { __compressionAudit?: CompressionAudit }).__compressionAudit
        ?.samples ?? [],
  );
  writeFileSync(compressionAuditPath, JSON.stringify([...compressionAudits, { stage, samples }]));
}
let frameTimer: ReturnType<typeof setInterval> | undefined;
let frameSaving: Promise<void> | undefined;
let frameNumber = 0;
const heldSince = new Map<string, number>();

function log(next: string) {
  stage = next;
  console.log(JSON.stringify({ stage, scenario, at: Date.now() }));
}
function remaining() {
  assert.ok(Date.now() < deadline, `native_inbox_total_limit_at_${stage}`);
  for (const [gate, at] of heldSince)
    assert.ok(Date.now() - at < 55000, `native_inbox_gate_budget_${gate}_at_${stage}`);
}
async function response(path: string) {
  remaining();
  const result = await fetch(`${control}${path}`, { signal: AbortSignal.timeout(5000) });
  assert.ok(result.ok, `native_inbox_control_http_${result.status}_at_${stage}`);
  return result;
}
async function read(which = scenario): Promise<Facts> {
  const facts = (await (await response(`/state?scenario=${which}`)).json()) as Facts;
  assert.equal(facts.sessionId, identities[which].sessionId);
  assert.ok(Array.isArray(facts.holds));
  const now = Date.now();
  for (const gate of facts.holds) if (!heldSince.has(gate)) heldSince.set(gate, now);
  for (const gate of heldSince.keys()) if (!facts.holds.includes(gate)) heldSince.delete(gate);
  return facts;
}
async function until<T>(load: () => Promise<T>, predicate: (value: T) => boolean, label: string) {
  const end = Math.min(deadline, Date.now() + 45000);
  for (;;) {
    remaining();
    const value = await load();
    if (predicate(value)) return value;
    assert.ok(Date.now() < end, `native_inbox_${stage}_${label}_not_reached`);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
}
async function release(gate: string) {
  await response(`/release?gate=${encodeURIComponent(gate)}`);
  heldSince.delete(gate);
}
const nativeState = () =>
  page!.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
// The ordinary parent transcript and a separately opened child detail may coexist.
const parentNodes = (selector: string) =>
  page!.locator(`:is(${selector}):not(.session-tab-child *)`);
const bubbles = () => parentNodes('article[data-agent-result-source]');

async function layout() {
  return page!.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const input = document.querySelector<HTMLTextAreaElement>('textarea');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      focus: document.activeElement?.tagName,
      input: input ? { ...box(input), start: input.selectionStart, end: input.selectionEnd } : null,
      reading: [...document.querySelectorAll('.conversation-viewport')].map((element) => ({
        ...box(element),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
      })),
      order: [...document.querySelectorAll('.agent-turn, article[data-agent-result-source]')].map(
        (element) => ({
          ...box(element),
          kind: element.classList.contains('agent-turn') ? 'turn' : 'result',
          sourceId: element.getAttribute('data-agent-result-source'),
          status: element.getAttribute('data-turn-status'),
        }),
      ),
      steerOrder: [...document.querySelectorAll('article[data-input-kind="input.steer"]')].map(
        (element) => ({
          ...box(element),
          id: element.getAttribute('data-message-id'),
          inProcess: !!element.closest('.agent-turn-process-messages'),
          textLength: element.textContent?.length ?? 0,
        }),
      ),
      draft: document.querySelector('[role="textbox"]')?.textContent ?? input?.value ?? null,
      composer: [...document.querySelectorAll('form.composer')].map((form) => ({
        loading: form.getAttribute('data-session-loading'),
        permissionPending: form.getAttribute('data-permission-pending'),
        submit: [...form.querySelectorAll('button[type="submit"]')].map((button) => ({
          ...box(button),
          disabled: button.hasAttribute('disabled'),
          busy: button.getAttribute('aria-busy'),
        })),
      })),
      childPanels: document.querySelectorAll('.session-tab-child').length,
    };
  });
}
function startFrames() {
  frameTimer = setInterval(() => {
    if (!page || frameSaving || frameNumber >= 4000) return;
    const sample = { stage, scenario, at: Date.now() };
    const file = `${String(frameNumber++).padStart(4, '0')}-${sample.stage}.png`;
    frameSaving = (async () => {
      const geometry = await layout();
      const geometryAt = Date.now();
      const compression = await page!.evaluate(() =>
        (
          window as typeof window & { __compressionAudit?: CompressionAudit }
        ).__compressionAudit?.snapshot('screenshot'),
      );
      const screenshotStartedAt = Date.now();
      await page!.screenshot({ path: join(frameDirectory, file), timeout: 5000 });
      frames.push({
        file,
        ...sample,
        layout: {
          ...geometry,
          geometryAt,
          screenshotStartedAt,
          screenshotFinishedAt: Date.now(),
          compression,
        },
      });
    })()
      .catch(() => {})
      .finally(() => {
        frameSaving = undefined;
      });
  }, 150);
}
async function shot(name: string, facts?: Facts) {
  remaining();
  if (facts) observations.push({ stage, scenario, at: Date.now(), facts });
  const state = await nativeState();
  compressionAudits.push({
    stage,
    at: Date.now(),
    native: {
      sessionId: state.selection?.session.id,
      viewLoading: state.selection?.viewLoading,
      permissionUnavailable: state.selection?.permissionUnavailable,
      compressionProgress: state.selection?.compressionProgress,
      activity: state.directory?.sessions.find(
        (session) => session.id === state.selection?.session.id,
      )?.activity,
      runs: state.selection?.runs.map((run) => ({
        id: run.id,
        status: run.status,
        isActive: run.isActive,
      })),
    },
  });
  await page!.screenshot({ path: join(home, `${name}.png`), fullPage: true });
  writeFileSync(manifest, JSON.stringify(frames));
}
async function launch() {
  log('launch_process');
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 20000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await installCompressionAudit();
  startFrames();
}
async function close() {
  clearInterval(frameTimer);
  await frameSaving;
  writeFileSync(manifest, JSON.stringify(frames));
  await saveCompressionAudit();
  if (!app) return;
  const owned = app;
  const process = owned.process();
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app: electron }) => electron.quit());
  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`native_inbox_exit_timeout_at_${stage}`)),
        20000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(process.exitCode, 0, 'ordinary Native process exited cleanly');
  app = undefined;
  page = undefined;
}
async function select(which: Scenario, cold = false) {
  scenario = which;
  log(`select_${which}`);
  await page!
    .getByRole('button', { name: identities[which].title, exact: true })
    .and(page!.locator('button.session-row'))
    .click();
  await page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).waitFor();
  const confirm = page!.getByRole('button', { name: '确认项目读取范围', exact: true });
  const readiness = await until(
    async () => ({
      needsTrust: await confirm.isVisible(),
      state: await nativeState(),
    }),
    (value) =>
      value.needsTrust ||
      (value.state.selection?.session.id === identities[which].sessionId &&
        !value.state.selection.viewLoading),
    'selection_or_trust',
  );
  if (readiness.needsTrust) {
    assert.ok(!cold, 'cold reading cannot change workspace trust');
    await confirm.click();
    await page!
      .getByRole('checkbox', { name: '我已核对所显示的项目及读取范围', exact: true })
      .check();
    await page!.getByRole('button', { name: '允许读取所显示的范围', exact: true }).click();
    await confirm.waitFor({ state: 'detached' });
    checks.workspaceTrustViaOrdinaryUI = true;
  }
  await until(
    nativeState,
    (value) =>
      value.selection?.session.id === identities[which].sessionId && !value.selection.viewLoading,
    'exact_root_history',
  );
  assert.equal(await page!.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
  checks.diagnosticsClosed = true;
}
async function send(which: Scenario) {
  log(`${which}_permission`);
  if ((await read()).mode !== 'full') {
    await page!.locator('[data-permission-trigger]').click();
    await page!.getByRole('menuitemradio', { name: /^(Full permission|完全访问)/ }).click();
    await page!
      .getByRole('alertdialog')
      .getByRole('button', { name: /^(Enable Full|启用完全权限)$/ })
      .click();
    await until(read, (facts) => facts.mode === 'full', 'full_via_ui');
  }
  checks[`${which}FullViaOrdinaryUI`] = true;
  log(`${which}_send`);
  const prompt = await (await response(`/prompt?scenario=${which}`)).text();
  assert.ok(prompt.trim());
  const draft = page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
  const button = page!.getByRole('button', { name: '发送明确的新轮次', exact: true });
  const form = page!.locator('form.composer');
  const before = new Set((await nativeState()).inputSubmissions.map((row) => row.intent.commandId));
  await draft.fill(prompt);
  // Lexical publishes its controlled draft through OnChangePlugin. Require the
  // full text and settled public form state across successive observations;
  // an enabled button alone can be a preserved history-loading presentation.
  let previous = '';
  await until(
    async () => {
      const text = normalized(await draft.innerText());
      const bounds = await button.boundingBox();
      const observation = JSON.stringify({ text, bounds });
      const ready =
        text === normalized(prompt) &&
        (await button.isEnabled()) &&
        (await button.getAttribute('aria-busy')) !== 'true' &&
        (await form.getAttribute('data-session-loading')) !== 'true' &&
        (await form.getAttribute('data-permission-pending')) !== 'true' &&
        (await form.getAttribute('aria-busy')) !== 'true' &&
        observation === previous;
      previous = observation;
      return ready;
    },
    Boolean,
    'complete_controlled_prompt_and_ready_form',
  );
  await shot(`${which}-prompt-ready-to-submit`, await read());
  log(`${which}_submit_once`);
  // Use the editor's public KEY_ENTER_COMMAND path. A tall draft can move the
  // submit button while pointer events are in flight; no fallback or resend.
  await draft.press('Enter');
  const submitted = await until(
    nativeState,
    (state) => {
      const row = state.inputSubmissions.find(
        (input) =>
          input.sessionId === identities[which].sessionId &&
          input.intent.kind === 'run.start' &&
          !before.has(input.intent.commandId),
      );
      if (row && ['failed', 'rejected', 'unknown'].includes(row.phase))
        throw Error(`native_inbox_${which}_initial_submit_${row.phase}`);
      return !!row?.command && ['accepted', 'applied', 'terminal'].includes(row.phase);
    },
    'actual_initial_command_accepted',
  );
  const accepted = submitted.inputSubmissions.filter(
    (row) =>
      row.sessionId === identities[which].sessionId &&
      row.intent.kind === 'run.start' &&
      !before.has(row.intent.commandId),
  );
  assert.equal(accepted.length, 1, 'exactly one initial UI submission was made');
  assert.ok(accepted[0]!.command);
  await until(
    () => draft.innerText(),
    (text) => !text.trim(),
    'accepted_prompt_cleared',
  );
  await until(
    read,
    (facts) => facts.rootRunIds.length === 1 && !!facts.originalRunId,
    'accepted_original_run_exists',
  );
  checks[`${which}InitialCommandAcceptedOnceAndDraftCleared`] = true;
  log(`${which}_submit_accepted`);
  await shot(`${which}-prompt-accepted`, await read());
}
async function assertBubble(sourceId: string, expectedCode: string) {
  const card = page!.locator(`article[data-agent-result-source="${sourceId}"]`);
  await card.waitFor();
  assert.equal(await bubbles().count(), 1);
  assert.equal(await card.count(), 1);
  const heading = await card.locator('.message-label').innerText();
  assert.match(heading, /Agent\s*发送/);
  const content = (await card.locator('.typeset-chat').innerText()).trim();
  assert.ok(content.length > 0, 'result body is visible independently of the parent reply');
  assert.ok(
    expectedCode && content.includes(expectedCode),
    'the actual material verification code is visible',
  );
  assert.equal(await card.evaluate((element) => !!element.closest('.agent-turn')), false);
  return { heading, content };
}

async function assertOrdinaryMail(facts: Facts, expectedRunId: string, screenshot?: string) {
  const mail = facts.ordinaryMail;
  assert.ok(mail, 'the runner found the actual send_agent_message input and receipt');
  assert.ok(mail.id && mail.name && mail.body.trim());
  assert.notEqual(mail.sourceSessionId, facts.sessionId);
  assert.ok(mail.sourceExecutionId);
  assert.equal(mail.receivedRunId, expectedRunId);
  assert.equal(facts.ordinaryReceived, 1);
  const summaries = parentNodes('.agent-turn-summary[aria-expanded]');
  const opened = new Set<number>();
  const reading = await parentNodes('.conversation-viewport').evaluateAll((elements) =>
    elements.map((element) => element.scrollTop),
  );
  try {
    const card = parentNodes(`article[data-agent-message-id="${mail.id}"]`);
    await until(
      async () => {
        // Store completion can precede the renderer's terminal regrouping.
        // Wait for that projection, then reopen only collapsed processes on
        // each attempt in case settlement replaced an earlier expanded node.
        if (
          facts.rootCompleted &&
          (await parentNodes('.agent-turn[data-turn-status="running"]').count()) > 0
        )
          return false;
        for (let index = 0; index < (await summaries.count()); index++) {
          if ((await summaries.nth(index).getAttribute('aria-expanded')) === 'false') {
            await summaries.nth(index).click();
            opened.add(index);
          }
        }
        return (await card.count()) === 1 && (await card.isVisible());
      },
      (visible) => visible,
      'exact_ordinary_mail_visible_after_settlement',
    );
    assert.equal(await parentNodes('article[data-agent-message-id]').count(), 1);
    assert.equal(await card.getAttribute('data-agent-result-source'), null);
    const heading = await card.locator('.message-label').innerText();
    assert.ok(heading.includes(`${mail.name} Agent 发送`), 'the sender label is Core-confirmed');
    const body = await card.locator('.typeset-chat').innerText();
    const normalize = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
    assert.equal(
      normalize(body),
      normalize(mail.body),
      'the entire real send input is displayed exactly once',
    );
    assert.ok(
      body.includes(facts.expectedCode),
      'ordinary mail contains the actual material verification code',
    );
    const placement = await card.evaluate((element) => ({
      insideProcess: !!element.closest('.agent-turn-process-messages'),
      insideTurn: !!element.closest('.agent-turn'),
      independentUserBubble: element.classList.contains('user'),
    }));
    assert.equal(placement.insideProcess, true);
    assert.equal(placement.insideTurn, true);
    assert.equal(placement.independentUserBubble, false);
    assert.equal(
      await page!
        .getByText('Agent message (untrusted data; no additional authorization)', { exact: true })
        .count(),
      0,
      'internal model transport headers never become public mail bodies',
    );
    await card.scrollIntoViewIfNeeded();
    if (screenshot) await shot(screenshot, facts);
  } finally {
    for (const index of [...opened].reverse()) {
      if ((await summaries.nth(index).getAttribute('aria-expanded')) === 'true')
        await summaries.nth(index).click();
    }
    await parentNodes('.conversation-viewport').evaluateAll((elements, positions) => {
      elements.forEach((element, index) => {
        if (positions[index] !== undefined) element.scrollTop = positions[index]!;
      });
    }, reading);
  }
}

const steerCards = () => parentNodes('article[data-input-kind="input.steer"]');
const normalized = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
function renderedSteerBody(source: string) {
  // These fixture guides contain only paragraphs and text. Parse their Markdown
  // escapes (for example the editor's read\_user\_file) before comparing the
  // rendered body; a pending plain-text handoff still has to match the raw body.
  const tree = parseDesktopMarkdown(source) as unknown as {
    children: { type: string; children: { type: string; value: string }[] }[];
  };
  return normalized(
    tree.children
      .map((paragraph) => {
        assert.equal(paragraph.type, 'paragraph', 'fixture guide uses plain paragraphs');
        return paragraph.children
          .map((child) => {
            assert.equal(child.type, 'text', 'fixture guide uses plain text');
            assert.equal(typeof child.value, 'string');
            return child.value;
          })
          .join('');
      })
      .join('\n\n'),
  );
}
async function assertFullSteerBody(card: Locator, body: string) {
  const rendered = renderedSteerBody(body);
  await until(
    async () => {
      const markdown = card.locator('.typeset-chat');
      if ((await markdown.count()) === 1)
        return normalized(await markdown.innerText()) === rendered;
      return normalized(await card.innerText()) === normalized(body);
    },
    Boolean,
    'complete_original_steer_body_visible',
  );
}
async function assertSteers(facts: Facts, applied: boolean) {
  const expected = steeringBoundaries ? 3 : 2;
  assert.equal(facts.steers.length, expected);
  assert.deepEqual(facts.rootRunIds, [facts.originalRunId]);
  assert.equal(await parentNodes('.agent-turn').count(), 1);
  assert.equal(await bubbles().count(), 0);
  await until(
    () => steerCards().count(),
    (count) => count === expected,
    'two_steer_presentations',
  );
  for (const [index, steer] of facts.steers.entries()) {
    assert.equal(steer.targetRunId, facts.originalRunId);
    assert.ok(steer.body.includes(facts.steerCodes[index]!));
    const card = steerCards().nth(index);
    assert.equal(
      await card.evaluate((element) => !!element.closest('.agent-turn-process-messages')),
      true,
    );
    if (applied) {
      assert.equal(steer.status, 'applied');
      assert.ok(steer.messageId);
      assert.equal(steer.messageRunId, facts.originalRunId);
      assert.equal(await card.getAttribute('data-message-id'), steer.messageId);
      const content = await card.locator('.typeset-chat').innerText();
      assert.equal(normalized(content), renderedSteerBody(steer.body));
      assert.ok(content.includes(`完整尾标：${facts.steerCodes[index]}`));
    } else {
      assert.ok(['accepted', 'applied'].includes(steer.status));
      await assertFullSteerBody(card, steer.body);
    }
  }
}
async function sendSteers() {
  for (let index = 0; index < 2; index++) {
    const prompt = await (await response(`/steer?index=${index}`)).text();
    const draft = page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
    await draft.fill(prompt);
    log(`active_steer_${index + 1}_sending`);
    await shot(`13${index}-steer-${index + 1}-draft`, await read());
    const send = page!.getByRole('button', { name: '引导当前轮次', exact: true });
    await until(() => send.isEnabled(), Boolean, 'ordinary_steer_send_enabled');
    await send.click();
    await shot(`13${index}-steer-${index + 1}-submitting`);
    const accepted = await until(
      read,
      (facts) =>
        facts.steers.length === index + 1 &&
        facts.steers.every((row) => ['accepted', 'applied'].includes(row.status)),
      'real_ui_steer_accepted',
    );
    assert.deepEqual(accepted.rootRunIds, [accepted.originalRunId]);
    await until(
      () => steerCards().count(),
      (count) => count === index + 1,
      'pending_steer_in_original_process',
    );
    for (const card of await steerCards().all())
      assert.equal(
        await card.evaluate((element) => !!element.closest('.agent-turn-process-messages')),
        true,
      );
    assert.equal(await parentNodes('.agent-turn').count(), 1);
    assert.equal(await bubbles().count(), 0);
    for (const [order, card] of (await steerCards().all()).entries())
      await assertFullSteerBody(card, accepted.steers[order]!.body);
    log(`active_steer_${index + 1}_accepted`);
    await shot(`14${index}-steer-${index + 1}-accepted`, accepted);
  }
}
async function assertTerminalSteers(facts: Facts, prefix: string) {
  await until(
    () => parentNodes('.agent-turn[data-turn-status="completed"]').count(),
    (count) => count === 1,
    'steer_terminal_grouping',
  );
  const summary = parentNodes('.agent-turn-summary[aria-expanded]');
  assert.equal(await summary.count(), 1);
  assert.equal(
    await summary.getAttribute('aria-expanded'),
    'false',
    'completed process defaults collapsed',
  );
  await until(
    async () => {
      for (const card of await steerCards().all()) if (await card.isVisible()) return false;
      return true;
    },
    Boolean,
    'terminal_steer_hidden',
  );
  await shot(`${prefix}-steer-collapsed`, facts);
  await summary.click();
  await until(() => steerCards().first().isVisible(), Boolean, 'terminal_steer_expanded');
  await assertSteers(facts, true);
  for (let index = 0; index < facts.steers.length; index++) {
    await steerCards().nth(index).scrollIntoViewIfNeeded();
    await shot(`${prefix}-steer-${index + 1}-expanded`, facts);
  }
  await summary.click();
  await until(
    () => steerCards().first().isVisible(),
    (visible) => !visible,
    'terminal_steer_recollapsed',
  );
  assert.equal(await summary.getAttribute('aria-expanded'), 'false');
  await shot(`${prefix}-steer-recollapsed`, facts);
}

async function runFinalResultsOnly() {
  const noOrdinary = async (facts: Facts) => {
    assert.equal(facts.ordinaryPending, 0);
    assert.equal(facts.ordinaryReceived, 0);
    assert.equal(facts.ordinaryMail, null);
    assert.equal(await parentNodes('article[data-agent-message-id]').count(), 0);
    if (!steeringBoundaries || facts.sessionId !== identities.active.sessionId) {
      assert.equal(await steerCards().count(), 0);
      assert.deepEqual(facts.steers, []);
      assert.equal(facts.compression, null);
      assert.equal(facts.parentReadCount, 0);
    }
    assert.equal(facts.childCompression, null);
  };
  const creationName = async () => {
    const summary = parentNodes('.agent-turn')
      .first()
      .locator('.agent-turn-summary[aria-expanded="false"]');
    if (await summary.count()) await summary.click();
    await until(
      () => parentNodes('.child-agent-activity .tool-agent-operation').allTextContents(),
      (values) => values.length === 1 && values[0] === '创建子 Agent',
      'original_static_creation_ready',
    );
    return parentNodes('.child-agent-activity .tool-agent-name').innerText();
  };
  const finalText = () =>
    parentNodes('.agent-turn-final article[data-final-reply="true"]').last().innerText();
  await select('idle');
  await send('idle');
  log('idle_parent_ended_child_running');
  const ended = await until(
    read,
    (f) =>
      f.holds.includes('idle-child-first') &&
      f.rootCompleted &&
      !f.rootActive &&
      f.childCount === 1,
    'final_only_idle_parent_ended',
  );
  await noOrdinary(ended);
  assert.equal(ended.resultReceived, 0);
  const idleName = await creationName();
  await shot('01-parent-ended-child-running', ended);
  await release('idle-child-first');
  const finalHeld = await until(
    read,
    (f) => f.holds.includes('idle-child-final'),
    'final_only_idle_child_final',
  );
  await noOrdinary(finalHeld);
  assert.equal(finalHeld.rootActive, false);
  assert.deepEqual(finalHeld.rootRunIds, [ended.originalRunId]);
  assert.equal(await bubbles().count(), 0);
  await shot('02-child-final-before-settlement', finalHeld);
  await release('idle-child-final');
  log('idle_result_before_parent_reply');
  const received = await until(
    read,
    (f) =>
      f.holds.includes('idle-parent-result') &&
      f.resultReceived === 1 &&
      f.receiptMode === 'idle_new_turn' &&
      f.rootActive,
    'final_only_idle_result_received',
  );
  await noOrdinary(received);
  assert.ok(received.sourceId && received.receivedRunId && received.childFinalText);
  assert.equal(received.resultPending, 0);
  assert.notEqual(received.receivedRunId, ended.originalRunId);
  assert.deepEqual(
    new Set(received.rootRunIds),
    new Set([ended.originalRunId, received.receivedRunId]),
  );
  assert.equal(received.footprint.controls, ended.footprint.controls);
  const idleBody = await assertBubble(received.sourceId, received.expectedCode);
  assert.equal(idleBody.heading.trim(), `${idleName.trim()} Agent 发送`);
  assert.equal(normalized(idleBody.content), normalized(received.childFinalText));
  await shot('03-idle-result-before-parent-reply', received);
  await release('idle-parent-result');
  scenarios.idle = await until(
    read,
    (f) => f.rootCompleted && !f.rootActive && !!f.childDone && f.resultReceived === 1,
    'final_only_idle_terminal',
  );
  await noOrdinary(scenarios.idle);
  assert.deepEqual(await assertBubble(received.sourceId, received.expectedCode), idleBody);
  await until(
    finalText,
    (text) => text.includes(received.expectedCode) && /[\u3400-\u9fff]/u.test(text),
    'idle_parent_actual_chinese_final_code',
  );
  assert.equal(scenarios.idle.footprint.controls, ended.footprint.controls);
  assert.deepEqual(scenarios.idle.rootRunIds, received.rootRunIds);
  await shot('04-idle-complete', scenarios.idle);
  checks.finalOnlyIdleUniqueContinuationAndEarlyBubble = true;

  await select('active');
  await send('active');
  log('active_parent_running');
  const running = await until(
    read,
    (f) =>
      f.holds.includes('active-parent-checkpoint') &&
      f.holds.includes('active-child-first') &&
      f.rootActive &&
      f.childCount === 1,
    'final_only_active_two_gates',
  );
  await noOrdinary(running);
  const activeName = await creationName();
  await agentOperationAudit('begin');
  await shot('05-parent-running', running);
  await release('active-child-first');
  await until(read, (f) => f.holds.includes('active-child-final'), 'final_only_active_child_final');
  await release('active-child-final');
  const pending = await until(
    read,
    (f) =>
      !!f.childDone &&
      f.resultPending === 1 &&
      f.resultReceived === 0 &&
      f.holds.includes('active-parent-checkpoint'),
    'final_only_active_pending_same_run',
  );
  await noOrdinary(pending);
  assert.deepEqual(pending.rootRunIds, [running.originalRunId]);
  assert.equal(await bubbles().count(), 0);
  await shot('06-child-completed-parent-inflight', pending);
  if (steeringBoundaries) {
    const sendBoundarySteer = async (index: number) => {
      const body = await (await response(`/steer?index=${index}`)).text();
      const draft = page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
      await draft.fill(body);
      log(`boundary_steer_${index + 1}_sending`);
      await shot(`boundary-${index + 1}-guide-draft`, await read());
      await page!.getByRole('button', { name: '引导当前轮次', exact: true }).click();
      const facts = await until(
        read,
        (row) =>
          row.steers.length === index + 1 &&
          row.steers.every((steer) => ['accepted', 'applied'].includes(steer.status)),
        'boundary_guide_accepted',
      );
      assert.deepEqual(facts.rootRunIds, [running.originalRunId]);
      await until(
        () => steerCards().count(),
        (count) => count === index + 1,
        'boundary_guide_card',
      );
      for (const [order, card] of (await steerCards().all()).entries()) {
        assert.equal(
          await card.evaluate((element) => !!element.closest('.agent-turn-process-messages')),
          true,
        );
        await assertFullSteerBody(card, facts.steers[order]!.body);
      }
      await noOrdinary(facts);
      await shot(`boundary-${index + 1}-guide-accepted`, facts);
      return facts;
    };
    await sendBoundarySteer(0);
    await release('active-parent-checkpoint');
    const streaming = await until(
      read,
      (row) =>
        row.holds.includes('active-parent-stream') &&
        !!row.streamPrefix &&
        row.resultReceived === 1 &&
        row.steers[0]?.status === 'applied',
      'boundary_real_content_stream',
    );
    await until(
      () => parentNodes('article.assistant.responding .typeset-chat').allTextContents(),
      (texts) =>
        texts.some((text) => normalized(text).includes(normalized(streaming.streamPrefix!))),
      'boundary_actual_content_visible_before_next_guide',
    );
    assert.equal(await parentNodes('.agent-turn').count(), 1);
    assert.equal(await bubbles().count(), 0);
    await shot('boundary-04-first-real-content-visible', streaming);
    await sendBoundarySteer(1);
    await release('active-parent-stream');
    const summarizing = await until(
      read,
      (row) =>
        row.holds.includes('active-compression-summary') &&
        row.compressionPending &&
        row.steers.length === 2 &&
        row.steers.every((steer) => steer.status === 'applied') &&
        row.parentReadCount === 1,
      'boundary_summary_after_stream_guide',
    );
    await until(
      () => parentNodes('.context-compacted.running').count(),
      (count) => count === 1,
      'boundary_summary_visible',
    );
    await compressionAudit('begin', 'parent');
    await shot('boundary-05-real-summary-before-new-guide', summarizing);
    await sendBoundarySteer(2);
    await compressionAudit('finish', 'parent');
    await release('active-compression-summary');
    const next = await until(
      read,
      (row) =>
        row.steers.length === 3 &&
        row.steers.every((steer) => steer.status === 'applied') &&
        (row.holds.includes('active-compression-retry') ||
          row.holds.includes('active-after-summary-rejection') ||
          row.holds.includes('active-postcompression')),
      'boundary_stale_summary_refused_and_correction_applied',
    );
    assert.equal(next.compressionAttempts[0]?.published, false);
    assert.equal(
      next.compressionAttempts[0]?.modelExecutionId,
      summarizing.compressionAttempts[0]?.modelExecutionId,
    );
    if (next.holds.includes('active-compression-retry')) {
      assert.notEqual(
        next.compressionAttempts.at(-1)?.modelExecutionId,
        next.compressionAttempts[0]?.modelExecutionId,
      );
      await shot('boundary-06-stale-summary-refused-new-summary', next);
      await release('active-compression-retry');
    }
    const afterSummary = await until(
      read,
      (row) =>
        (row.holds.includes('active-postcompression') ||
          row.holds.includes('active-after-summary-rejection')) &&
        row.steers.length === 3 &&
        row.steers.every((steer) => steer.status === 'applied'),
      'boundary_summary_time_guide_applied',
    );
    await assertSteers(afterSummary, true);
    assert.equal(afterSummary.receiptMode, 'active');
    assert.equal(afterSummary.receivedRunId, running.originalRunId);
    assert.equal(afterSummary.footprint.controls, running.footprint.controls);
    await agentOperationAudit('finish');
    await shot('boundary-06-summary-time-correction-received', afterSummary);
    await release(
      afterSummary.holds.includes('active-postcompression')
        ? 'active-postcompression'
        : 'active-after-summary-rejection',
    );
    scenarios.active = await until(
      read,
      (row) => row.rootCompleted && !row.rootActive && row.resultReceived === 1,
      'boundary_terminal',
    );
    await until(
      finalText,
      (text) =>
        text.includes('Purple') &&
        !text.includes('Green') &&
        !text.includes('Blue') &&
        afterSummary.steerCodes.every((code) => text.includes(code)) &&
        text.includes(afterSummary.expectedCode) &&
        text.includes(afterSummary.childInstructionCode!) &&
        text.includes(afterSummary.materialCode!),
      'boundary_real_final_latest_color_and_all_actual_facts',
    );
    await assertTerminalSteers(scenarios.active, 'boundary-07-terminal');
    assert.equal(await parentNodes('.agent-turn').count(), 1);
    assert.equal(await bubbles().count(), 0);
    checks.realStreamingMixedAndSummaryTimeSteeringPresentation = true;
  } else {
    await release('active-parent-checkpoint');
    const active = await until(
      read,
      (f) =>
        f.holds.includes('active-parent-result') &&
        f.resultReceived === 1 &&
        f.receiptMode === 'active' &&
        f.receivedRunId === f.originalRunId &&
        f.rootActive,
      'final_only_active_received',
    );
    assert.ok(active.sourceId && active.childInstructionCode && active.childFinalText);
    assert.equal(active.resultPending, 0);
    await noOrdinary(active);
    assert.deepEqual(active.rootRunIds, [running.originalRunId]);
    assert.equal(active.footprint.controls, running.footprint.controls);
    assert.equal(await parentNodes('.agent-turn').count(), 1);
    assert.equal(await bubbles().count(), 0);
    const events = parentNodes('.agent-turn[data-turn-status="running"] .tool-activity-summary')
      .filter({ hasText: '等待 Agent 事件' })
      .last();
    await events.click();
    await until(
      () =>
        parentNodes('.agent-turn')
          .allTextContents()
          .then((texts) => texts.join('\n')),
      (text) => text.includes('"kind":"completed"'),
      'final_only_completed_event_visible',
    );
    await shot('07-active-received-in-process', active);
    await events.click();
    await page!
      .getByRole('button', { name: `查看子 Agent 详情：${activeName.trim()}`, exact: true })
      .click();
    const detail = page!.locator('.session-tab-child');
    const childFinal = detail
      .locator('article[data-final-reply="true"]')
      .last()
      .locator('.typeset-chat');
    await until(
      () => childFinal.innerText(),
      (text) =>
        normalized(text) === normalized(active.childFinalText!) &&
        text.includes(active.expectedCode) &&
        text.includes(active.childInstructionCode!),
      'final_only_actual_child_full_result',
    );
    assert.ok(activeName.trim());
    await shot('08-active-child-result-detail', active);
    await page!.getByRole('button', { name: '收起标签栏', exact: true }).click();
    await agentOperationAudit('finish');
    await release('active-parent-result');
    scenarios.active = await until(
      read,
      (f) => f.rootCompleted && !f.rootActive && !!f.childDone && f.resultReceived === 1,
      'final_only_active_terminal',
    );
    await noOrdinary(scenarios.active);
    assert.deepEqual(scenarios.active.rootRunIds, [running.originalRunId]);
    assert.equal(await parentNodes('.agent-turn').count(), 1);
    assert.equal(await bubbles().count(), 0);
    await until(
      finalText,
      (text) =>
        text.includes(active.expectedCode) &&
        text.includes(active.childInstructionCode!) &&
        /[\u3400-\u9fff]/u.test(text),
      'final_only_parent_actual_chinese_codes',
    );
    assert.equal(scenarios.active.footprint.controls, running.footprint.controls);
    await shot('09-active-completed', scenarios.active);
    checks.finalOnlyActiveSameRunEventDetailAndNoBubble = true;
  }
  const before = { idle: await read('idle'), active: await read('active') };
  await close();
  heldSince.clear();
  await launch();
  for (const which of ['idle', 'active'] as const) {
    await select(which, true);
    await until(
      () => parentNodes('article[data-final-reply="true"]').count(),
      (count) => count > 0,
      'final_only_cold_parent_reply_ready',
    );
    const after = await read(which);
    await noOrdinary(after);
    assert.equal(after.physicalRequests, before[which].physicalRequests);
    assert.deepEqual(after.footprint, before[which].footprint);
    assert.deepEqual(after.rootRunIds, before[which].rootRunIds);
    assert.equal(after.sourceId, before[which].sourceId);
    await until(
      finalText,
      (text) =>
        text.includes(after.expectedCode) &&
        (which === 'idle' ||
          (!!after.childInstructionCode && text.includes(after.childInstructionCode))),
      'final_only_cold_parent_final_codes',
    );
    if (which === 'idle')
      assert.deepEqual(await assertBubble(received.sourceId, received.expectedCode), idleBody);
    else {
      assert.equal(await bubbles().count(), 0);
      assert.equal(await parentNodes('.agent-turn').count(), 1);
      await creationName();
      if (steeringBoundaries) {
        await assertSteers(after, true);
        assert.ok((await finalText()).includes('Purple'));
      }
      await shot('22-cold-original-agent-creation', after);
      checks.coldOriginalAgentToolHistoryStatic = true;
    }
    await shot(which === 'idle' ? '10-cold-idle' : '11-cold-active', after);
  }
  checks.finalOnlyZeroOrdinaryAndNoControlChanges = true;
  checks.coldNoProviderReplay = true;
  checks.coldNoRunExecutionCommandSourceControlMutation = true;
}

try {
  await launch();
  if (finalResultsOnly || steeringBoundaries) await runFinalResultsOnly();
  else {
    await select('idle');
    await send('idle');
    log('idle_parent_ended_child_running');
    const ended = await until(
      read,
      (facts) =>
        facts.holds.includes('idle-child-first') &&
        facts.rootCompleted &&
        !facts.rootActive &&
        facts.childCount === 1,
      'parent_ended_child_gate',
    );
    assert.equal(ended.resultReceived, 0);
    await shot('01-parent-ended-child-running', ended);
    await release('idle-child-first');
    log('idle_ordinary_mail_queued');
    const queued = await until(
      read,
      (facts) => facts.holds.includes('idle-child-final') && facts.ordinaryPending === 1,
      'ordinary_mail_queue_only',
    );
    assert.equal(queued.ordinaryReceived, 0);
    assert.equal(queued.rootActive, false);
    assert.deepEqual(queued.rootRunIds, [ended.originalRunId]);
    assert.equal(await bubbles().count(), 0);
    assert.equal(await parentNodes('article[data-agent-message-id]').count(), 0);
    await shot('02-ordinary-mail-queued', queued);
    checks.idleOrdinaryMailDoesNotWake = true;
    await release('idle-child-final');
    log('idle_result_before_parent_reply');
    const idleReceived = await until(
      read,
      (facts) =>
        facts.holds.includes('idle-parent-result') &&
        facts.resultReceived === 1 &&
        facts.ordinaryReceived === 1 &&
        facts.receiptMode === 'idle_new_turn' &&
        facts.rootActive,
      'conditional_idle_result_received',
    );
    assert.ok(idleReceived.sourceId);
    assert.ok(idleReceived.receivedRunId && idleReceived.receivedRunId !== ended.originalRunId);
    assert.equal(idleReceived.rootRunIds.length, 2);
    const idleBody = await assertBubble(idleReceived.sourceId, idleReceived.expectedCode);
    await assertOrdinaryMail(idleReceived, idleReceived.receivedRunId);
    checks.ordinaryMailNotRenderedAsUserPlaceholder = true;
    checks.idleOrdinarySenderAndEntireBodyVisibleOnce = true;
    await shot('03-idle-result-before-parent-reply', idleReceived);
    checks.idleConditionalContinuation = true;
    checks.idleResultVisibleBeforeParentReply = true;
    await release('idle-parent-result');
    log('idle_complete');
    scenarios.idle = await until(
      read,
      (facts) =>
        facts.rootCompleted && !facts.rootActive && !!facts.childDone && facts.resultReceived === 1,
      'idle_all_terminal',
    );
    assert.deepEqual(
      await assertBubble(idleReceived.sourceId, idleReceived.expectedCode),
      idleBody,
    );
    await assertOrdinaryMail(scenarios.idle, idleReceived.receivedRunId);
    await shot('04-idle-complete', scenarios.idle);

    await select('active');
    await send('active');
    log('active_parent_running');
    const running = await until(
      read,
      (facts) =>
        facts.holds.includes('active-parent-checkpoint') &&
        facts.holds.includes('active-child-first') &&
        facts.rootActive &&
        facts.childCount === 1,
      'both_active_gates',
    );
    assert.ok(running.originalRunId);
    await until(
      () => parentNodes('.child-agent-activity .tool-agent-operation').allTextContents(),
      (values) => values.length === 1 && values[0] === '创建子 Agent',
      'original_agent_creation_operation_visible',
    );
    await agentOperationAudit('begin');
    await shot('05-parent-running', running);
    await release('active-child-first');
    if (!parentCompactionOnly) {
      log('active_child_compression');
      const childSummarizing = await until(
        read,
        (facts) =>
          facts.holds.includes('active-child-summary') &&
          facts.childCompressionPending &&
          facts.holds.includes('active-parent-checkpoint') &&
          facts.rootActive,
        'real_child_summary_while_parent_inflight',
      );
      assert.ok(childSummarizing.childTask && childSummarizing.childInstructionCode);
      assert.equal(childSummarizing.childTask.sourceIds.length, 2);
      assert.equal(childSummarizing.childTask.sourceIds[0], childSummarizing.childTask.commandId);
      await page!
        .getByRole('button', { name: /^查看子 Agent 详情：/ })
        .last()
        .click();
      const compressingChildDetail = page!.locator('.session-tab-child');
      await compressingChildDetail.waitFor();
      const assertOriginalChildTask = async (facts: Facts) => {
        assert.ok(facts.childTask && facts.childInstructionCode);
        assert.ok(facts.childTask.body.includes(facts.childInstructionCode));
        const bodies = compressingChildDetail.locator('.typeset-chat');
        await until(
          () => bodies.allTextContents(),
          (texts) => texts.some((text) => normalized(text) === normalized(facts.childTask!.body)),
          'entire_original_agent_assignment_visible',
        );
        const task = bodies.filter({ hasText: facts.childInstructionCode }).first();
        await task.scrollIntoViewIfNeeded();
      };
      await assertOriginalChildTask(childSummarizing);
      await shot('20-child-real-summary-original-task', childSummarizing);
      await release('active-child-summary');
      log('active_child_postcompression');
      const childCompressed = await until(
        read,
        (facts) =>
          facts.holds.includes('active-child-postcompression') &&
          !!facts.childCompression &&
          facts.holds.includes('active-parent-checkpoint') &&
          facts.rootActive,
        'real_child_postcompression_request',
      );
      assert.equal(childCompressed.childCompression!.runId, childCompressed.childTask!.runId);
      assert.equal(childCompressed.childCompression!.trigger, 'automatic');
      assert.ok(
        BigInt(childCompressed.childCompression!.coveredThroughSeq) >=
          BigInt(childCompressed.childTask!.seq),
      );
      await until(
        () => compressingChildDetail.locator('.context-compacted.completed').count(),
        (count) => count === 1,
        'child_compression_sql_display',
      );
      await assertOriginalChildTask(childCompressed);
      await shot('21-child-postcompression-original-task', childCompressed);
      await page!.getByRole('button', { name: '收起标签栏', exact: true }).click();
      await release('active-child-postcompression');
      checks.realChildCompressionKeepsOriginalAgentAssignment = true;
    }
    log('active_ordinary_mail_queued');
    await until(
      read,
      (facts) => facts.holds.includes('active-child-final') && facts.ordinaryPending === 1,
      'active_ordinary_mail_pending',
    );
    await release('active-child-final');
    log('active_child_completed_parent_inflight');
    const pending = await until(
      read,
      (facts) =>
        !!facts.childDone &&
        facts.resultPending === 1 &&
        facts.resultReceived === 0 &&
        facts.holds.includes('active-parent-checkpoint'),
      'result_waits_for_parent_checkpoint',
    );
    assert.equal(pending.rootActive, true);
    assert.deepEqual(pending.rootRunIds, [running.originalRunId]);
    assert.equal(await bubbles().count(), 0);
    await shot('06-child-completed-parent-inflight', pending);
    await release('active-parent-checkpoint');
    log('active_received_in_process');
    const activeReceived = await until(
      read,
      (facts) =>
        facts.holds.includes('active-parent-result') &&
        facts.resultReceived === 1 &&
        facts.ordinaryReceived === 1 &&
        facts.receiptMode === 'active' &&
        facts.receivedRunId === facts.originalRunId &&
        facts.rootActive,
      'same_run_result_received',
    );
    assert.ok(activeReceived.sourceId);
    assert.deepEqual(activeReceived.rootRunIds, [running.originalRunId]);
    assert.equal(await bubbles().count(), 0);
    const activeProcesses = parentNodes('.agent-turn[data-turn-status="running"]');
    checks.activeSingleProcessForOriginalRun = (await activeProcesses.count()) === 1;
    assert.equal(
      checks.activeSingleProcessForOriginalRun,
      true,
      'mail stays inline in the original parent process',
    );
    await assertOrdinaryMail(
      activeReceived,
      running.originalRunId,
      '12-active-ordinary-mail-detail',
    );
    checks.activeOrdinarySenderAndEntireBodyVisibleOnce = true;
    const events = parentNodes('.agent-turn[data-turn-status="running"] .tool-activity-summary')
      .filter({ hasText: '等待 Agent 事件' })
      .last();
    await events.waitFor();
    await events.click();
    await until(
      () => activeProcesses.allTextContents().then((texts) => texts.join('\n')),
      (text) => text.includes('"kind":"completed"'),
      'completed_wait_agent_events_visible',
    );
    await shot('07-active-received-in-process', activeReceived);
    checks.activeResultOnlyInOriginalProcess = true;
    await events.click();
    log('active_child_result_detail');
    await page!
      .getByRole('button', { name: /^查看子 Agent 详情：/ })
      .last()
      .click();
    const detail = page!.locator('.session-tab-child');
    await detail.waitFor();
    const finalReply = detail
      .locator('article[data-final-reply="true"]')
      .last()
      .locator('.typeset-chat');
    await until(
      () => finalReply.allTextContents().then((texts) => texts.join('\n')),
      (text) =>
        !!activeReceived.expectedCode &&
        text.includes(activeReceived.expectedCode) &&
        !!activeReceived.childInstructionCode &&
        text.includes(activeReceived.childInstructionCode),
      'actual_child_final_reply',
    );
    assert.equal(await bubbles().count(), 0);
    await shot('08-active-child-result-detail', activeReceived);
    await page!.getByRole('button', { name: '收起标签栏', exact: true }).click();
    checks.activeChildResultDetailVisible = true;
    await sendSteers();
    await assertSteers(await read(), false);
    await release('active-parent-result');
    log('active_guided_request');
    const guided = await until(
      read,
      (facts) =>
        facts.holds.includes('active-parent-guided') &&
        facts.steers.length === 2 &&
        facts.steers.every((row) => row.status === 'applied') &&
        facts.rootActive,
      'actual_guided_request_after_both_steers',
    );
    await assertSteers(guided, true);
    for (let index = 0; index < 2; index++) {
      await steerCards().nth(index).scrollIntoViewIfNeeded();
      await shot(`15-guided-request-steer-${index + 1}`, guided);
    }
    await release('active-parent-guided');
    checks.twoRealUiSteersReceivedBySameRun = true;
    log('active_compression_in_progress');
    const compressing = await until(
      read,
      (facts) =>
        facts.holds.includes('active-compression-summary') &&
        facts.compressionPending &&
        facts.parentReadCount === 1 &&
        facts.rootActive,
      'actual_same_run_summary_request',
    );
    assert.deepEqual(compressing.rootRunIds, [running.originalRunId]);
    await until(
      () => parentNodes('.context-compacted.running').filter({ hasText: '正在压缩上下文' }).count(),
      (count) => count > 0,
      'real_compression_progress_visible',
    );
    await assertSteers(compressing, true);
    const parentCompression = parentNodes('.context-compacted').filter({
      has: page!.getByText('正在压缩上下文', { exact: true }),
    });
    assert.equal(await parentCompression.count(), 1);
    await parentCompression.scrollIntoViewIfNeeded();
    await compressionAudit('begin', 'parent');
    await shot('18-real-automatic-compression-in-progress', compressing);
    await release('active-compression-summary');
    log('active_postcompression_request');
    const compressed = await until(
      read,
      (facts) =>
        facts.holds.includes('active-postcompression') && !!facts.compression && facts.rootActive,
      'first_real_postcompression_business_request',
    );
    assert.equal(compressed.compression!.runId, running.originalRunId);
    assert.equal(compressed.compression!.trigger, 'automatic');
    for (const steer of compressed.steers)
      assert.ok(BigInt(compressed.compression!.coveredThroughSeq) >= BigInt(steer.seq));
    await until(
      () => parentNodes('.context-compacted.completed').count(),
      (count) => count === 1,
      'parent_compression_sql_display',
    );
    await compressionAudit('finish', 'parent');
    await assertSteers(compressed, true);
    for (let index = 0; index < 2; index++) {
      await steerCards().nth(index).scrollIntoViewIfNeeded();
      await shot(`19-postcompression-steer-${index + 1}-full`, compressed);
    }
    await agentOperationAudit('finish');
    await release('active-postcompression');
    checks.sameRunRealAutomaticCompressionCoversBothSteers = true;
    log('active_completed');
    scenarios.active = await until(
      read,
      (facts) =>
        facts.rootCompleted && !facts.rootActive && !!facts.childDone && facts.resultReceived === 1,
      'active_all_terminal',
    );
    assert.deepEqual(scenarios.active.rootRunIds, [running.originalRunId]);
    assert.equal(await bubbles().count(), 0);
    assert.equal(await parentNodes('.agent-turn').count(), 1);
    const finalParent = parentNodes('.agent-turn-final article[data-final-reply="true"]').last();
    await until(
      () => finalParent.innerText(),
      (text) =>
        scenarios.active!.steerCodes.every((code) => text.includes(code)) &&
        text.includes('Blue') &&
        !text.includes('Red'),
      'visible_final_reply_keeps_latest_guidance_after_compression',
    );
    await assertTerminalSteers(scenarios.active, '16-complete');
    await assertOrdinaryMail(scenarios.active, running.originalRunId);
    await shot('09-active-completed', scenarios.active);
    checks.activeNoRetroactiveBubble = true;

    log('cold_close');
    const before = { idle: await read('idle'), active: await read('active') };
    await close();
    checks.firstCleanExit = true;
    heldSince.clear();
    await launch();
    for (const which of ['idle', 'active'] as const) {
      await select(which, true);
      log(`cold_${which}`);
      await until(
        () => page!.locator('article[data-final-reply="true"]').count(),
        (count) => count > 0,
        'cold_parent_final_reply_loaded',
      );
      if (which === 'idle')
        assert.deepEqual(
          await assertBubble(idleReceived.sourceId, idleReceived.expectedCode),
          idleBody,
        );
      else assert.equal(await bubbles().count(), 0);
      const after = await read(which);
      assert.equal(after.physicalRequests, before[which].physicalRequests);
      assert.deepEqual(after.footprint, before[which].footprint);
      assert.deepEqual(after.rootRunIds, before[which].rootRunIds);
      assert.equal(after.sourceId, before[which].sourceId);
      assert.deepEqual(after.compression, before[which].compression);
      assert.deepEqual(after.childCompression, before[which].childCompression);
      assert.deepEqual(after.childTask, before[which].childTask);
      assert.equal(after.resultReceived, 1);
      const expectedRun = which === 'idle' ? idleReceived.receivedRunId : running.originalRunId;
      if (which === 'active') await assertTerminalSteers(after, '17-cold');
      if (which === 'active') {
        const summary = parentNodes('.agent-turn-summary[aria-expanded]');
        await summary.click();
        await until(
          () => parentNodes('.child-agent-activity .tool-agent-operation').allTextContents(),
          (values) => values.length === 1 && values[0] === '创建子 Agent',
          'cold_original_agent_creation_stays_static',
        );
        await parentNodes('.child-agent-activity').scrollIntoViewIfNeeded();
        await shot('22-cold-original-agent-creation', after);
        await summary.click();
        checks.coldOriginalAgentToolHistoryStatic = true;
      }
      await assertOrdinaryMail(after, expectedRun);
      if (which === 'active') assert.equal(await parentNodes('.agent-turn').count(), 1);
      await shot(which === 'idle' ? '10-cold-idle' : '11-cold-active', after);
    }
    checks.coldNoProviderReplay = true;
    checks.coldNoRunExecutionCommandSourceControlMutation = true;
    checks.ordinaryMailCompleteAndColdNoDuplicate = true;
    checks.steersSameProcessFullOrderedFoldAndCold = true;
  }
  await close();
  checks.cleanWindowExit = true;
  checks.continuousFrames = frames.length;
  log('complete');
  const passed = Object.values(checks).every((value) => value !== false);
  writeFileSync(
    receiptPath,
    JSON.stringify({
      passed,
      validationProfile,
      stage,
      failurePoint: passed
        ? null
        : finalResultsOnly
          ? 'final_result_only_receipt_and_presentation'
          : 'ordinary_mail_public_projection_and_turn_grouping',
      checks,
      scenarios,
      observations,
      frames: { count: frames.length, manifest, compressionAuditPath },
    }),
  );
} catch (error) {
  if (page) {
    try {
      await page.screenshot({ path: join(home, 'failure.png'), fullPage: true, timeout: 5000 });
      writeFileSync(manifest, JSON.stringify(frames));
    } catch {}
  }
  writeFileSync(
    receiptPath,
    JSON.stringify({
      passed: false,
      validationProfile,
      stage,
      checks,
      scenarios,
      observations,
      frames: { count: frames.length, manifest, compressionAuditPath },
      failureKind: error instanceof Error ? error.name : 'unknown',
      failureDetail:
        error instanceof Error
          ? error.message.replaceAll(control, '[private-control]').slice(0, 2000)
          : String(error).replaceAll(control, '[private-control]').slice(0, 2000),
      failureStack:
        error instanceof Error
          ? error.stack?.replaceAll(control, '[private-control]').slice(0, 6000)
          : undefined,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await close();
  } catch {
    process.exitCode = 1;
  }
}
