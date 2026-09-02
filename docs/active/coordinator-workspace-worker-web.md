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

正式installed/release与显式shared source每个canonical Kite Home只有一个Local Service、一个Store 9、一个`kite.sqlite`和一个loopback
HTTP listener。source TUI默认使用独立临时Runtime Home、Store与invocation endpoint。Coordinator与per-Workspace Worker不是当前可执行拓扑；独立Web Gateway的
process/control/state与Coordinator production glue已经删除，不能由普通startup、release connector或Browser恢复。

Workspace仍是Trust、配置、Skill、MCP、Sandbox、Controller与query scope，但不拥有独立进程、DB或idle lifecycle。
`apps/kite-service/src/workspace-worker/`中仍被single-Service消费的identity、Trust、effect与execution组件是in-process领域模块。

ADR-0166的KASD-01前置已另建未接production的`kite-session.sqlite`多连接owner：它不取得Workspace process lock，以Session generation裁决
writer，并允许同Workspace不同App Server写不同Session。该完成不恢复Coordinator/Worker拓扑，也不改变上述current production；KASD-02开始的
App Server只能组合该新owner，旧Workspace lock与one-connection Store不能进入新进程路径。

KASD-02内部App Server现以parent-owned stdio组合该owner和现有Host；它不是Coordinator/Worker复活，也没有Web Gateway、HTTP listener或
process-wide notification bus。另一个App Server可从Store snapshot读取Session，但不因read或退出取得/取消其generation。

## Web REST边界

Web是同一Service `/v1`的薄只读客户端：访问`GET /`或`GET /api-docs`SPA shell时Service创建或复用短期HttpOnly cookie；Workspace、Session、
History与Checkpoint通过`@kite-ai/agent-api-contract`定义的bounded、path-free REST读取。Browser principal是service-scoped read-only
principal，Session direct read仍必须属于Store 9 Directory可见范围。Browser cookie不能进入Native/Controller/mutation route，Agent bearer
也不能混入Browser请求。

Service-owned static carrier随Service启动固定提供`/`、`/index.html`、`/assets/*`、`/api-docs`、受限`/sessions/:sessionId` shell与精确OpenAPI
asset；Web使用React Router Declarative Mode进行History API SPA切换。Session选择push只包含opaque Session identity的短URL；从Docs执行Browser back时
通过现有Browser direct Session read恢复摘要与History，不暴露Workspace digest，也不扫描Workspace Session page。所有index shell入口都创建或复用
同一种短期HttpOnly Browser session；OpenAPI JSON和hashed asset请求不创建session。Browser业务BFF
`/_kite/web/tabs|directory|history|client`、业务WebSocket与WebObserver projection已删除。Browser logout只撤销当前session；Web route
只有在Service stop时关闭。

SPA root持有一个production Browser transport；Observer route unmount只停止该页面的异步投影，不撤销service-scoped Browser session，
document `pagehide`且不进入back-forward cache时才调用Browser session revoke。路由往返不创建第二transport、后台scheduler或持久client state。

`GET /`、`GET /api-docs`与受限Session shell直接返回同一个index并创建或复用短期read-only HttpOnly Browser session；CLI/TUI ensure同一Service并从Native `describe`返回稳定的
`origin/`。规范入口不暴露`/index.html`，也不存在launch token或Browser exchange route。

运行中Session只使用页面可见时的单一有界REST增量轮询；当前没有SSE、业务WebSocket、offline cache、Browser mutation、remote/LAN、
多租户或server-side Provider credential custody。后续事件transport必须由实测需求和新决策驱动，不能恢复dual read。

## 启动与fail-closed边界

Service在发布ready前验证release composition提供的immutable static root、`index.html`、OpenAPI及hashed JS/CSS；失败则整个Service
启动失败。installed TUI-first、`kite web`-first与并发ensure复用同一ready Service；source standalone不加入该owner，custom home只在相同canonical profile内复用。Browser打开
URL与Vite dev server均无本机进程启动authority。

unknown route、credential混用、Origin/Fetch Metadata错误、Directory scope漂移、History cursor/boundary失效、Controller generation漂移、
Protocol/client-contract不兼容与process identity不确定继续fail closed。兼容客户端可跨build只读发现ready Service；显式shared source `dev:` drift和
非active installed candidate可继续复用其Web assets，active installed candidate则验证旧owner后安全替换并收敛到当前candidate。
source与installed owner互不复用、互不替换，显式跨build lifecycle mutation仍拒绝；这些规则不授权第二Service、第二Store、兼容BFF
或旧Coordinator恢复路径。
