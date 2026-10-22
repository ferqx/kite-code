# 长任务的执行尝试与冷恢复

[Runtime](../../runtime.ts) 与 [Store](run-resume-operations.ts) 将持久任务意图、可替换的 Model 尝试、已确认效果及进程监督分开。显式 `run.resume` 由真实 root 创建主体接管同 Store 原 Run 及其准确子任务闭包；状态核实后的原私有边界可参与该验证，不创建替代任务树。API major、format major 1 和原 baseline 保持；0002-recovery-audit 与 0003-session-reconciliation 是闭合增量迁移，备份按实际迁移链核 schema/checksum。

## 会话恢复时的状态核实

[session-reconciliation](session-reconciliation.ts) 与[公共 SQLite owner](../../sqlite.ts)提供独立 `reconcileSession`。调用者绑定原 Store、主体、root 和观察 generation；先核整个原 generation 执行组，无遗留活动／未派发边界直接 unchanged。有工作时必须真实观察并取得同一原 OS 排他锁，事务内再次 CAS 后才 fence。持有／冻结 owner 返回 owner_held；锁文件缺失／检查错误不当成死亡。核实不创建普通 owner，不调用 Provider、Tool、Job 或授权器。

| 原执行组事实 | 核实后公开状态 |
| --- | --- |
| 活动主／子 Run | interrupted、inactive，原因 owner_lost |
| 已尝试 Model | failed，保原片段与身份 |
| 已尝试但结果不明的 Tool／Job／child carrier | outcome_unknown，保原效果边界 |
| 原 owner 未派发的 Model／Tool／Job／排队子 carrier | cancelled，原因 owner_lost_before_dispatch，不保假队列 |
| 相关 pending／answered、尚未 accepted 的 Interaction | cancelled，保答案、revision 和 accepted decision 事实 |
| 准确关联原 child／Execution 的 accepted 启动命令 | needs_review，独立新输入不按同根关系误取消 |
| 已完成结果与已结束 Run | 保持原状态和正文 |

0003 私有 `session_reconciliation` 每个 root 最多保一个版本化 checkpoint，绑定原 Store、结算 Command、fence generation、组 Run、Session control／selection／stop、业务命令边界、准确原行与结算后完整摘要。闭合字段、版本、scope、唯一身份和 digest 均验证。普通 View 读取真实结算状态，不把 running 隐藏在公共投影。仅标题重命名不改变执行边界：校验原 v1 checkpoint 时按同 Store／主体、已落定且控制修订连续的 rename 命令扣除其准确修订增量；不重写 checkpoint，也不忽略其他控制、选择、停止或删除变化。

显式 `run.resume` 预检／准备页仅在 SQL savepoint 临时叠加原 frontier，读后 rollback；最终 commit 在同一外层事务核 lease、结算行摘要及全部原恢复条件，通过后才还原并交普通 owner。未声明安全 continuation 的 unknown 仍拒绝，已确认效果不重放。显式放弃、取消、相关新工作或选择漂移使边界失效；旧 generation 不能再写。恢复 lease 的准确 generation 变化同步 snapshot，普通读不写入；原 accepted decision 不清除。

明确发送新的独立任务或公开后续输入时，后端先通过只读准入核对原 Store、主体、root、前驱与上下文，再自动核实遗留 owner。活 owner 不被抢占，正常 owner 交接的 CAS 变化有限重读；已落定原回执直接返回。旧快照的 `input.steer` 也先校验原目标并核实 owner；核实使原目标终结时准确拒绝，不能改为新任务或闭合旧 frontier。核实后，[Runtime](../../runtime.ts)核完整原 Model 输出与准确 Tool call，提供私有历史证明；[新任务受理](reconciliation-admission.ts)在原 accept／human-register 事务中复核 checkpoint、generation、原 owner 已释放与没有真实 unknown，补齐已保存为未执行的原 Tool 结果消息，再删除旧边界。它不恢复或执行旧 Tool，不把未配对调用传给下一 Model。未知效果或漂移在新 Command 受理前拒绝，原历史／checkpoint 保持；公共请求不能提供这项证明。崩溃前已受理但未开始的新任务，按原 ID 再提交也必须先闭合该历史；原已应用回执仍只读返回。私有 checkpoint 尚在时，普通 owner 准入拒绝，后台调度不能绕过闭合。显式放弃恢复同样沿准确原 frontier 完成既有工具历史闭合。[真实协议回归](../../../test/isolated/recovery/history-followup-runtime.test.ts)核 inline／sealed 原输出、直接新任务、一次新效果、原消息配对、同 ID 幂等和旧 Run 不再接续。

