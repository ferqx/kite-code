# Cancel-Resume 清理架构

状态：active
范围：`src/core/harness/graph.ts` (cleanup 节点)、`src/core/model/context.ts` (`reorderInterleavedMessages`)、`src/core/runner.ts` (finally)、`src/app/tui/` (取消 reducer / abort)
读取时机：修改 cancel/abort/resume 逻辑、检查点恢复、消息清理时必读。
最后更新：2026-06-23（sanitizeToolCallPairs 从热路径移除，下沉为仅测试引用）

## 问题

用户 ESC/Ctrl+C 取消正在执行工具的 agent 后，LangGraph 检查点中保留不完整的消息对：
```
AIMessage(tool_calls=[c1, c2])   ← 无匹配的 ToolMessage
```

resume 时若不处理：
1. **安全风险**：graph 会将孤儿 tool_calls 当作"待处理"重新执行
2. **API 顺序错误**：re-execution 的 ToolMessage 被追加到新 HumanMessage 之后，触发 DeepSeek 400 错误

## 两层清理架构（2026-06-23 简化）

```
START → cleanup 节点 → routeEntry → agent/approval/tools/user_input → ...
                ↓
        prepareModelContext → reorderInterleavedMessages → 模型 API
```

### 第 1 层：cleanup 节点（graph 入口，`graph.ts:443-482`）

在所有路由/执行之前运行。检测孤儿 tool_calls（有 tool_calls 无匹配 ToolMessage），插入 cancelled ToolMessage。

- 使用 field-based 检测（`m.tool_calls`），不依赖 instanceof，兼容反序列化消息
- 为每个孤儿 tool_call 创建 cancelled ToolMessage：`{ cancelled: true, reason: "User cancelled the operation" }`
- 返回的消息由 LangGraph 的 messagesStateReducer 追加到 state.messages 末尾
- 后续路由检查发现 tool_calls 已"解决"，直接走 agent 节点，跳过 tools 节点

**效果**：防止孤儿工具重新执行。cancelled ToolMessage 被持久化到检查点。**这是唯一的孤儿处理层，覆盖所有场景。**

**已知限制**：已运行的 shell 进程不会被 kill（见 `docs/space/backlog/`）。

### 第 2 层：reorderInterleavedMessages（API 适配，`context.ts:170-214`）

因 LangGraph 的 messagesStateReducer 仅支持 append，cleanup 节点的 cancelled ToolMessage 被追加到新 HumanMessage 之后。本层确保 API 看到正确顺序（AIMessage → 紧接着它的所有 ToolMessages → 其他消息）。

- 两遍扫描：先建 `tool_call_id → ToolMessage` 索引，再按 `AIMessage → ToolMessages → 其他` 输出
- 处理多个连续 AIMessage、交错 HumanMessage、重复 tool_call_id 等边缘情况
- 在 `prepareModelContext` 中直接调用，不再经过 `sanitizeToolCallPairs` 的冗余孤儿检测

### sanitizeToolCallPairs 的退役

`sanitizeToolCallPairs`（`context.ts:61-159`）曾是第 2 层防御，在 agent 节点和 `prepareModelContext` 中**各调用一次**（双次冗余）。2026-06-23 分析确认：

- cleanup 节点（graph 入口第一站）已为**所有**孤儿 tool_calls 注入 cancelled ToolMessage
- 两条调用路径产出的消息列表经 `reorderInterleavedMessages` 后 JSON 完全相同
- 该函数现仅保留供测试引用，不再在生产热路径中调用

## 运行时机序

```
用户 ESC
  → TUI reducer: cancelRunningTools (标记 tool_card/subagent 为 cancelled)
  → rt.abort() → abortController.abort()
  → processStream 检测 signal.aborted → 返回
  → runAgent finally: setTimeout(0) + checkpointer.close()

用户 resume + 输入新消息
  → graph 入口: cleanup 节点插入 cancelled ToolMessages
  → agent 节点: invokeModel → prepareModelContext → reorderInterleavedMessages
  → 模型调用: 干净有序的消息历史
```

## 关键决策

| 决策 | 理由 |
|------|------|
| cleanup 在 graph 入口而非 agent 内 | 必须在路由决策前更新 state.messages，避免 tools 节点重新执行 |
| field-based 检测而非 instanceof | 反序列化后的 plain object 会绕过 instanceof |
| reorder 独立于 cleanup | cleanup 追加的 cancelled ToolMessage 可能排在新 HumanMessage 之后 |
| `rt.abort()` 而非 `abortController.abort()` | 同步清 `agentLoopActive`，避免 session switch 时的 race condition |
| checkpointer `puts`/`putWrites` 关闭后静默跳过 | LangGraph 异步写入可能在 close() 后才触发，抛错会导致 crash |
| 移除 sanitizeToolCallPairs 热路径调用（2026-06-23） | cleanup 节点保证孤儿已解决；双次调用冗余，且不影响前缀缓存 |
| prepareModelContext 直接调用 reorderInterleavedMessages | sanitize 的孤儿检测 pass 对 cleanup 后的消息永远是 no-op |

## 测试覆盖

```bash
bun test tests/context.test.ts     # reorderInterleavedMessages + sanitizeToolCallPairs (32 tests)
bun test tests/graph.test.ts       # 图路由 + cleanup 节点集成 (44 tests)
bun test tests/integration.test.ts # 全链路 (14 tests)
bun test tests/runner.test.ts      # runAgent (30 tests)
bun test tests/checkpoint.test.ts  # 检查点持久化 (13 tests)
```

## 验证：

```bash
bun test tests/context.test.ts tests/graph.test.ts tests/integration.test.ts tests/runner.test.ts tests/checkpoint.test.ts
```

