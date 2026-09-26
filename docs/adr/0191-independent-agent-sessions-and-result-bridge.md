# ADR-0191：子 Agent 使用独立持久 Session 与父结果桥接

状态：accepted（设计边界已确认，实施与迁移尚未发布）

日期：2026-09-24

决策者：用户确认每 Agent 独立会话线程及隐藏子线程；Runtime 设计确定提交与恢复边界

现行依据：[后台 Agent 与 Shell 会话协调方案 §4.0](../plans/background-agent-shell-conversation-coordination.md)、[执行手册](../handbook/features/execution.md)、[Service owner](../../apps/kite-service/docs/runtime-application.md)、[Host owner](../../packages/runtime-host/docs/execution-lifecycle.md)、[Store owner](../../packages/runtime-storage-sqlite/README.md)。[ADR-0190](0190-codex-style-agent-mailbox-and-followup-authority.md)保留原单 Session 决定的历史理由；其交互目标仍供核对，共享 Session revision 和同 Session 邮箱事务的接线范围由本 ADR 替代。

## 背景

阶段 A–C 已修复父 Run 在多个后台子任务及 Shell 错峰完成时的等待和结果接纳。阶段 D 的未发布候选实现却把多个 Agent 行、子模型事实和邮箱写入同一个父 Session。并发兄弟写入会竞争同一 revision／effect lease；该结构也无法赋予子 Agent 独立的持久对话上下文。用户要求子 Agent 像 Codex 的 Agent thread 一样拥有自己的会话线程，且内部线程不能占据空间的顶层会话列表。官方 [Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)说明可检查 Agent thread 与独立上下文，但不规定 Kite 的数据库布局。

## 决定

1. 每个 Agent 的 `agentThreadId` 对应一个持久 Store Session，独立持有 State revision、模型 transcript、Run/Turn、execution owner 和 effect lease。稳定 `agent_id`、线程 ID、逐轮 `task_id` 分别保存。子 Session 继承经过收窄的 Workspace/project 与 grant，不能直接写父 State；同一个 SQLite 文件可容纳所有 Session。
2. Store 持久保存准确 `parent_session_id`：NULL 是根，非 NULL 是内部子线程，并核验父链与 Workspace/project 身份。旧顶层 Session 迁移为根，不按名称或 `agent_nodes` 猜测。公开空间目录、最近会话、搜索、分页在 SQL 排序、游标和 LIMIT 前过滤子线程；普通已知 ID 详情也不能绕过血缘权限。子线程仅经父 Agent 树或授权详情读取。
3. 父 `task` Tool 的受理事务写确定性子线程创建意图、原 Run required claim、有限委派预算和工具回执。Host 按相同 identity 幂等创建子 Session，子线程有独立创建回执和 owner。子首轮的来源、任务 Artifact、受限 grant、Run、预算与 turn 在子线程首次启动事务中核对；父线程确认仍持有原 required claim 和委派额度后，才允许子 Provider 派发。委派任务作为低权限 Agent 输入进入子模型，不写成 `user.message_appended`。永久创建失败由父线程按原意图结算具名失败，不留下永久 required。子 Provider/模型事实只写子 Session。
4. 唯一 watcher 在子 Session 事务中结算不可变结果 Artifact、终态、清理证据和带原父 Run／Turn／Tool attempt 的待投递记录。桥接器验证这条已结算记录后，在父 Session 的一个事务中接纳准确 `subagent.background_result_persisted`、结算 required claim 并写唯一投递回执。子 outbox 可稍后根据父回执确认；父提交成功后丢失确认只能重放回执，不能重执行 child 或重复注入结果。父 Run 已取消时按取消事实结算 claim，子结果留历史，不自动重开父 Run。
5. Agent 消息与续轮遵循发送 Session 持久受理、接收 Session 持久接纳的 outbox／inbox 协议。正文保持私有引用，模型输入水位只由接收线程的准确模型准入推进。预算由来源 Run 授权并有界委派给目标执行；不能借共享 Session revision 获得虚假的跨线程原子性。外部 dispatch 为 unknown 时保留恢复事实，禁止重放。
6. 未发布的 Store11 同 Session 邮箱、Agent 终态和后备预算代码只作为候选材料；阶段 D 工具保持关闭，Store11 不正式迁移用户数据。完成 D0 的跨线程格式、恢复及列表验证后，才按方案分阶段开放 D1–D3。A–C 的等待、Shell 与父结果行为继续保留。

## 恢复与验证

父意图已提交／子尚未创建、子已创建／父确认丢失、Artifact 已写／子终态未提交、子终态已提交／父未接纳、父接纳已提交／子确认丢失、父 Run 取消这六类窗口都由原身份与持久回执收敛，不重复外部执行。三个并发子线程的正常注册、handle、模型和终态写入不能使兄弟租约失效；父 Run 只因其准确结果或取消事实改变。创建三个子线程后，顶层列表、搜索、最近会话、跨页游标、重启和旧根会话迁移仍只显示根；父 Agent 树能授权读取三个子线程。完整事件与测试矩阵留在现行方案，运行测试通过才构成交付证据。

## 取舍

- 继续使用一个父 Session 的多 Agent 行：无法提供独立 revision／上下文，且兄弟提交干扰同一 lease，故不作为阶段 D 架构。
- 创建子 Session 后由客户端过滤列表：`LIMIT` 与游标已先截断结果，会产生空页和丢失根会话，故在 Store SQL 过滤。
- 子终态直接解除父 claim，或把两个 Session 当作一个事务：前者把 Artifact／子终态误当成父接纳，后者隐藏跨线程提交间隙，故使用可重放 outbox 和父投递回执。
