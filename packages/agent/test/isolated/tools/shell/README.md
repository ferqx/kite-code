# Shell Tools

`shell.test.ts` tests pure registration and cancellation-result wording with explicit structural contexts; it does not qualify SQLite authority or process cleanup. Actual default resolver, SDK, SQLite, dispatch ordering, output cursor, guardian assets, macOS process-group stop and original-command replay checks live in `apps/service/test/isolated/shell-configuration.test.ts`. Existing `jobs/shell.test.ts` and root `shell-service.test.ts` remain the supervision and paired lifecycle qualification owners.

`reference-runtime.test.ts` 使用真实临时 SQLite、普通 Runtime/Loop、Shell 扩展和受控 Job（不启动操作系统进程），核缺失 read/wait/stop 引用以失败反馈进入下一份实际 Model 输入，同批独立读取仍成功。错误引用不改变已知原 Job，一次启动、零取消；已尝试 Job 的业务结果未知即使清理已确认也仍为 unknown，结束 Run 且不派发下一 Model。`shell.test.ts` 另核错误记录类型／版本，以及存储错误、无法核实的原操作不会被吞掉。完整 [control 回归](../../execution/control.test.ts)继续核真实 effect 后抛错保持 unknown；这些夹具不授予进程监督或安装客户端资格。

相邻取消回归以原公开 `later` Command 回执和 `originCommandId` 绑定后继 Run，符合直接输入准入；仍核派发前零效果、原取消、旧取消重试与后来 Run 隔离，不依赖已退役的派生业务 Command。
