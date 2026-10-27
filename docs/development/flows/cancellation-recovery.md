# 取消、正常关闭与恢复

取消沿原工作身份进入 Runtime，实际 Model/Tool/Job 各自停止并保存结果；配套 Service 的正常关闭等待 owned 资源 drain。客户端断开、窗口隐藏、明确退出和原任务取消分别处理。

实现与局部验证：[恢复手册](../../handbook/features/recovery.md)、[Runtime](../../../packages/agent/README.md)、[会话恢复](../../../packages/agent/src/storage/sqlite/run-resume.README.md)、[Service 生命周期](../../../apps/service/README.md)。

只有真实停止和结果证明才能确认清理。持久活动 Run 不等于 live owner，冷核实在准确锁及事务内结算；未派发与已尝试效果分别保存。未知效果继续封闭新工作，不自动重放工具、不根据进程消失或超时推定失败。

共同约束以[当前八 workspace 边界](../../active/unified-agent-boundary.md)及对应 owner 为准。定向测试、真实客户端过程和平台资格分别说明，不从源码存在或最终截图推定完整行为通过。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/flows/cancellation-recovery.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
