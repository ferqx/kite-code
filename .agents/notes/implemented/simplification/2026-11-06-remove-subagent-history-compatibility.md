# Agent Note: 移除子 Agent 的历史执行兼容

Status: implemented

## Problem

子角色收束和子等待工具移除曾附带旧五角色目录、旧工具声明及每 Run Task factory 的兼容路径。新增 Worktree 指导后，两个分支的中间定义又产生新的历史组合；有限转换既增加跨层维护面，也不能保证任意升级前任务继续执行。用户明确选择不考虑旧执行数据兼容，要求清理相关逻辑，保持当前实现简洁。

## Decision

部分替代[通用与探索子角色决定](../architecture/2026-11-06-subagent-general-explore.md)中的历史兼容部分。Service 仅注册当前可信角色并创建一份当前 Task factory，默认仍为 `general/explore`。移除旧五角色及旧只读工具目录、历史权限分类和 Task 快照选择；不把 `worker/code/plan/review` 映射成当前默认别名。

Runtime 不再为已保存 Model 重建旧消息说明或旧 child 事件工具声明。恢复直接核当前完整工具目录、能力快照与原 Source，不能精确匹配就拒绝。仅服务于旧 Task factory 的每 Run Extension override API、传播及专用测试同时删除；不增加替代注册表、迁移参数、版本或持久字段。

当前版本恢复与协作继续需要原事实：child 的 role／Model／工具集合与 Source、准确 carrier／Store／父子／根关系、当前父权限交集、MCP 新轮 lineage、取消和未知效果检查全部保留。明确 follow-up 仍在同一 child Session 创建新轮；不能将原配置恢复入口当成历史迁移删掉。根专属创建、澄清和事件等待、Explore 的 Worktree 只读限制及原审批复用保持。

专用历史 producer 和回归随已取消的要求移除；当前同版本真实冷恢复、唯一效果及漂移拒绝继续验证。不删除用户会话库或改写已有消息，旧完成结果的只读历史与旧任务能否继续执行分别判断。其他子系统既有数据格式及恢复合同不属于本次清理。

## Alternatives considered

- 为两个分支的每种中间定义补精确转换：能够扩大有限兼容，但继续维护用户已明确不需要的能力。
- 保留旧定义却关闭入口：仍留下历史角色表、工厂替换、夹具与文档成本，不能实现此次精简目标。
- 放宽恢复、父子工具或权限比较：会把不同定义当成原授权，不符合当前执行安全与原身份要求。
- 删除全部 child 原配置和冷恢复代码：会破坏当前版本的正常续作、进程重启恢复与唯一效果，不属于用户撤销的旧数据兼容。

## Consequences

当前实现只围绕一套可信角色和工具声明运行，不再承诺升级前旧子角色／Task 定义的执行恢复。产品边界归[执行手册](../../../../docs/handbook/features/execution.md)，装配归[Service owner](../../../../apps/service/README.md)，工具和恢复校验归[Task owner](../../../../packages/agent/src/extensions/task/README.md)与[Runtime](../../../../packages/agent/src/runtime.ts)。

[默认角色回归](../../../../apps/service/test/isolated/default-task-roles.test.ts)、[Task 装配](../../../../apps/service/test/isolated/task-configuration.test.ts)、[Core 当前冷恢复](../../../../packages/agent/test/isolated/recovery/child-message-resume.test.ts)及[Service 当前子恢复](../../../../apps/service/test/isolated/current-child-resume.test.ts)分别核当前目录、真实进程终止后的原审批／子身份与唯一效果，协作／权限回归核其他保留行为。具体命令、环境与结果由相应 owner 文档记录，不把已删除的历史版本资格改称当前通过。
