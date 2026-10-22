# Agent Note: 普通消息直接进入当前主 Agent

Status: implemented

## Problem

普通输入先被独立模型判定任务归属，再派生成业务输入，会产生额外助手回复、第二条用户记录及不直观的配置和子任务隔离。只修气泡去重或位置不能消除额外模型轮次。用户在本次侧会话明确要求移除这层内部判定，并确认新消息进入普通主 Agent；不继续叠加 UI 补丁。

## Decision

新 `run.start/input.steer/input.follow_up` 保留原命令和附件，直接交给普通 Loop；运行中引导在准确原 Run 的安全边界应用，排队等前驱结束。普通主 Agent 理解补充、进度、澄清或改变方向，不单独生成归属说明、候选工作、selected-work 决定或隐藏业务输入。

新轮次使用当前明确配置和权限，保留会话上下文，不按正文恢复旧 Run。当前授权父 Tool 可管理自己的稳定直接子 Agent；技术 rootWork 不隔离同一会话后续普通输入。child result 可进入当前父轮次，仍核准确来源、Store、selection、result revision 与 Source/consume/ack。排队人类输入优先于 idle 报告启动；活动父轮次仍接收 child 结果。

真实模型的桌面 SIGKILL 重开实测暴露了另一条重复路径：原 Model／Execution 没有重放，但后继模型只读到旧用户任务和新输入，没有旧 Run 已 interrupted 的系统事实，便在新 Run 再次提出旧写入。因此新 Model 请求对当前 Store／Session 其他 interrupted／cancelled／failed Run 的准确人类输入提供生命周期说明，保完整历史但不把旧输入本身作为待办或新授权。当前明确输入和显式接续原 Run 保持正常语义；不改变权限准入，也不根据正文或路径拦截合法的新任务。原消息、Source 和已封存模型请求保持，Fork 和外 origin Store 恢复不借来源 Run 后来的动态状态重解释封存副本。

普通 Native 的明确发送沿 Session 已绑定项目准备当前 Workspace Trust，包含宿主声明的额外只读范围，不再让用户单独勾选项目读取范围。授权准备由 Main 复用原权限 observation、trust revision、目录身份／读取范围摘要 CAS 及 journal，未知只查原申请，切会话或观察变化不继续发送；审批模式、工具硬上限和实际执行审批保持独立。打开历史和状态核实不调用该准备入口。选择这一交互是落实本次移除独立范围确认的范围，不能由恢复意图或当前选中行自行取得发送许可。

旧 raw/decision、消息呈现证明和已封存业务回执保留审计兼容；pending/unresolved 与 selected-work 不再阻止普通新输入。旧 queued/active processing 的执行或恢复拒绝为 `input_processing_removed`，不调用模型或恢复配置。旧明确控制、取消、Rewind、unknown、父子关系及当前权限仍独立有效。

本决定部分替代[稳定协作者与工作选择决定](2026-10-18-stable-agent-collaboration-and-human-work-selection.md)中的输入归属预判、自然语言控制预处理、selected-work 派发屏障、按工作过滤普通结果及自动恢复旧工作配置；其稳定身份、精确来源、可信权限、未知效果、历史审计和呈现兼容的理由保留。

## Alternatives considered

- 只隐藏判定回复或继续调整 UI：仍会执行额外模型轮次及隐藏输入，不能解决用户指出的机制问题。
- 保留后台分类、只取消可见说明：继续引入分类错误和任务归属控制；用户确认整体移除。
- 保留独立项目范围弹窗：仍让用户在已绑定项目的会话内重复确认；改为明确发送时沿原权限控制准备范围，不把打开历史变成授权或发送。
- 删除旧记录和兼容字段：会损失可审计历史、已受理回执与 Fork 的准确出处，未采用。
- 只证明旧 Execution 零重放：无法阻止新模型因缺少中断事实而重新提出旧任务；补齐实际上下文事实后仍独立核验真实工具效果。
- 删除中断输入、补造“已完成”回复或按旧文件路径阻止执行：分别损失上下文、虚构结果或阻止后来明确授权的合法工作，未采用。

## Consequences

一次普通输入只产生实际 Agent 执行链；相同文本的新输入独立。普通消息不再取得预解析的暂停、停止或恢复效力，须由普通 Agent 的受权工具或明确 UI 操作落实。历史 processing 保持可读但不可恢复；旧业务已发效果不回滚。普通 Native 发送会准备当前项目读取授权，项目／范围并发变化或未知回执保留原文并拒绝继续，不能从移除弹窗推导任意外部文件或工具执行权限。

产品行为归[执行手册](../../../../docs/handbook/features/execution.md)，实现与对应验证归[Agent owner](../../../../packages/agent/README.md#人类输入工作选择与可靠结果)、[输入 owner](../../../../packages/agent/src/storage/sqlite/inputs/README.md)和[Desktop owner](../../../../apps/desktop/README.md#真实输入消息的唯一展示)。回归覆盖直接输入、steer/queue、稳定 child 跨普通轮次协作、原结果一次接纳、权限刷新、旧记录 SIGKILL 后零分类派发及真实 Electron 冷重开；受控模型和本机证据不扩为付费 Provider 或跨平台资格。
