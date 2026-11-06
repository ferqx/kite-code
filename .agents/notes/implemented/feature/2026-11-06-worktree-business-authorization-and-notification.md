# Agent Note: Worktree 业务批准复用与创建通知

Status: implemented

## Problem

一次创建或删除由原 Tool、prepare Job 和 mutation Job 完成，独立询问会在手动外部范围产生三张卡，Auto 也重复审核同一业务意图。创建结果只在子任务内返回时，其他编辑子任务需要等创建者结束或依赖模型主动报告，无法直接得到及时且有原执行出处的就绪信息。用户确认最小调整为每个业务动作一次批准、内部精确复用，并沿现有父子消息通知和转发；没有要求编辑独占、并行限制或 cwd 迁移。

## Decision

普通 `approve_once` 仍绑定原业务调用；固定 `builtin.shell/git.worktree@1` 的批准包含它唯一的两个内部步骤。[权限 owner](../../../../packages/agent/src/permissions/README.md#git-worktree-的准确权限)和[存储授权边界](../../../../packages/agent/src/storage/sqlite/worktree-authorization.ts)维护完整规则。默认 Host 核资产后描述配置身份，可信决策组合完整性封存检测额外条件改写；封存不是签名或单独 authority。实际派生根据原 Tool 已接受的人类／模型／grant 证明、同 Store/Session/root work/owner、真实注册、原 executable 记录及完整冻结步骤验证。mutation 还用原 prepare 的完整实际输出证明 plan 归属。最终派发继续核当前权限、控制读集、撤销、期限和取消；独立人工条件不被吸收。

创建真实成功并保存原稳定回执后，[通知 helper](../../../../packages/agent/src/tools/git-worktree/notification.ts)用原 Tool 的持久消息身份发 parent。原 owner 合法恢复可续接相同正文，新 Execution 历史回执不再发；通知未确认不改变 Git 已成功事实或重跑创建。主 Agent 用现有消息／follow-up 转给相关 child；queued、received 和实际使用分别表达。通知只传准确路径与原回执，不授予编辑范围，不改变 cwd，也不广播或登记独占租约。

该决定补充[原 Worktree 决定](2026-11-06-git-worktree-tool.md)的批准来源复用与创建通知；内层仍独立核验当前派发资格。原 Shell Job、Git argv、严格完整输出、只读角色、删除保护、unknown 与原 owner 恢复、平台与发行约束继续适用，没有工具或协议版本升级。

## Alternatives considered

- 保留每阶段独立业务确认：安全但重复询问原意图，用户已明确要求减少；改为证明步骤属于原批准，同时保留每次派发检查。
- 把 prepare 改为 safeRead 或对整个 Worktree 免审：无法代表所属变更授权，也可能吞并原独立条件，未采用。
- 共享命令摘要或仅按 path 缓存批准：两个阶段命令不同，同路径可换实体或执行者；不足以证明原 authority，未采用。
- 只靠创建者模型主动通知：不能可靠覆盖原记录恢复和模型遗漏，采用从稳定成功事实发原持久消息；相关子任务的选择仍由主任务沿既有工具协调。
- 新建工作树管理库、全员广播、编辑独占或迁移 Session：超出用户最小调整，也不是通知和批准复用所必需，未采用。

## Consequences

正常手动外部范围创建／删除各一张业务卡，Auto 各一次通用审核，两个内部 Job 仍有各自完整记录和当次派发证明。没有普通审批的已有范围保持；自定义独立要求可继续产生必要审批。普通 Shell 的原手动分层和 Auto 相同命令桥不变。

多个可写 child 可以共享或分别使用树。创建通知不是目录占用租约，不承诺路径一直存在；工作树清理、编辑范围与当前 Workspace 根仍按原合同。验证分别归[核心防伪回归](../../../../packages/agent/test/isolated/execution/worktree-authorization.test.ts)、[消息回归](../../../../packages/agent/test/isolated/business/task/worktree-notification.test.ts)、[Service](../../../../apps/service/test/isolated/git-worktree-permissions.test.ts)和[真实模型](../../../../tests/e2e/live/model/README.md)。平台和客户端资格只按实际执行证据陈述。