备份保存 checkpoint；恢复成新 Store 删除全部 checkpoint，旧来源不借它执行。GC 随准确 root 范围删除，安全导出白名单排除私有表。readonly 0001／0002 不强制升级，写迁移与 bundle 包含 0003。此机制证明原 owner 已释放和持久边界，不证明任意外部进程／副作用结束。

[真实任务组 SIGKILL](../../../test/isolated/recovery/run-resume-group-runtime.test.ts)核多子、排队、原审批的结算与同身份接续；[Store 反例](../../../test/isolated/recovery/run-resume-store.test.ts)核 held／缺锁、漂移、unknown、回滚和安全边界。[Native 实际交接](../../../../../apps/desktop/test/isolated/native-session-reconciliation.test.ts)核 Service／Client／Controller、冷读与零重放。持久取舍见[Note](../../../../../.agents/notes/implemented/architecture/2026-10-22-session-state-reconciliation.md)。

## 恢复协议

只读预检核原身份、控制状态、事务恢复证明及当前可恢复 frontier。宿主取得同一 root OS 锁，增加唯一 generation，以受限准备 lease 保留执行权。Runtime 沿父到子核原 spawning Model 的完整工具目录及 capability snapshot，重建可信动态工具 ceiling、原配置、权限交集和 record read-set；全部成功后，最终事务核原组摘要、配置、选择、取消与 fence，才交给普通 owner。失败不部分交接或调用 Provider。

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

有Artifact宿主的新Model在原 `decision_source_json` 封存version3 continuation：原Run/selection、[完整来源请求增量链](../../source-request-journal.ts)的准确链头和同工具相同参数失败streak。每批只发布首次出现的完整输入，后续Model/摘要/重试不重复保存累计输入；压缩不清除早期请求。恢复按原顺序完整核链的Artifact metadata/hash/size、Store/Session/subject/Workspace/Run、重复输入与无环关系；可信Model封存链头不由Provider opaque continuation或扩展Artifact提供。热Model共享Core冻结值，host每次capture得到独立输入副本；现行captureBatch仍保一个完整准确集合，不承诺常量RSS。

版本2的原完整inline集合和准确派发失败分类仍可读；版本1按旧规则计数，恢复时保来源请求并从原历史派发事实重建streak，不直接沿用或清零。具备Artifact时旧集合迁入首个增量节点，无Artifact的Core继续v2小型checkpoint。sourceBody仍承担大来源正文传输，预览不复制checkpoint。当前Model的Tool批次按声明顺序结算一次，恢复不重置五次真实失败规则；缺continuation的旧记录继续完整历史重建，未知版本/范围拒绝。[增量回归](../../../test/isolated/context/source-request-journal.test.ts)与原SIGKILL回归分别核保存增长、完整捕获和准确恢复。

这里的 Core continuation 与 Adapter 的 opaque continuation 分属不同字段。尚未派发 Model 的恢复读取经过原 scope/hash 核验的私有完整请求，不能使用已移除 opaque 字段的公开 Inspector 投影；中断或失败尝试仍创建新的 Execution，并从完整已确认历史恢复 Adapter 状态。公开 Inspector、reviewer 语义历史继续不暴露此私有字段。[真实强杀回归](../../../test/isolated/recovery/run-resume-runtime.test.ts)覆盖带大 opaque 状态的 planned/running/failed 边界、原效果只执行一次及恢复前后的公开投影。

SQL 的[事务证明](recovery-audit.ts)由普通 Store 写事务维护。持久 trigger 登记每次 Execution/Interaction 的 OLD/NEW Run 与准确 key，包括无 change_event 的外部 SQL 和关闭递归 trigger 时的 REPLACE 身份冲突；failed Model 的效果依赖、原 Command/Session/child 身份及交互资格也会失效。业务提交前核验已结算历史的增量，保存完整行摘要和资格问题，并推进受保护的单调序号。活动 Execution 不重复保存正文摘要，恢复时独立完整检查当前前沿；活动写入同样推进序号，不能绕过最终 CAS。同一 WAL 事务提交或回滚业务与证明，不提前 ACK；没有相关变更的事务无需认证。正常压缩、checkpoint、关闭和重开不使已认证历史失效。原 Run 正式删除时派生证明及队列同事务清理，不改变删除准入或其他 ledger 记录。

