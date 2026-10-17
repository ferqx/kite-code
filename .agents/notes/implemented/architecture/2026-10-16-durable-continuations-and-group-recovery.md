# Agent Note: 持久 continuation 与父子执行组冷恢复

Status: implemented

## Problem

长任务的意图会跨越进程、Model 尝试和上下文压缩。把 running 或末尾 failed 一律当作不可恢复效果，既阻止无工具效果的模型重试，也无法继续父 Agent 等待子 Agent 的任务树。相反，直接放开状态检查或重调旧工具会重做外部效果。每阶段重新扫描全部历史、逐个展开旧模型正文也使恢复成本反复随历史增加。

## Decision

首次全历史扫描、固定 canonical 摘要及未新增持久表/迁移的格式边界现由[事务内增量恢复证明](2026-10-16-incremental-recovery-certificates.md)部分替代；本篇任务意图、来源、未知效果、租约与组恢复边界保持。

每个Model重复封存完整来源集合的v2写入方式由[正常Loop决定](../bug-fix/2026-10-17-normal-loop-checkpoints.md)的v3增量Artifact链部分取代，保原来源与失败streak语义、v1/v2读取兼容和同一恢复协议；当前格式与验证归[协议owner](../../../../packages/agent/src/storage/sqlite/run-resume.README.md)。

采用同一恢复协议，分开持久任务意图、可替换 Model 尝试、已确认效果和进程监督。主入口仍是同 Store、真实 root 主体的显式 run.resume；原 OS root 锁与唯一 generation 是执行权，不增加第二个调度器或恢复执行引擎。所选原 Run 的实际 carrier/parent 链闭合后，沿父到子核原派发 Model 的能力快照与完整工具目录，再准备全部可信配置、动态 ceiling、权限交集和记录读集；组摘要与最终事务成功后才交给普通 owner，沿唯一 Loop、Job 观察与 ChildSlots 继续。

纯 Model 无派生 Tool/Job 时允许保留 partial、关闭旧未结算尝试并创建新 Execution/retry lineage，末尾 failed/incomplete 也可继续。旧片段不变为完整消息。自动压缩使用同一 Model 尝试规则；pending 和完整但未发布摘要不成为上下文，已发布点保持，下一安全边界可重新摘要。原执行初始化三态和未知外部效果约束继续适用。

child queued、已派发但未激活、active 与 terminal-but-unsettled 使用原 carrier，不新建替代树。active 继续原 Run，terminal 只承接原结果，queued/未激活走普通槽位与激活事务。子 Run 不重获30分钟，离线也计时，超期先结算。Host 在共同启动 barrier 之前登记全部原 operation；恢复与普通路径共用 binding lease，父先结束也保后代资源；根任务结束后交回同一持 owner 的普通任务泵，独立后代不阻塞同会话新人类任务。后代及其配置清理由 Host 原目录持有，包含恢复后新建的独立后代；普通和恢复路径的全部 owner 释放统一核监督寿命及清理失败，晚到 disposer 失败也保原锁并停止调度，terminal ledger 不代替清理确认。

普通 Tool 的执行不被泛化为可重试。可信 Tool 可在派发前声明版本化 recovery，并提供独立 resume；原来源、Run manifest 和当前定义须一致。它承诺复用原操作 key 而不重复外部效果。默认 task.execute 的 resume 复用 immutable OperationRef 和幂等登记，再等待同一 carrier。未知外部 Job、未声明 Tool、特殊活动 reviewer 闭包及任意 initializer 不因这个合同取得重放资格。原审批、原结果 revision、当前权限和取消继续核实。

每个新普通/压缩 Model 在原 decision_source_json 封存 version 2 continuation：Run/selection、完整来源请求和失败 streak。版本2绑定 Core 派发事实的刷新中性分类；版本1的旧失败摘要从原派发历史重建，不直接沿用或清零，来源请求仍核原作用域保留。大正文使用原 sourceBody Artifact，Runtime 核准确 scope/hash 后恢复；当前 Tool 批次再结算一次，五次失败额度不重置。旧记录没有该字段时继续完整历史重建，未知版本拒绝。没有新增 SQL 表、baseline checksum、Store major 或维护资产格式。

首次冷 SQL 审计仍线性验证全部 ledger 并保原 canonical digest。连接内只保一个已验证 frontier，必须同时匹配 SQLite data_version 和 total_changes 才可复用；begin 的已知 root epoch/申请/事件提交可更新快照。最终 commit 先重核当前控制，再匹配快照或完整重审，任何其他本机写入、peer commit、无通知 raw SQL 均使复用失效。该缓存不跨进程持久化、不以 change cursor 作完整性证明，也不授予执行权。组目录只读当前监督闭包与必要祖先，避免累计已结束子任务正文进入恢复目录。

该决定部分扩展[原安全检查点](2026-10-02-durable-run-resume-checkpoints.md)的拒绝范围和每阶段扫描方式；原身份、初始化、未知效果、OS 锁与最终 CAS 理由保持。[持续执行决定](2026-10-15-long-running-agent-continuation.md)的期限、五次失败、来源完整性和压缩发布规则保持。

## Alternatives considered

- 逐个删除 running、child、compressionId 拒绝条件：缺少效果分类、组原子性及监督资源所有权，不能作为恢复设计。
- 将所有工具按相同参数自动重放：外部效果可能已经发生；选择显式可信 continuation 和独立 resume。
- 为恢复创建替代父子 Run、重置子期限或失败 streak：丢失原任务身份并增加重试额度，违背已确认行为。
- 独立恢复调度器、配置引用计数或另一组 child 槽位：形成双重 authority；选择复用普通执行与实际资源 owner。
- 仅按通知 cursor 缓存历史验证：raw SQL 可以不产生事件；选择实际 SQLite 写入观察，变化时完整审计。
- 修改持久格式并把整个历史当成无需重审的可信归档：本轮没有可证实的不可变归档协议及迁移资格，保首次完整审计并明确线性成本。

## Consequences

恢复能容忍纯 Model、自动压缩和支持的父子监督阶段崩溃，并维持原身份和效果。新 checkpoint 避免旧 Model 正文重读；无变化准备阶段避免重复全扫描。首次冷审计仍随历史线性增长，checkpoint 仍随独特来源增长，不宣称常数成本、数周持续运行、任意闭包或全部平台资格。

[当前协议与证据](../../../../packages/agent/src/storage/sqlite/run-resume.README.md)负责实现边界。[任务组强杀](../../../../packages/agent/test/isolated/recovery/run-resume-group-runtime.test.ts)覆盖前台/后台等待、排队、嵌套、激活前、终态子、原审批与超期；未知效果、配置和组漂移另明确故障注入。[连续压缩强杀](../../../../packages/agent/test/isolated/recovery/run-resume-repeated-runtime.test.ts)使用两个真实 SIGKILL，再由第三进程恢复，原效果只发生一次。Store 与完整历史回归保 raw SQL 漂移、原 canonical 摘要和事务回滚。Windows 本机412条 Execution 一次测量冷17.83ms、相同快照0.75ms，不外推大型历史、RSS 或其他平台。
