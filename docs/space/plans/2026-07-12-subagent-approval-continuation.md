# 子 Agent 审批续跑状态机

状态：draft
优先级：P0
依赖：`2026-07-08-agent-kernel-incremental-evolution.md`

## 目标

当 `task` 派发的子 agent 因受保护工具暂停时，主 agent 必须一直等待该子 agent 成功、失败或被拒绝；用户批准后，子 agent 可以多次继续请求审批，且进程重启或会话恢复后仍可续跑。

## 问题与根因

当前 `src/core/controllers/tool-controller.ts` 使用模块级 `pendingSubagentContinuations` 保存 `SubAgentContinuation`。第一次暂停后，主 `task` 调用保持 `awaiting_approval`；但恢复后的子 agent 若再次暂停，若仍把结果视作 `task` 完成并发出 `tool.finished`，scheduler 会看到没有可运行工具并直接发出主 agent 的最终回复。

即使补上第二次暂停的分支，模块级 Map 仍不是正确的状态边界：它不随 RuntimeStore checkpoint 持久化、无法跨进程恢复，并且以未加 thread 命名空间的 tool call ID 为键，存在会话隔离和内存生命周期风险。

## 设计

### 1. `task` 的复合状态机

将子 agent 的暂停状态建模为主 `task` 调用的一部分。`task` 只有在子 agent 终结后才能产生 `tool.finished`；每次新的子工具审批都让同一个 `task` 回到 `awaiting_approval`。

```text
queued → running
          ├─ 子工具需要审批 → awaiting_approval → approved → running
          │                                      ↑              │
          │                                      └──── 再次暂停 ─┘
          └─ 子 agent 终结 → succeeded | failed | rejected | exhausted
```

`approval.requested.toolCallId` 保持主 `task` 的 ID，以复用现有 scheduler、用户 action 和 TUI approval barrier。审批 payload 携带被阻塞的子工具信息与 `subagentId`，供安全决策和展示使用。

### 2. 持久化的暂停快照

在 `RuntimeState` 增加按主 `task` ID 索引的 `suspendedSubagents`。它只包含 JSON-safe 数据：子 agent ID、角色名、原始任务、已执行步骤、journal、耗尽指纹、被阻塞的子工具请求，以及可重建的消息快照。

不持久化 `BaseMessage`、模型实例或 `Set`。新增 continuation codec，在 `src/core/subagent/` 中将 System/Human/AI/Tool 消息转换为显式 JSON-safe snapshot，并在恢复时重建 LangChain 消息。角色配置恢复时通过角色名调用 `getRoleConfig()`，避免把函数、模型或 Set 写入 checkpoint。

`RUNTIME_STATE_SCHEMA_VERSION` 升级并为普通旧快照提供默认空 `suspendedSubagents`，保证已有会话可加载。快照必须保留 `toolCallCount`、被阻塞子工具的原始 call ID、名称、参数和 command，保证恢复后的统计、ToolMessage 关联与审批 payload 不漂移。

### 3. 单一暂停迁移入口

在 `tool-controller` 中提取 `pauseSubagentForApproval()`，但它只构造事实，绝不直接修改 RuntimeState：

- 先发出 `subagent.suspended`，其 payload 是该 `task` 的完整 JSON-safe snapshot；reducer 以主 task ID 写入或替换 `suspendedSubagents`；
- 根据被阻塞子工具建立 approval payload；
- 后发出 `approval.requested`；
- 不得返回 `tool.finished`。

首次运行和每次恢复后都使用该入口，避免两条路径的状态迁移漂移。Runtime runner 必须将 `[subagent.suspended, approval.requested]` 作为一个 event batch 处理并持久化，确保观察到审批中断的 checkpoint 一定包含可恢复 snapshot。拒绝路径从 RuntimeState 读取 snapshot，发出 `subagent.failed` 与主 `task` 的失败 `tool.finished`；reducer 在任意 task 终结事件中清除 snapshot。

### 4. 续跑与恢复

