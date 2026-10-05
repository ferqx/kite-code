# Agent Note: 显式 profile 恢复保留来源并在稳定维护锁内核实 journal

Status: implemented

## Problem

从较早副本恢复，不能证明副本中 accepted/planned 状态的工作尚未在原系统执行。目录切换中断还可能让普通入口建出空数据库或绕过旧锁。跨 Store 的旧任务来源、备份后发生的外部效果与媒体读取权限都不能用改标 ID 解决。V1.3 §23.4/R01/R07 要求新 Store、来源保留、保留旧目录、可核实的 journal，以及整个切换使用同一外部锁。

## Decision

备份与严格关闭边界见[离线备份决定](2026-10-02-offline-profile-backup.md)。

已交付 [maintenance restore](../../../../packages/agent/src/maintenance/README.md) 的有限目录切换与核实边界。显式 restore 绑定观察 Store、准确备份清单与 replace intent，在同一个稳定 profile-use 排他锁内准备并验证候选、生成新 Store、保留旧目录、发布候选、验证及完成 journal。普通入口看到未完成 journal 拒开，不初始化替代库。

journal 仅有 prepared/old_moved/published/verified 四个持久步骤，记录生成目录名、原/new Store、profileAccessKey、完整目录内容/权限摘要和已选备份。显式 complete/rollback 必须绑定观察 restoreId/digest，并核对准确目录内容与数据库身份；不靠目录存在猜测。旧目录和未采用候选均保留，不先删当前数据。

候选新 Store 使旧写上下文与旧 SSE 起点失效。所有原业务 ID、origin、已完成 receipt 和 namespace 原文保持原值；旧 accepted 工作 needs_review、活动 Run interrupted、旧 planned/dispatching/running Execution outcome_unknown、pending interaction cancelled，owner 解除并增加 generation。旧 planned 不作为未执行证明。只有准确恢复 root 的 session.create 原来源与当前 Store 不同范围，旧来源 Execution 不阻塞新 Store owner；普通同 Store recovery 的跨来源 unknown 和新 Store 当前来源 unknown 都继续阻塞。执行入口仍拒绝旧来源或缺 key 的不可核实操作。

当前 Store 准入与历史原出处分别核实。目录和原始导出保留原 root，Model input/output 私有 snapshot 从真实 Execution 链取得 origin，公开 snapshot 仍表示当前 Store。正文先按当前 Store 查询准确原 ref/session/subject/scope，再核原 Execution/Run/Command/rootWork/child carrier 来源一致和完整 hash/size；旧引用不改标。Artifact 发布仍要求当前来源，不能向旧 Execution 登记新 Store 引用。Fork、压缩和新明确 Run 可以读取原历史，但不由此取得旧工作执行资格。

## Alternatives considered

- 先删除当前 profile 再复制：失败或崩溃会丢失当前数据，不采用。
- 将 SQL 锁或 profile 内锁作为目录替换的全部维护权：锁对象可能随目录移动，无法保护普通入口初始化，不采用。
- 复原旧 Store ID、批量改标 Command/Execution/namespace origin：会给旧副本工作新的执行资格或接受丢失事实的重试，不采用。
- 只凭 journal 阶段或目录存在完成/回退：无法核实相邻文件改名与 journal 更新窗口，不采用。
- 一般忽略所有 cross-Store outcome_unknown：会放宽原同 Store recovery 门禁；仅使用原 root 创建来源范围，不新增持久 eligibility bit 或表。

## Consequences

restore 是明确数据回退，不能代替无损代码降级或外部效果回滚。当前v2候选包含数据库、引用媒体和明确采集的原config/Desktop UI/TUI JSON；旧目录整体仍保留。UI草稿和creation原Store、ID、scope及phase不改标，cold只读不自动提交。TUI 原 Decimal64 revision、完整文本和原 scope ID 逐字节保留，恢复后的新 Store 不获得旧草稿的发送资格。未采集的私有文件和独立凭据vault仍不迁入，完整客户端与发行平台资格仍需后续完整目标交付；离线 CLI 已要求准确原 Store、备份及明确数据回退确认，journal 核实也绑定原观察摘要，本 Note 不宣称完整 W19 恢复已经完成。

[恢复测试](../../../../packages/agent/test/isolated/maintenance/restore.test.ts) 实际第二进程/SIGKILL覆盖持久 prepared、旧目录移出与 journal 更新前后、候选发布与 journal 更新前后、verified 和 journal 删除后仍持锁的窗口。普通入口先 busy、强杀后未完 journal 拒开；完成后取得完整新 Store。篡改原目录、错观察摘要均无法核实通过。冷读无 Model，旧 origin/缺 key 不执行，新明确工作完成；备份后真实 Tool 写外置 ledger 一次，恢复后旧 Store 重试未增加计数。备份/恢复/同 Store recovery/取消组合 28 项、306 断言通过。后续恢复读取、child、完整媒体、导出、压缩和维护恢复组合 67 项、887 断言通过；最终发布守卫收紧后受影响 14 项、189 断言复验通过。源码树外完整 manifest 1/48 通过，实际 HTTP 在新 Store 读取原媒体，冷读不调用 Model。类型、边界、文档与测试归属通过。后续v2配置/UI资产以实际Node私有库和七个携资产的强杀窗口验证；跨媒质电源故障、安装与三平台结果仍未证明。
