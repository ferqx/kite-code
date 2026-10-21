import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron, type Page } from 'playwright';
import type { NativeState } from '../src/native-bridge';

export const livePermissionExpected = {
  main: {
    holdingMarker: 'MAIN STARTED\n',
    marker: 'MAIN STARTED\nMAIN FINISHED\n',
    effect: 'MAIN EFFECT\n',
    finalReply: 'MAIN PERMISSIONS DONE',
  },
  child: {
    holdingMarker: 'CHILD STARTED\n',
    marker: 'CHILD STARTED\nCHILD FINISHED\n',
    effect: 'CHILD EFFECT\n',
    finalReply: 'CHILD PERMISSIONS DONE',
  },
} as const;
export type LivePermissionActor = {
  sessionId: string;
  runId: string;
  carrierId: string | null;
  shell: {
    id: string;
    status: string;
    dispatched: boolean;
    cancelRequestedAt: string | null;
    jobId: string | null;
    jobState: string | null;
  };
  target: {
    id: string;
    status: string;
    dispatched: boolean;
    attempt: number;
    controlRevisions: string[];
  } | null;
  cards: {
    id: string;
    state: 'pending' | 'answered' | 'cancelled';
    answer: unknown;
    policyRevision: string;
  }[];
  markerContent: string | null;
  effectExists: boolean;
  effectContent: string | null;
};
export type LivePermissionFacts = {
  storeId: string;
  mode: { mode: 'accept_edits' | 'auto' | 'full'; revision: string };
  actors: { main: LivePermissionActor | null; child: LivePermissionActor | null };
  holding: boolean;
  pending: boolean;
  terminal: boolean;
  calls: number;
  reviews: number;
  answerPosts: number;
  childCount: number;
};

