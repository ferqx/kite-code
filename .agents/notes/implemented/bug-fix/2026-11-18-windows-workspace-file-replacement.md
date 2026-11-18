# Agent Note: Windows 工作区文件保留 ACL 的原子替换

Status: implemented

## Problem

程序常用 `ReplaceFileW` 或 `.NET File.Replace` 保存文件。Windows 为保留目标 ACL，需要替换源的 `WRITE_DAC`。原工作区 capability 只允许普通内容写入与删除，即使文件已经释放，替换仍会返回 Win32 5。PowerShell 5.1、PowerShell 7 和 Git Bash 的原生探针均复现。

## Decision

[原生 ACL 层](../../../../native/windows-sandbox-runner/src/acl.rs)为原工作区 capability 加入仅对文件生效的 `OBJECT_INHERIT_ACE | INHERIT_ONLY_ACE`，权限为 `WRITE_DAC`。目录保留原有效权限，并将该 ACE 传递给后代文件。程序因此能在获批工作区范围内完成原子保存。

[工作区准备](../../../../native/windows-sandbox-runner/src/direct_workspace.rs)在原锁内核对文件继承 ACE。已完成的旧账本缺少该权限时，先保存未完成标记，再传播至既有后代，完成后更新标记。重用原 SID 与账本格式，后续完整准备命中时保持热路径。中途取消按原未完成标记恢复。

## Alternatives considered

- 将 `WRITE_DAC` 加入整个工作区的目录和文件权限，会扩大目录 ACL 的可修改范围。采用仅文件生效的继承权限，并用实际目录访问拒绝作为回归断言。
- 只在临时目录生成替换源，需要每个程序提供相应选项。通用文件权限覆盖在目标旁创建临时文件的常见保存方式。
- 将 `ReplaceFileW` 失败转换为移动或忽略 ACL 合并错误，会改变程序选择的保存语义。保留原系统调用及目标 ACL。
- 为默认命名管道添加用户 SID 到令牌的限制集合，会同时允许用户有权写入的区外文件。管道兼容性继续受现有范围和对象 ACL 约束。

## Consequences

工作区内文件的 ACL 可随原获批文件写入一起调整。目录、工作区外对象和只读 Job 继续受原执行范围限制。持有句柄且未共享删除仍返回 Win32 32，释放后可保存。

[真实三后端回归](../../../../packages/agent/test/isolated/jobs/windows-file-replace.test.ts)核已存在和新创建的文件替换、原 ACL 字节、源文件消费，以及目录、区外文件和只读 Job 的 `WRITE_DAC` 拒绝。Cargo 回归核旧账本升级和热路径免重写。当前用户行为归[执行与结果](../../../../docs/handbook/features/execution.md)，平台事实归 [Windows active](../../../../docs/active/windows-shell-sandbox.md)与 [Jobs owner](../../../../packages/agent/src/jobs/README.md)。
