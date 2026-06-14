# Cancel-Resume 清理架构

状态：active
范围：`src/core/harness/graph.ts` (cleanup 节点)、`src/core/model/context.ts` (`sanitizeToolCallPairs` / `reorderInterleavedMessages`)、`src/core/runner.ts` (finally)、`src/app/tui/` (取消 reducer / abort)
读取时机：修改 cancel/abort/resume 逻辑、检查点恢复、消息清理时必读。

## 问题

用户 ESC/Ctrl+C 取消正在执行工具的 agent 后，LangGraph 检查点中保留不完整的消息对：
```
AIMessage(tool_calls=[c1, c2])   ← 无匹配的 ToolMessage
```

resume 时若不处理：
1. **安全风险**：graph 会将孤儿 tool_calls 当作"待处理"重新执行
2. **API 顺序错误**：re-execution 的 ToolMessage 被追加到新 HumanMessage 之后，触发 DeepSeek 400 错误

## 三层清理架构

```
START → cleanup 节点 → routeEntry → agent/approval/tools/user_input → ...
                ↓
        sanitizeToolCallPairs → reorderInterleavedMessages → 模型 API
```

### 第 1 层：cleanup 节点（graph 入口，`graph.ts:400-437`）

在所有路由/执行之前运行。检测孤儿 tool_calls（有 tool_calls 无匹配 ToolMessage），插入 cancelled ToolMessage。

- 使用 field-based 检测（`m.tool_calls`），不依赖 instanceof，兼容反序列化消息
- 为每个孤儿 tool_call 创建 cancelled ToolMessage：`{ cancelled: true, reason: "User cancelled the operation" }`
- 返回的消息由 LangGraph 的 messagesStateReducer 追加到 state.messages 末尾
- 后续路由检查发现 tool_calls 已"解决"，直接走 agent 节点，跳过 tools 节点

**效果**：防止孤儿工具重新执行。cancelled ToolMessage 被持久化到检查点。

**已知限制**：已运行的 shell 进程不会被 kill（见 `docs/space/backlog/`）。

### 第 2 层：sanitizeToolCallPairs（模型调用前，`context.ts:62-142`）

防御层。处理 cleanup 节点可能遗漏的场景（如 plain object 消息中 `instanceof` 检测失败）。

- 双重源检测：`msg.tool_calls` + `additional_kwargs.tool_calls`
- 孤儿 AIMessage：拆离 tool_calls，仅保留文本内容和已匹配的有效 tool_calls
- 孤儿 ToolMessage：从消息列表中移除
- 保留 `additional_kwargs` 中的非 tool_calls 字段（如 `reasoning_content`）
- 仅删除 `additional_kwargs.tool_calls` 防止 API 序列化泄漏

### 第 3 层：reorderInterleavedMessages（API 适配，`context.ts:153-197`）

因 LangGraph 的 messagesStateReducer 仅支持 append，cleanup 节点的 cancelled ToolMessage 被追加到新 HumanMessage 之后。本层确保 API 看到正确顺序。

- 两遍扫描：先建 `tool_call_id → ToolMessage` 索引，再按 `AIMessage → ToolMessages → 其他` 输出
- 处理多个连续 AIMessage、交错 HumanMessage、重复 tool_call_id 等边缘情况

## 运行时机序

```
用户 ESC
  → TUI reducer: cancelRunningTools (标记 tool_card/subagent 为 cancelled)
  → rt.abort() → abortController.abort()
  → processStream 检测 signal.aborted → 返回
  → runAgent finally: setTimeout(0) + checkpointer.close()

用户 resume + 输入新消息
  → graph 入口: cleanup 节点插入 cancelled ToolMessages
  → agent 节点: sanitizeToolCallPairs + reorderInterleavedMessages
  → 模型调用: 干净有序的消息历史
```

## 关键决策

| 决策 | 理由 |
|------|------|
| cleanup 在 graph 入口而非 agent 内 | 必须在路由决策前更新 state.messages，避免 tools 节点重新执行 |
| field-based 检测而非 instanceof | 反序列化后的 plain object 会绕过 instanceof |
| reorder 在 sanitize 之后 | cleanup 追加的 cancelled ToolMessage 可能排在新 HumanMessage 之后 |
| `rt.abort()` 而非 `abortController.abort()` | 同步清 `agentLoopActive`，避免 session switch 时的 race condition |
| `setTimeout(0)` 在 checkpointer.close() 之前 | 让 LangGraph 内部异步写入在关闭前完成 |

## 测试覆盖

```bash
bun test tests/context.test.ts  # sanitizeToolCallPairs + reorderInterleavedMessages (20+ tests)
bun test tests/graph.test.ts    # 图路由 + cleanup 节点集成
bun test tests/integration.test.ts  # 全链路
bun test tests/runner.test.ts   # runAgent
```
