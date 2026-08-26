# Runtime Contract

## 定位

`@kite-ai/runtime-contract` 是 Kite Runtime 的私有、进程内客户端边界。它只暴露 JSON-safe 的 command、query、subscription、notification 与 presentation 数据。

## 拥有职责

- 定义 Session command、query、receipt、notification 和 projection。
- 定义封闭的 `RuntimeClientEvent`、`RuntimeClientInteraction` 与 complete history transcript DTO；未知
  Runtime 事实必须由 App projector 省略或投影为 `unavailable`，不得透传原始对象。
- 本地展示 DTO 保留有界 reasoning segment、动态工具 label、JSON-safe arguments、terminal result/progress
  与取消原因；只过滤明显 credential/authority material，不把普通 path/pattern/command/result 清空。
- `model.text_delta` 与 `reasoning.activity` 必须携带对应 model request identity；live projector 保留 Kernel
  event 的 `requestId`，history replay 从 durable model invocation identity 重建同一字段。
- 固定 command identity、expected revision、幂等回放与冲突语义。
- 为未来 transport adapter 提供中立数据边界。

## 不拥有职责

- 不包含 Kernel State、Host lifecycle、Provider handle、SQLite 类型或 TUI block。
- 不执行命令、不持久化、不分配 identity。
- 当前不是公共 SDK 或网络协议兼容承诺。

## 允许依赖

本 package 没有 workspace 或运行时依赖。

## 公开入口

只导出 package 根入口 `@kite-ai/runtime-contract`；`src/index.ts` 仅组合分域 contract。

## 关键不变量

- 所有客户端数据保持普通 JSON-safe 数据。
- command 必须携带唯一 `commandId`；Session mutation 使用 revision fencing。
- `delete_session` 是 Host-owned mutation：按 scoped command identity 删除 Session durable facts并保留
  receipt；Client/TUI 不能直接调用 Store delete。重放同一 digest 返回原 receipt，不同 digest fail closed。
- `respond_interaction` 必须携带匹配的 client-safe interaction identity：Session revision，及按 kind
  所需的 approval generation/grants、Plan identity、provider directory revision 或 verification revision。
- `RuntimeSubscriptionSpec` 是唯一可序列化 selector；`AbortSignal` 只属于 local
  `RuntimeSubscription`，不得进入 wire。
- `plan.approved` 是审核 settlement 的封闭 client event，携带 interaction identity、Session revision 与
  execution mode；Client 不从 raw Plan/Kernel event 推断审核已完成。
- `RuntimeHistorySessionTranscript` 只含同一 `RuntimeClientEvent` union；它是 display/recovery evidence，
  不携带 callback、Store handle 或历史 interaction settlement authority。
- 模型展示事件的 `requestId` 是 exact closed DTO 的必填字段；缺字段或额外字段均不进入 client boundary。
- Contract 不泄漏具体执行、存储或展示 authority。

## 测试

`bun test packages/runtime-contract/test`

## 文档影响

模块局部变化更新本 README；跨包 Session 或客户端语义同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
