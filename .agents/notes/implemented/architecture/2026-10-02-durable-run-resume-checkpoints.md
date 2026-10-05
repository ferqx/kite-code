# Agent Note: 从持久安全边界接续原 Run

Status: implemented

## Problem

进程崩溃后仍可能留下未终止的 Run、已成功落库的模型回复、尚未派发的 Tool 与原审批。重新进入普通 Loop 会重新询问模型并生成新调用身份，既不能恢复原审批，也可能重复已完成工作。仅看 planned 不足以证明备份恢复前没有执行；空 requirements 数组也无法证明初始化回调是否已经运行。

## Decision

显式 run.resume 固定当前 Store、根 Session、原 Run；HTTP 只接收这些公开身份与申请 ID，owner generation 由服务端读取，同 ID 使用原内部 generation 保持幂等，不能由客户端自报。可信 Core/Store 入口保留 generation CAS。只读预检先核原主体和来源，独立 OS 恢复 lease 封存检查点；恢复原配置后，同事务复核配置、当前选择、取消边界和准确检查点，再把可证明未派发的原执行交给新 generation 的普通 owner。独立申请保存 accepted/null 或 applied 的有限回执，不把内部恢复配置复制进原始导出的 Command。

检查点区分原 Model 派发前、完整 Model 的工具调用序列、完成判定。已完成结果只读跳过，planned Model 使用原封存请求和身份，planned Tool 保留原 Execution、决策来源和 Interaction；完成的无工具回复进入既有完成门禁。初始化保存 unstarted/started/completed，completed 不重跑回调，started 的冷恢复明确拒绝，不重放半完成闭包。

仅接续仍活动且安全边界可验证的同 Store 工作。终态 Run 不重开，可能派发的未决执行、截断 Model、备份旧来源与无法重建的闭包局部拒绝。当前权限、来源和必要条件仍在实际派发前核验。当前实现覆盖根 Run 的直接模型和工具；child、runless 嵌套闭包及其他尚无准确检查点的场景继续按完整方案闭合，不以本切片声称全部恢复完成。

## Alternatives considered

- 把 resume 转成新的 run.start：丢失原审批和调用序列，不能证明旧工具不会重复执行。
- 先 interrupt 再原地重开：会抹去终态，且取消原 planned/Interaction，违背历史与新尝试分离。
- 放宽普通 owner 准入：会使无显式恢复意图的冷工作获得派发权，因此采用目的受限的准备 lease 和核验后的交接。
- 根据 requirements=[] 决定重跑 initializer：空结果也可能是已完成初始化，必须保存独立阶段事实。
- 重放任意扩展闭包：持久数据无法证明恢复到了同一闭包位置，已派发闭包只能保留结果或局部阻断。

## Consequences

原 Run、模型决策、工具和审批身份可以在准确安全边界接续；初始化完成与空结果分开表达，避免重复执行初始化。代价是显式两阶段交接与严格检查点核实：不能序列化的业务闭包、未知效果、child/runless 和其他未覆盖来源仍局部拒绝，保留历史。资源清理不确认时不能假关闭 Store/profile。完整正文从原准确作用域核验，不用预览重建工具参数。

公开 owner generation 曾被错误放入草拟 HTTP 契约，交付前依照 V1.3 §18.5 移除。服务端推导加内部 CAS 既保持公开协议最小身份，也保留同 ID 原意图与竞争核验；其他主体重复相同 ID 不能查回原回执。

## Verification

2026-10-02 macOS隔离profile与固定Model：Runtime真实SIGKILL14项/120断言、Store12项/84断言、Store+原始导出16项/285断言；实际HTTP1项/47断言核原审批与一次效果、丢回应原GET和主体拒绝；Client1项/55断言核closed请求、冻结意图和坏回执。完整统一入口251测试作业通过（parallel79文件、isolated234、exclusive0）；根与26workspace类型检查、构建及API/边界/归属门禁通过。当前实现和完整限制由[Runtime owner](../../../../packages/agent/README.md)、[Store owner](../../../../packages/agent/src/storage/README.md)维护，实际日志与剩余V1.3范围见[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。这些证据不代表全部恢复、正式入口或跨平台发行已完成。
