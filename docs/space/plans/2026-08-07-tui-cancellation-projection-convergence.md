# TUI 取消投影与终态渲染收敛方案

状态：completed

日期：2026-08-07

## 背景

Windows 主屏 TUI 在 Bash 被取消后同时存在两条状态入口：

1. Ctrl+C/Esc 先执行本地即时清理，让用户无需等待 Runtime 持久化即可看到终态；
2. `tool.cancelled`、`turn.aborted(cause=user)` 从 Runtime event log 到达，或在重新进入会话时 replay。

两条入口最终都渲染同一个 `ToolCardBlock`，但过去分别构造 `ToolCardBlock`、`tool_summary` 和 Thought 的取消终态。字段归一化发生漂移时，实时视图与 replay 会出现差异，例如运行卡显式携带 `expanded=false`，本地取消沿用该字段而 durable 路径把它改为 `true`；Shell 的 `⎿ cancelled` footer 又被包在 `isExpanded` 条件内，因此实时 footer 消失、重新进入会话后才出现。

当前即时补丁通过取消时强制 `expanded=true` 修复了可见性，但这把“长输出是否展开”和“终态是否可见”两个独立语义绑在一起，仍会给后续 live/replay 漂移留下入口。

## 目标

采用“**两入口、一投影、一渲染**”模型：

- 保留本地即时入口和 durable/replay 入口；
- 抽取唯一、纯函数化、幂等的用户取消投影；
- `expanded` 只控制工具输出正文，不再控制 Shell/Web Fetch 终态 footer；
- live 与 replay 对同一取消事实产生等价的视觉状态和渲染结果；
- 不改变 Runtime 的取消事实、event schema、Effect lease 或持久化契约。

## 非目标

- 不移除本地乐观取消，否则会牺牲即时反馈；
- 不改为只等待 `turn.aborted` 后才更新 UI；
- 不修改 `src/core/` 的 Runtime 取消协议；
- 不重构所有工具卡展示，只收敛用户取消和 Shell/Web Fetch outcome footer；
- 不清理或回滚 Windows sandbox 分支上的其他改动。

## 设计

### 1. 共享取消投影

新增 `src/app/tui/reducers/cancellation-projection.ts`，提供纯函数：

- `settleCancelledToolCard(block, options)`：把 active 工具卡投影为 cancelled，保留名称、参数、命令 detail、实时输出和已知耗时；
- `projectToolCancelled(state, toolCallId, options)`：消费单个 durable `tool.cancelled`，更新可见工具卡或 Thought 聚合项，并清除对应 pending/tool timing；
- `projectUserCancelledTurn(state, options)`：对最后一轮执行整轮取消收尾，供 Ctrl+C/Esc、`turn.aborted(cause=user)` 和兜底 idle cleanup 共用。

终态转换遵循单向和幂等规则：

```text
queued/running -> cancelled
cancelled      -> cancelled
done/error/timeout/exhausted -> 保持原终态
project(project(state)) === project(state)
```

整轮投影继续保留现有语义：

- running Subagent 结算为 cancelled；
- queued 探索项删除，不计入已完成统计；
- running 探索项结算为 cancelled；
- 已完成工具结果不被晚到取消覆盖；
- pending caption 脱离为文本，Thought 进入终态；
- 清理 pending tool calls 和对应的工具计时记录。

### 2. footer 与 expanded 解耦

`ToolCardBlock` 的 Shell/Web Fetch 终态拆为两层：

```tsx
{isExpanded && <ToolOutputBody />}
<ToolOutcomeFooter />
```

约束：

- `expanded` 只决定 summary/live output 正文是否展示；
- `cancelled`、`timeout`、`error`、`exhausted` 和成功 outcome footer 始终可见；
- 取消时不再为了 footer 强制展开长输出；
- cancelled 卡若只有合成的 `summary='Cancelled'`，不把该内部占位文本重复渲染为正文；已有 `liveOutput` 仍保留，可在展开时查看。

### 3. 入口接线

- Ctrl+C/Esc 的普通运行态取消调用 `projectUserCancelledTurn`，然后同步切换 `running=false`；
- `tool.cancelled` 调用 `projectToolCancelled`，不再绕行通用 `tool_done` 错误映射；
- `turn.aborted(cause=user)` 再调用幂等的 `projectUserCancelledTurn`，作为 durable 收敛边界；
- plan review、approval 和 `ask_user` 保持各自现有交互契约，不被错误归并为普通工具取消。

