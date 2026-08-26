# Runtime Client

## 定位

`@kite-ai/runtime-client` 是 TUI、CLI 与 reference consumer 共用的 framework-neutral Runtime Client。

## 拥有职责

- 管理 Protocol request correlation、connection generation、显式 reconnect 与 subscription resubscribe。
- 维护 Session/index/ephemeral 的 observable snapshot，使用 connection generation 隔离旧连接消息，并在 index reset end 原子替换 session 列表。
- 结构性实现 `RuntimeAccess`：`command/execute`、`query` 与同步返回 `AsyncIterable` 的
  `subscribe({ spec, signal? })`。每个订阅拥有独立有界队列，Abort 或 iterator `return()` 会释放远端订阅。
- 定义 framing-neutral transport 和只读、exact DTO 的 `RuntimeHistoryClient` 接口；`loadSession` 返回完整
  closed transcript，完整 durable history 由 App 注入的 history adapter 提供。

## 不拥有职责

- 不依赖 Runtime Server concrete type、Host、Builtin、SQLite、React 或 Ink。
- 不读取 raw Runtime event、Workspace path、Artifact locator、Host、SQLite 或 Store handle。
- transport timeout 不等于取消 Runtime command；mutation retry 必须复用原 command ID。
- reconnect 只恢复登记的 subscription，绝不自动重放 mutation。
- Session index 仅在同一连接 generation 内的 reset begin/upsert/end 边界原子替换；乱序、旧连接和同 revision
  不同投影均被拒绝或标记 resync。Server 的短期 notification replay 只帮助断线恢复，不是完整 history。
- History adapter 与 control transport 正交注入；Client facade 可以同时暴露两者，但 history 不通过 Server
  retention，也不让 Client 取得 raw Runtime event 或 Store authority。

## 允许依赖

只依赖 `@kite-ai/runtime-contract` 与 `@kite-ai/runtime-protocol`。

## 公开入口

只导出 package 根入口；具体 stdio/WebSocket/进程 I/O 由 App carrier 拥有。

## 测试

`bun test packages/runtime-client/test`

## 文档影响

模块局部变化更新本 README；跨包 Client/Server、恢复或 history 语义同时更新 Runtime current authority。
