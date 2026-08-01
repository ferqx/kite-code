# ADR-0054：生产执行统一采用 sandbox、网络、受保护路径与 worktree 隔离

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Security + Platform，single-maintainer）
关联：D-08、D-09、Phase 1B、ADR-0042

## 背景

逐次审批不能替代进程实际 filesystem/network enforcement；本地 stdio MCP、Skill child 和
shell descendants 也可能绕过只约束内置工具的策略。并发 writer 共用 checkout 会破坏归因和
回滚。

## 决策

1. limited 默认 filesystem=`workspace_write`、network=`off`、protected paths=`deny`。网络只在
   可验证 backend 上按 host allowlist 开启，并在 DNS 与每次 redirect 后重验目标。
2. shell、Skill、本地 stdio MCP 与 descendants 继承同一 filesystem/network/process-tree
   边界；sandbox 或 `ExecutionBoundaryV1` 不可用时禁止进程型/写能力，审批不能恢复。
3. restricted fallback 只允许通过 conformance 的 Workspace-bound 进程内只读工具，且强制
   network=`off`，以新的受限 run 启动。
4. protected paths 至少覆盖 `.git`、Agent/MCP 配置、shell profile、credential/secret 和
   Workspace 外路径；App typed Git/worktree controller 使用独立可审计授权。
5. 前台单会话可在用户选择的 checkout 工作并提供实时 diff/review；后台、定时、无人值守、
   并发或委派 writer 必须使用独立 worktree/branch。
6. remote HTTP MCP 明确位于本地 sandbox 外，使用 endpoint identity、effects、approval、
   egress permit 与 Verification 单独治理。

## 备选方案

- sandbox 失败后回退裸 shell并逐次审批：拒绝，用户确认不能创造技术隔离。
- 所有 writer 共用 checkout：拒绝，无法可靠归因或恢复。
- 只约束内置 shell：拒绝，child/MCP 形成旁路。

## 后果

平台必须以 native deny/allow/process probe 声明支持；不能执行边界的平台会被排除或只提供已验证
的只读 fallback。

## 回滚

可以关闭 network、writer、process capability 或排除平台；不能恢复裸 shell fallback、共享
checkout 并发 writer、protected path 静默放行或把 remote MCP 标成已本地 sandbox 的旧路径。
