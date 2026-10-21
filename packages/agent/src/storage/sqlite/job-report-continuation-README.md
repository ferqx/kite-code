# 暂停后原结果继续资格

[continueHumanWork](job-report-continuation.ts)只由 `decideHumanInput` 在保存准确 raw input、已应用 continue 决定、工作选择与 control revision 的同一事务中调用。`assertHumanWorkContinuable` 在控制决定前复核原工作停止边界、unknown 和现有 execution group fence；晚到的继续不能降低这些边界。没有另一个公开工具、Store 写 API 或订阅调度器。

新 `agent_completion` 在封存订阅时记录当时 `workControlRevision`；后来的暂停/替换/停止使原订阅必须经过新准入，不能仅凭最新 continue 绕过失效 future proof。旧 after_turn 订阅保持原合同。原 carrier 的 `after_turn_json`、child.start 或可信 input.follow_up、配置、期限和执行事实保持。每项私有 `job.report.qualification` 唯一引用真实 continue 决定、carrier、准确启动 Command/digest、有限完成订阅 digest 和当时 control revision。尚未结算的 carrier 没有 result revision，资格不填未来 revision，也不授权重建 child 或重做效果。可信 follow-up 必须核私有 source/carrier、准确前驱 Run、原 child、Store/rootWork/selection；任意普通 follow-up 不取得资格。

已有未接纳结果，或未来 carrier 在原终态事务结算时，沿同一唯一结果键生成 `job.report.continue`，指向原 report 和资格。旧 rejected/suppressed report 不改回 accepted，已保存 suppression 回执保持历史。若原报告刚在同一结算事务形成，新的私有准入接手处理绑定，原报告耐久记为 continuation_admission。原 carrier 只登记一次终态结果。

最终接纳重新读取准确来源、原订阅、continue 决定之后没有新的暂停/替换/停止、当前工作选择、Rewind、必要条件、通知授权与 fence。对原 work_paused 结果，只在这一最终事务里临时恢复 pending，再调用现有 `consumeJobResult`：真实接收 Run、Source、consumed 与 report ack 同一事务提交，失败整体回滚。以后作为后代报告祖先读取已应用准入时，要求准确 Source 回执和历史结果键，不把后来的控制变化篡改成此前未消费。

Runtime 沿原配置 lease 和准确 `originalReportCommandId` 转移绑定；冷事实不能重建 Provider。继续时通知接纳资格与原 child 是否还能运行、父是否可派发各自复核。

[真实 Runtime/SQLite 测试](../../../test/isolated/business/task/collaboration-continuation.test.ts)覆盖已有 suppressed 结果与尚无结果两路径、结果形成前/消费后重复继续唯一 Source、原订阅不变和 child 一次、准入 INSERT 故障后决定/资格整体回滚及原 raw input 保留、真实停止拒绝继续、复用 child 的第二轮可信 follow-up，以及破坏 future proof 后原报告准确 continuation_required 且零 Source。unknown 用例在真实 carrier 上注入隔离 SQL 状态，证明准确决定门禁且保留 result/revision/订阅事实；它不宣称真实进程崩溃恢复。此文件不构成 SIGKILL/跨平台资格。
