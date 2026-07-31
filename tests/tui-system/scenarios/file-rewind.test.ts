/**
 * PTY System Test — /rewind restores workspace files (ADR-0042 §4)
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
 *
 * IMPORTANT: Like other scenarios, this test requires a warmup phase
 * before the first model call.
 */

import { Database } from 'bun:sqlite';
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
const NOTES_V4 = 'v4 第三次修改\n中间行\n';

describe('TUI PTY System — File Rewind', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      files: { 'notes.md': NOTES_V1 },
    });

    // Turn 1/2/3: overwrite notes.md V1 → V2 → V3 → V4, with a follow-up each turn.
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
      {
        message: {
          content: 'I will update your notes a third time.',
          tool_calls: [
            { id: 'call_rw3', name: 'write_file', args: { path: 'notes.md', content: NOTES_V4 } },
          ],
        },
      },
      { message: { content: 'Notes v4 done.' } },
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

  // ── Three turns build a rewind chain ──

  test(
    'three write_file turns land on disk and create checkpoints',
    async () => {
      await typeText(tui, 'Update my notes');
      tui.write('\r');
      await waitForRequestMessage(server, 'Update my notes', 15000);
      await waitForText(() => tui.output(), 'Notes v2 done.', 20000);

      await typeText(tui, 'Update my notes again');
      tui.write('\r');
      await waitForRequestMessage(server, 'Update my notes again', 15000);
      await waitForText(() => tui.output(), 'Notes v3 done.', 20000);

      await typeText(tui, 'Update my notes a third time');
      tui.write('\r');
      await waitForRequestMessage(server, 'Update my notes a third time', 15000);
      await waitForText(() => tui.output(), 'Notes v4 done.', 20000);
      await sleep(500);

      // Disk holds the latest version after all three turns.
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(NOTES_V4);
      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── First /rewind: latest actionable point restores V3 ──────

  test(
    '/rewind restores V3 and preserves the earlier recovery point',
    async () => {
      await typeText(tui, '/rewind');
      tui.write('\r');
      // 检查点面板以用户消息描述恢复边界，不暴露 event / snapshot ID。
      await waitForText(() => tui.output(), '── 回退', 15000);
      await sleep(500);

      // Enter 只进入确认层；默认选择恢复代码和会话。
      tui.write('\r');
      await waitForText(() => tui.output(), '回退 · 恢复到此消息之前', 15000);
      await waitForText(() => tui.output(), '代码将恢复 +1 −1，涉及 notes.md', 15000);
      tui.write('\r');

      // 恢复提示（LOCAL_TEXT）/ restore note
      await waitForText(() => tui.output(), '已从检查点创建新会话，并恢复 1 个文件', 20000);
      await sleep(500);

      // 磁盘层断言：文件回到 S2 时刻的 V3 / disk is back to V3 (state at S2)
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(NOTES_V3);

      // 会话恢复使用 fork：源会话和新会话都仍在 Runtime Store 中。
      const runtimeDb = new Database(join(workspace.home, '.kite-code', 'checkpoints.runtime.db'), {
        readonly: true,
      });
      const sessionCount = runtimeDb
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get()?.count;
      runtimeDb.close();
      expect(sessionCount).toBe(2);

      // TUI recovers — prompt visible
      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );

  // ── Second /rewind: forked session can continue to S1 ──────

  test(
    'the recovered session can rewind again to V2',
    async () => {
      const panelOffset = tui.output().length;
      await typeText(tui, '/rewind');
      tui.write('\r');
      await waitForText(() => tui.output().slice(panelOffset), '── 回退', 15000);

      tui.write('\r');
      await waitForText(() => tui.output().slice(panelOffset), '回退 · 恢复到此消息之前', 15000);
      await waitForText(
        () => tui.output().slice(panelOffset),
        '代码将恢复 +1 −1，涉及 notes.md',
        15000,
      );
      const restoreOffset = tui.output().length;
      tui.write('\r');

      await waitForText(
        () => tui.output().slice(restoreOffset),
        '已从检查点创建新会话，并恢复 1 个文件',
        20000,
      );
      expect(readFileSync(join(workspace.workspace, 'notes.md'), 'utf8')).toBe(NOTES_V2);

      const runtimeDb = new Database(join(workspace.home, '.kite-code', 'checkpoints.runtime.db'), {
        readonly: true,
      });
      const sessionCount = runtimeDb
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get()?.count;
      runtimeDb.close();
      expect(sessionCount).toBe(3);
      expect(screenContains(tui.output(), '❯')).toBe(true);
    },
    TIMEOUT,
  );
});
