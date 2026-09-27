# Agent Note: 受确认 Tool 调用的 Host Shell 可用性降级

Status: implemented

## Problem
PS-02 把原生 sandbox preparation、spawn 与 cleanup 收敛到受治理 Provider seam，并正确保留
Darwin `seatbelt_descendant_containment_unproven`、Windows
`windows_handle_relative_runtime_cleanup_unavailable` 等平台证据缺口。此前 App composition 把这些
pre-dispatch unavailable 结果直接投影为 Shell 拒绝，导致已经通过 Policy、approval、Tool attempt ack 的
普通 Workspace 命令（例如 `git log`、`git status`）仍无法运行。

用户要求当前受信任 Workspace 的常规工作默认可用，只有独立 Policy 识别的非常高危操作继续兜底拒绝。
同时不能把“sandbox 不可用”误写成 native qualification，也不能在用户命令可能已经启动后重放命令。

## Decision
1. TUI 与 foreground CLI 的 App composition 恢复显式 `host_shell` 可用性模式。它只服务已经经过
   Tool Pipeline Policy/approval、durable invocation/attempt acknowledgement 的 Shell 调用；直接调用
   App executor、缺少 Runtime identity 或缺少 lifecycle 的请求仍拒绝。
2. 以下两类状态可以在用户命令启动前选择 host Shell：
   - startup discovery 没有 backend、sandbox 被显式关闭、backend discovery 失败或 native executor
     构造失败；
   - 已选 native Provider 返回 typed `backend_unavailable`，并同时证明
     `stage=pre_dispatch` 且 allocating abandonment/cleanup receipt 已 durable 确认。
3. native command 一旦可能启动，或遇到 non-zero exit、timeout、cancel、runner failure、cleanup unknown、
   disposal/receipt failure，绝不切换 host Shell，也不重放命令。Host interpreter 启动后失败同样不再换环境
   重放用户脚本。
4. Host fallback 不扩大 Tool Policy：critical/destructive path、phase、Shell surface、network allowlist、
   explicit capability ceiling 等独立拒绝继续生效。`accept_edits` 或 exact approval 只解决对应普通调用的
   授权，不得覆盖这些高危兜底规则。
5. Host fallback 是 unisolated availability，不是 Seatbelt/bubblewrap/restricted-token 证据，不改变
   `productionSupported=false`、空 production support set 或 [Agent Note 0116](../process/2026-08-18-ps02-github-actions-native-evidence-authority.md) 的原生证据规则。
6. 该决定不改变 Workspace filesystem Provider、typed Git、MCP、Skill 或其他进程 capability，也不改变
   Runtime schema/format epoch。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
- 当前受信任 Workspace 中已获准的常规 Bash 命令不会再仅因本机原生 sandbox backend 缺少资格而失败。
- App 必须消费结构化 pre-dispatch/cleanup authority，禁止从 stderr 文本猜测是否可降级。
- PS-02 native fail-closed conformance 仍然有效：Local Provider 继续如实返回 unavailable；只有它外层的 App
  availability composition 在完成 abandonment 后选择 host Shell。

## 替代关系
本记录 恢复并收紧 [Agent Note 0077](../simplification/2026-08-08-unified-sandbox-startup-downgrade.md) 的 startup availability 结论，并替代 [Agent Note 0116](../process/2026-08-18-ps02-github-actions-native-evidence-authority.md) 后续实现中“任何
backend unavailable 都不得选择裸 host Shell”的 App 产品行为解释。[Agent Note 0116](../process/2026-08-18-ps02-github-actions-native-evidence-authority.md) 关于原生 evidence、
production support 与 Provider fail-closed 的决定保持不变。

## Historical relationships

决策者：用户直接指令

相关：[Agent Note 0077](../simplification/2026-08-08-unified-sandbox-startup-downgrade.md)、[Agent Note 0111](../feature/2026-08-18-governed-local-provider-seams.md)、[Agent Note 0116](../process/2026-08-18-ps02-github-actions-native-evidence-authority.md)、[Agent Note 0118](../feature/2026-08-18-trusted-workspace-unrestricted-file-access.md)