批准事件只把主 `task` 标记为 `approved`。下一次 `run_tools` 从 `suspendedSubagents[taskCallId]` 读取快照，执行刚获批准的子工具，再调用 `resumeSubAgent()`。如果子 agent 完成、失败或耗尽，发出一次 `tool.finished` 并删除快照；如果再次暂停，重新走统一暂停迁移。

Kernel 从 RuntimeStore 载入 state 后无需任何 controller 内存补偿；scheduler 的既有规则已优先运行 `approved` task，因此不会在暂停期间进入 `emit_final`。

### 5. 旧会话的不可恢复审批

旧 schema 的模块级 Map 从未落盘，因此历史 checkpoint 若同时满足“`awaiting_tool_approval` 且 approval 带 `subagentId`”无法安全恢复。状态迁移必须在升级 schema **之前**检测该形态，并写入一次性的 JSON-safe `legacyUnrecoverableSubagentApproval` marker（包含主 task ID、subagent ID 和错误原因）；普通旧快照才初始化为空的 `suspendedSubagents`。

scheduler 在一切正常 effect 之前消费该 marker 并产生 `subagent.recovery_unavailable` effect；其 executor 只发出 `subagent.failed` 和该主 `task` 的失败 `tool.finished`，错误说明 continuation 未被旧版本持久化、不能安全执行或伪造完成。`tool.finished` reducer 清除 marker 与 interaction，事件批次持久化后主模型获得失败 ToolMessage 并决定下一步。不得重新启动一个新的子 agent，也不得继续展示已失效的审批。

## 范围

- `src/protocol/`：为 JSON-safe 子 agent 暂停快照定义协议类型。
- `src/core/subagent/`：实现 continuation codec 和从 snapshot 恢复 continuation。
- `src/core/runtime/state.ts`、`reducer.ts`、`kernel.ts`：持久化、迁移和生命周期清理。
- `src/core/controllers/tool-controller.ts`、`runtime/runner.ts`：统一暂停、恢复和拒绝处理；删除模块级 Map。
- `tests/runtime/`、`tests/subagent-runner.test.ts`：状态机、重复审批、拒绝和 checkpoint 恢复覆盖。

不改变审批策略、scheduler 路由、TUI block 协议或主/子 agent 的单向通信模型。

## 验证

1. 首次暂停不产生 `tool.finished`，scheduler 请求审批。
2. 用户批准后子 agent 再次暂停，仍不产生 `tool.finished`，且暂停快照被新 continuation 替换。
3. 第二次批准后子 agent 完成，恰好产生一次 `tool.finished`，然后主模型才可生成最终回复。
4. 用户拒绝任一次审批，产生 `subagent.failed` 和失败的 `task` 结果，并清除暂停快照。
5. `subagent.suspended` 与 `approval.requested` 的一个 event batch 落盘后加载 RuntimeStore，恢复的 kernel 仍可接受批准并继续同一子 agent。
6. 旧 schema 的子 agent approval checkpoint 在恢复时不请求用户审批，而是产生明确失败的 task ToolMessage 与 `subagent.failed`。
7. 运行 `bun test tests/runtime/tool-controller.test.ts tests/runtime/reducer.test.ts tests/runtime/store.test.ts tests/runtime/kernel.test.ts tests/subagent-runner.test.ts`、`bun run typecheck` 和 `git diff --check`。

## 风险与取舍

- LangChain 消息 snapshot 的字段必须覆盖 provider 返回的 AI tool calls；codec 需要独立单测，不能依赖对象的隐式 JSON 序列化。
- 同一 RuntimeState 只允许一个全局 interaction，符合现有“同时只有一个审批”的约束；未来并行后台子 agent 需要把 interaction 从单值扩展为按 task 管理的集合，该工作不包含在本方案。
- 该方案会升级 runtime snapshot schema；迁移采用保守默认值，旧会话中没有可恢复的内存 continuation 时应明确失败，而不是伪造完成结果。
