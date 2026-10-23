# Ordinary Shell Tools

模型侧名称为 `shell_execute/shell_launch/shell_read/shell_wait/shell_stop`，仅声明属性投影为 snake_case。前台执行的毫秒期限为 `execution_timeout_ms`，等待的毫秒上限为 `wait_timeout_ms`；后者默认30000，超时不停止 Job。原 `shell.*` 身份、key、权限、Job 和取消证据合同不变。

`createShellExtension({job})` is a pure factory containing five ordinary Tools and one trusted `shell.command` Job. `shell.launch` calls ordinary `operations.ensure`, then saves an immutable own-record OperationRef. Only the registered Job's `start` may start a process. Import/factory/read/wait never create another manager or restart a cold reference. JSON input contains no cwd, environment, executable or guardian authority.

`shell.read` reads the exact own-record ref through generic scoped `operations.readOutput`; pages have fixed 64-bit output cursors/high water and preserve explicit gaps. `shell.wait` timeout leaves the original Job alive. `shell.stop` saves only a cancel-request receipt and the current durable execution fact; it cannot synthesize stopped from acceptance, leader exit or EOF. Actual supervisor `ended`/`unknown` qualification remains in the Job leaf. Original Command retry is an original operation; a new parent execution cannot rebind the same operation key.

默认宿主装配由 Service 显式选择 macOS host Shell：真实最终权限、固定 Seatbelt 与独占 launchd coalition 覆盖允许 fork／setsid／orphan 的本次子树。原 Job 终态还须完成准确原根 reap、注册清理和 broker 实际 exit/close；完整当前边界及有限历史 evidence 归 [Jobs owner](../jobs/README.md#默认-macos-宿主-shell)。普通 POSIX 工厂的 groupStopped 继续只证明原组，固定 confined 工厂继续 deny-fork。Linux／Windows 当前运行资格按重构计划延后，不从 macOS 结果推定。[Shell 工具测试](../../test/isolated/tools/shell/README.md)分别证明工厂语义与真实 Runtime/SQLite 的引用失败；实际 SDK／guardian 装配证据归 Service 的 `shell-configuration.test.ts`。

本地 `shell/<shell_id>` 记录明确不存在，或记录类型／版本不匹配时，`shell.read/wait/stop` 返回 `failed/shell_reference_not_found`，提示使用原启动回执中的真实 ID。该预查没有启动或取消 Job，普通 Loop 可将失败和同批其他真实结果交给下一次模型纠正。它不重试原命令、不改写目标 Job，也不从反馈字段取得权限。记录读取本身失败、取得原引用后无法核实执行、输出读取或取消异常仍按原未知／失败边界处理，不因错误名称相似而降级。
