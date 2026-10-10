# Agent Note: 从持久安全边界接续原 Run

Status: implemented

## Problem

进程崩溃后仍可能留下未终止的 Run、已成功落库的模型回复、尚未派发的 Tool 与原审批。重新进入普通 Loop 会重新询问模型并生成新调用身份，既不能恢复原审批，也可能重复已完成工作。仅看 planned 不足以证明备份恢复前没有执行；空 requirements 数组也无法证明初始化回调是否已经运行。

## Decision

显式 run.resume 固定当前 Store、根 Session、原 Run；HTTP 只接收这些公开身份与申请 ID，owner generation 由服务端读取，同 ID 使用原内部 generation 保持幂等，不能由客户端自报。可信 Core/Store 入口保留 generation CAS。只读预检先核原主体和来源，独立 OS 恢复 lease 封存检查点；恢复原配置后，同事务复核配置、当前选择、取消边界和准确检查点，再把可证明未派发的原执行交给新 generation 的普通 owner。独立申请保存 accepted/null 或 applied 的有限回执，不把内部恢复配置复制进原始导出的 Command。

检查点区分原 Model 派发前、完整 Model 的工具调用序列、完成判定。已完成结果只读跳过，planned Model 使用原封存请求和身份，planned Tool 保留原 Execution、决策来源和 Interaction；完成的无工具回复进入既有完成门禁。初始化保存 unstarted/started/completed，completed 不重跑回调，started 的冷恢复明确拒绝，不重放半完成闭包。

2026-10-10 移除累计已完成历史4096条拒绝：逐行验证全部原Execution/Interaction，按原canonical列序与行序流式生成同一checkpoint摘要；当前零派发planned frontier仍有4096条上界。Runtime用私有200条页穷尽原Model输出和最新Model全部Tool身份，再恢复定义/完整输入对应的来源请求；planned Model前也保已发现祖先来源。分页不授恢复权，begin/commit继续全历史摘要与原身份CAS，无法确认的效果仍拒绝。来源完整性与检查点内复用见[来源决定](2026-10-10-complete-checkpoint-source-capture.md)。

仅接续仍活动且安全边界可验证的同 Store 工作。终态 Run 不重开，可能派发的未决执行、截断 Model、备份旧来源与无法重建的闭包局部拒绝。当前权限、来源和必要条件仍在实际派发前核验。当前实现覆盖根 Run 的直接模型和工具；child、runless 嵌套闭包及其他尚无准确检查点的场景继续按完整方案闭合，不以本切片声称全部恢复完成。

## Alternatives considered

- 把 resume 转成新的 run.start：丢失原审批和调用序列，不能证明旧工具不会重复执行。
- 先 interrupt 再原地重开：会抹去终态，且取消原 planned/Interaction，违背历史与新尝试分离。
- 放宽普通 owner 准入：会使无显式恢复意图的冷工作获得派发权，因此采用目的受限的准备 lease 和核验后的交接。
- 根据 requirements=[] 决定重跑 initializer：空结果也可能是已完成初始化，必须保存独立阶段事实。
- 重放任意扩展闭包：持久数据无法证明恢复到了同一闭包位置，已派发闭包只能保留结果或局部阻断。
- 把4096条Worker传输上界当全部已完成历史额度：长任务会因历史长度拒绝合法检查点，与主Run无累计额度的产品承诺不符。保当前planned上界，完整历史改用流式摘要和私有有限页。
- 只摘要最后Model及planned集合：会遗漏旧结果/Interaction漂移，因此begin/commit仍核全历史，有限frontier只用于准备交接。

## Consequences

原 Run、模型决策、工具和审批身份可以在准确安全边界接续；初始化完成与空结果分开表达，避免重复执行初始化。代价是显式两阶段交接与严格检查点核实：不能序列化的业务闭包、未知效果、child/runless 和其他未覆盖来源仍局部拒绝，保留历史。资源清理不确认时不能假关闭 Store/profile。完整正文从原准确作用域核验，不用预览重建工具参数。

公开 owner generation 曾被错误放入草拟 HTTP 契约，交付前依照 V1.3 §18.5 移除。服务端推导加内部 CAS 既保持公开协议最小身份，也保留同 ID 原意图与竞争核验；其他主体重复相同 ID 不能查回原回执。

流式与分页避免一次把全部历史传进Worker回执，但恢复仍须读取和核验全部原历史及完整Model正文，成本随实际历史增长；没有承诺任意历史长度的固定恢复时延。当前SQL格式、原摘要及公开schema保持，不新增隐式恢复或外部效果重放。

## Verification

2026-10-02 macOS隔离profile与固定Model：Runtime真实SIGKILL14项/120断言、Store12项/84断言、Store+原始导出16项/285断言；实际HTTP1项/47断言核原审批与一次效果、丢回应原GET和主体拒绝；Client1项/55断言核closed请求、冻结意图和坏回执。完整统一入口251测试作业通过（parallel79文件、isolated234、exclusive0）；根与26workspace类型检查、构建及API/边界/归属门禁通过。当前实现和完整限制由[Runtime owner](../../../../packages/agent/README.md)、[Store owner](../../../../packages/agent/src/storage/README.md)维护，实际日志与剩余V1.3范围见[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。这些证据不代表全部恢复、正式入口或跨平台发行已完成。

2026-10-10 原历史叶子的4096拒绝在真实热效果完成后由公开resume返回409 `run_resume_checkpoint_unavailable`；恢复固定叶子后原完整用例通过1项/35断言。原Run/Execution/attempt、完整请求/静态metadata与准确派发授权、全部旧结果和ledger保持，零旧Tool重放。多页历史及原canonical全等另1项/3123断言，取消/权限/初始化/lease/CAS原完整邻接继续通过。原hot三次deadline与metadata期望错误保留，准确输入与19完整文件总范围见当前进度；不据此提升RSS/资源或阶段状态。
