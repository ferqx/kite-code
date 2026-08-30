# Coordinator、Workspace Worker 与 Web 模块边界

状态：active

读取时机：修改`packages/kite-local-runtime/src/coordinator/`、`apps/kite-service/src/workspace-worker/`、
`apps/kite-service/src/web-observer/`、`apps/kite-service/src/web-gateway/`、`packages/kite-app-contract/src/web.ts`或`apps/kite-web/`时。

验证：`bun test packages/kite-local-runtime/test/coordinator.test.ts apps/kite-service/test/workspace-worker apps/kite-service/test/web-observer apps/kite-service/test/web-gateway packages/kite-app-contract/test/web.test.ts`、`bun run --cwd apps/kite-web typecheck`、`bun run --cwd apps/kite-web test`、`bun run check:runtime-packages`、`bun run check:pre-release-architecture`、`bun run check:docs-impact`、`bun run check:docs`、`bun run typecheck`。

相关：ADR-0147、ADR-0148、ADR-0152、ADR-0154、[`单 Service 本机 Runtime 与 Kite Home 边界`](single-service-local-runtime.md)。

## 当前拓扑

正式source/release只有一个Local Service、一个Store 9和一个loopback HTTP listener。Coordinator、per-Workspace Worker与独立Web Gateway
不再是可执行拓扑；对应release entrypoint、client composition、migration命令和`web recover`均不存在。`packages/kite-local-runtime/src/coordinator/`
以及Service内旧process/layout模块只保留尚未删除的内部源码和测试，不得被普通startup、CLI/TUI、release connector或Browser选择。

`apps/kite-service/src/workspace-worker/`中仍被单Service复用的Workspace identity、Controller adapter、Trust、effect和execution组件是
in-process领域模块，不拥有Worker process、per-Workspace DB、idle lifecycle或第二writer。Store 7/8 layout与Catalog不是current Store 9的
fallback或兼容source。

## Web Observer与Browser边界

`packages/kite-app-contract/src/web.ts`是Browser-safe semantic contract。Browser只取得opaque Workspace/Session summary、safe History和
observer stream；绝不返回canonical Workspace path、Store path、native capability、credential、Controller或mutation route。

Service-owned Web carrier只bind `127.0.0.1`，验证Host、Origin、Fetch Metadata、body/queue bound、CSP与content type。认证保持
fragment launch token → HttpOnly/SameSite cookie → one-shot WebSocket ticket；这些材料只存在于内存，不写Kite Home。tab/socket replacement
只关闭旧Observer binding，不取消Turn、effect或Controller。

`kite web`在任何Service lifecycle或Browser auth状态前验证static root、`index.html`、OpenAPI与hashed JS/CSS；缺失返回
`web_assets_missing`且不spawn、不创建DB/socket/token。`web_ensure`attach同一listener并mint一次性URL；`web_status`只读返回
`absent|ready`、origin和asset digest；`web_stop`只撤销Browser session/ticket。

Browser打开URL不能启动本机server。Vite dev server只服务前端asset；`bun run web:dev`执行build、preflight和single-Service ensure。
remote/LAN/public Web、多租户、Browser mutation与server-side credential custody不受支持。

## Fail-closed边界

unknown/malformed frame、Trust drift、Workspace identity drift、Controller generation mismatch、Browser/native route confusion、Gateway route
draining和History gap/overflow继续fail closed。该安全边界不授权恢复旧Coordinator/Worker/Gateway process、Store layout、credential file或
filesystem Artifact root。
