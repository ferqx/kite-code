# Web 日志、模型上下文与 API Docs

产品入口：[日志](../../../docs/handbook/clients/web/guides/logs.md)、[模型上下文](../../../docs/handbook/clients/web/guides/model-context.md)、[API Docs](../../../docs/handbook/clients/web/guides/api-docs.md)。

[Session log list](../src/components/session/session-log-list.tsx) 展示 closed detail fields，不渲染 raw Store event。logs 按需请求，用户显式刷新，不混入 History polling。

[Model context inspector](../src/components/session/model-context-inspector.tsx) 绑定 Session 与 exact invocation。Overview、System prompt、Messages、Tools、Request settings 由 Browser-only context endpoint 提供；不展示 Artifact identity、Provider options/response、endpoint 或 Credential，关闭后不持久缓存正文。

[API Docs renderer](../src/api-docs/api-docs.tsx) 读取 release-bundled canonical OpenAPI，same-origin、no-credential、no-store。没有表单、Try it 或 execute control，文档存在不提升 principal capability。

精确 JSON 与 hashed asset 不创建 browser session；index shell 才拥有初始化。构建把 canonical OpenAPI 原样放入固定资源路径。

验证：[API Docs](../test/api-docs.test.tsx)、[transport](../test/transport.test.ts)及 Web build 的 OpenAPI 字节比对。

## 当前差异：日志刷新失败

[App.loadSessionLogs](../src/app/app.tsx) 在失败时保留 logEntries，但切换为 error/unavailable；[日志列表](../src/components/session/session-log-list.tsx) 只在 content 时渲染条目，所以已有快照会从界面隐藏。手册要求“保留已读内容并显示错误”尚未兑现；内存数组未清空不等于用户仍能阅读。

修复应保留 stale条目并显示错误，增加首次成功→刷新失败仍可读的测试。已有 [app lifecycle](../test/app-lifecycle.test.tsx) 证明迟到日志隔离，不证明失败保留。

API Docs 当前只渲染方法、路径、摘要和 schema 数量，详情读取同源 `/api-docs/openapi.json`。[渲染器](../src/api-docs/api-docs.tsx) 尚未展示参数和请求/响应结构；现有 [API Docs test](../test/api-docs.test.tsx) 只证明路径可见与无在线执行控件，不能证明完整参考已经呈现。
