# 子 Agent 审批续跑状态机实施计划

状态：archived（实施完成；正文仅作历史 TDD 记录）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 将子 agent 的审批暂停状态持久化为主 `task` 工具的 RuntimeState，使重复审批和会话恢复均不会让主 agent 提前结束。

**架构：** `task` 是复合操作：子工具暂停只产生 `subagent.suspended` 和 `approval.requested`，绝不结束 `task`。暂停 continuation 以 JSON-safe 快照保存到 RuntimeState，由 reducer 管理；批准后 controller 从快照重建子 agent，完成或拒绝时才终结 `task` 并清理快照。旧版本无法恢复的内存 continuation 通过一次性 recovery effect 转为明确失败。

**技术栈：** TypeScript、Bun test、LangChain message classes、RuntimeStore SQLite checkpoint。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/protocol/subagent.ts`（新建） | JSON-safe continuation snapshot 与被阻塞子工具的协议类型。 |
| `src/core/subagent/continuation-codec.ts`（新建） | `BaseMessage[]` 与协议 snapshot 的双向编解码；不包含模型或 Set。 |
| `src/core/subagent/types.ts` | 让运行时 continuation 与持久化 snapshot 边界明确。 |
| `src/core/runtime/events.ts` | `subagent.suspended` 事件。 |
| `src/core/runtime/state.ts` | 持久化 suspended map、旧快照 recovery marker 与 schema 版本。 |
| `src/core/runtime/reducer.ts` | snapshot 写入/替换与 task 终结清理。 |
| `src/core/runtime/effects.ts`、`scheduler.ts` | 恢复旧版本不可续跑审批的优先 effect。 |
| `src/core/runtime/kernel.ts`、`runner.ts`、`executor.ts` | state migration、suspended+approval 原子批处理与 recovery effect 执行。 |
| `src/core/controllers/tool-controller.ts` | 删除模块级 Map；统一首次/重复暂停、批准恢复、拒绝处理。 |
| `tests/subagent-continuation-codec.test.ts`（新建） | codec 的 AI tool call、ToolMessage、系统/用户消息 round-trip。 |
| `tests/runtime/{reducer,kernel,tool-controller}.test.ts` | 状态机、重复审批、恢复与旧快照降级。 |

### Task 1：定义可持久化 continuation 协议与 codec

**Files:**
- Create: `src/protocol/subagent.ts`
- Create: `src/core/subagent/continuation-codec.ts`
- Modify: `src/core/subagent/types.ts`
- Test: `tests/subagent-continuation-codec.test.ts`

- [ ] **Step 1: 写 codec 的失败测试**

覆盖 SystemMessage、HumanMessage、带 `tool_calls` 的 AIMessage、含 `tool_call_id`/`name`/`status` 的 ToolMessage；编码再解码后断言各类消息和 tool call ID/参数不丢失。还要断言 snapshot 经过 `JSON.stringify/parse` 后可解码。

```ts
const snapshot = serializeSubagentContinuation(continuation);
const restored = deserializeSubagentContinuation(snapshot);
expect(restored.messages[2]).toBeInstanceOf(AIMessage);
expect((restored.messages[2] as AIMessage).tool_calls[0]).toMatchObject({ id: 'call-1' });
```

- [ ] **Step 2: 运行失败测试**

Run: `bun test tests/subagent-continuation-codec.test.ts`

Expected: FAIL，缺少 protocol 类型或 codec 导出。

- [ ] **Step 3: 定义 JSON-safe protocol 类型**

在 `src/protocol/subagent.ts` 定义：

```ts
export interface SuspendedSubagentSnapshot {
  subagentId: string;
  role: SubAgentRole;
  task: string;
  messages: PersistedSubagentMessage[];
  toolCallCount: number;
  steps: PersistedSubagentStep[];
  executionJournal?: PersistedExecutionJournalEntry[];
  exhaustedFingerprints?: Record<string, true>;
  blockedTool: { toolCallId: string; toolName: string; args: Record<string, unknown>; command: string };
}
```

使用显式消息联合类型（`system`/`human`/`ai`/`tool`），其中 AI snapshot 保存 `content`、`id`、`toolCalls` 与 JSON-safe `additionalKwargs`。同时在该文件定义 `PersistedSubagentStep` 和 `PersistedExecutionJournalEntry`；core 侧的 runtime 类型转换到这些协议类型，不能让 protocol 从 core 导入类型，以保持 `core → protocol` 依赖方向。

- [ ] **Step 4: 实现最小 codec**

`serializeSubagentContinuation()` 接受运行时 continuation 和 blocked tool；`deserializeSubagentContinuation()` 使用 `getRoleConfig(snapshot.role)` 与 LangChain constructors 重建 runtime continuation。未知/不支持消息类型必须抛出带类型名的错误，不能静默降级为空消息。

- [ ] **Step 5: 运行 codec 测试**

Run: `bun test tests/subagent-continuation-codec.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/protocol/subagent.ts src/core/subagent/continuation-codec.ts src/core/subagent/types.ts tests/subagent-continuation-codec.test.ts
git commit -m "feat: 持久化子 agent continuation 快照"
```

### Task 2：把暂停状态纳入 RuntimeState 和 reducer

**Files:**
- Modify: `src/core/runtime/events.ts`
- Modify: `src/core/runtime/state.ts`
- Modify: `src/core/runtime/reducer.ts`
- Test: `tests/runtime/reducer.test.ts`
- Test: `tests/runtime/plan-persistence.test.ts`

- [ ] **Step 1: 写 reducer 的失败测试**

断言 `subagent.suspended` 将 snapshot 以主 `task` ID 写入 state；再次同 ID 事件会替换 snapshot；`tool.finished`、`tool.failed`、`tool.rejected`、`tool.cancelled` 清除对应 snapshot。另建一个仍处于 `awaiting_tool_approval` 的 legacy task state，对同 ID `tool.finished` 断言 interaction 变为 `idle`，防止恢复 effect 重复请求旧审批。

```ts
state = reduceRuntimeState(state, { type: 'subagent.suspended', toolCallId: 'task-1', snapshot });
expect(state.suspendedSubagents['task-1']).toEqual(snapshot);
expect(reduceRuntimeState(state, finished('task-1')).suspendedSubagents['task-1']).toBeUndefined();
```

- [ ] **Step 2: 运行失败测试**

Run: `bun test tests/runtime/reducer.test.ts --test-name-pattern "subagent.suspended"`

Expected: FAIL，RuntimeEvent 尚不包含该事件，state 尚无字段。

- [ ] **Step 3: 增加状态与事件**

新增 `SubagentSuspendedEvent`：

```ts
{ type: 'subagent.suspended'; toolCallId: string; snapshot: SuspendedSubagentSnapshot }
```

`RuntimeState` 增加 `suspendedSubagents: Record<string, SuspendedSubagentSnapshot>`；新增一次性 `legacyUnrecoverableSubagentApproval?: { toolCallId: string; subagentId: string; reason: string }`。把 `RUNTIME_STATE_SCHEMA_VERSION` 提升为 3，并在初始 state 初始化空 map。

- [ ] **Step 4: 实现 reducer 清理语义**

`subagent.suspended` 只接受现有 `task` 调用；写入时不改变 tool 状态。抽取 `withoutSuspendedSubagent(state, toolCallId)`，由全部 task 终结事件使用。`tool.finished` 还需清理 legacy marker（仅当 call ID 对应）；若当前 `awaiting_tool_approval.toolCallId` 相同，也必须将 interaction 置为 `idle`。该清理只在终结同一工具时触发，不影响其他工具的 approval barrier。

- [ ] **Step 5: 运行 reducer 与 snapshot 测试**

Run: `bun test tests/runtime/reducer.test.ts tests/runtime/plan-persistence.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/core/runtime/events.ts src/core/runtime/state.ts src/core/runtime/reducer.ts tests/runtime/reducer.test.ts tests/runtime/plan-persistence.test.ts
git commit -m "feat: 保存子 agent 审批暂停状态"
```

### Task 3：实现 snapshot 恢复迁移和确定性 recovery effect

**Files:**
- Modify: `src/core/runtime/effects.ts`
- Modify: `src/core/runtime/scheduler.ts`
- Modify: `src/core/runtime/kernel.ts`
- Modify: `src/core/runtime/executor.ts`
- Modify: `src/core/runtime/runner.ts`
- Test: `tests/runtime/kernel.test.ts`

- [ ] **Step 1: 写失败测试**

在临时 RuntimeStore 写入 schema 2 snapshot：它处于 `awaiting_tool_approval` 且 `approval.subagentId` 存在。通过 `createAgentKernel()` 恢复后，断言下一 effect 为 `subagent.recovery_unavailable`，而不是 `request_tool_approval` 或 `emit_final`；执行 effect 后断言产生 `subagent.failed` 和失败 `tool.finished`、`interactions.kind === 'idle'`，且下一个 effect 不是 `request_tool_approval`。

- [ ] **Step 2: 运行失败测试**

Run: `bun test tests/runtime/kernel.test.ts --test-name-pattern "legacy subagent approval"`

Expected: FAIL，旧 snapshot 被丢弃或 scheduler 仍请求用户审批。

- [ ] **Step 3: 实现恢复迁移**

在 `createAgentKernel()` 增加纯 `migrateRuntimeState(restoredState, expectedThreadId)`：先检测 schema 2 的 awaiting 子 agent approval，写入 recovery marker；再补齐 `suspendedSubagents`/schema 3。正常 schema 2 snapshot 同样迁移，而不是丢弃整个 session。禁止在 migration 中读 controller Map 或重启子 agent。

- [ ] **Step 4: 实现 effect 和执行器**

扩展 `RuntimeEffect`：

```ts
{ type: 'subagent.recovery_unavailable'; toolCallId: string; subagentId: string; reason: string }
```

`decideNextEffect()` 在 interaction 和 runnable tool 之前优先该 effect。`createRuntimeEffectExecutor()` 返回失败 `subagent.failed` 与主 task 的 `tool.finished`；`runRuntimeLoop()` 和 `AgentKernel.run()` 将它视为普通确定性 effect，不请求 provider action。

- [ ] **Step 5: 运行 kernel 测试**

Run: `bun test tests/runtime/kernel.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/core/runtime/effects.ts src/core/runtime/scheduler.ts src/core/runtime/kernel.ts src/core/runtime/executor.ts src/core/runtime/runner.ts tests/runtime/kernel.test.ts
git commit -m "fix: 明确终止旧版子 agent 审批会话"
```

### Task 4：统一 controller 的暂停、批准恢复与拒绝路径

**Files:**
- Modify: `src/core/controllers/tool-controller.ts`
- Modify: `src/core/runtime/runner.ts`
- Test: `tests/runtime/tool-controller.test.ts`

- [ ] **Step 1: 写失败回归测试**

用可控 mock model 产生：第一次子工具审批 → 批准后第二次子工具审批 → 第二次批准后最终文本。断言第二次暂停的 events 顺序为 `subagent.suspended`、`approval.requested`，没有 `tool.finished`；同一 task snapshot 已替换。拒绝测试从 state snapshot 生成 `subagent.failed` 和失败 task result，并清除 snapshot。

- [ ] **Step 2: 运行失败测试**

Run: `bun test tests/runtime/tool-controller.test.ts --test-name-pattern "sub-agent.*again|second approval|rejected continuation"`

Expected: FAIL，现有模块级 continuation Map 或重复暂停路径不满足事件契约。

- [ ] **Step 3: 删除内存 Map 并提取暂停 helper**

删除 `pendingSubagentContinuations` 与 `resolveRejectedSubagentContinuation()` 对模块级状态的依赖。新增纯 `pauseSubagentForApproval({ state, taskToolCallId, blocked })`，固定返回：

```ts
[
  { type: 'subagent.suspended', toolCallId: taskToolCallId, snapshot },
  { type: 'approval.requested', interactionId, toolCallId: taskToolCallId, approval },
]
```

首次 `runApprovedTool(task)` 与 `resumeSubAgent()` 的 blocked 分支都只调用该 helper。保留主 task ID 作为 approval ID，approval payload 的 `subagentId` 和 command 取 blocked tool。

- [ ] **Step 4: 从 state snapshot 恢复和拒绝**

当 task `approved` 时，从 `state.suspendedSubagents[taskToolCallId]` decode continuation，执行 snapshot 中 `blockedTool` 并继续 `resumeSubAgent()`；只有 non-blocked result 才发送一次 task `tool.finished`。将拒绝 continuation 的 helper 改为接收 readonly RuntimeState，从 snapshot 构建 `subagent.failed` 和 task failure events。

- [ ] **Step 5: 在 runtime loop 使用原子 batch**

`runRuntimeLoop()` 对包含相邻 `subagent.suspended` + `approval.requested` 的 controller 结果调用 `kernel.processEventBatch(events)`，再 yield；普通 controller 结果保持原有处理。不要让 controller 直接写 store。

- [ ] **Step 6: 运行 controller 测试**

Run: `bun test tests/runtime/tool-controller.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/core/controllers/tool-controller.ts src/core/runtime/runner.ts tests/runtime/tool-controller.test.ts
git commit -m "fix: 持久化子 agent 审批续跑"
```

### Task 5：端到端持久化与回归验证

**Files:**
- Modify: `tests/runtime/kernel.test.ts`
- Modify: `tests/runtime/store.test.ts`
- Modify: `tests/subagent-runner.test.ts`

- [ ] **Step 1: 写跨 kernel 恢复的失败测试**

首次 kernel 写入 `[subagent.suspended, approval.requested]` batch 后关闭 store；新 kernel 从同一路径恢复。批准 task 后使用 mock model 完成，断言恢复调用使用原 subagent ID、原 blocked child `toolCallId`，最终仅产生一次 task `tool.finished`，最后才有 `run.completed`。

- [ ] **Step 2: 运行失败测试**

Run: `bun test tests/runtime/kernel.test.ts tests/runtime/store.test.ts tests/subagent-runner.test.ts`

Expected: FAIL，恢复前没有 JSON-safe continuation 或没有原子 event/snapshot 边界。

- [ ] **Step 3: 完成最小实现并运行目标测试**

确认 Task 1–4 的实现能让测试通过；只修复测试揭示的接口缺口，不扩展到多 interaction 或后台并行子 agent。

- [ ] **Step 4: 运行目标测试、类型检查和差异检查**

Run: `bun test tests/subagent-continuation-codec.test.ts tests/subagent-runner.test.ts tests/runtime/tool-controller.test.ts tests/runtime/reducer.test.ts tests/runtime/kernel.test.ts tests/runtime/store.test.ts && bun run typecheck && git diff --check`

Expected: 全部 PASS，TypeScript 零错误，diff 无空白错误。

- [ ] **Step 5: 提交**

```bash
git add tests/subagent-runner.test.ts tests/runtime/kernel.test.ts tests/runtime/store.test.ts
git commit -m "test: 覆盖子 agent 审批恢复状态机"
```

## 完成检查

- [ ] 没有模块级子 agent continuation Map。
- [ ] 每次暂停均以 `subagent.suspended` 与 `approval.requested` 的原子 batch 持久化。
- [ ] 重复审批不产生 `task` 的 `tool.finished`。
- [ ] 主 `task` 的最终结果只在子 agent 终结后产生一次。
- [ ] 新进程可从 suspended snapshot 恢复；旧版不可恢复 session 得到持久化的失败结果。
- [ ] 所有目标测试、`bun run typecheck` 与 `git diff --check` 均有本次运行的通过证据。
