# Runtime Server

## 定位

`@kite-ai/runtime-server` 是 transport-neutral Runtime Protocol V1 gateway core。它只把经过严格 codec 的
logical message 路由到注入的 `RuntimeAccess` 与 App admission port；它不是 listener，也不是第二个 Runtime。

## 拥有职责

- 管理 connection 的 `uninitialized → active → draining → closed` 状态机。
- 路由 initialize、command、query、subscribe、unsubscribe 与 ping。
- 管理 subscription pump、ack-before-notification、iterator cleanup、同 subscription FIFO 与 connection/global bounded outbound queue。
- 提供不包含 socket/stream/process 的 InProcess logical-message endpoint。

## 不拥有职责

- 不创建或依赖 Runtime Host concrete type、Kernel、Builtin、SQLite、HTTP/WebSocket/stdio listener、Workspace Trust
  storage 或 App composition。
- 不折叠 domain projection，不保存 Runtime receipt，不成为第二 Session/Store authority。
- 不拥有 Web static UI、process signal、stdio JSONL、WebSocket、HTTP 或 transport framing。

## 允许依赖

仅依赖 `@kite-ai/runtime-contract` 与 `@kite-ai/runtime-protocol`。carrier I/O、Workspace/local-auth admission 与
Server/Host composition 由 `apps/kite` 拥有。

## 公开入口

只导出 package 根入口 `@kite-ai/runtime-server`：Server core/ports 和 InProcess logical endpoint。

## 关键不变量

- backend 是 `RuntimeAccess + RuntimeServerAdmissionPort`；admission 只裁定已冻结 operation 的 connection/role，并注入 App-owned Workspace facts。Server 不取得额外 Runtime authority，也不从 request body 或 client metadata 提升 authority。
- 输入和 InProcess message 一律通过同一 Protocol codec/limits；未知、超限或未初始化请求 fail closed。
- subscribe 先取得 Host iterator 并缓冲，再写 ack；顺序是 ack、replay/reset、initial item、ready/end、live。
  `afterRevision` 超过 Host watermark 时，ack 后立即发送 authoritative current snapshot/reset 与 ready，不能等待
  一个无法到达的旧边界。慢 consumer 只关闭所属 connection，并 return 所有 iterator；不会取消 Runtime work。
- outbound 同时受 count 和 encoded-byte 上限；已经从队列取出但尚未 settle 的 send 仍占 connection/global
  byte reservation，只有 send resolve/reject 后释放。drain 时发出 `server/draining` 并清理连接资源。没有
  sidecar、dual write 或 old-path fallback。

## 测试

`bun test packages/runtime-server/test`

## 文档影响

模块局部变化更新本 README；跨包 Runtime authority、receipt、admission、transport 或恢复变化同时更新对应
`docs/active/` current authority。
