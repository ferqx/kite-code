# 会话加载与历史阅读

客户端选择会话后开启所属读取代次，通过公开目录、视图、消息变化与完整正文接口读取原事实。Store 保存原消息及稳定顺序；Service 生成公共投影，Client 核作用域、游标和上界后交给 UI。

实现与局部验证：[Store 历史](../../../packages/agent/src/storage/README.md)、[Client](../../../packages/client/README.md)、[Desktop](../../../apps/desktop/README.md)、[TUI](../../../packages/ui/src/tui/README.md)。

切换、重连和关闭只取消所属 reader；迟到页面不能覆盖新选择。消息正文追加保持原身份，相同文本不能合并不同输入；SSE 观察不取代完整分页和结果读取。实际验收须覆盖加载、持久记录接管、焦点/阅读位置和恢复全过程。

共同约束以[当前八 workspace 边界](../../active/unified-agent-boundary.md)及对应 owner 为准。定向测试、真实客户端过程和平台资格分别说明，不从源码存在或最终截图推定完整行为通过。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/flows/session-history.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
