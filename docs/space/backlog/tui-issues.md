# TUI 待修复项

日期：2026-05-20
来源：TUI 生产就绪度深度审查
最后更新：2026-06-29（新增 Thought 预整合已知缺陷 B14-B16）

---

## 已修复（B01–B12）

所有 12 个项目已于 2026-05-22 ~ 2026-05-26 期间修复，详见：

| 编号 | 内容 | 修复日期 | 关联计划 |
|------|------|---------|---------|
| B01 | `/sessions <id>` 直接加载空分支 | 05-20 | TUI 生产就绪 |
| B02 | `error.recoverable` 上游未利用 | 05-22 | Phase 1 错误分类 |
| B03 | UNDO/REDO → Rewind | 05-23 | Phase 2 Rewind |
| B04 | 手动 Compaction | 05-22 | Phase 1 事件闭环 |
| B05 | `retry` 事件 → `model_retry` | 05-22 | Phase 1 事件闭环 |
| B06 | `compact_begin`/`compact_end` 事件路径 | 05-22 | Phase 1 事件闭环 |
| B07 | `compacting` 字段 UI 消费 | 05-22 | Phase 1 事件闭环 |
| B08 | React Error Boundary | 05-23 | 防御纵深 |
| B09 | Checkpoint 句柄泄漏 | 05-22 | 防御纵深 |
| B10 | 编辑器 temp 文件清理 | 05-23 | 防御纵深 |
| B11 | Session 命名 fallback | 05-22 | Phase 1 Session 命名 |
| B12 | 多会话并发 | 05-24 | 多会话并发执行 |

> 实施记录见 [`plans/`](../plans/) 目录下各对应计划文件。

---

## 暂缓

### B13 — 自定义斜杠命令 / Hook 系统

- 依赖：插件架构设计
- 状态：暂缓，待需求确认后启动
- 相关：Hooks（PreToolUse / PostToolUse）和 `customCommands` 配置段
- 备注：自定义斜杠命令可复用 Skills 加载机制

---

## 待修复（2026-06-29，Thought 预整合引入）

### B14 — 多 Thought 首块 stuck running

- **现象**：一轮对话中有两个或多个 Thought 块时，第一个 Thought 的 tool_done 事件未正确更新，首块永远停留在 running 状态（spinner），直到 agent 下一轮回复。
- **根因分析**：`explorationSummaryIds` map 已在 tool_call 时正确建立 callId → blockId 映射，但 tool_done 处理时 reducer 返回的 state 引用可能与后续 tool_done 接收到的 state 不一致。`.map()` 创建的新 turns 引用链可能使 `handleEventAction` 的入参 state 成为旧引用。
- **已验证不生效的方案**：
  - `explorationSummaryIds` map 精确定位（当前方案）—— 仍不生效
  - `findLastIndex(b => b.tools.some(t => t.callId === callId))` 搜索 —— 不生效
- **设计文档**：`docs/space/understanding/2026-06-28-thought-pre-consolidation-design.md`
- **严重程度**：P1 — 影响多个并行探索工具时的 UX

### B15 — shell_execute 未设 intent 导致遗漏

- **现象**：模型使用 `shell_execute` 执行 `rg`/`grep`/`find` 命令时可能不设置 `intent=inspect`，导致搜索命令未被纳入 Thought，而是保留为独立 tool_card。
- **当前缓解**：通过命令前缀（rg/grep/ag/ack/git grep/find）做 fallback 检测，但不完美。
- **理想方案**：通过 system prompt 强化，或者在 tool_runner 中为 search 类命令自动补设 intent。
- **严重程度**：P2 — 偶尔导致 UX 不一致

### B16 — 回放时 Thought 计时器不准

- **现象**：`consolidateAllRuns` 使用 `Date.now()` 而非实际的工具执行时间戳计算 `createdAt`，导致回放时 Thought 的 wall-clock 计时不反映真实执行耗时。
- **根因**：回放时 `tool_card` block 的 `startedAt` 在合并时未正确传递到 `tool_summary.createdAt`。
- **严重程度**：P2 — 回放展示不准确，不影响实时交互

