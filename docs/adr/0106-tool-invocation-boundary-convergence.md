# ADR-0106：Tool invocation 边界收敛

状态：accepted

日期：2026-08-15

决策者：github:@ferqx

相关：ADR-0028、ADR-0043、ADR-0105、`docs/space/plans/2026-08-15-runtime-architecture-convergence.md`

## 背景

ToolSpec Registry 已经是静态工具 Schema、effects、execute 和模型结果投影的事实源，但 Tool
Controller 仍直接 dispatch Tool Search、Skill 和 Plan specs，其他工具则经过 Harness 的
`runApprovedTool()`。同时 `ProjectedToolResult` 还携带 App 展示提示和 Runtime events，使模型结果
投影同时承担展示与领域事实提交职责。

继续为这些职责创建 ToolModule 或 definition/policy/handler/projection 四套接口会增加新的同步面，
不能消除现有双路径。

## 决策

1. 保留现有 ToolSpec Registry，不创建第二套 Tool 抽象。ToolSpec 继续拥有模型 Schema、可用性、
   effect facts、execute 和模型/结果元数据投影。
2. `ProjectedToolResult` 不包含 display hint 或 Runtime events。App 根据持久 RuntimeEvent 和工具结果
   元数据决定展示；Runtime action/coordination 的 execute 输出可以携带领域 events，由 Controller
   在模型投影之外原子提交。
3. 所有可执行 Builtin 和动态 MCP 调用都经过唯一的 `invokeGovernedTool()` 生命周期：解析后的请求、
   Policy、approval defense-in-depth、protected path/sandbox、Registry dispatch 和结果归一不得由
   Controller 旁路。
4. Tool Controller 可以保留跨领域的 disclosure、interaction routing、durable invocation、Skill fork
   adapter 和 outcome-to-event 映射，但不得直接调用 `dispatchRegisteredTool()` 或具体可执行 ToolSpec。
5. 删除旧 `runApprovedTool` 符号，不提供兼容导出。`dispatchRegisteredTool()` 仅是唯一 invocation
   实现内部的 Registry 执行原语，不是 Controller 的第二入口。

本决策替代 ADR-0043 中“ToolSpec 结果投影包含展示提示”以及 active 文档中“Controller 直接消费
Runtime-action spec 投影”的部分；不改变 ADR-0028 规定的 Plan/Skill 领域门面所有权。

## 后果

- Controller 不再为 Tool Search、Skill、Plan 维护独立执行分支；新增工具不会增加第二个 dispatch
  入口。
- ToolSpec execution context 只保留当前 specs 实际消费的依赖；删除未注入的 Shell network broker
  字段。
- Runtime events 不再经模型投影传递，展示也不再由 Core ToolSpec 提示驱动。
- Policy、approval、sandbox、MCP binding、Skill/Plan 语义和模型可见结果保持现有治理边界。

## 回滚

若唯一 invocation 出现问题，应修复或回滚对应工具迁移，不重新暴露 Controller direct dispatch，也
不恢复 `ProjectedToolResult.display/runtimeEvents`。需要新的工具职责边界时必须以删除现有重复权威
为前提新增 ADR。
