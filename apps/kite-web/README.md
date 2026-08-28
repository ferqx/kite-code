# Kite Web Observer

`@kite-ai/kite-web` 是本地、private、只读的 Browser presentation workspace。它使用 React 19、strict
TypeScript、Vite、按需纳入的 shadcn/ui + Radix primitives、Tailwind CSS v4 与 Lucide。

页面只有按 path-free Workspace 分组的既有 Session 列表、选中 Session 的消息列表、running Session
实时展示状态与主动断连。它不存在 prompt、Session create、approval/interaction reply、cancel、interrupt、
rewind、fork、mode/config mutation 或 Controller use case。

History、live、reconnect 与 resync 都进入 `src/presentation/reducer.ts` 的同一纯 reducer。组件只消费
`@kite-ai/kite-app-contract` 的 browser-safe DTO，不导入 CLI/TUI、Native local-runtime、Runtime Host、Store、
SQLite 或 raw Runtime event。

`src/transport/client.ts` 是唯一生产 Browser adapter：它同步捕获 launch URL fragment 并用
`history.replaceState` 清除 fragment，随后通过 `POST /_kite/web/bootstrap`、`POST /_kite/web/tabs` 和
`x-kite-web-tab` 访问 closed Gateway routes；running Session 通过 `/_kite/web/client` 的 closed WebSocket
`initialize`、`subscribe`、`unsubscribe`、`disconnect` 帧接入。WebSocket terminal unavailable/resync 会停止旧
generation 的事件归约，重新建立 tab、读取 bounded History，再恢复 live；不会把 transport error 静默替换为样例数据。

开发与 production 使用同一 Gateway transport；transport 失败只显示 unavailable，不会打包或回退到样例，
也不会直接读取本地文件。

release candidate 由独立 `kite-web-gateway` companion 提供 loopback BFF，并把 `payload/web` 作为 immutable candidate asset
绑定到 Web slot；Gateway 再经 Coordinator resolve/mint 后连接 Worker 的 current-format query/history/live surface。Web asset、
source entrypoint 与本地 smoke 只证明闭集 composition，不证明 Windows/Linux hosted process、remote/LAN 或 public Web 支持。

验证：

```text
bun run --cwd apps/kite-web typecheck
bun run --cwd apps/kite-web test
bun run --cwd apps/kite-web build
```
