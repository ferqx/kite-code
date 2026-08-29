# Kite Web Observer

`@kite-ai/kite-web` 是本地、private、只读的 Browser presentation workspace。它使用 React 19、strict
TypeScript、Vite、按需纳入的 shadcn/ui + Radix primitives、Tailwind CSS v4 与 Lucide。

Observer页面只有按 path-free Workspace 分组的既有 Session 列表、选中 Session 的消息列表、running Session
实时展示状态与主动断连。固定`/api-docs`入口另提供release-bundled、只读的Agent API OpenAPI参考；它不渲染Observer
App，也不执行Worker discovery、保存credential或发送Agent API data-plane request。两个页面都不存在 prompt、Session create、
approval/interaction reply、cancel、interrupt、rewind、fork、mode/config mutation 或 Controller use case。

History、live、reconnect 与 resync 都进入 `src/presentation/reducer.ts` 的同一纯 reducer。组件只消费
`@kite-ai/kite-app-contract` 的 browser-safe DTO，不导入 CLI/TUI、Native local-runtime、Runtime Host、Store、
SQLite 或 raw Runtime event。

`src/transport/client.ts` 是唯一生产 Browser adapter：它同步捕获 launch URL fragment 并用
`history.replaceState` 清除 fragment，随后通过 `POST /_kite/web/bootstrap`、`POST /_kite/web/tabs` 和
`x-kite-web-tab` 访问 closed Gateway routes。bootstrap/tab成功后Directory与History立即走HTTP snapshot，不等待或依赖live
WebSocket；因此live unavailable不能清空server已返回的Workspace/Session列表。只有选中running Session时才懒建立
`/_kite/web/client` 的 closed WebSocket
`initialize`、`subscribe`、`unsubscribe`、`disconnect` 帧接入。WebSocket terminal unavailable/resync 会停止旧
generation 的事件归约，重新建立 tab、读取 bounded History，再恢复 live；不会把 transport error 静默替换为样例数据。
点击左侧既有 Session 会按该 `sessionId` 重新读取 bounded History，并在消息区明确显示 loading、empty、content、unavailable
或 error 状态；History 请求失败可在页面内重试。实时流失败时会保留已显示的 History，并单独提示 live updates 不可用。
切换 Session 时，旧请求的迟到响应不会覆盖当前选择；terminal resync 的自动重连固定最多三次，随后停在可重试的
unavailable 状态，而不是无限循环。

开发与 production 使用同一 Gateway transport；transport 失败只显示 unavailable，不会打包或回退到样例，
也不会直接读取本地文件。

release candidate 由独立 `kite-web-gateway` companion 提供 loopback BFF，并把 `payload/web` 作为 immutable candidate asset
绑定到 Web slot；Gateway 对在线 Worker 经 Coordinator resolve/mint 连接 current-format History/live，Worker idle 时则使用
Service-owned active Store 7 query-only facade 读取同一 current-format History。两条路径都只向 Browser 返回 presentation DTO。Web asset、
source entrypoint 与本地 smoke 只证明闭集 composition，不证明 Windows/Linux hosted process、remote/LAN 或 public Web 支持。

Vite构建从`packages/agent-api-contract/generated/openapi.json`逐字节生成固定
`payload/web/api-docs/openapi.json`；Gateway只把`/api-docs`与`/api-docs/`映射到同一immutable HTML入口，并只额外允许该精确JSON路径。
renderer没有form、Try it或execute control，只显示placeholder endpoint、已声明operation和“availability未确认”；规范加载使用
same-origin `GET`、`credentials: omit`、`no-store`，且不依赖remote CDN/script。Gateway继续应用self-only CSP、`no-store`与
`nosniff`，未知docs deep link保持404。

验证：

```text
bun run --cwd apps/kite-web typecheck
bun run --cwd apps/kite-web test
bun run --cwd apps/kite-web build
cmp apps/kite-web/dist/api-docs/openapi.json packages/agent-api-contract/generated/openapi.json
```
