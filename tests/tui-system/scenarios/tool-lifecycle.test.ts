/**
 * PTY System Test — 工具全生命周期 / Tool Full Lifecycle
 *
 * 每种工具类型一个综合性测试，覆盖完整交互链路：
 * 1. 中断状态正确显示（options / 审批选项 / plan review 操作条）
 * 2. 消息渲染顺序正确（model text → tool_card → interrupt）
 * 3. 用户确认后工具状态更新
 * 4. 无重复中断弹框（resume 重放去重验证）
 * 5. 交互完成后模型继续运行
 *
 * One comprehensive test per tool type, covering the full interaction:
 * 1. Interrupt block renders correctly
 * 2. Correct rendering order (model text → tool_card → interrupt)
 * 3. Tool status updates after user confirmation
 * 4. No duplicate interrupt blocks (resume replay dedup)
 * 5. Model continues after interaction completes
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import {
  assertOrder,
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForText,
} from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedTurnEvents,
  readPersistedPlanArtifacts,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const TIMEOUT = 45000;

// ────────────────────────────────────────────────────────────────
// ask_user 全生命周期 / ask_user full lifecycle
// ────────────────────────────────────────────────────────────────

describe('TUI PTY System — Tool Lifecycle: ask_user', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        message: {
          content: 'Let me ask you something.',
          tool_calls: [
            {
              id: 'call_ask',
              name: 'ask_user',
              args: {
                questions: [
                  {
                    question: 'What is your favorite color?',
                    options: [
                      {
                        label: 'Blue',
                        description: 'Choose a calm primary color.',
                        recommended: true,
                      },
                      {
                        label: 'Red',
                        description: 'Choose a warm primary color.',
                        recommended: false,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_ask', contentIncludes: ['Blue'] }],
        },
        message: { content: 'Got it! Your favorite color is blue.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'full lifecycle: interrupt → confirm → no duplicate, model continues',
    async () => {
      // ── 1. 触发 ask_user / Trigger ask_user ──
      await submitUserMessage(tui, server, 'Ask me a question', { timeout: 15000 });

      // The question text may first appear in the started ask_user Tool Card.
      // Wait for the last option that proves the interactive footer is complete.
      await waitForText(() => tui.viewport(), 'Red', 15000);

      // ── 2. 验证中断显示 / Verify interrupt display ──
      let output = tui.viewport();
      expect(screenContains(output, 'What is your favorite color?')).toBe(true);
      expect(screenContains(output, 'Blue')).toBe(true);
      expect(screenContains(output, 'Red')).toBe(true);

      // ── 3. 验证渲染顺序：模型文字在问题选项之前 / Verify order: text before question ──
      const order = assertOrder(output, 'Let me ask you something', 'What is your favorite color?');
      expect(order.pass).toBe(true);

      // ── 4. 确认：按 Enter 接受默认选项 / Confirm: Enter to accept default ──
      tui.write('\r');
      await waitForText(() => tui.outputSinceLastAction(), 'Got it!', 15000);

      output = tui.viewport();

      // ── 5. 验证模型继续运行（有重复中断就会卡住）/ Verify model continues (duplicate interrupt would block) ──
      expect(screenContains(output, 'Got it!')).toBe(true);
      // TUI prompt 恢复 / TUI recovered
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});

// ────────────────────────────────────────────────────────────────
// write_plan 渲染 / write_plan rendering
// ────────────────────────────────────────────────────────────────
// The full write_plan → review → approve → complete flow is exercised below.
// The request-aware mock resolver binds submit to the real draft_saved
// Artifact identity instead of predicting the generated plan ID.

describe('TUI PTY System — Tool Lifecycle: write_plan', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        message: {
          content: 'Let me draft a plan for you.',
          tool_calls: [
            {
              id: 'call_write',
              name: 'write_plan',
              args: {
                title: 'Lifecycle Test Plan',
                body_markdown: 'Verify plan lifecycle rendering in the TUI.',
                steps: [
                  { id: 'step-1', title: 'Step 1: Do something' },
                  { id: 'step-2', title: 'Step 2: Verify' },
                ],
              },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_write', contentIncludes: ['draft_saved'] }],
        },
        message: { content: 'Draft saved! Ready for review.' },
      },
      {
        response(request) {
          const result = request.messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'call_write',
          );
          const { plan_id, version, structural_digest } = parseDraftSavedPlan(result?.content);
          return {
            expectedRequest: {
              toolResults: [{ toolCallId: 'call_write', contentIncludes: ['draft_saved'] }],
            },
            message: {
              tool_calls: [
                {
                  id: 'call_submit',
                  name: 'write_plan',
                  args: { action: 'submit', plan_id, version, structural_digest },
                },
              ],
            },
          };
        },
      },
      {
        response(request) {
          const result = request.messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'call_submit',
          );
          const plan = JSON.parse(String(result?.content)) as { plan_id: string };
          return {
            expectedRequest: {
              toolResults: [
                { toolCallId: 'call_submit', contentIncludes: ['"status":"approved"'] },
              ],
            },
            message: {
              tool_calls: [
                {
                  id: 'call_complete',
                  name: 'update_plan',
                  args: {
                    plan_id: plan.plan_id,
                    updates: [
                      { step_id: 'step-1', status: 'completed' },
                      { step_id: 'step-2', status: 'completed' },
                    ],
                    complete_plan: true,
                  },
                },
              ],
            },
          };
        },
      },
      {
        expectedRequest: {
          toolResults: [
            { toolCallId: 'call_complete', contentIncludes: ['"plan_completed":true'] },
          ],
        },
        message: { content: 'Lifecycle plan completed.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'write_plan renders plan content in planning phase',
    async () => {
      // Enter planning phase
      await submitCommand(tui, '/plan');
      await waitForText(() => tui.viewport(), 'Shift+Tab to exit', 15000);
      await waitForTuiReady(tui);
      await submitUserMessage(tui, server, 'Draft a lifecycle plan', { timeout: 15000 });

      // Wait for follow-up text
      await waitForText(() => tui.outputSinceLastAction(), 'Draft saved', 15000);
      await waitForText(() => tui.viewport(), '方案审核', 15_000);
      tui.write('\r');
      await waitForText(() => tui.viewport(), 'Lifecycle plan completed.', 15_000);
      await assertCompletedPlanTurn(workspace, 'Draft a lifecycle plan');

      const output = tui.viewport();
      const clean = stripAnsi(output);
      console.log('  output after write_plan:', clean.slice(-2000));

      // Plan content visible
      expect(clean.includes('Lifecycle Test Plan')).toBe(true);

      const artifacts = readPersistedPlanArtifacts(workspace);
      expect(artifacts).toHaveLength(1);
      expect(basename(artifacts[0]!.path)).toBe('v1.md');
      expect(artifacts[0]!.content).toContain('# Lifecycle Test Plan');
      expect(artifacts[0]!.content).toContain('Verify plan lifecycle rendering in the TUI.');
      expect(artifacts[0]!.content).toContain('"id":"step-1"');
      expect(artifacts[0]!.content).toContain('"title":"Step 2: Verify"');

      // No plan_review interrupt (write_plan does NOT trigger review)
      expect(clean.includes('Review the plan above')).toBe(false);

      // TUI back to idle
      expect(clean.includes('❯')).toBe(true);
    },
    TIMEOUT,
  );
});

function parseDraftSavedPlan(content: unknown): {
  plan_id: string;
  version: number;
  structural_digest: string;
} {
  const value: unknown = JSON.parse(String(content));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('plan_id' in value) ||
    typeof value.plan_id !== 'string' ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !('structural_digest' in value) ||
    typeof value.structural_digest !== 'string'
  ) {
    throw new Error('write_plan draft_saved result did not contain a valid plan identity');
  }
  return {
    plan_id: value.plan_id,
    version: value.version,
    structural_digest: value.structural_digest,
  };
}

async function assertCompletedPlanTurn(
  workspace: ReturnType<typeof createTestWorkspace>,
  userMessage: string,
): Promise<void> {
  await waitForCondition(
    () => {
      const observation = observePersistedTurnEvents(workspace, userMessage);
      if (observation.status !== 'ready' || !observation.value) return false;
      return observation.value.events.some((event) => event.type === 'turn.completed');
    },
    `durable completion for ${userMessage}`,
    10_000,
  );
  const observed = requirePersistedRuntimeReady(observePersistedTurnEvents(workspace, userMessage));
  expect(observed).toBeDefined();
  const events = observed!.events;
  const blocked = events.filter((event) => event.type === 'completion.blocked');
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toMatchObject({
    code: 'plan_draft_pending',
    planning: 'planning_draft',
    correctionAttempt: 1,
  });
  const blockerIndex = events.indexOf(blocked[0]!);
  const continuationIndex = events.findIndex(
    (event, index) => index > blockerIndex && event.type === 'model.requested',
  );
  const runCompletedIndex = events.findIndex((event) => event.type === 'run.completed');
  const turnCompletedIndex = events.findIndex((event) => event.type === 'turn.completed');
  expect(continuationIndex).toBeGreaterThan(blockerIndex);
  expect(runCompletedIndex).toBeGreaterThan(continuationIndex);
  expect(turnCompletedIndex).toBeGreaterThan(runCompletedIndex);
}

// ────────────────────────────────────────────────────────────────
// approval 全生命周期 / approval full lifecycle
// ────────────────────────────────────────────────────────────────

describe('TUI PTY System — Tool Lifecycle: approval', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    server.setResponses([
      {
        toolContinuation: 'aborted',
        message: {
          content: 'I will run a command.',
          tool_calls: [
            {
              id: 'call_shell',
              name: 'shell_execute',
              args: { command: 'node -e "1+1"', description: 'test lifecycle approval' },
            },
          ],
        },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'full lifecycle: interrupt → deny → current turn stops without model continuation',
    async () => {
      // ── 1. 触发审批 / Trigger approval ──
      await submitUserMessage(tui, server, 'Make a directory', { timeout: 15000 });

      // Wait for the complete interactive modal, not merely its first
      // incrementally rendered option, before inspecting it or sending input.
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return (
            screenContains(viewport, '工具授权') &&
            screenContains(viewport, '❯ 允许一次') &&
            screenContains(viewport, '本次会话允许') &&
            screenContains(viewport, '拒绝') &&
            screenContains(viewport, '↑↓ 导航  Enter 确认  Esc 取消')
          );
        },
        'complete approval modal to become interactive',
        15000,
      );

      // ── 2. 验证中断显示 / Verify interrupt display ──
      let output = tui.viewport();
      expect(screenContains(output, '工具授权')).toBe(true);
      expect(screenContains(output, '允许一次')).toBe(true);
      expect(screenContains(output, '拒绝')).toBe(true);
      expect(screenContains(output, '[接受编辑]')).toBe(false);

      // ── 3. 验证渲染顺序：模型文字在审批块之前 / Verify order: text before approval ──
      const order = assertOrder(output, 'I will run a command', '工具授权');
      expect(order.pass).toBe(true);

      // ── 4. 拒绝：导航到 Deny 确认 / Deny: navigate to Deny and confirm ──
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 本次会话允许', 5000);
      tui.write('\x1b[B');
      await waitForText(() => tui.viewport(), '❯ 拒绝', 5000);
      const rejectionFrames = tui.markScreen();
      tui.write('\r');
      await waitForTuiReady(tui);

      output = tui.viewport();
      const afterRejection = tui.screenFramesSince(rejectionFrames).join('\n');
      console.log('  output after approval rejection:', stripAnsi(afterRejection).slice(-2000));

      // ── 5. 用户拒绝审批会中止当前 turn，不再执行工具或调用模型 ──
      // Rejecting approval aborts the current turn without executing the tool
      // or asking the model for a continuation.
      expect(screenContains(afterRejection, '工具授权')).toBe(false);
      expect(screenContains(afterRejection, 'UNEXPECTED_MODEL_CONTINUATION_AFTER_REJECTION')).toBe(
        false,
      );
      // The rejected tool call remains in the message list as a settled fact.
      expect(screenContains(afterRejection, 'node -e "1+1"')).toBe(true);
      expect(screenContains(afterRejection, 'Tool approval rejected by user.')).toBe(true);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );
});

// ────────────────────────────────────────────────────────────────
// 自动放行工具 / Auto-approved tool (no interrupt)
// ────────────────────────────────────────────────────────────────

describe('TUI PTY System — Tool Lifecycle: auto-approved', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({ files: { 'fixture.ts': 'export const marker = true;\n' } });
    server.setResponses([
      {
        message: {
          content: 'Let me search for files.',
          tool_calls: [{ id: 'call_search', name: 'search_files', args: { pattern: '*.ts' } }],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_search', contentIncludes: ['fixture.ts'] }],
        },
        message: { content: 'Search complete.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'full lifecycle: no interrupt, tool auto-executes, model continues',
    async () => {
      // ── 1. 触发自动放行工具 / Trigger auto-approved tool ──
      await submitUserMessage(tui, server, 'Search for ts files', { timeout: 15000 });

      // 等工具执行完成 + 模型继续 / Wait for tool + model continuation
      await waitForText(() => tui.outputSinceLastAction(), 'Search complete', 15000);

      const output = tui.viewport();

      // ── 2. 验证无审批块出现 / Verify no approval block ──
      expect(screenContains(output, '工具授权')).toBe(false);

      // ── 3. 验证渲染顺序：模型文字在工具之前 / Verify order: text before tool ──
      const order = assertOrder(output, 'Let me search for files', 'Search complete');
      expect(order.pass).toBe(true);

      // ── 4. 验证正常恢复 / Verify normal recovery ──
      expect(screenContains(output, '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
