# 长任务的执行尝试与冷恢复

[Runtime](../../runtime.ts) 与 [Store](run-resume-operations.ts) 将持久任务意图、可替换的 Model 尝试、已确认效果及进程监督分开。显式 `run.resume` 仍由真实 root 创建主体发起，接管同 Store 的原活动 Run 及其准确子任务闭包；恢复不创建替代任务树。公开 HTTP、Store baseline 和备份格式保持。

## 恢复协议

只读预检核原身份、控制状态、完整 ledger 和当前可恢复 frontier。宿主取得同一 root OS 锁，增加唯一 generation，以受限准备 lease 保留执行权。Runtime 沿父到子核原 spawning Model 的完整工具目录及 capability snapshot，重建可信动态工具 ceiling、原配置、权限交集和 record read-set；全部成功后，最终事务核原组摘要、配置、选择、取消与 fence，才交给普通 owner。失败不部分交接或调用 Provider。

子任务目录从实际 live carrier 和原 parent Execution 链闭合，只加载仍需监督的节点与必要祖先；不遍历已结束的全部子任务正文。准确 `child-start-{carrier}`、原 Command、root work、配置、reference 和 Session/Run 关系进入组摘要，不以最新 Session Run 或有限 View 猜关系。非所选任务的其他 live/unknown 工作仍阻止接管。

| 持久事实 | 恢复动作 |
| --- | --- |
| Model 尚未派发 | 复用完整封存请求与原 Execution |
| Model running/dispatching，或最后一次 failed/incomplete，且没有派生 Tool/Job | 保留 partial 和旧身份；原子结束未闭合尝试，下一请求创建新 Execution 与 retry lineage |
| 完整 Model 与已结算 Tool | 使用完整输出和准确原结果，不重发模型段或已确认效果 |
| 自动压缩 Model 中断、完整摘要尚未发布 | pending 不进入上下文；保留上个已发布点，按普通压缩边界创建新摘要尝试 |
| 压缩已经发布 | 沿原 selected 点读取，不因恢复重复摘要 |
| child queued / dispatching 但尚未激活 | 原 carrier 继续普通槽位和激活事务；不重复登记 child |
| child 已激活 / 已结束但 carrier 未结算 | 原 Loop 继续 / 只承接原结果；原 Run 与 deadline 不变 |
| Tool 提前声明并封存版本化 continuation 合同 | 仅调用可信定义的 `resume`，保留原执行与操作 key；不调用旧 `execute` |
| 普通 Tool 或外部 Job 的效果不明 | 拒绝自动重放，保留核实边界 |

`task.execute` 的 continuation 复用 immutable OperationRef 与幂等创建，再观察准确原 carrier。Core 不按业务工具名称放行；版本须同时匹配原封存来源、Run manifest 和当前可信实现。未声明的旧调用没有这项资格。子审批继续原 Interaction/Execution/attempt，并重新经过当前权限。Auto reviewer 的特殊活动闭包没有据此取得一般 worker 恢复资格。

Host 在父 Loop 重入前把全部原操作登记到同一 operation 目录，共同启动 barrier 之后才进入观察，防止 ensure 再启动 queued carrier。恢复和普通执行共用 Run binding lease、Job 观察、ChildSlots、取消域与 disposer。父 Run 先结束时，后代监督仍持有配置；恢复后的根任务交回同一个持 owner 的普通任务泵，独立后代继续运行期间，同会话新人类任务可以执行。后代及其配置清理由 Host 原目录持有，包含恢复后新建的独立后代；全部落定才允许释放 root owner，终态子只读结果也释放其配置。普通及恢复路径统一在 owner 释放前核 Host 监督寿命和清理失败；晚到 disposer 失败保留原 root 锁并停止调度，不以 terminal ledger 代替清理确认。子 Run 离线时间不暂停 30 分钟期限，已经超期先取消结算，零新模型调用。

## 持久 continuation 与历史成本

每个新 Model 尝试在原 `decision_source_json` 封存 version 1 continuation：原 Run/selection、当前完整来源请求集合和同工具相同参数失败 streak。压缩尝试使用同一状态。超过正文传输阈值时使用既有不可变 sourceBody Artifact，预览不复制 checkpoint。Runtime 从完整原作用域核验并恢复该状态，当前 Model 的 Tool 批次再按声明顺序结算一次；恢复不会重置五次失败规则。没有该字段的旧记录继续完整历史重建，未知版本或范围拒绝。

SQL 首次冷预检仍流式验证全部历史并生成原 canonical 摘要；这项审计随历史线性增长。已验证快照只在同一 SQLite 连接的 `data_version/total_changes()` 都未改变时复用，最多保留一个 frontier。begin 仅提交 root epoch、准备申请与事件后可更新这个快照；最终 commit 先核当前身份/控制，再匹配快照或重新完整审计。任何其他本机写入、peer commit、无 change_event 的 raw SQL 变化都使复用失效。快照不跨进程持久化，不替代最终 CAS，也不以通知 cursor 当历史完整性证明。

这消除正常准备路径的重复全扫描和新记录的旧 Model 正文重读，并未把恢复变成与全部历史或独特来源数量无关的常数成本。当前 frontier 的单次传输和完整 ledger 审计边界仍保留；没有通过新增额度结束长 Run。

## 证据与限制

[单 Run](../../../test/isolated/recovery/run-resume-runtime.test.ts)、[任务组](../../../test/isolated/recovery/run-resume-group-runtime.test.ts)及[连续强杀](../../../test/isolated/recovery/run-resume-repeated-runtime.test.ts)使用所属子进程真实 SIGKILL、实际 SQLite 和独立效果 ledger。任务组覆盖后台必需等待、前台 continuation、多子、排队、嵌套、激活前、已完成子、原审批、超期与配置冲突；未知效果和组漂移另明确使用 SQL 故障注入。原 Run/Execution、结果与 deadline 断言分别判断，不把 accepted 当完成。

[Store](../../../test/isolated/recovery/run-resume-store.test.ts)与[完整历史](../../../test/isolated/recovery/run-resume-history.test.ts)保原 canonical 摘要、事务回滚、准备/最终 raw SQL 漂移与有限分页反例。Windows 当前本机 412 条 Execution 的一次测量：冷校验 17.83ms、未变化快照 0.75ms；它不代表大型历史、RSS 或其他平台的耗时承诺。当前测试不证明实际连续运行数周、任意外部效果自动恢复或全部客户端平台资格。半完成任意 initializer、未知效果、无法准确重建的配置仍需核实。

持久取舍见[执行尝试与监督恢复 Note](../../../../../.agents/notes/implemented/architecture/2026-10-16-durable-continuations-and-group-recovery.md)。