type MainNetwork = {
  original: typeof fetch;
  template?: Request;
  answerPosts: number;
};
const [candidate, home, control, evidence] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const roles = ['main', 'child'] as const;
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let page: Page | undefined;
let stage = 'launch';
let normalShutdown = false;
let electronExitCode: number | null = null;
let owned: { pid: number; command: string }[] = [];
const checkpoints: Record<string, LivePermissionFacts> = {};
mkdirSync(evidence, { recursive: true, mode: 0o700 });

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string) {
  const end = Date.now() + 25000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < end, `live_permissions_deadline:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function facts(): Promise<LivePermissionFacts> {
  const response = await fetch(`${control}/facts`);
  assert.equal(response.status, 200);
  return response.json() as Promise<LivePermissionFacts>;
}
function actors(value: LivePermissionFacts) {
  assert.ok(value.actors.main && value.actors.child, 'both original actors exist');
  return { main: value.actors.main, child: value.actors.child };
}
function processRows() {
  return String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command=']))
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      assert.ok(match);
      return { pid: Number(match[1]), parent: Number(match[2]), command: match[3]! };
    });
}
function rememberOwnedProcesses() {
  const root = app!.process().pid;
  assert.ok(root);
  const rows = processRows();
  const descendants = new Set([root]);
  for (let i = 0; i < rows.length; i++)
    for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
  owned = rows.filter((row) => row.pid !== root && descendants.has(row.pid));
  assert.ok(
    owned.some((row) => row.command.includes(candidate)),
    'owned candidate descendants observed',
  );
}
async function close() {
  if (!app) return;
  const current = app;
  const process = current.process();
  const exited = new Promise<void>((resolve) => {
    if (process.exitCode !== null) resolve();
    else process.once('exit', () => resolve());
  });
  if (process.exitCode === null) {
    await current.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await current.evaluate(({ app: electron }) => electron.quit());
  }
  await Promise.race([
    exited,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(Error('live_permissions_normal_exit_deadline')), 20000);
      timer.unref();
    }),
  ]);
  app = undefined;
  assert.equal(process.exitCode, 0, 'normal Electron exit');
  electronExitCode = process.exitCode;
  await until(
    async () => processRows(),
    (rows) =>
      !owned.some((original) =>
        rows.some((row) => row.pid === original.pid && row.command === original.command),
      ),
    'owned Service and descendants exited',
  );
  normalShutdown = true;
}
async function visibleMode(mode: LivePermissionFacts['mode']['mode']) {
  const label = { accept_edits: '请求批准', auto: '自动审核', full: '完全访问' }[mode];
  const trigger = page!.locator('[data-permission-trigger]');
  await until(
    async () => ({
      visible: await trigger.isVisible(),
      label: await trigger.getAttribute('aria-label'),
      text: await trigger.innerText(),
      busy: await trigger.getAttribute('aria-busy'),
    }),
    (value) =>
      value.visible &&
      !!value.label?.includes(label) &&
      value.text.includes(label) &&
      value.busy !== 'true',
    `renderer shows ${mode}`,
  );
}
async function chooseMode(mode: LivePermissionFacts['mode']['mode']) {
  await page!.locator('[data-permission-trigger]').click();
  await page!
    .getByRole('menuitemradio')
    .nth(['accept_edits', 'auto', 'full'].indexOf(mode))
    .click();
  if (mode === 'full')
    await page!
      .getByRole('alertdialog')
      .getByRole('button', { name: /^(Enable Full|启用完全权限)$/ })
      .click();
  await visibleMode(mode);
  return until(facts, (value) => value.mode.mode === mode, `applied ${mode}`);
}
async function setModeViaIndependentHttp(
  expectedStoreId: string,
  mode: LivePermissionFacts['mode']['mode'],
) {
  return app!.evaluate(
    async (_electron, { expectedStoreId, mode, commandId }) => {
      const network = (globalThis as typeof globalThis & { livePermissionNetwork?: MainNetwork })
        .livePermissionNetwork;
      if (!network?.template) throw Error('live_permissions_original_get_unobserved');
      const observed = network.template;
      const currentResponse = await network.original(observed.clone());
      if (!currentResponse.ok) throw Error('live_permissions_fresh_mode_failed');
      const current = (await currentResponse.json()) as {
        storeId: string;
        sessionId: string;
        scopeSessionId: string;
        revision: string;
        defaultRevision: string;
      };
      if (
        current.storeId !== expectedStoreId ||
        current.sessionId !== 'permission-root' ||
        current.scopeSessionId !== 'permission-root'
      )
        throw Error('live_permissions_original_scope_changed');
      const url = new URL(observed.url);
      url.search = '';
      const headers = new Headers(observed.headers);
      headers.delete('content-length');
      headers.set('content-type', 'application/json');
      const response = await network.original(url.href, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedStoreId,
          commandId,
          mode,
          makeDefault: false,
          ifRevision: current.revision,
          ifDefaultRevision: current.defaultRevision,
        }),
      });
      if (!response.ok) throw Error('live_permissions_independent_post_failed');
      const result = (await response.json()) as {
        commandId: string;
        kind: string;
        state: string;
        receipt: { status: string };
      };
      if (
        result.commandId !== commandId ||
        result.kind !== 'permission.mode' ||
        result.state !== 'applied' ||
        result.receipt.status !== 'applied'
      )
        throw Error('live_permissions_independent_receipt_mismatch');
      const appliedResponse = await network.original(observed.clone());
      if (!appliedResponse.ok) throw Error('live_permissions_applied_mode_read_failed');
      const applied = (await appliedResponse.json()) as typeof current & { mode: string };
      if (
        applied.storeId !== expectedStoreId ||
        applied.sessionId !== current.sessionId ||
        applied.scopeSessionId !== current.scopeSessionId ||
        applied.mode !== mode ||
        !/^(0|[1-9]\d*)$/.test(applied.revision) ||
        BigInt(applied.revision) <= BigInt(current.revision)
      )
        throw Error('live_permissions_applied_mode_mismatch');
      return {
        commandId: result.commandId,
        revision: applied.revision,
        answerPosts: network.answerPosts,
      };
    },
    { expectedStoreId, mode, commandId: crypto.randomUUID() },
  );
}
async function state() {
  return page!.evaluate(
    async () =>
      (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
  );
}
async function screenshot(name: string) {
  await page!.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
}
async function queueFacts() {
  return app!.evaluate(
    async (_electron, storeId) => {
      const network = (globalThis as typeof globalThis & { livePermissionNetwork?: MainNetwork })
        .livePermissionNetwork;
      if (!network?.template) throw Error('original_connection_unobserved');
      const url = new URL(network.template.url);
      url.pathname = '/v1/sessions/queue-root/input-queue';
      url.search = new URLSearchParams({ storeId, limit: '200' }).toString();
      const response = await network.original(url.href, { headers: network.template.headers });
      if (!response.ok) throw Error('queue_observation_failed');
      return response.json() as Promise<{
        commands: { id: string; status: string; request: { content: string } }[];
        revision: string;
      }>;
    },
    (await facts()).storeId,
  );
}
async function queueShellFacts() {
  const response = await fetch(`${control}/queue-shell-facts`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    id: string;
    status: string;
    attempt: number;
    cancelRequestedAt: number | null;
  }>;
}
async function verifyQueueWindow() {
  await page!
    .getByRole('button', { name: 'Queue prompts', exact: true })
    .and(page!.locator('button.session-row'))
    .click();
  await until(
    state,
    (value) =>
      value.selection?.session.id === 'queue-root' &&
      !value.selection.viewLoading &&
      !!value.selection.permissions,
    'queue session ready',
  );
  await page!.locator('[data-permission-trigger]').click();
  await page!.getByRole('menuitemradio').nth(0).click();
  await visibleMode('accept_edits');
  const draft = page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
  const submit = () => page!.locator('form.composer button[type="submit"]').click();
  await draft.fill('QUEUE JOURNEY');
  await submit();
  const group = page!.getByRole('region', { name: '需要人工审批', exact: true });
  await group.getByRole('button', { name: '批准一次', exact: true }).waitFor();
  const command = group.locator('.approval-command');
  await until(
    async () => command.innerText(),
    (value) => value.includes('LONG SAFE QUEUE SHELL'),
    'full shell command loaded',
  );
  const shellText = await command.innerText();
  assert.ok(shellText.length > 400);
  assert.ok(await command.evaluate((element) => element.scrollWidth > element.clientWidth));
  assert.equal(
    await command.evaluate((element) => getComputedStyle(element).textOverflow),
    'ellipsis',
  );
  await command.hover();
  const tooltip = page!.locator('.approval-command-tooltip');
  await tooltip.waitFor();
  assert.equal(await tooltip.innerText(), shellText);
  await screenshot('09a-queue-long-shell-full-hover');
  assert.equal(await group.locator('.approval-child').count(), 0);
  assert.equal(await group.getByRole('button', { name: /详情/ }).count(), 0);
  assert.ok((await group.boundingBox())!.height <= 112);
  await draft.hover();
  await screenshot('09-queue-long-shell-approval');
  const toolApproval = await group.getByRole('article').getAttribute('aria-label');
  await group.getByRole('button', { name: '批准一次', exact: true }).click();
  await until(
    state,
    (value) =>
      !!value.answerSubmissions?.some(
        (item) => item.scope.sessionId === 'queue-root' && item.phase === 'accepted',
      ),
    'queue explicit answer saved',
  );
  await until(
    async () => group.getByRole('article').getAttribute('aria-label'),
    (value) => !!value && value !== toolApproval,
    'separately authorized Shell Job card projected',
  );
  await visibleMode('accept_edits');
  // The ordinary Tool's one answer does not answer its separately authorized Job.
  // Choose Full through the production picker before dispatching that held Job.
  await page!.locator('[data-permission-trigger]').click();
  await page!.getByRole('menuitemradio').nth(2).click();
  await page!
    .getByRole('alertdialog')
    .getByRole('button', { name: /^(Enable Full|启用完全权限)$/ })
    .click();
  await visibleMode('full');
  await until(
    async () => (await fetch(`${control}/queue-held`)).json() as Promise<{ held: boolean }>,
    (value) => value.held,
    'queue original Shell held',
  );
  const originalShell = await queueShellFacts();
  assert.equal(originalShell.attempt, 1);
  assert.equal(originalShell.cancelRequestedAt, null);
  const texts = [
    `补充当前任务的 **alpha 说明**，保留原任务上下文。${'较长的排队消息内容 '.repeat(45)}\n\n- 第一项\n- 第二项`,
    '补充当前任务的 **beta 说明**，保留原任务上下文。',
    '补充当前任务的 **gamma 说明**，保留原任务上下文。',
  ];
  for (let index = 0; index < texts.length; index++) {
    await draft.focus();
    await draft.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
      );
    }, texts[index]!);
    await submit();
    await until(
      queueFacts,
      (value) =>
        value.commands.length === index + 1 &&
        value.commands.every((item) => item.status === 'accepted'),
      'real accepted queue input',
    );
  }
  const initial = await queueFacts();
  assert.deepEqual(
    initial.commands.map((item) => item.request.content),
    texts,
  );
  const queue = page!.getByRole('list', { name: '排队消息', exact: true });
  await until(
    async () => queue.locator('[data-queued-prompt]').count(),
    (value) => value === 3,
    'renderer observes real queue',
  );
  const row = (id: string) => queue.locator(`[data-queued-prompt="${id}"]`);
  const [alpha, beta, gamma] = initial.commands.map((item) => item.id) as [string, string, string];
  const preview = row(alpha).getByLabel('排队消息全文', { exact: true });
  assert.equal(await preview.locator('strong').innerText(), 'alpha 说明');
  assert.ok(await preview.evaluate((element) => element.scrollWidth > element.clientWidth));
  await preview.evaluate(async (element) => {
    let previous = '';
    for (let frame = 0; frame < 120; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const box = element.getBoundingClientRect();
      const current = JSON.stringify([box.x, box.y, box.width, box.height]);
      if (current === previous) return;
      previous = current;
    }
    throw Error('queue_preview_geometry_unstable');
  });
  await preview.evaluate((element) => {
    const events: { type: string; x: number; y: number }[] = [];
    (element as HTMLElement & { queueHoverEvents?: typeof events }).queueHoverEvents = events;
    for (const type of ['pointerenter', 'pointermove', 'pointerleave'])
      element.addEventListener(
        type,
        (event) => {
          const pointer = event as PointerEvent;
          events.push({ type, x: pointer.clientX, y: pointer.clientY });
        },
        { passive: true },
      );
  });
  await draft.hover();
  await preview.hover({ position: { x: 12, y: 10 } });
  const queueTooltip = page!.locator('.composer-queue-tooltip');
  const hoverOpened = await queueTooltip.waitFor({ timeout: 3000 }).then(
    () => true,
    () => false,
  );
  if (!hoverOpened) {
    const diagnostics = await preview.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + 12, box.top + 10);
      return {
        box: box.toJSON(),
        hit: hit && { tag: hit.tagName, class: hit.className },
        state: element.getAttribute('data-state'),
        events: (element as HTMLElement & { queueHoverEvents?: unknown }).queueHoverEvents,
      };
    });
    writeFileSync(
      join(evidence, 'queue-hover-diagnostics.json'),
      JSON.stringify(diagnostics, null, 2),
      { mode: 0o600 },
    );
  }
  assert.equal(hoverOpened, true, 'actual pointer hover opens complete queue Markdown');
  const hoverEvents = await preview.evaluate(
    (element) =>
      (element as HTMLElement & { queueHoverEvents?: { type: string }[] }).queueHoverEvents,
  );
  assert.ok(
    hoverEvents?.some((event) => event.type === 'pointermove'),
    'the same queue preview DOM receives the actual hover',
  );
  assert.equal(await queueTooltip.locator('strong').innerText(), 'alpha 说明');
  assert.ok((await queueTooltip.innerText()).includes('第二项'));
  await screenshot('10a-queue-single-line-and-markdown-hover');
  await draft.hover();
  await row(gamma).getByRole('button', { name: '移动排队消息', exact: true }).dragTo(row(alpha));
  await until(
    queueFacts,
    (value) => value.commands.map((item) => item.id).join() === [gamma, alpha, beta].join(),
    'drag persisted real queue order',
  );
  await row(beta).getByRole('button', { name: '删除排队消息', exact: true }).click();
  await until(
    queueFacts,
    (value) => value.commands.map((item) => item.id).join() === [gamma, alpha].join(),
    'delete withdrew original input',
  );
  await row(alpha).getByRole('button', { name: '编辑排队消息', exact: true }).click();
  await until(
    queueFacts,
    (value) => value.commands.map((item) => item.id).join() === gamma,
    'edit withdrew original input',
  );
  await until(
    async () => draft.innerText(),
    (value) => value.includes('第二项') && value.split('较长的排队消息内容').length === 46,
    'edit places complete Markdown in ordinary composer',
  );
  assert.equal(await draft.locator('.prompt-bold').innerText(), 'alpha 说明');
  assert.equal(await row(alpha).count(), 0);
  assert.equal(await page!.getByRole('button', { name: /取消编辑|恢复排队/ }).count(), 0);
  assert.equal((await queueFacts()).commands.length, 1, 'edit does not automatically submit');
  await screenshot('10-queue-edited-removed-and-draft');
  await submit();
  const resubmitted = await until(
    queueFacts,
    (value) => value.commands.length === 2,
    'manual submit creates a new queue input',
  );
  assert.equal(resubmitted.commands[0]!.id, gamma);
  assert.notEqual(resubmitted.commands[1]!.id, alpha);
  assert.equal(resubmitted.commands[1]!.request.content, texts[0]);
  // Delete remaining queue inputs before releasing the Shell so the fixture proves
  // zero automatic resubmission and avoids changing the completed permission journey.
  for (const item of resubmitted.commands) {
    await row(item.id).getByRole('button', { name: '删除排队消息', exact: true }).click();
    await until(
      queueFacts,
      (value) => !value.commands.some((pending) => pending.id === item.id),
      'remaining queue input withdrawn',
    );
  }
  const afterEditsShell = await queueShellFacts();
  assert.equal(afterEditsShell.id, originalShell.id);
  assert.equal(afterEditsShell.attempt, 1);
  assert.equal(afterEditsShell.cancelRequestedAt, null);
  assert.ok(['dispatching', 'running'].includes(afterEditsShell.status));
  assert.equal((await fetch(`${control}/queue-release`)).status, 200);
  await page!.getByText('QUEUE DONE', { exact: true }).waitFor();
  await screenshot('11-queue-terminal');
  return {
    hoverOpened,
    shellId: originalShell.id,
    shellUnchangedThroughQueueEdits: true,
    originalIds: initial.commands.map((item) => item.id),
    editedOriginalId: alpha,
    resubmittedId: resubmitted.commands[1]!.id,
  };
}
async function assertApprovalGroup(cards: Record<(typeof roles)[number], string>) {
  const group = page!.getByRole('region', { name: '需要人工审批', exact: true });
  await group.waitFor();
  await until(
    async () => group.locator('.approval-pager').innerText(),
    (value) => /[12]\/2/.test(value),
    'both original approvals projected',
  );
  assert.equal(await group.count(), 1);
  assert.equal(await group.getByText('需要批准', { exact: true }).count(), 1);
  assert.equal(await group.getByRole('article').count(), 1);
  assert.equal(await group.getByText('主 Agent', { exact: true }).count(), 0);
  assert.equal(await group.getByRole('button', { name: /详情/ }).count(), 0);
  assert.equal(await group.getByRole('button', { name: '批准一次', exact: true }).count(), 1);
  const box = await group.boundingBox();
  assert.ok(box && box.height <= 112, 'approval float fits default Composer height');
  const draft = page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
  assert.equal(await draft.isVisible(), true);
  assert.equal(await page!.locator('[data-permission-trigger]').isVisible(), true);
  let childAppearance: { icon: string | null; color: string | null } | undefined;
  for (const role of roles) {
    const item = group.getByRole('article', { name: `approval ${cards[role]}`, exact: true });
    if (!(await item.isVisible()))
      await group.getByRole('button', { name: '下一项审批', exact: true }).click();
    await item.waitFor();
    assert.equal(await item.count(), 1);
    const pager = await group.locator('.approval-pager').innerText();
    assert.match(pager, /[12]\/2/);
    if (role === 'main')
      await until(
        async () => ({
          article: await group.getByRole('article').getAttribute('aria-label'),
          child: await group.locator('.approval-child').count(),
        }),
        (value) => value.article === `approval ${cards.main}` && value.child === 0,
        'root approval has no child label',
      );
    else {
      await group.getByText('permission-child', { exact: true }).waitFor();
      const icon = group.locator('.approval-child-icon');
      childAppearance = {
        icon: await icon.getAttribute('data-child-icon'),
        color: await icon.getAttribute('data-child-color'),
      };
      assert.match(childAppearance.icon ?? '', /^[0-5]$/);
      assert.match(childAppearance.color ?? '', /^[0-5]$/);
      assert.notEqual(
        await icon.evaluate((element) => getComputedStyle(element).color),
        'rgba(0, 0, 0, 0)',
      );
    }
    const command = item.locator('.approval-command');
    const styles = await command.evaluate((element) => ({
      overflow: getComputedStyle(element).overflow,
      ellipsis: getComputedStyle(element).textOverflow,
      whiteSpace: getComputedStyle(element).whiteSpace,
    }));
    assert.equal(styles.overflow, 'hidden');
    assert.equal(styles.ellipsis, 'ellipsis');
    assert.equal(styles.whiteSpace, 'pre');
    await command.hover();
    const tooltip = page!.locator('.approval-command-tooltip');
    await tooltip.waitFor();
    await until(
      async () => tooltip.innerText(),
      (value) => value.includes('EFFECT'),
      'complete original approval content',
    );
    await draft.hover();
  }
  await group.getByRole('button', { name: '下一项审批', exact: true }).click();
  await group.getByRole('button', { name: '下一项审批', exact: true }).click();
  const icon = group.locator('.approval-child-icon');
  assert.deepEqual(
    {
      icon: await icon.getAttribute('data-child-icon'),
      color: await icon.getAttribute('data-child-color'),
    },
    childAppearance,
    'child appearance remains stable after paging',
  );
}
async function openChild(carrierId: string, final = false) {
  const show = page!.getByRole('button', { name: '显示环境信息', exact: true });
  if (await show.isVisible()) await show.click();
  await page!
    .locator(`li[data-execution-id="${carrierId}"]`)
    .getByRole('button', { name: /^查看子 Agent 详情：/ })
    .click();
  const detail = page!.locator('.session-tab-child');
  if (final)
    await detail.getByText(livePermissionExpected.child.finalReply, { exact: true }).waitFor();
  else await detail.getByText('等待人工审批', { exact: false }).first().waitFor();
  assert.equal(
    (await state()).selection?.session.id,
    'permission-root',
    'production child tab retains root selection',
  );
}
async function returnFromChild() {
  await page!.getByRole('button', { name: '收起标签栏', exact: true }).click();
  const hide = page!.getByRole('button', { name: '隐藏环境信息', exact: true });
  if (await hide.isVisible()) await hide.click();
}
function sameActors(value: LivePermissionFacts, original: ReturnType<typeof actors>) {
  const current = actors(value);
  for (const role of roles) {
    assert.equal(current[role].sessionId, original[role].sessionId);
    assert.equal(current[role].runId, original[role].runId);
    assert.equal(current[role].carrierId, original[role].carrierId);
    assert.equal(current[role].shell.id, original[role].shell.id);
    assert.equal(current[role].shell.jobId, original[role].shell.jobId);
    assert.equal(current[role].shell.cancelRequestedAt, null);
  }
  return current;
}

try {
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 20000,
  });
  // Passive Main-only fixture. Requests, responses, policy and SDK state are untouched.
  await app.evaluate(() => {
    const global = globalThis as typeof globalThis & { livePermissionNetwork?: MainNetwork };
    const network: MainNetwork = { original: globalThis.fetch, answerPosts: 0 };
    global.livePermissionNetwork = network;
    const observeFetch = (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init);
      const path = new URL(request.url).pathname;
      if (
        request.method === 'GET' &&
        path === '/v1/sessions/permission-root/permission-mode' &&
        request.headers.has('authorization')
      )
        network.template = request.clone();
      if (request.method === 'POST' && /\/interactions\/[^/]+\/answer$/.test(path))
        network.answerPosts++;
      return network.original(input, init);
    };
    globalThis.fetch = Object.assign(observeFetch, network.original);
  });
  page = await until(
    async () => {
      for (const candidate of app!.windows()) {
        try {
          page = candidate;
          if (
            await candidate
              .getByRole('button', { name: 'Live permissions', exact: true })
              .and(candidate.locator('button.session-row'))
              .count()
          )
            return candidate;
        } catch {
          /* A transient startup window may have closed. */
        }
      }
      return undefined;
    },
    (value) => !!value,
    'ordinary main window and seeded session ready',
  );
  assert.ok(page);
  page.setDefaultTimeout(20000);
  stage = 'trust';
  await page
    .getByRole('button', { name: 'Live permissions', exact: true })
    .and(page.locator('button.session-row'))
    .click();
  const confirm = page.getByRole('button', { name: '确认项目读取范围', exact: true });
  await confirm.click();
  await page.getByRole('checkbox', { name: '我已核对所显示的项目及读取范围', exact: true }).check();
  await page.getByRole('button', { name: '允许读取所显示的范围', exact: true }).click();
  await confirm.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
  await until(
    state,
    (value) =>
      value.selection?.session.id === 'permission-root' &&
      !value.selection.viewLoading &&
      !!value.selection.permissions?.trust.trusted,
    'trusted root ready',
  );
  stage = 'full_and_start';
  await chooseMode('full');
  await page
    .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
    .fill('LIVE PERMISSIONS');
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  const holding = await until(facts, (value) => value.holding, 'both original Shell jobs held');
  checkpoints.holding = holding;
  const original = actors(holding);
  assert.equal(original.main.sessionId, 'permission-root');
  assert.notEqual(original.child.sessionId, original.main.sessionId);
  assert.ok(original.child.carrierId);
  assert.equal(holding.childCount, 1);
  for (const role of roles) {
    const actor = original[role];
    assert.equal(actor.shell.dispatched, true);
    assert.ok(['dispatching', 'running'].includes(actor.shell.status));
    assert.equal(actor.shell.jobState, 'running');
    assert.ok(actor.shell.jobId);
    assert.equal(actor.shell.cancelRequestedAt, null);
    assert.equal(actor.markerContent, livePermissionExpected[role].holdingMarker);
    assert.equal(actor.effectExists, false);
  }
  await visibleMode('full');
  rememberOwnedProcesses();
  await screenshot('01-full-held');

  stage = 'tighten_held';
  const tightened = await chooseMode('accept_edits');
  checkpoints.tightened = tightened;
  const tightenedActors = sameActors(tightened, original);
  assert.equal(tightened.holding, true);
  for (const role of roles) {
    assert.equal(tightenedActors[role].shell.jobState, 'running');
    assert.equal(tightenedActors[role].markerContent, livePermissionExpected[role].holdingMarker);
    assert.equal(tightenedActors[role].effectExists, false);
  }
  await screenshot('02-accept-edits-held');

  stage = 'independent_http_auto_held';
  const heldAutoHttp = await setModeViaIndependentHttp(tightened.storeId, 'auto');
  const heldAutoAcknowledgedAt = performance.now();
  // An independent public mutation must update the still-visible composer itself.
  await visibleMode('auto');
  const heldAutoAckToVisibleMs = performance.now() - heldAutoAcknowledgedAt;
  const autoHeld = await until(
    facts,
    (value) => value.holding && value.mode.mode === 'auto',
    'independent Auto while both Shell jobs remain held',
  );
  checkpoints.autoHeld = autoHeld;
  assert.equal(autoHeld.mode.revision, heldAutoHttp.revision);
  const autoHeldActors = sameActors(autoHeld, original);
  for (const role of roles) {
    assert.equal(autoHeldActors[role].shell.jobState, 'running');
    assert.equal(autoHeldActors[role].markerContent, livePermissionExpected[role].holdingMarker);
    assert.equal(autoHeldActors[role].effectExists, false);
    assert.deepEqual(autoHeldActors[role].target, original[role].target);
  }
  await screenshot('02b-independent-auto-held-visible');
  stage = 'restore_accept_held';
  const acceptHeld = await chooseMode('accept_edits');
  checkpoints.acceptHeldBeforeRelease = acceptHeld;
  const acceptHeldActors = sameActors(acceptHeld, original);
  assert.equal(acceptHeld.holding, true);
  for (const role of roles) {
    assert.equal(acceptHeldActors[role].shell.jobState, 'running');
    assert.equal(acceptHeldActors[role].markerContent, livePermissionExpected[role].holdingMarker);
    assert.equal(acceptHeldActors[role].effectExists, false);
    assert.deepEqual(acceptHeldActors[role].target, original[role].target);
  }
  assert.equal((await fetch(`${control}/release`)).status, 200);
  stage = 'accept_pending';
  const pending = await until(
    facts,
    (value) => value.pending && value.mode.mode === 'accept_edits',
    'both exact external writes pending',
  );
  checkpoints.acceptPending = pending;
  const acceptedActors = sameActors(pending, original);
  const initialCards = {} as Record<(typeof roles)[number], string>;
  const targets = {} as Record<(typeof roles)[number], string>;
  for (const role of roles) {
    const actor = acceptedActors[role];
    assert.ok(actor.target);
    targets[role] = actor.target.id;
    assert.equal(actor.target.status, 'planned');
    assert.equal(actor.target.dispatched, false);
    assert.equal(actor.markerContent, livePermissionExpected[role].marker);
    assert.equal(actor.effectExists, false);
    const card = actor.cards.find((item) => item.state === 'pending');
    assert.ok(card);
    assert.equal(card.answer, null);
    initialCards[role] = card.id;
  }
  await until(
    async () => ({
      permissions: await page!.locator('[data-permission-trigger]').count(),
      draft: await page!.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).count(),
    }),
    (value) => value.permissions === 1 && value.draft === 1,
    'pending root approval keeps composer and permission controls visible',
  );
  await assertApprovalGroup(initialCards);
  await screenshot('03-root-accept-pending');
  await openChild(original.child.carrierId!);
  await screenshot('04-child-accept-pending');
  await returnFromChild();

  stage = 'auto_rejudge';
  const pendingAutoUi = await chooseMode('auto');
  const reviewed = await until(
    facts,
    (value) => {
      if (!value.pending || value.mode.mode !== 'auto' || value.reviews !== 2) return false;
      return roles.every((role) => {
        const actor = value.actors[role];
        return (
          actor?.cards.some(
            (card) =>
              card.id === initialCards[role] && card.state === 'cancelled' && card.answer === null,
          ) &&
          actor.cards.some((card) => card.id !== initialCards[role] && card.state === 'pending')
        );
      });
    },
    'Auto independently reviewed both original targets',
  );
  checkpoints.autoPending = reviewed;
  assert.equal(reviewed.mode.revision, pendingAutoUi.mode.revision);
  const reviewedActors = sameActors(reviewed, original);
  const autoCards = {} as Record<(typeof roles)[number], string>;
  for (const role of roles) {
    const actor = reviewedActors[role];
    assert.equal(actor.target?.id, targets[role]);
    assert.equal(actor.target?.dispatched, false);
    assert.equal(actor.effectExists, false);
    const card = actor.cards.find((item) => item.state === 'pending')!;
    autoCards[role] = card.id;
    assert.equal(card.answer, null);
  }
  await assertApprovalGroup(autoCards);
  await screenshot('05-root-auto-pending');

  stage = 'independent_http_full';
  const external = await setModeViaIndependentHttp(reviewed.storeId, 'full');
  await visibleMode('full');
  stage = 'terminal';
  const terminal = await until(
    facts,
    (value) => value.terminal && value.mode.mode === 'full',
    'original tools completed under latest root mode',
  );
  checkpoints.terminal = terminal;
  const finalActors = sameActors(terminal, original);
  assert.equal(terminal.mode.revision, external.revision);
  assert.equal(terminal.childCount, 1);
  assert.equal(terminal.answerPosts, 0);
  assert.equal(external.answerPosts, 0);
  assert.equal(terminal.reviews, 2);
  for (const role of roles) {
    const actor = finalActors[role];
    assert.ok(actor.target);
    assert.equal(actor.target?.id, targets[role]);
    assert.equal(actor.target.status, 'succeeded');
    assert.equal(actor.target.dispatched, true);
    assert.equal(actor.target.attempt, 1);
    assert.ok(actor.target.controlRevisions.includes(terminal.mode.revision));
    assert.equal(actor.effectExists, true);
    assert.equal(actor.effectContent, livePermissionExpected[role].effect);
    for (const id of [initialCards[role], autoCards[role]]) {
      const card = actor.cards.find((item) => item.id === id);
      assert.ok(card);
      assert.equal(card?.state, 'cancelled');
      assert.equal(card.answer, null);
      const approve = page
        .getByRole('article', { name: `approval ${id}`, exact: true })
        .getByRole('button', { name: '批准一次', exact: true });
      await until(
        async () => ({
          visible: await approve.isVisible(),
          enabled: (await approve.isVisible()) && (await approve.isEnabled()),
        }),
        (value) => !value.visible || !value.enabled,
        'old card cannot answer',
      );
    }
  }
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).waitFor();
  await visibleMode('full');
  await screenshot('06-independent-http-full-input-restored');
  await openChild(original.child.carrierId!, true);
  await screenshot('07-child-terminal');
  await returnFromChild();
  await visibleMode('full');
  await screenshot('08-root-terminal');
  const network = await app.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & { livePermissionNetwork?: MainNetwork })
      .livePermissionNetwork;
    return { answerPosts: fixture?.answerPosts, capturedOriginalGet: !!fixture?.template };
  });
  assert.equal(network.answerPosts, 0);
  assert.equal(network.capturedOriginalGet, true);
  stage = 'queue_window';
  const queueEvidence = await verifyQueueWindow();
  const queueAnswerPosts = await app.evaluate(
    () =>
      (globalThis as typeof globalThis & { livePermissionNetwork?: MainNetwork })
        .livePermissionNetwork!.answerPosts,
  );
  assert.equal(queueAnswerPosts, 1, 'queue Shell has one explicit independent answer');
  const allJourneyFacts = await facts();
  stage = 'normal_shutdown';
  await close();
  writeFileSync(
    join(evidence, 'report.json'),
    JSON.stringify(
      {
        storeId: terminal.storeId,
        main: finalActors.main,
        child: finalActors.child,
        originalModeRevision: holding.mode.revision,
        tightenedModeRevision: pending.mode.revision,
        autoModeRevision: reviewed.mode.revision,
        finalModeRevision: terminal.mode.revision,
        independentHttpCaller: external,
        independentHttpAutoWhileHeld: heldAutoHttp,
        heldAutoAckToVisibleMs,
        approvalUiAutoWhilePending: {
          revision: pendingAutoUi.mode.revision,
          answerPosts: pendingAutoUi.answerPosts,
        },
        rendererVisibleModeSynchronized: true,
        childDetailRetainsRootSelection: true,
        childCount: terminal.childCount,
        calls: allJourneyFacts.calls,
        reviews: terminal.reviews,
        answerPosts: terminal.answerPosts,
        queueWindowVerified: true,
        queueAnswerPosts,
        queueEvidence,
        normalShutdown,
        electronExitCode,
        ownedDescendantPids: owned.map((row) => row.pid),
        checkpoints,
        checks: {
          productionDiagnosticsClosed: true,
          trustAndInitialModesViaProductionControls: true,
          dispatchedShellRangesUnchanged: true,
          acceptEditsBlockedBothNextExternalWrites: true,
          autoRejudgedOriginalTargets: true,
          oldCardsCancelledWithoutAnswers: true,
          independentHttpCallerSynchronizedVisibleMode: true,
          independentHttpWhileHeldSynchronizedVisibleMode: true,
          pendingRootApprovalKeepsComposerVisible: true,
          oneApprovalPanelWithTwoAccurateOwnerPages: true,
          compactApprovalHeightAndStableChildIcon: true,
          approvalTextTooltipAndNoDetails: true,
          latestRevisionDispatchedEachOriginalTargetOnce: true,
          childDetailRetainedRootSelection: true,
          normalElectronAndObservedDescendantsExited: normalShutdown,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      stage: 'live_native_permissions_complete',
      normalShutdown,
      answerPosts: 0,
      childCount: 1,
      reviews: 2,
    }),
  );
} catch (error) {
  const errorMessage = (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s<>"']+/g, '[redacted-url]')
    .replace(/Bearer\s+[^\s<>"']+/gi, 'Bearer [redacted]')
    .slice(0, 1200);
  writeFileSync(join(evidence, 'failure-stage.json'), JSON.stringify({ stage, errorMessage }), {
    mode: 0o600,
  });
  if (page) {
    try {
      await screenshot('failure');
      writeFileSync(join(evidence, 'failure-body.txt'), await page.locator('body').innerText(), {
        mode: 0o600,
      });
    } catch {
      /* A closed startup window has no readable body. */
    }
    try {
      const observed = await state();
      writeFileSync(
        join(evidence, 'failure-state.json'),
        JSON.stringify(
          {
            stage,
            storeId: observed.selection?.storeId,
            sessionId: observed.selection?.session.id,
            permission: observed.selection?.permissions?.mode,
            viewLoading: observed.selection?.viewLoading,
            permissionUnavailable: observed.selection?.permissionUnavailable,
            runs: observed.selection?.runs.map((run) => ({
              id: run.id,
              status: run.status,
              isActive: run.isActive,
            })),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      const body = (await page.locator('body').innerText()).replace(
        /https?:\/\/[^\s<>"']+/g,
        '[redacted-url]',
      );
      writeFileSync(join(evidence, 'failure-body.txt'), body, { mode: 0o600 });
      await screenshot('failure');
    } catch {
      /* Preserve the failure stage even if the window already exited. */
    }
  }
  throw Error(`live_native_permissions_failed:${stage}`);
} finally {
  await close();
}
