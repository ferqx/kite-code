# Agent Note: 追加 Job 核实证据与受限恢复所有权

Status: implemented

## Problem

外部任务可能已经执行，但持有原句柄的进程在结果持久化之前退出。普通执行权因未知任务被阻挡，查询历史又不能暗中访问外部系统。原未知结果可能已经被 Context 按 executionId/resultRevision 引用，原地改写结果会破坏历史；仅凭业务成功也不能证明外部进程或任务监督已经结束。

## Decision

Job在真实派发前封存原定义与非秘密恢复配置。显式job.reconcile取得与普通OwnerRef隔离的root OS lease及generation，只允许查询准确原Execution；合法scope先于可信独立授权与恢复factory。无原关联、原manifest或可靠实现时局部不可核实，不能重建live handle或调用start。

核实结果作为独立Command证明追加，保留原Execution/result/revision与历史Context引用。业务结果与监督ended分别验证，两者共同成立才为准确原Job形成verified证明；普通owner只排除这一个已核实Job，其他未知执行继续阻挡。Fork/Rewind等既有独立约束不被此证明自动放宽。

核实关闭原pending自动投递资格，否则后续明确新Run可能消费旧unknown。已消费来源不改写，不自动续轮、消费新证明或重做原工具。Command request保存私有input/reference/恢复manifest的摘要；原配置和lease留内部，不通过原始导出泄露。sameID只读回执，accepted遗留不重新进入回调；新的明确核实命令也可复用已有verified证明。独立accepted必须同时排除于普通调度、owner释放阻挡和Session中断扫描；取消核实只停止这个新命令的查询，原Job保持历史事实。

## Alternatives considered

- 放宽普通owner以便调用reconcile：会把未知恢复查询权扩大为普通派发权，因此使用目的受限lease和独立操作。
- 将unknown原地更新成succeeded并增加revision：既有Context引用原revision会失效，也会覆盖当时事实，因此追加证明，保留原结果。
- 原结果保持pending：verified证明解除执行权阻挡后，下一轮会自动消费旧unknown，故仅抑制尚未消费的自动投递。
- 用PID消失或没有关联判断成功/未执行：缺少外部结果和监督证据，保持unsupported或unresolved。
- 把全部原配置复制进新Command请求：原始导出包含Command正文，会暴露宿主私有恢复配置，因此只保存精确摘要。

## Consequences

可以核实可靠adapter提供的原外部事实，不代表所有adapter具备冷恢复能力。默认Shell/MCP仍无可靠冷核实；一般Run恢复、重新尝试及完整客户端恢复面板继续由完整方案验收。独立核实证明不会自动成为模型上下文或改写原实时状态。当前源码、真实ledger/SIGKILL和公开调用证据见[Agent owner](../../../../packages/agent/README.md)、[Store owner](../../../../packages/agent/src/storage/README.md)、[Service owner](../../../../apps/service/README.md)及[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
