# 工具与扩展

工具声明、能力目录、授权、实际派发、结果呈现与 required 条件分别核验。业务扩展共用唯一 Loop 与受控 operations，不取得 SQL、owner 或原始运行时状态。

| 专题 | 负责范围 |
| --- | --- |
| [工具表面](../../../packages/agent/src/model-tools.README.md) | 当前机制与局部验证 |
| [扩展契约](../../../packages/agent/src/extensions/index.ts) | 当前机制与局部验证 |
| [Files](../../../packages/agent/src/tools/files/README.md) | 当前机制与局部验证 |
| [Shell](../../../packages/agent/src/tools/shell.README.md) | 当前机制与局部验证 |
| [Task](../../../packages/agent/src/extensions/task/README.md) | 当前机制与局部验证 |
| [MCP](../../../packages/agent/src/mcp/README.md) | 当前机制与局部验证 |

从实际 owner 深入代码与测试，跨模块变化再查[契约目录](contracts.md)。历史通过、源码存在和定向测试均不代替当前客户端全过程或平台发布资格。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/subsystems/tools.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
