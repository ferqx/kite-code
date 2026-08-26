# Runtime Application 与 App Control

本页是 `apps/kite-cli` 的 owner-local current authority，描述 KLSV1-03 后、独立 Service cutover 前的 app-local
InProcess 边界。

## 当前组合

- `KiteRuntimeApplication` 组合唯一 Runtime owner、Runtime Server、History、App Control 与共享 mutation gate；
  `start`、quiesce/drain、cancel 和 dispose 都是显式 owner lifecycle。
- `RuntimeWorkspaceContextFactory` 按完整 `canonicalPath + projectId + workspaceDigest` 缓存 Workspace context，
  `RuntimeExecutionBridgeRouter` 按持久 Session identity 路由。真实 integration 使用一个 SQLite writer、一个 Host、
  一个 coordinator registry 和多个 lazy per-Session bridge；同一 Workspace 可创建多个 Session，重启时从唯一
  Store snapshot恢复 Workspace identity。
- 每个 Runtime Server connection 可注入独立 admission。create 的 wire path 不可信，由 connection admission替换为
  canonical Workspace；resume/query/subscribe/fork 读取持久 Session identity并与 connection Workspace交叉校验。
  process-wide `list_sessions` 仍由唯一 Store owner产生，不使用 caller Workspace过滤或第二 reader authority。
- `RuntimeInteractionBroker` 以 Session、interaction、generation/revision 持有 durable waiter。Server admission将
  connection identity绑定到 Session waiter；client disconnect只删除 binding，另一 client可继续 settle；只有
  owner shutdown关闭 broker。

## App Control 与 Workspace owner

`KiteAppControlService` 对 Workspace Trust、Provider/model、MCP、Skill、execution 与 release 使用独立 handler和
exact codec。mutation 统一经过 operation gate；revision CAS原样传递，`outcome_unknown` 后只允许 query一次并由
用户显式决定，不能自动重放。Workspace handler校验完整 identity；neutral boot只提供 trust/release discovery，
没有 Provider/API key仍可启动。

每个 canonical Workspace分别创建 config/model route、MCP Supervisor/runtime provider、actual Skill scan、
Sandbox/Shell、observability和checkpoint inputs。TUI只得到 safe projection/client；raw Provider API key只经
`kite-local-runtime` Native credential codec进入 owner，取消 signal透传到 discovery，response/error不回传 secret。

## 生命周期与未迁移边界

Runtime Client `close`/TUI facade `dispose`只关闭自己的 connection；不会调用 `cancelAll` 或 Runtime Application
dispose。显式 embedded CLI owner仍可在自己的 lifecycle末端调用 `shutdownOwner`。当前 production仍在
`apps/kite-cli` 内 InProcess运行，没有 `apps/kite-service` process、production listener、app-to-app import、第二
Host/Store、silent fallback或默认双 owner。

`TuiRuntimeBridge`/`CliRuntimeBridge`、raw Runtime event/history projector、Host/SQLite/Builtin concrete composition
仍是 app-internal transition实现；它们不跨 client seam，并将在 KLSV1-06 relocation manifest中一次性迁移。
本阶段不提供 Web/Desktop、公共 SDK、通用 RPC、多 Store或 OS Service。

## 验证

`bun test apps/kite-cli/test/runtime-application apps/kite-cli/test/app-control apps/kite-cli/test/isolated/runtime-server-multi-workspace.test.ts apps/kite-cli/test/isolated/runtime-server-multi-client.test.ts apps/kite-cli/test/isolated/tui-runtime-client-conformance.test.ts`、`bun run --cwd apps/kite-cli typecheck`。
