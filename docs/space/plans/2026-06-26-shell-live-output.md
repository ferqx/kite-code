# Shell 工具实时输出展示

状态：completed
创建：2026-06-26
实施：2026-06-26 ~ 2026-06-27

## 目标

Shell 工具执行期间，TUI 实时展示 stdout/stderr 输出（tail-follow 最近 5 行），完成后展示 exit code + 最新 5 行摘要 + 截断计数。取消时展示 `cancelled` 状态。

## 数据流

```
shell.ts: readWithProgress (reader.read 逐行流式)
  → onProgress 回调 → tool-runner.ts 透传
    → graph.ts: onShellProgress → toolProgressSink
      → runner.ts: provider.onEvent({ type: 'tool_progress' })
        → handleEvent.ts: 更新 liveOutput + liveTotalLines（tail-follow5）
          → ToolCardBlock.tsx: renderShellLines（SHELL_PREFIX + clip + 5 行）
```

## 关键设计决策（偏离原始方案的记录）

| 决策 | 设计原案 | 实际实现 | 原因 |
|------|---------|---------|------|
| 流式读取方式 | `tee()` 双副本并发 | `reader.read()` 顺序读取 | Bun `tee()` 在副本间有同步 bug；顺序读避免并发挂起 |
| 行截断策略 | 固定 200 字符 `slice(0,200)` | 按终端宽度 `clip(line, contentWidth)` | 防止长行换行破坏布局 |
| 摘要行选择 | running: tail-follow / done: 前 5 行 | 统一 tail-follow（`slice(-5)`） | 命令末尾信息最有价值 |
| 渲染函数 | `renderShellSummary` + `renderLiveShellOutput` 两个函数 | 合并为 `renderShellLines(text, color, maxLine, totalLines?)` | 消除 80% 重复代码 |
| React flush | 无条件 `setTimeout(0)` | `if (onShellProgress)` 守卫 | 非 shell 工具无进度事件，不需延迟 |
| fingerprint 缓存 | 仅 `status` | `status + liveOutput(头尾 8 字符 + 长度) + liveTotalLines` | `liveOutput` 频繁变化需触发重渲染 |
| 截断计数 | 从截断后 buffer 计算 | `liveTotalLines` 累积递增 | 原计算方式始终 ≤6，截断计数错误 |
| cancelled 检测 | `includes('cancelled')` 子串 | `startsWith('Command cancelled')` 或 `includes('"cancelled":true')` | 避免 shell 输出含 "cancelled" 时的误判 |
| 行数常量 | `LIVE_MAX_LINES` + `MAX_TOOL_LINES` 两处重复 | `MAX_TOOL_LINES` 导出，reducer 引用 | 统一为单一真相源 |

## 新增/变更文件

| 文件 | 改动 |
|------|------|
| `src/protocol/events.ts` | 新增 `tool_progress` 事件 + `ToolProgressPayload` |
| `src/core/types.ts` | `ShellInput` 加 `onProgress` 回调 |
| `src/core/tools/shell.ts` | 新增 `readWithProgress`（reader.read + decoder flush + lock release）；`shellTool` 双路径（有/无 onProgress） |
| `src/core/harness/tool-runner.ts` | `RunApprovedToolInput.onShellProgress`；`runShellForTool` 透传 |
| `src/core/harness/graph.ts` | `BuildCodeAgentGraphInput.toolProgressSink`；`executeOneTool` 构造回调；`setTimeout(0)` flush（仅 shell 工具） |
| `src/core/runner.ts` | 创建 `toolProgressSink` → `provider.onEvent` |
| `src/app/tui/types.ts` | `tool_card` 加 `liveOutput` + `liveTotalLines` |
| `src/app/tui/reducers/handleEvent.ts` | `tool_progress` handler（tail-follow 5 行 + 累积计数） |
| `src/app/tui/components/ToolCardBlock.tsx` | 合并为 `renderShellLines`；running 分支渲染 liveOutput；done 分支加 exit code / cancelled 尾行；行截断改为 `clip()` 宽度感知 |
| `src/app/tui/render/useStaticContent.tsx` | `blockFingerprint` 对 `tool_card` 纳入 `liveOutput` 内容 + `liveTotalLines` |

## 实施中发现并修复的 bug

1. `readWithProgress` 末尾行被重复追加到 result（`result += buffer` 冗余）
2. `TextDecoder` 跨 chunk 的多字节 UTF-8 末尾字符未 flush
3. `reader.releaseLock()` 未调用，stream 锁泄漏
4. `liveTotalLines` 从截断后 buffer 计算，始终 ≤6
5. `setTimeout(0)` 对非 shell 工具也执行，每次浪费 ~1ms
6. `blockFingerprint` 不含 `liveOutput`，缓存吞掉实时更新
7. `blockFingerprint` 仅用 `liveOutput.length`，行长度相近时窗口滑动无法触发刷新
8. cancelled 检测用 `includes('cancelled')` 子串可能误判

## 验证

- `bun run typecheck` — 零错误
- `bun test tests/tui-reducer.test.ts` — 111 pass
- `bun test tests/tui-layout.test.tsx` — 6 预存失败（非本次引入）
- `bun test tests/tools.test.ts` — 1 预存失败（abort timeout，非本次引入）
- `bun run tui` 手动验证 — 实时输出正常、tail-follow 正常、退出码/cancelled 正常
