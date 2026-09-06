# 客户端接入与展示

TUI 使用 Native Runtime 和终端投影，Web 使用 Public REST 与页面状态；共享结果语义，不共享全部操作、刷新或渲染机制。

## 深入顺序与协作

| 专题 | 负责说明 |
| --- | --- |
| [TUI 模块](../../../apps/kite-cli/README.md) | 导航、投影、输入、终端 |
| [Web 模块](../../../apps/kite-web/README.md) | 路由、请求、更新与诊断 |
| [Native 接入](../../../packages/kite-local-runtime/docs/native-client-and-control.md) | 配对、App Control、transport |
| [Public API](../../../packages/agent-api-contract/docs/public-wire.md) | Browser DTO 与生成规范 |
| [Web 链路](../flows/web-queries.md) | 分页、条件更新与错误 |

从对应专题读取实际代码与测试。只有发生跨模块影响时扩读其他主题；准确约束见[契约目录](contracts.md)，不要在本页复制接口和不变量。
