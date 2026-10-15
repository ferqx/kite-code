/**
 * PTY System Test — /rewind restores workspace files
 *
 * 端到端验证文件原像 + 回退链路：
 * End-to-end coverage of the file pre-image + rewind pipeline:
 *
 * 1. Turn 1: write_file 覆写 notes.md（V1 → V2）；turn 结束时 kernel 写入
 *    命名检查点 S1。
 * 2. Turn 2/3: write_file 继续覆写（V2 → V3 → V4）。
 * 3. 第一次 /rewind 恢复到 S2（V3）并创建新会话；新会话仍保留 S1。
 * 4. 新会话中再次 /rewind 恢复到 S1（V2），验证连续回退不会丢历史。
 *
 * 断言分两层：TUI 文本层（面板、恢复提示、prompt 恢复）与磁盘层
 * （直接读取 workspace 文件内容，证明回退真实发生）。
 * Two assertion layers: TUI text (panel, restore note, prompt recovery)
 * and disk (read the workspace file directly to prove the revert happened).
 *
 * NOTE: 默认交互模式为 accept-edits，工作区写入自动放行，无审批浮层。
 * Default interaction mode is accept-edits: workspace writes auto-approve.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand, submitUserMessage } from '../harness/input-helpers';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import {
  createTestWorkspace,
  observePersistedSessionIds,
  requirePersistedRuntimeReady,
} from '../harness/test-workspace';

const TIMEOUT = 30000;

const INITIAL_NOTES = 'v1 原始内容\n中间行\n';
const FIRST_NOTES_UPDATE = 'v2 第一次修改\n中间行\n';
const SECOND_NOTES_UPDATE = 'v3 第二次修改\n中间行\n';
const THIRD_NOTES_UPDATE = 'v4 第三次修改\n中间行\n';

describe('TUI PTY System — File Rewind', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      files: { 'notes.md': INITIAL_NOTES },
    });

    // Turn 1/2/3: overwrite notes.md V1 → V2 → V3 → V4, with a follow-up each turn.
    server.setResponses([
      {
        message: {
          content: 'I will update your notes.',
          tool_calls: [
            {
              id: 'call_rw1',
              name: 'write_file',
              args: { path: 'notes.md', content: FIRST_NOTES_UPDATE },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_rw1', contentIncludes: ['+v2 第一次修改'] }],
        },
        message: { content: 'Notes v2 done.' },
      },
      {
        message: {
          content: 'I will update your notes again.',
          tool_calls: [
            {
              id: 'call_rw2',
              name: 'write_file',
              args: { path: 'notes.md', content: SECOND_NOTES_UPDATE },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_rw2', contentIncludes: ['+v3 第二次修改'] }],
        },
        message: { content: 'Notes v3 done.' },
      },
      {
        message: {
          content: 'I will update your notes a third time.',
          tool_calls: [
            {
              id: 'call_rw3',
              name: 'write_file',
              args: { path: 'notes.md', content: THIRD_NOTES_UPDATE },
            },
          ],
        },
      },
      {
        expectedRequest: {
          toolResults: [{ toolCallId: 'call_rw3', contentIncludes: ['+v4 第三次修改'] }],
        },
        message: { content: 'Notes v4 done.' },
      },
    ]);

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  // ── Three turns build a rewind chain ──

  step(
    'three write_file turns land on disk and create checkpoints',
    async () => {
      await submitUserMessage(tui, server, 'Update my notes', { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), 'Notes v2 done.', 20000);

      await submitUserMessage(tui, server, 'Update my notes again', { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), 'Notes v3 done.', 20000);

      await submitUserMessage(tui, server, 'Update my notes a third time', { timeout: 15000 });
      await waitForText(() => tui.outputSinceLastAction(), 'Notes v4 done.', 20000);
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      // Disk holds the latest version after all three turns.
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(THIRD_NOTES_UPDATE);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  async function selectOriginalPoint(message: string) {
    // Locate the exact user boundary inside the actual directory, never the
    // same text in a historical user bubble. Each native key must be painted
    // before the next navigation decision; draining the terminal alone does
    // not prove that the application has consumed its stdin key.
    const selected = () =>
      stripAnsi(tui.viewport())
        .split('回退 · 检查点')
        .at(-1)!
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('❯ '));
    await waitForCondition(
      () => selected() !== undefined,
      'the original recovery directory has a selected row',
      5000,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = selected();
      if (before === `❯ ${message}`) return;
      tui.write('\x1b[B');
      await waitForCondition(
        () => selected() !== undefined && selected() !== before,
        'the original recovery directory paints its next explicit selection',
        5000,
      ).catch((error) => {
        console.error('Original boundary selection:', before, message, tui.viewport());
        throw error;
      });
    }
    expect(selected()).toBe(`❯ ${message}`);
  }

  async function continueConfirmedCode(expected: string, sessions: number) {
    await waitForText(() => tui.viewport(), '原恢复申请', 5000);
    // The actual restore Action has its own approval. Leaving this read-only
    // preview does not approve it or create the later fork.
    tui.write('a');
    await waitForText(() => tui.viewport(), 'builtin.files/files.checkpoint.restore', 5000);
    await waitForText(() => tui.viewport(), '允许一次', 5000);
    tui.write('\r');
    await waitForCondition(
      () => !screenContains(tui.viewport(), '工具授权'),
      'the original restore approval settles before reopening its saved result',
      5000,
    );
    await submitCommand(tui, '/rewind');
    await waitForText(() => tui.viewport(), 'L 查询所选原申请', 5000);
    tui.write('l');
    await waitForText(() => tui.viewport(), '原恢复申请', 5000);
    // R only reads the original result; the fork leg still requires C.
    await waitForCondition(
      () => {
        const frame = tui.viewport();
        if (
          screenContains(frame, '文件: succeeded') &&
          screenContains(frame, '会话: not_started') &&
          !screenContains(frame, '正在处理恢复申请')
        )
          return true;
        if (!screenContains(frame, '正在处理恢复申请')) tui.write('r');
        return false;
      },
      'actual code restoration succeeds before explicitly continuing the fork',
      5000,
      100,
    ).catch((error) => {
      console.error('Original recovery viewport:', tui.viewport());
      throw error;
    });
    expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(expected);
    expect(requirePersistedRuntimeReady(observePersistedSessionIds(workspace))).toHaveLength(
      sessions,
    );
    expect(server.getRequestCount()).toBe(6);
    tui.write('c');
    let continuationObserved = false;
    await waitForCondition(
      () => {
        const frame = tui.viewport();
        if (screenContains(frame, '已从检查点创建新会话，并恢复 1 个文件')) return true;
        if (
          screenContains(frame, '正在处理恢复申请') ||
          /会话: (pending|unknown|succeeded|failed)/u.test(frame)
        )
          continuationObserved = true;
        if (
          continuationObserved &&
          screenContains(frame, '原恢复申请') &&
          !screenContains(frame, '正在处理恢复申请')
        )
          tui.write('r');
        return false;
      },
      'the explicitly continued original fork and code proof produce a confirmed completion',
      5000,
      100,
    ).catch((error) => {
      console.error('Original completed recovery viewport:', tui.viewport());
      throw error;
    });
  }

  // ── First /rewind: latest actionable point restores V3 ──────

  step(
    '/rewind restores V3 and preserves the earlier recovery point',
    async () => {
      await submitCommand(tui, '/rewind');
      // 检查点面板以用户消息描述恢复边界，不暴露 event / snapshot ID。
      await waitForText(() => tui.viewport(), '回退', 15000);
      await waitForText(() => tui.viewport(), 'Enter 继续', 15000);

      await selectOriginalPoint('Update my notes a third time');
      // Enter reads the actual boundary; scope selection and submission are separate.
      tui.write('\r');
      await waitForText(() => tui.viewport(), '回退 · 恢复到此消息之前', 15000);
      await waitForText(() => tui.viewport(), '代码将恢复 +1 −1，涉及 notes.md', 15000);
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(THIRD_NOTES_UPDATE);
      expect(screenContains(tui.viewport(), '❯ 1. 会话与文件')).toBe(true);
      await waitForText(() => tui.viewport(), 'Enter 确认所选范围', 5000);
      tui.write('\r');

      await continueConfirmedCode(SECOND_NOTES_UPDATE, 1);

      // 恢复提示（LOCAL_TEXT）/ restore note
      await waitForText(
        () => tui.outputSinceLastAction(),
        '已从检查点创建新会话，并恢复 1 个文件',
        20000,
      );
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());

      // 磁盘层断言：文件回到 S2 时刻的 V3 / disk is back to V3 (state at S2)
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(SECOND_NOTES_UPDATE);

      // 会话恢复使用 fork：源会话和新会话都仍在 Runtime Store 中。
      expect(requirePersistedRuntimeReady(observePersistedSessionIds(workspace))).toHaveLength(2);

      // TUI recovers — prompt visible
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Second /rewind: forked session can continue to S1 ──────

  step(
    'the recovered session can rewind again to V2',
    async () => {
      await submitCommand(tui, '/rewind');
      await waitForText(() => tui.viewport(), '回退', 15000);
      await waitForText(() => tui.viewport(), 'Enter 继续', 15000);
      await selectOriginalPoint('Update my notes again');

      tui.write('\r');
      await waitForText(() => tui.viewport(), '回退 · 恢复到此消息之前', 15000);
      await waitForText(() => tui.viewport(), '代码将恢复 +1 −1，涉及 notes.md', 15000);
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(SECOND_NOTES_UPDATE);
      expect(screenContains(tui.viewport(), '❯ 1. 会话与文件')).toBe(true);
      await waitForText(() => tui.viewport(), 'Enter 确认所选范围', 5000);
      tui.write('\r');

      await continueConfirmedCode(FIRST_NOTES_UPDATE, 2);

      await waitForCondition(() => {
        const observed = observePersistedSessionIds(workspace);
        return observed.status === 'ready' && observed.value.length === 3;
      }, 'the second rewind target Session to become durable');
      await waitForText(
        () => tui.outputSinceLastAction(),
        '已从检查点创建新会话，并恢复 1 个文件',
        20000,
      );
      await waitForOutputQuiescence(() => tui.outputSinceLastAction());
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(FIRST_NOTES_UPDATE);

      expect(requirePersistedRuntimeReady(observePersistedSessionIds(workspace))).toHaveLength(3);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);
    },
    TIMEOUT,
  );
  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
