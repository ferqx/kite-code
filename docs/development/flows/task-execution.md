# 任务提交、执行与终态

CLI/TUI、Desktop 通过公开 Client 保存并提交原完整 Command，Service 解码并交给唯一 Agent Runtime。短命令受理与异步运行分开，模型或工具等待不占控制入口。

实现与局部验证：[Client](../../../packages/client/README.md)、[Service](../../../apps/service/README.md)、[Runtime](../../../packages/agent/src/runtime.ts)、[唯一 Loop](../../../packages/agent/src/loop.ts)、[Store](../../../packages/agent/src/storage/README.md)。

accepted 不等于 applied，applied 不等于模型、工具或整个任务成功。Run 完成依赖原 Execution/Job、required 条件与真实结果；子报告与 UI 状态不能自行补全终态。传输结果未知时只查原 ID，不重发或换身份。

共同约束以[当前八 workspace 边界](../../active/unified-agent-boundary.md)及对应 owner 为准。定向测试、真实客户端过程和平台资格分别说明，不从源码存在或最终截图推定完整行为通过。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/flows/task-execution.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
