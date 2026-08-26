# Kite Local Runtime

## 定位

`@kite-ai/kite-local-runtime` 是 Kite 本机 Service 的 Bun/Node-only、repo-private substrate。它冻结
Service descriptor、token、lock、lifecycle 与 native credential 的 exact codec，并为 CLI/native consumer
提供窄的 Runtime、History 和 App Control connection contract。

本阶段只交付 contract 与 state-layout primitive；不创建 listener、WebSocket/HTTP server、child process、OS
service、Store、SQLite 或第二个 Runtime composition。

## 拥有职责

- `./service`：严格校验不含 secret/path/session 的 Service descriptor、lock identity、token material 与
  lifecycle state；构造 canonical `userKiteCodeDir()/runtime-service/v1` state layout 接口。
- `./client`：定义 `LocalKiteConnection`、manager、Runtime/History/App Control transport interfaces，以及
  Native-only lifecycle 和 raw credential request/result codec。
- 固定 client contract revision、Protocol V1 identity 与 loopback endpoint shape；拒绝未知字段、非 loopback
  endpoint、secret-bearing descriptor 和不安全 JSON shape。

## 不拥有职责

- 不监听端口、不 spawn/管理进程、不实现 lifecycle state machine，不读取或删除 state files。
- 不依赖 Runtime Host、Runtime Server、Builtin Runtime、SQLite、React、Ink 或任何 `apps/*`。
- 不把 control token 放进 `LocalKiteConnection`，不自动重试/重放 Runtime 或 App Control mutation；response
  丢失必须由调用方按 `outcome_unknown → exact state query → explicit decision` 处理。
- 不定义 Runtime Protocol service method、generic RPC、dynamic method registry、Browser transport、Desktop IPC
  或 public SDK。

## 允许依赖

只依赖 `@kite-ai/kite-app-contract`、`@kite-ai/runtime-client`、`@kite-ai/runtime-protocol` 与 codec 所需的
`zod`。该 package 的 source 不得导入 Host/Server/Builtin/SQLite、React/Ink 或 `apps/*`。

## 公开入口

只导出 `@kite-ai/kite-local-runtime/client` 与 `@kite-ai/kite-local-runtime/service`。不提供 root export，
不暴露内部 filesystem/process implementation。

## 关键不变量

- descriptor schema 是 `kite.local-runtime-service.v1`，只含 instance/PID/start time、loopback endpoint、
  Protocol version、client contract revision、server version 与 build ID；token、Workspace、Store/executable
  path、credential 和 Session 字段 fail closed。
- `access.token` 与 `control.token` 是不同的 restart-scoped material；connection contract 只能使用 access
  admission，stop/restart 由独立 manager 负责。
- state layout 固定在 validated home 下的 `runtime-service/v1/`，不以请求 Workspace 或 cwd 推导 Service identity。

## 测试

`bun run --cwd packages/kite-local-runtime test`

## 文档影响

模块局部 codec、state-layout 或 native client contract 变化更新本 README；跨包 Service auth、恢复、carrier、
process 或 release 变化同时更新对应 `docs/active/` current authority。
