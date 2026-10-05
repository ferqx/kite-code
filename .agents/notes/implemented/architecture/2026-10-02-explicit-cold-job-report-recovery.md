# Agent Note: 显式恢复原后台报告与绑定生命周期

Status: implemented

## Problem

真实后台结果、原目标上下文和唯一报告命令已经持久保存，但模型、扩展与资源绑定属于进程内对象。进程重启后只读取这些持久事实不能恢复原对象；直接使用当前默认配置可能替换原模型、工具或授权，直接执行查回的旧Run又可能重复消费模型和外部效果。

## Decision

原根Session报告通过独立 `job.report.resume` 申请恢复，公开入口只接受原Store、Session、reportCommandId和新commandId。可信恢复resolver接收原父Run及实际Workspace，Core比较完整原manifest；普通新Run resolver不作为冷恢复的隐式替代。默认Service固定原modelId和Skill选择，在凭据读取前比较原配置digest，参数或引用改变时拒绝，不从旧快照直接授予当前权限。

只读准入先核root创建主体、原报告主体、合法恢复来源与配置，失败不进入恢复工厂、凭据或策略I/O；它不预留授权，最终事务仍重查。Store在同一事务验证原报告资格、配置、主体、afterTurn授权、取消和当前选择，再登记恢复回执、原报告的新因果Run及结果消费。返回 `started` 明确区分本次新建与历史Run查回；只有本次新建才进入唯一Loop。原报告已应用时另一个恢复申请仍只记录已有事实，原父Run和Tool不复活。

恢复准备计入Runtime准入与任务生命周期。关闭先中止准备signal；进入Run后把绑定释放权交给真实Run及其后代lease，不能在前台回复结束时提前释放后台任务仍使用的资源。准备释放失败保留cleanup事实，关闭不能假成功释放Store/profile；不会自动重复调用任意失败disposer。接口先返回持久申请，不等待模型结束；丢回应只查询原命令。

## Alternatives considered

- 冷读取或启动时自动解析当前配置并续轮：会把只读变成收费执行，也不能证明当前配置等于原绑定，因此拒绝。
- 把恢复等同于新的普通run.start：无法保留准确原报告的消费资格、取消和幂等关系，因此使用原报告及独立恢复申请。
- 查回Run后无条件调用executeRun：历史Run存在不证明是本次新建，因此用事务返回的started事实决定执行。
- 恢复函数finally无条件dispose绑定：报告完成时detached后台任务仍可能持有该绑定，因此只释放未交接资源，已交接的由lease收束。
- 在本入口核实外部未知Job：普通owner仍拒绝未知执行，报告恢复不具有adapter外部核实权。该能力需要独立受限恢复lease和实际监督证据，不能借报告入口绕过。

## Consequences

无原实现、配置不匹配、旧Store或已失去交付资格时保留历史及明确原因；不安装旧代码、不重试旧工具。能力当前针对根Session已有报告，不代表任意Run重试、嵌套child公开恢复或adapter reconcile完成。源码和测试边界见[Task owner](../../../../packages/agent/src/extensions/task/README.md)、[Service owner](../../../../apps/service/README.md)与[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

独立Job核实链路随后按[追加核实证据与受限lease](2026-10-02-append-only-job-reconciliation.md)交付；本Note关于原报告绑定、幂等和资源生命周期的理由仍适用，报告入口仍不获得外部查询权。
