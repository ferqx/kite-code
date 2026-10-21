import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { NativeState } from '../src/native-bridge';

// This module is built as a private Node driver. It has no production startup hook.
const [candidate, home, control, receiptPath, desktopPackage] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const require = createRequire(desktopPackage);
const { _electron } = require('playwright') as typeof import('playwright');
type Facts = {
  approvals: { id: string; label: 'A' | 'B'; pending: boolean }[];
  originalMetadata: unknown[];
  followupInputUnresolved: boolean;
  delegationApproval: {
    id: string | null;
    agentId: string | null;
    pending: boolean;
    exactLineage: boolean;
    answered: boolean;
    dispatched: boolean;
  };
  followup: {
    id: string | null;
    pending: boolean;
    effectAbsent: boolean;
    effectExact: boolean;
    exactLineage: boolean;
    answered: boolean;
    dispatched: boolean;
  };
  twoChildren: boolean;
  exactLineage: boolean;
  rootWaiting: boolean;
  effectsAbsent: boolean;
  approvedEffect: boolean;
  deniedEffectAbsent: boolean;
  terminal: boolean;
  exactAnswers: boolean;
  exactDispatch: boolean;
  modeSelected: boolean;
  physicalRequests: number;
  footprint: {
    runs: number;
    executions: number;
    commands: number;
    sources: number;
    controls: number;
  };
};
const checks: Record<string, boolean | number> = {};
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let stage = 'launch';
const read = async () => (await (await fetch(`${control}/state`)).json()) as Facts;
async function until<T>(load: () => Promise<T>, predicate: (value: T) => boolean) {
  const end = Date.now() + 180000;
  for (;;) {
    const value = await load();
    if (predicate(value)) return value;
    assert.ok(Date.now() < end, `native_window_${stage}_not_reached`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function launch(cold = false) {
  stage = 'launch_process';
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 20000,
  });
  stage = 'launch_window';
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  stage = 'select_root';
  await page
    .getByRole('button', { name: 'Live collaboration', exact: true })
    .and(page.locator('button.session-row'))
    .click();
  stage = 'input_ready';
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).waitFor();
  stage = 'workspace_trust';
  const confirm = page.getByRole('button', { name: '确认项目读取范围', exact: true });
  const readiness = await until(
    async () => ({
      needsTrust: await confirm.isVisible(),
      state: await page.evaluate(
        async () =>
          (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
      ),
    }),
    (value) =>
      value.needsTrust ||
      (value.state.selection?.session.id === 'native-root' && !value.state.selection.viewLoading),
  );
  if (readiness.needsTrust) {
    assert.ok(!cold, 'native_window_cold_trust_changed');
    await confirm.click();
    await page
      .getByRole('checkbox', { name: '我已核对所显示的项目及读取范围', exact: true })
      .check();
    await page.getByRole('button', { name: '允许读取所显示的范围', exact: true }).click();
    await confirm.waitFor({ state: 'detached' });
    checks.workspaceTrustViaOrdinaryUI = true;
  }
  stage = 'history_ready';
  await until(
    async () =>
      page.evaluate(
        async () =>
          (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
      ),
    (value) => value.selection?.session.id === 'native-root' && !value.selection.viewLoading,
  );
  stage = 'diagnostics_closed';
  assert.equal(await page.getByRole('button', { name: '会话工具', exact: true }).count(), 0);
  checks.diagnosticsClosed = true;
  return page;
}
async function close() {
  if (!app) return;
  const owned = app;
  const ownedProcess = owned.process();
  const exit = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
  await owned.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await owned.evaluate(({ app: electron }) => electron.quit());
  await exit;
  assert.equal(ownedProcess.exitCode, 0);
  app = undefined;
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: join(home, `${name}.png`), fullPage: true });
}
try {
  let page = await launch();
  stage = 'permission_mode';
  await page.locator('[data-permission-trigger]').click();
  await page.getByRole('menuitemradio').nth(0).click();
  await until(read, (value) => value.modeSelected);
  checks.permissionModeViaOrdinaryUI = true;
  stage = 'send';
  const prompt = await (await fetch(`${control}/prompt`)).text();
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  stage = 'two_pending';
  const pending = await until(
    read,
    (value) =>
      value.twoChildren &&
      value.exactLineage &&
      value.rootWaiting &&
      value.approvals.length === 2 &&
      value.approvals.every((entry) => entry.pending),
  );
  assert.ok(pending.effectsAbsent);
  for (const card of pending.approvals) {
    const visible = page.getByRole('article', { name: `approval ${card.id}`, exact: true });
    await visible.waitFor();
    await visible
      .getByText(new RegExp(`external-${card.label}\\.txt`))
      .first()
      .waitFor();
  }
  assert.ok((await page.getByText('需要人工审批', { exact: true }).count()) >= 2);
  await screenshot(page, 'two-original-approvals');
  checks.twoExactChildCards = true;
  checks.exactTargetVisibleInEachCard = true;
  checks.parentWaitingAndApprovalVisible = true;
  checks.zeroEffectBeforeAnswer = true;
  const a = pending.approvals.find((entry) => entry.label === 'A')!;
  const b = pending.approvals.find((entry) => entry.label === 'B')!;
  assert.ok(a && b && a.id !== b.id);
  stage = 'approve_A';
  await page
    .getByRole('article', { name: `approval ${a.id}`, exact: true })
    .getByRole('button', { name: '仅批准这一次', exact: true })
    .click();
  await until(
    read,
    (value) =>
      value.approvedEffect &&
      value.deniedEffectAbsent &&
      value.approvals.some((entry) => entry.id === b.id && entry.pending),
  );
  checks.onlyApprovedEffectWhileSiblingPending = true;
  stage = 'deny_B';
  await page
    .getByRole('article', { name: `approval ${b.id}`, exact: true })
    .getByRole('button', { name: '拒绝', exact: true })
    .click();
  stage = 'terminal';
  const terminal = await until(read, (value) => value.terminal);
  assert.ok(terminal.approvedEffect && terminal.deniedEffectAbsent);
  assert.ok(terminal.exactAnswers && terminal.exactDispatch);
  await screenshot(page, 'terminal-effects');
  checks.canonicalAnswersAndDispatch = true;
  checks.allOriginalRunsAndCarriersTerminal = true;
  checks.approvedFileExactDeniedFileAbsent = true;
  stage = 'followup_session_switch';
  const originalMetadata = terminal.originalMetadata;
  const originalCards = [a, b].map((card) =>
    page.getByRole('article', { name: `approval ${card.id}`, exact: true }),
  );
  for (const card of originalCards) await card.waitFor({ state: 'detached' });
  await page
    .getByRole('button', { name: 'Switch target', exact: true })
    .and(page.locator('button.session-row'))
    .click();
  await until(
    async () =>
      page.evaluate(
        async () =>
          (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
      ),
    (value) => value.selection?.session.id === 'native-switch' && !value.selection.viewLoading,
  );
  await page
    .getByRole('button', { name: 'Live collaboration', exact: true })
    .and(page.locator('button.session-row'))
    .click();
  await until(
    async () =>
      page.evaluate(
        async () =>
          (await window.kiteNative!.request({ method: 'state', generation: 1 })) as NativeState,
      ),
    (value) => value.selection?.session.id === 'native-root' && !value.selection.viewLoading,
  );
  checks.ordinarySessionSwitchReturn = true;
  stage = 'followup_send';
  const followupPrompt = await (await fetch(`${control}/followup`)).text();
  assert.ok(followupPrompt.startsWith('Continue '));
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).fill(followupPrompt);
  await page.getByRole('button', { name: '发送明确的新轮次', exact: true }).click();
  stage = 'followup_delegation_pending';
  const delegation = await until(read, (value) => {
    assert.ok(!value.followupInputUnresolved, 'native_window_followup_input_unresolved');
    return value.delegationApproval.pending;
  });
  assert.ok(delegation.delegationApproval.exactLineage && delegation.followup.effectAbsent);
  assert.deepEqual(delegation.originalMetadata, originalMetadata);
  const delegationCard = page.getByRole('article', {
    name: `approval ${delegation.delegationApproval.id}`,
    exact: true,
  });
  await delegationCard.waitFor();
  await delegationCard.getByText('完整审批请求', { exact: true }).click();
  const completeRequest = delegationCard.locator('pre');
  await completeRequest.waitFor();
  const completeText = await completeRequest.innerText();
  assert.ok(completeText.includes('external-A-followup.txt'));
  assert.ok(
    delegation.delegationApproval.agentId &&
      completeText.includes(delegation.delegationApproval.agentId),
  );
  await screenshot(page, 'followup-delegation-approval');
  stage = 'followup_delegation_approve';
  await delegationCard.getByRole('button', { name: '仅批准这一次', exact: true }).click();
  const acceptedDelegation = await until(
    read,
    (value) => value.delegationApproval.answered && value.delegationApproval.dispatched,
  );
  assert.ok(acceptedDelegation.delegationApproval.exactLineage);
  checks.accurateFollowupDelegationApprovedViaOrdinaryUI = true;
  stage = 'followup_pending';
  const nextPending = await until(read, (value) => {
    assert.ok(!value.followupInputUnresolved, 'native_window_followup_input_unresolved');
    return value.followup.pending;
  });
  assert.ok(nextPending.followup.exactLineage && nextPending.followup.effectAbsent);
  assert.ok(nextPending.delegationApproval.answered && nextPending.delegationApproval.dispatched);
  assert.deepEqual(nextPending.originalMetadata, originalMetadata);
  const nextCard = page.getByRole('article', {
    name: `approval ${nextPending.followup.id}`,
    exact: true,
  });
  await nextCard.waitFor();
  await nextCard
    .getByText(/external-A-followup\.txt/)
    .first()
    .waitFor();
  for (const card of originalCards) assert.equal(await card.count(), 0);
  await screenshot(page, 'followup-independent-approval');
  checks.oldApprovalControlsDetached = true;
  checks.sameChildTwoAccurateRounds = true;
  stage = 'followup_approve';
  await nextCard.getByRole('button', { name: '仅批准这一次', exact: true }).click();
  const final = await until(
    read,
    (value) =>
      value.terminal &&
      value.followup.answered &&
      value.followup.dispatched &&
      value.followup.effectExact,
  );
  assert.deepEqual(final.originalMetadata, originalMetadata);
  assert.ok(
    final.approvedEffect && final.deniedEffectAbsent && final.exactAnswers && final.exactDispatch,
  );
  checks.originalMetadataUnchanged = true;
  checks.freshFollowupApprovalAndEffect = true;
  await screenshot(page, 'followup-terminal-effects');
  stage = 'cold_close';
  const before = final.physicalRequests;
  await close();
  checks.firstWindowCleanExit = true;
  stage = 'cold_launch';
  page = await launch(true);
  await page.getByRole('textbox', { name: '当前会话私有草稿', exact: true }).waitFor();
  const cold = await read();
  assert.ok(cold.terminal && cold.exactAnswers && cold.exactDispatch);
  assert.equal(cold.physicalRequests, before);
  assert.deepEqual(cold.footprint, final.footprint);
  assert.deepEqual(cold.originalMetadata, originalMetadata);
  assert.ok(cold.followup.answered && cold.followup.dispatched && cold.followup.effectExact);
  assert.ok(cold.delegationApproval.answered && cold.delegationApproval.dispatched);
  assert.ok(cold.approvedEffect && cold.deniedEffectAbsent);
  await screenshot(page, 'cold-original-history');
  checks.coldReopenNoModelReplay = true;
  checks.coldReopenNoBusinessOrSourceMutation = true;
  await close();
  checks.cleanWindowExit = true;
  writeFileSync(receiptPath, JSON.stringify({ passed: true, stage, checks }));
} catch (error) {
  if (app) {
    try {
      await app.windows()[0]!.screenshot({ path: join(home, 'failure.png'), fullPage: true });
    } catch {}
  }
  writeFileSync(
    receiptPath,
    JSON.stringify({
      passed: false,
      stage,
      checks,
      failureKind: error instanceof Error ? error.name : 'unknown',
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
