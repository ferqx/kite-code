# Agent Note: Shell 按单次审批绑定独立写入和网络范围

Status: implemented

## Problem

用户确认的请求批准允许工作区写入、外部写入与联网需要审批，Auto 由模型审查，Full 保极危险拒绝。正式 Shell 之前非 Full 已允许 IP，却不能因准确批准而写外部；界面又把 `accept_edits` 改写为严格 `ask`。只分析命令名称不能证明任意脚本、解释器或子进程的完整副作用。

## Decision

参考 Codex CLI 固定源码 [Bash 解析](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/shell-command/src/bash.rs)、[执行策略](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/core/src/exec_policy.rs)与[Seatbelt](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/sandboxing/src/seatbelt.rs)的分工。有限字面量 Bash AST 和固定危险扫描分开；复杂命令不取得“已证明只读”资格。危险扫描按源序保留字面量 `cd` 的可能目录，内部 subshell 不把目录变化传给外层；条件或失败不能丢弃原目录，末尾 pipeline 保留父 Shell 执行的可能性。超过分析预算直接失败关闭。OS 执行范围负责未知后代的实际越界拦截，不按失败后扩大权限重放。

正式 `shell.launch` 的可选 `permissions` 只请求独立的 filesystem/network tuple，同一请求传到普通 `shell.command`。Core 原人工/模型决定和最终 SQL 接纳保持唯一 authority；Agent 独立权限模块仅从最终接受快照读取 scope，父子逐维求交；Service 只注入已校验宿主事实。摘要绑定命令、范围、环境、执行/解析资产及配置；Full 先核固定拒绝，再取得普通 host 范围。正式权限从类型、HTTP/IPC、持久控制、Client 和用户入口统一为三选一，退役第四种 raw `ask`；旧输入和旧控制记录失败关闭，不按兼容映射扩大权限。旧严格模式的独立审批/零效果场景迁到真正 Auto 审核的 `ask_user` 决定或确实需要人工审批的请求批准调用。`web_fetch` 消费原 network 能力的同一授权流程，原网络政策与 SSRF guard 保留。

冷恢复沿原 Store 的同一提交事务移交待派发目标、其已终结的审核承载记录及唯一审核 Model 的 owner generation。移交前核原 purpose、source/input/request/digest、子 Run/Command、Store/root-work 与原代次，逐条 CAS；任何失配使整个事务回滚。审核身份、正文/hash、原结果与决定保持，不增加 grant、不重跑 Provider，也不放宽最终 generation 相等校验。这是从旧严格测试迁入真实 Auto 后暴露的实际恢复缺口；已失败审核仍保原 unavailable 与独立人工决定。

新决定部分替代[未知 Shell 的固定人工审批](../bug-fix/2026-09-01-uncertain-shell-requires-exact-approval.md)和[Auto 先审核](../bug-fix/2026-09-17-auto-review-uncertain-shell.md)中的旧模式矩阵、未知命令一律人工及准确批准不能开放请求范围的结论。Auto 的真实三态审核、准确单次身份、硬拒绝、持久队列、恢复零重放和实际沙箱限制仍适用；旧 Kernel 历史实现不能反推当前正式产品模式。

## Alternatives considered

- 根据名称或正则完整识别互联网/只读/写入：动态参数、解释器、重定向和子进程无法可靠证明；不作为授权边界。
- 每个不透明脚本永久交人工：违背已确认的工作区自动写入和 Auto 先审核；保留有限固定危险拒绝后由实际沙箱限制。
- 获准后整场会话切 Full，或首次拒绝自动扩权重跑：把一次批准扩大成其他调用权限，且可能重复已有部分效果；采用准确调用绑定与原最终 revalidation。
- 为旧严格 `ask` 保留第四种产品模式：用户确认仅三策略，且旧数据无需兼容；保留安全断言并迁移真实调用者，不能以测试依赖延长旧入口。
- 放宽恢复时审核与目标的代次相等校验：会弱化原 Store 因果和 fencing；采用同事务核原来源后准确移交，原校验继续生效。
- 用 Bash AST 验证 Windows 原生命令：语法与后端实际不满足，继续失败关闭和原门禁。

## Consequences

权限与 Shell 分析的模块归属已按用户确认迁到 [Agent 独立模块](../../../../packages/agent/src/permissions/README.md)，Service 仅接口、身份校验和装配；本 Note 的三策略、单次范围、危险拒绝与恢复理由保持，归属理由见[独立权限模块决定](2026-10-11-agent-permissions-module.md)。

macOS 正式入口已验证工作区写入无人工卡、外部写入与联网独立批准/拒绝且审批前零效果、真实 Auto 拒绝与公开原因、三策略的固定危险拒绝及 Full 普通范围。正式权限类型、HTTP/IPC、持久控制、Client 和 CLI/TUI/Native 调用者只保三种策略；原严格场景迁到真实 Auto 的 ask_user 或确有人工要求的请求批准调用，安全断言保持。

本次原完整默认回归通过，定向与完整证据、真实失败及必要修复见[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11shell-三策略与旧模式退役)。当前合同归[产品手册](../../../../docs/handbook/features/tools-and-approvals.md)、[Service](../../../../apps/service/README.md)、[Jobs](../../../../packages/agent/src/jobs/README.md)和[Store](../../../../packages/agent/src/storage/README.md)。

固定危险扫描不证明任意动态脚本完全安全，未知命令仍由系统范围约束，越界失败可能已有其他部分效果，不能扩权重放。Full 保 Runtime authority 与资产保护。Linux 使用同一范围源码和原生 CI 用例，实际内核执行尚未验证；Windows 正式 Shell backend 缺口继续失败关闭。RSS 真失败、完整观测缺项及 V1.3 阶段退出仍未闭合，剩余资格见[切片](../../../../docs/plans/shell-permission-scopes.md)。
