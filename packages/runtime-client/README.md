# Runtime Client

## 定位

`@kite-ai/runtime-client` 是 TUI、CLI 与 reference consumer 共用的 framework-neutral Runtime Client。

## 拥有职责

- 管理 Protocol request correlation、connection generation、显式 reconnect 与 subscription resubscribe。
- 维护 Session/index/ephemeral 的 observable snapshot，使用 connection generation 隔离旧连接消息，并在 index reset end 原子替换 session 列表。
- connection generation 变化时清空旧 generation 的 Session/stream snapshot，使所有旧 `ready` 与 revision
  立即失效；只有新 generation 的 authoritative reset/replay 与 subscription ready 边界可以重新建立 Session。
  新 Server 可以合法建立 revision 更低的当前投影，Client 不得在 resubscribe 前用 stale revision 发命令。
- 结构性实现 `RuntimeAccess`：`command/execute`、`query` 与同步返回 `AsyncIterable` 的
  `subscribe({ spec, signal? })`。每个订阅拥有独立有界队列，Abort 或 iterator `return()` 会释放远端订阅。
- 定义 framing-neutral transport 和只读、exact DTO 的 `RuntimeHistoryClient` 接口；`loadSession` 返回完整
  closed transcript。App可以继续注入独立history adapter；parent-owned App Server client也可显式选择
  `history: 'protocol'`，在同一条已initialize的logical connection上发送三个exact History request。
- 提供仅供Native App connector组合的closed `requestAppControl(method, request)` seam：方法名来自Protocol enum，
  响应必须回显同一method；语义payload仍由上层`kite-app-contract`逐方法codec拥有。`expectedServer`可要求
  exact server version与capability集合，initialize不匹配时关闭刚打开的连接并fail closed。

## 不拥有职责

- 不依赖 Runtime Server concrete type、Host、Builtin、SQLite、React 或 Ink。
- 不读取 raw Runtime event、Workspace path、Artifact locator、Host、SQLite 或 Store handle。
- transport timeout 不等于取消 Runtime command；mutation retry 必须复用原 command ID。
- reconnect 只恢复登记的 subscription，绝不自动重放 mutation。
- Session index 仅在同一连接 generation 内的 reset begin/upsert/end 边界原子替换；乱序、旧连接和同 revision
  不同投影均被拒绝或标记 resync。Server 的短期 notification replay 只帮助断线恢复，不是完整 history。
- History adapter/protocol adapter与control transport正交；Client facade可以同时暴露两者。History不通过Server
  notification retention，也不让Client取得raw Runtime event或Store authority。
- Native descriptor/discovery/process、WebSocket/History/App Control connector contract 位于
  `@kite-ai/kite-local-runtime/client`；本 package 不反向依赖该 Native owner，也不在 browser build 中加入环境分支。

## 允许依赖

只依赖 `@kite-ai/runtime-contract` 与 `@kite-ai/runtime-protocol`。

## 公开入口

只导出 package 根入口；具体 stdio/development carrier 仍由当前 App 拥有，Native connector 已由独立
`kite-local-runtime/client` 组合本接口。Runtime Client 本身保持 transport-neutral，并重新导出closed
`assertRuntimeClientEvent` validator供Native History复用唯一client-safe event边界。

## 测试

`bun test packages/runtime-client/test`

## 文档影响

模块局部变化更新本 README；跨包 Client/Server、恢复或 history 语义同时更新 Runtime current authority。
