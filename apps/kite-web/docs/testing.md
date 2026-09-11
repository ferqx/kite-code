# Web 开发验证

Web 的更新与路由独立于 TUI；通过终端测试不能证明浏览器行为。会话 UI 与桌面共用 [kite-client-ui](../../../packages/kite-client-ui/README.md)，共享层调整同时执行两端回归。

```sh
bun run --cwd apps/kite-web typecheck
bun run --cwd apps/kite-web test
bun run --cwd apps/kite-web build
```

[routing](../test/routing.test.tsx) 验证路由；[app-lifecycle](../test/app-lifecycle.test.tsx) 验证页面数据、日志/上下文入口和切换后的迟到日志隔离。[transport](../test/transport.test.ts) 验证 REST 快照接入、工具生命周期聚合及派发拒绝与执行失败的区别；[presentation-reducer](../test/presentation-reducer.test.ts) 验证空工作区与迟到 generation 的 History 隔离。API 文档看 [api-docs](../test/api-docs.test.tsx)。

当前测试尚未直接证明页面可见性切换、约两秒轮询调度、单飞请求和增量合并的完整组合行为。产品预期见[更新条件](../../../docs/handbook/clients/web/guides/updates-and-connection.md)，实现见 [App](../src/app/app.tsx) 和 [reducer](../src/presentation/reducer.ts)；源码存在不能替代测试断言。修改这些行为时需补充相应调度、隐藏/返回、失败保留与会话切换场景，不能以普通快照测试已通过宣称轮询验证完整。

构建后比对 dist/api-docs/openapi.json 与 agent-api-contract/generated/openapi.json。旧 bootstrap/目录 API 不应进入产物。完整源码环境使用根 `bun run server`；单独 Vite 只测试资源开发，不声明后端已经启动。

产品页面核对使用确定性非敏感数据。不要让截图、日志或模型上下文包含实际用户凭据。设计系统见[视觉规范](ui-design-system.md)。


2026-09-08 使用两个生产 App 与隔离数据进行浏览器预览：Web 检查深浅主题、常用宽度及 390 × 844 窄屏、目录预览／继续、URL 后退、日志和本地文件链接不可操作；桌面检查常用与最小窗口下审批、输入和停止的布局。预览不证明真实服务执行或原生宿主可用；服务只读权限由既有 Agent API 测试独立核对。

2026-09-08 会话导航纠正：删除标题搜索与预览确认，点击即加载目标会话。以上早期预览／继续的验证记录不再定义当前交互；本次通过两端实际 App 的 HTML 测试数据预览复核直接切换，共享 UI 5 项、桌面 22 项、Web 13 项回归及全仓类型检查通过。系统输入法与 Tauri 原生能力本次未重跑。
