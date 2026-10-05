# Agent Note: 恢复申请在宿主私人 Journal 保留原身份

Status: implemented

## Problem

恢复申请可能已经被 Service 受理，但 POST 或原 GET 的回应丢失。仅在内存保存申请会在 CLI/TUI 或 Native main 被强杀后丢失原 command，使新进程无法区分未提交与已提交；重发或换 Store 则可能重复恢复并误用其他会话的权威。UI 文件不能成为 Service receipt，备份恢复也不能重标旧申请。

## Decision

CLI/TUI host 在首次 POST 前持久发布 selected Profile 的 `ui/recovery.json`。闭合 v1 记录只含原 Store/Session/Command、run/report 目标或明确 interrupt 与 caller phase，最多128项、262144 UTF-8 字节；真实 profile-use 与私人数据锁、无跟随单硬链、0700/0600、fsync 与原子 rename 保护发布。损坏、冲突、满槽或无使用权时零 POST，不驱逐 unknown 或已确认记录。共享 UI 只有有限 host port，不读文件。

Native Node main 用既有私人 SQLite owner 完成准确 v1→v2 迁移，增加 `recovery_intents` 表，FULL 与 BEGIN IMMEDIATE 在一 POST 前封存同一闭合原意图。renderer 只有 prepare/submit/lookup/close 等有限 IPC，不能提供 owner/generation/token/path。原 observation 共用 Promise，关闭或切换只释放其读取，不取消业务、覆盖 known 或丢失原 unknown。冷读取验证全部保留行，不能以 SQL phase 过滤掩盖坏记录。

冷 submitting/accepted 作为待核实申请，只显式 GET 原 ID。原 Store/Session 和目标永久保存；查不到回执、bad/丢回执或发生第二次崩溃均不自动 POST。新恢复须重新显式 prepare 和新 command，原 GET 不安装新执行绑定。CLI 已落定 run/report 后继续观察返回的原 Run，处理其真实卡/完整附件直至终态；受理或 waitingInteraction 不冒充完成，Ctrl+C/EOF 只结束当前观察并保持准确配对关闭或共享 detach 语义。

最初的 closed manifest v3 独立加入 `tuiRecovery`，Desktop 一致副本只接受准确 v1 两表或 v2 三表并绑定实际 user_version。旧 closed v2 只按原路径/字段/Desktop v1 读取；新版字段不能放宽旧格式。备份保持原字节和完整 proof，七个实际 SIGKILL complete/rollback 窗口各保对应原或后续 journal。恢复生成新 Store 仍保存旧申请 scope，不成为新 Store 权限。Agent maintenance 不依赖 Desktop/CLI workspace。

## Alternatives considered

- 内存意图：拒绝，真实宿主 SIGKILL 后无法核原 ID。
- renderer 保存或读取私人文件：拒绝，扩大路径/令牌与执行权边界，也不能证明 main 提交前持久化。
- 复用 core schema 存 UI pending：拒绝，请求观察状态不应成为 Runtime 恢复权威。
- journal 满时驱逐 unknown：拒绝，唯一可查原申请的身份不能为后续操作腾槽而丢失。
- 冷启动自动重发或换 Store 重标：拒绝，旧回执与旧效果保持原事实，只查原 ID。
- 将全部 UI 文件纳入备份：拒绝，只收明确白名单与准确格式，coordination/locks/vault 保持排除。

## Consequences

编译 CLI paired/shared 和真实 80×24 TUI 使用默认 Service、固定 loopback SDK、原 Ask 审批、物理已提交响应丢失与宿主 SIGKILL 验证一次 POST、原查询、完整卡及零重复效果。配置了可信 afterTurn policy 的 report fixture 核父 completed、真实 child 与唯一来源 report Run；这个历史 report fixture 不代表默认制品；目前源码外默认Task另有1/164资格，完整默认冷窗口仍按[默认报告提案](../../proposed/architecture/2026-10-03-default-task-after-turn.md)判断。真实 Node Electron main/preload/renderer 另核 Run/report/interrupt、原 Service/main 强杀、known 不降级、原审批继续与准确 Profile 使用权。

Native/CLI/TUI journal 与维护组合的资格仅来自 macOS 隔离开发制品，未取得正式 installed 或 Linux/Windows 资格。128槽是未决请求观察的本地边界，不是累计 Session/Run 历史上限。旧来源的回执 unavailable 保持准确诊断，没有自动修复或 UI 授权。

当前事实与原日志归 [CLI owner](../../../../apps/cli/README.md)、[Native owner](../../../../apps/desktop/README.md)、[维护 owner](../../../../packages/agent/src/maintenance/README.md)与[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。公共恢复投影继续由[原决定](2026-10-03-public-session-interruption-projection.md)指导，私人 journal 不改变其权威。

当前 strict manifest v5保完整普通申请 `callerIntents.v1` 原文件/format/proof，并明确验证 Desktop v3 完整普通 `caller_intents` 表。原v2/v3/v4字段、physicalpath及Desktop版本白名单仍独立闭合，DB3不能标成旧manifest；v5逐行规范hash只验原结构与字节，不重算业务authority。restore到新Store只保原申请，不授权POST。普通Work/steer/follow-up/精确cancel完整body、subject/hash和draft版本的新增宿主决定与真实CLI/Native资格见[完整业务申请](2026-10-03-complete-caller-command-intents.md)；本篇的有限run/report/interrupt恢复journal及Native v2理由继续适用，未整体替代。
