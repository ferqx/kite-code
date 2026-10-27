# Agent 决策、执行与完成

旧独立 agent-kernel workspace 已删除。当前唯一 Loop 使用中立模型、输入与执行契约；Run/Execution/Job 和必要条件的最终持久判定归 Agent Store，I/O leaves 只在受控派发边界执行。

| 专题 | 负责范围 |
| --- | --- |
| [唯一 Loop](../../../packages/agent/src/loop.ts) | 当前机制与局部验证 |
| [执行入口](../../../packages/agent/src/execution/index.ts) | 当前机制与局部验证 |
| [Store](../../../packages/agent/src/storage/README.md) | 当前机制与局部验证 |
| [required 条件](../../../packages/agent/src/storage/sqlite/requirements/README.md) | 当前机制与局部验证 |

从实际 owner 深入代码与测试，跨模块变化再查[契约目录](contracts.md)。历史通过、源码存在和定向测试均不代替当前客户端全过程或平台发布资格。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/subsystems/kernel.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
