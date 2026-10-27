# 会话与执行协调

会话与原工作由 Agent Runtime/Store 拥有，Service 负责可信装配和公开请求；Client 与 UI 只保存原意图及读取代次。连接、导航和持久执行状态分别处理。

| 专题 | 负责范围 |
| --- | --- |
| [任务提交与终态](../flows/task-execution.md) | 当前机制与局部验证 |
| [会话与历史](../flows/session-history.md) | 当前机制与局部验证 |
| [Agent Runtime](../../../packages/agent/README.md) | 当前机制与局部验证 |
| [Store 事务](../../../packages/agent/src/storage/README.md) | 当前机制与局部验证 |

从实际 owner 深入代码与测试，跨模块变化再查[契约目录](contracts.md)。历史通过、源码存在和定向测试均不代替当前客户端全过程或平台发布资格。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/subsystems/sessions.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
