# ADR-0047：跨平台 Shell 执行边界与 Windows 非沙箱 Bash

状态：accepted
日期：2026-07-28
决策人：项目所有者（Windows 策略已直接确认）

## 背景

当前 sandbox backend 只支持 macOS Seatbelt 与 Linux Bubblewrap。Windows 返回 `none`，而执行器在 backend 缺失时回退裸 `shellTool`。完全实现 Windows sandbox/Job Object 隔离成本过高，但 0.1.0 仍需要 Windows Bash 可用性。

## 决策

1. Linux/macOS 配置启用 sandbox 时，backend 缺失、失效或能力漂移均 fail closed；不得回退裸 Shell。
2. Windows 0.1.0 正式支持“受控非沙箱 Bash”执行边界：
   - 优先使用从 Git executable 推导的 Git for Windows Bash；
   - 其次使用校验过的 vendored MSYS2 Bash；
   - 排除 WSL stub；
   - 找不到合格 Bash 时拒绝；
   - 禁止回退 `cmd.exe`、PowerShell 或任意 PATH Shell。
3. Windows `accept_edits` 按风险进入审批；`auto` 只允许有限 allowlist；`full` 始终禁止，因为 full 仍要求真实 sandbox。
4. Windows 状态栏、审批和 receipt 持续显示 `Unsandboxed Bash`，审计记录 execution boundary 与 shell kind。
5. 非沙箱 Bash 不授予 authorization，也不替代 Policy、Approval、Deadline、危险路径检查、输出上限或进程树取消。
6. Windows tree-kill 是取消/清理机制，不宣传为 sandbox。无法确认清理时 Session recovery-blocked。

## 备选方案

- Windows 完全禁用 Shell：拒绝，无法满足 0.1.0 的 Windows Bash 可用性要求。
- 为 0.1.0 实现完整 Windows sandbox：延期，复杂度和验证成本超出本轮。
- backend 为 none 时通用 unsafe fallback：拒绝，无法区分平台设计与意外降级。
- 回退 cmd.exe：拒绝，语义、转义和安全边界与 Bash 不一致。

## 后果

- Windows CI 只能声明受控 Bash 兼容性，不能声明文件系统或网络隔离。
- `full` 模式在 Windows 0.1.0 不可用。
- 配置增加显式 Windows boundary policy，项目配置只能收紧。
- Shell resolver、Policy、TUI、CLI、receipt 和测试需要同步更新。

## 回滚

将 Windows policy 设为 deny 即可停止新的非沙箱 Bash invocation。已有 invocation 必须先取消并完成进程树清理。不得回滚到隐式 `shellTool` 或 `cmd.exe` fallback。
