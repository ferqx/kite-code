# Cancel-Resume 清理架构 & 工具参数异常处理

状态：active
范围：`src/core/runtime/kernel.ts`（AgentKernel.run 循环控制）、`src/core/harness/tool-runner.ts`（runApprovedTool）、`src/core/harness/tool-requests.ts`（toolRequestFromCall）、`src/core/model/context.ts`（sanitizeToolCallPairs、reorderInterleavedMessages）、`src/core/tools/tool-parse-error.ts`（formatToolParseError）、`src/app/tui/`（handleEvent、replay-blocks）
读取时机：修改 cancel/abort/resume 逻辑、检查点恢复、消息清理、工具参数异常处理、ask_user 错误展示时必读。
验证：`bun test tests/tool-parse-error.test.ts tests/context.test.ts tests/tui-reducer.test.ts`
最后更新：2026-06-27（三层清理架构 + 工具参数异常自主处理）

## 架构总览

```
START → cleanup → routeEntry → agent/approval/tools/user_input → ...
              ↓                        ↓
      orphan tool_calls       invokeModel → invalid_tool_calls
      → cancelled TMs           → synthetic tool_calls（无 TM）
              ↓                        ↓
      prepareModelContext      routeAfterAgent → tools
        → sanitize               ↓
        → reorder          runApprovedTool → _raw_invalid_args 检测
              ↓               → error TM → routeAfterTools → agent
         模型 API
```

## 第 1 层：cleanup（`context.ts` sanitize + `kernel.ts` 循环入口）

Agent 循环入口第一站。检测孤儿 `tool_calls`（有 tool_calls 无匹配 ToolMessage），插入 cancelled ToolMessage。

- 只检查 `m.tool_calls`（顶层字段），**不检查** `m.additional_kwargs.tool_calls`
- 使用 field-based 检测，不依赖 instanceof，兼容反序列化消息

## 第 2 层：invalid_tool_calls 处理（`model-controller.ts` + `tool-runner.ts` + `tool-requests.ts`）

### 问题

LLM 偶尔生成不合法的 JSON tool call 参数 → `parseToolCall()` 失败 → 放入 `response.invalid_tool_calls` → 不执行 → 无 ToolMessage → 模型不知道工具调用失败。

### 修复：合成 tool_calls + runApprovedTool 检测

```
invokeModel
  → 检测 response.invalid_tool_calls 非空
  → 创建合成 tool_calls 条目：
      { id, name, args: { _raw_invalid_args, _parse_error } }
  → 清理 additional_kwargs.tool_calls
  → 不创建 ToolMessage（保持"未解决"状态）
  
graph 路由 → tools 节点

toolRequestFromCall
  → 检测 _raw_invalid_args → 跳过规范化 → 直通 PendingToolRequest

runApprovedTool
  → 检测 args._raw_invalid_args → 调用 formatToolParseError
  → 返回 error ToolExecutionResult（stderr = 工具特定错误详情）
  → 不执行实际工具逻辑

executeOneTool
  → 创建 error ToolMessage
  → routeAfterTools → agent
  → 模型看到错误 → 自动重试
```

### 关键文件

| 文件 | 函数 | 职责 |
|------|------|------|
| `src/core/tools/tool-parse-error.ts` | `formatToolParseError()` | 工具特定错误格式化（原始参数 + 解析错误 + 期望格式） |
| `src/core/tools/tool-parse-error.ts` | `getToolSchemaHint()` | 查工具契约返回期望格式描述 |
| `src/core/tools/tool-contracts.ts` | `getToolContract()` | 按名称查找 ToolContract |

## 第 3 层：sanitizeToolCallPairs + reorderInterleavedMessages（`context.ts`）

每次 `prepareModelContext` 时运行。处理三种不一致：

1. **孤儿 tool_calls**：顶层 `tool_calls` 有 ID 但无匹配 ToolMessage → 移除
2. **akwDangling**：`additional_kwargs.tool_calls` 有 ID 但顶层 `tool_calls` 无对应 → 删除残留数据
3. **plain object 重建**：checkpoint 反序列化后 `!AIMessage.isInstance(msg)` → 重建为正确实例

三层条件合并：`orphaned || akwDangling || !AIMessage.isInstance(msg)`

修复后调用 `reorderInterleavedMessages` 确保 ToolMessage 紧接其 AIMessage。

## TUI 层：ask_user 错误展示

| 文件 | 改动 |
|------|------|
| `src/core/runtime/runner.ts` — `parseToolResultEvents` | `ok === false` 时提取 `stderr` 为 summary |
| `src/app/tui/reducers/handleEvent.ts` | 同上（实时处理） |
| `src/app/tui/replay-blocks.ts` — ask_user 展示 + `isToolMessageLike` | 同上（回放）+ field-based fallback 兼容 plain object |

## sanitizeToolCallPairs 的退役与恢复

| 日期 | 事件 | 理由 |
|------|------|------|
| 2026-06-23 前 | 在 agent 和 prepareModelContext 双重调用 | 历史防御 |
| 2026-06-23 | 退役：从热路径移除 | 认为 cleanup 节点已覆盖 |
| 2026-06-27 | 恢复：在 prepareModelContext 调用 | cleanup 漏检 `additional_kwargs.tool_calls` → 400 |

## 测试覆盖

```bash
bun test tests/tool-parse-error.test.ts  # 工具层错误格式化 (8 tests)
bun test tests/context.test.ts           # sanitize + reorder (32 tests)
bun test tests/runtime/reducer.test.ts   # RuntimeState 状态转换 (53 tests)
bun test tests/tui-reducer.test.ts       # TUI 展示 (111 tests)
```
