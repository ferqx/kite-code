# ADR-0108：Runtime 残余权威单轨化

状态：accepted

日期：2026-08-15

决策者：github:@ferqx

相关：ADR-0105、ADR-0106、ADR-0107、`docs/space/plans/2026-08-15-runtime-architecture-convergence.md`

## 背景

主体收敛和完整性审计完成后，运行路径已净减少，但仍有几处旧入口或镜像留在当前格式中：Event
decoder 同时维护 discriminant 与字段目录；RuntimeStore 同时提供吞错读取和严格读取；Kernel 转发
没有生产消费者的 Store façade；Tool approval 在 Core/Protocol 各有一套 DTO；RuntimeState 与 active
Task 各持久化一份 Planning；恢复后的 Subagent 还使用旧 Tool terminal mapper 和缺省 recovery 字段。

这些残留不是建立新分层的理由。继续保留会让“当前格式、唯一权威、唯一执行入口”的结论依赖调用者
自律，并形成下一次兼容分支的落点。

## 决策

1. 当前 RuntimeEvent 只有一份 required-field manifest；其 key 同时是当前 discriminant 集合。类型联合与
   manifest 必须由测试验证一致，不另建 allowlist。
2. RuntimeStore 事件读取只保留严格 API。损坏事件不得转换为空历史；删除 AgentKernel 中无生产消费者
   且与 Store 同名的 snapshot/event façade。
3. `ToolApprovalPayload` 只在 Protocol 定义。Policy、Controller、Executor 和 App 共用该 JSON-safe DTO，
   不以 Core 同义接口或类型强转连接两套形状。
4. active `TaskState.planning` 是 Planning 唯一持久权威。RuntimeState 不保存 thread-level mirror；没有
   active Task 时 selector 固定返回 `building_without_plan`，不得重新创建兼容字段。
5. 当前 `SubAgentContinuation` 必须携带 recovery journal 和 blocked reason identity。普通 Tool、Task 与
   恢复后的 Task 共用同一个 `ToolExecutionResult → tool.finished` terminal/digest mapper；恢复 continuation
   不重新 dispatch child。
6. 删除已无消费者的旧 Plan Artifact locator。当前在线路径只识别 `{taskId}/v{version}.md`，不恢复旧
   `{taskId}/{planId}/v{version}.md` 路径。

## 后果

- 损坏 Store 读取、Planning 访问、审批 payload 和 Tool terminal 不再由调用者选择路径。
- 当前 snapshot 格式删除 Planning mirror。项目尚未发布，当前收敛工作仍作为同一未发布 epoch 交付，
  不增加 migration、shim 或第二个 decoder。
- RuntimeStore 的通用 snapshot 测试接口暂维持 `unknown`，因为本决策只删除重复读取/恢复权威；将其改成
  通用存储重写不属于本轮范围。
- 既有 TUI Plan Mode 同线程第二 writer 是独立 correctness 问题，不借本决策扩入本轮。

## 回滚

不恢复宽松读取、Planning mirror、Core approval DTO 或 continuation fallback。若正式发布后需要兼容旧
格式，应新增公开格式 ADR 和离线迁移边界。