### 4. 等价性验证

从同一 active 状态构造：

```text
live   = reduce(initial, ESCAPE/CTRL_C)
replay = reduceMany(initial, [tool.cancelled, turn.aborted(cause=user)])
```

验证：

- 工具卡、聚合项、Thought、pending 状态的视觉字段等价；
- 重复投影不继续修改状态；
- 折叠的 cancelled Shell 仍显示 `⎿ cancelled`；
- live/replay 渲染 frame 相同；
- Windows PTY 仍满足取消实时可见、successor 不重复、Running 状态持续、Thought 与回答分帧。

## Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| `TUI-CANCEL-1` | 无 | 本方案、active 规则更新 | `bun run check:docs` | 文档不改变 Runtime 契约 |
| `TUI-CANCEL-2` | `TUI-CANCEL-1` | 共享 cancellation projection 与 reducer 接线 | `bun test tests/tui-reducer.test.ts` | 可回退到原 reducer 内联逻辑，不涉及持久化迁移 |
| `TUI-CANCEL-3` | `TUI-CANCEL-2` | ToolCard footer/正文解耦 | `bun test tests/tui-layout.test.tsx` | 可恢复原条件渲染；状态 schema 不变 |
| `TUI-CANCEL-4` | `TUI-CANCEL-2`,`TUI-CANCEL-3` | live/replay、幂等、PTY 回归测试 | `bun run scripts/run-tui-system-tests.ts cancel-successor-render` | 测试失败时保持即时入口，回退内部投影重构 |
| `TUI-CANCEL-5` | `TUI-CANCEL-4` | 类型、文档与差异门禁 | `bun run typecheck`、`bun run check:docs-impact`、`bun run check:docs` | 未共同收敛不得提交 |

## 风险与控制

1. **晚到 `tool.cancelled` 覆盖成功结果**：共享函数对 terminal 状态保持不变，并用测试覆盖。
2. **探索工具被误记为 error**：durable `tool.cancelled` 直接投影 cancelled，不再复用通用失败路径。
3. **折叠后用户看不到终态**：footer 无条件渲染，独立测试 `expanded=false`。
4. **本地与 durable 时间戳差异导致状态漂移**：只在已有 started time 且缺少 elapsed 时冻结一次，后续投影保持已有值；视觉等价测试忽略不可见的本地输入标志。
5. **影响 ask_user/审批语义**：入口接线只覆盖普通运行取消；现有专用分支和测试保留。

## 完成条件

- 共享投影成为普通 live cancel、durable tool cancel 和 user turn abort 的唯一取消归一化实现；
- footer 不依赖 `expanded`；
- live/replay 状态及渲染等价测试通过；
- 相关 reducer/layout/session/PTY 测试、typecheck、文档门禁全部通过；
- `docs/active/cancel-resume-cleanup.md` 描述新的当前行为。

## 实施结果

- `TUI-CANCEL-1`：方案与 `docs/active/cancel-resume-cleanup.md` 已更新；
- `TUI-CANCEL-2`：新增 `cancellation-projection.ts`，普通 Ctrl+C/Esc、`tool.cancelled`、`turn.aborted(cause=user)` 已共用投影；
- `TUI-CANCEL-3`：Shell/Web Fetch terminal footer 已与 `expanded` 解耦，取消不再强制展开正文；
- `TUI-CANCEL-4`：已增加 live/replay 状态等价、幂等、探索工具 cancelled、终态单向、折叠 footer 与渲染等价测试；Windows PTY `cancel-successor-render` 通过；
- `TUI-CANCEL-5`：最终验证结果：
  - 取消/恢复相关 18 文件测试集：`850 pass / 0 fail`；
  - Windows PTY `cancel-successor-render`：连续 5 次通过；
  - `bun run typecheck`：通过；
  - Biome 定向检查：通过；
  - `bun run check:docs-impact`、`bun run check:docs`：通过；
  - `git diff --check`：通过（仅仓库既有 CRLF/LF 提示）。

额外尝试的 `file-rewind` PTY 场景未进入测试正文：当前 Windows fixture 被既有首次 sandbox setup gate（`managed_network_setup_invalid`）拦截，并在清理临时工作区时报告 EBUSY；该场景不经过本方案修改的取消投影，未作为本方案完成 Gate。

该改动不新增 RuntimeEvent、不改变持久化 schema，也不需要 ADR 或数据迁移。