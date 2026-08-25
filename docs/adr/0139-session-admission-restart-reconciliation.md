# ADR-0139：Session admission 前完成跨进程恢复并重载事件尾

状态：accepted

日期：2026-08-25

决策者：用户直接指令

相关：ADR-0050、ADR-0071、ADR-0137、ADR-0138、
`docs/active/cancel-resume-cleanup.md`、`docs/active/runtime-resilience-qualification.md`、
`docs/active/six-concept-runtime-architecture.md`

## 背景

Runtime Host 在 Coordinator 构造时会持久化通用 restart recovery 事实，但 Subagent Provider handle 与 sandbox
preparation 需要异步 evidence reconciliation，过去只在下一条用户消息进入 turn coordinator 后执行。TUI 打开历史 Session
又先读取事件，再同步注册 Runtime，最后仍用注册前的旧事件列表渲染。进程退出时遗留的 Tool、Subagent、模型流和审批 sibling
因此可以长期显示为“进行中”，即使 Store 已经写入部分恢复事实。

不能把所有状态一律改成 `cancelled`：已 dispatch 调用的外部结果可能未知，自动取消会伪造无副作用结论；State 27 的 durable
approval queue 与 Subagent continuation 也必须跨重启保留。另一方面，仅在 TUI 把 `suspended` 改回 `running` 会制造一个没有
live executor 的 spinner，且下一次 Session 切换还会重复出现。

## 决策

### 1. Host resume 是跨进程恢复屏障

`resume_session` 在 Session 进入前台和 TUI replay 前完成一次 Host-owned restart reconciliation：

1. Coordinator 先提交通用 model/capability/resource restart facts；
2. App 通过同一 `AuthorizedExecutionControl` 清理 Subagent Provider lifecycle 与 sandbox preparation；
3. cleanup receipt 确认后，非可恢复 Tool 才提交终态；
4. TUI bridge 的 readiness 只在上述步骤完成后解决。

任何 cleanup 未确认都保持原 recovery authority，后续执行继续 fail closed；不得为了让历史画面可打开而伪造 cleanup receipt、
重放 Provider/Tool，或回退 host execution。

### 2. 按执行确定性收敛，而不是按组件名称收敛

- 未 dispatch 且不属于当前 durable interaction/continuation 的 Tool 由恢复流程取消；
- 已进入 `running` 或已有 invocation intent、但没有 terminal receipt 的 Tool 收敛为 `failure=unknown`，外部效果为 unknown，
  不自动重放；
- 恢复生成任何 Tool 终态前，先在同一 transaction 闭合该 Tool 下全部 `recorded|running` capability invocation；缺少
  可信结果 Artifact 的 invocation 写为 `capability.execution_unknown`，不能只依赖第一个 receipt-bearing attempt；
- `prepared|dispatching` model invocation 使用 `model.invocation_interrupted(runtime_restored)`；
- resource reservation/waiter 与 sandbox/Subagent process authority 先按各自 cleanup contract 收敛；
- exact durable approval、`authorized_queued` receipt、ask/plan/provider interaction 与有效 Subagent continuation 保留 canonical
  State，不伪造用户批准、拒绝或取消；
- 只有存在真实 interrupted work 且已经没有可恢复 interaction/continuation 时，才提交 `turn.aborted(cause=error)`。空的 active
  placeholder 或仅有待处理 compaction 不因 Session 打开而被误终止。

同一进程内的 Session 前后台切换不是 restart，不运行这套收敛；后台 operation 和事件 buffer 继续按 ADR-0050 保留。

### 3. TUI 只渲染恢复后的 head

历史 Session 打开顺序固定为：兼容加载 → Runtime 注册 → await Host readiness/recovery → 重新加载 persisted SessionData →
navigation token 校验 → foreground switch → replay。第一次加载只用于 admission，不能作为最终画面。恢复期间若用户选择其他
Session，旧 token 的成功、失败和 cleanup 都不得覆盖新的 active Session；同 target 重复选择复用同一个 dormant Runtime，
不能由较早请求清理掉较新请求正在使用的 registration。

TUI 的 crash-only 本地投影继续遵守 ADR-0071：不向源 Store 写伪造的用户动作。尚未开始的交互显示本地恢复取消；已跨执行
边界的 Tool、运行中 Subagent 与未闭合模型流停止 spinner，并显示“结果无法确认/不会自动重试”。审批 suspended child 不能再
被投影回 `running`。Canonical terminal event 晚到时仍以其 identity 和 generation 覆盖本地只读投影。

## 与旧决策的关系

本 ADR 细化 ADR-0071 的 unknown 与本地恢复投影：保留“不伪造用户终态、不自动重试、继续工作时 fork”的决定，替代
`suspended` 清除审批标记后回到 `running` 的展示结果，并把 process-owned cleanup 从下一次用户 turn 前移到 Host Session
admission。ADR-0137 的 durable queue、receipt、generation 和 continuation 语义不变；ADR-0138 的历史格式兼容边界不变。

## 后果

- 重开被中断的 Session 不再显示永远运行的 Tool/Subagent/模型流；
- Store、live projection 与 replay 使用同一恢复事件尾，Session A/B 往返不会把旧画面重新写回；
- 已 dispatch 外部效果继续保守标记 unknown，durable approval/continuation 不因 UI 修复被误删；
- Session open 多一次本地 readiness 等待和 persisted reload，但不增加 Provider dispatch，也不读取事件正文到诊断日志。

## 回滚

可以回滚 post-recovery reload 与本地 unknown 文案，但不得恢复“Session 打开后仍显示 live spinner”、在 TUI 伪造用户拒绝、
跳过 Subagent/sandbox cleanup、或对 unknown invocation 自动重放。若移除 admission recovery，必须先提供等价的 Host 屏障与
跨进程状态收敛方案。
