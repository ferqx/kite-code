# 模型与上下文

模型输入由已提交原历史、上下文选择、来源和冻结配置构造，不等于客户端屏幕。Service 负责实际模型装配，AI adapter 负责传输，中立 Loop 不持有另一套业务完成状态。

| 专题 | 负责范围 |
| --- | --- |
| [模型循环](../flows/model-tool-cycle.md) | 当前机制与局部验证 |
| [AI](../../../packages/ai/README.md) | 当前机制与局部验证 |
| [上下文选择](../../../packages/agent/src/storage/sqlite/context/README.md) | 当前机制与局部验证 |
| [完整请求检查](../../../packages/agent/src/model-body/README.md) | 当前机制与局部验证 |

从实际 owner 深入代码与测试，跨模块变化再查[契约目录](contracts.md)。历史通过、源码存在和定向测试均不代替当前客户端全过程或平台发布资格。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/subsystems/model-context.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
