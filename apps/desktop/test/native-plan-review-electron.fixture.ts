import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { NativeDraft, NativeState } from '../src/native-bridge';

type MainDraftEvent = {
  type: string;
  target: string;
  text: string;
  value?: string;
  disabled?: boolean;
  trusted: boolean;
  focused: boolean;
  draft: string | null;
  history: string;
  time: number;
};
type MainDraftProbe = {
  sessionId: string;
  expected: string;
  beforeSave?: { sessionId: string; history: string; enabled: boolean; value: string };
  lastRead?: NativeDraft | null;
  lastReadError?: string;
};
type DiagnosticWindow = typeof window & {
  planMainEvents: MainDraftEvent[];
  planMainProbe?: MainDraftProbe;
};

const [candidate, home, control, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const startedAt = performance.now();
const stage = (name: string, facts: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ stage: name, elapsedMs: Math.round(performance.now() - startedAt), ...facts }),
  );
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let childPid: number | undefined;
const cards: any[] = [],
  runs: any[] = [],
  management: any[] = [],
  filesApprovals: any[] = [];
try {
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
  const page = await app.firstWindow();
  stage('window_ready', { electronPid: app.process().pid });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => console.error('plan_renderer_error', error.message));
  await page.evaluate(() => {
    const target = window as DiagnosticWindow;
    target.planMainEvents = [];
    for (const type of ['input', 'change', 'click', 'submit'])
      document.addEventListener(
        type,
        (event) => {
          const element = event.target as HTMLElement;
          const form = element.closest('form');
          if (!form?.textContent?.includes('当前会话私有草稿')) return;
          target.planMainEvents.push({
            type: event.type,
            target: element.tagName,
            text: (element.textContent ?? '').slice(0, 160),
            ...('value' in element ? { value: String(element.value) } : {}),
            ...('disabled' in element ? { disabled: Boolean(element.disabled) } : {}),
            trusted: event.isTrusted,
            focused: document.hasFocus(),
            draft: form.querySelector('textarea')?.value ?? null,
            history:
              Array.from(document.querySelectorAll('[role="status"]'))
                .map((value) => value.textContent ?? '')
                .find((value) => value.startsWith('历史')) ?? '',
            time: performance.now(),
          });
          if (target.planMainEvents.length > 16) target.planMainEvents.shift();
        },
        true,
      );
  });
  const state = () =>
    page.evaluate(
      async () =>
        (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
    );
  async function select(id: string) {
    await page.getByRole('button', { name: `Plan ${id.toUpperCase()}`, exact: true }).click();
    await page.getByRole('heading', { name: `Plan ${id.toUpperCase()}`, exact: true }).waitFor();
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
  }
  async function until<T>(
    read: () => Promise<T>,
    test: (value: T) => boolean,
    message: string,
  ): Promise<T> {
    const deadline = Date.now() + 15000;
    for (;;) {
      const value = await read();
      if (test(value)) return value;
      assert.ok(Date.now() < deadline, message);
      await page.waitForTimeout(20);
    }
  }
  await select('a');
  assert.equal((await state()).selection?.storeId, storeId);
  const children = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app!.process().pid &&
        parts.slice(2).join(' ') === join(candidate, 'terminal/runtime/bun'),
    );
  assert.equal(children.length, 1);
  childPid = Number(children[0]![0]);
  stage('owned_service_pid', { childPid });
  // Only observe outgoing original HTTP answers; preserve all responses and authority.
  await app.evaluate(() => {
    const target = globalThis as typeof globalThis & { planPosts: number };
    target.planPosts = 0;
    const original = target.fetch;
    target.fetch = Object.assign(
      (...args: Parameters<typeof original>) => {
        if (
          args[1]?.method === 'POST' &&
          /\/interactions\/[^/]+\/answer$/.test(new URL(String(args[0])).pathname)
        )
          target.planPosts++;
        return original(...args);
      },
      { preconnect: original.preconnect },
    );
  });
  const posts = () =>
    app!.evaluate(() => (globalThis as typeof globalThis & { planPosts: number }).planPosts);
  const metadata = (await (await fetch(`${control}/metadata`)).json()) as {
    feedback: string;
    bodyText: string;
  };
  // Establish Ask and trust using the actual permission form before any Model request.
  await page.getByRole('radio', { name: 'Ask', exact: true }).check();
  await page.getByRole('button', { name: '保存模式选择', exact: true }).click();
  await page.getByText('当前模式：ask；默认模式：auto', { exact: true }).waitFor();
  await page
    .getByRole('checkbox', { name: '我已核对所显示的工作区与读取范围', exact: true })
    .check();
  await page.getByRole('button', { name: '信任所显示的范围', exact: true }).click();
  await page.getByText(/^工作区：w；信任状态：trusted；版本：/).waitFor();
  async function approvePlanningManagement(expectedRunId?: string) {
    const current = await state();
    const card = current.selection!.interactions.find(
      (card) => card.kind === 'approval' && card.state === 'pending',
    );
    if (!card) return;
    const request = card.request as Record<string, any>;
    assert.ok(
      ['planning.write', 'planning.review', 'planning.update'].includes(request.definitionId),
      'only exact Planning management approvals may be handled here',
    );
    assert.equal(request.definitionVersion, '1');
    assert.equal(card.originStoreId, storeId);
    assert.equal(card.presentationSessionId, current.selection!.session.id);
    assert.equal(card.sessionId, current.selection!.session.id);
    const run = current.selection!.runs.find((run) => run.id === card.runId)!;
    assert.ok(run?.isActive);
    if (expectedRunId) assert.equal(card.runId, expectedRunId);
    assert.equal(
      await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).count(),
      0,
    );
    let completeHash: string | undefined;
    if (request.policy?.review) {
      const original = request.policy.review.reference;
      assert.equal(original.scope.kind, 'execution');
      assert.equal(original.scope.id, card.executionId);
      await page.getByRole('button', { name: 'Load complete attachment', exact: true }).click();
      await page.locator('[data-complete-attachment="verified"]').waitFor();
      const text = (await page.locator('[data-complete-attachment="verified"]').textContent())!;
      const bytes = Buffer.from(text);
      completeHash = createHash('sha256').update(bytes).digest('hex');
      assert.equal(String(bytes.length), original.size);
      assert.equal(completeHash, request.approvalRequestDigest);
      const complete = JSON.parse(text);
      assert.equal(complete.definitionId, request.definitionId);
      assert.equal(complete.definitionVersion, request.definitionVersion);
      if (request.definitionId === 'planning.write')
        assert.equal(complete.input.body, metadata.bodyText);
    }
    await page.getByRole('button', { name: 'Approve once', exact: true }).click();
    const accepted = await until(
      state,
      (value) =>
        value.interactionSubmissions.some(
          (row) => row.interaction.id === card.id && row.phase === 'accepted',
        ) &&
        !value.selection!.interactions.some((row) => row.id === card.id && row.state === 'pending'),
      'original management approval not accepted',
    );
    const submission = accepted.interactionSubmissions.find(
      (row) => row.interaction.id === card.id,
    )!;
    management.push({
      id: card.id,
      runId: card.runId,
      sessionId: card.presentationSessionId,
      executionId: card.executionId,
      definitionId: request.definitionId,
      request,
      completeHash,
      commandId: submission.intent.commandId,
    });
  }
  async function waitForPlan(expectedRunId?: string, excludedId?: string) {
    stage('plan_wait_enter', { expectedRunId, excludedId });
    const current = await until(
      async () => {
        const current = await state();
        if (
          current.selection!.interactions.some(
            (card) => card.kind === 'approval' && card.state === 'pending',
          )
        ) {
          await approvePlanningManagement(expectedRunId);
          return state();
        }
        return current;
      },
      (value) =>
        value.selection!.interactions.some(
          (card) =>
            card.kind === 'plan_review' && card.state === 'pending' && card.id !== excludedId,
        ),
      'exact original Plan review missing',
    );
    await page.getByRole('region', { name: 'Plan review', exact: true }).waitFor();
    stage('plan_wait_complete', {
      sessionId: current.selection!.session.id,
      interactions: current
        .selection!.interactions.filter(
          (card) => card.kind === 'plan_review' && card.state === 'pending',
        )
        .map((card) => ({ id: card.id, runId: card.runId, executionId: card.executionId })),
    });
    return current;
  }
  async function start(id: string, mainDraft: string) {
    stage('start_enter', { sessionId: id });
    await select(id);
    if (id !== 'a') {
      await page.getByRole('radio', { name: 'Ask', exact: true }).check();
      await page.getByRole('button', { name: '保存模式选择', exact: true }).click();
      await page.getByText('当前模式：ask；默认模式：auto', { exact: true }).waitFor();
    }
    if (id === 'b') {
      const parentCount = Number(await (await fetch(`${control}/count`)).text());
      await page
        .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
        .fill('NATIVE_PARENT_B hold original active Run');
      await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
      await until(
        async () => Number(await (await fetch(`${control}/count`)).text()),
        (n) => n === parentCount + 1,
        'original parent Model missing',
      );
      await until(
        state,
        (value) => value.selection!.runs.some((run) => run.isActive),
        'original active Run missing',
      );
    }
    await page.evaluate(
      ({ sessionId, expected }) => {
        const target = window as DiagnosticWindow;
        target.planMainEvents = [];
        target.planMainProbe = { sessionId, expected };
      },
      { sessionId: id, expected: mainDraft },
    );
    const count = Number(await (await fetch(`${control}/count`)).text());
    const input = page.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
    await input.fill(`NATIVE_PLAN_${id.toUpperCase()} exact original task`);
    await page.getByRole('checkbox', { name: '先审核计划', exact: true }).check();
    await page
      .getByRole('button', { name: id === 'b' ? '排队新的计划任务' : '发送计划任务', exact: true })
      .click();
    if (id === 'b') {
      await until(
        state,
        (value) =>
          value.callerSubmissions!.some(
            (row) => row.scope.sessionId === 'b' && row.request.kind === 'input.follow_up',
          ),
        'queued original Plan receipt missing',
      );
      assert.equal((await fetch(`${control}/continue?request=${count}`)).status, 200);
    }
    await until(
      async () => Number(await (await fetch(`${control}/count`)).text()),
      (value) => value === count + 1,
      'original Model request missing',
    );
    stage('initial_model_held', { sessionId: id, providerRequest: count + 1 });
    await input.fill(mainDraft);
    assert.equal(await input.inputValue(), mainDraft);
    await page
      .getByText('历史已完整读取至固定高水位；当前执行事实仍须核实。', { exact: true })
      .waitFor();
    const saveButton = page.getByRole('button', { name: '保留草稿', exact: true });
    await until(
      async () => !(await saveButton.isDisabled()),
      Boolean,
      'original Main save never became enabled',
    );
    assert.equal(await input.inputValue(), mainDraft);
    assert.equal((await state()).selection?.session.id, id);
    await page.evaluate(async () => {
      const target = window as DiagnosticWindow;
      const current = (await window.kiteNative!.request({
        method: 'state',
        generation: 1,
      })) as NativeState;
      const input = Array.from(document.querySelectorAll('textarea')).find((value) =>
        value.closest('label')?.textContent?.includes('当前会话私有草稿'),
      )!;
      const button = Array.from(input.closest('form')!.querySelectorAll('button')).find(
        (value) => value.textContent === '保留草稿',
      )!;
      target.planMainProbe!.beforeSave = {
        sessionId: current.selection!.session.id,
        history:
          Array.from(document.querySelectorAll('[role="status"]'))
            .map((value) => value.textContent ?? '')
            .find((value) => value.startsWith('历史')) ?? '',
        enabled: !button.disabled,
        value: input.value,
      };
    });
    await saveButton.click();
    assert.equal(
      await page.evaluate(
        () =>
          (window as DiagnosticWindow).planMainEvents.filter(
            (event) => event.type === 'click' && event.text === '保留草稿',
          ).length,
      ),
      1,
    );
    const savedMainDraft = await until(
      () =>
        page.evaluate(async (sessionId) => {
          const target = window as DiagnosticWindow;
          try {
            const value = (await window.kiteNative!.request({
              method: 'draft.read',
              generation: 1,
              sessionId,
            })) as NativeDraft | null;
            target.planMainProbe!.lastRead = value;
            target.planMainProbe!.lastReadError = undefined;
            return value;
          } catch (error) {
            target.planMainProbe!.lastReadError =
              error instanceof Error ? error.message : String(error);
            throw error;
          }
        }, id),
      (value) => value?.content === mainDraft,
      'Main draft not durably saved',
    );
    stage('main_draft_saved', {
      sessionId: id,
      revision: savedMainDraft!.revision,
      value: savedMainDraft!.content,
    });
    assert.equal((await fetch(`${control}/continue?request=${count + 1}`)).status, 200);
    const current = await waitForPlan();
    const card = current.selection!.interactions.find(
      (value) => value.kind === 'plan_review' && value.state === 'pending',
    )!;
    assert.ok(card);
    assert.equal(await input.count(), 0);
    assert.equal(await page.getByRole('button', { name: '保留草稿', exact: true }).count(), 0);
    assert.ok(
      (await page.getByRole('button', { name: /^取消原申请/ }).count()) > 0,
      'pending Plan must preserve its original task stop',
    );
    assert.equal(existsSync(join(home, 'workspace', `blocked-${id}-1.txt`)), false);
    stage('start_complete', {
      sessionId: id,
      runId: card.runId,
      interactionId: card.id,
      managementApprovals: management.length,
    });
    return card;
  }
  async function capture(card: any, decision?: string, mode?: string) {
    stage('capture_enter', {
      sessionId: card.presentationSessionId,
      runId: card.runId,
      interactionId: card.id,
      decision,
      mode,
    });
    const current = await until(
      state,
      (value) =>
        !decision ||
        value.interactionSubmissions.some(
          (row) => row.interaction.id === card.id && row.phase === 'accepted',
        ),
      'original answer receipt missing',
    );
    const submission = current.interactionSubmissions.find((row) => row.interaction.id === card.id);
    cards.push({
      id: card.id,
      runId: card.runId,
      executionId: card.executionId,
      sessionId: card.presentationSessionId,
      version: card.request.version,
      request: card.request,
      decision,
      mode,
      commandId: submission?.intent.commandId,
    });
    stage('capture_complete', {
      sessionId: card.presentationSessionId,
      runId: card.runId,
      interactionId: card.id,
      decision,
      mode,
      commandId: submission?.intent.commandId,
    });
  }
  async function done(id: string, runId: string, status: string, mainDraft: string) {
    stage('done_enter', { sessionId: id, runId, status });
    const current = await until(
      async () => {
        const current = await state();
        if (
          current.selection!.interactions.some(
            (card) => card.kind === 'approval' && card.state === 'pending',
          )
        ) {
          await approvePlanningManagement(runId);
          return state();
        }
        return current;
      },
      (value) => value.selection!.runs.some((run) => run.id === runId && run.status === status),
      'original Run terminal missing',
    );
    stage('original_run_terminal', { sessionId: id, runId, status });
    const submission = current.inputSubmissions.find(
      (row) =>
        row.sessionId === id && row.intent.kind === (id === 'b' ? 'input.follow_up' : 'run.start'),
    )!;
    runs.push({ sessionId: id, id: runId, status, commandId: submission.intent.commandId });
    await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).inputValue(),
      mainDraft,
    );
    stage('done_complete', {
      sessionId: id,
      runId,
      status,
      restoredMainDraft: await page
        .getByRole('textbox', { name: '当前会话私有草稿', exact: true })
        .inputValue(),
    });
  }
  async function toolApproval(id: string, runId: string) {
    await page.getByRole('button', { name: 'Approve once', exact: true }).waitFor();
    const current = await state();
    const approval = current.selection!.interactions.find(
      (card) => card.kind === 'approval' && card.state === 'pending',
    )!;
    assert.ok(approval);
    assert.equal(approval.runId, runId);
    assert.equal((approval.request as Record<string, unknown>).definitionId, 'files.write');
    assert.equal(existsSync(join(home, 'workspace', `effect-${id}.txt`)), false);
    // The exact Files approval is independent of the already saved Plan approval.
    assert.equal(
      await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: 'Approve once', exact: true }).click();
    const accepted = await until(
      state,
      (value) =>
        value.interactionSubmissions.some(
          (row) => row.interaction.id === approval.id && row.phase === 'accepted',
        ),
      'original Files approval not accepted',
    );
    const submission = accepted.interactionSubmissions.find(
      (row) => row.interaction.id === approval.id,
    )!;
    filesApprovals.push({
      id: approval.id,
      runId: approval.runId,
      sessionId: approval.presentationSessionId,
      executionId: approval.executionId,
      request: approval.request,
      commandId: submission.intent.commandId,
    });
  }
  const mainDraft = '  原 Main 草稿🙂\n空格必须恢复  ';
  const first: any = await start('a', mainDraft);
  const approve = page.getByRole('button', { name: 'Approve this exact plan', exact: true });
  assert.ok(first.request.policy.review.reference.size > 32768);
  assert.equal(first.request.policy.review.originStoreId, storeId);
  assert.equal(first.request.policy.review.executionId, first.executionId);
  assert.ok((await approve.count()) === 0 || (await approve.isDisabled()));
  const reviseBeforeRead = page.getByRole('button', { name: 'Request revision', exact: true });
  assert.ok((await reviseBeforeRead.count()) === 0 || (await reviseBeforeRead.isDisabled()));
  assert.equal(await posts(), management.length);
  await page.getByRole('button', { name: 'Load complete attachment', exact: true }).click();
  await page.getByLabel('完整计划正文', { exact: true }).waitFor();
  const completePlan = JSON.parse(
    (await page.locator('[data-complete-attachment="verified"]').textContent())!,
  );
  assert.equal(completePlan.body, metadata.bodyText);
  assert.equal(completePlan.planId, 'p-a');
  assert.equal(completePlan.version, 1);
  assert.equal(completePlan.digest, first.request.digest);
  assert.deepEqual(completePlan.steps, [
    { id: 'write', title: 'Write the approved file and verify its receipt' },
  ]);
  assert.match(
    await page.getByLabel('完整计划正文', { exact: true }).innerText(),
    /原完整正文尾部/,
  );
  assert.match(
    await page.getByLabel('计划步骤', { exact: true }).innerText(),
    /Write the approved file/,
  );
  await page
    .getByRole('combobox', { name: 'Plan review mode', exact: true })
    .selectOption('accept_edits');
  await page
    .getByRole('textbox', { name: 'Plan review feedback', exact: true })
    .fill(metadata.feedback);
  await select('b');
  assert.equal(await page.getByRole('region', { name: 'Plan review', exact: true }).count(), 0);
  await select('a');
  // Selection invalidates the original complete-read proof; explicitly read again.
  if (await page.getByRole('button', { name: 'Load complete attachment', exact: true }).count())
    await page.getByRole('button', { name: 'Load complete attachment', exact: true }).click();
  await page.getByLabel('完整计划正文', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('combobox', { name: 'Plan review mode', exact: true }).inputValue(),
    'accept_edits',
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Plan review feedback', exact: true }).inputValue(),
    metadata.feedback,
  );
  await page.getByRole('button', { name: 'Request revision', exact: true }).click();
  await capture(first, 'revise');
  const secondState = await waitForPlan(first.runId, first.id);
  const second = secondState.selection!.interactions.find(
    (card) => card.kind === 'plan_review' && card.state === 'pending',
  )!;
  assert.notEqual(second.id, first.id);
  assert.equal((second.request as any).version, '2');
  assert.equal(
    await page.getByRole('combobox', { name: 'Plan review mode', exact: true }).inputValue(),
    '',
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Plan review feedback', exact: true }).inputValue(),
    '',
  );
  assert.equal(await approve.isDisabled(), true);
  assert.equal(existsSync(join(home, 'workspace', 'blocked-a-2.txt')), false);
  assert.equal(existsSync(join(home, 'workspace', 'effect-a.txt')), false);
  assert.equal(await posts(), management.length + 1);
  await page.getByRole('combobox', { name: 'Plan review mode', exact: true }).selectOption('auto');
  await approve.click();
  await capture(second, 'approve', 'auto');
  await toolApproval('a', second.runId!);
  await done('a', second.runId!, 'completed', mainDraft);
  const bDraft = '  B 原草稿 雪🙂  ';
  const b = await start('b', bDraft);
  assert.equal(await approve.isDisabled(), true);
  await page
    .getByRole('combobox', { name: 'Plan review mode', exact: true })
    .selectOption('accept_edits');
  await approve.click();
  await capture(b, 'approve', 'accept_edits');
  await toolApproval('b', b.runId!);
  await done('b', b.runId!, 'completed', bDraft);
  const dDraft = '拒绝原 Main 草稿';
  const d = await start('d', dDraft);
  await page
    .getByRole('textbox', { name: 'Plan review feedback', exact: true })
    .fill('原拒绝理由 雪🙂');
  await page.getByRole('button', { name: 'Deny plan', exact: true }).click();
  await capture(d, 'deny');
  await done('d', d.runId!, 'failed', dDraft);
  assert.equal(existsSync(join(home, 'workspace', 'denied-effect.txt')), false);
  const cDraft = '取消原 Main 草稿';
  const c = await start('c', cDraft);
  await capture(c);
  const cCommand = (await state()).callerSubmissions!.find(
    (row) => row.scope.sessionId === 'c' && row.request.kind === 'run.start',
  )!.request.commandId;
  const cancelButton = page.getByRole('button', { name: `取消原申请 · ${cCommand}`, exact: true });
  const providerRequestsBeforeCancel = Number(await (await fetch(`${control}/count`)).text());
  stage('original_cancel_before_click', {
    sessionId: 'c',
    runId: c.runId,
    commandId: cCommand,
    text: await cancelButton.innerText(),
    enabled: !(await cancelButton.isDisabled()),
    history: await page.getByRole('status').allTextContents(),
    observedRuns: (await state()).selection?.runs.map((run) => ({
      id: run.id,
      status: run.status,
    })),
  });
  await cancelButton.click();
  stage('original_cancel_clicked', { sessionId: 'c', runId: c.runId, commandId: cCommand });
  const cancelState = await state();
  stage('original_cancel_observed', {
    sessionId: cancelState.selection?.session.id,
    runs: cancelState.selection?.runs.map((run) => ({ id: run.id, status: run.status })),
    cancellations: cancelState.inputSubmissions
      .filter((row) => row.intent.kind === 'command.cancel')
      .map((row) => ({ commandId: row.intent.commandId, phase: row.phase, command: row.command })),
  });
  await done('c', c.runId!, 'cancelled', cDraft);
  assert.equal(
    Number(await (await fetch(`${control}/count`)).text()),
    providerRequestsBeforeCancel,
  );
  assert.ok(management.some((row) => row.definitionId === 'planning.write'));
  assert.ok(management.some((row) => row.definitionId === 'planning.review'));
  assert.ok(management.some((row) => row.definitionId === 'planning.update'));
  assert.equal(filesApprovals.length, 2);
  const expectedPosts = management.length + 4 + filesApprovals.length; // Every actual management approval, four Plan answers, two independent Files Ask approvals.
  assert.equal(await posts(), expectedPosts);
  stage('all_ui_assertions_complete', {
    planDecisions: 4,
    managementApprovals: management.length,
    filesApprovals: filesApprovals.length,
    answerPosts: expectedPosts,
  });
  const owned = app;
  const exit = new Promise<void>((resolve) =>
    owned.process().once('exit', (code, signal) => {
      stage('electron_exit_event', { electronPid: owned.process().pid, childPid, code, signal });
      resolve();
    }),
  );
  stage(
    'quit_all_original_work_facts',
    (await (await fetch(`${control}/quit-facts`)).json()) as Record<string, unknown>,
  );
  const exitChoicePath = join(home, 'plan-review-exit-choice.json');
  // Test port for the production warning; this does not qualify the OS modal UI.
  await owned.evaluate(({ dialog, BrowserWindow }, path) => {
    const assert: typeof import('node:assert').strict =
      process.getBuiltinModule('node:assert').strict;
    const write = process.getBuiltinModule('node:fs')
      .writeFileSync as typeof import('node:fs').writeFileSync;
    const original = dialog.showMessageBox;
    const windows = BrowserWindow.getAllWindows();
    assert.equal(windows.length, 1);
    const originalWindow = windows[0]!;
    let calls = 0;
    dialog.showMessageBox = async (_window, options?: import('electron').MessageBoxOptions) => {
      calls += 1;
      assert.equal(calls, 1);
      assert.equal(_window, originalWindow);
      assert.ok(options, 'Production before-quit must supply its actual window and exact options');
      assert.deepEqual(options, {
        type: 'warning',
        message: '仍有活动工作，或尚不能完整核实。退出会停止本应用拥有的服务。',
        buttons: ['保留服务', '退出'],
        defaultId: 0,
        cancelId: 0,
      });
      dialog.showMessageBox = original;
      write(
        path,
        JSON.stringify({ calls, options, response: 1, via: 'one-shot-fixture-dialog-port' }),
      );
      return { response: 1, checkboxChecked: false };
    };
  }, exitChoicePath);
  stage('quit_requested', { electronPid: owned.process().pid, childPid });
  await owned.evaluate(({ app }) => app.quit());
  stage('quit_call_returned');
  await exit;
  stage('quit_completed', { childPid });
  app = undefined;
  assert.throws(() => process.kill(childPid!, 0));
  stage('owned_service_closed', { childPid });
  const exitChoice = JSON.parse(readFileSync(exitChoicePath, 'utf8'));
  assert.equal(exitChoice.calls, 1);
  assert.equal(exitChoice.response, 1);
  stage('explicit_exit_choice', exitChoice);
  assert.equal(
    Number(await (await fetch(`${control}/count`)).text()),
    providerRequestsBeforeCancel,
  );
  writeFileSync(
    join(home, 'plan-review-report.json'),
    JSON.stringify({
      cards,
      runs,
      management,
      filesApprovals,
      expectedPosts,
      childPid,
      exitChoice,
      providerRequestsBeforeCancel,
    }),
  );
  childPid = undefined;
  console.log(
    JSON.stringify({
      sourceFree: true,
      defaultService: true,
      planReviews: 4,
      independentToolApprovals: 2,
      managementApprovals: management.length,
      answerPosts: expectedPosts,
      completed: 2,
      deniedFailed: 1,
      explicitlyCancelled: 1,
    }),
  );
} catch (error) {
  if (app)
    try {
      const page = app.windows()[0]!;
      console.error(
        'plan_actual_failure',
        JSON.stringify({
          state: await page.evaluate(async () => {
            const state = (await window.kiteNative!.request({
              method: 'state',
              generation: 1,
            })) as NativeState;
            return {
              session: state.selection?.session.id,
              mainDraft: {
                events: (window as DiagnosticWindow).planMainEvents,
                probe: (window as DiagnosticWindow).planMainProbe,
                visibleValue: Array.from(document.querySelectorAll('textarea')).find((value) =>
                  value.closest('label')?.textContent?.includes('当前会话私有草稿'),
                )?.value,
              },
              runs: state.selection?.runs.map((run) => ({ id: run.id, status: run.status })),
              interactions: state.selection?.interactions.map((card) => ({
                id: card.id,
                kind: card.kind,
                state: card.state,
                executionId: card.executionId,
                runId: card.runId,
                revision: card.revision,
                request: card.request,
                answer: card.answer,
              })),
              executions: state.selection?.executions
                .filter((execution) => execution.kind === 'tool')
                .map((execution) => ({
                  id: execution.id,
                  runId: execution.runId,
                  definitionId: execution.definitionId,
                  status: execution.status,
                  result: execution.result,
                })),
              inputs: state.inputSubmissions.map((row) => ({
                commandId: row.intent.commandId,
                phase: row.phase,
              })),
            };
          }),
          visible: (await page.locator('body').innerText()).slice(-16000),
        }),
      );
      await page.screenshot({
        path: '/private/tmp/kite-native-plan-window-failure.png',
        fullPage: true,
      });
    } catch {}
  throw error;
} finally {
  if (childPid)
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
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
