/**
 * PTY System Test — /rewind restores workspace files (ADR-0042 §4)
 *
 * 端到端验证文件原像 + 回退链路：
 * End-to-end coverage of the file pre-image + rewind pipeline:
 *
 * 1. Turn 1: write_file 覆写 notes.md（V1 → V2）；turn 结束时 kernel 写入
 *    命名检查点 S1。
 * 2. Turn 2: write_file 再次覆写（V2 → V3）；写入前工具链记录原像 V2。
 * 3. /rewind 打开检查点面板（按创建时间倒序：[S2, S1]），↓ 选中 S1 并
 *    Enter 回退 → 工作区文件恢复为检查点时刻的 V2，会话截断到 S1。
 *
 * 断言分两层：TUI 文本层（面板、恢复提示、prompt 恢复）与磁盘层
 * （直接读取 workspace 文件内容，证明回退真实发生）。
 * Two assertion layers: TUI text (panel, restore note, prompt recovery)
 * and disk (read the workspace file directly to prove the revert happened).
 *
 * NOTE: 默认交互模式为 accept-edits，工作区写入自动放行，无审批浮层。
 * Default interaction mode is accept-edits: workspace writes auto-approve.
 *
 * IMPORTANT: Like other scenarios, this test requires a warmup phase
 * before the first model call.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockModelServer } from '../harness/fixtures';
import { sleep, typeText, waitForRequestMessage } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';
import { warmupInputPipeline } from '../harness/warmup';

const TIMEOUT = 30000;

const NOTES_V1 = 'v1 原始内容\n中间行\n';
const NOTES_V2 = 'v2 第一次修改\n中间行\n';
const NOTES_V3 = 'v3 第二次修改\n中间行\n';

describe('TUI PTY System — File Rewind', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      files: { 'notes.md': NOTES_V1 },
    });

    // Turn 1: overwrite notes.md V1 → V2, then follow up
    // Turn 2: overwrite notes.md V2 → V3, then follow up
    // Spares for potential extra requests (wrap-around is defensive)
    server.setResponses([
      {
        message: {
          content: 'I will update your notes.',
          tool_calls: [
            { id: 'call_rw1', name: 'write_file', args: { path: 'notes.md', content: NOTES_V2 } },
          ],
        },
      },
      { message: { content: 'Notes v2 done.' } },
      {
        message: {
          content: 'I will update your notes again.',
          tool_calls: [
            { id: 'call_rw2', name: 'write_file', args: { path: 'notes.md', content: NOTES_V3 } },
          ],
        },
      },
      { message: { content: 'Notes v3 done.' } },
      { message: { content: 'rewind spare 1' } },
      { message: { content: 'rewind spare 2' } },
      { message: { content: 'rewind spare 3' } },
    ]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });

    await waitForText(() => tui.output(), '❯', 15000);
    tui.setRawMode(true);
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  // ── Warmup ───────────────────────────────────────────────

  test(
    'warmup: input pipeline initialized',
    async () => {
      await warmupInputPipeline(tui, server);
    },
    TIMEOUT,
  );

  // ── Turn 1 + Turn 2: two overwrites build checkpoint history ──

  test(
    'two write_file turns land on disk and create checkpoints',
    async () => {
      await typeText(tui, 'Update my notes');
      tui.write('\r');
      await waitForRequestMessage(server, 'Update my notes', 15000);
      await waitForText(() => tui.output(), 'Notes v2 done.', 20000);

      await typeText(tui, 'Update my notes again');
      tui.write('\r');
      await waitForRequestMessage(server, 'Update my notes again', 15000);
      await waitForText(() => tui.output(), 'Notes v3 done.', 20000);
      await sleep(500);

      // Disk holds the latest version after both turns
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(NOTES_V3);
      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── /rewind: revert to the first checkpoint restores V2 ──────

  test(
    '/rewind revert to the first checkpoint restores the file on disk',
    async () => {
      await typeText(tui, '/rewind');
      tui.write('\r');
      // 检查点面板出现（含两个 turn 检查点）/ checkpoint panel with both turns
      await waitForText(() => tui.output(), '回退 — 选择检查点', 15000);
      await sleep(500);

      // 列表按创建时间倒序：[S2, S1]。↓ 选中 S1，Enter 回退。
      // List is DESC by creation: [S2, S1]. Down selects S1, Enter reverts.
      tui.write('\x1B[B');
      await sleep(300);
      tui.write('\r');

      // 恢复提示（LOCAL_TEXT）/ restore note
      await waitForText(() => tui.output(), '已恢复 1 个文件到检查点', 20000);
      await sleep(500);

      // 磁盘层断言：文件回到 S1 时刻的 V2 / disk is back to V2 (state at S1)
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(NOTES_V2);

      // TUI recovers — prompt visible
      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
