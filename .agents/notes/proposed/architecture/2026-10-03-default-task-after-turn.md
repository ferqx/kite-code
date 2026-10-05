# Agent Note: 默认 Task 的显式后台结果汇报保持原授权

Status: proposed

## Problem

通用 Core 已保存真实后台终态、唯一报告命令与精确来源，但默认 Service 同时缺普通可信 child role 和 afterTurn policy。仅在测试 configure 注入回调不能证明正式默认后台结果已迁入。把所有 Job 终态变为自动 Run 会扩大用户意图，并让报告重复生出报告。

## Proposal

默认工厂注册固定 `worker@1` 普通角色，继承真实原父 Model 与已选择 Tool 范围；显式 trusted child 数组继续覆盖，显式空数组关闭 Task。JSONC 仅选择已注册 Tool，不声明角色、回调、授权或权限。Task 未指定 disposition 仍 required；background 只保后台结果。只有原 task/followup_task 明确 after_turn 才申请一次结果汇报。

Service 私有有限 leaf 只核实际原 Command/Run/Session/源 Task Execution、Store/root work 与冻结 role/version。它在 request/apply 读取当前可信 permission snapshot/trust，封存稳定策略版本与原控制读集；默认持久策略沿原 Session/主体/Store读取三项模式和信任 revision。显式 programmatic readPolicy 的实时事实继续优先；只有自定义 permissions、没有可读取可信 current policy 时默认 afterTurn failclosed，自定义 trusted afterTurn 可明确覆盖。无信任不能借 Task 已批准获得自动汇报资格。

策略只许可这份准确原结果触发一次报告，不批准 Task、carrier、报告 Model 或报告内效果。当前 Tool/Job 独立许可、原 Planning 上界与 final SQL控制/来源读集继续约束；普通 sourceCapture不能自报通过。Core已由真实carrier/result revision唯一登记报告，job.report来源不能再次申请after_turn。父仍活动时apply保合格原授权，由Store保持deferred而非策略提前suppress；父完成、目标无活动Run且原source/selection/control仍等值时才启动。

required/background/普通Shell不产生自动报告。unknown、取消/删除、Rewind、期限或来源变化保原结果并抑制；后来的用户工作优先。nested报告沿准确child Session及原deadline，不能续签新30分钟。冷启动没有原热binding保持显式原报告恢复，不重建旧执行器或盲重放外部效果；恢复理由沿用[既有原报告决定](../../implemented/architecture/2026-10-02-explicit-cold-job-report-recovery.md)。

## Alternatives considered

- 仅加默认policy但无角色：实际默认进程没有Task，不能形成完整链，因此拒绝把回调存在当交付。
- 允许每个Job终态自动报告：扩大原意图并混入Shell/Workflow/未知结果，改为准确Task显式disposition。
- 报告再自授权after_turn：会自生持续工作；复用Core原origin检查，job.report拒绝该处置。
- 将旧批准当当前权限或角色注册：取消实际控制/能力边界，拒绝；只封有限可信事实并最终CAS。
- apply阶段父未completed立即deny：吞掉子先完成的合法deferred报告，保running父资格由原Store延后启动。

## Current implementation

固定worker@1、有限默认policy及Service默认接线已经实施。真实默认leaf11例包含原Task/carrier各自Ask、required/background零报告、原currentpolicy/trust/source/head漂移、非递归和两种结果时序。父先completed fixture使用modelConcurrency:2；另一个真实单槽窗口保原deferred，父完成后准确一次报告，生产默认单槽未变。最终相关九文件48/747/0fail，涵盖原nested/followup、冷报告恢复和父子Planning；Planning历史来源业务三文件50/454/0fail。日志分别为kite-default-after-turn-neighbors-third-qualified、kite-plan-history-source-leaf-neighbors-first-qualified。原中途装配/初始化/权限/head漂移和历史digest失配日志保留，不能用最终绿删除反例。

原SQL报告应用继承实际父requirements；report initializer保 refs而不登记外国 Run义务。Service有限readBoundJobReportParent通过实际原命令/回执/source/carrier/config/rootwork/主体关系读取原计划权限，并保最后record/control CAS。历史Planning receipt按原实际Execution的批准Run重建来源digest，当前inactive信息仍无批准。丢失这个历史关系会拒绝合法报告，清空义务或借给任意新Run则越权，故只开放有限实际report绑定。

源码外无configure默认Task已取得实际1/164资格：public builder/paired、独立HOME/profile/cwd、Task与carrier各Ask，after_turn父2/child1/report1而required/background零报告；完整108042 UTF-8字节原结果以source/hash进入唯一报告，重复GET零新效果，制品manifest字节保持且所属PID结束。日志kite-task-packaged-default-final-qualified。没有注入child/afterTurn/permissions/resolver，实际默认JSONC仅选已注册模型/tools。

当前提案继续proposed：完整默认冷报告强杀/丢回执、多层和全部正式客户端/平台接受标准尚未合并资格。已有源码外1/164或Service组合不代替这些场景。

## Acceptance criteria

真实无child/afterTurn注入的默认factory及源码外default进程：Task/独立carrier各审批、父先或子先完成均准确一次报告Model采用原低信任完整结果；required/background/Shell零报告；失败如实汇报而unknown/cancel不报告。原control/source/Planning在request/apply/final SQL漂移拒绝，无新授权和外部重做；报告不递归after_turn，nested不新建deadline。SIGKILL冷读零Model，显式原恢复与丢回执原GET保持一次消费。当前正式入口/平台资格单独记录。

## Risks

可信默认角色注册不使未选Task出现在Model目录，不扩大JSONC授权。私有角色/policy不能跳过原child model/Tool交集。扩展current policy若无法可信读取必须拒绝，不能拿不存在的control revision构造通过。有限leaf与configured测试通过尚不等同source-free默认进程、全部客户端和平台完成。

owner为[Service](../../../../apps/service/README.md)、[Task](../../../../packages/agent/src/extensions/task/README.md)，实际实施与资格记在[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
