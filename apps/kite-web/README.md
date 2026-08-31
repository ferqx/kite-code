# Kite Web

`@kite-ai/kite-web`是本地、private、只读的Browser presentation workspace。它使用React、strict
TypeScript与Vite，只显示path-free Workspace、既有Session、History、诊断Log和Checkpoint；不提供prompt、Session create、
Interaction/approval reply、cancel、rewind、fork、配置或Controller操作。

## 唯一业务通道

`src/transport/client.ts`是唯一生产Browser adapter。访问Service `/`时，index响应已经建立HttpOnly/SameSite Browser session，
client直接验证`GET /v1`；Browser JavaScript不捕获或兑换启动token。此后业务数据只来自同一Service listener的typed REST：

- `GET /v1`验证当前Browser principal的`workspaces/sessions/history/checkpoints`capability；
- `GET /v1/workspaces`读取独立、path-free Workspace page；只预取首个Workspace的Session，其余在展开时读取；
- `GET /v1/workspaces/{workspace_id}/sessions`读取该Workspace的bounded Session page；
- 选择Session后默认读取`History`与Checkpoint metadata；用户切换到Runtime logs Tab时读取安全的durable Log snapshot；
- `GET /v1/sessions/{session_id}/logs`只包含event type、sequence、time、category、status、summary及closed detail fields，
  Web用可展开的key/value解释展示，不读取raw Store event；
- 展开`model.invocation_prepared`后可按exact invocation打开Model Context Inspector；Inspector调用Browser-only
  `GET /v1/sessions/{session_id}/model-invocations/{invocation_id}/context`，分区展示Overview、System prompt、Messages、Tools与Request settings；
- 只有选中Session为`running/waiting`且页面可见时，按2秒单飞读取`after_sequence`增量History并重新读取Session projection；
- 页面生命周期结束时，transport调用`DELETE /v1/auth/browser/session`自动清理Browser session；页面不提供无意义的手动Disconnect动作。

Web不调用`/_kite/web/bootstrap|tabs|directory|history|client`，不建立业务WebSocket，也没有BFF fallback、SSE、offline cache、后台同步
engine或持久client state。迟到结果以connection generation和Session identity隔离；轮询失败保留最后REST snapshot并停止把错误伪装成空数据。
Runtime logs按需读取并由用户显式刷新，不增加第二个后台poll scheduler。

## 视觉与可操控性

Web采用“Quiet Technical Workspace”设计语言：目录紧凑、正文舒适、状态明确，Light/Dark共用semantic token。关键交互具备稳定role与
accessible name，loading/empty/error/selected/connected均保留可读文本，不把关键能力藏在hover或Canvas中。完整规范见
[`UI Design System`](docs/ui-design-system.md)。

## 依赖与安全边界

组件只消费本地presentation type。transport只依赖browser-safe `@kite-ai/agent-api-client`，该client只依赖
`@kite-ai/agent-api-contract`；Web不得导入Service、CLI/TUI、Native local-runtime、Runtime Protocol/Host、Store、SQLite、Node或Bun I/O。
Browser JavaScript不持有Agent bearer、Native access token、canonical Workspace path或Store path。
Model Context是敏感本机诊断内容；Inspector不展示Artifact identity、Provider options/response、endpoint或Credential，关闭后不缓存或持久化内容。

固定`/api-docs`入口展示release-bundled canonical OpenAPI；renderer没有form、Try it或execute control，规范使用same-origin、
no-credential、`no-store`读取。页面存在不表示当前principal拥有尚未ready的mutation/SSE operation。

## 启动与release

TUI/CLI与`kite web`都通过同一个canonical Kite Home manager ensure唯一Local Service。Browser打开URL不能启动本机进程；
`bun run --cwd apps/kite-web dev`只是Vite资源服务器。源码开发使用根命令`bun run server`或`bun run tui`：它们先build assets，
Service在ready前完成preflight并把`/`、`/index.html`、`/assets/*`与`/api-docs`挂到同一个listener。`kite web`只ensure Service并
打印稳定的`origin/`；`GET /`直接返回index而不暴露物理文件名。Browser关闭或logout不停止Service。

release candidate把同一Vite产物放入`payload/web`。Service的一个loopback listener同时提供static assets、`/api-docs`与`/v1`；Web
不拥有第二listener、Runtime、Store、数据库或独立lifecycle。

## 验证

```text
bun run --cwd apps/kite-web typecheck
bun run --cwd apps/kite-web test
bun run --cwd apps/kite-web build
cmp apps/kite-web/dist/api-docs/openapi.json packages/agent-api-contract/generated/openapi.json
rg '_kite/web/(bootstrap|tabs|directory|history|client)' apps/kite-web/dist
```

最后一条必须无匹配。

## 本地文档

- [UI Design System](docs/ui-design-system.md)
