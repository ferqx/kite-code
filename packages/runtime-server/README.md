# Runtime Server

## 定位

`@kite-ai/runtime-server` 是 transport-neutral Runtime Protocol V1 gateway core。它只把经过严格 codec 的
logical message 路由到注入的 `RuntimeAccess` 与 App admission port；它不是 listener，也不是第二个 Runtime。

## 拥有职责

- 管理 connection 的 `uninitialized → active → draining → closed` 状态机。
- 路由 initialize、command、query、subscribe、unsubscribe 与 ping。
- 可按App composition的精确布尔开关在initialize capability中声明三个History方法；Runtime Server不路由这些
  App-owned请求，声明与实际carrier handler必须由同一composition配对。
- 管理 subscription pump、ack-before-notification、iterator cleanup、同 subscription FIFO 与 connection/global bounded outbound queue。
- 将 App admission 返回的 opaque `bindingReference` 与 connection/request/client identity 组合成 strict、frozen 的进程内
  `RuntimeCommandContext`，仅传给 `RuntimeAccess.command()`；该 context 不进入 Protocol frame、request body、History 或 Browser。
- 提供不包含 socket/stream/process 的 InProcess logical-message endpoint。

## 不拥有职责

- 不创建或依赖 Runtime Host concrete type、Kernel、Builtin、SQLite、HTTP/WebSocket/stdio listener、Workspace Trust
  storage 或 App composition。
- 不折叠 domain projection，不保存 Runtime receipt，不成为第二 Session/Store authority。
- 不拥有 Web static UI、process signal、stdio JSONL、WebSocket、HTTP 或 transport framing。
- 不拥有、读取或路由durable History；App carrier必须在logical message进入Server前处理History，并复用App-owned
  read snapshot与closed result codec。

## 允许依赖

仅依赖 `@kite-ai/runtime-contract` 与 `@kite-ai/runtime-protocol`。carrier I/O、Workspace/local-auth admission 与
Server/Host composition由App拥有；KLSV1-06 clean cutover后唯一concrete Host/Store/Server root与Native carrier都在
`apps/kite-service`。`apps/kite-cli`只持有`RuntimeClient`/presentation facade，不依赖本package，也不组合InProcess Server。

## 公开入口

只导出 package 根入口 `@kite-ai/runtime-server`：Server core/ports 和 InProcess logical endpoint。

`RuntimeServer.open(connection, { admission })` 可为单个 logical connection 绑定 App-owned admission port；
`createRuntimeServerInProcessHub().open({ admission })` 提供相同的 InProcess seam。未提供 override 时继续使用
backend admission。该 port 只返回 admission decision 与注入的 Workspace fact；Server 不知道 HTTP access/ticket、
Workspace object 或 carrier 认证细节。Workspace fact 只在 create command mapper seam 注入；resume/fork/query 继续由
App/Runtime 的持久 Session identity 决定。connection 关闭后 binding 随 connection 一起释放，Session runtime 不受影响。
App 可同时提供 `onClose(connectionId)` 清理自身 connection-to-interaction binding；callback失败也不能阻止 Server
释放 connection accounting。该 hook不是 Runtime cancel或owner shutdown signal。

## 关键不变量

- backend 是 `RuntimeAccess + RuntimeServerAdmissionPort`；admission只裁定已冻结operation的connection/role，并注入
  Service-owned Workspace facts。每个connection可使用自己的admission port；Server不取得额外Runtime authority，也不从
  request body、cwd或client metadata提升authority。Native Trust query/decision与ticket auth留在Service carrier/App Control。
- `runtime/command` 只有在 admission 允许后才把 `connectionId`、protocol `requestId`、client info 与 admission 的 opaque
  binding reference 组成 `RuntimeCommandContext`；Server 不解释或缓存 Worker capability，旧 caller 未提供 binding 时只传 null。
- 输入和 InProcess message 一律通过同一 Protocol codec/limits；未知、超限或未初始化请求 fail closed。
- subscribe 先取得 Host iterator 并缓冲，再写 ack；顺序是 ack、replay/reset、initial item、ready/end、live。
  `afterRevision` 超过 Host watermark 时，ack 后立即发送 authoritative current snapshot/reset 与 ready，不能等待
  一个无法到达的旧边界。慢 consumer 只关闭所属 connection，并 return 所有 iterator；不会取消 Runtime work。
- outbound 同时受 count 和 encoded-byte 上限；已经从队列取出但尚未 settle 的 send 仍占 connection/global
  byte reservation，只有 send resolve/reject 后释放。drain 时发出 `server/draining` 并清理连接资源。没有
  sidecar、dual write 或 old-path fallback。
- KLSV1-06不改变本package的transport-neutral边界或Protocol/Store schema；clean cutover只改变注入backend的App owner。

## 测试

`bun test packages/runtime-server/test`

## 文档影响

模块局部变化更新本 README；跨包 Runtime authority、receipt、admission、transport 或恢复变化同时更新对应
`docs/active/` current authority。
