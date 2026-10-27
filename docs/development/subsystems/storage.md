# 持久化与恢复

Agent Store 保存原 Command、Run、Execution、消息与业务记录，具名事务裁决准入和结算；完整正文由准确 scope 的不可变 Artifact 保存。只读观察不能自动修复、补结果或恢复派发权。

| 专题 | 负责范围 |
| --- | --- |
| [Store](../../../packages/agent/src/storage/README.md) | 当前机制与局部验证 |
| [Artifact](../../../packages/agent/src/artifacts/README.md) | 当前机制与局部验证 |
| [会话核实与恢复](../../../packages/agent/src/storage/sqlite/run-resume.README.md) | 当前机制与局部验证 |
| [离线维护](../../../packages/agent/src/maintenance/README.md) | 当前机制与局部验证 |
| [取消链路](../flows/cancellation-recovery.md) | 当前机制与局部验证 |

从实际 owner 深入代码与测试，跨模块变化再查[契约目录](contracts.md)。历史通过、源码存在和定向测试均不代替当前客户端全过程或平台发布资格。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/subsystems/storage.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
