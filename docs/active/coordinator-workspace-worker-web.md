# Coordinator、Workspace 与 Web 当前边界

状态：active

读取时机：修改`packages/kite-local-runtime/src/coordinator/`、`apps/kite-service/src/workspace-worker/`、
`apps/kite-service/src/web-gateway/`、`apps/kite-service/src/agent-api/`、`packages/agent-api-client/`或`apps/kite-web/`时。

验证：`bun test packages/kite-local-runtime/test/single-service-manager.test.ts apps/kite-service/test/agent-api
apps/kite-service/test/web-gateway tests/release/single-service-real-child.test.ts`、`bun run --cwd apps/kite-web test`、
`bun run --cwd apps/kite-web typecheck`、`bun run check:runtime-packages`、`bun run check:pre-release-architecture`、
`bun run check:docs-impact`、`bun run check:docs`、`bun run typecheck`。

相关：ADR-0147、ADR-0148、ADR-0152、ADR-0154、ADR-0155、ADR-0156、
[`单 Service 本机 Runtime 与 Kite Home 边界`](single-service-local-runtime.md)。

## 当前拓扑

正式source/release每个canonical Kite Home只有一个Local Service、一个Store 9、一个`kite.sqlite`和一个loopback HTTP listener。TUI、
CLI、`service *`与`web`共用同一个manager/reservation。Coordinator与per-Workspace Worker不是当前可执行拓扑；独立Web Gateway的
process/control/state与Coordinator production glue已经删除，不能由普通startup、release connector或Browser恢复。

Workspace仍是Trust、配置、Skill、MCP、Sandbox、Controller与query scope，但不拥有独立进程、DB或idle lifecycle。
`apps/kite-service/src/workspace-worker/`中仍被single-Service消费的identity、Trust、effect与execution组件是in-process领域模块。

## Web REST边界

Web是同一Service `/v1`的薄只读客户端：访问`GET /`时Service创建或复用短期HttpOnly cookie；Workspace、Session、
History与Checkpoint通过`@kite-ai/agent-api-contract`定义的bounded、path-free REST读取。Browser principal是service-scoped read-only
principal，Session direct read仍必须属于Store 9 Directory可见范围。Browser cookie不能进入Native/Controller/mutation route，Agent bearer
也不能混入Browser请求。

Service-owned static carrier随Service启动固定提供`/`、`/index.html`、`/assets/*`、`/api-docs`与精确OpenAPI asset；Browser业务BFF
`/_kite/web/tabs|directory|history|client`、业务WebSocket与WebObserver projection已删除。Browser logout只撤销当前session；Web route
只有在Service stop时关闭。

`GET /`直接返回index并创建或复用短期read-only HttpOnly Browser session；CLI/TUI ensure同一Service并从Native `describe`返回稳定的
`origin/`。规范入口不暴露`/index.html`，也不存在launch token或Browser exchange route。

运行中Session只使用页面可见时的单一有界REST增量轮询；当前没有SSE、业务WebSocket、offline cache、Browser mutation、remote/LAN、
多租户或server-side Provider credential custody。后续事件transport必须由实测需求和新决策驱动，不能恢复dual read。

## 启动与fail-closed边界

Service在发布ready前验证release composition提供的immutable static root、`index.html`、OpenAPI及hashed JS/CSS；失败则整个Service
启动失败。TUI-first、`kite web`-first与并发ensure都复用同一ready Service；custom home只在相同canonical profile内复用。Browser打开
URL与Vite dev server均无本机进程启动authority。

unknown route、credential混用、Origin/Fetch Metadata错误、Directory scope漂移、History cursor/boundary失效、Controller generation漂移、
build mismatch与process identity不确定继续fail closed；这些规则不授权第二Service、第二Store、兼容BFF或旧Coordinator恢复路径。
