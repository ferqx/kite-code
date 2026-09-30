# Agent Note: Keep active resource reservations in State and archive terminal receipts

Status: implemented

## Problem

移除累计额度后，已结算 reservation 仍不断进入 State。2,000 次工具预留／释放使这部分 State 从约 2.3 KiB 增到 936,948 字节（约 915 KiB），随后每次 admission、Kernel clone、State 序列化和持久快照都重复处理已经完成的工作。直接删除这些记录又会丢失终态幂等、父子资金血缘、取消释放与恢复查证所需的身份和用量。

## Decision

无累计额度的活动 Run 使用持久的 `externalizedClosedReservations` 标记，State 只保留未结算 reservation，完整 canonical `reconciled`／`released` 记录移入 Store16 私有 receipt 表。终态事件、receipt、State 与快照在同一 revision CAS 事务中提交；Store 校验前态、终态事件、被移出的准确记录及同一 Run／invocation 的唯一性。Host 查询归档 receipt 仍按 Session、Run、reservation 身份和实际终态核对，缺失或冲突不能推断成功。

新配置沿已有 `resource_budget.configured` 保存标记；旧活动 Run 沿已有 `resource_budget.cumulative_limits_removed` 同批迁出旧终态，旧有限历史保留原回放规则。同批 `bounded_replaced` 产生的新 reservation 也参与归档，不能只枚举普通 reserved 事件。恢复或并行收尾再次核对原 reservation 时，只有准确已完成 receipt 才可幂等跳过；未知 reservation 保留在 State，不因内存优化释放。

派发前审批会结算原准备预约；审批授权后的续执行使用准确 approval receipt ID 派生新的 invocation，查证原归档预约时必须匹配当前 Tool／MCP／Skill／Task 的 resource kind。只支持 Task 会使独立子 Session 的普通工具在审批后被唯一身份校验拒绝；不允许通过取消 Store 查重来绕开这一遗漏。

历史 v1 续轮在首模型准备后过期时，未替换的来源备付仍需准确的目标本地失败证明。目标 State 中保留更早 Run 的 Model 身份，因此先用当前 Run 的活动预约与索引 receipt 集合筛选候选，再验证完整终态回执、零尝试及零派发事件；不能把旧 Run 的正常已完成模型当作当前 Run 证明冲突，也不能跳过真正的派发事实。真实截止竞态回归同时核对原 Run 的归档回执未被修改。

Service 的 followup 恢复、完成、来源 ACK 与预派发失败判断使用同一目标 Run 的活动及归档模型预约视图。Store 沿现有 Session／Run 索引一次读取所需 resource kind，并核对终态 revision 不超过调用方快照；不逐个查询全部旧模型。`released` 只证明已有意图和释放，不能当成完成：未路由的已释放准备意图保留恢复要求，不能再次准备同一模型或误结算失败；已激活的未尝试模型沿原 Surface 派发一次，已尝试结果不明保持 unknown。多模型 v2 继续由原工具循环完成，不受首模型快捷路径的一模型判断限制。回归覆盖三个真实 SIGKILL 窗口和两个模型加读工具的独立续轮。

续轮并发等待区分仍可自动释放的已知执行与需要核对的未知执行。只有未知预约本身已占满所需子槽位时，恢复扫描立即报告 `followup_recovery_required`；已接受的 queued 备付保持原样，不能释放未知执行或重派模型。有剩余槽位时仍可执行，与已知执行混合占位时继续等待已知槽位释放。真实 SIGKILL 回归固定在来源 Tool 已成功、备付已排队但两个子槽位尚未释放的窗口，避免测试偶然在来源执行权无法恢复时提前退出，遗漏真正的容量等待路径。

receipt 保存终态 revision。fork 只复制快照边界之前的 receipt，named rewind 在同一事务移除边界之后的 receipt；回退 State 中恢复为活动的预约可沿原身份再次合法结算。Store15→16 仅转换受维护保护的私有候选，并核对全部旧事实，原数据库不原位改写。

架构检查只为这个准确的 `kite-session-store15-to16.ts` 维护转换 owner 增加登记；普通 Runtime owner 与尚未实现的后续版本路径继续拒绝，不放宽版本化执行路径规则。

## Alternatives considered

- 删除已结算 reservation 且不保存回执：拒绝。会使重复结算、父级查证与重启恢复失去准确证据。
- 继续全部保留在 State、只提高内存额度：拒绝。无限累计运行的每次 clone 和序列化成本仍随历史增长。
- 仅保存内存终态缓存：拒绝。进程重启、跨 Session 资金引用和多 writer CAS 都需要持久证明。
- 为归档增加独立异步 writer：拒绝。receipt 与 State 可能出现可观察的半提交窗口，既有 Store 事务可以同时提交。

## Consequences

受控 2,000 次预留／释放后，活动预算 State 维持约 2.3 KiB；已完成事实仍保存在 SQLite，完整历史不会因为活跃 State 缩小而丢失。Store 的持久 receipt 总量继续随真实工作增长，按身份索引查询；该取舍不声称全部 Session State 或磁盘占用恒定。

恢复记录同步区分未解决项和已闭合历史：未解决失败及其因果链完整保留，只对闭合诊断保留最近 128 条，不能因执行较多而丢失仍需处理的恢复问题。Steer 接纳复用 Store revision CAS，不再为已证明的同一事务加载和扫描两遍完整 journal。

扩展子执行的 CPU 自检另定位到重复的 Store 结构扫描。结构 inventory 与列清单改用合并查询，仍逐次核对完整字段、索引、触发器、元数据及外键，不缓存成功校验。相同的 15 次读工具加独立续轮探针中，结构校验采样由约 1.44 秒降至 0.63 秒，整体约 5.26 秒降至 4.39 秒；完整会话事实与快照校验仍继续执行，成本随其实际内容变化。

当前负责文档见 [Store 事务](../../../../packages/runtime-storage-sqlite/docs/transactions-and-state.md)、[Host 生命周期](../../../../packages/runtime-host/docs/execution-lifecycle.md)和 [Kernel 恢复](../../../../packages/agent-kernel/docs/completion-recovery.md)。回归见 [receipt](../../../../packages/runtime-storage-sqlite/test/resource-reservation-receipts.test.ts)及 [Session Store](../../../../packages/runtime-storage-sqlite/test/isolated/kite-session-runtime-storage.test.ts)。
