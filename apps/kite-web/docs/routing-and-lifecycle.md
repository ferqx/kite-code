# Web 路由与页面生命周期

产品入口：[目录与会话](../../../docs/handbook/clients/web/guides/workspaces-and-sessions.md)。源码：[routing](../src/routing.tsx)、[App](../src/app/app.tsx)。

React Router Declarative Mode 管理 `/`、`/sessions/:sessionId` 和 `/api-docs`。会话 URL 只包含 opaque identity，不携带 Workspace digest 或路径。浏览器 back 从 Docs 返回通过 direct Session read 恢复，不扫描所有 workspace page。

document 持有一个生产 transport。route unmount 只停止页面工作，不能注销 browser session；pagehide 才清理。深链接 index shell 能建立相同只读访问，资产和 OpenAPI JSON 请求不创建新 session。

点击目录中的会话或在会话行按 Enter 直接调用 Web 入口、push 会话 URL 并加载目标 History，无二次确认。方向键只移动焦点；浏览器前进／后退仍由 route 驱动。

加载结果绑定当前 generation 和 Session。旧页面/旧会话结果不能覆盖新目标，错误不伪装成空数据。

验证：[routing](../test/routing.test.tsx)、[app lifecycle](../test/app-lifecycle.test.tsx)。

实际测试覆盖与尚未证明的轮询场景见[Web 验证](testing.md)。

## 当前差异：深链接快照优先级

首次直达会话时 App 同时读取目录和 direct Session。当前 [selectedSession](../src/presentation/reducer.ts) 优先使用目录中匹配项，再回退 routeSessionSnapshot；目录为 idle而后到 direct GET 为 running时，较新状态仍可能被遮蔽，[App](../src/app/app.tsx) 因而不启动活动轮询。这不同于尚未明确承诺的 idle外部变化探测：这里已经取得新状态，却没有采用。

需按明确的新旧关系合并同一会话快照，并补目录idle/direct running的深链接测试。现有 [app lifecycle](../test/app-lifecycle.test.tsx) 使用相同状态的快照，未覆盖此竞态。

生产入口 [main](../src/main.tsx) 固定 document 的服务身份，向 transport 注入 [page identity fetch](../src/transport/page-identity.ts)。响应身份不符时显示重新加载提示，route change 不重置该约束；只有新文档从服务取得新身份。
