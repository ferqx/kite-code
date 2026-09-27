# Agent Note: 开发期 Shell 默认广泛只读

Status: implemented

## Problem
已批准的 `git show HEAD:...` 在 macOS Native Shell 中因用户 `.gitconfig` 不在默认读取 roots 而失败。普通工具还可能隐式读取用户配置、动态库或其他工作区外文件。逐命令识别这些依赖无法覆盖通用 Shell 与子进程，且会把沙箱行为绑到不完整的命令白名单。POSIX 启动文件的隐式执行另由非 login Shell 与 `BASH_ENV`/`ENV` 清理控制，和普通文件读取权限是不同问题。

Codex CLI 的 [macOS Seatbelt](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs) 与 [Linux bubblewrap](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/src/bwrap.rs) 实现提供可参考的机制：广泛只读文件视图与独立的可写 roots。Kite 在此基础上保留自己的 Host-control、网络、运行时和发布资格边界。

## Decision
1. 开发期 TUI／foreground CLI 的 Native Shell 默认使用 `broad` read scope。macOS 允许广泛文件读取，Linux 以只读方式挂载主机根目录，Windows direct restricted-token 保持现有普通用户读取能力。宿主 ACL／TCC 仍生效。
2. 读取范围与写入权限正交。非 Full 调用仍只可写 canonical Workspace 与独立 runtime 临时目录；`read_only` 调用不能写 Workspace。广泛读取不授予网络、进程、外部写入或 Full authority。
3. Host-control identity 在 broad scope 下继续不可访问。macOS 不扩大可执行映射 roots，即使另行批准 IP 网络也不开放 Unix socket；Linux 遮蔽 Host-control 根并要求 AF_UNIX syscall filter 可用，否则在用户命令启动前拒绝。网络 namespace 单独不足以隔离主机 Unix socket。
4. 带 release-pinned `ExecutionBoundary` 的封存生产路径继续使用 `restricted` read scope，精确 runtime／已授权外部 roots 与既有 qualification；本决定不扩大当前空的 effectful production support set。
5. Shell 命令继续按 Policy 和交互模式审批。显式外部读取仍作为已知 effect 进入审查；已批准命令隐式读取配置文件时，不再由开发期 Native sandbox 按文件名二次阻断。结构化文件工具保留自己的 path scope。

## 替代范围
- 限定 [Agent Note 0131](../simplification/2026-08-24-whole-workspace-sandbox-admission.md) 中“Workspace 外普通访问由原生 backend 默认拒绝”的开发期 Shell read 部分；Workspace 写入身份、外部写入与封存生产范围不变。
- 限定 [Agent Note 0135](../simplification/2026-08-24-mode-aware-workspace-authorization-boundary.md)、[Agent Note 0136](../simplification/2026-08-24-mode-governed-shell-without-command-allowlists.md) 及旧 Git 专题中把开发期 Shell 的所有外部读取都视为必须扩大 native filesystem scope 的部分；Policy 审批与显式 effects 分类继续有效。
- 不改变历史 Workspace Trust exact metadata grant 的存储及生产期校验。开发期 Native Shell broad read 不再依赖该 grant 才能读取 linked worktree metadata。

## 后果与验证
`git show` 等已批准的普通 Shell 可在宿主权限允许时读取用户 `.gitconfig`，而无需识别 Git 命令。Linux broad bind 可能暴露主机 socket 路径，必须以 seccomp 拦截 AF_UNIX；缺少过滤器时拒绝 broad Native Shell。策略生成与 Provider 接线测试不能替代三平台原生执行及生产资格证据。

## 回滚
回滚须同时恢复开发期 `restricted` 选择、三平台策略与手册说明；不能只针对 Git 或某个命令补名单。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

原始记录 未单独记录后果；其已记录的取舍与限制保留在上文。

## Historical relationships

决策者：用户明确选择“开发期 Shell 默认广泛只读，写入仍限工作区”

现行依据：[执行手册](../../../../docs/handbook/features/execution.md)、[执行边界](../../../../docs/active/execution-boundary.md)、[平台支持](../../../../docs/active/execution-platform-support.md)。本决定只涉及开发期 Native Shell 的文件读取投影；封存生产边界、结构化文件工具、审批与网络仍由上述现行文档定义。
