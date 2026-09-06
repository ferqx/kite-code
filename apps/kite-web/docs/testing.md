# Web 开发验证

Web 的更新与路由独立于 TUI；通过终端测试不能证明浏览器行为。

```sh
bun run --cwd apps/kite-web typecheck
bun run --cwd apps/kite-web test
bun run --cwd apps/kite-web build
```

[routing](../test/routing.test.tsx) 验证路由；[app-lifecycle](../test/app-lifecycle.test.tsx) 验证页面数据、日志/上下文入口和切换后的迟到日志隔离。[transport](../test/transport.test.ts) 验证 REST 快照接入、工具生命周期聚合及派发拒绝与执行失败的区别；[presentation-reducer](../test/presentation-reducer.test.ts) 验证空工作区与迟到 generation 的 History 隔离。API 文档看 [api-docs](../test/api-docs.test.tsx)。

当前测试尚未直接证明页面可见性切换、约两秒轮询调度、单飞请求和增量合并的完整组合行为。产品预期见[更新条件](../../../docs/handbook/clients/web/guides/updates-and-connection.md)，实现见 [App](../src/app/app.tsx) 和 [reducer](../src/presentation/reducer.ts)；源码存在不能替代测试断言。修改这些行为时需补充相应调度、隐藏/返回、失败保留与会话切换场景，不能以普通快照测试已通过宣称轮询验证完整。

构建后比对 dist/api-docs/openapi.json 与 agent-api-contract/generated/openapi.json。旧 bootstrap/目录 API 不应进入产物。完整源码环境使用根 `bun run server`；单独 Vite 只测试资源开发，不声明后端已经启动。

产品页面核对使用确定性非敏感数据。不要让截图、日志或模型上下文包含实际用户凭据。设计系统见[视觉规范](ui-design-system.md)。
