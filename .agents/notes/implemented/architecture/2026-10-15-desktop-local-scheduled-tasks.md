# Agent Note: Desktop 本地定时任务保持普通会话执行边界

Status: implemented

## Problem

桌面安排任务页原先只能填写草稿。用户要求参考Codex的具体实现，让稳定重复任务按时运行并能回到原结果，同时不能干扰正在阅读或运行的会话，也不能在重启或回执丢失后重复产生效果。

## Decision

首版只提供应用运行期间的本地日／工作日／周任务。Main单运行器使用可注入时钟，Node私有SQLite保存任务与运行快照，首次使用惰性DB10；Agent基线和schema保持。每次用普通createSession和run.start创建独立会话，原权限与审批保持。已错过时间最多补最近一次，同任务、同 Store 绑定不重叠；DST gap跳过、overlap只取第一次。稳定原ID与快照在网络效果前写入，冷恢复只GET原创建／启动Command。创建与启动之间中断也保持unknown，不以缺回执推断未发送。备份恢复为新Store保原绑定，不能自动执行；明确重绑后旧运行仅留只读历史，新 claim 身份包含Store。前台Run结束不代表组内效果结算，原Tool／后台／child事实仍有未知或活动项时继续阻止后继。after-turn 原报告待处理或根／已核 child Session 仍有活动 Run 同样等待，覆盖尚无 Model 的派发窗口。可信结算保存可选版本标识；旧终态无标识时也阻止派发，只按需每轮最多4条核原记录，不扫描无关任务、不由最新成功覆盖更早未知，也不通过重放取得证明。

Codex参考的是线程与轮次分离，以及本地自动任务需应用运行、提供结果入口的行为。[官方公开源码](https://github.com/openai/codex/tree/f0c5077c34ec7a76b4ad9134835925e6ae3d72ec)的thread/start与turn/start分别承担会话和轮次；turn/start可start_or_steer_turn，所以每次独立会话避免引导当前工作。[Automations文档](https://learn.chatgpt.com/docs/automations?surface=app)用于产品行为对照。公开源码没有桌面调度器内部实现，本文不把本地SQLite/轮询说成复制Codex。

## Alternatives considered

- 在当前活动会话发送：可能变成steer或混入已有上下文，结果归属不明确，未采用。
- 另建模型执行器：重复权限、恢复与执行owner，未采用。
- 通用RRULE平台、OS级后台守护和独立worktree：首版范围不需要，且会引入宿主生命周期与项目隔离承诺，暂不实现。
- 回执未知后自动重发：不能证明此前没有效果，因此仅核原ID，代价是部分中断需要人工核实。

## Consequences

UI缺真实项目或配置模型不能保存；任务暂停不取消原运行。当前Store的未知运行阻止后续发生和删除，不能用删除任务掩盖未确认效果。持久任务聚合1MiB、128个，运行32MiB、10000条；新claim只为活动记录预留现有字段最大增长，更新事务保持容量，不自动删除历史。旧满状态保原字节和严格只读展示，明确删除已验证结算任务可释放容量；极端旧满且仍活动或无空间补写可信标识的记录不承诺自动收尾。IPC只发最近轻量摘要，避免重复prompt快照超响应上限。未来扩展需保持原身份、审批与备份白名单，而不是把客户端缓存提升为Service authority。

当前源码、测试和平台限制由[Desktop owner](../../../../apps/desktop/README.md#native-安排任务草稿)维护。
