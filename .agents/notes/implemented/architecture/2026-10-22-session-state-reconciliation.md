# Agent Note: 重开会话时结算失去执行者的完整 Agent 组

Status: implemented

## Problem

用户强制结束客户端或关机后，重开仍看到主／子 Agent running、等待事件工具与排队子任务。只读锁观察和界面待核实能避免冒充进度，但后端仍保存活动状态，队列也已没有调度者；泛化待核实因此成为长期状态。用户明确要求恢复时更新完整后端，并保留可安全接续的原任务身份。

## Decision

Native 选中与重连、TUI 明确选中及 CLI 继续已有会话调用独立 `reconcileSession`；TUI 观察流重连仅重读当前会话，不重复核实写入。GET／SSE 和只读 Web 保持只读。Core 核原 Store／主体／root／generation、整组和真实原 OS 排他锁，确认 owner 丢失后原子 fence 并结算。Run 中断，尝试过的 Model 失败，未知 Tool／Job 保未知；未派发工作取消并记未执行原因，未被 accepted 的审批结束等待。完成结果和 accepted decision 保持。成功后 UI 用真实终态；普通会话不额外渲染泛化待核实文字，内部失败或证据不足仍撤销相应操作资格。

原行与安全边界进入私有版本化 checkpoint。显式接续预检用 savepoint 叠加后回滚；最终事务核结算行、generation、控制／选择／停止与业务命令边界，通过既有全部恢复约束才还原并交普通 owner。核实无业务派发，未知效果不因此取得重放资格。格式／安全细节归[恢复 owner](../../../../packages/agent/src/storage/sqlite/run-resume.README.md#会话恢复时的状态核实)。

用户明确开始新的独立任务或提交公开后续输入时，Runtime 先通过只读准入核对原请求、主体、前驱与上下文，再自动走同一 owner 核实；正常交接的 generation 变化有限重读，活 owner 不被抢占。原已落定回执直接返回。核实后完整读取原模型输出，受理事务确认准确旧边界和没有未知效果后，补齐原未派发 Tool 的取消结果并删除 checkpoint。新任务不会继承未配对的旧调用，不执行旧工具；真实 unknown 在新 Command 受理前拒绝。仅在核实时追加不可撤回的工具消息会干扰原身份接续，因此把这项历史闭合留给明确的新任务或放弃恢复。

普通会话不再借消息外异常文案、通用错误弹窗或临时核对按钮维持恢复流程。客户端保留已读正文和准确原提交，连接、历史与展示读取持续退避重试，未知提交只查原 ID；真实失败仍属于原输入、轮次或工具消息。测试诊断可以查看内部事实，显示开关不放宽任何执行或恢复资格。

无法核实活动 owner 时，客户端把新的普通输入排在准确原 Run 之后，仍由后端核实际锁和前驱；已核实的活动 owner 保持原引导语义。读取与发送之间的 owner 丢失不能仅靠这个显示观察兜底，因此旧快照 `input.steer` 也走后端核实。准确目标已终结时拒绝原引导，不改变已提交种类或改投新 Run；客户端把这项明确的准入拒绝记为未应用而保留草稿，不把它混成只能查询的网络未知结果。

[正常退出决定](../bug-fix/2026-10-21-paired-graceful-exit.md)的自然 drain、准确清理和明确强退边界继续适用；本决定补齐无法正常收尾的 owner 丢失恢复，不以强杀后结算替代正常退出。

## Alternatives considered

- 只隐藏 spinner／显示待核实：未更新后端，不能修正子队列与工具状态，用户已明确否定该完成边界。
- 仅删除异常文案、依赖用户再触发一次刷新：会把可恢复错误变为无声卡死，普通输入准入与客户端只读恢复分别承担各自兜底；不会用自动重发写操作获得表面可用性。
- 重开直接调用旧 session.recover：表示明确放弃原边界，会破坏安全 Run／子任务／审批接续，故保持独立语义。
- 普通 GET／SSE 隐式写中断：读取不应取得控制权，共享／只读消费者会改变行为，改用固定身份与能力受限的独立调用。
- 全部未知改完成或取消，或凭 PID／锁文件缺失猜死亡：不能证明外部效果或原锁，保留 unknown 和检查错误。
- 结算后丢弃原 frontier：失去原 queued child 与审批身份；私有 checkpoint 以校验成本保存原边界，公共 View 仍是真实终态。

## Consequences

正常重开不再把失去调度者的工作显示为 queued／running，仍持锁的共享执行保持。新增 0003 私有迁移与校验／维护成本：备份保留，新 Store 恢复和范围 GC 清除，安全导出排除。选择／停止／相关业务变化使边界失效，失败保历史与错误。外部未知仍需可靠适配器核实，不承诺任意作用已停止。

[真实 SIGKILL](../../../../packages/agent/test/isolated/recovery/run-resume-group-runtime.test.ts)、[Store 反例](../../../../packages/agent/test/isolated/recovery/run-resume-store.test.ts)及[Native 装配](../../../../apps/desktop/test/isolated/native-session-reconciliation.test.ts)验证结算／同身份接续、安全拒绝和冷读／零重放，覆盖本机进程与 SQLite，不代证实际整机关机、付费 Provider、物理损坏或全部平台／安装资格。
