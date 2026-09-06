# 调度、授权与副作用选择

实现入口：[scheduler](../src/scheduler.ts)、[execution traits](../src/execution-traits.ts)、[tool governance](../src/tool-governance.ts)、[approval queue](../src/approval-queue.ts)。

## 调度输入

scheduler 同时读取业务 State 和 Host 提供的不可持久化调度 facts。ExecutionTraits 描述资源范围、读写性质、冲突键、隔离、因果组、交互 barrier 与 lease fence 要求。它们是明确事实，不通过工具显示名猜测。

selectPendingEffects 选择当前允许的工作。不同资源且满足约束的调用可以并发；同一业务交互、资源冲突或未完成清理会限制继续。不能用 UI 工具数量或墙钟动画决定可调度性。

## 授权交接

Builtin 编译参数和 effect facts，Kernel 决定允许、拒绝或审批，Host 持有实际执行 identity。权限模式、精确授权、工作区信任和环境可执行能力分别检查，不相互代替。

审批队列通过稳定 interaction identity 和 owner 选择焦点。用户决定转换成事件后推进状态；UI 关闭窗口不构成授权。旧 revision 或旧 owner 的决定不能作用于新请求。

## 修改时保持的关系

新增工具 effect 类型时，同时检查 traits、策略 facts、scheduler 和执行器是否一致；只添加 UI label 不建立运行能力。扩大并发必须证明无冲突和清理条件满足，不按测试运行快慢放宽 fence。

详细授权契约见[跨包授权](../../../docs/active/authorization.md)，调用顺序见[交互链路](../../../docs/development/flows/interactions.md)。

验证：[调度策略](../test/runtime/runtime-scheduling-policy.test.ts)、[effect admission](../test/effect-admission.test.ts)、[approval queue](../test/approval-queue.test.ts)、[工具治理](../test/tool-governance.test.ts)。
