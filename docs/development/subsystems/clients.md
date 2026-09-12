# 客户端接入与展示

TUI 使用 Native Runtime 和终端投影，Web 使用 Public REST 与页面状态；共享结果语义，不共享全部操作、刷新或渲染机制。

开发中的 [Electron 桌面客户端](../../../apps/kite-desktop/README.md)已接入纯 TypeScript Client、沙箱 preload、具名 IPC、Electron main host 与同 build 配套 Service。renderer 和 host 构建及分层测试已经接入；packaged Electron 原生窗口已通过[本机自动验收](../../../apps/kite-desktop/docs/native-validation.md#electron-本机迁移验收)，不扩大 Web 权限。迁移前 Tauri 的原生结果只保留为历史证据。

Web 与桌面共用 [React 会话页面](../../../packages/kite-client-ui/README.md)，端侧入口分别负责协议、路由、宿主与已授权操作；共享页面不拥有执行或传输权威。

## 深入顺序与协作

| 专题 | 负责说明 |
| --- | --- |
| [TUI 模块](../../../apps/kite-cli/README.md) | 导航、投影、输入、终端 |
| [Web 模块](../../../apps/kite-web/README.md) | 路由、请求、更新与诊断 |
| [桌面模块](../../../apps/kite-desktop/README.md) | Electron、preload/IPC、配套服务、开发与验证限制 |
| [Native 接入](../../../packages/kite-local-runtime/docs/native-client-and-control.md) | 配对、App Control、transport |
| [Public API](../../../packages/agent-api-contract/docs/public-wire.md) | Browser DTO 与生成规范 |
| [Web 链路](../flows/web-queries.md) | 分页、条件更新与错误 |

从对应专题读取实际代码与测试。只有发生跨模块影响时扩读其他主题；准确约束见[契约目录](contracts.md)，不要在本页复制接口和不变量。