冷读在同一只读事务核证明及尚未认证的增量，再按索引读取实际 live 前沿、最后 Model、未决 Interaction 和原子接管所需的真实任务树。未知 Tool/Job 始终按实际状态阻挡；删除或跨 Run 移走已登记身份留下不合格记录。原来源和 Model 大正文仍在准确作用域内完整核 scope/hash，证明不代替配置、审批、当前权限、原 generation、取消或最终 CAS。新的 bindingDigest 绑定版本、当前 Run/selection 及单调审计序号；历史任一列变化使旧申请失效，改回原字节也不倒退序号。连接内 data_version/total_changes 缓存只加速重复准备，不承担跨进程证明。

证明的信任边界是原 private profile、闭合 SQL schema 与受控写事务。客户端或模型不能提交证明；证明写门只在认证事务内开启并在 COMMIT 前关闭。原 0001 baseline 的既有历史在首次写入升级时完整认证一次；readonly/preflight 不升级。缺证据、未知协议或 schema cookie 失效沿原完整 canonical 审计回退，不默认证为安全。失效/旧来源证明退出增量认证并压实队列，后续普通写入不会反复积压其旧历史；它们仍须完整审计，未知事实保留在原 ledger。

健康证明的恢复审计成本由当前前沿和未认证增量决定，索引查找仍有 B-tree 对数成本；实际 live 树、当前完整来源和旧版 continuation 重建保各自必要成本。没有清理原历史、重标身份、扩大重试或新增任务额度。首次升级及失效证明的安全回退仍可能线性，不能据此宣称任意损坏下的固定恢复时延。

## 证据与限制

[单 Run](../../../test/isolated/recovery/run-resume-runtime.test.ts)、[任务组](../../../test/isolated/recovery/run-resume-group-runtime.test.ts)及[连续强杀](../../../test/isolated/recovery/run-resume-repeated-runtime.test.ts)使用所属子进程真实 SIGKILL、实际 SQLite 和独立效果 ledger。任务组覆盖后台必需等待、前台 continuation、多子、排队、嵌套、激活前、已完成子、原审批、超期与配置冲突；未知效果和组漂移另明确使用 SQL 故障注入。原 Run/Execution、结果与 deadline 断言分别判断，不把 accepted 当完成。

[增量审计](../../../test/isolated/recovery/run-resume-audit.test.ts)在真实冷重开后比较 100 和 10000 条已认证 SQL 历史，另配同等数量的已结束子任务，两种规模在 planned 前沿均读取18行 SQL结果、running 前沿均22行，并核末次 Model/效果依赖/live 状态索引；这是受控 SQL 容量夹具，耗时只作本机测量，不冒充真实 Provider 工作或固定性能 SLA。它另用所属子进程实际 SIGKILL 卡在证明已写、COMMIT 前/后，核业务与证明共同回滚/提交；真实 SQL 证明失败回滚原 Run 激活与回执。历史坏正文、坏来源、删除/跨 Run、unknown、旧 failed Model 新效果、无通知变化和 CAS 均有反例。

[升级回归](../../../test/isolated/recovery/run-resume-audit-migration.test.ts)核原 0001 schema 的 readonly 原字节、一次写入认证、后续冷读、迁移 checksum 与未知版本拒绝。[完整历史](../../../test/isolated/recovery/run-resume-history.test.ts)保全部原身份分页和未在 frontier 中的漂移；[Store](../../../test/isolated/recovery/run-resume-store.test.ts)保事务回滚、原审批及接管。Windows [实际维护与包内 leaf](../../../test/isolated/maintenance/windows.test.ts)核真实 Worker、三项包内迁移、备份/新 Store 恢复和 GC。当前证据不代表实际持续数周、任意外部效果恢复、物理存储损坏认证或全部平台资格。

持久取舍见[执行尝试与监督恢复 Note](../../../../../.agents/notes/implemented/architecture/2026-10-16-durable-continuations-and-group-recovery.md)。

增量审计的持久取舍见[事务恢复证明 Note](../../../../../.agents/notes/implemented/architecture/2026-10-16-incremental-recovery-certificates.md)。
