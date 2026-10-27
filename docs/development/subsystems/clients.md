# 客户端接入与展示

CLI/TUI、Desktop 与 Web 共用公开 Client 和有限展示事实。CLI/Desktop 的可信宿主拥有配套进程、资产与持久原意图；renderer 和浏览器不取得 Store/执行 authority。共享 UI 不扩大客户端的能力。

| 专题 | 负责范围 |
| --- | --- |
| [CLI/TUI](../../../apps/cli/README.md) | 当前机制与局部验证 |
| [通用 UI](../../../packages/ui/README.md) | 当前机制与局部验证 |
| [Desktop](../../../apps/desktop/README.md) | 当前机制与局部验证 |
| [Web](../../../apps/web/README.md) | 当前机制与局部验证 |
| [Client](../../../packages/client/README.md) | 当前机制与局部验证 |
| [Web 查询](../flows/web-queries.md) | 当前机制与局部验证 |

从实际 owner 深入代码与测试，跨模块变化再查[契约目录](contracts.md)。历史通过、源码存在和定向测试均不代替当前客户端全过程或平台发布资格。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/subsystems/clients.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
