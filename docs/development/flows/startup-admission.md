# 启动与准入

客户端先固定明确 Profile、Workspace、候选与所需资产，再启动或连接对应 Service。正式入口由根 `agent/tui/desktop/server` 选择新 Terminal/Native；开发入口显式选择独立 development profile。

实现与局部验证：[启动与资产](../local-development.md)、[Service bootstrap](../../../apps/service/src/bootstrap.ts)、[配套进程](../../../apps/service/src/paired.ts)、[CLI 宿主](../../../apps/cli/README.md)。

私有启动握手只证明所选子进程和资产准入；Client 的 Service 身份、公开能力及 Store 仍需核实。help/严格参数拒绝先于 Profile 与 Provider I/O。缺资产不回退旧路径，连接成功不授权工具。

共同约束以[当前八 workspace 边界](../../active/unified-agent-boundary.md)及对应 owner 为准。定向测试、真实客户端过程和平台资格分别说明，不从源码存在或最终截图推定完整行为通过。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/flows/startup-admission.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
