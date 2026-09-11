# kite-web

## 定位

浏览器只读 presentation owner，提供 React 路由、REST 数据接入与诊断。会话主页面与桌面端共同消费 [kite-client-ui](../../packages/kite-client-ui/README.md)，Web 入口按 Browser principal 的只读策略不提供写操作。

产品行为见[WEB 手册](../../docs/handbook/clients/web/README.md)，不从另一客户端推导交互。

## 职责与边界

唯一业务通道为 agent-api-client → agent-api-contract → 同源 App Server REST。端侧先投影为共享页面需要的展示数据；组件不直接消费传输协议。禁止依赖 Native、Host、Store、Protocol、SQLite、Node/Bun I/O 或 Service raw source。Web 不拥有 Runtime、数据库或第二 listener。

## 修改入口

- [src/routing.tsx](src/routing.tsx)
- [src/app/app.tsx](src/app/app.tsx)
- [src/transport/client.ts](src/transport/client.ts)
- [src/presentation/reducer.ts](src/presentation/reducer.ts)

## 实现专题

- [Web REST 接入与更新](docs/data-and-updates.md)
- [Web 日志、模型上下文与 API Docs](docs/diagnostics.md)
- [Web 路由与页面生命周期](docs/routing-and-lifecycle.md)
- [Web 会话展示](docs/session-presentation.md)
- [Web 开发验证](docs/testing.md)
- [Kite Web UI Design System](docs/ui-design-system.md)

## 验证与文档影响

`bun run --cwd apps/kite-web test`、`typecheck`、`build`；完整环境用根 `bun run server`，Vite 仅资源开发。构建后 canonical OpenAPI 与 dist/api-docs/openapi.json 应逐字节一致。

用户行为更新对应手册；局部技术变化更新本地专题；跨包变化同时核对[App Server](../../docs/active/app-server-local-runtime.md)与[API 契约](../../docs/active/agent-api-contract.md)。行为不变时记录核对依据，不制造文档修改。
