# 授权、沙箱与用户交互

权限策略与 Shell 分析归 Agent 独立权限模块，Service 注入可信宿主事实，最终执行仍复核原策略与 control revision。UI 只提交原用户意图；信任、能力、明确拒绝、取消和 unknown 分别限制执行。

| 专题 | 负责范围 |
| --- | --- |
| [权限 owner](../../../packages/agent/src/permissions/README.md) | 当前机制与局部验证 |
| [交互链路](../flows/interactions.md) | 当前机制与局部验证 |
| [Job 与平台范围](../../../packages/agent/src/jobs/README.md) | 当前机制与局部验证 |
| [授权契约](../../active/authorization.md) | 当前机制与局部验证 |

从实际 owner 深入代码与测试，跨模块变化再查[契约目录](contracts.md)。历史通过、源码存在和定向测试均不代替当前客户端全过程或平台发布资格。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/subsystems/security.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
